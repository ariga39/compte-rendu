import type { ModelRouteDescriptor, ModelUsageSummary } from '@compte-rendu/contracts';
import {
  RunnerJobInput,
  StructuredReviewResult,
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
  type RunnerJobResponse as ExecutionJobState,
} from '@compte-rendu/contracts';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duration, Effect } from 'effect';
import type {
  RunnerDiagnostic,
  RunnerProcess,
  RunnerProcessOptions,
  RunnerProcessResult,
  SandboxBackend,
  SandboxExecPort,
} from './sandbox-runtime.js';
import { SandboxCreateError } from './sandbox-runtime.js';
import { processFailure, redactProcessResult, stop } from './runner-process.js';
import { currentEpochMillis, currentIso } from './runner-clock.js';
import {
  archiveEvidence,
  createCallbackSender,
  createEvidenceUploader,
  evidenceFiles,
  redactEvidenceTextFiles,
  secureEvidenceTree,
  writeManifestAtomically,
} from './evidence-store.js';
import {
  MAX_AGENT_OUTPUT_BYTES,
  parseResult,
  uniqueSessionIdFrom,
  mergedAgentResult,
  shellPermissionRules,
  type ParsedAgentResult,
  type RunnerFailureCauseValue,
} from './opencode-config.js';
import {
  decodeSessionExport,
  sessionSucceeded,
  type MultiReviewSelection,
  type ReviewSubmission,
  type SessionIdentity,
  SUPERVISOR_AGENT_ID,
  dedupedRoutes,
  extractReviewSubmission,
  multiReviewConfig,
  participants,
  routeModelIdentity,
} from './opencode-multi-review.js';
import { reviewCorrectionPrompt, reviewPrompt, reviewerSystemPrompt } from './review-prompt.js';
import { reviewSkills } from './review-skill.js';
import type { GrantRevoker } from './grant-revoker.js';
import {
  LlmGrantIssueError,
  type LlmGrantIdentity,
  type LlmServiceClient,
} from './llm-service-client.js';
import type { JobHandle } from './job-registry.js';
import { createProgressReporter, type ProgressReporter } from './progress-reporter.js';
import { createReadTokenLease, type ReadTokenLease } from './read-token-lease.js';
import type { ReadTokenClient } from './read-token-client.js';

const SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const SUBMIT_REMINDER_BUDGET_MS = 2 * 60 * 1000;
const FINALIZATION_BUDGET_MS = 60 * 1000;
const CLEANUP_COMMAND_TIMEOUT_MS = 30 * 1000;
const DEFAULT_DESTROY_RETRY_DELAYS_MS = [0, 3_000, 10_000] as const;
const ARCHIVE_COMMAND_TIMEOUT_MS = 30 * 1000;
const ARCHIVE_PHASE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DIAGNOSTIC_STDERR_BYTES = 4 * 1024;
const OPENCODE_VERSION = '2.4.1';
const askpassScript =
  '#!/bin/sh\ncase "$1" in *[Uu]sername*) printf %s x-access-token ;; *) printf %s "$CHECKOUT_TOKEN" ;; esac\n';

export type JobExecutionInput = {
  claimDeadlineAt?: number;
  repositoryReadTokenExpiresAt?: number;
  reviewConfiguration?: RunnerJobInput['reviewConfiguration'];
  id: string;
  runId: string;
  attempt: number;
  repositoryUrl: string;
  repositoryName: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  repositoryReadToken: string;
};

type RunnerMultiReviewEvidence = {
  readonly revision: number;
  readonly selection: MultiReviewSelection;
  readonly rootSessionId: string;
  readonly reviewers: ReadonlyArray<{
    readonly participant: string;
    readonly route: string;
    readonly sessionId: string;
    readonly model: string;
  }>;
  readonly synthesis: ReviewSubmission;
};

interface ExecutionJob {
  readonly handle: JobHandle;
  readonly state: ExecutionJobState;
  readonly input: JobExecutionInput;
  readonly id: string;
  readonly sandboxName: string;
  usage?: ModelUsageSummary;
  child?: ChildProcess;
  readonly abortRequested: boolean;
  sandboxAttempted: boolean;
  sandboxCreated: boolean;
  hostCleanupConfirmed?: boolean;
  sessionIds: string[];
  multiReview?: RunnerMultiReviewEvidence;
  sandbox?: import('./sandbox-runtime.js').JobSandbox;
  checkoutRoot?: string;
  configRoot?: string;
  grantIssuanceAttempted: boolean;
  grantRevoked: boolean;
  grantToken?: string;
  grantTokenPath?: string;
  grantRoot?: string;
  claimDeadlineAt: number;
  deadlineAt: number;
  deadlineLimit: 'claim' | 'credential';
  readToken?: ReadTokenLease;
  processCredentialValues: string[];
  executionStartedAt?: string;
  submissionCompletedAt?: string;
  cleanupCompletedAt?: string;
  progress?: ProgressReporter;
}

export interface JobExecutorDependencies {
  readonly backend: SandboxBackend;
  readonly process: RunnerProcess;
  readonly evidenceRoot: string;
  readonly callbackUrl?: string | undefined;
  readonly callbackToken?: string | undefined;
  readonly callbackFetch: typeof fetch;
  readonly callbackTimeoutMs: number;
  readonly callbackRetryDelaysMs?: readonly number[] | undefined;
  readonly destroyRetryDelaysMs?: readonly number[] | undefined;
  readonly evidenceUrl?: string | undefined;
  readonly evidenceFetch: typeof fetch;
  readonly evidenceTimeoutMs: number;
  readonly progressFetch: typeof fetch;
  readonly grants: GrantRevoker;
  readonly llmServiceClient?: LlmServiceClient | undefined;
  readonly readTokenClient?: ReadTokenClient | undefined;
  readonly relayEnabled: boolean;
  readonly grantVersion: string;
  readonly modelId?: string | undefined;
  readonly openCodeConfig?: string | undefined;
  readonly serviceBaseUrl?: URL | undefined;
  readonly modelResource: string;
  readonly log?: OperationalLog | undefined;
  readonly retire: (handle: JobHandle) => void;
  readonly scheduleCleanupRecovery: () => void;
  readonly requestNextJob?: (() => void) | undefined;
}

export const createJobExecutor = (deps: JobExecutorDependencies) => {
  const {
    backend: sandboxBackend,
    process: executeProcess,
    evidenceRoot,
    callbackUrl,
    callbackToken,
    callbackFetch,
    callbackTimeoutMs,
    callbackRetryDelaysMs,
    destroyRetryDelaysMs = DEFAULT_DESTROY_RETRY_DELAYS_MS,
    evidenceUrl,
    evidenceFetch,
    evidenceTimeoutMs,
    progressFetch,
    grants: grantRevoker,
    llmServiceClient,
    readTokenClient,
    relayEnabled,
    grantVersion,
    modelId,
    openCodeConfig,
    serviceBaseUrl,
    modelResource,
    log,
    scheduleCleanupRecovery,
    retire,
    requestNextJob,
  } = deps;
  const readTokenSecretValues = (job: ExecutionJob): string[] =>
    [...new Set([job.input.repositoryReadToken, ...(job.readToken?.secrets ?? [])])].filter(
      (value) => value.length > 0,
    );
  const trackProcessCredentialValues = (
    job: ExecutionJob,
    values: readonly string[] | undefined,
  ) => {
    for (const value of values ?? []) {
      if (value.length > 0 && !job.processCredentialValues.includes(value))
        job.processCredentialValues.push(value);
    }
  };
  const jobCredentialValues = (job: ExecutionJob): string[] =>
    [
      ...new Set([...readTokenSecretValues(job), job.grantToken, ...job.processCredentialValues]),
    ].filter((value): value is string => value !== undefined && value.length > 0);

  const remainingExecutionMs = (job: ExecutionJob) => Math.max(0, job.deadlineAt - Date.now());
  const update = (job: ExecutionJob, state: Partial<ExecutionJobState>) => {
    Object.assign(job.state, state);
  };
  const deadlineFailure = (job: ExecutionJob): NonNullable<ExecutionJobState['failure']> => ({
    reason: 'timeout',
    deadline: job.deadlineLimit,
  });

  const boundedDiagnostic = (job: ExecutionJob, value: string | undefined) => {
    if (value === undefined || value.length === 0) return undefined;
    let sanitized = value;
    for (const secret of [...readTokenSecretValues(job), job.grantToken]) {
      if (secret !== undefined && secret.length > 0)
        sanitized = sanitized.replaceAll(secret, '[redacted]');
    }
    sanitized = sanitized.replaceAll(job.input.repositoryUrl, '[repository]');
    sanitized = Array.from(sanitized, (character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)
        ? character
        : '?';
    }).join('');
    const bytes = new TextEncoder().encode(sanitized);
    return bytes.length <= MAX_DIAGNOSTIC_STDERR_BYTES
      ? sanitized
      : new TextDecoder().decode(bytes.subarray(0, MAX_DIAGNOSTIC_STDERR_BYTES));
  };

  // A logger failure must never change the Runner Job outcome.
  const recordLog = async (event: OperationalLogEvent) => {
    if (log === undefined) return;
    try {
      await log.record(sanitizeOperationalLogEvent(event));
    } catch {
      // Diagnostics must not change the Runner Job outcome.
    }
  };
  const sendCallback = createCallbackSender({
    url: callbackUrl,
    token: callbackToken,
    fetch: callbackFetch,
    timeoutMs: callbackTimeoutMs,
    retryDelaysMs: callbackRetryDelaysMs,
    recordLog,
  });
  const sendEvidence = createEvidenceUploader({
    url: evidenceUrl,
    token: callbackToken,
    fetch: evidenceFetch,
    timeoutMs: evidenceTimeoutMs,
  });

  const recordCommand = async (
    job: ExecutionJob,
    diagnostic: RunnerDiagnostic,
    result: RunnerProcessResult,
  ) => {
    const event: OperationalLogEvent = {
      phase: 'runner',
      outcome: 'command',
      runId: job.input.runId,
      stage: diagnostic.stage,
      command: diagnostic.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated === true,
      stderrTruncated: result.stderrTruncated === true,
      streamError: result.streamError === true,
      abortRequested: job.abortRequested,
      processError: result.processError === true,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      ...(diagnostic.includeStderr === true ||
      (diagnostic.stage === 'checkout' && (result.exitCode !== 0 || result.timedOut))
        ? (() => {
            const stderr = boundedDiagnostic(job, result.stderr);
            return stderr === undefined ? {} : { stderr };
          })()
        : {}),
    };
    await recordLog(event);
  };

  const runTracked = async (
    job: ExecutionJob,
    command: string,
    args: readonly string[],
    processOptions: RunnerProcessOptions = {},
    diagnostic?: RunnerDiagnostic,
  ) => {
    const requestedTimeout = processOptions.timeoutMs ?? SETUP_TIMEOUT_MS;
    const remaining = remainingExecutionMs(job);
    trackProcessCredentialValues(job, processOptions.credentialValues);
    const credentialValues = jobCredentialValues(job);
    const redactions = [...credentialValues, ...(processOptions.stderrRedactions ?? [])].filter(
      (value): value is string => value !== undefined && value.length > 0,
    );
    let result: RunnerProcessResult;
    try {
      result = await executeProcess(command, args, {
        ...processOptions,
        captureStderr: processOptions.captureStderr ?? diagnostic !== undefined,
        stderrRedactions:
          diagnostic === undefined ? redactions : [...redactions, job.input.repositoryUrl],
        credentialValues,
        maxBytes:
          diagnostic === undefined
            ? processOptions.maxBytes
            : (processOptions.maxBytes ?? MAX_DIAGNOSTIC_STDERR_BYTES),
        timeoutMs: Math.max(1, Math.min(requestedTimeout, remaining)),
        onChild: (child) => {
          job.child = child;
          processOptions.onChild?.(child);
          if (job.abortRequested) stop(child);
        },
      });
    } catch (error) {
      result = processFailure(error);
    }
    result = redactProcessResult(result, redactions);
    job.child = undefined;
    if (diagnostic !== undefined) await recordCommand(job, diagnostic, result);
    return result;
  };

  const runArchive = async (
    job: ExecutionJob,
    command: string,
    args: readonly string[],
    deadlineAt: number,
    processOptions: RunnerProcessOptions = {},
    diagnostic?: RunnerDiagnostic,
  ) => {
    let remaining: number;
    try {
      remaining = deadlineAt - currentEpochMillis();
    } catch {
      return { exitCode: 1, stdout: '', timedOut: true, truncated: false };
    }
    if (remaining <= 0) {
      return { exitCode: 1, stdout: '', timedOut: true, truncated: false };
    }
    let result: RunnerProcessResult;
    try {
      result = await executeProcess(command, args, {
        ...processOptions,
        captureStderr: processOptions.captureStderr ?? diagnostic !== undefined,
        timeoutMs: Math.max(
          1,
          Math.min(processOptions.timeoutMs ?? ARCHIVE_COMMAND_TIMEOUT_MS, remaining),
        ),
      });
    } catch (error) {
      result = processFailure(error);
    }
    if (diagnostic !== undefined) await recordCommand(job, diagnostic, result);
    return result;
  };

  const prepareCheckout = async (job: ExecutionJob, root: string): Promise<string | undefined> => {
    const checkoutPath = join(root, 'checkout');
    const askpassPath = join(root, 'askpass');
    await writeFile(askpassPath, askpassScript, { mode: 0o700 });
    const env = {
      ...process.env,
      CHECKOUT_TOKEN: job.input.repositoryReadToken,
      GIT_ASKPASS: askpassPath,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    const clone = await runTracked(
      job,
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'submodule.recurse=false',
        '-c',
        'filter.lfs.smudge=:',
        'clone',
        '--quiet',
        '--no-checkout',
        '--no-recurse-submodules',
        job.input.repositoryUrl,
        checkoutPath,
      ],
      { env },
      { stage: 'checkout', command: 'clone' },
    );
    if (clone.exitCode !== 0 || clone.timedOut) return undefined;
    const fetch = await runTracked(
      job,
      'git',
      [
        '-C',
        checkoutPath,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'submodule.recurse=false',
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        `+${job.input.baseSha}:refs/remotes/origin/review-base`,
        `+${job.input.headSha}:refs/remotes/origin/review-head`,
      ],
      { env },
      { stage: 'checkout', command: 'fetch' },
    );
    if (fetch.exitCode !== 0 || fetch.timedOut) return undefined;
    const checkout = await runTracked(
      job,
      'git',
      [
        '-C',
        checkoutPath,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'submodule.recurse=false',
        'checkout',
        '--quiet',
        '--detach',
        'refs/remotes/origin/review-head',
      ],
      { env },
      { stage: 'checkout', command: 'detach' },
    );
    if (checkout.exitCode !== 0 || checkout.timedOut) return undefined;
    const commits = await runTracked(
      job,
      'git',
      [
        '-C',
        checkoutPath,
        'rev-parse',
        'refs/remotes/origin/review-base^{commit}',
        'refs/remotes/origin/review-head^{commit}',
      ],
      { captureStdout: true, maxBytes: 4 * 1024, env },
      { stage: 'checkout', command: 'verify-revision' },
    );
    if (commits.exitCode !== 0 || commits.timedOut) return undefined;
    const reported = commits.stdout.trim().split(/\s+/);
    if (
      reported.length !== 2 ||
      reported[0] !== job.input.baseSha ||
      reported[1] !== job.input.headSha
    ) {
      return undefined;
    }
    const mergeBase = await runTracked(
      job,
      'git',
      [
        '-C',
        checkoutPath,
        'merge-base',
        'refs/remotes/origin/review-base^{commit}',
        'refs/remotes/origin/review-head^{commit}',
      ],
      { captureStdout: true, maxBytes: 4 * 1024, env },
      { stage: 'checkout', command: 'verify-merge-base' },
    );
    if (mergeBase.exitCode !== 0 || mergeBase.timedOut || mergeBase.truncated) return undefined;
    const mergeBaseSha = mergeBase.stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(mergeBaseSha)) return undefined;
    const removeRemote = await runTracked(
      job,
      'git',
      ['-C', checkoutPath, 'remote', 'remove', 'origin'],
      { env },
      { stage: 'checkout', command: 'remove-remote' },
    );
    if (removeRemote.exitCode !== 0) return undefined;
    const removeAskpass = await runTracked(
      job,
      'git',
      ['-C', checkoutPath, 'config', '--local', '--unset-all', 'credential.helper'],
      { env },
      { stage: 'checkout', command: 'remove-credential' },
    );
    if (removeAskpass.exitCode !== 0 && removeAskpass.exitCode !== 5) return undefined;
    const removeHook = await runTracked(
      job,
      'git',
      ['-C', checkoutPath, 'config', '--local', '--unset-all', 'core.askPass'],
      { env },
      { stage: 'checkout', command: 'remove-askpass' },
    );
    if (removeHook.exitCode !== 0 && removeHook.exitCode !== 5) return undefined;
    await rm(askpassPath, { force: true });
    return mergeBaseSha;
  };

  const removeHostDirectories = async (job: ExecutionJob): Promise<boolean> => {
    let clean = true;
    for (const directory of [job.checkoutRoot, job.configRoot, job.grantRoot]) {
      if (directory === undefined) continue;
      try {
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 2,
          retryDelay: 100,
        });
      } catch {
        clean = false;
        // Keep this on the Runner host only. Paths can identify the repository
        // checkout, so they must not enter the injectable operational log.
        console.warn(
          JSON.stringify({
            phase: 'runner',
            outcome: 'host-cleanup',
            jobId: job.id,
            directory,
          }),
        );
      }
    }
    return clean;
  };

  const cleanup = async (job: ExecutionJob) => {
    job.progress?.stage('cleanup');
    // Sandbox destruction and host scratch-directory removal are different
    // outcomes. Only an unconfirmed real Sandbox may block the same PR or need
    // recovery; a host path failure still fails this task without claiming the
    // VM survived.
    let sandboxClean = true;
    if (job.sandboxAttempted) update(job, { stage: 'cleanup' });
    const cleanupPort: SandboxExecPort = {
      run: async (program, args, processOptions = {}, diagnostic) => {
        let result: RunnerProcessResult;
        try {
          result = await executeProcess(program, args, {
            ...processOptions,
            env: processOptions.env,
            captureStdout: processOptions.captureStdout ?? false,
            captureStderr: true,
            stderrRedactions: [
              ...readTokenSecretValues(job),
              job.grantToken,
              job.input.repositoryUrl,
              ...(processOptions.stderrRedactions ?? []),
            ].filter((value): value is string => value !== undefined && value.length > 0),
            maxBytes: processOptions.maxBytes ?? MAX_DIAGNOSTIC_STDERR_BYTES,
            timeoutMs: CLEANUP_COMMAND_TIMEOUT_MS,
          });
        } catch (error) {
          result = processFailure(error);
        }
        if (diagnostic !== undefined) await recordCommand(job, diagnostic, result);
        return result;
      },
    };
    if (job.sandboxAttempted && job.sandbox !== undefined) {
      const sandbox = job.sandbox;
      const destroyDelays = destroyRetryDelaysMs.length === 0 ? [0] : destroyRetryDelaysMs;
      // A transient CLI/daemon failure is not proof that destruction failed.
      // Retry the same owned Sandbox briefly; a confirmed destroy is never
      // repeated after it succeeds, and an empty delay list still performs the
      // one required destroy attempt.
      for (const [index, delay] of destroyDelays.entries()) {
        if (delay > 0) await Effect.runPromise(Effect.sleep(Duration.millis(delay)));
        try {
          await sandbox.destroy(cleanupPort);
          sandboxClean = true;
          break;
        } catch {
          sandboxClean = false;
          if (index === destroyDelays.length - 1) break;
        }
      }
    }
    const hostClean = await removeHostDirectories(job);
    const clean = sandboxClean && hostClean;
    job.handle.cleanupRecoveryPending = !sandboxClean;
    if (job.handle.cleanupRecoveryPending) job.handle.cleanupRecoveryRetryAt = Date.now();
    // Backend proof is about the Sandbox and its own host resources, never the
    // Runner scratch roots. A scratch failure is reported separately and cannot
    // turn a confirmed VM destruction into an unrecoverable cleanup failure.
    job.hostCleanupConfirmed =
      !job.sandboxAttempted || job.sandbox?.metadata.hostCleanupConfirmed === true;
    update(job, { sandbox: { cleanup: sandboxClean ? 'destroyed' : 'failed' } });
    if (job.handle.cleanupRecoveryPending) scheduleCleanupRecovery();
    return clean;
  };

  const revokeGrant = async (job: ExecutionJob): Promise<boolean> => {
    if (llmServiceClient === undefined || job.grantRevoked) return true;
    if (!job.grantIssuanceAttempted) return true;
    const revoked = await grantRevoker.revoke(job.id, true);
    if (revoked) job.grantRevoked = true;
    return revoked;
  };

  const executeJob = async (job: ExecutionJob) => {
    let failure: ExecutionJobState['failure'];
    let executionCause: RunnerFailureCauseValue | undefined;
    let result: StructuredReviewResult | undefined;
    let agent: RunnerProcessResult | undefined;
    let agentEndedAt: number | undefined;
    let correctionTimeout = false;
    let agentParsed: ParsedAgentResult | undefined;
    let executionModel: string | undefined;
    let submissionIdentity: SessionIdentity | undefined;
    let descriptors: readonly ModelRouteDescriptor[] | undefined;
    const evidenceId = job.state.evidenceId ?? job.id;
    const evidencePath = join(evidenceRoot, evidenceId);
    const multiConfiguration = job.input.reviewConfiguration;
    const multiSelection = multiConfiguration?.selection ?? undefined;
    const multi = multiSelection !== undefined;
    const directExecution = multiSelection !== undefined && multiSelection.reviewers.length === 1;
    let evidenceStartedAt: string | undefined;
    let evidenceReady = false;
    let evidenceComplete = false;
    let evidenceFailure: string | undefined;
    let revocationUnconfirmed = false;
    const validateMultiReview = async (): Promise<
      { readonly result: StructuredReviewResult } | { readonly cause: RunnerFailureCauseValue }
    > => {
      if (multiSelection === undefined) return { cause: 'result-schema-failure' };
      const rootSessionId = job.sessionIds[0];
      if (rootSessionId === undefined) return { cause: 'result-schema-failure' };
      const readExport = async (sessionId: string): Promise<unknown> => {
        try {
          return JSON.parse(
            await readFile(join(evidencePath, `opencode-export-${sessionId}.json`), 'utf8'),
          ) as unknown;
        } catch {
          return undefined;
        }
      };
      const root = await readExport(rootSessionId);
      if (root === undefined || !sessionSucceeded(root, rootSessionId)) {
        return { cause: 'missing-terminal-message' };
      }
      const rootIdentity = submissionIdentity;
      if (rootIdentity === undefined) return { cause: 'result-schema-failure' };
      const rootInfo = decodeSessionExport(root)?.info;
      if (
        rootInfo === undefined ||
        rootInfo.agent !== rootIdentity.agent ||
        rootInfo.model?.providerID !== rootIdentity.model.providerID ||
        rootInfo.model.id !== rootIdentity.model.id
      ) {
        return { cause: 'result-schema-failure' };
      }
      const synthesis = extractReviewSubmission(root, rootIdentity);
      if (synthesis.cause !== undefined) return { cause: synthesis.cause };
      const synthesisValue = synthesis.value;
      if (synthesisValue === undefined) return { cause: 'result-schema-failure' };

      // Child sessions are kept as provenance only. A reviewer that did not
      // submit, used a different completion path, or was retried never turns a
      // valid supervisor result into a failure.
      const reviewers: RunnerMultiReviewEvidence['reviewers'][number][] = [];
      for (const sessionId of job.sessionIds.slice(1)) {
        const info = decodeSessionExport(await readExport(sessionId))?.info;
        if (info === undefined || info.parentID !== rootSessionId) continue;
        const model = info.model;
        const route =
          model === undefined
            ? ''
            : (multiSelection.reviewers.find((candidate) => {
                const identity = routeModelIdentity(candidate, descriptors);
                return identity.providerID === model.providerID && identity.id === model.id;
              }) ?? model.id);
        reviewers.push({
          participant: info.agent ?? '',
          route,
          sessionId,
          model: model === undefined ? '' : `${model.providerID}/${model.id}`,
        });
      }
      job.multiReview = {
        revision: multiConfiguration!.revision,
        selection: multiSelection,
        rootSessionId,
        reviewers,
        synthesis: synthesisValue,
      };
      return {
        result: {
          version: 2,
          decision: synthesisValue.decision,
          markdown: synthesisValue.markdown,
        },
      };
    };
    try {
      // Phase 1: evidence root and immutable admission invariants.
      evidenceStartedAt = currentIso();
      job.executionStartedAt = evidenceStartedAt;
      if (!multi && (modelId === undefined || openCodeConfig === undefined)) {
        failure = { reason: 'agent' };
        return;
      }
      await mkdir(evidencePath, { recursive: true, mode: 0o700 });
      await chmod(evidencePath, 0o700);
      evidenceReady = true;
      await writeManifestAtomically(join(evidencePath, 'manifest.json'), {
        evidenceId,
        runId: job.input.runId,
        attempt: job.input.attempt,
        repositoryName: job.input.repositoryName,
        pullRequestNumber: job.input.pullRequestNumber,
        baseSha: job.input.baseSha,
        headSha: job.input.headSha,
        startedAt: evidenceStartedAt,
        complete: false,
        cleanup: { status: 'pending' },
      });
      if (job.abortRequested) return;
      await job.readToken?.ensureFresh();
      if (job.deadlineAt <= Date.now()) {
        failure = deadlineFailure(job);
        return;
      }
      // Remote relay execution never infers a default route: Core must have
      // materialized the frozen selection at admission. Fail before checkout.
      if (relayEnabled && multiSelection === undefined) {
        failure = { reason: 'configuration' };
        return;
      }
      // Explicit effort controls require the profile-aware v2 grant. A v1
      // issuer cannot carry them, so fail closed instead of silently dropping
      // the operator's selection. Only routes this job actually calls count; an
      // unused synthesis route must not block a single reviewer.
      const executionRoutes =
        multiSelection === undefined
          ? []
          : directExecution
            ? [multiSelection.reviewers[0]!]
            : dedupedRoutes(multiSelection);
      if (
        relayEnabled &&
        grantVersion === '1' &&
        (multiConfiguration?.efforts?.some(
          (effort) => effort.name !== undefined && executionRoutes.includes(effort.routeId),
        ) ??
          false)
      ) {
        failure = { reason: 'configuration' };
        return;
      }
      if (multi) {
        if (llmServiceClient === undefined || serviceBaseUrl === undefined) {
          failure = { reason: 'agent' };
          return;
        }
      }
      // Phase 2: checkout and merge-base verification.
      update(job, { status: 'running', stage: 'checkout' });
      job.progress?.stage('checkout');
      const checkoutRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-review-'));
      job.checkoutRoot = checkoutRoot;
      const mergeBaseSha = await prepareCheckout(job, checkoutRoot);
      if (job.abortRequested) return;
      if (job.deadlineAt <= Date.now()) {
        failure = deadlineFailure(job);
        return;
      }
      if (mergeBaseSha === undefined) {
        failure = { reason: 'checkout' };
        return;
      }
      await job.readToken?.ensureFresh();
      if (job.deadlineAt <= Date.now()) {
        failure = deadlineFailure(job);
        return;
      }

      // Phase 3: issue the job grant and stage its private token file.
      if (llmServiceClient !== undefined && multiSelection !== undefined) {
        const grantRoutes = directExecution
          ? [multiSelection.reviewers[0]!]
          : dedupedRoutes(multiSelection);
        // An ambiguous response is revoked by job identity and issuance is never
        // retried for this job; the short grant expiry bounds any lost response.
        job.grantIssuanceAttempted = true;
        const grantIdentity: LlmGrantIdentity = {
          runId: job.input.runId,
          jobId: job.id,
          attempt: job.input.attempt,
        };
        let grant: Awaited<ReturnType<typeof llmServiceClient.issue>>;
        try {
          grant = await llmServiceClient.issue(grantIdentity, grantRoutes);
        } catch (error) {
          // Keep issuance failures distinguishable without recording the
          // response body, route descriptors or the would-be grant.
          const reason = error instanceof LlmGrantIssueError ? error.reason : 'transport-error';
          const status = error instanceof LlmGrantIssueError ? error.status : undefined;
          await recordLog({
            phase: 'runner',
            outcome: 'grant',
            runId: job.input.runId,
            jobId: job.id,
            attempt: job.input.attempt,
            reason,
            ...(status === undefined ? {} : { status }),
          });
          failure = { reason: 'agent' };
          return;
        }
        if (grant.expiresAt < job.deadlineAt + FINALIZATION_BUDGET_MS) {
          failure = { reason: 'agent' };
          return;
        }
        descriptors = grant.descriptors;
        job.grantToken = grant.token;
        const grantRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-llm-grant-'));
        job.grantRoot = grantRoot;
        const tokenPath = join(grantRoot, 'job-token');
        await writeFile(tokenPath, grant.token, { mode: 0o600 });
        job.grantTokenPath = tokenPath;
      }
      if (job.abortRequested) return;

      // Phase 4: construct the isolated OpenCode configuration and sandbox.
      const promptReviewers = multi
        ? participants(multiSelection).map(({ participant, route }) => ({
            participant,
            model: routeModelIdentity(route, descriptors).reference,
          }))
        : modelId === undefined
          ? []
          : [{ participant: 'reviewer-0', model: modelId }];
      const promptInput = {
        repositoryName: job.input.repositoryName,
        pullRequestNumber: job.input.pullRequestNumber,
        baseSha: job.input.baseSha,
        mergeBaseSha,
        headSha: job.input.headSha,
        reviewers: promptReviewers,
      };
      const agentPrompt = reviewPrompt(promptInput);
      const configRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-opencode-config-'));
      job.configRoot = configRoot;
      for (const skill of reviewSkills) {
        const directory = join(configRoot, 'opencode', 'skills', skill.name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'SKILL.md'), skill.body);
        await writeFile(join(directory, 'LICENSE.md'), skill.license);
        await writeFile(join(directory, 'NOTICE.md'), skill.notice);
      }
      const activeOpenCodeConfig = multi
        ? multiReviewConfig({
            selection: multiSelection,
            descriptors,
            serviceBaseUrl: serviceBaseUrl!.toString(),
            shellPermissionRules,
            reviewerTask: reviewerSystemPrompt(promptInput),
          })
        : openCodeConfig;

      const sandbox = sandboxBackend.createJob({
        id: job.id,
        name: job.sandboxName,
        cpu: '4',
        memoryGib: 8,
        env: [
          `OPENCODE_CONFIG_CONTENT=${activeOpenCodeConfig!}`,
          'OPENCODE_DISABLE_PROJECT_CONFIG=1',
        ],
        checkoutRoot: join(checkoutRoot, 'checkout'),
        configRoot,
        modelResource,
        ...(job.grantTokenPath === undefined ? {} : { modelTokenFile: job.grantTokenPath }),
        githubResource: 'api.github.com:443',
        githubReadToken: job.input.repositoryReadToken,
      });
      job.sandbox = sandbox;
      job.sandboxAttempted = true;
      job.progress?.stage('sandbox');
      const setupPort: SandboxExecPort = {
        run: (program, args, processOptions, diagnostic) =>
          runTracked(job, program, args, processOptions, diagnostic),
      };
      try {
        await sandbox.setup(setupPort);
      } catch (error) {
        job.sandboxCreated = sandbox.metadata.created;
        if (
          error instanceof SandboxCreateError &&
          error.timedOut &&
          remainingExecutionMs(job) <= 0
        ) {
          // The create consumed the job's limiting clock rather than only its
          // ordinary per-command timeout. Report the actual exhausted deadline.
          failure = deadlineFailure(job);
          return;
        }
        executionCause =
          error instanceof SandboxCreateError
            ? error.timedOut
              ? 'timeout'
              : 'process-exit'
            : undefined;
        failure = {
          reason: 'agent',
          ...(executionCause === undefined ? {} : { cause: executionCause }),
        };
        return;
      }
      job.sandboxCreated = sandbox.metadata.created;
      if (job.abortRequested) return;
      const githubPreflight = await sandbox.exec(
        ['gh', 'api', '--silent', 'installation/repositories'],
        setupPort,
        {},
        { stage: 'sandbox', command: 'github-preflight' },
      );
      await job.readToken?.ensureFresh();
      if (job.deadlineAt <= Date.now()) {
        failure = deadlineFailure(job);
        return;
      }
      if (githubPreflight.exitCode !== 0 || githubPreflight.timedOut) {
        failure = { reason: 'agent' };
        return;
      }
      const agentRemaining = remainingExecutionMs(job);
      if (agentRemaining <= 0) {
        failure = deadlineFailure(job);
        return;
      }
      // Phase 5: run the review agent and its bounded same-session correction.
      update(job, { stage: 'agent' });
      job.progress?.stage('agent');
      const agentRoute = multi
        ? directExecution
          ? multiSelection.reviewers[0]!
          : multiSelection.synthesis
        : undefined;
      const agentIdentity =
        agentRoute === undefined ? undefined : routeModelIdentity(agentRoute, descriptors);
      const agentModel = agentIdentity?.reference ?? modelId;
      const agentName = multi && !directExecution ? SUPERVISOR_AGENT_ID : 'review';
      executionModel = agentModel;
      submissionIdentity =
        agentIdentity === undefined
          ? {
              agent: 'review',
              model: (() => {
                const reference = modelId!;
                const slash = reference.indexOf('/');
                return slash === -1
                  ? { providerID: 'opencode-go', id: reference }
                  : {
                      providerID: reference.slice(0, slash),
                      id: reference.slice(slash + 1),
                    };
              })(),
            }
          : {
              agent: agentName,
              model: { providerID: agentIdentity.providerID, id: agentIdentity.id },
            };
      agent = await sandbox.exec(
        [
          'opencode',
          'run',
          '--standalone',
          '--format',
          'json',
          '--model',
          agentModel!,
          '--agent',
          agentName,
          agentPrompt,
        ],
        setupPort,
        {
          captureStdout: true,
          captureStderr: true,
          maxBytes: MAX_AGENT_OUTPUT_BYTES,
          timeoutMs: agentRemaining,
          stdoutFilePath: join(evidencePath, 'opencode.jsonl'),
          stderrFilePath: join(evidencePath, 'opencode.stderr'),
        },
      );
      agentEndedAt = Date.now();
      const sessionId = uniqueSessionIdFrom(agent.stdout);
      const initialStdout = parseResult(agent.stdout, sessionId);
      const recoveredProvider = agent.exitCode === 1 && (initialStdout.recoveredErrors ?? 0) > 0;
      if (
        !job.abortRequested &&
        (agent.exitCode === 0 || recoveredProvider) &&
        !agent.timedOut &&
        !agent.truncated &&
        agent.streamError !== true &&
        initialStdout.cause === undefined &&
        initialStdout.upstream === undefined
      ) {
        // A normal exit with no valid final result is only eligible for the one
        // correction when the exact session reached an authoritative normal
        // completion. A length/content-filter/error finish, a non-succeeded
        // outcome, or an ambiguous session identity must not resume a truncated
        // session.
        let normalCompletion = false;
        let needsCorrection = false;
        const precheckRemaining = job.deadlineAt - currentEpochMillis();
        if (sessionId !== undefined && precheckRemaining > 0) {
          const exported = await sandbox.exec(
            ['opencode', 'session', 'export', '--standalone', sessionId],
            setupPort,
            {
              captureStdout: true,
              maxBytes: MAX_AGENT_OUTPUT_BYTES,
              timeoutMs: Math.min(precheckRemaining, SUBMIT_REMINDER_BUDGET_MS),
            },
          );
          if (exported.exitCode === 0 && !exported.timedOut && exported.truncated !== true) {
            try {
              const value: unknown = JSON.parse(exported.stdout);
              normalCompletion = sessionSucceeded(value, sessionId);
              if (normalCompletion)
                needsCorrection =
                  extractReviewSubmission(value, submissionIdentity).value === undefined;
            } catch {
              normalCompletion = false;
              needsCorrection = false;
            }
          }
        }
        // Recompute after the export: it consumes shared deadline time.
        const remaining = job.deadlineAt - currentEpochMillis();
        if (
          !job.abortRequested &&
          sessionId !== undefined &&
          remaining > 0 &&
          normalCompletion &&
          needsCorrection
        ) {
          agentEndedAt = undefined;
          const reminder = await sandbox.exec(
            [
              'opencode',
              'run',
              '--standalone',
              '--session',
              sessionId,
              '--format',
              'json',
              '--model',
              agentModel!,
              '--agent',
              agentName,
              reviewCorrectionPrompt,
            ],
            setupPort,
            {
              captureStdout: true,
              captureStderr: true,
              maxBytes: MAX_AGENT_OUTPUT_BYTES,
              timeoutMs: Math.min(SUBMIT_REMINDER_BUDGET_MS, remaining),
              stdoutFilePath: join(evidencePath, 'opencode.jsonl'),
              stderrFilePath: join(evidencePath, 'opencode.stderr'),
              fileAppend: true,
            },
          );
          agentEndedAt = Date.now();
          const reminderParsed = parseResult(reminder.stdout, sessionId);
          const reminderRecovered = (reminderParsed.recoveredErrors ?? 0) > 0;
          const recoveredErrors =
            (initialStdout.recoveredErrors ?? 0) + (reminderParsed.recoveredErrors ?? 0);
          agentParsed =
            reminderParsed.cause !== undefined || reminderParsed.upstream !== undefined
              ? reminderParsed
              : reminder.exitCode !== 0 && !reminderRecovered
                ? { cause: 'process-exit' }
                : uniqueSessionIdFrom(reminder.stdout) === sessionId
                  ? recoveredErrors === 0
                    ? reminderParsed
                    : { ...reminderParsed, recoveredErrors }
                  : { cause: 'zero-results' };
          correctionTimeout = reminder.timedOut && remaining > SUBMIT_REMINDER_BUDGET_MS;
          agent = mergedAgentResult(agent, reminder);
        }
      }
    } catch {
      failure = { reason: 'agent' };
    } finally {
      // Stop the refresh loop before evidence/cleanup removes the active token
      // destination. An in-flight response is ignored when it settles late.
      job.readToken?.stop();
      if (
        job.readToken?.failed === true &&
        job.deadlineLimit === 'credential' &&
        (agentEndedAt ?? Date.now()) >= job.deadlineAt
      ) {
        executionCause = 'timeout';
        failure = { reason: 'timeout', cause: 'timeout', deadline: 'credential' };
      }
      // Revoke as soon as agent work ends, before evidence/archive/cleanup, so a
      // still-running Sandbox cannot keep using a finished job's grant.
      if (job.grantIssuanceAttempted) {
        revocationUnconfirmed = !(await revokeGrant(job));
        try {
          job.usage = await llmServiceClient?.usage(job.id);
        } catch {
          // Usage is optional telemetry: preserve review/cleanup outcomes when unavailable.
          void Effect.runPromise(
            Effect.logWarning('llm.usage.unavailable', { jobId: job.id }),
          ).catch(() => undefined);
        }
      }
      const submissionSessionId =
        agent === undefined ? undefined : uniqueSessionIdFrom(agent.stdout);
      let sessionTerminal = false;
      if (evidenceReady && job.sandboxCreated) {
        job.progress?.stage('evidence');
        try {
          const archiveDeadlineAt = currentEpochMillis() + ARCHIVE_PHASE_TIMEOUT_MS;
          const archivePort: SandboxExecPort = {
            run: (program, args, processOptions, diagnostic) =>
              runArchive(job, program, args, archiveDeadlineAt, processOptions, diagnostic),
          };
          const archived = await archiveEvidence({
            evidencePath,
            sandbox: job.sandbox!,
            archivePort,
            agent,
            submissionSessionId,
            multiSelection: job.input.reviewConfiguration?.selection ?? undefined,
            sessionIds: job.sessionIds,
          });
          evidenceComplete = archived.complete;
          sessionTerminal = archived.terminal;
          if (!evidenceComplete) evidenceFailure = 'archive-incomplete';
        } catch {
          evidenceFailure = 'archive-incomplete';
        }
      } else {
        evidenceFailure = 'sandbox-not-created';
      }
      if (evidenceReady) {
        const evidenceSecrets = jobCredentialValues(job);
        if (evidenceSecrets.length > 0) {
          try {
            if (await redactEvidenceTextFiles(evidencePath, evidenceSecrets)) {
              failure ??= { reason: 'evidence' };
              evidenceComplete = false;
              evidenceFailure = 'credential-in-output';
            }
          } catch {
            evidenceFailure = 'archive-incomplete';
            evidenceComplete = false;
          }
        }
      }
      // Raw stream observation survives pre-write redaction: an actual job
      // credential in model output is never publishable even when the evidence
      // files no longer contain the secret.
      if (agent?.credentialObserved === true) {
        failure ??= { reason: 'evidence' };
        if (evidenceReady) {
          evidenceComplete = false;
          evidenceFailure = 'credential-in-output';
        }
      }
      // A process that echoed the grant into its output must fail closed: the
      // evidence copy is scrubbed, but a review carrying the token is never
      // published as a modified result.
      const echoedGrant =
        job.grantToken !== undefined &&
        job.grantToken.length > 0 &&
        (agent?.stdout.includes(job.grantToken) === true ||
          agent?.stderr?.includes(job.grantToken) === true);
      if (echoedGrant && failure === undefined) {
        failure = { reason: 'agent' };
      }
      if (agent !== undefined && failure === undefined) {
        job.submissionCompletedAt = currentIso();
        const parsed = agentParsed ?? parseResult(agent.stdout, submissionSessionId);
        const recoveredProvider =
          agent.exitCode === 1 &&
          parsed.cause === undefined &&
          (parsed.recoveredErrors ?? 0) > 0 &&
          !agent.timedOut &&
          !agent.truncated &&
          agent.streamError !== true &&
          evidenceComplete &&
          sessionTerminal &&
          submissionSessionId !== undefined;
        if (agent.timedOut) {
          executionCause = 'timeout';
          failure = {
            reason: 'timeout',
            cause: executionCause,
            ...(correctionTimeout ? {} : { deadline: job.deadlineLimit }),
          };
        } else if (parsed.cause !== undefined) {
          executionCause = parsed.cause;
          failure = { reason: 'invalid-output', cause: executionCause };
        } else if (parsed.upstream !== undefined) {
          executionCause = 'upstream-error';
          failure = {
            reason: 'upstream',
            cause: executionCause,
            ...(parsed.upstream.httpStatus === undefined
              ? {}
              : { httpStatus: parsed.upstream.httpStatus }),
          };
        } else if (agent.exitCode !== 0 && !recoveredProvider) {
          executionCause = 'process-exit';
          failure = { reason: 'invalid-output', cause: executionCause };
        } else if (agent.truncated) {
          executionCause = 'output-truncated';
          failure = { reason: 'invalid-output', cause: executionCause };
        } else if (multi) {
          const validated = await validateMultiReview();
          if ('cause' in validated) {
            executionCause = validated.cause;
            failure = { reason: 'invalid-output', cause: executionCause };
          } else {
            result = validated.result;
          }
        } else if (submissionSessionId === undefined) {
          failure = { reason: 'invalid-output' };
        } else if (!sessionTerminal) {
          executionCause = 'missing-terminal-message';
          failure = { reason: 'invalid-output', cause: executionCause };
        } else {
          let exported: unknown;
          try {
            exported = JSON.parse(
              await readFile(
                join(evidencePath, `opencode-export-${submissionSessionId}.json`),
                'utf8',
              ),
            ) as unknown;
          } catch {
            exported = undefined;
          }
          const submission =
            exported === undefined
              ? undefined
              : extractReviewSubmission(exported, submissionIdentity);
          if (submission?.value === undefined) {
            executionCause = submission?.cause ?? 'missing-terminal-message';
            failure = { reason: 'invalid-output', cause: executionCause };
          } else {
            result = {
              version: 2,
              decision: submission.value.decision,
              markdown: submission.value.markdown,
            };
          }
        }
        if (result !== undefined && evidenceReady) {
          try {
            await writeFile(join(evidencePath, 'validated-review.md'), result.markdown, {
              mode: 0o600,
            });
          } catch {
            evidenceComplete = false;
            evidenceFailure = 'archive-incomplete';
          }
        }
      }
      // Phase 6: revoke, archive, clean up, persist evidence and publish.
      await finalizeExecution(job, {
        evidencePath,
        evidenceId,
        multiSelection,
        multiConfiguration,
        executionModel,
        evidenceStartedAt,
        evidenceReady,
        evidenceComplete,
        evidenceFailure,
        failure,
        result,
        agent,
        executionCause,
        revocationUnconfirmed,
      });
    }
  };

  const finalizeExecution = async (
    job: ExecutionJob,
    outcome: {
      readonly evidencePath: string;
      readonly evidenceId: string;
      readonly multiSelection: MultiReviewSelection | undefined;
      readonly multiConfiguration: RunnerJobInput['reviewConfiguration'];
      readonly executionModel: string | undefined;
      readonly evidenceStartedAt: string | undefined;
      readonly evidenceReady: boolean;
      readonly evidenceComplete: boolean;
      readonly evidenceFailure: string | undefined;
      readonly failure: ExecutionJobState['failure'];
      readonly result: StructuredReviewResult | undefined;
      readonly agent: RunnerProcessResult | undefined;
      readonly executionCause: RunnerFailureCauseValue | undefined;
      readonly revocationUnconfirmed: boolean;
    },
  ) => {
    const {
      evidencePath,
      evidenceId,
      multiSelection,
      multiConfiguration,
      executionModel,
      evidenceStartedAt,
      evidenceReady,
      result,
      agent,
      executionCause,
      revocationUnconfirmed,
    } = outcome;
    let evidenceComplete = outcome.evidenceComplete;
    let evidenceFailure = outcome.evidenceFailure;
    let failure = outcome.failure;
    // Retain the frozen selection and every available parent/child session as
    // a standalone provenance document, including partial child evidence when
    // validation failed. It is derived from the already-archived, redacted
    // exports.
    if (evidenceReady && multiSelection !== undefined) {
      try {
        const readSessionInfo = async (sessionId: string) => {
          try {
            const value = JSON.parse(
              await readFile(join(evidencePath, `opencode-export-${sessionId}.json`), 'utf8'),
            ) as unknown;
            return decodeSessionExport(value)?.info;
          } catch {
            return undefined;
          }
        };
        const sessions: unknown[] = [];
        for (const sessionId of job.sessionIds) {
          const info = await readSessionInfo(sessionId);
          sessions.push({
            sessionId,
            ...(info === undefined
              ? {}
              : {
                  parentID: info.parentID ?? null,
                  agent: info.agent ?? null,
                  model: info.model ?? null,
                  outcome: info.outcome ?? null,
                }),
          });
        }
        const document =
          job.multiReview === undefined
            ? {
                revision: multiConfiguration!.revision,
                frozenSelection: {
                  reviewers: [...multiSelection.reviewers],
                  synthesis: multiSelection.synthesis,
                },
                rootSessionId: job.sessionIds[0] ?? null,
                sessions,
              }
            : {
                revision: job.multiReview.revision,
                frozenSelection: {
                  reviewers: [...job.multiReview.selection.reviewers],
                  synthesis: job.multiReview.selection.synthesis,
                },
                rootSessionId: job.multiReview.rootSessionId,
                sessions,
                reviewers: job.multiReview.reviewers.map((reviewer) => ({
                  participant: reviewer.participant,
                  route: reviewer.route,
                  sessionId: reviewer.sessionId,
                  model: reviewer.model,
                })),
                synthesis: {
                  sessionId: job.multiReview.rootSessionId,
                  model: executionModel!,
                  decision: job.multiReview.synthesis.decision,
                  markdown: job.multiReview.synthesis.markdown,
                },
              };
        await writeFile(
          join(evidencePath, 'multi-review.json'),
          JSON.stringify(document, null, 2) + '\n',
          { mode: 0o600 },
        );
      } catch {
        evidenceComplete = false;
        // Preserve a security-relevant cause recorded before this write.
        evidenceFailure ??= 'archive-incomplete';
      }
    }
    if (failure === undefined && result !== undefined && !evidenceComplete) {
      failure = { reason: 'evidence' };
    }
    job.input.repositoryReadToken = '';
    let cleaned = false;
    try {
      cleaned = await cleanup(job);
    } catch {
      cleaned = false;
    }
    job.cleanupCompletedAt = currentIso();
    if (!cleaned) {
      failure = {
        reason: 'cleanup',
        ...(executionCause === undefined ? {} : { cause: executionCause }),
      };
    }
    if (revocationUnconfirmed) {
      // An unconfirmed revocation is a terminal failure with no vote; the
      // Sandbox cleanup status above still reports what actually happened.
      failure ??= { reason: 'agent' };
    }
    let finalStatus: ExecutionJobState['status'] = revocationUnconfirmed
      ? 'failed'
      : job.abortRequested && cleaned
        ? 'aborted'
        : failure !== undefined
          ? 'failed'
          : 'succeeded';
    let finalFailure = finalStatus === 'failed' ? failure : undefined;
    let manifestFinalized = !evidenceReady;
    if (evidenceReady) {
      try {
        await secureEvidenceTree(evidencePath);
        const evidenceStatus = evidenceComplete ? 'complete' : 'incomplete';
        await writeManifestAtomically(join(evidencePath, 'manifest.json'), {
          jobId: job.id,
          sandboxName: job.sandboxName,
          sandboxId: job.sandbox?.metadata.id ?? job.sandboxName,
          sandboxRuntimeName: job.sandbox?.metadata.name ?? job.sandboxName,
          runtime: job.sandbox?.metadata.runtime ?? sandboxBackend.kind,
          recoveryProof: job.sandbox?.metadata.recoveryProof,
          evidenceId,
          runId: job.input.runId,
          attempt: job.input.attempt,
          repositoryName: job.input.repositoryName,
          pullRequestNumber: job.input.pullRequestNumber,
          baseSha: job.input.baseSha,
          headSha: job.input.headSha,
          startedAt: evidenceStartedAt,
          finishedAt: currentIso(),
          model: executionModel,
          ...(job.usage === undefined ? {} : { usage: job.usage }),
          image: job.sandbox?.metadata.imageRef ?? sandboxBackend.kind,
          openCodeVersion: OPENCODE_VERSION,
          agent: {
            exitCode: agent?.exitCode ?? null,
            timedOut: agent?.timedOut ?? false,
            truncated: agent?.truncated ?? false,
            stderrTruncated: agent?.stderrTruncated ?? false,
            streamError: agent?.streamError ?? false,
          },
          // The archived `opencode session list` enumerates roots only, and
          // Core requires the manifest list to match it exactly. A multi job
          // keeps every child in `job.sessionIds` for archive, validation and
          // redaction, but serializes only the root here; child provenance
          // remains in multiReview and multi-review.json.
          sessionIds: multiSelection === undefined ? job.sessionIds : job.sessionIds.slice(0, 1),
          ...(multiSelection === undefined
            ? {}
            : {
                selection: {
                  revision: multiConfiguration!.revision,
                  reviewers: [...multiSelection.reviewers],
                  synthesis: multiSelection.synthesis,
                  ...(multiSelection.efforts === undefined
                    ? {}
                    : { efforts: multiSelection.efforts }),
                },
                // The admission-time frozen selection is recorded even when
                // later validation fails, so a failed job still shows which
                // roster was attempted.
                frozenSelection: {
                  reviewers: [...multiSelection.reviewers],
                  synthesis: multiSelection.synthesis,
                  ...(multiSelection.efforts === undefined
                    ? {}
                    : { efforts: multiSelection.efforts }),
                },
                ...(job.multiReview === undefined
                  ? {}
                  : {
                      multiReview: {
                        revision: job.multiReview.revision,
                        frozenSelection: {
                          reviewers: [...job.multiReview.selection.reviewers],
                          synthesis: job.multiReview.selection.synthesis,
                          ...(job.multiReview.selection.efforts === undefined
                            ? {}
                            : { efforts: job.multiReview.selection.efforts }),
                        },
                        rootSessionId: job.multiReview.rootSessionId,
                        reviewers: job.multiReview.reviewers.map((reviewer) => ({
                          participant: reviewer.participant,
                          route: reviewer.route,
                          sessionId: reviewer.sessionId,
                          model: reviewer.model,
                        })),
                        synthesis: {
                          sessionId: job.multiReview.rootSessionId,
                          model: executionModel!,
                          decision: job.multiReview.synthesis.decision,
                          markdown: job.multiReview.synthesis.markdown,
                        },
                      },
                    }),
              }),
          validation: {
            status: agent === undefined ? 'not-run' : result === undefined ? 'invalid' : 'valid',
          },
          // Present only for a successful, validated version-2 submission.
          // Core checks this exact decision/version/markdown against the
          // callback result and the validated-review.md Markdown bytes. A
          // terminal failure (cleanup, evidence, abort) clears it.
          ...(finalStatus !== 'succeeded' || result === undefined ? {} : { result }),
          execution:
            finalStatus === 'aborted'
              ? { status: 'aborted', validation: 'not-run' }
              : finalFailure !== undefined
                ? {
                    status: 'failed',
                    reason: finalFailure.reason,
                    ...(finalFailure.cause === undefined ? {} : { cause: finalFailure.cause }),
                    ...(finalFailure.deadline === undefined
                      ? {}
                      : { deadline: finalFailure.deadline }),
                    ...(finalFailure.httpStatus === undefined
                      ? {}
                      : { httpStatus: finalFailure.httpStatus }),
                  }
                : { status: 'succeeded', validation: 'valid-review-result' },
          terminal: {
            status: finalStatus,
            ...(finalFailure === undefined ? {} : { reason: finalFailure.reason }),
            ...(finalFailure?.cause === undefined ? {} : { cause: finalFailure.cause }),
            ...(finalFailure?.deadline === undefined ? {} : { deadline: finalFailure.deadline }),
            ...(finalFailure?.httpStatus === undefined
              ? {}
              : { httpStatus: finalFailure.httpStatus }),
          },
          evidence: { id: evidenceId, status: evidenceStatus },
          complete: evidenceComplete && evidenceFailure === undefined,
          evidenceFailure,
          cleanup: {
            status: job.state.sandbox.cleanup === 'destroyed' ? 'destroyed' : 'failed',
          },
          hostCleanupConfirmed: job.hostCleanupConfirmed === true,
          files: await evidenceFiles(evidencePath),
        });
        manifestFinalized = true;
      } catch {
        evidenceFailure = 'manifest-finalization-failed';
        evidenceComplete = false;
      }
    }
    if (!manifestFinalized && finalStatus === 'succeeded') {
      failure = { reason: 'evidence' };
      finalStatus = 'failed';
      finalFailure = failure;
    }
    update(job, {
      evidence: { id: evidenceId, status: evidenceComplete ? 'complete' : 'incomplete' },
    });
    try {
      job.progress?.stop();
      await sendCallback({
        evidencePath,
        identity: {
          id: job.id,
          runId: job.input.runId,
          attempt: job.input.attempt,
          baseSha: job.input.baseSha,
          headSha: job.input.headSha,
        },
        status: finalStatus,
        stage: job.state.stage,
        failure: finalFailure,
        result,
        lifecycle: job.progress?.snapshot,
        usage: job.usage,
        sandbox: job.state.sandbox,
        evidence: job.state.evidence,
        sessionIds: job.sessionIds,
        timestamps: {
          executionStartedAt: job.executionStartedAt,
          submissionCompletedAt: job.submissionCompletedAt,
          cleanupCompletedAt: job.cleanupCompletedAt,
        },
      });
    } catch {
      // Callback serialization or transport failure must not discard local evidence.
    }
    update(
      job,
      finalStatus === 'aborted'
        ? { status: 'aborted', failure: undefined, result: undefined }
        : finalStatus === 'failed'
          ? { status: 'failed', failure: finalFailure, result: undefined }
          : { status: 'succeeded', result, failure: undefined },
    );
    const terminalStatus = job.state.status;
    if (
      terminalStatus === 'succeeded' ||
      terminalStatus === 'failed' ||
      terminalStatus === 'aborted'
    ) {
      // One terminal diagnostic after callback and cleanup so operators can
      // tell a local terminal state (and its cleanup result) apart from a
      // delivery or inspection problem.
      await recordLog({
        phase: 'runner',
        outcome: 'terminal',
        runId: job.input.runId,
        jobId: job.id,
        status: terminalStatus,
        cleanup: job.state.sandbox.cleanup,
      });
    }
    retire(job.handle);
    requestNextJob?.();
    try {
      // Diagnostics are independent after the terminal result is settled and
      // the Job slot is released. Their size or transport never changes it.
      await sendEvidence({
        evidencePath,
        identity: { id: job.id, runId: job.input.runId, attempt: job.input.attempt },
        evidence: job.state.evidence,
        sessionIds: job.sessionIds,
        timestamps: {
          executionStartedAt: job.executionStartedAt,
          submissionCompletedAt: job.submissionCompletedAt,
          cleanupCompletedAt: job.cleanupCompletedAt,
        },
      });
    } catch {
      // The complete local evidence directory remains available.
    }
  };

  const execute = async (input: JobExecutionInput, handle: JobHandle) => {
    const admittedAt = Date.now();
    const claimDeadlineAt = input.claimDeadlineAt ?? handle.claimDeadlineAt;
    const credentialDeadlineAt =
      input.repositoryReadTokenExpiresAt === undefined
        ? undefined
        : input.repositoryReadTokenExpiresAt - 60 * 1000;
    const rotatingCredential =
      readTokenClient !== undefined &&
      input.repositoryReadTokenExpiresAt !== undefined &&
      input.repositoryReadTokenExpiresAt > admittedAt;
    const deadlineLimit =
      !rotatingCredential &&
      credentialDeadlineAt !== undefined &&
      credentialDeadlineAt < claimDeadlineAt
        ? 'credential'
        : 'claim';
    const job: ExecutionJob = {
      handle,
      state: handle.state,
      input: { ...input, claimDeadlineAt },
      id: handle.id,
      sandboxName: `compte-rendu-${handle.id}`,
      get abortRequested() {
        return handle.abortRequested;
      },
      sandboxAttempted: false,
      sandboxCreated: false,
      grantIssuanceAttempted: false,
      grantRevoked: false,
      sessionIds: [],
      claimDeadlineAt,
      deadlineAt: rotatingCredential
        ? claimDeadlineAt
        : Math.min(claimDeadlineAt, credentialDeadlineAt ?? Number.POSITIVE_INFINITY),
      deadlineLimit,
      processCredentialValues: [],
    };
    const stopExecution = () => {
      const child = job.child;
      if (child !== undefined) {
        stop(child);
        setTimeout(() => stop(child, 'SIGKILL'), 5_000);
      }
    };
    job.readToken = createReadTokenLease({
      identity: { runId: input.runId, jobId: handle.id, attempt: input.attempt },
      initialToken: input.repositoryReadToken,
      initialExpiresAt: input.repositoryReadTokenExpiresAt,
      claimDeadlineAt,
      enabled: rotatingCredential,
      client: readTokenClient,
      sandbox: () => job.sandbox,
      host: {
        updateToken: (token, expiresAt) => {
          job.input.repositoryReadToken = token;
          job.input.repositoryReadTokenExpiresAt = expiresAt;
        },
        applyFallback: (fallbackAt) => {
          if (fallbackAt < job.deadlineAt) {
            job.deadlineAt = fallbackAt;
            job.deadlineLimit = 'credential';
          }
          void Effect.runPromise(
            Effect.logWarning('runner.read-token.refresh-failed', { jobId: job.id }),
          ).catch(() => undefined);
        },
        reachCredentialDeadline: () => {
          if (Date.now() >= job.deadlineAt) stopExecution();
        },
      },
    });
    job.progress = createProgressReporter({
      identity: { id: handle.id, runId: input.runId, attempt: input.attempt },
      callbackUrl,
      callbackToken,
      fetch: progressFetch,
      runtime: () => job.sandbox?.metadata.runtime ?? sandboxBackend.kind,
    });
    handle.setAbortHandler(() => {
      job.readToken?.stop();
      stopExecution();
      void revokeGrant(job).catch(() => undefined);
    });
    job.readToken.start();
    try {
      await executeJob(job);
    } finally {
      handle.setAbortHandler(undefined);
      job.readToken?.stop();
      job.readToken?.clearSecrets();
      job.progress?.stop();
      job.grantToken = '';
      job.processCredentialValues.length = 0;
      job.sandbox = undefined;
      job.multiReview = undefined;
      job.sessionIds = [];
      handle.resolveDone();
    }
  };

  return { execute };
};

import type { RunnerJobResponse as ExecutionJobState } from '@compte-rendu/contracts';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveReviewResult } from './agent-runner.js';
import type { CommandRunner } from './execution-commands.js';
import { jobCredentialValues, updateJobState, type ExecutionJob } from './execution-job.js';
import {
  archiveEvidence,
  createCallbackSender,
  createEvidenceUploader,
  evidenceFiles,
  redactEvidenceTextFiles,
  secureEvidenceTree,
  writeManifestAtomically,
} from './evidence-store.js';
import type { GrantRevoker } from './grant-revoker.js';
import { collectJobUsage, revokeJobGrant } from './job-grant.js';
import type { JobHandle } from './job-registry.js';
import type { LlmServiceClient } from './llm-service-client.js';
import { decodeSessionExport } from './opencode-multi-review.js';
import type { RecordLog, WarnLog } from './operational-log.js';
import { currentEpochMillis, currentIso, delayMillis } from './runner-clock.js';
import type { SandboxRuntimeKind } from './sandbox-runtime.js';
import { uniqueSessionIdFrom, type RunnerFailureCauseValue } from './opencode-config.js';

export const DEFAULT_DESTROY_RETRY_DELAYS_MS = [0, 3_000, 10_000] as const;
const ARCHIVE_PHASE_TIMEOUT_MS = 2 * 60 * 1000;
const OPENCODE_VERSION = '2.4.1';

type JobFailure = NonNullable<ExecutionJobState['failure']>;

export interface FinalizerOutcome {
  readonly evidencePath: string;
  readonly evidenceId: string;
  readonly evidenceStartedAt: string | undefined;
  readonly evidenceReady: boolean;
  readonly failure: JobFailure | undefined;
  readonly executionCause: RunnerFailureCauseValue | undefined;
}

export interface FinalizerDependencies {
  readonly commands: CommandRunner;
  readonly backendKind: SandboxRuntimeKind;
  readonly sendCallback: ReturnType<typeof createCallbackSender>;
  readonly sendEvidence: ReturnType<typeof createEvidenceUploader>;
  readonly recordLog: RecordLog;
  readonly warn: WarnLog;
  readonly grants: GrantRevoker;
  readonly llmServiceClient?: LlmServiceClient | undefined;
  readonly destroyRetryDelaysMs: readonly number[];
  readonly scheduleCleanupRecovery: () => void;
  readonly retire: (handle: JobHandle) => void;
  readonly requestNextJob?: (() => void) | undefined;
}

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

const cleanup = async (
  job: ExecutionJob,
  {
    commands,
    destroyRetryDelaysMs,
    scheduleCleanupRecovery,
  }: Pick<FinalizerDependencies, 'commands' | 'destroyRetryDelaysMs' | 'scheduleCleanupRecovery'>,
): Promise<boolean> => {
  job.progress?.stage('cleanup');
  // Host directory failures fail this task. Only sandbox destruction gates the next claim.
  let sandboxClean = true;
  if (job.sandboxAttempted) updateJobState(job, { stage: 'cleanup' });
  const cleanupPort = commands.cleanupPort(job);
  if (job.sandboxAttempted && job.sandbox !== undefined) {
    const sandbox = job.sandbox;
    const destroyDelays = destroyRetryDelaysMs.length === 0 ? [0] : destroyRetryDelaysMs;
    // A transient CLI/daemon failure is not proof that destruction failed.
    // Retry the same owned Sandbox briefly; a confirmed destroy is never
    // repeated after it succeeds, and an empty delay list still performs the
    // one required destroy attempt.
    for (const [index, delay] of destroyDelays.entries()) {
      if (delay > 0) await delayMillis(delay);
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
  job.hostCleanupConfirmed =
    !job.sandboxAttempted || job.sandbox?.metadata.hostCleanupConfirmed === true;
  updateJobState(job, { sandbox: { cleanup: sandboxClean ? 'destroyed' : 'failed' } });
  if (job.handle.cleanupRecoveryPending) scheduleCleanupRecovery();
  return clean;
};

/**
 * Terminal stage for one execution: stops the credential lease, revokes the
 * grant, archives and redacts evidence, resolves the validated review, destroys
 * the sandbox with bounded retries, finalizes the local manifest, then sends
 * the slim callback and the independent best-effort diagnostic upload.
 */
export const finalizeExecution = async (
  job: ExecutionJob,
  outcome: FinalizerOutcome,
  {
    commands,
    backendKind,
    sendCallback,
    sendEvidence,
    recordLog,
    warn,
    grants,
    llmServiceClient,
    destroyRetryDelaysMs,
    scheduleCleanupRecovery,
    retire,
    requestNextJob,
  }: FinalizerDependencies,
): Promise<void> => {
  const { evidencePath, evidenceId, evidenceStartedAt, evidenceReady } = outcome;
  const multiConfiguration = job.input.reviewConfiguration;
  const multiSelection = multiConfiguration?.selection ?? undefined;
  const agent = job.agent;
  const executionModel = job.executionModel;
  let failure = outcome.failure;
  let executionCause = outcome.executionCause;
  let result: import('@compte-rendu/contracts').StructuredReviewResult | undefined;

  // Stop the refresh loop before evidence/cleanup removes the active token
  // destination. An in-flight response is ignored when it settles late.
  job.readToken?.stop();
  if (
    job.readToken?.failed === true &&
    job.deadlineLimit === 'credential' &&
    (job.agentEndedAt ?? Date.now()) >= job.deadlineAt
  ) {
    executionCause = 'timeout';
    failure = { reason: 'timeout', cause: 'timeout', deadline: 'credential' };
  }
  // Revoke as soon as agent work ends, before evidence/archive/cleanup, so a
  // still-running Sandbox cannot keep using a finished job's grant.
  let revocationUnconfirmed = false;
  if (job.grantIssuanceAttempted) {
    revocationUnconfirmed = !(await revokeJobGrant(job, { grants, llmServiceClient }));
    await collectJobUsage(job, { llmServiceClient, warn });
  }

  const submissionSessionId = agent === undefined ? undefined : uniqueSessionIdFrom(agent.stdout);
  let evidenceComplete = false;
  let evidenceFailure: string | undefined;
  let sessionTerminal = false;
  if (evidenceReady && job.sandboxCreated) {
    job.progress?.stage('evidence');
    try {
      const archiveDeadlineAt = currentEpochMillis() + ARCHIVE_PHASE_TIMEOUT_MS;
      const archived = await archiveEvidence({
        evidencePath,
        sandbox: job.sandbox!,
        archivePort: {
          run: (program, args, processOptions, diagnostic) =>
            commands.runArchive(job, program, args, archiveDeadlineAt, processOptions, diagnostic),
        },
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

  const resolution = await resolveReviewResult(job, {
    evidencePath,
    evidenceReady,
    evidenceComplete,
    evidenceFailure,
    sessionTerminal,
    failure,
    executionCause,
  });
  failure = resolution.failure;
  executionCause = resolution.executionCause;
  result = resolution.result;
  evidenceComplete = resolution.evidenceComplete;
  evidenceFailure = resolution.evidenceFailure;

  // Retain the frozen selection and every available parent/child session as a
  // standalone provenance document, including partial child evidence when
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
    cleaned = await cleanup(job, {
      commands,
      destroyRetryDelaysMs,
      scheduleCleanupRecovery,
    });
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
        runtime: job.sandbox?.metadata.runtime ?? backendKind,
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
        image: job.sandbox?.metadata.imageRef ?? backendKind,
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
  updateJobState(job, {
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
  updateJobState(
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

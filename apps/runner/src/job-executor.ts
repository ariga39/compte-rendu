import type { OperationalLog } from '@compte-rendu/contracts';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareCheckout } from './checkout.js';
import { createCommandRunner } from './execution-commands.js';
import {
  deadlineFailure,
  updateJobState as update,
  type ExecutionJob,
  type JobExecutionInput,
} from './execution-job.js';
import {
  createCallbackSender,
  createEvidenceUploader,
  writeManifestAtomically,
} from './evidence-store.js';
import type { GrantRevoker } from './grant-revoker.js';
import { DEFAULT_DESTROY_RETRY_DELAYS_MS, finalizeExecution } from './job-finalizer.js';
import { issueJobGrant, revokeJobGrant } from './job-grant.js';
import type { JobHandle } from './job-registry.js';
import type { LlmServiceClient } from './llm-service-client.js';
import { runAgentStage } from './agent-runner.js';
import { createBestEffortLog } from './operational-log.js';
import { dedupedRoutes } from './opencode-multi-review.js';
import type { RunnerFailureCauseValue } from './opencode-config.js';
import { createProgressReporter } from './progress-reporter.js';
import type { ReadTokenClient } from './read-token-client.js';
import { createReadTokenLease } from './read-token-lease.js';
import { currentIso } from './runner-clock.js';
import { stop } from './runner-process.js';
import { sandboxResourceName } from './sandbox-resource-name.js';
import type { RunnerProcess, SandboxBackend } from './sandbox-runtime.js';

export type { JobExecutionInput } from './execution-job.js';

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
  readonly llmServiceClient: LlmServiceClient;
  readonly readTokenClient?: ReadTokenClient | undefined;
  readonly serviceBaseUrl: URL;
  readonly modelResource: string;
  readonly log?: OperationalLog | undefined;
  readonly retire: (handle: JobHandle) => void;
  readonly scheduleCleanupRecovery: () => void;
  readonly requestNextJob?: (() => void) | undefined;
}

/**
 * Assembly and phase sequencing for one Job execution. It owns the execution
 * stack lifetime and delegates stage behavior to the checkout, agent-runner,
 * grant and finalizer modules.
 */
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
    destroyRetryDelaysMs,
    evidenceUrl,
    evidenceFetch,
    evidenceTimeoutMs,
    progressFetch,
    grants: grantRevoker,
    llmServiceClient,
    readTokenClient,
    serviceBaseUrl,
    modelResource,
    log,
    scheduleCleanupRecovery,
    retire,
    requestNextJob,
  } = deps;
  const operationalLog = createBestEffortLog(log);
  const commands = createCommandRunner({
    process: executeProcess,
    recordLog: operationalLog.record,
  });
  const sendCallback = createCallbackSender({
    url: callbackUrl,
    token: callbackToken,
    fetch: callbackFetch,
    timeoutMs: callbackTimeoutMs,
    retryDelaysMs: callbackRetryDelaysMs,
    recordLog: operationalLog.record,
  });
  const sendEvidence = createEvidenceUploader({
    url: evidenceUrl,
    token: callbackToken,
    fetch: evidenceFetch,
    warn: operationalLog.warn,
    timeoutMs: evidenceTimeoutMs,
  });
  const grantLifecycle = {
    grants: grantRevoker,
    llmServiceClient,
    recordLog: operationalLog.record,
    warn: operationalLog.warn,
  };
  const finalizerDependencies = {
    commands,
    backendKind: sandboxBackend.kind,
    sendCallback,
    sendEvidence,
    recordLog: operationalLog.record,
    warn: operationalLog.warn,
    grants: grantRevoker,
    llmServiceClient,
    destroyRetryDelaysMs: destroyRetryDelaysMs ?? DEFAULT_DESTROY_RETRY_DELAYS_MS,
    scheduleCleanupRecovery,
    retire,
    requestNextJob,
  };

  const executeJob = async (job: ExecutionJob) => {
    const evidenceId = job.state.evidenceId ?? job.id;
    const evidencePath = join(evidenceRoot, evidenceId);
    const multiConfiguration = job.input.reviewConfiguration;
    const multiSelection = multiConfiguration?.selection ?? undefined;
    const directExecution = multiSelection !== undefined && multiSelection.reviewers.length === 1;
    let evidenceStartedAt: string | undefined;
    let evidenceReady = false;
    let failure: ExecutionJob['state']['failure'];
    let executionCause: RunnerFailureCauseValue | undefined;
    try {
      // Phase 1: evidence root and immutable admission invariants.
      evidenceStartedAt = currentIso();
      job.executionStartedAt = evidenceStartedAt;
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
      // Managed execution never infers a default route: Core must have
      // materialized the frozen selection at admission. Fail before checkout.
      if (multiSelection === undefined) {
        failure = { reason: 'configuration' };
        return;
      }
      const executionRoutes =
        multiSelection === undefined
          ? []
          : directExecution
            ? [multiSelection.reviewers[0]!]
            : dedupedRoutes(multiSelection);
      // Phase 2: checkout and merge-base verification.
      update(job, { status: 'running', stage: 'checkout' });
      job.progress?.stage('checkout');
      const mergeBaseSha = await prepareCheckout(job, commands);
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
      const grant = await issueJobGrant(job, executionRoutes, grantLifecycle);
      if (!grant.ok) {
        failure = { reason: 'agent' };
        return;
      }
      job.descriptors = grant.descriptors;
      if (job.abortRequested) return;

      // Phase 4-5: construct the sandbox and run the review agent.
      const agentResult = await runAgentStage(job, {
        backend: sandboxBackend,
        commands,
        evidencePath,
        mergeBaseSha,
        serviceBaseUrl,
        modelResource,
      });
      failure = agentResult.failure;
      executionCause = agentResult.executionCause;
    } catch {
      failure = { reason: 'agent' };
    } finally {
      // Phase 6: terminal delivery, cleanup and evidence persistence.
      await finalizeExecution(
        job,
        {
          evidencePath,
          evidenceId,
          evidenceStartedAt,
          evidenceReady,
          failure,
          executionCause,
        },
        finalizerDependencies,
      );
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
      sandboxName: sandboxResourceName(handle.id),
      get abortRequested() {
        return handle.abortRequested;
      },
      sandboxAttempted: false,
      sandboxCreated: false,
      correctionTimeout: false,
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
          operationalLog.warn('runner.read-token.refresh-failed', { jobId: job.id });
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
      void revokeJobGrant(job, { grants: grantRevoker, llmServiceClient }).catch(() => undefined);
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
      job.descriptors = undefined;
      job.agent = undefined;
      job.agentParsed = undefined;
      job.agentEndedAt = undefined;
      job.executionModel = undefined;
      job.submissionIdentity = undefined;
      job.multiReview = undefined;
      job.sessionIds = [];
      handle.resolveDone();
    }
  };

  return { execute };
};

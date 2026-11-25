import type { ModelRouteDescriptor, ModelUsageSummary } from '@compte-rendu/contracts';
import type {
  RunnerJobInput,
  RunnerJobResponse as ExecutionJobState,
} from '@compte-rendu/contracts';
import type { ChildProcess } from 'node:child_process';
import type { JobHandle } from './job-registry.js';
import type { ParsedAgentResult } from './opencode-config.js';
import type {
  MultiReviewSelection,
  ReviewSubmission,
  SessionIdentity,
} from './opencode-multi-review.js';
import type { ProgressReporter } from './progress-reporter.js';
import type { ReadTokenLease } from './read-token-lease.js';
import type { JobSandbox, RunnerProcessResult } from './sandbox-runtime.js';

export const MAX_DIAGNOSTIC_STDERR_BYTES = 4 * 1024;

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

export type RunnerMultiReviewEvidence = {
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

/**
 * Execution-scoped state for one admitted job. It never outlives the job:
 * sandboxes, child processes, token leases, grants and host directories are
 * released by the executor before the handle is retired.
 */
export interface ExecutionJob {
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
  sandbox?: JobSandbox;
  checkoutRoot?: string;
  configRoot?: string;
  /** Grant descriptors frozen for this attempt. */
  descriptors?: readonly ModelRouteDescriptor[];
  /** Raw agent observation; assigned progressively so archival keeps partial context. */
  agent?: RunnerProcessResult;
  agentParsed?: ParsedAgentResult;
  agentEndedAt?: number;
  correctionTimeout: boolean;
  executionModel?: string;
  submissionIdentity?: SessionIdentity;
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

export const readTokenSecretValues = (job: ExecutionJob): string[] =>
  [...new Set([job.input.repositoryReadToken, ...(job.readToken?.secrets ?? [])])].filter(
    (value) => value.length > 0,
  );

export const trackProcessCredentialValues = (
  job: ExecutionJob,
  values: readonly string[] | undefined,
) => {
  for (const value of values ?? []) {
    if (value.length > 0 && !job.processCredentialValues.includes(value))
      job.processCredentialValues.push(value);
  }
};

export const jobCredentialValues = (job: ExecutionJob): string[] =>
  [
    ...new Set([...readTokenSecretValues(job), job.grantToken, ...job.processCredentialValues]),
  ].filter((value): value is string => value !== undefined && value.length > 0);

export const remainingExecutionMs = (job: ExecutionJob) => Math.max(0, job.deadlineAt - Date.now());

export const updateJobState = (job: ExecutionJob, state: Partial<ExecutionJobState>) => {
  Object.assign(job.state, state);
};

export const deadlineFailure = (job: ExecutionJob): NonNullable<ExecutionJobState['failure']> => ({
  reason: 'timeout',
  deadline: job.deadlineLimit,
});

export const boundedDiagnostic = (job: ExecutionJob, value: string | undefined) => {
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

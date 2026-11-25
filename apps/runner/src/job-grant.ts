import type { ModelRouteDescriptor } from '@compte-rendu/contracts';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GrantRevoker } from './grant-revoker.js';
import type { ExecutionJob } from './execution-job.js';
import {
  LlmGrantIssueError,
  type LlmGrantIdentity,
  type LlmServiceClient,
} from './llm-service-client.js';
import type { RecordLog, WarnLog } from './operational-log.js';

const FINALIZATION_BUDGET_MS = 60 * 1000;

export interface GrantLifecycle {
  readonly grants: GrantRevoker;
  readonly llmServiceClient?: LlmServiceClient | undefined;
  readonly recordLog: RecordLog;
  readonly warn: WarnLog;
}

export type GrantIssueResult =
  | { readonly ok: true; readonly descriptors: readonly ModelRouteDescriptor[] | undefined }
  | { readonly ok: false };

/**
 * Issues the job-scoped LLM grant and stages its private token file. An
 * ambiguous response is revoked later by job identity and issuance is never
 * retried for this job; the short grant expiry bounds any lost response.
 */
export const issueJobGrant = async (
  job: ExecutionJob,
  routes: readonly string[],
  { llmServiceClient, recordLog }: GrantLifecycle,
): Promise<GrantIssueResult> => {
  if (llmServiceClient === undefined) return { ok: false };
  job.grantIssuanceAttempted = true;
  const grantIdentity: LlmGrantIdentity = {
    runId: job.input.runId,
    jobId: job.id,
    attempt: job.input.attempt,
  };
  let grant: Awaited<ReturnType<typeof llmServiceClient.issue>>;
  try {
    grant = await llmServiceClient.issue(grantIdentity, routes);
  } catch (error) {
    // Keep issuance failures distinguishable without recording the response
    // body, route descriptors or the would-be grant.
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
    return { ok: false };
  }
  if (grant.expiresAt < job.deadlineAt + FINALIZATION_BUDGET_MS) return { ok: false };
  job.grantToken = grant.token;
  const grantRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-llm-grant-'));
  job.grantRoot = grantRoot;
  const tokenPath = join(grantRoot, 'job-token');
  await writeFile(tokenPath, grant.token, { mode: 0o600 });
  job.grantTokenPath = tokenPath;
  return { ok: true, descriptors: grant.descriptors };
};

/** Revokes the job grant at most once; an unconfirmed revocation is terminal. */
export const revokeJobGrant = async (
  job: ExecutionJob,
  { grants: grantRevoker, llmServiceClient }: Pick<GrantLifecycle, 'grants' | 'llmServiceClient'>,
): Promise<boolean> => {
  if (llmServiceClient === undefined || job.grantRevoked) return true;
  if (!job.grantIssuanceAttempted) return true;
  const revoked = await grantRevoker.revoke(job.id, true);
  if (revoked) job.grantRevoked = true;
  return revoked;
};

/** Usage is optional telemetry: preserve review/cleanup outcomes when unavailable. */
export const collectJobUsage = async (
  job: ExecutionJob,
  { llmServiceClient, warn }: Pick<GrantLifecycle, 'llmServiceClient' | 'warn'>,
): Promise<void> => {
  if (llmServiceClient === undefined || !job.grantIssuanceAttempted) return;
  try {
    job.usage = await llmServiceClient.usage(job.id);
  } catch {
    warn('llm.usage.unavailable', { jobId: job.id });
  }
};

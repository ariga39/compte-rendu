import { Schema } from 'effect';
import {
  RunnerJobInput,
  RunnerJobResponse,
  type RunnerJobResponse as RunnerJobResponseValue,
} from '@compte-rendu/contracts';
import type {
  ReviewRunFailureReason,
  ReviewRunResult,
  ReviewRunSpec,
  ReviewRunner,
} from './review-run';

export interface RunnerJobBinding {
  readonly fetch: (request: Request) => Response | Promise<Response>;
}

export interface RunnerJobClientOptions {
  readonly binding: RunnerJobBinding;
  readonly authToken: string;
  readonly pollIntervalMs?: number;
  readonly deadlineMs?: number;
}

const CLIENT_BUDGET_MS = 14 * 60 * 1000;
const MAX_POLL_INTERVAL_MS = 5_000;
const MAX_POST_RETRIES = 3;

const authorizedRequest = (url: string, token: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return new Request(url, { ...init, headers });
};

const readResponse = async (
  response: Response,
  expectedStatus: number,
): Promise<RunnerJobResponseValue | undefined> => {
  if (response.status !== expectedStatus) return undefined;
  try {
    return await Schema.decodeUnknownPromise(RunnerJobResponse)(await response.json());
  } catch {
    return undefined;
  }
};

const matches = (
  state: RunnerJobResponseValue,
  input: { readonly id?: string; readonly runId: string; readonly attempt: number },
) =>
  (input.id === undefined || state.id === input.id) &&
  state.runId === input.runId &&
  state.attempt === input.attempt;

const failureReason = (state: RunnerJobResponseValue): ReviewRunFailureReason => {
  if (state.status === 'aborted' || state.failure?.reason === 'timeout') return 'timeout';
  if (state.failure?.reason !== undefined) return state.failure.reason;
  return 'agent';
};

const failed = (
  reason: ReviewRunFailureReason,
  attempt: number,
  sandboxId?: string,
): Extract<ReviewRunResult, { status: 'failed' }> => ({
  status: 'failed',
  reason,
  attempt,
  ...(sandboxId === undefined ? {} : { sandboxId }),
  retryable: reason !== 'timeout' && reason !== 'cleanup' && reason !== 'superseded',
});

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export const createRunnerJobClient = ({
  binding,
  authToken,
  pollIntervalMs = 1_000,
  deadlineMs = CLIENT_BUDGET_MS,
}: RunnerJobClientOptions): ReviewRunner => ({
  runJob: async (spec: ReviewRunSpec) => {
    const maxAttempts = Math.max(1, Math.min(spec.maxAttempts ?? 1, 3));
    const deadline = Date.now() + deadlineMs;
    let lastFailure = failed('agent', 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let initial: RunnerJobResponseValue | undefined;
      for (let retry = 0; retry < MAX_POST_RETRIES && Date.now() < deadline; retry += 1) {
        try {
          const response = await binding.fetch(
            authorizedRequest('https://runner.internal/jobs', authToken, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                runId: spec.runId,
                attempt,
                repositoryUrl: spec.repositoryUrl,
                baseSha: spec.baseSha,
                headSha: spec.headSha,
                checkoutToken: spec.checkoutToken,
              }),
            }),
          );
          const decoded = await readResponse(response, 202);
          if (decoded !== undefined && matches(decoded, { runId: spec.runId, attempt })) {
            initial = decoded;
            break;
          }
        } catch {
          // A POST response can be lost after the runner admits the job. Retry
          // the same idempotency key before considering a new attempt.
        }
        if (retry + 1 < MAX_POST_RETRIES) await delay(0);
      }

      if (initial === undefined) {
        lastFailure = failed('agent', attempt);
        break;
      }

      let state = initial;
      const deleteJob = async (requireAborted: boolean) => {
        try {
          const response = await binding.fetch(
            authorizedRequest(
              `https://runner.internal/jobs/${encodeURIComponent(state.id)}`,
              authToken,
              { method: 'DELETE' },
            ),
          );
          const deleted = await readResponse(response, 200);
          if (
            deleted === undefined ||
            !matches(deleted, { id: state.id, runId: spec.runId, attempt }) ||
            (requireAborted && deleted.status !== 'aborted') ||
            (deleted.status !== 'succeeded' &&
              deleted.status !== 'failed' &&
              deleted.status !== 'aborted') ||
            deleted.sandbox.cleanup !== 'destroyed'
          ) {
            return undefined;
          }
          return deleted;
        } catch {
          return undefined;
        }
      };

      const abortFor = async (reason: 'timeout' | 'superseded') => {
        const deleted = await deleteJob(true);
        return deleted === undefined
          ? failed('cleanup', attempt, state.id)
          : failed(reason, attempt, state.id);
      };

      while (state.status === 'queued' || state.status === 'running') {
        let superseded = false;
        if (spec.shouldAbort !== undefined) {
          try {
            superseded = await spec.shouldAbort();
          } catch {
            superseded = true;
          }
        }
        if (superseded) return abortFor('superseded');
        if (Date.now() >= deadline) return abortFor('timeout');

        await delay(Math.min(Math.max(0, pollIntervalMs), MAX_POLL_INTERVAL_MS));
        if (Date.now() >= deadline) return abortFor('timeout');

        let next: RunnerJobResponseValue | undefined;
        try {
          const response = await binding.fetch(
            authorizedRequest(
              `https://runner.internal/jobs/${encodeURIComponent(state.id)}`,
              authToken,
            ),
          );
          const decoded = await readResponse(response, 200);
          if (
            decoded !== undefined &&
            matches(decoded, { id: state.id, runId: spec.runId, attempt })
          ) {
            next = decoded;
          }
        } catch {
          next = undefined;
        }

        if (next === undefined) {
          const deleted = await deleteJob(false);
          if (deleted === undefined) return failed('cleanup', attempt, state.id);
          state = deleted;
          break;
        }
        state = next;
      }

      if (
        state.status === 'succeeded' &&
        state.sandbox.cleanup === 'destroyed' &&
        state.result !== undefined
      ) {
        return {
          status: 'succeeded',
          attempt,
          sandboxId: state.id,
          output: state.result,
        };
      }

      if (state.sandbox.cleanup !== 'destroyed') {
        const deleted = await deleteJob(false);
        if (deleted === undefined) return failed('cleanup', attempt, state.id);
        state = deleted;
      }

      lastFailure = failed(failureReason(state), attempt, state.id);
      if (!lastFailure.retryable) break;
    }

    return lastFailure;
  },
});

export { RunnerJobInput };

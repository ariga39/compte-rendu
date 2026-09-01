import { Schema } from 'effect';
import { RunnerJobInput, RunnerJobResponse } from '@compte-rendu/contracts';

export interface ReviewRunSpec {
  readonly id: string;
  readonly attempt: number;
  readonly runId: string;
  readonly repositoryUrl: string;
  readonly repositoryName: string;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly repositoryReadToken: string;
}

export interface RunnerJobBinding {
  readonly fetch: (request: Request) => Response | Promise<Response>;
}

export interface RunnerJobClientOptions {
  readonly binding: RunnerJobBinding;
  readonly authToken: string;
}

export interface RunnerJobSubmitter {
  readonly submitJob: (
    spec: ReviewRunSpec,
  ) => Promise<{ readonly id: string; readonly attempt: number }>;
}

const authorizedRequest = (token: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return new Request('http://runner.internal/jobs', { ...init, headers });
};

export const createRunnerJobClient = ({
  binding,
  authToken,
}: RunnerJobClientOptions): RunnerJobSubmitter => ({
  submitJob: async (spec) => {
    const body = JSON.stringify({
      id: spec.id,
      runId: spec.runId,
      attempt: spec.attempt,
      repositoryUrl: spec.repositoryUrl,
      repositoryName: spec.repositoryName,
      pullRequestNumber: spec.pullRequestNumber,
      baseSha: spec.baseSha,
      headSha: spec.headSha,
      repositoryReadToken: spec.repositoryReadToken,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await binding.fetch(
          authorizedRequest(authToken, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          }),
        );
        if (response.status !== 202) throw new Error('Runner Job admission failed');
        const admitted = await Schema.decodeUnknownPromise(RunnerJobResponse)(
          await response.json(),
        );
        if (
          admitted.id !== spec.id ||
          admitted.runId !== spec.runId ||
          admitted.attempt !== spec.attempt
        ) {
          throw new Error('Runner Job admission failed');
        }
        return { id: admitted.id, attempt: admitted.attempt };
      } catch (error) {
        if (attempt === 1) throw new Error('Runner Job admission failed', { cause: error });
      }
    }
    throw new Error('Runner Job admission failed');
  },
});

export { RunnerJobInput };

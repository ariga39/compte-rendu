import { Schema } from 'effect';
import {
  RunnerJobInput,
  RunnerJobResponse,
  type RunnerJobResponse as RunnerJobResponseValue,
} from '@compte-rendu/contracts';

export interface ReviewRunSpec {
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
    const response = await binding.fetch(
      authorizedRequest(authToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: spec.runId,
          attempt: 1,
          repositoryUrl: spec.repositoryUrl,
          repositoryName: spec.repositoryName,
          pullRequestNumber: spec.pullRequestNumber,
          baseSha: spec.baseSha,
          headSha: spec.headSha,
          repositoryReadToken: spec.repositoryReadToken,
        }),
      }),
    );
    if (response.status !== 202) throw new Error('Runner Job admission failed');
    let admitted: RunnerJobResponseValue;
    try {
      admitted = await Schema.decodeUnknownPromise(RunnerJobResponse)(await response.json());
    } catch {
      throw new Error('Runner Job admission failed');
    }
    if (admitted.runId !== spec.runId || admitted.attempt !== 1) {
      throw new Error('Runner Job admission failed');
    }
    return { id: admitted.id, attempt: admitted.attempt };
  },
});

export { RunnerJobInput };

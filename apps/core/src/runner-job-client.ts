import { Schema } from 'effect';
import { RunnerJobResponse } from '@compte-rendu/contracts';

export interface RunnerJobBinding {
  readonly fetch: (request: Request) => Response | Promise<Response>;
}

export interface RunnerJobClientOptions {
  readonly binding: RunnerJobBinding;
  readonly authToken: string;
}

export interface RunnerJobSubmitter {
  readonly cancelJob: (jobId: string) => Promise<void>;
}

const authorizedJobRequest = (token: string, jobId: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return new Request(`http://runner.internal/jobs/${encodeURIComponent(jobId)}`, {
    ...init,
    headers,
  });
};

export const createRunnerJobClient = ({
  binding,
  authToken,
}: RunnerJobClientOptions): RunnerJobSubmitter => ({
  cancelJob: async (jobId) => {
    const response = await binding.fetch(
      authorizedJobRequest(authToken, jobId, { method: 'DELETE' }),
    );
    if (response.status !== 200) throw new Error('Runner Job cleanup was not confirmed');
    const state = await Schema.decodeUnknownPromise(RunnerJobResponse)(await response.json());
    if (state.status !== 'aborted' || state.sandbox.cleanup !== 'destroyed') {
      throw new Error('Runner Job cleanup was not confirmed');
    }
  },
});

import { describe, expect, it } from 'vitest';
import { createRunnerJobClient } from '../apps/core/src/runner-job-client';

describe('operator stop delivery', () => {
  const attempt = { jobId: 'job-one', runId: 'run-one', attempt: 2, claimDeadlineAt: 12345678 };
  const terminal = {
    id: attempt.jobId,
    runId: attempt.runId,
    attempt: attempt.attempt,
    evidence: { id: 'evidence', status: 'complete' },
    stage: 'cleanup',
    status: 'succeeded',
    sandbox: { cleanup: 'destroyed' },
  };
  it.each([
    ['aborted', 200, { ...terminal, status: 'aborted' }, true],
    ['finished before cancellation arrived', 200, terminal, true],
    ['prior attempt', 200, { ...terminal, attempt: 1 }, false],
    ['different run', 200, { ...terminal, runId: 'another' }, false],
    ['different job', 200, { ...terminal, id: 'another' }, false],
    ['unconfirmed cleanup', 200, { ...terminal, sandbox: { cleanup: 'failed' } }, false],
    ['running', 200, { ...terminal, status: 'running' }, false],
    ['pending stop', 202, {}, false],
    ['unknown job', 404, {}, false],
  ] as const)('%s', async (_, status, response, destroyed) => {
    const requests: Request[] = [];
    const client = createRunnerJobClient({
      authToken: 'test-token',
      binding: {
        fetch: async (req) => {
          requests.push(req);
          return Response.json(response, { status });
        },
      },
    });
    await expect(client.requestStop(attempt)).resolves.toBe(destroyed);
    expect(requests[0].method).toBe('DELETE');
    expect(new URL(requests[0].url).pathname).toBe('/jobs/job-one');
    expect(requests[0].headers.get('authorization')).toBe('Bearer test-token');
    expect(requests[0].headers.get('x-compte-rendu-claim-deadline')).toBe('12345678');
  });
});

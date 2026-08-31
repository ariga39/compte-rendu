import { describe, expect, it } from 'vitest';
import { createRunnerJobClient } from '../apps/core/src/runner-job-client';

const baseSha = '1111111111111111111111111111111111111111';
const headSha = '2222222222222222222222222222222222222222';

const runnerSpecFields = {
  repositoryName: 'acme/reviewed',
  pullRequestNumber: 42,
  repositoryReadToken: 'github-read-token',
};

const runnerResponse = (
  value: { readonly id: string; readonly status: string; readonly [key: string]: unknown },
  init?: ResponseInit,
) =>
  Response.json(
    {
      evidence: {
        id: value.id,
        status:
          value.status === 'succeeded'
            ? 'complete'
            : value.status === 'queued' || value.status === 'running'
              ? 'pending'
              : 'incomplete',
      },
      ...value,
    },
    init,
  );

describe('Runner Job client', () => {
  it('uses the HTTP VPC Service scheme for every Runner Job request', async () => {
    const requests: string[] = [];
    const runner = createRunnerJobClient({
      authToken: 'runner-auth-token',
      pollIntervalMs: 0,
      binding: {
        fetch: async (request) => {
          const url = new URL(request.url);
          requests.push(`${request.method} ${url.href}`);
          if (url.protocol !== 'http:') throw new Error('HTTP-only VPC Service rejected HTTPS');

          if (request.method === 'POST') {
            return runnerResponse(
              {
                id: 'job-http-scheme',
                runId: 'run-http-scheme',
                attempt: 1,
                status: 'queued',
                stage: 'admission',
                sandbox: { cleanup: 'pending' },
              },
              { status: 202 },
            );
          }
          if (request.method === 'GET') {
            return runnerResponse({
              id: 'job-http-scheme',
              runId: 'run-http-scheme',
              attempt: 1,
              status: 'failed',
              stage: 'cleanup',
              failure: { reason: 'agent' },
              sandbox: { cleanup: 'pending' },
            });
          }
          return runnerResponse({
            id: 'job-http-scheme',
            runId: 'run-http-scheme',
            attempt: 1,
            status: 'failed',
            stage: 'cleanup',
            failure: { reason: 'agent' },
            sandbox: { cleanup: 'destroyed' },
          });
        },
      },
    });

    await expect(
      runner.runJob({
        ...runnerSpecFields,
        runId: 'run-http-scheme',
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
        repositoryReadToken: 'short-lived-checkout-token',
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'agent', retryable: true });
    expect(requests).toEqual([
      'POST http://runner.internal/jobs',
      'GET http://runner.internal/jobs/job-http-scheme',
      'DELETE http://runner.internal/jobs/job-http-scheme',
    ]);
  });

  it('retries a lost POST response with the same attempt instead of advancing', async () => {
    const attempts: number[] = [];
    let postCount = 0;
    const runner = createRunnerJobClient({
      authToken: 'runner-auth-token',
      pollIntervalMs: 0,
      binding: {
        fetch: async (request) => {
          const url = new URL(request.url);
          if (request.method === 'POST' && url.pathname === '/jobs') {
            const body = (await request.json()) as { attempt: number };
            attempts.push(body.attempt);
            postCount += 1;
            if (postCount === 1) throw new Error('response lost after admission');
            return runnerResponse(
              {
                id: 'job-lost-post',
                runId: 'run-lost-post',
                attempt: body.attempt,
                status: 'queued',
                stage: 'admission',
                sandbox: { cleanup: 'pending' },
              },
              { status: 202 },
            );
          }
          if (request.method === 'GET' && url.pathname === '/jobs/job-lost-post') {
            return runnerResponse({
              id: 'job-lost-post',
              runId: 'run-lost-post',
              attempt: 1,
              status: 'succeeded',
              stage: 'cleanup',
              result: { findings: [], summary: 'No findings' },
              sandbox: { cleanup: 'destroyed' },
            });
          }
          return new Response(null, { status: 404 });
        },
      },
    });

    await expect(
      runner.runJob({
        ...runnerSpecFields,
        runId: 'run-lost-post',
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
        repositoryReadToken: 'short-lived-checkout-token',
        maxAttempts: 2,
      }),
    ).resolves.toMatchObject({ status: 'succeeded', attempt: 1 });
    expect(attempts).toEqual([1, 1]);
  });

  it('completes a review only after the authenticated job reports cleaned success', async () => {
    let statusReads = 0;
    const runner = createRunnerJobClient({
      authToken: 'runner-auth-token',
      pollIntervalMs: 0,
      binding: {
        fetch: async (request) => {
          expect(request.headers.get('authorization')).toBe('Bearer runner-auth-token');
          const url = new URL(request.url);
          if (request.method === 'POST' && url.pathname === '/jobs') {
            return runnerResponse(
              {
                id: 'job-1',
                runId: 'run-client-1',
                attempt: 1,
                status: 'queued',
                stage: 'admission',
                sandbox: { cleanup: 'pending' },
              },
              { status: 202 },
            );
          }
          if (request.method === 'GET' && url.pathname === '/jobs/job-1') {
            statusReads += 1;
            return statusReads === 1
              ? runnerResponse({
                  id: 'job-1',
                  runId: 'run-client-1',
                  attempt: 1,
                  status: 'running',
                  stage: 'agent',
                  sandbox: { cleanup: 'pending' },
                })
              : runnerResponse({
                  id: 'job-1',
                  runId: 'run-client-1',
                  status: 'succeeded',
                  attempt: 1,
                  stage: 'cleanup',
                  result: { findings: [], summary: 'No findings' },
                  sandbox: { cleanup: 'destroyed' },
                });
          }
          return new Response(null, { status: 404 });
        },
      },
    });

    const result = await runner.runJob({
      ...runnerSpecFields,
      runId: 'run-client-1',
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
      repositoryReadToken: 'short-lived-checkout-token',
    });

    expect(result).toEqual({
      status: 'succeeded',
      attempt: 1,
      sandboxId: 'job-1',
      output: { findings: [], summary: 'No findings' },
    });
  });

  it('deletes a known job after GET transport loss before starting a fresh attempt', async () => {
    const postedAttempts: number[] = [];
    let getLost = true;
    const runner = createRunnerJobClient({
      authToken: 'runner-auth-token',
      pollIntervalMs: 0,
      binding: {
        fetch: async (request) => {
          const url = new URL(request.url);
          if (request.method === 'POST') {
            const body = (await request.json()) as { runId: string; attempt: number };
            postedAttempts.push(body.attempt);
            const id = body.attempt === 1 ? 'job-get-lost' : 'job-fresh';
            return runnerResponse(
              {
                id,
                runId: body.runId,
                attempt: body.attempt,
                status: 'queued',
                stage: 'admission',
                sandbox: { cleanup: 'pending' },
              },
              { status: 202 },
            );
          }
          if (request.method === 'GET' && url.pathname === '/jobs/job-get-lost') {
            if (getLost) {
              getLost = false;
              throw new Error('GET response lost');
            }
            return runnerResponse({
              id: 'job-get-lost',
              runId: 'run-get-lost',
              attempt: 1,
              status: 'running',
              stage: 'agent',
              sandbox: { cleanup: 'pending' },
            });
          }
          if (request.method === 'DELETE' && url.pathname === '/jobs/job-get-lost') {
            return runnerResponse({
              id: 'job-get-lost',
              runId: 'run-get-lost',
              attempt: 1,
              status: 'failed',
              stage: 'cleanup',
              failure: { reason: 'agent' },
              sandbox: { cleanup: 'destroyed' },
            });
          }
          if (request.method === 'GET' && url.pathname === '/jobs/job-fresh') {
            return runnerResponse({
              id: 'job-fresh',
              runId: 'run-get-lost',
              attempt: 2,
              status: 'succeeded',
              stage: 'cleanup',
              result: { findings: [], summary: 'fresh' },
              sandbox: { cleanup: 'destroyed' },
            });
          }
          return new Response(null, { status: 404 });
        },
      },
    });

    await expect(
      runner.runJob({
        ...runnerSpecFields,
        runId: 'run-get-lost',
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
        repositoryReadToken: 'short-lived-checkout-token',
        maxAttempts: 2,
      }),
    ).resolves.toMatchObject({ status: 'succeeded', attempt: 2, sandboxId: 'job-fresh' });
    expect(postedAttempts).toEqual([1, 2]);
  });

  it('fails closed after DELETE transport loss without starting another attempt', async () => {
    let posts = 0;
    let deletes = 0;
    const runner = createRunnerJobClient({
      authToken: 'runner-auth-token',
      pollIntervalMs: 0,
      deadlineMs: 100,
      binding: {
        fetch: async (request) => {
          const url = new URL(request.url);
          if (request.method === 'POST') {
            posts += 1;
            return runnerResponse(
              {
                id: 'job-delete-loss',
                runId: 'run-delete-loss',
                attempt: 1,
                status: 'queued',
                stage: 'admission',
                sandbox: { cleanup: 'pending' },
              },
              { status: 202 },
            );
          }
          if (request.method === 'GET' && url.pathname === '/jobs/job-delete-loss') {
            return new Response(null, { status: 503 });
          }
          if (request.method === 'DELETE') {
            deletes += 1;
            throw new Error('DELETE response lost');
          }
          return new Response(null, { status: 404 });
        },
      },
    });

    await expect(
      runner.runJob({
        ...runnerSpecFields,
        runId: 'run-delete-loss',
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
        repositoryReadToken: 'short-lived-checkout-token',
        maxAttempts: 2,
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'cleanup', retryable: false });
    expect(posts).toBe(1);
    expect(deletes).toBe(1);
  });

  it('deletes and returns nonretryable superseded when the run becomes superseded', async () => {
    let deletes = 0;
    const runner = createRunnerJobClient({
      authToken: 'runner-auth-token',
      pollIntervalMs: 0,
      binding: {
        fetch: async (request) => {
          const url = new URL(request.url);
          if (request.method === 'POST') {
            return runnerResponse(
              {
                id: 'job-superseded',
                runId: 'run-superseded',
                attempt: 1,
                status: 'queued',
                stage: 'admission',
                sandbox: { cleanup: 'pending' },
              },
              { status: 202 },
            );
          }
          if (request.method === 'DELETE' && url.pathname === '/jobs/job-superseded') {
            deletes += 1;
            return runnerResponse({
              id: 'job-superseded',
              runId: 'run-superseded',
              attempt: 1,
              status: 'aborted',
              stage: 'cleanup',
              sandbox: { cleanup: 'destroyed' },
            });
          }
          return runnerResponse({
            id: 'job-superseded',
            runId: 'run-superseded',
            attempt: 1,
            status: 'running',
            stage: 'agent',
            sandbox: { cleanup: 'pending' },
          });
        },
      },
    });

    await expect(
      runner.runJob({
        ...runnerSpecFields,
        runId: 'run-superseded',
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
        repositoryReadToken: 'short-lived-checkout-token',
        shouldAbort: async () => true,
        maxAttempts: 2,
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'superseded', retryable: false });
    expect(deletes).toBe(1);
  });

  it('accepts a deadline only after DELETE returns the exact cleaned terminal state', async () => {
    let deletes = 0;
    const runner = createRunnerJobClient({
      authToken: 'runner-auth-token',
      pollIntervalMs: 0,
      deadlineMs: 1,
      binding: {
        fetch: async (request) => {
          const url = new URL(request.url);
          if (request.method === 'POST') {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return runnerResponse(
              {
                id: 'job-deadline',
                runId: 'run-deadline',
                attempt: 1,
                status: 'queued',
                stage: 'admission',
                sandbox: { cleanup: 'pending' },
              },
              { status: 202 },
            );
          }
          if (request.method === 'DELETE' && url.pathname === '/jobs/job-deadline') {
            deletes += 1;
            return runnerResponse({
              id: 'job-deadline',
              runId: 'run-deadline',
              attempt: 1,
              status: 'aborted',
              stage: 'cleanup',
              sandbox: { cleanup: 'destroyed' },
            });
          }
          return runnerResponse({
            id: 'job-deadline',
            runId: 'run-deadline',
            attempt: 1,
            status: 'running',
            stage: 'agent',
            sandbox: { cleanup: 'pending' },
          });
        },
      },
    });

    await expect(
      runner.runJob({
        ...runnerSpecFields,
        runId: 'run-deadline',
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
        repositoryReadToken: 'short-lived-checkout-token',
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'timeout', retryable: false });
    expect(deletes).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { createRunnerJobClient } from '../apps/core/src/runner-job-client';
import { runReviewWorkflow, type ReviewWorkflowStep } from '../apps/core/src/review-workflow';
import { createRunner, type RunnerProcessResult } from '../apps/runner/src/runner';

const baseSha = '1111111111111111111111111111111111111111';
const headSha = '2222222222222222222222222222222222222222';

describe('review Workflow runner tracer', () => {
  it('completes through the real client and Runner HTTP handler before publication', async () => {
    const agentOutput = JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: JSON.stringify({ findings: [], summary: 'No findings' }),
      },
    });
    const runner = createRunner({
      authToken: 'runner-tracer-token',
      modelSecretCommand: 'test-secret-resolver',
      process: async (_command, args, options = {}) => ({
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : options.captureStdout === true
            ? `${agentOutput}\n`
            : '',
        timedOut: false,
        truncated: false,
      }),
    });
    const client = createRunnerJobClient({
      authToken: 'runner-tracer-token',
      pollIntervalMs: 0,
      binding: { fetch: (request) => runner.handle(request) },
    });
    let published: unknown;
    const step: ReviewWorkflowStep = {
      do: async (_name, _options, operation) => operation(),
    };

    const disposition = await runReviewWorkflow(
      {
        runId: 'run-workflow-runner-tracer',
        job: {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          baseSha,
          headSha,
          trigger: 'automatic',
        },
      },
      step,
      {
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
        getInstallationToken: async () => 'checkout-token',
        runJob: client.runJob,
        completeReview: async ({ output }) => {
          published = output;
          return 'completed';
        },
        markRunFailed: async () => {},
      },
    );

    expect(disposition).toBe('completed');
    expect(published).toEqual({ findings: [], summary: 'No findings' });
  });

  it('retries after a lost GET when the real Runner confirms aborted cleanup', async () => {
    const agentOutput = JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: JSON.stringify({ findings: [], summary: 'Fresh attempt' }),
      },
    });
    let agentRuns = 0;
    let agentStarted!: () => void;
    const firstAgentReady = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    let releaseFirstAgent: (() => void) | undefined;
    const runner = createRunner({
      authToken: 'runner-tracer-token',
      modelSecretCommand: 'test-secret-resolver',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec') {
          agentRuns += 1;
          if (agentRuns === 1) {
            agentStarted();
            return new Promise<RunnerProcessResult>((resolve) => {
              releaseFirstAgent = () =>
                resolve({ exitCode: 1, stdout: '', timedOut: false, truncated: false });
              options.onChild?.({
                stdout: null,
                kill: () => {
                  releaseFirstAgent?.();
                  return true;
                },
                once: () => {},
              } as never);
            });
          }
          return { exitCode: 0, stdout: `${agentOutput}\n`, timedOut: false, truncated: false };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const posted: Array<{ runId: string; attempt: number; baseSha: string; headSha: string }> = [];
    let lostGet = true;
    let deletedState: unknown;
    const client = createRunnerJobClient({
      authToken: 'runner-tracer-token',
      pollIntervalMs: 0,
      binding: {
        fetch: async (request) => {
          if (request.method === 'POST') {
            const body = (await request.clone().json()) as {
              runId: string;
              attempt: number;
              baseSha: string;
              headSha: string;
            };
            posted.push({
              runId: body.runId,
              attempt: body.attempt,
              baseSha: body.baseSha,
              headSha: body.headSha,
            });
          }
          const response = await runner.handle(request);
          if (request.method === 'DELETE') deletedState = await response.clone().json();
          if (request.method === 'GET' && lostGet) {
            lostGet = false;
            await firstAgentReady;
            throw new Error('GET response lost');
          }
          return response;
        },
      },
    });
    const step: ReviewWorkflowStep = {
      do: async (_name, _options, operation) => operation(),
    };
    let published: unknown;

    const disposition = await runReviewWorkflow(
      {
        runId: 'run-workflow-runner-get-loss',
        job: {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          baseSha,
          headSha,
          trigger: 'automatic',
        },
      },
      step,
      {
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
        getInstallationToken: async () => 'checkout-token',
        runJob: client.runJob,
        completeReview: async ({ output }) => {
          published = output;
          return 'completed';
        },
        markRunFailed: async () => {},
      },
    );

    expect(disposition).toBe('completed');
    expect(published).toEqual({ findings: [], summary: 'Fresh attempt' });
    expect(deletedState).toMatchObject({ status: 'aborted', sandbox: { cleanup: 'destroyed' } });
    expect(posted).toEqual([
      { runId: 'run-workflow-runner-get-loss', attempt: 1, baseSha, headSha },
      { runId: 'run-workflow-runner-get-loss', attempt: 2, baseSha, headSha },
    ]);
  });

  it('does not retry a lost GET after confirmed cleanup crosses the client deadline', async () => {
    const agentOutput = JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: JSON.stringify({ findings: [], summary: 'Unused' }),
      },
    });
    let agentRuns = 0;
    let agentStarted!: () => void;
    const firstAgentReady = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    let releaseFirstAgent: (() => void) | undefined;
    const runner = createRunner({
      authToken: 'runner-tracer-token',
      modelSecretCommand: 'test-secret-resolver',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec') {
          agentRuns += 1;
          if (agentRuns === 1) {
            agentStarted();
            return new Promise<RunnerProcessResult>((resolve) => {
              releaseFirstAgent = () =>
                resolve({ exitCode: 1, stdout: '', timedOut: false, truncated: false });
              options.onChild?.({
                stdout: null,
                kill: () => {
                  releaseFirstAgent?.();
                  return true;
                },
                once: () => {},
              } as never);
            });
          }
          return { exitCode: 0, stdout: `${agentOutput}\n`, timedOut: false, truncated: false };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const postedAttempts: number[] = [];
    let lostGet = true;
    let deletedState: unknown;
    const client = createRunnerJobClient({
      authToken: 'runner-tracer-token',
      pollIntervalMs: 0,
      deadlineMs: 100,
      binding: {
        fetch: async (request) => {
          if (request.method === 'POST') {
            const body = (await request.clone().json()) as { attempt: number };
            postedAttempts.push(body.attempt);
          }
          const response = await runner.handle(request);
          if (request.method === 'GET' && lostGet) {
            lostGet = false;
            await firstAgentReady;
            throw new Error('GET response lost');
          }
          if (request.method === 'DELETE') {
            deletedState = await response.clone().json();
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          return response;
        },
      },
    });

    const result = await client.runJob({
      runId: 'run-workflow-runner-get-loss-deadline',
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
      checkoutToken: 'checkout-token',
      maxAttempts: 2,
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'timeout',
      attempt: 1,
      retryable: false,
    });
    expect(deletedState).toMatchObject({ status: 'aborted', sandbox: { cleanup: 'destroyed' } });
    expect(postedAttempts).toEqual([1]);
  });
});

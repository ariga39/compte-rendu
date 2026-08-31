import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { REVIEW_ATTEMPT_BUDGET_MS } from '../packages/contracts/src';
import { createRunnerJobClient } from '../apps/core/src/runner-job-client';
import { runReviewWorkflow, type ReviewWorkflowStep } from '../apps/core/src/review-workflow';
import { createRunner, type RunnerProcessResult } from '../apps/runner/src/runner';

const baseSha = '1111111111111111111111111111111111111111';
const headSha = '2222222222222222222222222222222222222222';

const readTokenServices = {
  getReadInstallationToken: async () => ({
    token: 'read-token',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
  revokeInstallationToken: async (_token: string) => {},
};

const runnerSpecFields = {
  repositoryName: 'acme/reviewed',
  pullRequestNumber: 42,
  repositoryReadToken: 'github-read-token',
};
const evidenceRoot = join(tmpdir(), 'compte-rendu-review-workflow-evidence');

const writeEvidenceFixture = async (
  args: readonly string[],
  options: { readonly stdoutFilePath?: string; readonly stderrFilePath?: string },
  resultLine: string,
) => {
  if (args[0] === 'exec' && args.includes('--agent')) {
    await writeFile(options.stdoutFilePath!, `${resultLine}\n`, { mode: 0o600 });
    await writeFile(options.stderrFilePath!, 'agent stderr\n', { mode: 0o600 });
  }
  if (args[0] === 'exec' && args.includes('export')) {
    await writeFile(
      options.stdoutFilePath!,
      `{"session":"${args[args.indexOf('export') + 1]}"}\n`,
      { mode: 0o600 },
    );
  }
  if (args[0] === 'cp') {
    const destination = args[2];
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
    await writeFile(join(destination, 'opencode.db-wal'), 'wal', { mode: 0o600 });
    await writeFile(join(destination, 'opencode.db-shm'), 'shm', { mode: 0o600 });
    await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
  }
};

afterAll(async () => {
  await rm(evidenceRoot, { recursive: true, force: true });
});

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
      evidenceRoot,
      authToken: 'runner-tracer-token',
      modelSecretCommand: 'test-secret-resolver',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, agentOutput);
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"workflow-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${agentOutput}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
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
        ...readTokenServices,
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
      evidenceRoot,
      authToken: 'runner-tracer-token',
      modelSecretCommand: 'test-secret-resolver',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, agentOutput);
        if (args[0] === 'exec' && args.includes('--agent')) {
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
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"workflow-session"}]\n'
              : '',
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
        ...readTokenServices,
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

  it('does not retry a lost GET when less than a full attempt budget remains', async () => {
    const agentOutput = JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: JSON.stringify({ findings: [], summary: 'Unused' }),
      },
    });
    let agentRuns = 0;
    const initialTime = Date.now();
    let currentTime = initialTime;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    let agentStarted!: () => void;
    const firstAgentReady = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    let releaseFirstAgent: (() => void) | undefined;
    const runner = createRunner({
      evidenceRoot,
      authToken: 'runner-tracer-token',
      modelSecretCommand: 'test-secret-resolver',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, agentOutput);
        if (args[0] === 'exec' && args.includes('--agent')) {
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
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"workflow-session"}]\n'
              : '',
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
      deadlineMs: REVIEW_ATTEMPT_BUDGET_MS + 100,
      binding: {
        fetch: async (request) => {
          if (request.method === 'POST') {
            const body = (await request.clone().json()) as { attempt: number };
            postedAttempts.push(body.attempt);
          }
          const response = await runner.handle(request);
          if (request.method === 'GET' && lostGet) {
            lostGet = false;
            currentTime = initialTime + 200;
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

    let result: Awaited<ReturnType<typeof client.runJob>>;
    try {
      result = await client.runJob({
        ...runnerSpecFields,
        runId: 'run-workflow-runner-get-loss-deadline',
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
        repositoryReadToken: 'checkout-token',
        maxAttempts: 2,
      });
    } finally {
      dateNow.mockRestore();
    }

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'timeout',
      attempt: 1,
      retryable: false,
    });
    expect(deletedState).toMatchObject({ status: 'aborted', sandbox: { cleanup: 'destroyed' } });
    expect(postedAttempts).toEqual([1]);
  });

  it('does not retry a lost GET at the attempt budget boundary without poll margin', async () => {
    const agentOutput = JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: JSON.stringify({ findings: [], summary: 'Unused' }),
      },
    });
    let agentRuns = 0;
    const initialTime = Date.now();
    let currentTime = initialTime;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    let agentStarted!: () => void;
    const firstAgentReady = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    let releaseFirstAgent: (() => void) | undefined;
    const runner = createRunner({
      evidenceRoot,
      authToken: 'runner-tracer-token',
      modelSecretCommand: 'test-secret-resolver',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, agentOutput);
        if (args[0] === 'exec' && args.includes('--agent')) {
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
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"workflow-session"}]\n'
              : '',
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
      deadlineMs: REVIEW_ATTEMPT_BUDGET_MS + 5_000,
      binding: {
        fetch: async (request) => {
          if (request.method === 'POST') {
            const body = (await request.clone().json()) as { attempt: number };
            postedAttempts.push(body.attempt);
          }
          const response = await runner.handle(request);
          if (request.method === 'GET' && lostGet) {
            lostGet = false;
            currentTime = initialTime + 5_000;
            await firstAgentReady;
            throw new Error('GET response lost');
          }
          if (request.method === 'DELETE') deletedState = await response.clone().json();
          return response;
        },
      },
    });

    let result: Awaited<ReturnType<typeof client.runJob>>;
    try {
      result = await client.runJob({
        ...runnerSpecFields,
        runId: 'run-workflow-runner-get-loss-budget-boundary',
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
        repositoryReadToken: 'checkout-token',
        maxAttempts: 2,
      });
    } finally {
      dateNow.mockRestore();
    }

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

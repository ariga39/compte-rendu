import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRunnerJobClient } from '../apps/core/src/runner-job-client';
import { runReviewWorkflow, type ReviewWorkflowStep } from '../apps/core/src/review-workflow';
import {
  createRunner as createProductionRunner,
  type RunnerProcessResult,
} from '../apps/runner/src/runner';

const baseSha = '1111111111111111111111111111111111111111';
const headSha = '2222222222222222222222222222222222222222';

const readTokenServices = {
  getReadInstallationToken: async () => ({
    token: 'read-token',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
  revokeInstallationToken: async (_token: string) => {},
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
    const sessionId = args[1].match(/opencode-export-([A-Za-z0-9._:-]+)\.json$/)?.[1];
    if (sessionId !== undefined) {
      await writeFile(destination, JSON.stringify({ info: { id: sessionId }, messages: [] }), {
        mode: 0o600,
      });
    } else {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
      await writeFile(join(destination, 'opencode.db-wal'), 'wal', { mode: 0o600 });
      await writeFile(join(destination, 'opencode.db-shm'), 'shm', { mode: 0o600 });
      await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
    }
  }
};

const createRunner = (options: Parameters<typeof createProductionRunner>[0] = {}) => {
  const originalProcess = options.process;
  if (originalProcess === undefined) return createProductionRunner(options);
  const rules: Array<Record<string, unknown>> = [
    {
      id: 'default-deny-all',
      resources: ['**'],
      editable: false,
      origin: 'local',
      layer: 'local',
    },
  ];
  return createProductionRunner({
    ...options,
    process: async (command, args, processOptions) => {
      if (args[0] === 'policy' && args[1] === 'ls') {
        return {
          exitCode: 0,
          stdout: processOptions?.captureStdout === true ? JSON.stringify({ rules }) + '\n' : '',
          timedOut: false,
          truncated: false,
        };
      }
      const result = await originalProcess(command, args, processOptions);
      if (command === 'git' && args.includes('merge-base') && result.exitCode === 0) {
        return { ...result, stdout: `${baseSha}\n` };
      }
      if (args[0] === 'policy' && args[1] === 'allow' && result.exitCode === 0) {
        const sandbox = args[args.indexOf('--sandbox') + 1];
        const resource = args[args.length - 1];
        rules.push({
          id: `${sandbox}-${resource}`,
          resources: [resource],
          sandbox_id: sandbox,
          editable: true,
          origin: 'local',
          layer: 'local',
        });
      }
      if (args[0] === 'policy' && args[1] === 'rm' && result.exitCode === 0) {
        const ruleId = args[args.indexOf('--id') + 1];
        const index = rules.findIndex((rule) => rule.id === ruleId);
        if (index >= 0) rules.splice(index, 1);
      }
      return result;
    },
  });
};

afterAll(async () => {
  await rm(evidenceRoot, { recursive: true, force: true });
});

describe('review Workflow runner tracer', () => {
  it('completes through the real client and Runner HTTP handler before publication', async () => {
    const agentOutput = [
      JSON.stringify({
        type: 'text',
        part: { type: 'text', messageID: 'msg-final', text: '## Review:\n\nNo findings.' },
      }),
      JSON.stringify({
        type: 'step_finish',
        part: { type: 'step-finish', messageID: 'msg-final', reason: 'stop' },
      }),
    ].join('\n');
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
    expect(published).toBe('## Review:\n\nNo findings.');
  });

  it('fails after one retryable invalid-output attempt without creating another Runner Job', async () => {
    let agentRuns = 0;
    const runner = createRunner({
      evidenceRoot,
      authToken: 'runner-tracer-token',
      modelSecretCommand: 'test-secret-resolver',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, 'not-jsonl');
        const isAgent = args[0] === 'exec' && args.includes('--agent');
        if (isAgent) agentRuns += 1;
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"one-attempt-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? 'not-jsonl\n'
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const posted: number[] = [];
    const client = createRunnerJobClient({
      authToken: 'runner-tracer-token',
      pollIntervalMs: 0,
      binding: {
        fetch: async (request) => {
          if (request.method === 'POST') {
            posted.push(((await request.clone().json()) as { attempt: number }).attempt);
          }
          return runner.handle(request);
        },
      },
    });
    let published: unknown;

    const disposition = await runReviewWorkflow(
      {
        runId: 'run-workflow-runner-one-attempt',
        job: {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          baseSha,
          headSha,
          trigger: 'automatic',
        },
      },
      { do: async (_name, _options, operation) => operation() },
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

    expect(disposition).toBe('failed');
    expect(published).toBeUndefined();
    expect(posted).toEqual([1]);
    expect(agentRuns).toBe(1);
  });

  it('returns terminal failure after a lost GET once the known job is cleaned up', async () => {
    const agentOutput = [
      JSON.stringify({
        type: 'text',
        part: { type: 'text', messageID: 'msg-final', text: '## Review:\n\nFresh attempt.' },
      }),
      JSON.stringify({
        type: 'step_finish',
        part: { type: 'step-finish', messageID: 'msg-final', reason: 'stop' },
      }),
    ].join('\n');
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

    expect(disposition).toBe('failed');
    expect(published).toBeUndefined();
    expect(deletedState).toMatchObject({ status: 'aborted', sandbox: { cleanup: 'destroyed' } });
    expect(posted).toEqual([
      { runId: 'run-workflow-runner-get-loss', attempt: 1, baseSha, headSha },
    ]);
    expect(agentRuns).toBe(1);
  });
});

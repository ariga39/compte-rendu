import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createRunner as createProductionRunner,
  type RunnerProcess,
  type RunnerProcessResult,
} from '../apps/runner/src/runner';

const runnerJobFields = {
  repositoryName: 'acme/reviewed',
  pullRequestNumber: 42,
  repositoryReadToken: 'github-read-token',
};
const sharedEvidenceRoot = join(tmpdir(), 'compte-rendu-runner-evidence');

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
      `{"session":"${args[args.indexOf('export') + 1]}","full":true}\n`,
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

const readTextTree = async (root: string): Promise<string> => {
  const parts: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) parts.push(await readTextTree(path));
    else if (!entry.isSymbolicLink()) parts.push(await readFile(path, 'utf8'));
  }
  return parts.join('\n');
};

type MergeBaseOverride = Partial<
  Pick<RunnerProcessResult, 'exitCode' | 'stdout' | 'timedOut' | 'truncated'>
>;
type TestRunnerOptions = Parameters<typeof createProductionRunner>[0] & {
  readonly mergeBase?: MergeBaseOverride;
};

const withMergeBaseFixture = (
  originalProcess: RunnerProcess,
  mergeBaseOverride?: MergeBaseOverride,
): RunnerProcess => {
  let verifiedBaseSha: string | undefined;
  return async (command, args, processOptions) => {
    const result = await originalProcess(command, args, processOptions);
    if (command === 'git' && args.includes('rev-parse') && result.exitCode === 0) {
      const reported = result.stdout.trim().split(/\s+/);
      if (reported.length === 2 && /^[0-9a-f]{40}$/i.test(reported[0])) {
        verifiedBaseSha = reported[0];
      }
    }
    if (command === 'git' && args.includes('merge-base')) {
      if (mergeBaseOverride !== undefined) return { ...result, ...mergeBaseOverride };
      if (verifiedBaseSha !== undefined && result.exitCode === 0) {
        return { ...result, stdout: `${verifiedBaseSha}\n` };
      }
    }
    return result;
  };
};

const createProductionRunnerWithMergeBase = (
  options: Parameters<typeof createProductionRunner>[0] = {},
) =>
  options.process === undefined
    ? createProductionRunner(options)
    : createProductionRunner({
        ...options,
        process: withMergeBaseFixture(options.process),
      });

const createRunner = (options: TestRunnerOptions = {}) => {
  const { mergeBase: mergeBaseOverride, ...productionOptions } = options;
  const originalProcess = productionOptions.process;
  if (originalProcess === undefined) return createProductionRunner(productionOptions);
  const mergeBaseProcess = withMergeBaseFixture(originalProcess, mergeBaseOverride);
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
    ...productionOptions,
    process: async (command, args, processOptions) => {
      if (args[0] === 'policy' && args[1] === 'ls') {
        return {
          exitCode: 0,
          stdout: processOptions?.captureStdout === true ? JSON.stringify({ rules }) + '\n' : '',
          timedOut: false,
          truncated: false,
        };
      }
      const result = await mergeBaseProcess(command, args, processOptions);
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
  await rm(sharedEvidenceRoot, { recursive: true, force: true });
});

const waitForTerminal = async (runner: ReturnType<typeof createRunner>, jobId: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await runner.handle(
      new Request(`http://runner/jobs/${jobId}`, {
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );
    const state = (await response.json()) as {
      status: string;
      evidenceId?: string;
      evidence?: { id: string; status: string };
    };
    if (state.status === 'succeeded' || state.status === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Runner Job did not reach a terminal state');
};

const runAgentScenario = async (scenario: {
  runId: string;
  output: string;
  exitCode?: number;
  timedOut?: boolean;
  truncated?: boolean;
  stderrTruncated?: boolean;
  cleanupFailure?: boolean;
}) => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  let agentInvoked = false;
  const runner = createRunner({
    evidenceRoot: sharedEvidenceRoot,
    authToken: 'runner-test-token',
    modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
    process: async (_command, args, options = {}) => {
      await writeEvidenceFixture(args, options, scenario.output);
      const isAgent = args[0] === 'exec' && args.includes('--agent');
      if (isAgent) agentInvoked = true;
      return {
        exitCode: isAgent
          ? (scenario.exitCode ?? 0)
          : scenario.cleanupFailure && args[0] === 'policy' && args[1] === 'rm'
            ? 1
            : 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : args.includes('session')
            ? '[{"id":"scenario-session"}]\n'
            : args.includes('export')
              ? ''
              : options.captureStdout === true
                ? `${scenario.output}\n`
                : '',
        stderrTruncated: isAgent ? scenario.stderrTruncated : undefined,
        timedOut: isAgent ? (scenario.timedOut ?? false) : false,
        truncated: isAgent ? (scenario.truncated ?? false) : false,
      };
    },
  });
  const submitted = await runner.handle(
    new Request('http://runner/jobs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer runner-test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...runnerJobFields,
        runId: scenario.runId,
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      }),
    }),
  );
  const { id } = (await submitted.json()) as { id: string };
  const terminalStartedAt = performance.now();
  const terminal = await waitForTerminal(runner, id);
  const terminalDurationMs = performance.now() - terminalStartedAt;
  const manifest = JSON.parse(
    await readFile(
      join(sharedEvidenceRoot, terminal.evidenceId as string, 'manifest.json'),
      'utf8',
    ),
  );
  return { terminal, manifest, agentInvoked, terminalDurationMs };
};

describe('Runner Job HTTP interface', () => {
  it('reports a process-exit cause without exposing agent content', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'unused' }) },
    });
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: args[0] === 'exec' && args.includes('--agent') ? 7 : 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"process-exit-session"}]\n'
              : args.includes('export')
                ? '{"session":"process-exit-session","full":true}\n'
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-90-process-exit',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    const terminal = await waitForTerminal(runner, id);

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'process-exit' },
      evidence: { status: 'complete' },
    });
    const manifest = JSON.parse(
      await readFile(
        join(sharedEvidenceRoot, terminal.evidenceId as string, 'manifest.json'),
        'utf8',
      ),
    );
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'process-exit' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'process-exit' },
    });
    expect(JSON.stringify(terminal)).not.toContain(resultLine);
  });

  it('reports a timeout cause while preserving the timeout reason', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-timeout',
      output: JSON.stringify({
        type: 'text',
        part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'unused' }) },
      }),
      exitCode: 1,
      timedOut: true,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'timeout', cause: 'timeout' },
      evidence: { status: 'complete' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'timeout', cause: 'timeout' },
      terminal: { status: 'failed', reason: 'timeout', cause: 'timeout' },
    });
  });

  it('reports an output-truncated cause for capture overflow', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-output-truncated',
      output: JSON.stringify({
        type: 'text',
        part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'unused' }) },
      }),
      truncated: true,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'output-truncated' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'output-truncated' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'output-truncated' },
    });
  });

  it('reports output-truncated when the parser rejects oversized stdout', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-oversized-stdout',
      output: 'x'.repeat(8 * 1024 * 1024 + 1),
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'output-truncated' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'output-truncated' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'output-truncated' },
    });
  });

  it('does not treat stderr capture truncation alone as invalid output', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-stderr-truncated-only',
      output: JSON.stringify({
        type: 'text',
        part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
      }),
      stderrTruncated: true,
    });

    expect(terminal).toMatchObject({
      status: 'succeeded',
      evidence: { status: 'complete' },
    });
    expect(terminal).not.toHaveProperty('failure');
    expect(manifest).toMatchObject({
      execution: { status: 'succeeded', validation: 'valid-review-result' },
      terminal: { status: 'succeeded' },
    });
    expect(manifest.terminal).not.toHaveProperty('cause');
  });

  it('reports a malformed-jsonl cause for invalid agent event lines', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-malformed-jsonl',
      output: 'not-jsonl',
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'malformed-jsonl' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'malformed-jsonl' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'malformed-jsonl' },
    });
  });

  it('reports an agent-error cause for an explicit agent error event', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-agent-error',
      output: JSON.stringify({ type: 'error' }),
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'agent-error' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'agent-error' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'agent-error' },
    });
  });

  it('reports zero-results when no event contains a schema-valid result', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-zero-results',
      output: JSON.stringify({ type: 'step-start' }),
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'zero-results' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'zero-results' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'zero-results' },
    });
  });

  it('reports multiple-results when more than one event contains a schema-valid result', async () => {
    const resultEvent = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-multiple-results',
      output: `${resultEvent}\n${resultEvent}`,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'multiple-results' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'multiple-results' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'multiple-results' },
    });
  });

  it('fails closed when one text event contains two outermost schema-valid results', async () => {
    const result = JSON.stringify({ findings: [], summary: 'No findings' });
    const resultEvent = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: `${result}\n${result}` },
    });
    const { terminal, manifest, agentInvoked } = await runAgentScenario({
      runId: 'run-103-multiple-results-one-event',
      output: resultEvent,
    });

    expect(agentInvoked).toBe(true);
    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'multiple-results' },
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'multiple-results' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'multiple-results' },
    });
  });

  it('reports result-schema-failure when a result event fails the output schema', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-result-schema-failure',
      output: JSON.stringify({
        type: 'text',
        part: {
          type: 'text',
          text: JSON.stringify({ findings: [], summary: 42 }),
        },
      }),
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'result-schema-failure' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'result-schema-failure' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'result-schema-failure' },
    });
  });

  it('preserves the execution cause when cleanup also fails', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-cause-through-cleanup',
      output: 'not-jsonl',
      cleanupFailure: true,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup', cause: 'malformed-jsonl' },
      sandbox: { cleanup: 'failed' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'cleanup', cause: 'malformed-jsonl' },
      terminal: { status: 'failed', reason: 'cleanup', cause: 'malformed-jsonl' },
    });
  });

  it('removes only each job-owned network rules for jobs sharing resources', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    type PolicyRule = {
      id: string;
      resources: string[];
      sandbox_id?: string;
      editable: boolean;
      origin: string;
      layer: string;
    };
    const rules: PolicyRule[] = [
      {
        id: 'default-deny-all',
        resources: ['**'],
        editable: false,
        origin: 'local',
        layer: 'local',
      },
      {
        id: 'other-sandbox-model',
        resources: ['opencode.ai:443'],
        sandbox_id: 'other-sandbox',
        editable: true,
        origin: 'local',
        layer: 'local',
      },
    ];
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'create') {
          return {
            exitCode: 0,
            stdout: '',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'policy' && args[1] === 'allow') {
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
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'policy' && args[1] === 'ls') {
          return {
            exitCode: 0,
            stdout: options.captureStdout === true ? JSON.stringify({ rules }) + '\n' : '',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'policy' && args[1] === 'rm') {
          const ruleId = args[args.indexOf('--id') + 1];
          if (ruleId !== undefined) {
            const index = rules.findIndex((rule) => rule.id === ruleId);
            if (index >= 0) rules.splice(index, 1);
            return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
          }
          return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'rm' && args[1] === '--force') {
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"policy-session"}]\n'
              : args.includes('export')
                ? '{"session":"policy-session","full":true}\n'
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const submit = async (runId: string) => {
      const response = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...runnerJobFields,
            runId,
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha,
            headSha,
          }),
        }),
      );
      return (await response.json()) as { id: string };
    };

    const [first, second] = await Promise.all([
      submit('run-93-policy-first'),
      submit('run-93-policy-second'),
    ]);
    const [firstTerminal, secondTerminal] = await Promise.all([
      waitForTerminal(runner, first.id),
      waitForTerminal(runner, second.id),
    ]);

    expect(firstTerminal).toMatchObject({
      status: 'succeeded',
      sandbox: { cleanup: 'destroyed' },
    });
    expect(secondTerminal).toMatchObject({
      status: 'succeeded',
      sandbox: { cleanup: 'destroyed' },
    });
    expect(rules).toEqual([
      {
        id: 'default-deny-all',
        resources: ['**'],
        editable: false,
        origin: 'local',
        layer: 'local',
      },
      {
        id: 'other-sandbox-model',
        resources: ['opencode.ai:443'],
        sandbox_id: 'other-sandbox',
        editable: true,
        origin: 'local',
        layer: 'local',
      },
    ]);
  });

  it('fails cleanup on exact policy removal failure while continuing Sandbox cleanup', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    const rules: Array<Record<string, unknown>> = [
      {
        id: 'default-deny-all',
        resources: ['**'],
        editable: false,
        origin: 'local',
        layer: 'local',
      },
    ];
    let sandboxRemoved = false;
    let secretRemoved = false;
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'create')
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        if (args[0] === 'policy' && args[1] === 'allow') {
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
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'policy' && args[1] === 'ls') {
          return {
            exitCode: 0,
            stdout: options.captureStdout === true ? JSON.stringify({ rules }) + '\n' : '',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'policy' && args[1] === 'rm') {
          return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'rm' && args[1] === '--force') {
          sandboxRemoved = true;
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'secret' && args[1] === 'rm') {
          secretRemoved = true;
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"cleanup-failure-session"}]\n'
              : args.includes('export')
                ? '{"session":"cleanup-failure-session","full":true}\n'
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-93-policy-removal-failure',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
    expect(sandboxRemoved).toBe(true);
    expect(secretRemoved).toBe(true);
  });

  it('fails cleanup when a read-only policy rule remains attached after Sandbox removal', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    const rules: Array<Record<string, unknown>> = [
      {
        id: 'default-deny-all',
        resources: ['**'],
        editable: false,
        origin: 'local',
        layer: 'local',
      },
    ];
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'create')
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        if (args[0] === 'policy' && args[1] === 'allow') {
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
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'policy' && args[1] === 'ls') {
          const visibleRules = args.includes('--include-inactive')
            ? rules
            : rules.filter((rule) => rule.id !== 'kit-after-rm');
          return {
            exitCode: 0,
            stdout:
              options.captureStdout === true ? JSON.stringify({ rules: visibleRules }) + '\n' : '',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'policy' && args[1] === 'rm') {
          const ruleId = args[args.indexOf('--id') + 1];
          const index = rules.findIndex((rule) => rule.id === ruleId);
          if (index >= 0) rules.splice(index, 1);
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'rm' && args[1] === '--force') {
          const sandbox = args[2];
          rules.push({
            id: 'kit-after-rm',
            resources: ['**'],
            sandbox_id: sandbox,
            editable: false,
            origin: 'kit',
            layer: 'kit',
          });
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"orphan-session"}]\n'
              : args.includes('export')
                ? '{"session":"orphan-session","full":true}\n'
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-93-policy-orphan',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    const terminal = await waitForTerminal(runner, id);
    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kit-after-rm',
          sandbox_id: expect.stringContaining('compte-rendu-'),
        }),
      ]),
    );
  });

  it('removes a rule recorded before an initial policy lookup failure', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'unused' }) },
    });
    const rules: Array<Record<string, unknown>> = [
      {
        id: 'default-deny-all',
        resources: ['**'],
        editable: false,
        origin: 'local',
        layer: 'local',
      },
    ];
    let policyLists = 0;
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'policy' && args[1] === 'allow') {
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
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'policy' && args[1] === 'ls') {
          if (options.captureStdout !== true) {
            return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
          }
          policyLists += 1;
          if (policyLists === 1) {
            return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({ rules }) + '\n',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'policy' && args[1] === 'rm') {
          const ruleId = args[args.indexOf('--id') + 1];
          const index = rules.findIndex((rule) => rule.id === ruleId);
          if (index >= 0) rules.splice(index, 1);
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"lookup-failure-session"}]\n'
              : args.includes('export')
                ? '{"session":"lookup-failure-session","full":true}\n'
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-93-policy-lookup-failure',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'agent' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(rules).toEqual([
      {
        id: 'default-deny-all',
        resources: ['**'],
        editable: false,
        origin: 'local',
        layer: 'local',
      },
    ]);
  });

  it('does not remove a replacement rule when a recorded policy ID disappears', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    const sandboxRules: Array<Record<string, unknown>> = [
      {
        id: 'default-deny-all',
        resources: ['**'],
        editable: false,
        origin: 'local',
        layer: 'local',
      },
    ];
    let setupLookups = 0;
    let replacementRemoved = false;
    let sandboxRemoved = false;
    let secretRemoved = false;
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'create')
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        if (args[0] === 'policy' && args[1] === 'allow') {
          const sandbox = args[args.indexOf('--sandbox') + 1];
          const resource = args[args.length - 1];
          sandboxRules.push({
            id: `${sandbox}-${resource}`,
            resources: [resource],
            sandbox_id: sandbox,
            editable: true,
            origin: 'local',
            layer: 'local',
          });
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'policy' && args[1] === 'ls') {
          if (options.captureStdout !== true) {
            return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
          }
          if (setupLookups < 2) {
            setupLookups += 1;
          } else if (!sandboxRules.some((rule) => rule.id === 'replacement-model')) {
            const modelIndex = sandboxRules.findIndex((rule) =>
              String(rule.id).endsWith('-opencode.ai:443'),
            );
            const modelRule = sandboxRules[modelIndex];
            sandboxRules.splice(modelIndex, 1);
            sandboxRules.push({
              ...modelRule,
              id: 'replacement-model',
            });
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({ rules: sandboxRules }) + '\n',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'policy' && args[1] === 'rm') {
          const ruleId = args[args.indexOf('--id') + 1];
          if (ruleId === 'replacement-model') replacementRemoved = true;
          const index = sandboxRules.findIndex((rule) => rule.id === ruleId);
          if (index >= 0) sandboxRules.splice(index, 1);
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'rm' && args[1] === '--force') {
          sandboxRemoved = true;
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'secret' && args[1] === 'rm') {
          secretRemoved = true;
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"replacement-session"}]\n'
              : args.includes('export')
                ? '{"session":"replacement-session","full":true}\n'
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-93-policy-replacement',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
    expect(replacementRemoved).toBe(false);
    expect(sandboxRemoved).toBe(true);
    expect(secretRemoved).toBe(true);
    expect(sandboxRules).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'replacement-model' })]),
    );
  });

  it('returns a durable evidence archive before destroying a successful Sandbox', async () => {
    const evidenceRoot = await mkdtemp(`${tmpdir()}/compte-rendu-evidence-`);
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const agentJsonl = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    try {
      const runner = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
        process: async (command, args, options = {}) => {
          if (args[0] === 'exec' && args.includes('--agent')) {
            await writeFile(options.stdoutFilePath!, `${agentJsonl}\n`, { mode: 0o600 });
            await writeFile(options.stderrFilePath!, '', { mode: 0o600 });
          }
          if (args[0] === 'exec' && args.includes('export')) {
            await writeFile(
              options.stdoutFilePath!,
              `{"session":"${args[args.indexOf('export') + 1]}","full":true}\n`,
              { mode: 0o600 },
            );
          }
          if (command === 'sbx' && args[0] === 'cp') {
            const destination = args[2];
            await mkdir(destination, { recursive: true, mode: 0o700 });
            await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
            await writeFile(join(destination, 'opencode.db-wal'), 'wal', { mode: 0o600 });
            await writeFile(join(destination, 'opencode.db-shm'), 'shm', { mode: 0o600 });
            await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
          }
          return {
            exitCode: 0,
            stdout: args.includes('rev-parse')
              ? `${baseSha}\n${headSha}\n`
              : args.includes('session')
                ? '[{"id":"session-89"},{"id":"session-child"}]\n'
                : args.includes('export')
                  ? `{"session":"${args[args.indexOf('export') + 1]}","full":true}\n`
                  : options.captureStdout === true
                    ? `${agentJsonl}\n`
                    : '',
            stderr: args[0] === 'exec' && args.includes('--format') ? 'agent stderr\n' : '',
            timedOut: false,
            truncated: false,
          };
        },
      });
      const submitted = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...runnerJobFields,
            runId: 'run-89-evidence',
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha,
            headSha,
          }),
        }),
      );
      const { id } = (await submitted.json()) as { id: string };
      const terminal = await waitForTerminal(runner, id);

      expect(terminal.status).toBe('succeeded');
      expect(terminal.evidenceId).toEqual(expect.any(String));
      expect(terminal.evidence).toEqual({ id: terminal.evidenceId, status: 'complete' });
      const archive = join(evidenceRoot, terminal.evidenceId as string);
      expect(await readFile(join(archive, 'opencode.jsonl'), 'utf8')).toBe(`${agentJsonl}\n`);
      expect(await readFile(join(archive, 'opencode.stderr'), 'utf8')).toBe('');
      expect(await readFile(join(archive, 'manifest.json'), 'utf8')).toContain('run-89-evidence');
      await expect(
        readFile(join(archive, 'opencode-export-session-89.json'), 'utf8'),
      ).resolves.toContain('session-89');
      await expect(
        readFile(join(archive, 'opencode-export-session-child.json'), 'utf8'),
      ).resolves.toContain('session-child');
      await expect(readFile(join(archive, 'opencode-data', 'opencode.db'), 'utf8')).resolves.toBe(
        'db',
      );
      await expect(
        readFile(join(archive, 'opencode-data', 'opencode.db-wal'), 'utf8'),
      ).resolves.toBe('wal');
      await expect(
        readFile(join(archive, 'opencode-data', 'opencode.db-shm'), 'utf8'),
      ).resolves.toBe('shm');
      await expect(readFile(join(archive, 'opencode-data', 'review.log'), 'utf8')).resolves.toBe(
        'log',
      );
      await expect(
        readFile(join(archive, 'validated-review-result.json'), 'utf8'),
      ).resolves.toContain('No findings');
      expect(JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))).toMatchObject({
        jobId: expect.any(String),
        sandboxName: expect.any(String),
        sandboxId: expect.any(String),
        sessionIds: ['session-89', 'session-child'],
        model: 'opencode-go/deepseek-v4-flash',
        image: 'ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0',
        openCodeVersion: '1.18.25',
        agent: {
          exitCode: 0,
          timedOut: false,
          truncated: false,
          stderrTruncated: false,
          streamError: false,
        },
        validation: { status: 'valid' },
        terminal: { status: 'succeeded' },
        complete: true,
        cleanup: { status: 'destroyed' },
      });
      expect((await stat(archive)).mode & 0o777).toBe(0o700);
      const archiveFiles = await readdir(archive, { withFileTypes: true });
      for (const entry of archiveFiles) {
        expect((await stat(join(archive, entry.name))).mode & 0o777).toBe(
          entry.isDirectory() ? 0o700 : 0o600,
        );
      }
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('reports incomplete evidence as its own failure when archiving fails', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: args[0] === 'cp' ? 1 : 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"archive-failure-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-89-archive-failure',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    const terminal = await waitForTerminal(runner, id);
    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'evidence' },
      evidence: { status: 'incomplete' },
      sandbox: { cleanup: 'destroyed' },
    });
  });

  it('keeps sanitized setup diagnostics when cleanup is also unconfirmed', async () => {
    const events: unknown[] = [];
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const repositoryReadToken = 'checkout-token-must-not-appear';
    const resolverCommand = 'secret-resolver --token resolver-secret';
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: resolverCommand,
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
      process: async (_command, args) => {
        if (args[0] === 'create') {
          return {
            exitCode: 1,
            stderr: `mkfs.ext4: command not found ${repositoryReadToken} ${resolverCommand}`,
            stdout: '',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'rm') {
          return {
            exitCode: 1,
            stderr: 'sandbox not found',
            stdout: '',
            timedOut: false,
            truncated: false,
          };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-72-setup-diagnostics',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
    expect(events).toContainEqual({
      phase: 'runner',
      outcome: 'command',
      runId: 'run-72-setup-diagnostics',
      stage: 'sandbox',
      command: 'create',
      exitCode: 1,
      timedOut: false,
      stderr: 'mkfs.ext4: command not found [redacted] [redacted]',
    });
    expect(events).toContainEqual({
      phase: 'runner',
      outcome: 'command',
      runId: 'run-72-setup-diagnostics',
      stage: 'cleanup',
      command: 'remove-sandbox',
      exitCode: 1,
      timedOut: false,
      stderr: 'sandbox not found',
    });
    expect(JSON.stringify(events)).not.toContain(repositoryReadToken);
    expect(JSON.stringify(events)).not.toContain(resolverCommand);
  });

  it('finalizes incomplete evidence for a terminal checkout failure', async () => {
    const evidenceRoot = await mkdtemp(`${tmpdir()}/compte-rendu-evidence-failure-`);
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    try {
      const runner = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
        process: async (_command, args) => ({
          exitCode: args.includes('clone') ? 1 : 0,
          stdout: '',
          timedOut: false,
          truncated: false,
        }),
      });
      const submitted = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...runnerJobFields,
            runId: 'run-89-checkout-failure',
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha,
            headSha,
          }),
        }),
      );
      const { id } = (await submitted.json()) as { id: string };
      const terminal = await waitForTerminal(runner, id);
      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'checkout' },
        sandbox: { cleanup: 'destroyed' },
      });
      const manifest = JSON.parse(
        await readFile(join(evidenceRoot, terminal.evidenceId as string, 'manifest.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({
        complete: false,
        execution: { status: 'failed', reason: 'checkout' },
        cleanup: { status: 'destroyed' },
      });
      expect(manifest.startedAt).toEqual(expect.any(String));
      expect(manifest.finishedAt).toEqual(expect.any(String));
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('archives available Sandbox evidence when network setup fails before the agent', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'unused' }) },
    });
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: args[0] === 'policy' && args[1] === 'allow' ? 1 : 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"network-failure-session"}]\n'
              : args.includes('export')
                ? ''
                : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-89-network-setup-failure',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    const terminal = await waitForTerminal(runner, id);
    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'agent' },
      evidence: { status: 'incomplete' },
      sandbox: { cleanup: 'destroyed' },
    });
    const archive = join(sharedEvidenceRoot, terminal.evidenceId as string);
    await expect(readFile(join(archive, 'opencode-session-list.json'), 'utf8')).resolves.toContain(
      'network-failure-session',
    );
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db'), 'utf8')).resolves.toBe(
      'db',
    );
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db-wal'), 'utf8')).resolves.toBe(
      'wal',
    );
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db-shm'), 'utf8')).resolves.toBe(
      'shm',
    );
    await expect(readFile(join(archive, 'opencode-data', 'review.log'), 'utf8')).resolves.toBe(
      'log',
    );
  });

  it('redacts sensitive stderr before applying the diagnostic byte bound', async () => {
    const events: Array<Record<string, unknown>> = [];
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const repositoryReadToken = 'secret-checkout-token';
    const overflowingStderr = `${'x'.repeat(4080)}${repositoryReadToken}${'y'.repeat(100)}`;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      log: {
        record: async (event) => {
          events.push(event as unknown as Record<string, unknown>);
        },
      },
      process: async (_command, args) => {
        if (args[0] === 'create') {
          return {
            exitCode: 1,
            stderr: overflowingStderr,
            stderrTruncated: true,
            stdout: '',
            timedOut: false,
            truncated: false,
          };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-72-redaction-bound',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'agent' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'command',
        runId: 'run-72-redaction-bound',
        stage: 'sandbox',
        command: 'create',
        exitCode: 1,
        timedOut: false,
        stderr: `${'x'.repeat(4080)}[redacted]${'y'.repeat(6)}`,
      }),
    );
    expect(JSON.stringify(events)).not.toContain(repositoryReadToken);
  });

  it('loads the packaged review skill and exact revision through the OpenCode sandbox boundary', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    let createArgs: readonly string[] | undefined;
    let fetchArgs: readonly string[] | undefined;
    let agentArgs: readonly string[] | undefined;
    let configRootAtSandboxBoundary: string | undefined;
    let skillAtSandboxBoundary: string | undefined;
    let sandboxEnvironment: NodeJS.ProcessEnv | undefined;
    const process = async (
      _command: string,
      args: readonly string[],
      options: {
        readonly captureStdout?: boolean;
        readonly env?: NodeJS.ProcessEnv;
        readonly stdoutFilePath?: string;
        readonly stderrFilePath?: string;
      } = {},
    ): Promise<RunnerProcessResult> => {
      await writeEvidenceFixture(args, options, resultLine);
      if (args[0] === 'create') sandboxEnvironment = options.env;
      if (args[0] === 'create') {
        createArgs = args;
        const config = args.find((value) => value.startsWith('XDG_CONFIG_HOME='));
        if (config !== undefined) {
          const configRoot = config.slice('XDG_CONFIG_HOME='.length);
          configRootAtSandboxBoundary = configRoot;
          skillAtSandboxBoundary = await readFile(
            join(configRoot, 'opencode/skills/pr-review/SKILL.md'),
            'utf8',
          );
        }
      }
      if (args.includes('fetch')) fetchArgs = args;
      if (args[0] === 'exec' && args.includes('--agent')) agentArgs = args;
      return {
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : args.includes('session')
            ? '[{"id":"fixture-session"}]\n'
            : args.includes('export')
              ? ''
              : options.captureStdout === true
                ? `${resultLine}\n`
                : '',
        timedOut: false,
        truncated: false,
      };
    };
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      process,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
    });

    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-67-skill',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'succeeded',
      result: { findings: [], summary: 'No findings' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(createArgs).toEqual(expect.arrayContaining(['--clone', '--no-share-skills']));
    const template = 'ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0';
    const templateIndex = createArgs?.indexOf(template) ?? -1;
    const agentIndex = createArgs?.lastIndexOf('opencode') ?? -1;
    expect(templateIndex).toBeGreaterThanOrEqual(0);
    expect(templateIndex).toBeLessThan(agentIndex);
    expect(fetchArgs).toEqual(
      expect.arrayContaining([
        `+${baseSha}:refs/remotes/origin/review-base`,
        `+refs/pull/42/head:refs/remotes/origin/review-head`,
      ]),
    );
    expect(createArgs).toContain(configRootAtSandboxBoundary);
    expect(createArgs).not.toContain(`${configRootAtSandboxBoundary}:ro`);
    expect(createArgs?.some((value) => value.startsWith('XDG_CONFIG_HOME='))).toBe(true);
    expect(skillAtSandboxBoundary).toContain('name: pr-review');
    expect(skillAtSandboxBoundary).toContain('description:');
    expect(skillAtSandboxBoundary).toContain('This is a static review');
    expect(skillAtSandboxBoundary).toContain('install dependencies');
    expect(skillAtSandboxBoundary).toContain('Do not execute repository code');
    expect(skillAtSandboxBoundary).toContain('official GitHub CLI');
    expect(skillAtSandboxBoundary).toContain('current title, body, all commits, issue comments');
    const overviewCommand = skillAtSandboxBoundary?.match(/`gh pr view[^`]+`/)?.[0];
    expect(overviewCommand).toBe(
      '`gh pr view PR_NUMBER --repo REPOSITORY --json title,body,author,baseRefOid,headRefOid,commits,comments,reviews`',
    );
    expect(skillAtSandboxBoundary).toContain(
      'Require `gh api graphql` as the authoritative source for',
    );
    expect(skillAtSandboxBoundary).toContain('baseRefOid`, `headRefOid`');
    expect(skillAtSandboxBoundary).toContain(
      'every review thread plus independently paginated reply',
    );
    expect(skillAtSandboxBoundary).toContain('resolved');
    expect(skillAtSandboxBoundary).toContain('outdated');
    expect(skillAtSandboxBoundary).toContain('older related issues');
    expect(skillAtSandboxBoundary).toContain(
      'Independently cursor-paginate the commits connection',
    );
    expect(skillAtSandboxBoundary).toContain('issue comments connection');
    expect(skillAtSandboxBoundary).toContain('submitted reviews connection');
    expect(skillAtSandboxBoundary).toContain('review threads connection');
    expect(skillAtSandboxBoundary).toContain("every thread's");
    expect(skillAtSandboxBoundary).toContain('replies connection');
    expect(skillAtSandboxBoundary).toContain(
      'Count the nodes and require every connection to report',
    );
    expect(skillAtSandboxBoundary).toContain('completion (`pageInfo.hasNextPage` false)');
    expect(skillAtSandboxBoundary).toContain('Re-read the pull request base and');
    expect(skillAtSandboxBoundary).toContain('head OIDs after pagination');
    expect(skillAtSandboxBoundary).not.toContain('web or repository inspection');
    expect(skillAtSandboxBoundary).not.toContain('```');
    const configContent = createArgs?.find((value) => value.startsWith('OPENCODE_CONFIG_CONTENT='));
    expect(configContent).toBeDefined();
    const config = JSON.parse(configContent!.slice('OPENCODE_CONFIG_CONTENT='.length)) as {
      agent: { review: { permission: Record<string, unknown> } };
    };
    expect(config).toMatchObject({
      agent: {
        review: {
          description: 'Pull request reviewer',
          permission: {
            '*': 'deny',
            bash: {
              '*': 'deny',
              'gh *': 'deny',
              'gh api graphql *': 'allow',
              'gh pr view *': 'allow',
              'git diff': 'allow',
              'git diff *': 'allow',
              'git grep': 'allow',
              'git grep *': 'allow',
              'git log': 'allow',
              'git log *': 'allow',
              'git show': 'allow',
              'git show *': 'allow',
              'git diff *--no-index*': 'deny',
              'git diff *--output*': 'deny',
              'git show *--output*': 'deny',
              'git diff *--extcmd*': 'deny',
              'git diff *>*': 'deny',
              'git show *>*': 'deny',
              'git grep *>*': 'deny',
              'git grep *--open-files-in-pager*': 'deny',
              'git grep *-O*': 'deny',
              'gh *&*': 'deny',
              'gh *;*': 'deny',
              'gh *|*': 'deny',
              'gh *>*': 'deny',
              'gh *<*': 'deny',
              'gh *$(*': 'deny',
              'gh *`*': 'deny',
              'gh *\n*': 'deny',
              'git *&*': 'deny',
              'git *;*': 'deny',
              'git *|*': 'deny',
              'git *>*': 'deny',
              'git *<*': 'deny',
              'git *$(*': 'deny',
              'git *`*': 'deny',
              'git *\n*': 'deny',
              'npm *': 'deny',
              'pnpm *': 'deny',
              'python *': 'deny',
              './*': 'deny',
            },
            edit: 'deny',
            external_directory: 'allow',
            glob: 'allow',
            grep: 'allow',
            read: 'allow',
            skill: 'allow',
            webfetch: 'deny',
          },
        },
      },
    });
    expect(sandboxEnvironment?.SSH_AUTH_SOCK).toBeUndefined();
    expect(sandboxEnvironment?.SSH_AGENT_PID).toBeUndefined();
    expect(sandboxEnvironment?.GH_TOKEN).toBeUndefined();
    expect(sandboxEnvironment?.GITHUB_TOKEN).toBeUndefined();
    expect(agentArgs?.join(' ')).toContain('acme/reviewed');
    expect(agentArgs?.join(' ')).toContain('pull request #42');
    expect(agentArgs?.join(' ')).toContain('GH_TOKEN');
    expect(agentArgs?.join(' ')).toContain('independently cursor-paginate');
    expect(agentArgs?.join(' ')).toContain('after pagination');
    expect(agentArgs?.join(' ')).toContain(baseSha);
    expect(agentArgs?.join(' ')).toContain(headSha);
    await expect(
      readFile(join(configRootAtSandboxBoundary!, 'opencode/skills/pr-review/SKILL.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('accepts one schema-valid review result wrapped in prose and a markdown fence', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const reviewResult = { findings: [], summary: 'No findings' };
    const agentEvent = JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: `Here is the review result:\n\n\`\`\`json\n${JSON.stringify(reviewResult)}\n\`\`\`\n\nEnd of review.`,
      },
    });
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'model-secret-resolver',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, agentEvent);
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"wrapped-result-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${agentEvent}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-103-wrapped-review-result',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    const terminal = await waitForTerminal(runner, id);
    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: reviewResult,
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    const manifest = JSON.parse(
      await readFile(
        join(sharedEvidenceRoot, terminal.evidenceId as string, 'manifest.json'),
        'utf8',
      ),
    );
    expect(manifest).toMatchObject({ complete: true, terminal: { status: 'succeeded' } });
  });

  it('accepts a fenced result after prose with an unmatched opening brace', async () => {
    const reviewResult = { findings: [], summary: 'No findings' };
    const agentEvent = JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: `json\nThe explanatory object begins here {\n\`\`\`json\n${JSON.stringify(reviewResult)}\n\`\`\``,
      },
    });
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-103-unmatched-prose-brace',
      output: agentEvent,
    });

    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: reviewResult,
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({ complete: true, terminal: { status: 'succeeded' } });
  });

  it('accepts a fenced result after prose with an unmatched brace and quote', async () => {
    const reviewResult = { findings: [], summary: 'No findings' };
    const agentEvent = JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: `Explanation of foo starts { with an unfinished quote "\n\`\`\`json\n${JSON.stringify(reviewResult)}\n\`\`\``,
      },
    });
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-103-unmatched-prose-brace-and-quote',
      output: agentEvent,
    });

    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: reviewResult,
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({ complete: true, terminal: { status: 'succeeded' } });
  });

  it('accepts an unfenced result after prose with an unmatched brace and quote', async () => {
    const reviewResult = { findings: [], summary: 'No findings' };
    const agentEvent = JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: `Explanation of foo starts { with an unfinished quote "\n${JSON.stringify(reviewResult)}`,
      },
    });
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-103-unfenced-unmatched-brace-and-quote',
      output: agentEvent,
    });

    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: reviewResult,
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({ complete: true, terminal: { status: 'succeeded' } });
  });

  it('accepts a schema-valid result with 512 findings', async () => {
    const reviewResult = {
      findings: Array.from({ length: 512 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        line: index + 1,
        message: `Finding ${index}`,
      })),
      summary: '512 findings',
    };
    const agentEvent = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify(reviewResult) },
    });
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-103-512-findings',
      output: agentEvent,
    });

    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: reviewResult,
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({ complete: true, terminal: { status: 'succeeded' } });
  });

  it('fails bounded and closed for brace-heavy text without a schema-valid result', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const agentEvent = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: '{'.repeat(80_000) },
    });
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'model-secret-resolver',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, agentEvent);
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"brace-heavy-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${agentEvent}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-103-brace-heavy-result',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    const startedAt = performance.now();
    const terminal = await waitForTerminal(runner, id);

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'result-schema-failure' },
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
  });

  it('fails bounded and closed for many consecutive balanced empty objects', async () => {
    const reviewResult = JSON.stringify({ findings: [], summary: 'No findings' });
    const agentEvent = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: '{}'.repeat(5_000) + reviewResult },
    });
    const { terminal, manifest, terminalDurationMs } = await runAgentScenario({
      runId: 'run-103-many-empty-objects',
      output: agentEvent,
    });

    expect(terminalDurationMs).toBeLessThan(2_000);
    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'result-schema-failure' },
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({
      complete: true,
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'result-schema-failure' },
    });
  });

  it('reviews a behind target from merge base to head while retaining admitted revision facts', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const mergeBaseSha = '3333333333333333333333333333333333333333';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    let agentPrompt: string | undefined;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'model-secret-resolver',
      mergeBase: { stdout: `${mergeBaseSha}\n` },
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        if (args[0] === 'exec' && args.includes('--agent')) {
          agentPrompt = args[args.length - 1];
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"merge-base-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-100-behind-target',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'succeeded',
      result: { findings: [], summary: 'No findings' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(agentPrompt).toContain(`git diff --find-renames ${mergeBaseSha} ${headSha}`);
    expect(agentPrompt).toContain(`base ${baseSha}`);
    expect(agentPrompt).toContain(`head ${headSha}`);
  });

  it('preserves the expected diff when the merge base equals the admitted base', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    let agentPrompt: string | undefined;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'model-secret-resolver',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        if (args[0] === 'exec' && args.includes('--agent')) {
          agentPrompt = args[args.length - 1];
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"merge-base-equal-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-100-equal-merge-base',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'succeeded',
      sandbox: { cleanup: 'destroyed' },
    });
    expect(agentPrompt).toContain(`git diff --find-renames ${baseSha} ${headSha}`);
  });

  it.each([
    ['missing history', { exitCode: 1, stdout: '', truncated: false }],
    [
      'truncated output',
      {
        exitCode: 0,
        stdout: '3333333333333333333333333333333333333333\n',
        truncated: true,
      },
    ],
  ] as const)(
    'fails closed for %s merge-base history before agent invocation',
    async (_mode, mergeBase) => {
      const baseSha = '1111111111111111111111111111111111111111';
      const headSha = '2222222222222222222222222222222222222222';
      const resultLine = JSON.stringify({
        type: 'text',
        part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'unused' }) },
      });
      let agentInvoked = false;
      const runner = createRunner({
        evidenceRoot: sharedEvidenceRoot,
        authToken: 'runner-test-token',
        modelSecretCommand: 'model-secret-resolver',
        mergeBase,
        process: async (_command, args, options = {}) => {
          await writeEvidenceFixture(args, options, resultLine);
          if (args[0] === 'exec' && args.includes('--agent')) agentInvoked = true;
          return {
            exitCode: 0,
            stdout: args.includes('rev-parse')
              ? `${baseSha}\n${headSha}\n`
              : options.captureStdout === true
                ? `${resultLine}\n`
                : '',
            timedOut: false,
            truncated: false,
          };
        },
      });
      const submitted = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...runnerJobFields,
            runId: 'run-100-merge-base-failure',
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha,
            headSha,
          }),
        }),
      );
      const { id } = (await submitted.json()) as { id: string };

      await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
        status: 'failed',
        failure: { reason: 'checkout' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(agentInvoked).toBe(false);
    },
  );

  it('exposes the per-run GitHub read token only through a scoped GitHub service', async () => {
    const repositoryReadToken = 'github-read-token-must-not-be-an-argument';
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    const commands: string[][] = [];
    const events: unknown[] = [];
    let resolvedGithubToken: string | undefined;
    let githubTokenPath: string | undefined;
    let checkoutRoot: string | undefined;
    let cleanupEnvironment: NodeJS.ProcessEnv | undefined;
    let checkoutEnvironment: NodeJS.ProcessEnv | undefined;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'model-secret-resolver',
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
      process: async (_command, args, options = {}) => {
        commands.push([...args]);
        await writeEvidenceFixture(args, options, resultLine);
        if (_command === 'git' && args.includes('clone')) {
          checkoutRoot = args[args.length - 1];
          await mkdir(checkoutRoot, { recursive: true, mode: 0o700 });
        }
        if (args[0] === 'rm' && args[1] === '--force') cleanupEnvironment = options.env;
        if (_command === 'git' && args.includes('clone')) checkoutEnvironment = options.env;
        if (args[0] === 'secret' && args[1] === 'set' && args[2] === 'github') {
          const command = args[args.indexOf('--command') + 1];
          if (command?.startsWith('cat ')) {
            githubTokenPath = command.slice(4);
            resolvedGithubToken = await readFile(command.slice(4), 'utf8');
          }
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"fixture-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryName: 'acme/reviewed',
          pullRequestNumber: 42,
          runId: 'run-github-read-secret',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    const terminal = await waitForTerminal(runner, id);
    expect(terminal).toMatchObject({
      status: 'succeeded',
      sandbox: { cleanup: 'destroyed' },
    });
    expect(
      commands.some((args) => args[0] === 'policy' && args.includes('api.github.com:443')),
    ).toBe(true);
    expect(resolvedGithubToken).toBe(repositoryReadToken);
    expect(cleanupEnvironment).toBeDefined();
    expect(cleanupEnvironment?.SSH_AUTH_SOCK).toBeUndefined();
    expect(cleanupEnvironment?.SSH_AGENT_PID).toBeUndefined();
    expect(cleanupEnvironment?.GH_TOKEN).toBeUndefined();
    expect(cleanupEnvironment?.GITHUB_TOKEN).toBeUndefined();
    expect(checkoutEnvironment?.CHECKOUT_TOKEN).toBe(repositoryReadToken);
    expect(checkoutEnvironment?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(githubTokenPath).toBeDefined();
    await expect(stat(githubTokenPath!)).rejects.toThrow();
    expect(checkoutRoot).toBeDefined();
    await expect(stat(checkoutRoot!)).rejects.toThrow();
    expect(commands.flat().join(' ')).not.toContain(repositoryReadToken);
    expect(JSON.stringify(events)).not.toContain(repositoryReadToken);
    expect(
      await readTextTree(join(sharedEvidenceRoot, terminal.evidenceId as string)),
    ).not.toContain(repositoryReadToken);
  });

  it('fails closed when GitHub authentication preflight fails before OpenCode invocation', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    let agentInvoked = false;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'model-secret-resolver',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        if (args[0] === 'exec' && args.includes('gh')) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'GitHub authentication failed',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'exec' && args.includes('--agent')) agentInvoked = true;
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"fixture-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-github-preflight-failure',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'agent' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(agentInvoked).toBe(false);
  });

  it('runs one authenticated immutable review attempt to a cleaned terminal result', async () => {
    const root = await mkdtemp(`${tmpdir()}/compte-rendu-runner-`);
    try {
      const baseSha = '1111111111111111111111111111111111111111';
      const headSha = '2222222222222222222222222222222222222222';
      const resultLine = JSON.stringify({
        type: 'text',
        part: {
          type: 'text',
          text: JSON.stringify({ findings: [], summary: 'No findings' }),
        },
      });
      const successfulProcess = async (
        _command: string,
        args: readonly string[],
        options: {
          readonly captureStdout?: boolean;
          readonly stdoutFilePath?: string;
          readonly stderrFilePath?: string;
        } = {},
      ): Promise<RunnerProcessResult> => {
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"fixture-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      };
      const runner = createRunner({
        evidenceRoot: sharedEvidenceRoot,
        process: successfulProcess,
        authToken: 'runner-test-token',
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      });
      const submitted = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...runnerJobFields,
            runId: 'run-64-test',
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha,
            headSha,
            repositoryReadToken: 'checkout-token-for-test',
          }),
        }),
      );
      expect(submitted.status).toBe(202);
      const { id } = (await submitted.json()) as { id: string };

      const terminal = await waitForTerminal(runner, id);
      expect(terminal).toMatchObject({
        status: 'succeeded',
        attempt: 1,
        result: { findings: [], summary: 'No findings' },
        sandbox: { cleanup: 'destroyed' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unauthenticated job requests without starting work', async () => {
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async () => ({
        exitCode: 0,
        stdout: '',
        timedOut: false,
        truncated: false,
      }),
    });

    const response = await runner.handle(
      new Request('http://runner/jobs', { method: 'POST', body: '{}' }),
    );

    expect(response.status).toBe(401);
  });

  it('fails closed on malformed agent output and still destroys the Sandbox', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, '{not-json}');
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"fixture-session"}]\n'
              : options.captureStdout === true
                ? '{not-json}\n'
                : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-invalid-output',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    const terminal = await waitForTerminal(runner, id);

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output' },
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    const archive = join(sharedEvidenceRoot, terminal.evidenceId as string);
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db'), 'utf8')).resolves.toBe(
      'db',
    );
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db-wal'), 'utf8')).resolves.toBe(
      'wal',
    );
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db-shm'), 'utf8')).resolves.toBe(
      'shm',
    );
    await expect(readFile(join(archive, 'opencode-data', 'review.log'), 'utf8')).resolves.toBe(
      'log',
    );
  });

  it('maps an agent deadline to a failed terminal job after cleanup', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(
          args,
          options,
          '{"type":"text","part":{"type":"text","text":"{\\"findings\\":[],\\"summary\\":\\"timeout\\"}"}}',
        );
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"fixture-session"}]\n'
              : args.includes('export')
                ? ''
                : '',
          timedOut: args[0] === 'exec' && args.includes('--agent'),
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-timeout',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    const terminal = await waitForTerminal(runner, id);

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'timeout' },
      sandbox: { cleanup: 'destroyed' },
    });
  });

  it('fails closed when custom secret cleanup returns exit 1', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: args[0] === 'secret' && args[1] === 'rm' ? 1 : 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"fixture-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-secret-cleanup-failure',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    const terminal = await waitForTerminal(runner, id);

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
  });

  it('is idempotent for the same run and attempt but creates a fresh job for a new attempt', async () => {
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async () => ({
        exitCode: 0,
        stdout: '',
        timedOut: false,
        truncated: false,
      }),
    });
    const request = (attempt: number) =>
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-idempotency',
          attempt,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
          repositoryReadToken: 'checkout-token-for-test',
        }),
      });

    const first = await runner.handle(request(1));
    const duplicate = await runner.handle(request(1));
    const retry = await runner.handle(request(2));
    const firstState = (await first.json()) as { id: string; attempt: number };
    const duplicateState = (await duplicate.json()) as { id: string; attempt: number };
    const retryState = (await retry.json()) as { id: string; attempt: number };

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(duplicateState).toEqual(firstState);
    expect(retryState.attempt).toBe(2);
    expect(retryState.id).not.toBe(firstState.id);
  });

  it('fails before the agent when checkout reports the wrong immutable head SHA', async () => {
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => ({
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? '1111111111111111111111111111111111111111\n9999999999999999999999999999999999999999\n'
          : options.captureStdout === true
            ? ''
            : '',
        timedOut: false,
        truncated: false,
      }),
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-sha-mismatch',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    const terminal = await waitForTerminal(runner, id);
    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'checkout' },
      sandbox: { cleanup: 'destroyed' },
    });
  });

  it('fails closed when checkout credential cleanup fails', async () => {
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        return {
          exitCode: args.includes('credential.helper') ? 1 : 0,
          stdout: args.includes('rev-parse')
            ? '1111111111111111111111111111111111111111\n2222222222222222222222222222222222222222\n'
            : options.captureStdout === true
              ? ''
              : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-credential-cleanup',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'checkout' },
      sandbox: { cleanup: 'destroyed' },
    });
  });

  it('waits for cleanup on DELETE and reports cleanup failure instead of aborted', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const agentJsonl = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'aborted' }) },
    });
    let releaseAgent: (() => void) | undefined;
    let agentStarted!: () => void;
    const agentReady = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec' && args.includes('--agent')) {
          agentStarted();
          await writeEvidenceFixture(args, options, agentJsonl);
          return new Promise<RunnerProcessResult>((resolve) => {
            releaseAgent = () =>
              resolve({ exitCode: 1, stdout: '', timedOut: false, truncated: false });
          });
        }
        if (args[0] === 'exec' && args.includes('session')) {
          if (options.onChild !== undefined) return new Promise<RunnerProcessResult>(() => {});
          return {
            exitCode: 0,
            stdout: '[{"id":"delete-session"}]\n',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'exec' && args.includes('export')) {
          await writeEvidenceFixture(args, options, 'unused');
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'cp') {
          await writeEvidenceFixture(args, options, 'unused');
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'secret' && args[1] === 'rm') {
          return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-delete-cleanup',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    await agentReady;

    let deleteFinished = false;
    const deleting = runner
      .handle(
        new Request(`http://runner/jobs/${id}`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      )
      .then((response) => {
        deleteFinished = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deleteFinished).toBe(false);
    releaseAgent?.();

    const deleted = await deleting;
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
  });

  it('returns aborted after DELETE stops the agent when all cleanup succeeds', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const agentJsonl = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'aborted' }) },
    });
    let releaseAgent: (() => void) | undefined;
    let agentStarted!: () => void;
    const agentReady = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec' && args.includes('--agent')) {
          agentStarted();
          await writeEvidenceFixture(args, options, agentJsonl);
          return new Promise<RunnerProcessResult>((resolve) => {
            releaseAgent = () =>
              resolve({ exitCode: 1, stdout: '', timedOut: false, truncated: false });
            options.onChild?.({
              stdout: null,
              kill: () => {
                releaseAgent?.();
                return true;
              },
              once: () => {},
            } as never);
          });
        }
        if (args[0] === 'exec' && args.includes('session')) {
          if (options.onChild !== undefined) return new Promise<RunnerProcessResult>(() => {});
          return {
            exitCode: 0,
            stdout: '[{"id":"delete-session"}]\n',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'exec' && args.includes('export')) {
          await writeEvidenceFixture(args, options, 'unused');
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'cp') {
          await writeEvidenceFixture(args, options, 'unused');
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-delete-aborted',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    await agentReady;

    const deleted = await runner.handle(
      new Request(`http://runner/jobs/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );

    expect(deleted.status).toBe(200);
    const deletedState = (await deleted.json()) as { status: string; evidenceId?: string };
    expect(deletedState).toMatchObject({
      status: 'aborted',
      sandbox: { cleanup: 'destroyed' },
    });
    const archive = join(sharedEvidenceRoot, deletedState.evidenceId as string);
    await expect(readFile(join(archive, 'opencode-session-list.json'), 'utf8')).resolves.toContain(
      'delete-session',
    );
    await expect(
      readFile(join(archive, 'opencode-export-delete-session.json'), 'utf8'),
    ).resolves.toContain('delete-session');
    const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      complete: true,
      execution: { status: 'aborted' },
      cleanup: { status: 'destroyed' },
    });
    expect(manifest.terminal).not.toHaveProperty('cause');
  });

  it('rejects error events, multiple valid candidates, and oversized output', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const validLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    const outputs = [
      JSON.stringify({ type: 'error' }),
      `${validLine}\n${validLine}\n`,
      'x'.repeat(8 * 1024 * 1024 + 1),
    ];

    for (const [index, agentOutput] of outputs.entries()) {
      const runner = createRunner({
        evidenceRoot: sharedEvidenceRoot,
        authToken: 'runner-test-token',
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
        process: async (_command, args, options = {}) => {
          await writeEvidenceFixture(args, options, agentOutput);
          return {
            exitCode: 0,
            stdout: args.includes('rev-parse')
              ? `${baseSha}\n${headSha}\n`
              : args.includes('session')
                ? '[{"id":"fixture-session"}]\n'
                : args.includes('export')
                  ? ''
                  : args[0] === 'exec' && options.captureStdout === true
                    ? agentOutput
                    : '',
            timedOut: false,
            truncated: false,
          };
        },
      });
      const submitted = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...runnerJobFields,
            runId: `run-64-invalid-agent-${index}`,
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha,
            headSha,
            repositoryReadToken: 'checkout-token-for-test',
          }),
        }),
      );
      const { id } = (await submitted.json()) as { id: string };

      await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
        status: 'failed',
        failure: { reason: 'invalid-output' },
        sandbox: { cleanup: 'destroyed' },
      });
    }
  });
});

import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createRunner as createProductionRunner,
  type RunnerProcess,
  type RunnerProcessResult,
} from '../apps/runner/src/runner';

delete process.env.REVIEW_MODEL_CONFIG;

const sessionExportJson = (
  id: string,
  options: {
    readonly outcome?: string;
    readonly finish?: string;
    readonly terminalIdle?: boolean;
  } = {},
) =>
  JSON.stringify({
    info: { id, outcome: options.outcome ?? 'succeeded' },
    messages: [
      { type: 'assistant', finish: options.finish ?? 'stop' },
      ...(options.terminalIdle === false ? [] : [{ type: 'idle', outcome: 'succeeded' }]),
    ],
  });

const structuredResult = (markdown: string, decision = 'comment') => ({
  version: 2,
  decision,
  markdown,
});

const runnerJobFields = {
  id: 'runner-job-test',
  repositoryName: 'acme/reviewed',
  pullRequestNumber: 42,
  repositoryReadToken: 'github-read-token',
};
const sharedEvidenceRoot = join(tmpdir(), 'compte-rendu-runner-evidence');

const standardModelConfig = JSON.stringify({
  id: 'opencode-go/deepseek-flash',
  definition: {
    name: 'DeepSeek V4.1 Flash',
    reasoning: true,
    interleaved: { field: 'reasoning_content' },
    limit: { context: 1000000, output: 384000 },
    cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
  },
});

const submitReviewEvent = (
  markdown = '## Review:\n\nNo findings.',
  options: {
    readonly callID?: string;
    readonly status?: string;
    readonly decision?: string;
    readonly sessionID?: string;
  } = {},
) => {
  const status = options.status ?? 'completed';
  const input = { decision: options.decision ?? 'comment', markdown };
  return JSON.stringify({
    type: 'tool_use',
    sessionID: options.sessionID ?? 'scenario-session',
    part: {
      type: 'tool',
      id: options.callID ?? 'call-submit-review',
      tool: 'submit_review',
      state:
        status === 'completed'
          ? { status: 'completed', input, output: 'Review submitted.', title: 'Review submitted.' }
          : { status, input, error: 'submission failed' },
    },
  });
};

const finalMarkdownJsonl = (
  markdown = '## Review:\n\nNo findings.',
  sessionID = 'scenario-session',
) =>
  [
    JSON.stringify({
      type: 'text',
      sessionID,
      part: {
        type: 'text',
        messageID: 'msg-final',
        text: 'I finished reviewing the pull request.',
      },
    }),
    submitReviewEvent(markdown, { sessionID }),
  ].join('\n');

const writeEvidenceFixture = async (
  args: readonly string[],
  options: {
    readonly stdoutFilePath?: string;
    readonly stderrFilePath?: string;
    readonly fileAppend?: boolean;
  },
  resultLine: string,
) => {
  const flag = options.fileAppend === true ? 'a' : 'w';
  if (args[0] === 'exec' && args.includes('--agent')) {
    await writeFile(options.stdoutFilePath!, `${resultLine}\n`, { mode: 0o600, flag });
    await writeFile(options.stderrFilePath!, 'agent stderr\n', { mode: 0o600, flag });
  }
  if (args[0] === 'exec' && args.includes('export') && options.stdoutFilePath !== undefined) {
    await writeFile(
      options.stdoutFilePath,
      `{"session":"${args[args.indexOf('export') + 1]}","full":true}\n`,
      { mode: 0o600, flag },
    );
  }
  if (args[0] === 'cp') {
    const source = args[1];
    const destination = args[2];
    const sessionId = source.match(/opencode-export-([A-Za-z0-9._:-]+)\.json$/)?.[1];
    if (sessionId !== undefined) {
      await writeFile(destination, sessionExportJson(sessionId), {
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
) => {
  const optionsWithCallback = {
    ...options,
    claimUrl: options.claimUrl ?? (options.claimFetch === undefined ? '' : undefined),
    modelConfig: options.modelConfig ?? standardModelConfig,
    callbackUrl: options.callbackUrl ?? 'https://ingress.test/runner-callback',
    callbackToken: options.callbackToken ?? 'callback-token',
    progressFetch: options.progressFetch ?? (async () => new Response(null, { status: 202 })),
    callbackFetch: options.callbackFetch ?? (async () => new Response(null, { status: 202 })),
  };
  return options.process === undefined
    ? createProductionRunner(optionsWithCallback)
    : createProductionRunner({
        ...optionsWithCallback,
        process: withMergeBaseFixture(options.process),
      });
};

const createRunner = (options: TestRunnerOptions = {}) => {
  const { mergeBase: mergeBaseOverride, ...productionOptions } = options;
  const optionsWithCallback = {
    ...productionOptions,
    claimUrl:
      productionOptions.claimUrl ?? (productionOptions.claimFetch === undefined ? '' : undefined),
    modelConfig: productionOptions.modelConfig ?? standardModelConfig,
    callbackUrl: productionOptions.callbackUrl ?? 'https://ingress.test/runner-callback',
    callbackToken: productionOptions.callbackToken ?? 'callback-token',
    progressFetch:
      productionOptions.progressFetch ?? (async () => new Response(null, { status: 202 })),
    callbackFetch:
      productionOptions.callbackFetch ?? (async () => new Response(null, { status: 202 })),
  };
  const originalProcess = productionOptions.process;
  if (originalProcess === undefined) return createProductionRunner(optionsWithCallback);
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
    ...optionsWithCallback,
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
      if (
        args[0] === 'cp' &&
        result.exitCode === 0 &&
        !args[1].endsWith('/data') &&
        !args[1].endsWith('/state')
      ) {
        const destination = args[2];
        let destinationIsDirectory = false;
        try {
          const mode = (await stat(destination)).mode;
          destinationIsDirectory = (mode & 0o170000) === 0o040000;
        } catch {
          // The external Sandbox copy may not create the destination in a test double.
        }
        if (destinationIsDirectory) await rm(destination, { recursive: true, force: true });
        try {
          await stat(destination);
        } catch {
          const sessionId = args[1].match(/opencode-export-([A-Za-z0-9._:-]+)\.json$/)?.[1];
          if (sessionId !== undefined) {
            await writeFile(destination, sessionExportJson(sessionId), { mode: 0o600 });
          }
        }
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
  await rm(sharedEvidenceRoot, { recursive: true, force: true });
});

const waitForTerminal = async (
  runner: ReturnType<typeof createRunner>,
  jobId: string,
  attempts = 50,
) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
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
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'aborted')
      return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Runner Job did not reach a terminal state');
};

const runAgentScenario = async (scenario: {
  reviewConfiguration?: { revision: number; selection: { reviewers: string[]; synthesis: string } };
  runId: string;
  output: string;
  exitCode?: number;
  timedOut?: boolean;
  truncated?: boolean;
  stderrTruncated?: boolean;
  cleanupFailure?: boolean;
  create?: { readonly exitCode?: number; readonly timedOut?: boolean };
  sandboxRemovalFailure?: boolean;
  callbackRequests?: Request[];
  progressFetch?: typeof fetch;
  agentGate?: Promise<void>;
  onAgentStart?: () => void | Promise<void>;
  onModelSecret?: (args: readonly string[]) => Promise<void>;
  callbackStatuses?: readonly number[];
  callbackHangs?: boolean;
  callbackTimeoutMs?: number;
  modelConfig?: string;
  llmServiceSocket?: string;
  sessionExport?: string;
  evidenceRoot?: string;
  onRunner?: (runner: ReturnType<typeof createRunner>) => void;
  terminalAttempts?: number;
}) => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  let agentInvoked = false;
  let createArgs: readonly string[] | undefined;
  let agentArgs: readonly string[] | undefined;
  let secretArgs: readonly string[] | undefined;
  const allowedResources: string[] = [];
  const removedRuleIds: string[] = [];
  const runner = createRunner({
    evidenceRoot: scenario.evidenceRoot ?? sharedEvidenceRoot,
    authToken: 'runner-test-token',
    modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
    llmServiceSocket: scenario.llmServiceSocket,
    modelConfig: scenario.modelConfig,
    progressFetch: scenario.progressFetch,
    callbackUrl:
      scenario.callbackRequests === undefined ? undefined : 'https://ingress.test/runner-callback',
    callbackToken: scenario.callbackRequests === undefined ? undefined : 'callback-token',
    callbackTimeoutMs: scenario.callbackTimeoutMs,
    callbackFetch:
      scenario.callbackRequests === undefined
        ? undefined
        : async (input: RequestInfo | URL, init?: RequestInit) => {
            scenario.callbackRequests!.push(new Request(input, init));
            if (scenario.callbackHangs === true) {
              return new Promise<Response>(() => undefined);
            }
            const status =
              scenario.callbackStatuses?.[scenario.callbackRequests!.length - 1] ?? 202;
            return new Response(null, { status });
          },
    process: async (_command, args, options = {}) => {
      await writeEvidenceFixture(args, options, scenario.output);
      if (
        scenario.sessionExport !== undefined &&
        args[0] === 'cp' &&
        /opencode-export-[A-Za-z0-9._:-]+\.json$/.test(args[1])
      ) {
        await writeFile(args[2], scenario.sessionExport, { mode: 0o600 });
      }
      if (args[0] === 'create') createArgs = args;
      if (args[0] === 'secret' && args[1] === 'set-custom') {
        secretArgs = args;
        await scenario.onModelSecret?.(args);
      }
      if (args[0] === 'policy' && args[1] === 'allow') {
        allowedResources.push(args[args.length - 1]);
      }
      if (args[0] === 'policy' && args[1] === 'rm') {
        removedRuleIds.push(args[args.indexOf('--id') + 1]);
      }
      const isAgent = args[0] === 'exec' && args.includes('--agent');
      if (isAgent) {
        await scenario.onAgentStart?.();
        await scenario.agentGate;
        agentInvoked = true;
        agentArgs = args;
      }
      const isCreate = args[0] === 'create';
      const isSandboxRemoval = args[0] === 'rm' && args[1] === '--force';
      return {
        exitCode: isAgent
          ? (scenario.exitCode ?? 0)
          : isCreate && scenario.create !== undefined
            ? (scenario.create.exitCode ?? 1)
            : (scenario.cleanupFailure && args[0] === 'policy' && args[1] === 'rm') ||
                (scenario.sandboxRemovalFailure === true && isSandboxRemoval)
              ? 1
              : 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : args.includes('export')
            ? sessionExportJson('scenario-session')
            : args.includes('session')
              ? '[{"id":"scenario-session"}]\n'
              : options.captureStdout === true
                ? `${scenario.output}\n`
                : '',
        stderrTruncated: isAgent ? scenario.stderrTruncated : undefined,
        timedOut: isAgent
          ? (scenario.timedOut ?? false)
          : isCreate && scenario.create !== undefined
            ? (scenario.create.timedOut ?? false)
            : false,
        truncated: isAgent ? (scenario.truncated ?? false) : false,
      };
    },
  });
  scenario.onRunner?.(runner);
  const submitted = await runner.handle(
    new Request('http://runner/jobs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer runner-test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...runnerJobFields,
        ...(scenario.reviewConfiguration === undefined
          ? {}
          : { reviewConfiguration: scenario.reviewConfiguration }),
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
  const terminal = await waitForTerminal(runner, id, scenario.terminalAttempts);
  const terminalDurationMs = performance.now() - terminalStartedAt;
  const manifest = JSON.parse(
    await readFile(
      join(
        scenario.evidenceRoot ?? sharedEvidenceRoot,
        terminal.evidenceId as string,
        'manifest.json',
      ),
      'utf8',
    ),
  );
  return {
    terminal,
    manifest,
    agentInvoked,
    terminalDurationMs,
    createArgs,
    agentArgs,
    secretArgs,
    allowedResources,
    removedRuleIds,
  };
};

type ReminderRound = {
  readonly output: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly truncated?: boolean;
  readonly advanceMs?: number;
  readonly exportFinish?: string;
};

const runReminderScenario = async (scenario: {
  runId: string;
  rounds: readonly ReminderRound[];
}) => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  const sessionId = 'session-reminder';
  const sandboxName = `compte-rendu-${runnerJobFields.id}`;
  const agentCommands: string[][] = [];
  const agentTimeouts: Array<number | undefined> = [];
  const createCommands: string[][] = [];
  let agentRuns = 0;
  const runner = createRunner({
    evidenceRoot: sharedEvidenceRoot,
    authToken: 'runner-test-token',
    modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
    process: async (_command, args, options = {}) => {
      if (args[0] === 'create') createCommands.push([...args]);
      const isAgent = args[0] === 'exec' && args.includes('--agent');
      if (isAgent) {
        const round = scenario.rounds[Math.min(agentRuns, scenario.rounds.length - 1)]!;
        agentRuns += 1;
        agentCommands.push([...args]);
        agentTimeouts.push(options.timeoutMs);
        await writeEvidenceFixture(args, options, round.output);
        if (round.advanceMs !== undefined) {
          vi.setSystemTime(Date.now() + round.advanceMs);
        }
        return {
          exitCode: round.exitCode ?? 0,
          stdout: `${round.output}\n`,
          timedOut: round.timedOut ?? false,
          truncated: round.truncated ?? false,
        };
      }
      await writeEvidenceFixture(args, options, '');
      if (args[0] === 'cp' && args[1].includes('opencode-export-')) {
        await writeFile(
          args[2],
          sessionExportJson(sessionId, {
            finish: scenario.rounds[Math.max(agentRuns - 1, 0)]?.exportFinish,
          }),
          { mode: 0o600 },
        );
      }
      return {
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : args.includes('export')
            ? sessionExportJson(sessionId, {
                finish: scenario.rounds[Math.max(agentRuns - 1, 0)]?.exportFinish,
              })
            : args.includes('session')
              ? `[{"id":"${sessionId}"}]\n`
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
        runId: scenario.runId,
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      }),
    }),
  );
  const { id } = (await submitted.json()) as { id: string };
  const terminal = await waitForTerminal(runner, id);
  const manifest = JSON.parse(
    await readFile(
      join(sharedEvidenceRoot, terminal.evidenceId as string, 'manifest.json'),
      'utf8',
    ),
  );
  return {
    runner,
    terminal,
    manifest,
    agentCommands,
    agentTimeouts,
    agentRuns,
    createCommands,
    sessionId,
    sandboxName,
  };
};

const completedWithoutSubmitJsonl = (sessionId: string) =>
  JSON.stringify({
    type: 'text',
    sessionID: sessionId,
    part: {
      type: 'text',
      messageID: 'msg-final',
      text: 'I completed the review without submitting.',
    },
  });

const submitReminderJsonl = (sessionId: string, markdown: string) =>
  [
    JSON.stringify({
      type: 'text',
      sessionID: sessionId,
      part: { type: 'text', messageID: 'msg-reminder', text: 'Submitting the review now.' },
    }),
    submitReviewEvent(markdown, { callID: 'call-reminder', sessionID: sessionId }),
  ].join('\n');

describe('Runner Job HTTP interface', () => {
  it('does not claim durable work until local Job admission is fully configured', async () => {
    let claims = 0;
    for (const overrides of [
      { authToken: undefined, modelSecretCommand: 'secret-resolver get MODEL_API_KEY' },
      { authToken: 'runner-test-token', modelSecretCommand: undefined },
      {
        authToken: 'runner-test-token',
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
        callbackUrl: undefined,
      },
    ]) {
      createProductionRunner({
        modelConfig: standardModelConfig,
        callbackUrl: 'https://ingress.test/runner-callback',
        ...overrides,
        callbackToken: 'callback-token',
        claimUrl: 'https://ingress.test/runner-claim',
        claimFetch: async () => {
          claims += 1;
          return new Response(null, { status: 204 });
        },
        claimIntervalMs: 1,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(claims).toBe(0);
  });

  it('polls again after a hanging claim request reaches its finite timeout', async () => {
    let claims = 0;
    let secondClaim!: () => void;
    const secondClaimObserved = new Promise<void>((resolve) => {
      secondClaim = resolve;
    });
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      callbackUrl: 'https://ingress.test/runner-callback',
      claimUrl: 'https://ingress.test/runner-claim',
      claimTimeoutMs: 5,
      claimIntervalMs: 1,
      claimFetch: async (_input, init) => {
        claims += 1;
        if (claims === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('claim aborted')), {
              once: true,
            });
          });
        }
        secondClaim();
        return new Response(null, { status: 204 });
      },
    });

    await secondClaimObserved;
    expect(claims).toBeGreaterThanOrEqual(2);
    expect(
      (
        await runner.handle(
          new Request('http://runner/jobs/unknown', {
            headers: { authorization: 'Bearer runner-test-token' },
          }),
        )
      ).status,
    ).toBe(404);
  });

  it('derives the claim route from the callback URL when no claim URL is injected', async () => {
    let claimedUrl: string | undefined;
    let observed!: () => void;
    const claimObserved = new Promise<void>((resolve) => {
      observed = resolve;
    });
    createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      callbackUrl: 'https://ingress.test/runner-callback',
      claimFetch: async (input) => {
        claimedUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        observed();
        return new Response(null, { status: 204 });
      },
      claimIntervalMs: 60_000,
    });

    await claimObserved;
    expect(claimedUrl).toBe('https://ingress.test/runner-claim');
  });

  it('lets a fresh Runner instance claim later queued work', async () => {
    const firstEvidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-restart-1-'));
    const secondEvidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-restart-2-'));
    const firstJob = {
      ...runnerJobFields,
      id: 'runner-restart-job-1',
      runId: 'run-restart-1',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha: '1111111111111111111111111111111111111111',
      headSha: '2222222222222222222222222222222222222222',
    };
    const secondJob = { ...firstJob, id: 'runner-restart-job-2', runId: 'run-restart-2' };
    let firstClaimed!: () => void;
    const firstClaimObserved = new Promise<void>((resolve) => {
      firstClaimed = resolve;
    });
    const process = async (
      _command: string,
      args: readonly string[],
      options: Parameters<RunnerProcess>[2] = {},
    ) => {
      await writeEvidenceFixture(args, options, finalMarkdownJsonl(undefined, 'session-1'));
      return {
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? `${firstJob.baseSha}\n${firstJob.headSha}\n`
          : args.includes('session')
            ? '[{"id":"session-1"}]\n'
            : args.includes('export')
              ? ''
              : options.captureStdout === true
                ? finalMarkdownJsonl(undefined, 'session-1')
                : '',
        timedOut: false,
        truncated: false,
      };
    };

    const firstRunner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot: firstEvidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      claimFetch: async () => {
        firstClaimed();
        return Response.json(firstJob);
      },
      claimIntervalMs: 1,
      process,
    });

    try {
      await firstClaimObserved;
      const secondRunner = createRunner({
        authToken: 'runner-test-token',
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
        evidenceRoot: secondEvidenceRoot,
        claimUrl: 'https://ingress.test/runner-claim',
        claimFetch: async () => Response.json(secondJob),
        claimIntervalMs: 1,
        process,
      });

      const secondTerminal = await waitForTerminal(secondRunner, secondJob.id);
      expect(secondTerminal.status).toBe('succeeded');
      const firstTerminal = await waitForTerminal(firstRunner, firstJob.id);
      expect(firstTerminal.status).toBe('succeeded');
    } finally {
      await Promise.all([
        rm(firstEvidenceRoot, { recursive: true, force: true }),
        rm(secondEvidenceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('pulls one Job while idle and claims the next only after terminal cleanup', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-queue-'));
    const jobs = [
      {
        ...runnerJobFields,
        id: 'runner-claimed-job-1',
        runId: 'run-claimed-1',
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '2222222222222222222222222222222222222222',
      },
      {
        ...runnerJobFields,
        id: 'runner-claimed-job-2',
        runId: 'run-claimed-2',
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '2222222222222222222222222222222222222222',
      },
    ];
    let claims = 0;
    let activeAgents = 0;
    let maximumActiveAgents = 0;
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async () => new Response(null, { status: 202 }),
      claimUrl: 'https://ingress.test/runner-claim',
      claimFetch: async () => {
        const job = jobs[claims++];
        return job === undefined
          ? new Response(null, { status: 204 })
          : Response.json(job, { status: 200 });
      },
      claimIntervalMs: 1,
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec' && args.includes('--agent')) {
          activeAgents += 1;
          maximumActiveAgents = Math.max(maximumActiveAgents, activeAgents);
          await new Promise((resolve) => setTimeout(resolve, 10));
          await writeEvidenceFixture(args, options, finalMarkdownJsonl(undefined, 'session-1'));
          activeAgents -= 1;
          return {
            exitCode: 0,
            stdout: `${finalMarkdownJsonl(undefined, 'session-1')}\n`,
            timedOut: false,
            truncated: false,
          };
        }
        await writeEvidenceFixture(args, options, finalMarkdownJsonl(undefined, 'session-1'));
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${jobs[0]!.baseSha}\n${jobs[0]!.headSha}\n`
            : args.includes('session')
              ? '[{"id":"session-1"}]\n'
              : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    try {
      const first = await waitForTerminal(runner, jobs[0]!.id);
      expect(first.status).toBe('succeeded');
      const second = await waitForTerminal(runner, jobs[1]!.id);
      expect(second.status).toBe('succeeded');
      expect(claims).toBeGreaterThanOrEqual(2);
      expect(maximumActiveAgents).toBe(1);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('rejects admission when callback configuration is incomplete before starting a Job', async () => {
    let processCalls = 0;
    const runner = createProductionRunner({
      modelConfig: standardModelConfig,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async () => {
        processCalls += 1;
        return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
      },
    });

    const response = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-callback-config-missing',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
        }),
      }),
    );

    expect(response.status).toBe(503);
    expect(processCalls).toBe(0);
  });

  it('rejects malformed or unsupported deployment model config before claims or Sandbox work', async () => {
    const invalidConfigs = [
      undefined,
      '{',
      JSON.stringify({ id: 'other-provider/model' }),
      JSON.stringify({ id: 'opencode-go/' }),
      JSON.stringify({ id: 'opencode-go/ has space' }),
      JSON.stringify({ id: 'opencode-go/line\nbreak' }),
      JSON.stringify({ id: `opencode-go/${'a'.repeat(129)}` }),
      '{"id":"opencode-go/test-model","definition":{"cost":{"input":1e400,"output":0}}}',
      JSON.stringify({ id: 'opencode-go/test-model', definition: { name: '' } }),
      JSON.stringify({ id: 'opencode-go/test-model', baseUrl: '' }),
      JSON.stringify({ id: 'opencode-go/test-model', baseUrl: '/v1' }),
      JSON.stringify({ id: 'opencode-go/test-model', baseUrl: 'http://model.example.test/v1' }),
      JSON.stringify({
        id: 'opencode-go/test-model',
        baseUrl: 'https://user:key@model.example.test/v1',
      }),
      JSON.stringify({
        id: 'opencode-go/test-model',
        baseUrl: 'https://model.example.test/v1?key=value',
      }),
      JSON.stringify({
        id: 'opencode-go/test-model',
        baseUrl: 'https://model.example.test/v1#fragment',
      }),
      JSON.stringify({ id: 'opencode-go/test-model', baseUrl: 'https://*.example.test/v1' }),
      JSON.stringify({ id: 'opencode-go/test-model', apiKey: 'raw-secret' }),
      JSON.stringify({ id: 'opencode-go/test-model', definition: { name: 'Test' }, extra: true }),
      JSON.stringify({ id: 'opencode-go/test-model', definition: { name: 'Test', unsafe: true } }),
    ];
    for (const [index, modelConfig] of invalidConfigs.entries()) {
      let claims = 0;
      let processCalls = 0;
      const runner = createProductionRunner({
        authToken: 'runner-test-token',
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
        ...(modelConfig === undefined ? {} : { modelConfig }),
        callbackUrl: 'https://ingress.test/runner-callback',
        callbackToken: 'callback-token',
        claimUrl: 'https://ingress.test/runner-claim',
        claimFetch: async () => {
          claims += 1;
          return new Response(null, { status: 204 });
        },
        claimIntervalMs: 1,
        process: async () => {
          processCalls += 1;
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        },
      });

      const response = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...runnerJobFields,
            runId: `run-model-config-${index}`,
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha: '1111111111111111111111111111111111111111',
            headSha: '2222222222222222222222222222222222222222',
          }),
        }),
      );

      expect(response.status).toBe(503);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(claims).toBe(0);
      expect(processCalls).toBe(0);
    }
  });

  it('sends one named-field evidence callback after a successful Job', async () => {
    const callbackRequests: Request[] = [];
    const result = await runAgentScenario({
      runId: 'run-callback-success',
      output: finalMarkdownJsonl(),
      callbackRequests,
    });

    expect(result.terminal.status).toBe('succeeded');
    expect(callbackRequests).toHaveLength(1);
    expect(callbackRequests[0]?.url).toBe('https://ingress.test/runner-callback');
    expect(callbackRequests[0]?.headers.get('authorization')).toBe('Bearer callback-token');
    const callback = (await callbackRequests[0]?.json()) as {
      evidence: Record<string, unknown>;
    };
    expect(callback.evidence).toMatchObject({
      id: result.terminal.evidenceId,
      status: 'complete',
      manifest: {
        content: expect.any(String),
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      opencodeJsonl: {
        content: expect.any(String),
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      opencodeStderr: {
        content: expect.any(String),
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      validatedReview: {
        content: expect.any(String),
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      opencodeSessionList: {
        content: expect.any(String),
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      opencodeExport: {
        sessionId: 'scenario-session',
        content: {
          content: expect.any(String),
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
    });
    expect(callback.evidence).not.toHaveProperty('files');
  });

  it('makes one bounded immediate callback retry while retaining local evidence', async () => {
    const callbackRequests: Request[] = [];
    const result = await runAgentScenario({
      runId: 'run-callback-loss',
      output: finalMarkdownJsonl(),
      callbackRequests,
      callbackStatuses: [503, 503],
    });

    expect(result.terminal.status).toBe('succeeded');
    expect(callbackRequests).toHaveLength(2);
    await expect(
      readFile(
        join(sharedEvidenceRoot, result.terminal.evidenceId as string, 'manifest.json'),
        'utf8',
      ),
    ).resolves.toContain('run-callback-loss');
  });

  it('bounds each callback attempt when callback transport hangs', async () => {
    const callbackRequests: Request[] = [];
    const startedAt = performance.now();
    const result = await runAgentScenario({
      runId: 'run-callback-timeout',
      output: finalMarkdownJsonl(),
      callbackRequests,
      callbackHangs: true,
      callbackTimeoutMs: 5,
    });
    for (let attempt = 0; attempt < 50 && callbackRequests.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(result.terminal.status).toBe('succeeded');
    expect(callbackRequests).toHaveLength(2);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('reports oversized callback evidence as terminal incomplete without truncating local evidence', async () => {
    const evidenceRoot = await mkdtemp(`${tmpdir()}/compte-rendu-oversized-callback-`);
    const callbackRequests: Request[] = [];
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const sessionExport = JSON.stringify({
      info: { id: 'oversized-session' },
      messages: [
        { id: 'message-1', parts: [{ type: 'text', text: 'x'.repeat(25 * 1024 * 1024) }] },
      ],
    });
    try {
      const runner = createRunner({
        authToken: 'runner-test-token',
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
        evidenceRoot,
        callbackUrl: 'https://ingress.test/runner-callback',
        callbackToken: 'callback-token',
        callbackFetch: async (input, init) => {
          callbackRequests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
        process: async (_command, args, options = {}) => {
          if (args[0] === 'exec' && args.includes('--agent')) {
            await writeFile(
              options.stdoutFilePath!,
              `${finalMarkdownJsonl(undefined, 'oversized-session')}\n`,
              { mode: 0o600 },
            );
            await writeFile(options.stderrFilePath!, '', { mode: 0o600 });
          }
          if (args[0] === 'cp') {
            const source = args[1];
            const destination = args[2];
            if (source.endsWith('opencode-export-oversized-session.json')) {
              await writeFile(destination, sessionExport, { mode: 0o600 });
            } else {
              await mkdir(destination, { recursive: true, mode: 0o700 });
              await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
              await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
            }
          }
          return {
            exitCode: 0,
            stdout: args.includes('rev-parse')
              ? `${baseSha}\n${headSha}\n`
              : args.includes('session')
                ? '[{"id":"oversized-session"}]\n'
                : args.includes('--agent')
                  ? `${finalMarkdownJsonl(undefined, 'oversized-session')}\n`
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
            runId: 'run-114-oversized-callback',
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha,
            headSha,
          }),
        }),
      );
      const { id } = (await submitted.json()) as { id: string };
      const terminal = await waitForTerminal(runner, id);
      for (let attempt = 0; attempt < 50 && callbackRequests.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(terminal.status).toBe('failed');
      expect(callbackRequests).toHaveLength(1);
      const callback = (await callbackRequests[0]?.clone().json()) as {
        status: string;
        failure?: { reason: string };
        evidence: Record<string, unknown>;
      };
      expect(callback).toMatchObject({
        status: 'failed',
        failure: { reason: 'evidence' },
        evidence: {
          id: terminal.evidenceId,
          status: 'incomplete',
          manifest: { content: '', size: 0, sha256: expect.any(String) },
          opencodeJsonl: { content: '', size: 0, sha256: expect.any(String) },
          opencodeStderr: { content: '', size: 0, sha256: expect.any(String) },
        },
      });
      expect(callback.evidence).not.toHaveProperty('opencodeExport');
      // The bounded lifecycle snapshot is retained even when evidence exceeds the callback limit.
      expect(callback).toMatchObject({ lifecycle: { stage: 'cleanup', sequence: 5 } });
      expect(new TextEncoder().encode(JSON.stringify(callback)).byteLength).toBeLessThan(2048);
      await expect(
        readFile(
          join(
            evidenceRoot,
            terminal.evidenceId as string,
            'opencode-export-oversized-session.json',
          ),
          'utf8',
        ),
      ).resolves.toBe(sessionExport);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('reports a process-exit cause without exposing agent content', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'process-exit-session');
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
      output: finalMarkdownJsonl(),
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

  it('publishes the completed submit_review tool Markdown instead of terminal narration', async () => {
    const finalMarkdown = '\n  ## Review:\n\nNo findings.  \n';
    const output = finalMarkdownJsonl(finalMarkdown);
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-109-submit-review-tool',
      output,
    });

    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(finalMarkdown),
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({
      complete: true,
      terminal: { status: 'succeeded' },
      evidence: { status: 'complete' },
      cleanup: { status: 'destroyed' },
    });
    await expect(
      readFile(
        join(sharedEvidenceRoot, terminal.evidenceId as string, 'validated-review.md'),
        'utf8',
      ),
    ).resolves.toBe(finalMarkdown);
    await expect(
      readFile(join(sharedEvidenceRoot, terminal.evidenceId as string, 'opencode.jsonl'), 'utf8'),
    ).resolves.toBe(`${output}\n`);
  });

  it.each([
    ['missing submission', 'text-only', 'zero-results'],
    ['errored submission', 'errored', 'zero-results'],
    ['empty submission', 'empty', 'empty-final-text'],
    ['invalid Markdown', 'invalid-markdown', 'result-schema-failure'],
    ['duplicate submissions', 'duplicate', 'multiple-results'],
    ['malformed completed submission', 'missing-call-id', 'result-schema-failure'],
  ] as const)('rejects %s as invalid output', async (_name, kind, cause) => {
    const terminalEvent = JSON.stringify({
      type: 'step_finish',
      part: { type: 'step-finish', messageID: 'msg-final', reason: 'stop' },
    });
    const narrationEvent = JSON.stringify({
      type: 'text',
      part: { type: 'text', messageID: 'msg-final', text: 'Terminal narration.' },
    });
    const output =
      kind === 'text-only'
        ? `${narrationEvent}\n${terminalEvent}`
        : kind === 'errored'
          ? `${narrationEvent}\n${submitReviewEvent('## Review:\n\nNo findings.', { status: 'error' })}\n${terminalEvent}`
          : kind === 'empty'
            ? `${narrationEvent}\n${submitReviewEvent('')}\n${terminalEvent}`
            : kind === 'invalid-markdown'
              ? `${narrationEvent}\n${submitReviewEvent('not a review')}\n${terminalEvent}`
              : kind === 'missing-call-id'
                ? `${narrationEvent}\n${JSON.stringify({ type: 'tool_use', sessionID: 'scenario-session', part: { type: 'tool', tool: 'submit_review', state: { status: 'completed', input: { decision: 'comment', markdown: '## Review:\n\nNo findings.' } } } })}\n${terminalEvent}`
                : `${narrationEvent}\n${submitReviewEvent()}\n${submitReviewEvent('## Review:\n\nSecond.', { callID: 'call-submit-review-2' })}\n${terminalEvent}`;
    const { terminal } = await runAgentScenario({
      runId: `run-109-${kind}`,
      output,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause },
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(terminal).not.toHaveProperty('result');
  });

  it('reminds the same review session once when a completed run omitted submit_review', async () => {
    const reminderMarkdown = '## Review:\n\nReminder submission.';
    const result = await runReminderScenario({
      runId: 'run-reminder-success',
      rounds: [
        { output: completedWithoutSubmitJsonl('session-reminder') },
        { output: submitReminderJsonl('session-reminder', reminderMarkdown) },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(reminderMarkdown),
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(result.createCommands).toHaveLength(1);
    expect(result.agentCommands[1]).toEqual(
      expect.arrayContaining([
        'exec',
        result.sandboxName,
        'opencode',
        'run',
        '--session',
        'session-reminder',
        '--agent',
        'review',
      ]),
    );
    expect(result.manifest).toMatchObject({
      sessionIds: ['session-reminder'],
      terminal: { status: 'succeeded' },
    });
    const evidencePath = join(sharedEvidenceRoot, result.terminal.evidenceId as string);
    const combined = await readFile(join(evidencePath, 'opencode.jsonl'), 'utf8');
    expect(combined).toContain('I completed the review without submitting.');
    expect(combined).toContain('Submitting the review now.');
    await expect(readFile(join(evidencePath, 'validated-review.md'), 'utf8')).resolves.toBe(
      reminderMarkdown,
    );
  });

  it('reports zero-results after a single reminder still omits submit_review', async () => {
    const result = await runReminderScenario({
      runId: 'run-reminder-still-missing',
      rounds: [{ output: completedWithoutSubmitJsonl('session-reminder') }],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'zero-results' },
    });
    expect(result.terminal).not.toHaveProperty('result');
  });

  it.each([
    ['duplicate submissions', 'multiple-results'],
    ['an invalid result', 'result-schema-failure'],
    ['an agent error event', 'agent-error'],
  ] as const)('does not remind the session after a completed run with %s', async (kind, cause) => {
    const session = 'session-reminder';
    const textEvent = JSON.stringify({
      type: 'text',
      sessionID: session,
      part: { type: 'text', messageID: 'msg-final', text: 'Completed.' },
    });
    const stopEvent = JSON.stringify({
      type: 'step_finish',
      sessionID: session,
      part: { type: 'step-finish', messageID: 'msg-final', reason: 'stop' },
    });
    const markdown = '## Review:\n\nNo findings.';
    const output =
      kind === 'duplicate submissions'
        ? [
            textEvent,
            submitReviewEvent(markdown),
            submitReviewEvent(markdown, { callID: 'call-submit-review-2' }),
            stopEvent,
          ].join('\n')
        : kind === 'an invalid result'
          ? [textEvent, submitReviewEvent('not a review'), stopEvent].join('\n')
          : [textEvent, JSON.stringify({ type: 'error' }), stopEvent].join('\n');

    const result = await runReminderScenario({
      runId: `run-reminder-no-${kind.replace(/\W+/g, '-')}`,
      rounds: [{ output }],
    });

    expect(result.agentRuns).toBe(1);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause },
    });
  });

  it('does not remind when the completed run timed out', async () => {
    const result = await runReminderScenario({
      runId: 'run-reminder-timeout',
      rounds: [{ output: completedWithoutSubmitJsonl('session-reminder'), timedOut: true }],
    });

    expect(result.agentRuns).toBe(1);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'timeout', cause: 'timeout' },
    });
  });

  it('does not remind when the Job is aborted after a zero-results run', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    let agentStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    let releaseAgent!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    let agentRuns = 0;
    const zeroResults = completedWithoutSubmitJsonl('session-reminder');
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        const isAgent = args[0] === 'exec' && args.includes('--agent');
        if (isAgent) {
          agentRuns += 1;
          agentStarted();
          await gate;
          await writeEvidenceFixture(args, options, zeroResults);
          return {
            exitCode: 0,
            stdout: `${zeroResults}\n`,
            timedOut: false,
            truncated: false,
          };
        }
        await writeEvidenceFixture(args, options, '');
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"session-reminder"}]\n'
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
          runId: 'run-reminder-abort',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    await started;
    const aborted = runner.handle(
      new Request(`http://runner/jobs/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );
    releaseAgent();
    expect((await aborted).status).toBe(200);
    expect(agentRuns).toBe(1);
    const terminal = await runner.handle(
      new Request(`http://runner/jobs/${id}`, {
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );
    expect((await terminal.json()) as { status: string }).toMatchObject({ status: 'aborted' });
  });

  it('does not remind when the shared agent budget is exhausted', async () => {
    const agentBudgetMs = 30 * 60 * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'));
      const result = await runReminderScenario({
        runId: 'run-reminder-budget-exhausted',
        rounds: [
          {
            output: completedWithoutSubmitJsonl('session-reminder'),
            advanceMs: agentBudgetMs + 1,
          },
        ],
      });

      expect(result.agentRuns).toBe(1);
      expect(result.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'invalid-output', cause: 'zero-results' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the reminder at the remaining shared agent budget', async () => {
    const agentBudgetMs = 30 * 60 * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'));
      const reminderMarkdown = '## Review:\n\nBudget-capped reminder.';
      const result = await runReminderScenario({
        runId: 'run-reminder-budget-remaining',
        rounds: [
          {
            output: completedWithoutSubmitJsonl('session-reminder'),
            advanceMs: agentBudgetMs - 30_000,
          },
          { output: submitReminderJsonl('session-reminder', reminderMarkdown) },
        ],
      });

      expect(result.agentRuns).toBe(2);
      expect(result.agentTimeouts[0]).toBe(agentBudgetMs);
      expect(result.agentTimeouts[1]).toBe(30_000);
      expect(result.terminal).toMatchObject({
        status: 'succeeded',
        result: structuredResult(reminderMarkdown),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not remind a session whose exported final turn was truncated', async () => {
    const result = await runReminderScenario({
      runId: 'run-v2-no-reminder-after-length',
      rounds: [{ output: completedWithoutSubmitJsonl('session-reminder'), exportFinish: 'length' }],
    });
    expect(result.agentRuns).toBe(1);
    expect(result.terminal).toMatchObject({ status: 'failed', sandbox: { cleanup: 'destroyed' } });
    expect(result.terminal).not.toHaveProperty('result');
    expect(result.manifest).not.toHaveProperty('result');
  });

  it('rejects a reminder round that submits without its own terminal stop', async () => {
    const session = 'session-reminder';
    const reminderWithoutStop = [
      JSON.stringify({
        type: 'text',
        sessionID: session,
        part: { type: 'text', messageID: 'msg-reminder', text: 'Submitting the review.' },
      }),
      submitReviewEvent('## Review:\n\nReminder without a stop.', {
        callID: 'call-reminder',
        sessionID: session,
      }),
    ].join('\n');
    const result = await runReminderScenario({
      runId: 'run-reminder-no-stop',
      rounds: [
        { output: completedWithoutSubmitJsonl(session) },
        { output: reminderWithoutStop, exportFinish: 'length' },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
    });
    expect(result.terminal).not.toHaveProperty('result');
  });

  it('does not accept a reminder submission from a different session', async () => {
    const result = await runReminderScenario({
      runId: 'run-reminder-session-mismatch',
      rounds: [
        { output: completedWithoutSubmitJsonl('session-reminder') },
        { output: submitReminderJsonl('session-other', '## Review:\n\nOther session.') },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'zero-results' },
    });
    expect(result.terminal).not.toHaveProperty('result');
  });

  it('preserves a malformed reminder round cause', async () => {
    const result = await runReminderScenario({
      runId: 'run-reminder-malformed',
      rounds: [
        { output: completedWithoutSubmitJsonl('session-reminder') },
        { output: 'not-jsonl' },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'malformed-jsonl' },
    });
  });

  it('preserves an explicit reminder agent error without a session ID', async () => {
    const result = await runReminderScenario({
      runId: 'run-reminder-agent-error',
      rounds: [
        { output: completedWithoutSubmitJsonl('session-reminder') },
        { output: JSON.stringify({ type: 'error' }) },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'agent-error' },
    });
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

  it('publishes a recovered OpenCode review despite its sticky exit code', async () => {
    const markdown = '## Review:\n\nNo findings after recovery.';
    const callbacks: Request[] = [];
    const output = [
      JSON.stringify({
        type: 'error',
        sessionID: 'scenario-session',
        error: {
          type: 'provider.invalid-output',
          message: 'OpenAI Chat stream ended without finish_reason',
          status: 200,
        },
      }),
      finalMarkdownJsonl(markdown),
    ].join('\n');
    const exported = JSON.stringify({
      info: { id: 'scenario-session', outcome: 'succeeded' },
      messages: [
        { type: 'assistant', finish: 'error', content: [] },
        {
          type: 'assistant',
          finish: 'tool-calls',
          content: [
            {
              type: 'tool',
              name: 'submit_review',
              state: { status: 'completed', input: { decision: 'comment', markdown } },
            },
          ],
        },
        { type: 'assistant', finish: 'stop', content: [] },
        { type: 'idle', outcome: 'succeeded' },
      ],
    });
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-recovered-cli',
      output,
      exitCode: 1,
      sessionExport: exported,
      callbackRequests: callbacks,
    });
    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(markdown),
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({
      terminal: { status: 'succeeded' },
      result: structuredResult(markdown),
    });
    const callback = await callbacks[0]!.json();
    expect(callback).toMatchObject({ status: 'succeeded', result: structuredResult(markdown) });
    await expect(
      readFile(
        join(sharedEvidenceRoot, terminal.evidenceId as string, 'validated-review.md'),
        'utf8',
      ),
    ).resolves.toBe(markdown);
  });

  it.each([
    'unknown-error',
    'foreign-error-session',
    'export-mismatch',
    'missing-export-submission',
    'duplicate-export-submission',
    'malformed-assistant',
    'failed-export',
    'foreign-export-session',
    'duplicate-jsonl-submission',
    'malformed-jsonl',
    'fatal-exit',
    'timeout',
    'truncated',
  ] as const)('does not accept apparent OpenCode recovery with %s', async (scenario) => {
    const markdown = '## Review:\n\nRecovered review.';
    const callbacks: Request[] = [];
    const error = JSON.stringify({
      type: 'error',
      sessionID: scenario === 'foreign-error-session' ? 'another-session' : 'scenario-session',
      error: {
        type: scenario === 'unknown-error' ? 'unknown.failure' : 'provider.invalid-output',
        status: 200,
      },
    });
    const output = [
      error,
      finalMarkdownJsonl(markdown),
      ...(scenario === 'duplicate-jsonl-submission'
        ? [submitReviewEvent(markdown, { callID: 'second-submission' })]
        : []),
      ...(scenario === 'malformed-jsonl' ? ['not-json'] : []),
    ].join('\n');
    const submission = {
      type: 'tool',
      name: 'submit_review',
      state: {
        status: 'completed',
        input: {
          decision: 'comment',
          markdown: scenario === 'export-mismatch' ? '## Review:\n\nDifferent.' : markdown,
        },
      },
    };
    const exported = JSON.stringify({
      info: {
        id: scenario === 'foreign-export-session' ? 'foreign-session' : 'scenario-session',
        outcome: scenario === 'failed-export' ? 'failed' : 'succeeded',
      },
      messages: [
        ...(scenario === 'malformed-assistant'
          ? [{ type: 'assistant', content: { tool: submission } }]
          : []),
        {
          type: 'assistant',
          finish: 'stop',
          content:
            scenario === 'missing-export-submission'
              ? []
              : scenario === 'duplicate-export-submission'
                ? [submission, submission]
                : [submission],
        },
        { type: 'idle', outcome: 'succeeded' },
      ],
    });
    const { terminal, manifest } = await runAgentScenario({
      runId: `run-recovery-${scenario}`,
      output,
      exitCode: scenario === 'fatal-exit' ? 137 : 1,
      timedOut: scenario === 'timeout',
      truncated: scenario === 'truncated',
      sessionExport: exported,
      callbackRequests: callbacks,
    });
    expect(terminal).toMatchObject({ status: 'failed', sandbox: { cleanup: 'destroyed' } });
    expect(terminal).not.toHaveProperty('result');
    expect(manifest).not.toHaveProperty('result');
    expect(await callbacks[0]!.json()).not.toHaveProperty('result');
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

  it('reports missing-terminal-message when OpenCode emits no terminal assistant message', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-missing-terminal-message',
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

  it.each(['length', 'error'] as const)(
    'does not publish final text when the terminal step finishes with %s',
    async (reason) => {
      const output = [
        JSON.stringify({
          type: 'text',
          part: { type: 'text', messageID: 'msg-final', text: '# Partial review' },
        }),
        JSON.stringify({
          type: 'step_finish',
          part: { type: 'step-finish', messageID: 'msg-final', reason },
        }),
      ].join('\n');
      const { terminal, manifest } = await runAgentScenario({
        runId: `run-105-${reason}-terminal`,
        output,
      });

      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'invalid-output', cause: 'zero-results' },
        evidence: { status: 'complete' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(terminal).not.toHaveProperty('result');
      expect(manifest).toMatchObject({
        execution: { status: 'failed', reason: 'invalid-output', cause: 'zero-results' },
        terminal: { status: 'failed', reason: 'invalid-output', cause: 'zero-results' },
      });
    },
  );

  it.each(['length', null, { malformed: true }])(
    'rejects a submission whose final assistant finish is %j',
    async (finish) => {
      const markdown = '## Review:\n\nNo findings.';
      const { terminal, manifest } = await runAgentScenario({
        runId: 'run-v2-last-assistant-length',
        output: finalMarkdownJsonl(markdown),
        sessionExport: JSON.stringify({
          info: { id: 'scenario-session', outcome: 'succeeded' },
          messages: [
            { type: 'assistant', finish: 'stop' },
            { type: 'assistant', finish },
            { type: 'idle', outcome: 'succeeded' },
          ],
        }),
      });

      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(terminal).not.toHaveProperty('result');
      expect(manifest).not.toHaveProperty('result');
    },
  );

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

  it.each([
    ['exits nonzero', { exitCode: 1 }, 'process-exit'],
    ['times out', { timedOut: true }, 'timeout'],
  ] as const)(
    'retains the failed Sandbox create cause when create %s',
    async (_case, create, cause) => {
      const { terminal, manifest } = await runAgentScenario({
        runId: `run-153-create-${cause}`,
        output: '',
        create,
      });

      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'agent', cause },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(manifest).toMatchObject({
        execution: { status: 'failed', reason: 'agent', cause },
        terminal: { status: 'failed', reason: 'agent', cause },
      });
    },
  );

  it.each([
    ['exits nonzero', { exitCode: 1 }, 'process-exit'],
    ['times out', { timedOut: true }, 'timeout'],
  ] as const)(
    'retains the failed Sandbox create cause when cleanup removal also fails and create %s',
    async (_case, create, cause) => {
      const { terminal, manifest } = await runAgentScenario({
        runId: `run-153-create-${cause}-through-cleanup`,
        output: '',
        create,
        sandboxRemovalFailure: true,
      });

      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'cleanup', cause },
        sandbox: { cleanup: 'failed' },
      });
      expect(manifest).toMatchObject({
        execution: { status: 'failed', reason: 'cleanup', cause },
        terminal: { status: 'failed', reason: 'cleanup', cause },
      });
    },
  );

  it('removes only each job-owned network rules for jobs sharing resources', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'policy-session');
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

    const first = await submit('run-93-policy-first');
    const firstTerminal = await waitForTerminal(runner, first.id);
    const second = await submit('run-93-policy-second');
    const secondTerminal = await waitForTerminal(runner, second.id);

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
    const resultLine = finalMarkdownJsonl(undefined, 'cleanup-failure-session');
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
    const resultLine = finalMarkdownJsonl(undefined, 'orphan-session');
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
    const resultLine = finalMarkdownJsonl(undefined, 'lookup-failure-session');
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

  it('inspects policy globally after Sandbox removal when the scoped sandbox no longer exists', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'absent-scope-session');
    const rules: Array<Record<string, unknown>> = [
      {
        id: 'default-deny-all',
        resources: ['**'],
        editable: false,
        origin: 'local',
        layer: 'local',
      },
    ];
    let sandboxExists = true;
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
          const scoped = args[2] !== undefined && !args[2].startsWith('--');
          if (scoped && !sandboxExists) {
            return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
          }
          return {
            exitCode: 0,
            stdout: options.captureStdout === true ? JSON.stringify({ rules }) + '\n' : '',
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
          sandboxExists = false;
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'secret' && args[1] === 'rm') {
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"absent-scope-session"}]\n'
              : args.includes('export')
                ? '{"session":"absent-scope-session","full":true}\n'
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
          runId: 'run-157-absent-scope',
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
  });

  it('completes unattended cleanup only when network policy removal is forced', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'force-removal-session');
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
          if (!args.includes('--force')) {
            return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
          }
          const ruleId = args[args.indexOf('--id') + 1];
          const index = rules.findIndex((rule) => rule.id === ruleId);
          if (index >= 0) rules.splice(index, 1);
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'rm' && args[1] === '--force') {
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'secret' && args[1] === 'rm') {
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"force-removal-session"}]\n'
              : args.includes('export')
                ? '{"session":"force-removal-session","full":true}\n'
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
          runId: 'run-157-force-removal',
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
  });

  it('does not remove a replacement rule when a recorded policy ID disappears', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'replacement-session');
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
    const finalMarkdown = '## Review:\n\nNo findings.';
    const agentJsonl = [
      JSON.stringify({
        type: 'text',
        part: {
          type: 'text',
          messageID: 'msg-final',
          text: 'I finished reviewing the pull request.',
        },
      }),
      submitReviewEvent(finalMarkdown, { sessionID: 'session-89' }),
      JSON.stringify({
        type: 'step_finish',
        part: { type: 'step-finish', messageID: 'msg-final', reason: 'stop' },
      }),
    ].join('\n');
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
            const sessionId = args[1].match(/opencode-export-([A-Za-z0-9._:-]+)\.json$/)?.[1];
            if (sessionId !== undefined) {
              await writeFile(destination, sessionExportJson(sessionId), { mode: 0o600 });
            } else {
              await mkdir(destination, { recursive: true, mode: 0o700 });
              await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
              await writeFile(join(destination, 'opencode.db-wal'), 'wal', { mode: 0o600 });
              await writeFile(join(destination, 'opencode.db-shm'), 'shm', { mode: 0o600 });
              await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
            }
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
      await expect(readFile(join(archive, 'validated-review.md'), 'utf8')).resolves.toBe(
        finalMarkdown,
      );
      expect(JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))).toMatchObject({
        jobId: expect.any(String),
        sandboxName: expect.any(String),
        sandboxId: expect.any(String),
        sessionIds: ['session-89', 'session-child'],
        model: 'opencode-go/deepseek-flash',
        image: 'ghcr.io/ariga39/petit-chiba-opencode:2.0.32-gh2.98.0',
        openCodeVersion: '2.0.32',
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

  it('retains a complete valid JSON export larger than the Sandbox exec stdout limit', async () => {
    const evidenceRoot = await mkdtemp(`${tmpdir()}/compte-rendu-large-export-`);
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const sessionExport = JSON.stringify({
      info: { id: 'large-session', outcome: 'succeeded' },
      messages: [
        {
          type: 'assistant',
          finish: 'stop',
          parts: [{ type: 'text', text: 'x'.repeat(70 * 1024) }],
        },
        { type: 'idle', outcome: 'succeeded' },
      ],
    });
    const sessionExportBytes = new TextEncoder().encode(sessionExport);
    expect(sessionExportBytes.byteLength).toBeGreaterThan(64 * 1024);
    const truncatedBySandbox = new TextDecoder().decode(sessionExportBytes.slice(0, 64 * 1024));
    try {
      const runner = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
        process: async (command, args, options = {}) => {
          if (args[0] === 'exec' && args.includes('--agent')) {
            await writeFile(
              options.stdoutFilePath!,
              `${finalMarkdownJsonl(undefined, 'large-session')}\n`,
              { mode: 0o600 },
            );
            await writeFile(options.stderrFilePath!, '', { mode: 0o600 });
          }
          if (args[0] === 'exec' && args.includes('export')) {
            if (options.stdoutFilePath !== undefined) {
              await writeFile(options.stdoutFilePath, truncatedBySandbox, { mode: 0o600 });
            }
          }
          if (command === 'sbx' && args[0] === 'cp') {
            const source = args[1];
            const destination = args[2];
            if (!source.endsWith('/data') && !source.endsWith('/state')) {
              await writeFile(destination, sessionExport, { mode: 0o600 });
            } else {
              await mkdir(destination, { recursive: true, mode: 0o700 });
              await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
              await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
            }
          }
          return {
            exitCode: 0,
            stdout: args.includes('rev-parse')
              ? `${baseSha}\n${headSha}\n`
              : args.includes('session')
                ? '[{"id":"large-session"}]\n'
                : args.includes('--agent')
                  ? `${finalMarkdownJsonl(undefined, 'large-session')}\n`
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
            runId: 'run-107-large-export',
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
        evidence: { status: 'complete' },
        sandbox: { cleanup: 'destroyed' },
      });
      const archive = join(evidenceRoot, terminal.evidenceId as string);
      const retainedExport = await readFile(
        join(archive, 'opencode-export-large-session.json'),
        'utf8',
      );
      expect(new TextEncoder().encode(retainedExport).byteLength).toBe(
        sessionExportBytes.byteLength,
      );
      expect(JSON.parse(retainedExport)).toEqual(JSON.parse(sessionExport));
      expect(JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))).toMatchObject({
        complete: true,
        evidence: { status: 'complete' },
      });
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('does not report complete evidence for a malformed or truncated session export', async () => {
    const evidenceRoot = await mkdtemp(`${tmpdir()}/compte-rendu-malformed-export-`);
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const malformedExport =
      '{"info":{"id":"malformed-session"},"messages":[' + '"x",'.repeat(16 * 1024);
    try {
      const runner = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
        process: async (_command, args, options = {}) => {
          if (args[0] === 'exec' && args.includes('--agent')) {
            await writeFile(
              options.stdoutFilePath!,
              `${finalMarkdownJsonl(undefined, 'malformed-session')}\n`,
              { mode: 0o600 },
            );
            await writeFile(options.stderrFilePath!, '', { mode: 0o600 });
          }
          if (args[0] === 'exec' && args.includes('export')) {
            if (options.stdoutFilePath !== undefined) {
              await writeFile(options.stdoutFilePath, malformedExport, { mode: 0o600 });
            }
          }
          if (args[0] === 'cp') {
            const source = args[1];
            const destination = args[2];
            if (!source.endsWith('/data') && !source.endsWith('/state')) {
              await writeFile(destination, malformedExport, { mode: 0o600 });
            } else {
              await mkdir(destination, { recursive: true, mode: 0o700 });
              await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
              await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
            }
          }
          return {
            exitCode: 0,
            stdout: args.includes('rev-parse')
              ? `${baseSha}\n${headSha}\n`
              : args.includes('session')
                ? '[{"id":"malformed-session"}]\n'
                : args.includes('--agent')
                  ? `${finalMarkdownJsonl(undefined, 'malformed-session')}\n`
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
            runId: 'run-107-malformed-export',
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha,
            headSha,
          }),
        }),
      );
      const { id } = (await submitted.json()) as { id: string };
      const terminal = await waitForTerminal(runner, id);
      const manifest = JSON.parse(
        await readFile(join(evidenceRoot, terminal.evidenceId as string, 'manifest.json'), 'utf8'),
      );

      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
        evidence: { status: 'incomplete' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(manifest).toMatchObject({
        complete: false,
        evidence: { status: 'incomplete' },
        terminal: { status: 'failed', reason: 'invalid-output', cause: 'missing-terminal-message' },
      });
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('reports incomplete evidence as its own failure when archiving fails', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'archive-failure-session');
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
      failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
      evidence: { status: 'incomplete' },
      sandbox: { cleanup: 'destroyed' },
    });
  });

  it('retains sanitized checkout failure diagnostics without exposing credentials', async () => {
    const events: unknown[] = [];
    const repositoryUrl = 'https://github.com/acme/reviewed.git';
    const repositoryReadToken = 'checkout-diagnostic-secret';
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'model-secret-resolver',
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
      process: async (_command, args) => ({
        exitCode: args.includes('clone') ? 128 : 0,
        stdout: '',
        stderr: args.includes('clone')
          ? `fatal: unable to access ${repositoryUrl}: connection reset ${repositoryReadToken}`
          : '',
        timedOut: false,
        truncated: false,
      }),
    });
    const response = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: { authorization: 'Bearer runner-test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-checkout-diagnostics',
          attempt: 1,
          repositoryUrl,
          repositoryReadToken,
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
        }),
      }),
    );
    const { id } = (await response.json()) as { id: string };
    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'checkout' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        stage: 'checkout',
        command: 'clone',
        exitCode: 128,
        stderr: 'fatal: unable to access [repository]: connection reset [redacted]',
      }),
    );
    expect(JSON.stringify(events)).not.toContain(repositoryReadToken);
    expect(JSON.stringify(events)).not.toContain(repositoryUrl);
  });

  it.each(['absent', 'present', 'unavailable', 'truncated', 'timeout', 'wrong-name'])(
    'confirms failed-create cleanup only with exact sandbox absence: %s',
    async (inspection) => {
      const baseSha = '1111111111111111111111111111111111111111';
      const headSha = '2222222222222222222222222222222222222222';
      const runner = createRunner({
        evidenceRoot: sharedEvidenceRoot,
        authToken: 'runner-test-token',
        modelSecretCommand: 'model-secret-resolver',
        process: async (_command, args) => {
          if (args[0] === 'inspect')
            return {
              exitCode: inspection === 'present' ? 0 : 1,
              stdout: inspection === 'present' ? '{"name":"existing"}' : '',
              stderr:
                inspection === 'unavailable'
                  ? 'error: daemon unavailable'
                  : `WARN: docker hub refresh lock held by another process: context deadline exceeded\nerror: sandbox '${inspection === 'wrong-name' ? 'another-sandbox' : args[1]}' not found\n  try: sbx ls\n`,
              timedOut: inspection === 'timeout',
              truncated: false,
              stderrTruncated: inspection === 'truncated',
            };
          return {
            exitCode: args[0] === 'create' || args[0] === 'rm' ? 1 : 0,
            stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
            stderr: args[0] === 'create' ? 'context canceled' : '',
            timedOut: false,
            truncated: false,
          };
        },
      });
      const response = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...runnerJobFields,
            runId: `run-absent-cleanup-${inspection}`,
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha,
            headSha,
          }),
        }),
      );
      const { id } = (await response.json()) as { id: string };
      await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
        status: 'failed',
        sandbox: { cleanup: inspection === 'absent' ? 'destroyed' : 'failed' },
      });
    },
  );

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
    const resultLine = finalMarkdownJsonl(undefined, 'network-failure-session');
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
    const finalMarkdown = '## Review:\n\nNo findings.';
    const resultLine = [
      JSON.stringify({
        type: 'text',
        part: {
          type: 'text',
          messageID: 'msg-final',
          text: 'I finished reviewing the pull request.',
        },
      }),
      submitReviewEvent(finalMarkdown, { sessionID: 'fixture-session' }),
      JSON.stringify({
        type: 'step_finish',
        part: { type: 'step-finish', messageID: 'msg-final', reason: 'stop' },
      }),
    ].join('\n');
    let createArgs: readonly string[] | undefined;
    let fetchArgs: readonly string[] | undefined;
    let agentArgs: readonly string[] | undefined;
    let configRootAtSandboxBoundary: string | undefined;
    let skillAtSandboxBoundary: string | undefined;
    let submitReviewToolAvailableAtSandboxBoundary = false;
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
          await readFile(join(configRoot, 'opencode/plugins/submit_review/index.js'), 'utf8');
          submitReviewToolAvailableAtSandboxBoundary = true;
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
      result: structuredResult(finalMarkdown),
      sandbox: { cleanup: 'destroyed' },
    });
    expect(createArgs).toEqual(expect.arrayContaining(['--clone', '--no-share-skills']));
    const template = 'ghcr.io/ariga39/petit-chiba-opencode:2.0.32-gh2.98.0';
    const templateIndex = createArgs?.indexOf(template) ?? -1;
    const launcherIndex = createArgs?.lastIndexOf('shell') ?? -1;
    expect(templateIndex).toBeGreaterThanOrEqual(0);
    expect(templateIndex).toBeLessThan(launcherIndex);
    expect(createArgs).not.toContain('opencode');
    expect(fetchArgs).toEqual(
      expect.arrayContaining([
        `+${baseSha}:refs/remotes/origin/review-base`,
        `+${headSha}:refs/remotes/origin/review-head`,
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
    expect(skillAtSandboxBoundary).toContain(
      'concise human-readable Markdown review ready to publish',
    );
    expect(skillAtSandboxBoundary).toMatch(/up to\s+five high-confidence actionable findings/);
    expect(skillAtSandboxBoundary).toContain(
      'the first prose sentence must state the overall verdict',
    );
    expect(skillAtSandboxBoundary).toContain('exact actionable-finding count');
    expect(skillAtSandboxBoundary).toContain('No actionable findings.');
    expect(skillAtSandboxBoundary?.replace(/\s+/g, ' ')).toContain('Found 1 actionable finding.');
    expect(skillAtSandboxBoundary).toContain('pagination status');
    expect(skillAtSandboxBoundary?.replace(/\s+/g, ' ')).toContain(
      'Tool calls and intermediate work may remain visible during the review.',
    );
    expect(skillAtSandboxBoundary?.replace(/\s+/g, ' ')).toContain(
      'After completing all analysis, call `submit_review` exactly once with the `decision` and the complete publishable Markdown in its `markdown` argument. The `markdown` argument itself must contain only findings and the conclusion ready to publish, with no visible planning, self-dialogue, candidate triage, or process narration. After optional outer whitespace, begin that argument with exactly `## Review:`. Do not emit the review as terminal prose; terminal assistant messages are evidence only.',
    );
    expect(submitReviewToolAvailableAtSandboxBoundary).toBe(true);
    expect(skillAtSandboxBoundary).not.toContain(
      'The final response must be exactly one bare JSON object',
    );
    expect(skillAtSandboxBoundary).not.toContain('schema-valid');
    expect(skillAtSandboxBoundary).not.toContain('web or repository inspection');
    expect(skillAtSandboxBoundary).not.toContain('```');
    const shellGuidance = skillAtSandboxBoundary?.replace(/\s+/g, ' ') ?? '';
    expect(shellGuidance).toContain('as direct shell commands');
    expect(shellGuidance).toContain(
      '`gh pr view`, `gh api graphql`, `git diff`, `git grep`, `git log`, and `git show` are available',
    );
    expect(shellGuidance).toContain("shell tool's workdir option; do not use `git -C` or `cd`");
    expect(shellGuidance).toContain(
      'one direct command per call: no pipelines, redirection, command chaining, command substitution, or wrapper commands',
    );
    expect(shellGuidance).toContain('Keep each GraphQL query on a single line');
    expect(shellGuidance).toContain(
      'Bound GitHub output with the native `--json` flag and simple field lists instead of piping to another command such as `head`',
    );
    expect(shellGuidance).toContain(
      'Avoid `--jq` expressions and other arguments containing shell metacharacters such as `|`, `>`, `;`, or `&`; the sandbox denies those command shapes',
    );
    expect(shellGuidance).toContain('Prefer field lists and pagination over output transformation');
    expect(shellGuidance).toContain(
      'permission denial means the command shape is unsupported, not that GitHub is unavailable',
    );
    expect(shellGuidance).toContain(
      'Retry the same intent as one allowed direct command before concluding GitHub cannot be reached',
    );
    expect(shellGuidance).toContain(
      'Do not probe the environment, auth, or token state, and do not broaden the allowed permissions',
    );
    const configContent = createArgs?.find((value) => value.startsWith('OPENCODE_CONFIG_CONTENT='));
    expect(configContent).toBeDefined();
    const config = JSON.parse(configContent!.slice('OPENCODE_CONFIG_CONTENT='.length)) as {
      model: string;
      providers: Record<string, { models: Record<string, Record<string, unknown>> }>;
      agents: {
        review: {
          description: string;
          mode: string;
          permissions: Array<{ action: string; resource: string; effect: string }>;
        };
      };
    };
    expect(config.model).toBe('opencode-go/deepseek-flash');
    expect(config.providers['opencode-go']?.models['deepseek-flash']).toEqual({
      name: 'DeepSeek V4.1 Flash',
      capabilities: { reasoning: { supported: true } },
      limit: { context: 1000000, output: 384000 },
      cost: { input: 0.15, output: 0.6, cache: { read: 0.003 } },
    });
    const permissions = config.agents.review.permissions;
    const rule = (action: string, resource: string, effect: string) =>
      permissions.find(
        (entry) =>
          entry.action === action && entry.resource === resource && entry.effect === effect,
      );
    expect(config.agents.review.mode).toBe('primary');
    expect(config.agents.review.description).toBe('Pull request reviewer');
    expect(permissions[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    expect(rule('submit_review', '*', 'allow')).toBeDefined();
    expect(rule('shell', 'gh api graphql *', 'allow')).toBeDefined();
    expect(rule('shell', 'gh pr view *', 'allow')).toBeDefined();
    expect(rule('shell', 'git diff *', 'allow')).toBeDefined();
    expect(rule('shell', 'git show *', 'allow')).toBeDefined();
    expect(rule('shell', '*', 'deny')).toBeDefined();
    expect(rule('edit', '*', 'deny')).toBeDefined();
    expect(rule('glob', '*', 'allow')).toBeDefined();
    expect(rule('grep', '*', 'allow')).toBeDefined();
    expect(rule('read', '*', 'allow')).toBeDefined();
    expect(rule('skill', '*', 'allow')).toBeDefined();
    expect(rule('webfetch', '*', 'deny')).toBeDefined();
    expect(permissions.some((entry) => entry.action === 'bash')).toBe(false);
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
    expect(agentArgs?.join(' ')).toContain(
      'concise human-readable Markdown review ready to publish',
    );
    expect(agentArgs?.join(' ')).toContain("pr-review skill's verdict-first output contract");
    expect(agentArgs?.join(' ')).toContain(
      'Tool calls and intermediate work may remain visible during the review.',
    );
    expect(agentArgs?.join(' ')).toContain(
      'After completing all analysis, call `submit_review` exactly once with the `decision` and the complete publishable Markdown in its `markdown` argument. The `markdown` argument itself must contain only findings and the conclusion ready to publish, with no visible planning, self-dialogue, candidate triage, or process narration. After optional outer whitespace, begin that argument with exactly `## Review:`. Do not emit the review as terminal prose; terminal assistant messages are evidence only.',
    );
    expect(agentArgs?.join(' ')).not.toContain('Return exactly one bare JSON object');
    expect(agentArgs?.join(' ')).not.toContain('schema-valid');
    await expect(
      readFile(join(configRootAtSandboxBoundary!, 'opencode/skills/pr-review/SKILL.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('routes the deployment-configured model through trusted config, CLI, and evidence', async () => {
    const definition = {
      name: 'Test Model',
      reasoning: true,
      interleaved: { field: 'reasoning_details' },
      limit: { context: 200000, output: 8192 },
      cost: { input: 0.1, output: 0.2, cache_read: 0.01 },
    };
    const result = await runAgentScenario({
      runId: 'run-deployment-model',
      output: finalMarkdownJsonl(),
      modelConfig: JSON.stringify({ id: 'opencode-go/test-model-7', definition }),
    });

    expect(result.terminal.status).toBe('succeeded');
    expect(result.terminal.evidenceId).toEqual(expect.any(String));
    expect(result.manifest.model).toBe('opencode-go/test-model-7');
    const modelIndex = result.agentArgs?.indexOf('--model') ?? -1;
    expect(result.agentArgs?.[modelIndex + 1]).toBe('opencode-go/test-model-7');
    const configContent = result.createArgs?.find((value) =>
      value.startsWith('OPENCODE_CONFIG_CONTENT='),
    );
    expect(JSON.parse(configContent!.slice('OPENCODE_CONFIG_CONTENT='.length))).toMatchObject({
      model: 'opencode-go/test-model-7',
      providers: {
        'opencode-go': {
          models: {
            'test-model-7': {
              name: 'Test Model',
              capabilities: { reasoning: { supported: true } },
              limit: { context: 200000, output: 8192 },
              cost: { input: 0.1, output: 0.2, cache: { read: 0.01 } },
            },
          },
        },
      },
    });
  });

  it('relies on the bundled catalog when the deployment config omits a definition', async () => {
    const result = await runAgentScenario({
      runId: 'run-deployment-model-catalog',
      output: finalMarkdownJsonl(),
      modelConfig: JSON.stringify({ id: 'opencode-go/test-model-catalog' }),
    });

    expect(result.terminal.status).toBe('succeeded');
    expect(result.manifest.model).toBe('opencode-go/test-model-catalog');
    const configContent = result.createArgs?.find((value) =>
      value.startsWith('OPENCODE_CONFIG_CONTENT='),
    );
    const config = JSON.parse(configContent!.slice('OPENCODE_CONFIG_CONTENT='.length)) as {
      model: string;
      providers?: unknown;
    };
    expect(config.model).toBe('opencode-go/test-model-catalog');
    expect(config.providers).toBeUndefined();
  });

  it('routes a custom base URL through provider options, credential host, network, and cleanup', async () => {
    const result = await runAgentScenario({
      runId: 'run-custom-base-url',
      output: finalMarkdownJsonl(),
      modelConfig: JSON.stringify({
        id: 'opencode-go/test-model-7',
        baseUrl: 'https://model.example.test/v1',
      }),
    });

    expect(result.terminal.status).toBe('succeeded');
    expect(result.manifest.model).toBe('opencode-go/test-model-7');
    expect(result.secretArgs?.[result.secretArgs.indexOf('--host') + 1]).toBe('model.example.test');
    expect(result.allowedResources).toContain('model.example.test:443');
    expect(result.allowedResources).not.toContain('opencode.ai:443');
    expect(result.removedRuleIds).toContain('compte-rendu-runner-job-test-model.example.test:443');
    const configContent = result.createArgs?.find((value) =>
      value.startsWith('OPENCODE_CONFIG_CONTENT='),
    );
    const config = JSON.parse(configContent!.slice('OPENCODE_CONFIG_CONTENT='.length)) as {
      model: string;
      providers: Record<
        string,
        {
          package?: string;
          settings?: { baseURL?: string };
          models?: Record<string, { settings?: { baseURL?: string } }>;
        }
      >;
    };
    expect(config.model).toBe('opencode-go/test-model-7');
    expect(config.providers['opencode-go']?.package).toBe(
      '@opencode/ai/providers/openai-compatible',
    );
    expect(config.providers['opencode-go']?.settings?.baseURL).toBe(
      'https://model.example.test/v1',
    );
    expect(config.providers['opencode-go']?.models?.['test-model-7']?.settings?.baseURL).toBe(
      'https://model.example.test/v1',
    );
  });

  it('derives an explicit HTTPS port for the custom route and coexists with a definition', async () => {
    const definition = { name: 'Test Model', reasoning: true };
    const result = await runAgentScenario({
      runId: 'run-custom-base-url-port',
      output: finalMarkdownJsonl(),
      modelConfig: JSON.stringify({
        id: 'opencode-go/test-model-7',
        baseUrl: 'https://model.example.test:8443/v1',
        definition,
      }),
    });

    expect(result.terminal.status).toBe('succeeded');
    expect(result.manifest.model).toBe('opencode-go/test-model-7');
    expect(result.secretArgs?.[result.secretArgs.indexOf('--host') + 1]).toBe('model.example.test');
    expect(result.allowedResources).toContain('model.example.test:8443');
    expect(result.allowedResources).not.toContain('opencode.ai:443');
    expect(result.removedRuleIds).toContain('compte-rendu-runner-job-test-model.example.test:8443');
    const configContent = result.createArgs?.find((value) =>
      value.startsWith('OPENCODE_CONFIG_CONTENT='),
    );
    expect(JSON.parse(configContent!.slice('OPENCODE_CONFIG_CONTENT='.length))).toMatchObject({
      model: 'opencode-go/test-model-7',
      providers: {
        'opencode-go': {
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: 'https://model.example.test:8443/v1' },
          models: {
            'test-model-7': {
              name: 'Test Model',
              capabilities: { reasoning: { supported: true } },
              settings: { baseURL: 'https://model.example.test:8443/v1' },
            },
          },
        },
      },
    });
  });

  it('returns submitted Markdown after terminal progress output', async () => {
    const finalPartOne =
      '## Review:\n\nThe change is sound; ordinary braces like `{example}` are part of the prose.';
    const finalPartTwo = '- No blocking findings.';
    const finalReview = `${finalPartOne}\n${finalPartTwo}`;
    const progressEvent = JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        messageID: 'msg-progress',
        text: 'Inspecting the pull request...',
      },
    });
    const finalPartOneEvent = JSON.stringify({
      type: 'text',
      part: { type: 'text', messageID: 'msg-final', text: finalPartOne },
    });
    const finalPartTwoEvent = JSON.stringify({
      type: 'text',
      part: { type: 'text', messageID: 'msg-final', text: finalPartTwo },
    });
    const submitEvent = JSON.stringify({
      type: 'tool_use',
      sessionID: 'scenario-session',
      part: {
        type: 'tool',
        id: 'call-final-review',
        tool: 'submit_review',
        state: {
          status: 'completed',
          input: { decision: 'comment', markdown: finalReview },
          output: 'Review submitted.',
          title: 'Review submitted.',
        },
      },
    });
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-109-submitted-markdown-review',
      output: `${progressEvent}\n${finalPartOneEvent}\n${finalPartTwoEvent}\n${submitEvent}`,
    });

    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(finalReview),
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({ complete: true, terminal: { status: 'succeeded' } });
  });

  it('reviews a behind target from merge base to head while retaining admitted revision facts', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const mergeBaseSha = '3333333333333333333333333333333333333333';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'merge-base-session');
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
      result: structuredResult('## Review:\n\nNo findings.'),
      sandbox: { cleanup: 'destroyed' },
    });
    expect(agentPrompt).toContain(`git diff --find-renames ${mergeBaseSha} ${headSha}`);
    expect(agentPrompt).toContain(`base ${baseSha}`);
    expect(agentPrompt).toContain(`head ${headSha}`);
  });

  it('preserves the expected diff when the merge base equals the admitted base', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'merge-base-equal-session');
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
    const resultLine = finalMarkdownJsonl(undefined, 'fixture-session');
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
          id: 'runner-job-github-read-secret',
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
      const resultLine = finalMarkdownJsonl(undefined, 'fixture-session');
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
        result: structuredResult('## Review:\n\nNo findings.'),
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
    const resultLine = finalMarkdownJsonl(undefined, 'fixture-session');
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
          id: `runner-job-test-${attempt}`,
          attempt,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
          repositoryReadToken: 'checkout-token-for-test',
        }),
      });

    const first = await runner.handle(request(1));
    const duplicate = await runner.handle(request(1));
    const firstState = (await first.clone().json()) as { id: string; attempt: number };
    await waitForTerminal(runner, firstState.id);
    const retry = await runner.handle(request(2));
    const duplicateState = (await duplicate.json()) as { id: string; attempt: number };
    const retryState = (await retry.json()) as { id: string; attempt: number };

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(duplicateState).toEqual(firstState);
    expect(retryState.attempt).toBe(2);
    expect(retryState.id).not.toBe(firstState.id);
  });

  it('fetches the exact admitted head SHA instead of a stale mutable pull request ref', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const stalePullRequestHead = '8fb71a5da668f89beff853e7b8899a689a6b2401';
    const resultLine = finalMarkdownJsonl(undefined, 'fixture-session');
    let fetchArgs: readonly string[] | undefined;
    let simulatedReviewHead = stalePullRequestHead;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'model-secret-resolver',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        if (_command === 'git' && args.includes('clone')) {
          await mkdir(args[args.length - 1], { recursive: true, mode: 0o700 });
        }
        if (_command === 'git' && args.includes('fetch')) {
          fetchArgs = args;
          const reviewHeadRefspec = args.find((value) =>
            value.endsWith(':refs/remotes/origin/review-head'),
          );
          const source = reviewHeadRefspec?.replace(/^\+/, '').split(':')[0];
          simulatedReviewHead = source === headSha ? headSha : stalePullRequestHead;
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${simulatedReviewHead}\n`
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
          runId: 'run-checkout-stale-pull-ref',
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
      status: 'succeeded',
      sandbox: { cleanup: 'destroyed' },
    });
    expect(fetchArgs).toEqual(
      expect.arrayContaining([
        `+${baseSha}:refs/remotes/origin/review-base`,
        `+${headSha}:refs/remotes/origin/review-head`,
      ]),
    );
    expect(fetchArgs).not.toContain(`+refs/pull/42/head:refs/remotes/origin/review-head`);
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

  it('rejects error events and oversized output', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const outputs = [JSON.stringify({ type: 'error' }), 'x'.repeat(8 * 1024 * 1024 + 1)];

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

describe('Runner concurrency', () => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  const independentJob = (pullRequestNumber: number, runId: string) => ({
    ...runnerJobFields,
    id: `runner-concurrency-job-${pullRequestNumber}-${runId}`,
    runId,
    attempt: 1,
    pullRequestNumber,
    repositoryUrl: 'https://github.com/acme/reviewed.git',
    baseSha,
    headSha,
  });

  it('rejects a non-positive or non-integer concurrency before claiming or admitting work', async () => {
    let claims = 0;
    let processCalls = 0;
    const base = {
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot: sharedEvidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      claimFetch: async () => {
        claims += 1;
        return new Response(null, { status: 204 });
      },
      claimIntervalMs: 1,
      process: async (): Promise<RunnerProcessResult> => {
        processCalls += 1;
        return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
      },
    };
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      expect(() => createRunner({ ...base, concurrency })).toThrow();
    }

    const previous = process.env.RUNNER_CONCURRENCY;
    try {
      process.env.RUNNER_CONCURRENCY = '0';
      expect(() => createRunner(base)).toThrow();
      process.env.RUNNER_CONCURRENCY = 'not-a-number';
      expect(() => createRunner(base)).toThrow();
    } finally {
      if (previous === undefined) delete process.env.RUNNER_CONCURRENCY;
      else process.env.RUNNER_CONCURRENCY = previous;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(claims).toBe(0);
    expect(processCalls).toBe(0);
  });

  it('runs independent pull request reviews concurrently up to the configured limit', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-concurrency-'));
    const jobs = [independentJob(42, 'run-overlap-1'), independentJob(43, 'run-overlap-2')];
    let claims = 0;
    let activeAgents = 0;
    let agentsStarted = 0;
    let maximumActiveAgents = 0;
    let releaseAgents: (() => void) | undefined;
    let bothRunning!: () => void;
    const bothRunningObserved = new Promise<void>((resolve) => {
      bothRunning = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseAgents = resolve;
    });
    const runner = createRunner({
      concurrency: 2,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: async () => {
        const job = jobs[claims++];
        return job === undefined ? new Response(null, { status: 204 }) : Response.json(job);
      },
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec' && args.includes('--agent')) {
          activeAgents += 1;
          agentsStarted += 1;
          maximumActiveAgents = Math.max(maximumActiveAgents, activeAgents);
          if (agentsStarted >= 2) bothRunning();
          await gate;
          await writeEvidenceFixture(
            args,
            options,
            finalMarkdownJsonl(undefined, 'concurrency-session'),
          );
          activeAgents -= 1;
          return {
            exitCode: 0,
            stdout: `${finalMarkdownJsonl(undefined, 'concurrency-session')}\n`,
            timedOut: false,
            truncated: false,
          };
        }
        await writeEvidenceFixture(
          args,
          options,
          finalMarkdownJsonl(undefined, 'concurrency-session'),
        );
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${jobs[0]!.baseSha}\n${jobs[0]!.headSha}\n`
            : args.includes('session')
              ? '[{"id":"concurrency-session"}]\n'
              : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    try {
      await Promise.race([
        bothRunningObserved,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('independent reviews did not overlap')), 2_000),
        ),
      ]);
      expect(maximumActiveAgents).toBe(2);
      releaseAgents?.();
      const first = await waitForTerminal(runner, jobs[0]!.id);
      const second = await waitForTerminal(runner, jobs[1]!.id);
      expect(first.status).toBe('succeeded');
      expect(second.status).toBe('succeeded');
    } finally {
      releaseAgents?.();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('waits for a free slot before starting a third independent review', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-third-'));
    const jobs = [
      independentJob(42, 'run-third-1'),
      independentJob(43, 'run-third-2'),
      independentJob(44, 'run-third-3'),
    ];
    let claims = 0;
    let activeAgents = 0;
    let startedCount = 0;
    let maximumActiveAgents = 0;
    let claimsWhenTwoRunning = -1;
    let releaseFirstWave: (() => void) | undefined;
    let twoRunning!: () => void;
    const twoRunningObserved = new Promise<void>((resolve) => {
      twoRunning = resolve;
    });
    const firstWaveGate = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    const runner = createRunner({
      concurrency: 2,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: async () => {
        const job = jobs[claims++];
        return job === undefined ? new Response(null, { status: 204 }) : Response.json(job);
      },
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec' && args.includes('--agent')) {
          activeAgents += 1;
          startedCount += 1;
          maximumActiveAgents = Math.max(maximumActiveAgents, activeAgents);
          if (startedCount === 2) {
            claimsWhenTwoRunning = claims;
            twoRunning();
          }
          if (startedCount <= 2) await firstWaveGate;
          await writeEvidenceFixture(
            args,
            options,
            finalMarkdownJsonl(undefined, 'concurrency-session'),
          );
          activeAgents -= 1;
          return {
            exitCode: 0,
            stdout: `${finalMarkdownJsonl(undefined, 'concurrency-session')}\n`,
            timedOut: false,
            truncated: false,
          };
        }
        await writeEvidenceFixture(
          args,
          options,
          finalMarkdownJsonl(undefined, 'concurrency-session'),
        );
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"concurrency-session"}]\n'
              : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    try {
      await Promise.race([
        twoRunningObserved,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('two reviews did not start')), 2_000),
        ),
      ]);
      expect(claimsWhenTwoRunning).toBe(2);
      releaseFirstWave?.();
      const terminals = await Promise.all(jobs.map((job) => waitForTerminal(runner, job.id)));
      expect(terminals.map((terminal) => terminal.status)).toEqual([
        'succeeded',
        'succeeded',
        'succeeded',
      ]);
      expect(maximumActiveAgents).toBe(2);
    } finally {
      releaseFirstWave?.();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('keeps a slot occupied through callback delivery before starting the next review', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-callback-'));
    const jobs = [independentJob(42, 'run-callback-1'), independentJob(43, 'run-callback-2')];
    let claims = 0;
    let callbacks = 0;
    let callbackStarted!: () => void;
    const callbackObserved = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    let releaseCallback: (() => void) | undefined;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const runner = createRunner({
      concurrency: 1,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      claimIntervalMs: 1,
      claimFetch: async () => {
        const job = jobs[claims++];
        return job === undefined ? new Response(null, { status: 204 }) : Response.json(job);
      },
      callbackFetch: async () => {
        callbacks += 1;
        if (callbacks === 1) {
          callbackStarted();
          await callbackGate;
        }
        return new Response(null, { status: 202 });
      },
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(
          args,
          options,
          finalMarkdownJsonl(undefined, 'concurrency-session'),
        );
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"concurrency-session"}]\n'
              : options.captureStdout === true
                ? `${finalMarkdownJsonl(undefined, 'concurrency-session')}\n`
                : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    try {
      await Promise.race([
        callbackObserved,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('first callback was not reached')), 2_000),
        ),
      ]);
      expect(claims).toBe(1);
      releaseCallback?.();
      const first = await waitForTerminal(runner, jobs[0]!.id);
      const second = await waitForTerminal(runner, jobs[1]!.id);
      expect(first.status).toBe('succeeded');
      expect(second.status).toBe('succeeded');
    } finally {
      releaseCallback?.();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('reserves the only slot for an in-flight claim without rejecting its admitted job', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-reserve-'));
    const claimedJob = independentJob(42, 'run-reserve-claimed');
    let claimCalls = 0;
    let claimRequested!: () => void;
    const claimObserved = new Promise<void>((resolve) => {
      claimRequested = resolve;
    });
    let resolveClaim: ((response: Response) => void) | undefined;
    const claimResponse = new Promise<Response>((resolve) => {
      resolveClaim = resolve;
    });
    const runner = createRunner({
      concurrency: 1,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: async () => {
        claimCalls += 1;
        if (claimCalls === 1) {
          claimRequested();
          return claimResponse;
        }
        return new Response(null, { status: 204 });
      },
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(
          args,
          options,
          finalMarkdownJsonl(undefined, 'concurrency-session'),
        );
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"concurrency-session"}]\n'
              : options.captureStdout === true
                ? `${finalMarkdownJsonl(undefined, 'concurrency-session')}\n`
                : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    try {
      await Promise.race([
        claimObserved,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('claim was not requested')), 2_000),
        ),
      ]);
      const direct = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(independentJob(99, 'run-reserve-direct')),
        }),
      );
      expect(direct.status).toBe(409);

      resolveClaim?.(Response.json(claimedJob));
      const terminal = await waitForTerminal(runner, claimedJob.id);
      expect(terminal.status).toBe('succeeded');
    } finally {
      resolveClaim?.(new Response(null, { status: 204 }));
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('serializes independent reviews by default without an explicit limit', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-default-'));
    const jobs = [independentJob(42, 'run-default-1'), independentJob(43, 'run-default-2')];
    let claims = 0;
    let activeAgents = 0;
    let maximumActiveAgents = 0;
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: async () => {
        const job = jobs[claims++];
        return job === undefined ? new Response(null, { status: 204 }) : Response.json(job);
      },
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec' && args.includes('--agent')) {
          activeAgents += 1;
          maximumActiveAgents = Math.max(maximumActiveAgents, activeAgents);
          await new Promise((resolve) => setTimeout(resolve, 10));
          await writeEvidenceFixture(
            args,
            options,
            finalMarkdownJsonl(undefined, 'concurrency-session'),
          );
          activeAgents -= 1;
          return {
            exitCode: 0,
            stdout: `${finalMarkdownJsonl(undefined, 'concurrency-session')}\n`,
            timedOut: false,
            truncated: false,
          };
        }
        await writeEvidenceFixture(
          args,
          options,
          finalMarkdownJsonl(undefined, 'concurrency-session'),
        );
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"concurrency-session"}]\n'
              : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    try {
      const terminals = await Promise.all(jobs.map((job) => waitForTerminal(runner, job.id)));
      expect(terminals.map((terminal) => terminal.status)).toEqual(['succeeded', 'succeeded']);
      expect(maximumActiveAgents).toBe(1);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('excludes a same-pull-request admission until the prior Sandbox is destroyed while unrelated work proceeds', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-same-pr-'));
    let releaseAgents: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseAgents = resolve;
    });
    const runner = createRunner({
      concurrency: 2,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot,
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec' && args.includes('--agent')) {
          await gate;
          await writeEvidenceFixture(
            args,
            options,
            finalMarkdownJsonl(undefined, 'concurrency-session'),
          );
          return {
            exitCode: 0,
            stdout: `${finalMarkdownJsonl(undefined, 'concurrency-session')}\n`,
            timedOut: false,
            truncated: false,
          };
        }
        await writeEvidenceFixture(
          args,
          options,
          finalMarkdownJsonl(undefined, 'concurrency-session'),
        );
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"concurrency-session"}]\n'
              : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const post = (job: Record<string, unknown>) =>
      runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(job),
        }),
      );

    try {
      const first = independentJob(42, 'run-same-pr-first');
      const replacement = independentJob(42, 'run-same-pr-replacement');
      const unrelated = independentJob(43, 'run-same-pr-unrelated');

      expect((await post(first)).status).toBe(202);
      expect((await post(replacement)).status).toBe(409);
      expect((await post(unrelated)).status).toBe(202);

      releaseAgents?.();
      expect((await waitForTerminal(runner, first.id)).status).toBe('succeeded');
      expect((await waitForTerminal(runner, unrelated.id)).status).toBe('succeeded');

      expect((await post(replacement)).status).toBe(202);
      expect((await waitForTerminal(runner, replacement.id)).status).toBe('succeeded');
    } finally {
      releaseAgents?.();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('admits a same-pull-request replacement in a spare slot once the old Sandbox is destroyed even while its callback is in flight', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-same-pr-callback-'));
    let callbacks = 0;
    let firstCallbackStarted!: () => void;
    const firstCallbackObserved = new Promise<void>((resolve) => {
      firstCallbackStarted = resolve;
    });
    let releaseCallback: (() => void) | undefined;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const runner = createRunner({
      concurrency: 2,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async () => {
        callbacks += 1;
        if (callbacks === 1) {
          firstCallbackStarted();
          await callbackGate;
        }
        return new Response(null, { status: 202 });
      },
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(
          args,
          options,
          finalMarkdownJsonl(undefined, 'concurrency-session'),
        );
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"concurrency-session"}]\n'
              : options.captureStdout === true
                ? `${finalMarkdownJsonl(undefined, 'concurrency-session')}\n`
                : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const post = (job: Record<string, unknown>) =>
      runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(job),
        }),
      );

    try {
      const first = independentJob(42, 'run-same-pr-cleaned-first');
      expect((await post(first)).status).toBe(202);
      await Promise.race([
        firstCallbackObserved,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('first callback was not reached')), 2_000),
        ),
      ]);

      const replacement = independentJob(42, 'run-same-pr-cleaned-replacement');
      expect((await post(replacement)).status).toBe(202);

      releaseCallback?.();
      expect((await waitForTerminal(runner, first.id)).status).toBe('succeeded');
      expect((await waitForTerminal(runner, replacement.id)).status).toBe('succeeded');
    } finally {
      releaseCallback?.();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('keeps blocking a same-pull-request admission after a terminal failed cleanup while unrelated work proceeds', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-terminal-cleanup-'));
    const failing = independentJob(42, 'run-terminal-cleanup-failing');
    const replacement = independentJob(42, 'run-terminal-cleanup-replacement');
    const unrelated = independentJob(43, 'run-terminal-cleanup-unrelated');
    const runner = createRunner({
      concurrency: 2,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot,
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(
          args,
          options,
          finalMarkdownJsonl(undefined, 'concurrency-session'),
        );
        return {
          exitCode:
            args[0] === 'rm' && args[1] === '--force' && args[2] === `compte-rendu-${failing.id}`
              ? 1
              : 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"concurrency-session"}]\n'
              : options.captureStdout === true
                ? `${finalMarkdownJsonl(undefined, 'concurrency-session')}\n`
                : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const post = (job: Record<string, unknown>) =>
      runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(job),
        }),
      );

    try {
      expect((await post(failing)).status).toBe(202);
      expect(await waitForTerminal(runner, failing.id)).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });

      expect((await post(replacement)).status).toBe(409);
      expect((await post(unrelated)).status).toBe(202);
      expect((await waitForTerminal(runner, unrelated.id)).status).toBe('succeeded');
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('keeps an oversized-callback job occupying its slot until callback transport completes', async () => {
    const evidenceRoot = await mkdtemp(
      join(tmpdir(), 'compte-rendu-runner-oversized-concurrency-'),
    );
    const jobA = independentJob(42, 'run-oversized-a');
    const jobB = independentJob(43, 'run-oversized-b');
    const jobC = independentJob(44, 'run-oversized-c');
    const jobD = independentJob(45, 'run-oversized-d');
    const sandboxA = `compte-rendu-${jobA.id}`;
    const bigExport = JSON.stringify({
      info: { id: 'oversized-session', outcome: 'succeeded' },
      messages: [
        {
          type: 'assistant',
          finish: 'stop',
          parts: [{ type: 'text', text: 'x'.repeat(25 * 1024 * 1024) }],
        },
        { type: 'idle', outcome: 'succeeded' },
      ],
    });
    let callbacks = 0;
    let firstCallbackStarted!: () => void;
    const firstCallbackObserved = new Promise<void>((resolve) => {
      firstCallbackStarted = resolve;
    });
    let releaseA: (() => void) | undefined;
    const callbackGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let releaseB: (() => void) | undefined;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let releaseC: (() => void) | undefined;
    const gateC = new Promise<void>((resolve) => {
      releaseC = resolve;
    });
    let bAgentStarted!: () => void;
    const bAgentObserved = new Promise<void>((resolve) => {
      bAgentStarted = resolve;
    });
    let cAgentStarted!: () => void;
    const cAgentObserved = new Promise<void>((resolve) => {
      cAgentStarted = resolve;
    });
    const runner = createRunner({
      concurrency: 2,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async () => {
        callbacks += 1;
        if (callbacks === 1) {
          firstCallbackStarted();
          await callbackGate;
        }
        return new Response(null, { status: 202 });
      },
      process: async (_command, args, options = {}) => {
        const sandbox = args.find((value) => value.startsWith('compte-rendu-'));
        const sessionId = sandbox === sandboxA ? 'oversized-session' : 'concurrency-session';
        if (args[0] === 'exec' && args.includes('--agent')) {
          if (sandbox === `compte-rendu-${jobB.id}`) {
            bAgentStarted();
            await gateB;
          } else if (sandbox === `compte-rendu-${jobC.id}`) {
            cAgentStarted();
            await gateC;
          }
          await writeFile(
            options.stdoutFilePath!,
            `${finalMarkdownJsonl(undefined, sessionId)}\n`,
            { mode: 0o600 },
          );
          await writeFile(options.stderrFilePath!, '', { mode: 0o600 });
        }
        if (args[0] === 'cp') {
          const source = args[1];
          const destination = args[2];
          if (source.endsWith('opencode-export-oversized-session.json')) {
            await writeFile(destination, bigExport, { mode: 0o600 });
          } else if (source.includes('opencode-export-')) {
            const sessionId =
              source.match(/opencode-export-([A-Za-z0-9._:-]+)\.json$/)?.[1] ?? 'oversized-session';
            await writeFile(destination, sessionExportJson(sessionId), { mode: 0o600 });
          } else {
            await mkdir(destination, { recursive: true, mode: 0o700 });
            await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
            await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
          }
        }

        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? `[{"id":"${sessionId}"}]\n`
              : args.includes('--agent')
                ? `${finalMarkdownJsonl(undefined, sessionId)}\n`
                : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const post = (job: Record<string, unknown>) =>
      runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(job),
        }),
      );

    try {
      expect((await post(jobA)).status).toBe(202);
      await Promise.race([
        firstCallbackObserved,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('oversized callback was not reached')), 3_000),
        ),
      ]);

      expect((await post(jobB)).status).toBe(202);
      await bAgentObserved;
      expect((await post(jobC)).status).toBe(409);

      releaseB?.();
      expect((await waitForTerminal(runner, jobB.id)).status).toBe('succeeded');

      expect((await post(jobC)).status).toBe(202);
      await cAgentObserved;
      expect((await post(jobD)).status).toBe(409);

      releaseA?.();
      expect((await waitForTerminal(runner, jobA.id)).status).toBe('failed');
      expect((await post(jobD)).status).toBe(202);

      releaseC?.();
      expect((await waitForTerminal(runner, jobC.id)).status).toBe('succeeded');
      expect((await waitForTerminal(runner, jobD.id)).status).toBe('succeeded');
    } finally {
      releaseA?.();
      releaseB?.();
      releaseC?.();
      await Promise.all(
        [jobA, jobB, jobC, jobD].map((job) =>
          waitForTerminal(runner, job.id).catch(() => undefined),
        ),
      );
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('aborts a contradictory same-pull-request claim with a terminal callback while unrelated work progresses', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-abort-claim-'));
    const existing = independentJob(42, 'run-abort-existing');
    const contradictory = independentJob(42, 'run-abort-claim');
    const unrelated = independentJob(43, 'run-abort-unrelated');
    let allowClaims = false;
    let claims = 0;
    let clones = 0;
    const createdSandboxes: string[] = [];
    const callbackBodies: Array<{ runId: string; status: string }> = [];
    let agentsStarted = 0;
    let firstAgentStarted!: () => void;
    const firstAgentObserved = new Promise<void>((resolve) => {
      firstAgentStarted = resolve;
    });
    let releaseAgents: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseAgents = resolve;
    });
    let contradictoryCallback!: () => void;
    const contradictoryCallbackObserved = new Promise<void>((resolve) => {
      contradictoryCallback = resolve;
    });
    const runner = createRunner({
      concurrency: 2,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      evidenceRoot,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: async () => {
        if (!allowClaims) return new Response(null, { status: 204 });
        claims += 1;
        if (claims === 1) return Response.json(contradictory);
        if (claims === 2) return Response.json(unrelated);
        return new Response(null, { status: 204 });
      },
      callbackFetch: async (_input, init) => {
        const rawBody = init?.body;
        const body = JSON.parse(typeof rawBody === 'string' ? rawBody : '{}') as {
          runId: string;
          status: string;
        };
        callbackBodies.push({ runId: body.runId, status: body.status });
        if (body.runId === contradictory.runId && body.status === 'aborted') {
          contradictoryCallback();
        }
        return new Response(null, { status: 202 });
      },
      process: async (command, args, options = {}) => {
        if (command === 'git' && args.includes('clone')) clones += 1;
        if (args[0] === 'create') createdSandboxes.push(args[args.indexOf('--name') + 1]);
        if (args[0] === 'exec' && args.includes('--agent')) {
          agentsStarted += 1;
          if (agentsStarted === 1) {
            firstAgentStarted();
            await gate;
          }
          await writeEvidenceFixture(
            args,
            options,
            finalMarkdownJsonl(undefined, 'concurrency-session'),
          );
          return {
            exitCode: 0,
            stdout: `${finalMarkdownJsonl(undefined, 'concurrency-session')}\n`,
            timedOut: false,
            truncated: false,
          };
        }
        await writeEvidenceFixture(
          args,
          options,
          finalMarkdownJsonl(undefined, 'concurrency-session'),
        );
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"concurrency-session"}]\n'
              : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const post = (job: Record<string, unknown>) =>
      runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(job),
        }),
      );

    try {
      expect((await post(existing)).status).toBe(202);
      await Promise.race([
        firstAgentObserved,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('existing review did not start')), 2_000),
        ),
      ]);
      allowClaims = true;

      await Promise.race([
        contradictoryCallbackObserved,
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('no aborted callback for the contradictory claim')),
            2_000,
          ),
        ),
      ]);
      expect((await waitForTerminal(runner, unrelated.id)).status).toBe('succeeded');

      expect(createdSandboxes).not.toContain(`compte-rendu-${contradictory.id}`);
      expect(clones).toBe(2);
      expect(callbackBodies).toContainEqual({
        runId: contradictory.runId,
        status: 'aborted',
      });
    } finally {
      releaseAgents?.();
      await waitForTerminal(runner, existing.id).catch(() => undefined);
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe('Runner sandbox runtime selection', () => {
  const base = {
    authToken: 'runner-test-token',
    modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
    evidenceRoot: sharedEvidenceRoot,
    process: async (): Promise<RunnerProcessResult> => ({
      exitCode: 0,
      stdout: '',
      timedOut: false,
      truncated: false,
    }),
  };

  it('defaults to the sbx runtime when no sandbox runtime is configured', () => {
    expect(() => createRunner(base)).not.toThrow();
  });

  it('rejects an unknown sandbox runtime before claiming or admitting work', () => {
    const previous = process.env.RUNNER_SANDBOX_RUNTIME;
    try {
      process.env.RUNNER_SANDBOX_RUNTIME = 'docker';
      expect(() => createRunner(base)).toThrow(/RUNNER_SANDBOX_RUNTIME/);
    } finally {
      if (previous === undefined) delete process.env.RUNNER_SANDBOX_RUNTIME;
      else process.env.RUNNER_SANDBOX_RUNTIME = previous;
    }
  });

  it('rejects incomplete openshell configuration before claiming or admitting work', () => {
    expect(() => createRunner({ ...base, sandboxRuntime: 'openshell' })).toThrow(
      /OPENSHELL_GATEWAY/,
    );
    expect(() =>
      createRunner({
        ...base,
        sandboxRuntime: 'openshell',
        openshell: { gatewayEndpoint: 'http://127.0.0.1:18670' },
      }),
    ).toThrow(/OPENSHELL_MODEL_PROVIDER/);
    expect(() =>
      createRunner({
        ...base,
        sandboxRuntime: 'openshell',
        openshell: {
          gatewayEndpoint: 'http://127.0.0.1:18670',
          modelProvider: 'model-provider',
        },
      }),
    ).toThrow(/OPENSHELL_IMAGE/);
    expect(() =>
      createRunner({
        ...base,
        sandboxRuntime: 'openshell',
        openshell: { gateway: 'local' },
      }),
    ).toThrow(/OPENSHELL_MODEL_PROVIDER/);
  });

  it('selects the openshell adapter for complete configuration', () => {
    for (const openshell of [
      {
        gatewayEndpoint: 'http://127.0.0.1:18670',
        modelProvider: 'model-provider',
        image: 'compte-rendu-openshell:158',
      },
      {
        gateway: 'local',
        modelProvider: 'model-provider',
        image: 'compte-rendu-openshell:158',
      },
    ]) {
      expect(() => createRunner({ ...base, sandboxRuntime: 'openshell', openshell })).not.toThrow();
    }
  });
});

describe('Runner OpenShell runtime lifecycle', () => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  const openshell = {
    gatewayEndpoint: 'http://127.0.0.1:18670',
    modelProvider: 'cr158-model',
    image: 'compte-rendu-openshell:158',
  };

  const runOpenShellReview = async (scenario: {
    runId: string;
    sandboxId?: string;
    createFails?: boolean;
    createTimesOut?: boolean;
    uploadFails?: boolean;
    providerCreateFails?: boolean;
    destroyGet: 'gone' | 'transport' | 'malformed' | 'present';
    observedId?: string;
    conflictOwner?: boolean;
    missingModelProvider?: boolean;
    pagedModelProvider?: boolean;
    malformedProviderList?: boolean;
    providerReconcileFails?: boolean;
    providerReplaced?: boolean;
  }) => {
    const resultLine = finalMarkdownJsonl(undefined, 'os-session');
    const token = 'os-read-token-must-not-be-argv';
    const commands: string[][] = [];
    const providerEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const agentResult = resultLine;
    const observedId = scenario.observedId ?? scenario.sandboxId ?? 'sbx-uuid-1';
    let deleteIssued = false;
    let sandboxExists = false;
    let createdName = '';
    let labelNonce = '';
    let providerListCalls = 0;
    let providerCreateAttempted = false;
    let createdProviderName = '';
    let createdProviderOwner = '';
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      sandboxRuntime: 'openshell',
      openshell,
      process: async (command, args, options = {}) => {
        commands.push([...args]);
        const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        const head = args.findIndex((value) => value === 'sandbox' || value === 'provider');
        const a0 = args[head];
        const a1 = args[head + 1];
        if (command === 'git') {
          if (args.includes('rev-parse')) return { ...ok, stdout: `${baseSha}\n${headSha}\n` };
          if (args.includes('merge-base')) return { ...ok, stdout: `${baseSha}\n` };
          return ok;
        }
        if (command !== 'openshell') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: `unexpected command ${command}`,
            timedOut: false,
            truncated: false,
          };
        }
        if (a0 === 'provider' && a1 === 'list') {
          providerListCalls += 1;
          if (scenario.malformedProviderList === true) {
            return { ...ok, stdout: 'not-json' };
          }
          if (scenario.providerReconcileFails === true && providerCreateAttempted === true) {
            return { ...ok, stdout: 'not-json' };
          }
          if (scenario.pagedModelProvider === true && providerListCalls === 1) {
            return {
              ...ok,
              stdout: JSON.stringify({ providers: [], next_page_token: 'page-2' }),
            };
          }
          const providers: Array<Record<string, unknown>> =
            scenario.missingModelProvider === true ? [] : [{ id: 'p-model', name: 'cr158-model' }];
          if (createdProviderName.length > 0) {
            providers.push({
              id: 'p-github',
              name: createdProviderName,
              labels: {
                'cr-job-owner':
                  scenario.providerReplaced === true ? 'foreign-owner' : createdProviderOwner,
              },
            });
          }
          return { ...ok, stdout: JSON.stringify({ providers, next_page_token: '' }) };
        }
        if (a0 === 'provider' && a1 === 'get') {
          return scenario.providerCreateFails === true
            ? {
                ...ok,
                stdout: JSON.stringify({ id: 'preexisting', name: 'cr-runner-job-test-github' }),
              }
            : {
                exitCode: 1,
                stdout: '',
                stderr: 'provider not found',
                timedOut: false,
                truncated: false,
              };
        }
        if (a0 === 'provider' && a1 === 'create') {
          providerCreateAttempted = true;
          providerEnvs.push(options.env);
          createdProviderName = args[args.indexOf('--name') + 1] ?? '';
          createdProviderOwner = (args[args.indexOf('--label') + 1] ?? '').replace(
            'cr-job-owner=',
            '',
          );
          return scenario.providerCreateFails === true
            ? {
                exitCode: 1,
                stdout: '',
                stderr: 'provider exists',
                timedOut: false,
                truncated: false,
              }
            : ok;
        }
        if (a0 === 'provider' && a1 === 'delete') return ok;
        if (a0 === 'sandbox' && a1 === 'create') {
          const memory = args[args.indexOf('--memory') + 1];
          if (memory === undefined || !/^\d+(Mi|Gi|G|M)$/.test(memory)) {
            return {
              exitCode: 1,
              stdout: '',
              stderr: 'invalid memory unit',
              timedOut: false,
              truncated: false,
            };
          }
          const requestedName = args[args.indexOf('--name') + 1] ?? '';
          if (requestedName.length === 0 || requestedName.length > 19) {
            return {
              exitCode: 1,
              stdout: '',
              stderr: 'invalid sandbox name length',
              timedOut: false,
              truncated: false,
            };
          }
          createdName = requestedName;
          labelNonce = (args[args.indexOf('--label') + 1] ?? '').replace('cr-job-owner=', '');
          if (scenario.createTimesOut === true) {
            sandboxExists = true;
            return { exitCode: 1, stdout: '', timedOut: true, truncated: false };
          }
          if (scenario.createFails === true) {
            return {
              exitCode: 1,
              stdout: '',
              stderr: 'create failed',
              timedOut: false,
              truncated: false,
            };
          }
          sandboxExists = true;
          return {
            ...ok,
            stdout: JSON.stringify({
              id: observedId,
              name: createdName,
              labels: { 'cr-job-owner': labelNonce },
            }),
          };
        }
        if (a0 === 'sandbox' && a1 === 'get') {
          if (!deleteIssued && !sandboxExists) {
            return {
              exitCode: 1,
              stdout: '',
              stderr: 'message sandbox not found',
              timedOut: false,
              truncated: false,
            };
          }
          if (deleteIssued) {
            if (scenario.destroyGet === 'transport') {
              return {
                exitCode: 1,
                stdout: '',
                stderr: 'connection refused',
                timedOut: false,
                truncated: false,
              };
            }
            if (scenario.destroyGet === 'malformed') {
              return { ...ok, stdout: '{"unexpected":true}' };
            }
            if (scenario.destroyGet === 'gone') {
              return {
                exitCode: 1,
                stdout: '',
                stderr: 'message sandbox not found',
                timedOut: false,
                truncated: false,
              };
            }
          }
          return {
            ...ok,
            stdout: JSON.stringify({
              id: observedId,
              name: createdName,
              labels: {
                'cr-job-owner': scenario.conflictOwner === true ? 'foreign-owner' : labelNonce,
              },
            }),
          };
        }
        if (a0 === 'sandbox' && a1 === 'delete') {
          deleteIssued = true;
          sandboxExists = false;
          return ok;
        }
        if (a0 === 'sandbox' && a1 === 'upload') {
          return scenario.uploadFails === true
            ? {
                exitCode: 1,
                stdout: '',
                stderr: 'upload failed',
                timedOut: false,
                truncated: false,
              }
            : ok;
        }
        if (a0 === 'sandbox' && a1 === 'download') {
          const source = args[head + 3];
          const destination = args[head + 4];
          if (source.endsWith('.json')) {
            await writeFile(destination, sessionExportJson('os-session'), {
              mode: 0o600,
            });
          } else {
            await mkdir(destination, { recursive: true, mode: 0o700 });
            await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
            await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
          }
          return ok;
        }
        if (a0 === 'sandbox' && a1 === 'exec') {
          if (args.includes('--agent')) {
            await writeFile(options.stdoutFilePath!, `${agentResult}\n`, { mode: 0o600 });
            await writeFile(options.stderrFilePath!, 'agent stderr\n', { mode: 0o600 });
            return { ...ok, stdout: agentResult };
          }
          if (args.includes('session')) return { ...ok, stdout: '[{"id":"os-session"}]' };
          return ok;
        }
        return ok;
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: { authorization: 'Bearer runner-test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: scenario.runId,
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: token,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    const terminal = await waitForTerminal(runner, id);
    let manifest: Record<string, unknown> | undefined;
    if (terminal.evidenceId !== undefined) {
      manifest = JSON.parse(
        await readFile(join(sharedEvidenceRoot, terminal.evidenceId, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
    }
    return { terminal, manifest, commands, providerEnvs, token };
  };

  it('runs a review through the OpenShell adapter with real identity and job-owned provider cleanup', async () => {
    const run = await runOpenShellReview({ runId: 'run-158-success', destroyGet: 'gone' });
    expect(run.terminal).toMatchObject({
      status: 'succeeded',
      sandbox: { cleanup: 'destroyed' },
    });
    expect(run.manifest).toMatchObject({
      runtime: 'openshell',
      image: 'compte-rendu-openshell:158',
      sandboxId: 'sbx-uuid-1',
    });
    const flat = run.commands.map((args) => args.join(' '));
    expect(flat.join(' ')).not.toContain(run.token);
    const createArgs = run.commands.find(
      (args) => args.includes('sandbox') && args.includes('create') && args.includes('--from'),
    );
    expect(createArgs).toEqual(
      expect.arrayContaining(['--from', 'compte-rendu-openshell:158', '--provider', 'cr158-model']),
    );
    const agentExec = run.commands.find(
      (args) => args.includes('sandbox') && args.includes('exec') && args.includes('--agent'),
    );
    expect(agentExec).toEqual(expect.arrayContaining(['--workdir', '/workspace/checkout']));
    const providerCreate = run.commands.find(
      (args) => args.includes('provider') && args.includes('create'),
    );
    expect(providerCreate).toEqual(
      expect.arrayContaining([
        '--name',
        'cr-runner-job-test-github',
        '--type',
        'cr-github',
        '--credential',
        'GITHUB_TOKEN',
      ]),
    );
    const providerDelete = run.commands.find(
      (args) => args.includes('provider') && args.includes('delete'),
    );
    expect(providerDelete).toEqual(expect.arrayContaining(['cr-runner-job-test-github']));
    expect(run.providerEnvs[0]?.GITHUB_TOKEN).toBe(run.token);
  });

  it('does not release cleanup when OpenShell deletion cannot be confirmed', async () => {
    for (const destroyGet of ['transport', 'malformed'] as const) {
      const run = await runOpenShellReview({
        runId: `run-158-${destroyGet}`,
        destroyGet,
      });
      expect(run.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'cleanup' },
        sandbox: { cleanup: 'failed' },
      });
    }

    const previous = process.env.OPENSHELL_DELETE_TIMEOUT_MS;
    try {
      process.env.OPENSHELL_DELETE_TIMEOUT_MS = '100';
      const run = await runOpenShellReview({ runId: 'run-158-present', destroyGet: 'present' });
      expect(run.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'cleanup' },
        sandbox: { cleanup: 'failed' },
      });
    } finally {
      if (previous === undefined) delete process.env.OPENSHELL_DELETE_TIMEOUT_MS;
      else process.env.OPENSHELL_DELETE_TIMEOUT_MS = previous;
    }
  });

  it('archives partial OpenShell evidence and confirms cleanup after a post-create setup failure', async () => {
    const run = await runOpenShellReview({
      runId: 'run-158-partial',
      destroyGet: 'gone',
      uploadFails: true,
    });
    expect(run.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'agent' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(run.terminal.evidenceId).toBeDefined();
    expect(run.manifest).toMatchObject({ runtime: 'openshell', sandboxId: 'sbx-uuid-1' });
  });

  it('reserves only one claim when two completions release together', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compte-rendu-claim-race-'));
    let releaseClones: () => void = () => {};
    const cloneGate = new Promise<void>((resolve) => {
      releaseClones = resolve;
    });
    let startupDone = false;
    let measure = false;
    let pending = 0;
    let peak = 0;
    const claimReleases: Array<() => void> = [];
    const callbackReleases: Array<() => void> = [];
    const runner = createRunner({
      authToken: 'test-auth',
      modelSecretCommand: 'fixture-resolver',
      modelConfig: standardModelConfig,
      sandboxRuntime: 'sbx',
      concurrency: 2,
      evidenceRoot: root,
      claimUrl: 'http://claim.test/runner-claim',
      claimIntervalMs: 1_000_000_000,
      claimTimeoutMs: 1_000,
      callbackUrl: 'http://callback.test/runner-callback',
      callbackToken: 'test-callback',
      claimFetch: async () => {
        if (!measure) {
          startupDone = true;
          return new Response(null, { status: 204 });
        }
        pending += 1;
        peak = Math.max(peak, pending);
        return new Promise<Response>((resolve) =>
          claimReleases.push(() => {
            pending -= 1;
            resolve(new Response(null, { status: 204 }));
          }),
        );
      },
      callbackFetch: async () =>
        new Promise<Response>((resolve) =>
          callbackReleases.push(() => resolve(new Response(null, { status: 202 }))),
        ),
      process: async (_command, args) => {
        if (args.includes('clone')) await cloneGate;
        return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
      },
    });
    try {
      for (let i = 0; i < 200 && !startupDone; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(startupDone).toBe(true);
      const post = (n: number) =>
        runner.handle(
          new Request('http://runner/jobs', {
            method: 'POST',
            headers: { authorization: 'Bearer test-auth', 'content-type': 'application/json' },
            body: JSON.stringify({
              id: `claims-${n}`,
              runId: `claims-${n}`,
              attempt: 1,
              repositoryName: 'acme/repo',
              pullRequestNumber: n,
              repositoryUrl: 'https://github.com/acme/repo.git',
              repositoryReadToken: 'fixture-token',
              baseSha: '1'.repeat(40),
              headSha: '2'.repeat(40),
            }),
          }),
        );
      const admissions = await Promise.all([post(1), post(2)]);
      expect(admissions.map((response) => response.status)).toEqual([202, 202]);
      releaseClones();
      for (let i = 0; i < 200 && callbackReleases.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(callbackReleases).toHaveLength(2);
      measure = true;
      for (const release of callbackReleases) release();
      for (let i = 0; i < 200 && peak < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(peak).toBe(1);
    } finally {
      for (const release of claimReleases) release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed and keeps an unresolved provider after an ambiguous create', async () => {
    const run = await runOpenShellReview({
      runId: 'run-158-ambiguous-provider',
      destroyGet: 'gone',
      providerCreateFails: true,
      providerReconcileFails: true,
    });
    expect(run.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
    expect(run.commands.some((args) => args.includes('provider') && args.includes('delete'))).toBe(
      false,
    );
  });

  it('never deletes a same-name provider replaced by a foreign record', async () => {
    const run = await runOpenShellReview({
      runId: 'run-158-provider-replaced',
      destroyGet: 'gone',
      providerReplaced: true,
    });
    expect(run.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
    expect(run.commands.some((args) => args.includes('provider') && args.includes('delete'))).toBe(
      false,
    );
  });

  it('accepts a model provider found on a later provider-list page', async () => {
    const run = await runOpenShellReview({
      runId: 'run-158-paged',
      destroyGet: 'gone',
      pagedModelProvider: true,
    });
    expect(run.terminal.status).toBe('succeeded');
    expect(run.terminal).toMatchObject({ sandbox: { cleanup: 'destroyed' } });
  });

  it('does not admit when the provider list is malformed', async () => {
    let claims = 0;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      sandboxRuntime: 'openshell',
      openshell,
      claimUrl: 'https://ingress.test/runner-claim',
      claimFetch: async () => {
        claims += 1;
        return new Response(null, { status: 204 });
      },
      claimIntervalMs: 1,
      process: async () => ({
        exitCode: 0,
        stdout: 'not-json',
        timedOut: false,
        truncated: false,
      }),
    });
    const response = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: { authorization: 'Bearer runner-test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-158-malformed-preflight',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
        }),
      }),
    );
    expect(response.status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claims).toBe(0);
  });

  it('does not claim or admit when the configured model provider is missing', async () => {
    let claims = 0;
    let admits = 0;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      sandboxRuntime: 'openshell',
      openshell,
      claimUrl: 'https://ingress.test/runner-claim',
      claimFetch: async () => {
        claims += 1;
        return new Response(null, { status: 204 });
      },
      claimIntervalMs: 1,
      process: async (command, args) => {
        const a1 = args[1];
        if (args.includes('provider') && a1 === 'list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ providers: [], next_page_token: '' }),
            timedOut: false,
            truncated: false,
          };
        }
        if (args.includes('provider') && a1 === 'create') {
          admits += 1;
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
      },
    });
    const response = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: { authorization: 'Bearer runner-test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-158-preflight',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
        }),
      }),
    );
    expect(response.status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claims).toBe(0);
    expect(admits).toBe(0);
  });

  it('reconciles a timed-out create that actually created the labelled sandbox', async () => {
    const run = await runOpenShellReview({
      runId: 'run-158-timeout-created',
      destroyGet: 'gone',
      createTimesOut: true,
    });
    expect(run.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'agent', cause: 'timeout' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(run.terminal.evidenceId).toBeDefined();
  });

  it('refuses to delete a same-name sandbox owned by another nonce', async () => {
    const run = await runOpenShellReview({
      runId: 'run-158-conflict',
      destroyGet: 'gone',
      conflictOwner: true,
    });
    expect(run.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
    expect(run.commands.some((args) => args.includes('sandbox') && args.includes('delete'))).toBe(
      false,
    );
  });

  it('preserves the create timeout cause and still confirms cleanup', async () => {
    const run = await runOpenShellReview({
      runId: 'run-158-timeout',
      destroyGet: 'gone',
      createTimesOut: true,
    });
    expect(run.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'agent', cause: 'timeout' },
      sandbox: { cleanup: 'destroyed' },
    });
  });
});

describe('Runner settings reload', () => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  let prSeed = 5000;
  const prById = new Map<string, number>();
  const prFor = (id: string) => {
    const existing = prById.get(id);
    if (existing !== undefined) return existing;
    prSeed += 1;
    prById.set(id, prSeed);
    return prSeed;
  };
  const jobBody = (id: string) =>
    JSON.stringify({
      ...runnerJobFields,
      id,
      runId: id,
      attempt: 1,
      pullRequestNumber: prFor(id),
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    });
  const auth = { authorization: 'Bearer runner-test-token' };
  const get = async (runner: ReturnType<typeof createProductionRunner>, id: string) =>
    (
      await runner.handle(new Request(`http://runner/jobs/${id}`, { headers: auth }))
    ).json() as Promise<{
      status: string;
    }>;
  const post = (runner: ReturnType<typeof createProductionRunner>, id: string) =>
    runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: jobBody(id),
      }),
    );
  const writeRaw = async (dir: string, content: string) => {
    const tmp = join(dir, `settings.${crypto.randomUUID()}.tmp`);
    await writeFile(tmp, content);
    await rename(tmp, join(dir, 'settings.toml'));
  };
  const writeCap = (dir: string, value: number) => writeRaw(dir, `concurrency = ${value}\n`);
  const captureLogs = () => {
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    return {
      ignored: () => logs.filter((line) => line.includes('keeping last valid settings')).length,
      reloadedTo: (cap: number) =>
        logs.some((line) => line.includes(`runner settings reloaded concurrency=${cap}`)),
      restore: () => spy.mockRestore(),
    };
  };
  const startFixture = async (initialCap: number, extra: Record<string, unknown>) => {
    const dir = await mkdtemp(join(tmpdir(), 'compte-rendu-settings-'));
    const file = join(dir, 'settings.toml');
    await writeFile(file, `concurrency = ${initialCap}\n`);
    const callbackReleases = new Map<string, () => void>();
    let disposed = false;
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'fixture-resolver',
      modelConfig: standardModelConfig,
      sandboxRuntime: 'sbx',
      evidenceRoot: sharedEvidenceRoot,
      settingsFile: file,
      claimUrl: 'https://ingress.test/runner-claim',
      claimTimeoutMs: 1_000_000,
      claimIntervalMs: 1_000_000,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'test-callback',
      callbackTimeoutMs: 1_000_000,
      process: async (): Promise<RunnerProcessResult> => ({
        exitCode: 1,
        stdout: '',
        timedOut: false,
        truncated: false,
      }),
      callbackFetch: async (_url, init) => {
        if (disposed) return new Response(null, { status: 202 });
        const id = (JSON.parse(init?.body as string) as { id: string }).id;
        return new Promise<Response>((resolve) =>
          callbackReleases.set(id, () => resolve(new Response(null, { status: 202 }))),
        );
      },
      ...extra,
    });
    const releaseCallback = (id: string) => {
      callbackReleases.get(id)?.();
      callbackReleases.delete(id);
    };
    const releaseCallbacks = () => {
      for (const id of callbackReleases.keys()) releaseCallback(id);
    };
    const close = async () => {
      disposed = true;
      releaseCallbacks();
      await runner.close();
      await rm(dir, { recursive: true, force: true });
    };
    return { dir, file, runner, callbackReleases, releaseCallback, releaseCallbacks, close };
  };

  it('rejects an initial missing or invalid settings file at startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'compte-rendu-settings-'));
    const valid = join(dir, 'valid.toml');
    const invalid = join(dir, 'invalid.toml');
    const missing = join(dir, 'missing.toml');
    await writeFile(valid, 'concurrency = 1\n');
    await writeFile(invalid, 'concurrency = 0\n');
    const base = (settingsFile: string) => ({
      authToken: 'runner-test-token',
      modelSecretCommand: 'fixture-resolver',
      evidenceRoot: sharedEvidenceRoot,
      settingsFile,
      claimFetch: async () => new Response(null, { status: 204 }),
    });
    try {
      expect(() => createRunner(base(invalid))).toThrow('invalid runner settings file');
      expect(() => createRunner(base(missing))).toThrow('invalid runner settings file');
      const runner = createRunner(base(valid));
      await runner.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('delivers a second claimed job when the cap rises while the runner is full', async () => {
    const bodies = [jobBody('settings-raise-a'), jobBody('settings-raise-b')];
    let claims = 0;
    const h = await startFixture(1, {
      claimFetch: async () => {
        const body = bodies[claims++];
        return body === undefined
          ? new Response(null, { status: 204 })
          : new Response(body, { status: 200 });
      },
    });
    try {
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-raise-a')).status).toBe('running');
      });
      expect(claims).toBe(1);
      await writeCap(h.dir, 2);
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-raise-b')).status).toBe('running');
      });
      expect(claims).toBe(2);
      await vi.waitFor(() => {
        expect(h.callbackReleases.has('settings-raise-a')).toBe(true);
        expect(h.callbackReleases.has('settings-raise-b')).toBe(true);
      });
    } finally {
      await h.close();
    }
  });

  it('admits a reserved claim held across a cap lowering, keeps it, and refuses new work', async () => {
    let claims = 0;
    let releaseHeldClaim: (() => void) | undefined;
    const h = await startFixture(3, {
      claimIntervalMs: 20,
      claimFetch: async () => {
        claims += 1;
        if (claims === 1) return new Response(jobBody('settings-lower-a'), { status: 200 });
        if (claims === 2) {
          return new Promise<Response>((resolve) => {
            releaseHeldClaim = () =>
              resolve(new Response(jobBody('settings-lower-b'), { status: 200 }));
          });
        }
        return new Response(null, { status: 204 });
      },
    });
    const probeFresh = async () => {
      const id = `settings-lower-probe-${crypto.randomUUID()}`;
      const response = await post(h.runner, id);
      if (response.status === 409) return true;
      await vi.waitFor(() => expect(h.callbackReleases.has(id)).toBe(true));
      h.releaseCallback(id);
      await vi.waitFor(async () => {
        expect((await get(h.runner, id)).status).not.toBe('running');
      });
      return false;
    };
    try {
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lower-a')).status).toBe('running');
      });
      await vi.waitFor(() => expect(claims).toBeGreaterThanOrEqual(2));
      await writeCap(h.dir, 1);
      await vi.waitFor(async () => expect(await probeFresh()).toBe(true));
      releaseHeldClaim?.();
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lower-b')).status).toBe('running');
      });
      expect((await get(h.runner, 'settings-lower-a')).status).toBe('running');
      expect((await post(h.runner, 'settings-lower-after')).status).toBe(409);
      await vi.waitFor(() => expect(h.callbackReleases.size).toBe(2));
      h.releaseCallbacks();
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lower-b')).status).not.toBe('running');
      });
      expect((await get(h.runner, 'settings-lower-b')).status).not.toBe('aborted');
    } finally {
      await h.close();
    }
  });

  it('keeps the last valid cap across invalid, deletion, and applies an atomic recreation', async () => {
    const logs = captureLogs();
    const h = await startFixture(2, {
      claimFetch: async () => new Response(null, { status: 204 }),
    });
    try {
      expect((await post(h.runner, 'settings-lastgood-a')).status).toBe(202);
      expect((await post(h.runner, 'settings-lastgood-b')).status).toBe(202);
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lastgood-a')).status).toBe('running');
        expect((await get(h.runner, 'settings-lastgood-b')).status).toBe('running');
      });
      await vi.waitFor(() => expect(h.callbackReleases.size).toBe(2));
      expect((await post(h.runner, 'settings-lastgood-c')).status).toBe(409);
      await writeRaw(h.dir, 'concurrency = 0\n');
      await vi.waitFor(() => expect(logs.ignored()).toBeGreaterThanOrEqual(1));
      await writeRaw(h.dir, 'concurrency = "two"\nnot = toml =\n');
      await vi.waitFor(() => expect(logs.ignored()).toBeGreaterThanOrEqual(2));
      expect((await post(h.runner, 'settings-lastgood-c')).status).toBe(409);
      await rm(h.file, { force: true });
      await vi.waitFor(() => expect(logs.ignored()).toBeGreaterThanOrEqual(3));
      expect((await get(h.runner, 'settings-lastgood-a')).status).toBe('running');
      h.releaseCallback('settings-lastgood-a');
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lastgood-a')).status).not.toBe('running');
      });
      expect((await post(h.runner, 'settings-lastgood-d')).status).toBe(202);
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lastgood-d')).status).toBe('running');
      });
      expect((await post(h.runner, 'settings-lastgood-e')).status).toBe(409);
      await writeCap(h.dir, 3);
      await vi.waitFor(() => expect(logs.reloadedTo(3)).toBe(true));
      await vi.waitFor(async () => {
        expect((await post(h.runner, 'settings-lastgood-f')).status).toBe(202);
      });
    } finally {
      logs.restore();
      await h.close();
    }
  });

  it('serializes simultaneous completions and a reload into a single in-flight claim', async () => {
    const logs = captureLogs();
    let claims = 0;
    let pending = 0;
    let peak = 0;
    const heldClaims: Array<() => void> = [];
    const bodies = [jobBody('settings-race-a'), jobBody('settings-race-b')];
    const h = await startFixture(2, {
      claimIntervalMs: 1,
      claimFetch: async () => {
        claims += 1;
        pending += 1;
        peak = Math.max(peak, pending);
        if (claims <= 2) {
          pending -= 1;
          return new Response(bodies[claims - 1], { status: 200 });
        }
        return new Promise<Response>((resolve) =>
          heldClaims.push(() => {
            pending -= 1;
            resolve(new Response(null, { status: 204 }));
          }),
        );
      },
    });
    try {
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-race-a')).status).toBe('running');
        expect((await get(h.runner, 'settings-race-b')).status).toBe('running');
      });
      expect(h.callbackReleases.size).toBe(2);
      const reload = writeCap(h.dir, 3);
      h.releaseCallbacks();
      await reload;
      await vi.waitFor(() => expect(logs.reloadedTo(3)).toBe(true));
      await vi.waitFor(() => expect(claims).toBeGreaterThanOrEqual(3));
      expect(peak).toBe(1);
    } finally {
      logs.restore();
      for (const release of heldClaims.splice(0)) release();
      await h.close();
    }
  });
});

describe('Runner persisted lifecycle reporting', () => {
  it('keeps cleanup and terminal delivery independent of a stalled progress request', async () => {
    const reports: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const terminals: unknown[] = [];
    let progressSignal: AbortSignal | null | undefined;
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: '/usr/bin/false',
      evidenceRoot: sharedEvidenceRoot,
      progressFetch: async (url, init) => {
        progressSignal = init?.signal;
        reports.push({
          url: new Request(url, init).url,
          authorization: new Headers(init?.headers).get('authorization'),
          body: await new Request('https://ingress.test', init).json(),
        });
        return new Promise<Response>(() => {});
      },
      callbackFetch: async (_url, init) => {
        terminals.push(await new Request('https://ingress.test', init).json());
        return new Response(null, { status: 202 });
      },
      process: async () => ({ exitCode: 1, stdout: '', timedOut: false, truncated: false }),
    });
    try {
      const response = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...runnerJobFields,
            id: 'progress-stalled',
            runId: 'progress-stalled-run',
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha: '1'.repeat(40),
            headSha: '2'.repeat(40),
          }),
        }),
      );
      expect(response.status).toBe(202);
      await expect(waitForTerminal(runner, 'progress-stalled')).resolves.toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'destroyed' },
      });
      expect(reports).toEqual([
        {
          url: 'https://ingress.test/runner-progress',
          authorization: 'Bearer callback-token',
          body: {
            id: 'progress-stalled',
            runId: 'progress-stalled-run',
            attempt: 1,
            sequence: 1,
            stage: 'checkout',
            milestones: [{ stage: 'checkout', startedAt: expect.any(String) }],
          },
        },
      ]);
      expect(terminals).toEqual([
        expect.objectContaining({
          failure: { reason: 'checkout' },
          lifecycle: {
            sequence: 2,
            stage: 'cleanup',
            milestones: [
              { stage: 'checkout', startedAt: expect.any(String) },
              { stage: 'cleanup', startedAt: expect.any(String) },
            ],
          },
        }),
      ]);
      expect(progressSignal?.aborted).toBe(true);
    } finally {
      await runner.close();
    }
  });
});

describe('Runner lifecycle recovery', () => {
  it('retains all execution milestones in the terminal callback when progress transport fails', async () => {
    const callbacks: Request[] = [];
    const reports: unknown[] = [];
    const scenario = await runAgentScenario({
      runId: 'run-progress-complete',
      output: finalMarkdownJsonl(),
      callbackRequests: callbacks,
      progressFetch: async (_url, init) => {
        reports.push(await new Request('https://ingress.test', init).json());
        throw new Error('offline');
      },
    });
    expect(scenario.terminal).toMatchObject({
      status: 'succeeded',
      sandbox: { cleanup: 'destroyed' },
    });
    expect(callbacks).toHaveLength(1);
    const callback = await callbacks[0].json();
    expect(callback.lifecycle).toEqual({
      sequence: 5,
      stage: 'cleanup',
      milestones: [
        { stage: 'checkout', startedAt: expect.any(String) },
        { stage: 'sandbox', startedAt: expect.any(String) },
        { stage: 'agent', startedAt: expect.any(String) },
        { stage: 'evidence', startedAt: expect.any(String) },
        { stage: 'cleanup', startedAt: expect.any(String) },
      ],
    });
    expect(reports).toContainEqual(expect.objectContaining({ stage: 'agent' }));
    expect(JSON.stringify(reports)).not.toContain('github-read-token');
    expect(JSON.stringify(reports)).not.toContain('acme/reviewed');
  });
});

describe('Runner progress coalescing', () => {
  it('sends the newest cumulative stage after a slow report without parallel delivery', async () => {
    let releaseProgress = () => {};
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    let releaseAgent = () => {};
    const agentGate = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    let agentStarted = false;
    let active = 0;
    let peak = 0;
    const reports: Array<{
      stage: string;
      milestones: Array<{ stage: string; startedAt: string }>;
    }> = [];
    const pending = runAgentScenario({
      runId: 'run-progress-coalescing',
      output: finalMarkdownJsonl(),
      agentGate,
      onAgentStart: () => {
        agentStarted = true;
      },
      progressFetch: async (_url, init) => {
        active += 1;
        peak = Math.max(peak, active);
        const report = await new Request('https://ingress.test', init).json();
        reports.push(report);
        try {
          if (report.stage === 'checkout') await progressGate;
        } finally {
          active -= 1;
        }
        return new Response(null, { status: 202 });
      },
    });
    try {
      await vi.waitFor(() => expect(agentStarted).toBe(true));
      expect(reports.map((report) => report.stage)).toEqual(['checkout']);
      releaseProgress();
      await vi.waitFor(() =>
        expect(reports.map((report) => report.stage)).toEqual(['checkout', 'agent']),
      );
      expect(reports[1].milestones).toEqual([
        reports[0].milestones[0],
        { stage: 'sandbox', startedAt: expect.any(String) },
        { stage: 'agent', startedAt: expect.any(String) },
      ]);
      releaseAgent();
      expect((await pending).terminal.status).toBe('succeeded');
      expect(peak).toBe(1);
    } finally {
      releaseProgress();
      releaseAgent();
      await pending;
    }
  });
});

describe('Runner progress response disposal', () => {
  it('cancels an unread progress body without holding terminal delivery', async () => {
    let cancelled = false;
    let signal: AbortSignal | null | undefined;
    const callbacks: Request[] = [];
    const result = await runAgentScenario({
      runId: 'run-progress-response-body',
      output: finalMarkdownJsonl(),
      callbackRequests: callbacks,
      progressFetch: async (_url, init) => {
        signal = init?.signal;
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
              return new Promise<void>(() => {});
            },
          }),
        );
      },
    });
    expect(result.terminal.status).toBe('succeeded');
    expect(callbacks).toHaveLength(1);
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});

describe('Runner LLM service mode', () => {
  it('never substitutes the legacy single reviewer for a configured multi-model review', async () => {
    const result = await runAgentScenario({
      runId: 'configured-review-is-not-single-review',
      output: finalMarkdownJsonl(),
      reviewConfiguration: {
        revision: 1,
        selection: { reviewers: ['deepseek-review', 'step-review'], synthesis: 'deepseek-review' },
      },
    });
    expect(result.terminal).toMatchObject({ status: 'failed', sandbox: { cleanup: 'destroyed' } });
    expect(result.terminal).not.toHaveProperty('result');
  });
  it.each([
    'https://models.example/v1',
    'http://localhost:8090/v1',
    'http://host.docker.internal:8090/other',
  ])('rejects a service endpoint outside the supported local transport: %s', (baseUrl) => {
    expect(() =>
      createRunner({
        llmServiceSocket: '/tmp/control.sock',
        modelConfig: JSON.stringify({
          id: 'opencode-go/review',
          baseUrl,
          definition: { name: 'Review' },
        }),
      }),
    ).toThrow();
  });
  it('rejects a relative control socket and OpenShell service mode before admission', () => {
    expect(() => createRunner({ llmServiceSocket: 'control.sock' })).toThrow(
      'absolute Unix socket',
    );
    expect(() =>
      createRunner({
        llmServiceSocket: '/tmp/control.sock',
        sandboxRuntime: 'openshell',
        openshell: { gateway: 'review', modelProvider: 'review', image: 'review:test' },
      }),
    ).toThrow('does not support');
  });

  it('issues a job grant, injects it through the sbx token file, revokes it, and leaves no usable token behind', async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), 'cr-llm-control-'));
    const socketPath = join(controlRoot, 'control.sock');
    const issued: Array<{ jobId: string; routes: string[]; token: string }> = [];
    const revoked: string[] = [];
    const active = new Map<string, string>();
    let counter = 0;

    const unixPost = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const body = JSON.stringify(payload);
        const call = request(
          {
            socketPath,
            path,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': String(new TextEncoder().encode(body).byteLength),
              ...headers,
            },
          },
          async (response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of response) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          },
        );
        call.on('error', reject);
        call.end(body);
      });

    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (incoming.method === 'POST' && incoming.url === '/grants') {
        const jobId = String(body.jobId);
        const routes = body.routes as string[];
        const token = `grant-token-${(counter += 1)}`;
        active.set(token, jobId);
        issued.push({ jobId, routes, token });
        outgoing.writeHead(201, { 'content-type': 'application/json' });
        outgoing.end(
          JSON.stringify({
            token,
            expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          }),
        );
        return;
      }
      if (incoming.method === 'POST' && incoming.url === '/grants/revoke') {
        const jobId = String(body.jobId);
        revoked.push(jobId);
        for (const [token, owner] of active) if (owner === jobId) active.delete(token);
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      if (incoming.method === 'POST' && incoming.url === '/v1/chat/completions') {
        const authorization = incoming.headers.authorization;
        const token =
          typeof authorization === 'string' ? authorization.replace(/^Bearer /, '') : '';
        outgoing.writeHead(active.has(token) ? 200 : 401, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ usable: active.has(token) }));
        return;
      }
      outgoing.writeHead(404);
      outgoing.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    try {
      const serviceModelConfig = JSON.stringify({
        id: 'opencode-go/deepseek-review',
        baseUrl: 'http://host.docker.internal:32773/v1',
        definition: {
          name: 'DeepSeek Review',
          reasoning: true,
          limit: { context: 1000000, output: 384000 },
        },
      });
      let injectedToken = '';
      let usableDuringReview = false;
      const scenario = await runAgentScenario({
        runId: 'run-llm-service-success',
        output: finalMarkdownJsonl(),
        callbackRequests: [],
        modelConfig: serviceModelConfig,
        llmServiceSocket: socketPath,
        onModelSecret: async (args) => {
          const command = args[args.indexOf('--command') + 1];
          const path = command.slice("/usr/bin/cat '".length, -1);
          injectedToken = await readFile(path, 'utf8');
        },
        onAgentStart: async () => {
          usableDuringReview =
            (
              await unixPost(
                '/v1/chat/completions',
                {},
                { authorization: `Bearer ${injectedToken}` },
              )
            ).status === 200;
        },
      });

      expect(scenario.terminal).toMatchObject({
        status: 'succeeded',
        sandbox: { cleanup: 'destroyed' },
      });
      const jobId = runnerJobFields.id;
      expect(usableDuringReview).toBe(true);
      expect(issued).toHaveLength(1);
      expect(issued[0]).toMatchObject({ jobId, routes: ['deepseek-review'] });
      expect(revoked).toEqual([jobId]);

      const token = issued[0].token;
      const secretArgs = scenario.secretArgs ?? [];
      const command = secretArgs[secretArgs.indexOf('--command') + 1];
      expect(command).toMatch(/^\/usr\/bin\/cat '/);
      expect(secretArgs[secretArgs.indexOf('--host') + 1]).toBe('localhost');
      const tokenPath = command.slice("/usr/bin/cat '".length, -1);
      expect(command).not.toContain(token);
      expect((scenario.createArgs ?? []).join(' ')).not.toContain(token);
      expect((scenario.agentArgs ?? []).join(' ')).not.toContain(token);

      const evidence = join(sharedEvidenceRoot, scenario.terminal.evidenceId as string);
      expect(await readTextTree(evidence)).not.toContain(token);
      const tokenFileExists = await stat(tokenPath).then(
        () => true,
        () => false,
      );
      expect(tokenFileExists).toBe(false);

      const inference = await unixPost(
        '/v1/chat/completions',
        {},
        {
          authorization: `Bearer ${token}`,
        },
      );
      expect(inference.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(controlRoot, { recursive: true, force: true });
    }
  });
});

describe('Runner LLM token output', () => {
  it('does not publish or retain a review that unexpectedly contains its host grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-llm-leak-'));
    const socketPath = join(root, 'control.sock');
    const token = 'unexpected-host-grant-value';
    const server = createServer((incoming, outgoing) => {
      outgoing.writeHead(incoming.url === '/grants' ? 201 : 204, {
        'content-type': 'application/json',
      });
      outgoing.end(
        incoming.url === '/grants'
          ? JSON.stringify({ token, expiresAt: new Date(Date.now() + 7200000).toISOString() })
          : undefined,
      );
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const callbacks: Request[] = [];
    try {
      const scenario = await runAgentScenario({
        runId: 'run-llm-leaked-review',
        output: finalMarkdownJsonl(`## Review:\n${token}`),
        sessionExport: JSON.stringify({
          ...JSON.parse(sessionExportJson('scenario-session')),
          diagnostic: token,
        }),
        callbackRequests: callbacks,
        modelConfig: JSON.stringify({
          id: 'opencode-go/deepseek-review',
          baseUrl: 'http://host.docker.internal:18089/v1',
          definition: { name: 'Review' },
        }),
        llmServiceSocket: socketPath,
      });
      expect(scenario.terminal).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'destroyed' },
      });
      expect(scenario.terminal).not.toHaveProperty('result');
      expect(callbacks).toHaveLength(1);
      const callback = await callbacks[0].json();
      expect(callback).toMatchObject({ status: 'failed' });
      expect(callback.result).toBeUndefined();
      expect(JSON.stringify(callback)).not.toContain(token);
      expect(
        Buffer.from(callback.evidence.opencodeExport.content.content, 'base64').toString('utf8'),
      ).not.toContain(token);
      expect(
        await readTextTree(join(sharedEvidenceRoot, scenario.terminal.evidenceId as string)),
      ).not.toContain(token);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Runner LLM lifecycle failures', () => {
  const modelConfig = JSON.stringify({
    id: 'opencode-go/deepseek-review',
    baseUrl: 'http://host.docker.internal:18089/v1',
    definition: { name: 'Review' },
  });
  const fixture = async (issue: 'normal' | 'malformed' | 'short' = 'normal') => {
    const root = await mkdtemp(join(tmpdir(), 'cr-llm-life-'));
    const socket = join(root, 'control.sock');
    const token = 'lifecycle-test-grant';
    let usable = false;
    let rejectRevoke = false;
    const server = createServer(async (incoming, outgoing) => {
      for await (const _chunk of incoming) {
        /* consume request */
      }
      if (incoming.url === '/grants') {
        usable = true;
        outgoing.writeHead(201, { 'content-type': 'application/json' });
        outgoing.end(
          issue === 'malformed'
            ? '{'
            : JSON.stringify({
                token,
                expiresAt: new Date(
                  Date.now() + (issue === 'short' ? 1000 : 7200000),
                ).toISOString(),
              }),
        );
      } else if (incoming.url === '/grants/revoke') {
        if (!rejectRevoke) usable = false;
        outgoing.writeHead(rejectRevoke ? 503 : 204);
        outgoing.end();
      } else {
        outgoing.writeHead(usable ? 200 : 401);
        outgoing.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return {
      root,
      socket,
      token,
      rejectRevoke: (value: boolean) => {
        rejectRevoke = value;
      },
      inferenceStatus: () =>
        new Promise<number>((resolve, reject) => {
          const req = request(
            {
              socketPath: socket,
              path: '/v1/chat/completions',
              method: 'POST',
              headers: { authorization: `Bearer ${token}` },
            },
            (res) => {
              resolve(res.statusCode ?? 0);
            },
          );
          req.on('error', reject);
          req.end();
        }),
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      },
    };
  };
  it.each(['malformed', 'short'] as const)(
    'revokes an unusable %s issuance without starting the agent',
    async (issue) => {
      const f = await fixture(issue);
      try {
        const result = await runAgentScenario({
          runId: `llm-${issue}`,
          output: finalMarkdownJsonl(),
          llmServiceSocket: f.socket,
          modelConfig,
          evidenceRoot: join(f.root, 'evidence'),
          callbackRequests: [],
        });
        expect(result.terminal).toMatchObject({
          status: 'failed',
          sandbox: { cleanup: 'destroyed' },
        });
        expect(result.agentInvoked).toBe(false);
        expect(await f.inferenceStatus()).toBe(401);
      } finally {
        await f.close();
      }
    },
  );
  it('fails without a vote when revocation is unavailable, then recovers before a fresh Runner can claim', async () => {
    const f = await fixture();
    f.rejectRevoke(true);
    const evidenceRoot = join(f.root, 'evidence');
    const callbacks: Request[] = [];
    let restarted: ReturnType<typeof createRunner> | undefined;
    try {
      const result = await runAgentScenario({
        runId: 'llm-revoke-failed',
        output: finalMarkdownJsonl(),
        llmServiceSocket: f.socket,
        modelConfig,
        evidenceRoot,
        callbackRequests: callbacks,
      });
      expect(result.terminal).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'destroyed' },
      });
      expect(result.terminal).not.toHaveProperty('result');
      expect((await callbacks[0].json()).result).toBeUndefined();
      expect(await f.inferenceStatus()).toBe(200);
      let unexpectedClaim = false;
      const blocked = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        modelConfig,
        llmServiceSocket: f.socket,
        claimFetch: async () => {
          unexpectedClaim = true;
          return new Response(null, { status: 204 });
        },
      });
      try {
        const admission = await blocked.handle(
          new Request('http://runner/jobs', {
            method: 'POST',
            headers: {
              authorization: 'Bearer runner-test-token',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              ...runnerJobFields,
              runId: 'blocked-recovery',
              attempt: 1,
              repositoryUrl: 'https://github.com/acme/reviewed.git',
              baseSha: '1111111111111111111111111111111111111111',
              headSha: '2222222222222222222222222222222222222222',
            }),
          }),
        );
        expect(admission.status).toBe(503);
        expect(unexpectedClaim).toBe(false);
        expect(await f.inferenceStatus()).toBe(200);
      } finally {
        await blocked.close();
      }
      f.rejectRevoke(false);
      let claimedWithRevokedGrant = false;
      restarted = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        modelConfig,
        llmServiceSocket: f.socket,
        claimIntervalMs: 60000,
        claimFetch: async () => {
          claimedWithRevokedGrant = (await f.inferenceStatus()) === 401;
          return new Response(null, { status: 204 });
        },
      });
      await vi.waitFor(() => expect(claimedWithRevokedGrant).toBe(true));
    } finally {
      await restarted?.close();
      await f.close();
    }
  });
  it('preserves cleanup failure when grant revocation also fails', async () => {
    const f = await fixture();
    f.rejectRevoke(true);
    try {
      const result = await runAgentScenario({
        runId: 'llm-revoke-cleanup-failed',
        output: finalMarkdownJsonl(),
        llmServiceSocket: f.socket,
        modelConfig,
        evidenceRoot: join(f.root, 'evidence'),
        cleanupFailure: true,
      });
      expect(result.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'cleanup' },
        sandbox: { cleanup: 'failed' },
      });
      expect(result.manifest.terminal).toMatchObject({ status: 'failed', reason: 'cleanup' });
    } finally {
      await f.close();
    }
  });
  it('revokes immediately on DELETE while the agent process has not exited', async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    let runner: ReturnType<typeof createRunner> | undefined;
    const scenario = runAgentScenario({
      runId: 'llm-cancel',
      terminalAttempts: 400,
      output: finalMarkdownJsonl(),
      llmServiceSocket: f.socket,
      modelConfig,
      evidenceRoot: join(f.root, 'evidence'),
      callbackRequests: [],
      agentGate: gate,
      onAgentStart: () => {
        started = true;
      },
      onRunner: (r) => {
        runner = r;
      },
    });
    let cancelled: Promise<Response> | undefined;
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      expect(await f.inferenceStatus()).toBe(200);
      cancelled = runner!.handle(
        new Request(`http://runner/jobs/${runnerJobFields.id}`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      );
      await vi.waitFor(async () => expect(await f.inferenceStatus()).toBe(401));
    } finally {
      release();
      await cancelled;
      const done = await scenario;
      expect(done.terminal).toMatchObject({ status: 'aborted', sandbox: { cleanup: 'destroyed' } });
      await runner?.close();
      await f.close();
    }
  });
});

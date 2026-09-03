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
  id: 'runner-job-test',
  repositoryName: 'acme/reviewed',
  pullRequestNumber: 42,
  repositoryReadToken: 'github-read-token',
};
const sharedEvidenceRoot = join(tmpdir(), 'compte-rendu-runner-evidence');

const submitReviewEvent = (
  markdown = '## Review:\n\nNo findings.',
  options: { readonly callID?: string; readonly status?: string } = {},
) =>
  JSON.stringify({
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'submit_review',
      callID: options.callID ?? 'call-submit-review',
      state:
        options.status === undefined || options.status === 'completed'
          ? {
              status: 'completed',
              input: { markdown },
              output: 'Review submitted.',
              title: 'Review submitted.',
            }
          : { status: options.status, error: 'submission failed' },
    },
  });

const finalMarkdownJsonl = (markdown = '## Review:\n\nNo findings.') =>
  [
    JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        messageID: 'msg-final',
        text: 'I finished reviewing the pull request.',
      },
    }),
    submitReviewEvent(markdown),
    JSON.stringify({
      type: 'step_finish',
      part: { type: 'step-finish', messageID: 'msg-final', reason: 'stop' },
    }),
  ].join('\n');

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
    const source = args[1];
    const destination = args[2];
    const sessionId = source.match(/opencode-export-([A-Za-z0-9._:-]+)\.json$/)?.[1];
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
    callbackUrl: options.callbackUrl ?? 'https://ingress.test/runner-callback',
    callbackToken: options.callbackToken ?? 'callback-token',
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
    callbackUrl: productionOptions.callbackUrl ?? 'https://ingress.test/runner-callback',
    callbackToken: productionOptions.callbackToken ?? 'callback-token',
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
            await writeFile(
              destination,
              JSON.stringify({ info: { id: sessionId }, messages: [] }),
              { mode: 0o600 },
            );
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
  callbackRequests?: Request[];
  callbackStatuses?: readonly number[];
  callbackHangs?: boolean;
  callbackTimeoutMs?: number;
}) => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  let agentInvoked = false;
  const runner = createRunner({
    evidenceRoot: sharedEvidenceRoot,
    authToken: 'runner-test-token',
    modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
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
      await writeEvidenceFixture(args, options, finalMarkdownJsonl());
      return {
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? `${firstJob.baseSha}\n${firstJob.headSha}\n`
          : args.includes('session')
            ? '[{"id":"session-1"}]\n'
            : args.includes('export')
              ? ''
              : options.captureStdout === true
                ? finalMarkdownJsonl()
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
          await writeEvidenceFixture(args, options, finalMarkdownJsonl());
          activeAgents -= 1;
          return {
            exitCode: 0,
            stdout: `${finalMarkdownJsonl()}\n`,
            timedOut: false,
            truncated: false,
          };
        }
        await writeEvidenceFixture(args, options, finalMarkdownJsonl());
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
            await writeFile(options.stdoutFilePath!, `${finalMarkdownJsonl()}\n`, { mode: 0o600 });
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
                  ? `${finalMarkdownJsonl()}\n`
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
      expect(new TextEncoder().encode(JSON.stringify(callback)).byteLength).toBeLessThan(1024);
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
    const resultLine = finalMarkdownJsonl();
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
      result: finalMarkdown,
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
    ['errored submission', 'errored', 'result-schema-failure'],
    ['empty submission', 'empty', 'empty-final-text'],
    ['invalid Markdown', 'invalid-markdown', 'result-schema-failure'],
    ['duplicate submissions', 'duplicate', 'multiple-results'],
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

  it('reports missing-terminal-message when OpenCode emits no terminal assistant message', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-missing-terminal-message',
      output: JSON.stringify({ type: 'step-start' }),
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
    });
    expect(manifest).toMatchObject({
      execution: {
        status: 'failed',
        reason: 'invalid-output',
        cause: 'missing-terminal-message',
      },
      terminal: {
        status: 'failed',
        reason: 'invalid-output',
        cause: 'missing-terminal-message',
      },
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
        failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
        evidence: { status: 'complete' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(terminal).not.toHaveProperty('result');
      expect(manifest).toMatchObject({
        execution: {
          status: 'failed',
          reason: 'invalid-output',
          cause: 'missing-terminal-message',
        },
        terminal: { status: 'failed', reason: 'invalid-output', cause: 'missing-terminal-message' },
      });
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

  it('removes only each job-owned network rules for jobs sharing resources', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl();
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
    const resultLine = finalMarkdownJsonl();
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
    const resultLine = finalMarkdownJsonl();
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
    const resultLine = finalMarkdownJsonl();
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
    const resultLine = finalMarkdownJsonl();
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
      submitReviewEvent(finalMarkdown),
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
      await expect(readFile(join(archive, 'validated-review.md'), 'utf8')).resolves.toBe(
        finalMarkdown,
      );
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

  it('retains a complete valid JSON export larger than the Sandbox exec stdout limit', async () => {
    const evidenceRoot = await mkdtemp(`${tmpdir()}/compte-rendu-large-export-`);
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const sessionExport = JSON.stringify({
      info: { id: 'large-session' },
      messages: [{ id: 'message-1', parts: [{ type: 'text', text: 'x'.repeat(70 * 1024) }] }],
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
            await writeFile(options.stdoutFilePath!, `${finalMarkdownJsonl()}\n`, { mode: 0o600 });
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
                  ? `${finalMarkdownJsonl()}\n`
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
            await writeFile(options.stdoutFilePath!, `${finalMarkdownJsonl()}\n`, { mode: 0o600 });
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
                  ? `${finalMarkdownJsonl()}\n`
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
        failure: { reason: 'evidence' },
        evidence: { status: 'incomplete' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(manifest).toMatchObject({
        complete: false,
        evidence: { status: 'incomplete' },
        terminal: { status: 'failed', reason: 'evidence' },
      });
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('reports incomplete evidence as its own failure when archiving fails', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl();
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
    const resultLine = finalMarkdownJsonl();
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
      submitReviewEvent(finalMarkdown),
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
          await readFile(join(configRoot, 'opencode/tools/submit_review.js'), 'utf8');
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
      result: finalMarkdown,
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
      'After completing all analysis, call `submit_review` exactly once with the complete publishable Markdown in its `markdown` argument. The `markdown` argument itself must contain only findings and the conclusion ready to publish, with no visible planning, self-dialogue, candidate triage, or process narration. After optional outer whitespace, begin that argument with exactly `## Review:`. Do not emit the review as terminal prose; terminal assistant messages are evidence only.',
    );
    expect(submitReviewToolAvailableAtSandboxBoundary).toBe(true);
    expect(skillAtSandboxBoundary).not.toContain(
      'The final response must be exactly one bare JSON object',
    );
    expect(skillAtSandboxBoundary).not.toContain('schema-valid');
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
            submit_review: 'allow',
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
              'git log *--output*': 'deny',
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
    expect(agentArgs?.join(' ')).toContain(
      'concise human-readable Markdown review ready to publish',
    );
    expect(agentArgs?.join(' ')).toContain("pr-review skill's verdict-first output contract");
    expect(agentArgs?.join(' ')).toContain(
      'Tool calls and intermediate work may remain visible during the review.',
    );
    expect(agentArgs?.join(' ')).toContain(
      'After completing all analysis, call `submit_review` exactly once with the complete publishable Markdown in its `markdown` argument. The `markdown` argument itself must contain only findings and the conclusion ready to publish, with no visible planning, self-dialogue, candidate triage, or process narration. After optional outer whitespace, begin that argument with exactly `## Review:`. Do not emit the review as terminal prose; terminal assistant messages are evidence only.',
    );
    expect(agentArgs?.join(' ')).not.toContain('Return exactly one bare JSON object');
    expect(agentArgs?.join(' ')).not.toContain('schema-valid');
    await expect(
      readFile(join(configRootAtSandboxBoundary!, 'opencode/skills/pr-review/SKILL.md'), 'utf8'),
    ).rejects.toThrow();
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
    const finishEvent = JSON.stringify({
      type: 'step_finish',
      part: { type: 'step-finish', messageID: 'msg-final', reason: 'stop' },
    });
    const submitEvent = JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'submit_review',
        callID: 'call-final-review',
        state: {
          status: 'completed',
          input: { markdown: finalReview },
          output: 'Review submitted.',
          title: 'Review submitted.',
        },
      },
    });
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-109-submitted-markdown-review',
      output: `${progressEvent}\n${finalPartOneEvent}\n${finalPartTwoEvent}\n${submitEvent}\n${finishEvent}`,
    });

    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: finalReview,
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({ complete: true, terminal: { status: 'succeeded' } });
  });

  it('reviews a behind target from merge base to head while retaining admitted revision facts', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const mergeBaseSha = '3333333333333333333333333333333333333333';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl();
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
      result: '## Review:\n\nNo findings.',
      sandbox: { cleanup: 'destroyed' },
    });
    expect(agentPrompt).toContain(`git diff --find-renames ${mergeBaseSha} ${headSha}`);
    expect(agentPrompt).toContain(`base ${baseSha}`);
    expect(agentPrompt).toContain(`head ${headSha}`);
  });

  it('preserves the expected diff when the merge base equals the admitted base', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl();
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
    const resultLine = finalMarkdownJsonl();
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
      const resultLine = finalMarkdownJsonl();
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
        result: '## Review:\n\nNo findings.',
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
    const resultLine = finalMarkdownJsonl();
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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  RunnerProcess,
  RunnerProcessResult,
  SandboxBackend,
  SandboxHealth,
  createClaimExecution,
  createProductionRunner,
  createRunner,
  finalMarkdownJsonl,
  runnerJobFields,
  sessionExportJson,
  sharedEvidenceRoot,
  standardModelConfig,
  waitForTerminal,
  writeEvidenceFixture,
} from './support/runner-harness';

describe('Runner Job HTTP interface', () => {
  it('fails startup when MODEL_SECRET_COMMAND configures direct-provider mode', () => {
    const previous = process.env.MODEL_SECRET_COMMAND;
    try {
      process.env.MODEL_SECRET_COMMAND = 'secret-resolver get MODEL_API_KEY';
      expect(() =>
        createProductionRunner({
          modelConfig: standardModelConfig,
          callbackUrl: 'https://ingress.test/runner-callback',
          callbackToken: 'callback-token',
          claimUrl: 'https://ingress.test/runner-claim',
        }),
      ).toThrow(/MODEL_SECRET_COMMAND.*direct-provider/);
    } finally {
      if (previous === undefined) delete process.env.MODEL_SECRET_COMMAND;
      else process.env.MODEL_SECRET_COMMAND = previous;
    }
  });
  it.each(['0', 'false', 'off', 'no'])(
    'fails startup when RUNNER_LLM_RELAY explicitly disables managed inference: %s',
    (value) => {
      const previous = process.env.RUNNER_LLM_RELAY;
      try {
        process.env.RUNNER_LLM_RELAY = value;
        expect(() =>
          createProductionRunner({
            modelConfig: standardModelConfig,
            callbackUrl: 'https://ingress.test/runner-callback',
            callbackToken: 'callback-token',
            claimUrl: 'https://ingress.test/runner-claim',
          }),
        ).toThrow(/managed inference is the only model credential path/);
      } finally {
        if (previous === undefined) delete process.env.RUNNER_LLM_RELAY;
        else process.env.RUNNER_LLM_RELAY = previous;
      }
    },
  );
  it('does not claim durable work until local Job admission is fully configured', async () => {
    let claims = 0;
    createProductionRunner({
      modelConfig: standardModelConfig,
      authToken: undefined,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      claimUrl: 'https://ingress.test/runner-claim',
      claimFetch: async () => {
        claims += 1;
        return new Response(null, { status: 204 });
      },
      claimIntervalMs: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(claims).toBe(0);
  });
  it('polls again after a hanging claim request reaches its finite timeout', async () => {
    let claims = 0;
    const requestIds: string[] = [];
    let secondClaim!: () => void;
    const secondClaimObserved = new Promise<void>((resolve) => {
      secondClaim = resolve;
    });
    const runner = createRunner({
      authToken: 'runner-test-token',
      callbackUrl: 'https://ingress.test/runner-callback',
      claimUrl: 'https://ingress.test/runner-claim',
      claimTimeoutMs: 5,
      claimIntervalMs: 1,
      claimFetch: async (_input, init) => {
        claims += 1;
        if (typeof init?.body !== 'string') throw new Error('missing claim body');
        requestIds.push(JSON.parse(init.body).requestId);
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
    expect(requestIds[0]).toEqual(expect.any(String));
    expect(requestIds[1]).toBe(requestIds[0]);
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
    const firstExecution = createClaimExecution({ onClaim: () => firstClaimed() });
    firstExecution.enqueue(firstJob);
    const secondExecution = createClaimExecution();
    secondExecution.enqueue(secondJob);
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
              ? sessionExportJson('session-1')
              : options.captureStdout === true
                ? finalMarkdownJsonl(undefined, 'session-1')
                : '',
        timedOut: false,
        truncated: false,
      };
    };

    const firstRunner = createRunner({
      authToken: 'runner-test-token',
      evidenceRoot: firstEvidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      claimFetch: firstExecution.claimFetch,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: firstExecution.callbackFetch,
      claimIntervalMs: 1,
      process,
    });

    let secondRunner: ReturnType<typeof createRunner> | undefined;
    try {
      await firstClaimObserved;
      secondRunner = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot: secondEvidenceRoot,
        claimUrl: 'https://ingress.test/runner-claim',
        claimFetch: secondExecution.claimFetch,
        callbackUrl: 'https://ingress.test/runner-callback',
        callbackToken: 'callback-token',
        callbackFetch: secondExecution.callbackFetch,
        claimIntervalMs: 1,
        process,
      });

      const secondTerminal = await secondExecution.waitForTerminal();
      expect(secondTerminal.terminal.status).toBe('succeeded');
      const firstTerminal = await firstExecution.waitForTerminal();
      expect(firstTerminal.terminal.status).toBe('succeeded');
      expect(firstExecution.claimRequests.length).toBeGreaterThanOrEqual(1);
      expect(secondExecution.claimRequests.length).toBeGreaterThanOrEqual(1);
    } finally {
      await firstRunner.close();
      await secondRunner?.close();
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
      await runner.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
  it.each([
    ['missing callback URL', undefined, 'callback-token'],
    ['missing callback token', 'https://ingress.test/runner-callback', undefined],
    ['non-HTTPS callback URL', 'http://ingress.test/runner-callback', 'callback-token'],
  ])(
    'fails managed startup with a clear error for a %s',
    async (_name, callbackUrl, callbackToken) => {
      expect(() =>
        createProductionRunner({
          modelConfig: standardModelConfig,
          authToken: 'runner-test-token',
          ...(callbackUrl === undefined ? {} : { callbackUrl }),
          ...(callbackToken === undefined ? {} : { callbackToken }),
          claimUrl: 'https://ingress.test/runner-claim',
        }),
      ).toThrow(/RUNNER_CALLBACK_URL|RUNNER_CALLBACK_TOKEN/);
    },
  );
  it('rejects direct-provider or malformed managed config before claims or Sandbox work', () => {
    const invalidConfigs = [
      undefined,
      '{',
      JSON.stringify({ id: 'opencode-go/deepseek-flash', definition: { name: 'Direct' } }),
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
    for (const modelConfig of invalidConfigs) {
      expect(() =>
        createProductionRunner({
          authToken: 'runner-test-token',
          ...(modelConfig === undefined ? {} : { modelConfig }),
          callbackUrl: 'https://ingress.test/runner-callback',
          callbackToken: 'callback-token',
          claimUrl: 'https://ingress.test/runner-claim',
        }),
      ).toThrow();
    }
  });
  it('retires direct job submission without starting work', async () => {
    let processCalls = 0;
    const runner = createProductionRunner({
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      evidenceRoot: sharedEvidenceRoot,
      process: async (_command, args) => {
        const readOnly =
          args[0] === 'ls' ||
          (args[0] === 'policy' && args[1] === 'ls') ||
          (args[0] === 'secret' && args[1] === 'ls');
        if (!readOnly) processCalls += 1;
        return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
      },
    });

    try {
      const anonymous = await runner.handle(
        new Request('http://runner/jobs', { method: 'POST', body: '{}' }),
      );
      const authenticated = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: '{}',
        }),
      );

      expect(anonymous.status).toBe(401);
      expect(authenticated.status).toBe(404);
      expect(processCalls).toBe(0);
    } finally {
      await runner.close();
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
      evidenceRoot: sharedEvidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      claimFetch: async () => {
        claims += 1;
        return new Response(null, { status: 204 });
      },
      claimIntervalMs: 1,
      process: async (_command: string, args: readonly string[]): Promise<RunnerProcessResult> => {
        const readOnly =
          args[0] === 'ls' ||
          (args[0] === 'policy' && args[1] === 'ls') ||
          (args[0] === 'secret' && args[1] === 'ls');
        if (!readOnly) processCalls += 1;
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
      await runner.close();
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
      await runner.close();
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
      await runner.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
  it('reports a timeout without starting a sandbox for an expired claim', async () => {
    const job = independentJob(42, 'expired-claim');
    const started: string[] = [];
    const runner = createRunner({
      authToken: 'runner-test-token',
      evidenceRoot: sharedEvidenceRoot,
      process: async (_command, args) => {
        if (args.includes('clone') || args[0] === 'create') started.push(args[0]);
        return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
      },
    });
    const submittedJob = { ...job, claimDeadlineAt: Date.now() - 1 };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;
    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'timeout' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(started).toEqual([]);
    const stopped = await runner.handle(
      new Request(`http://runner/jobs/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );
    expect(stopped.status).toBe(404);
  });
  it.each([false, true])(
    'acknowledges a stop during claim delivery without inventing cleanup if delivery fails (%s)',
    async (lost) => {
      const job = independentJob(42, 'cancel-during-claim');
      let deliver!: (response: Response) => void;
      let started!: () => void;
      const claimed = new Promise<void>((resolve) => {
        started = resolve;
      });
      const response = new Promise<Response>((resolve) => {
        deliver = resolve;
      });
      let callback!: (value: unknown) => void;
      const result = new Promise<unknown>((resolve) => {
        callback = resolve;
      });
      let polledAgain!: () => void;
      const resumed = new Promise<void>((resolve) => {
        polledAgain = resolve;
      });
      let first = true;
      const deadline = Date.now() + 60_000;
      const runner = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot: sharedEvidenceRoot,
        claimUrl: 'https://ingress.test/runner-claim',
        claimIntervalMs: 10,
        callbackUrl: 'https://ingress.test/runner-callback',
        callbackToken: 'callback-token',
        claimFetch: async () => {
          if (first) {
            first = false;
            started();
            return response;
          }
          polledAgain();
          return new Response(null, { status: 204 });
        },
        callbackFetch: async (_, init) => {
          if (typeof init?.body !== 'string') throw new Error('expected callback body');
          callback(JSON.parse(init.body));
          return new Response(null, { status: 202 });
        },
        process: async (_command, args) => {
          if (args.includes('clone') || args[0] === 'create')
            throw new Error('cancelled job executed');
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        },
      });
      await claimed;
      try {
        const reply = await runner.handle(
          new Request('http://runner/jobs/' + job.id, {
            method: 'DELETE',
            headers: {
              authorization: 'Bearer runner-test-token',
              'x-compte-rendu-claim-deadline': String(deadline),
            },
          }),
        );
        expect(reply.status).toBe(202);
      } finally {
        if (lost) deliver(new Response(null, { status: 503 }));
        else deliver(Response.json({ ...job, claimDeadlineAt: deadline }));
      }
      await resumed;
      if (lost) {
        const unknown = await runner.handle(
          new Request('http://runner/jobs/' + job.id, {
            headers: { authorization: 'Bearer runner-test-token' },
          }),
        );
        expect(unknown.status).toBe(404);
        await runner.close();
        return;
      }
      expect(await result).toMatchObject({
        runId: job.runId,
        status: 'aborted',
        sandbox: { cleanup: 'destroyed' },
      });
      await resumed;
    },
  );
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
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(claimCalls).toBe(1);

      resolveClaim?.(Response.json(claimedJob));
      const terminal = await waitForTerminal(runner, claimedJob.id);
      expect(terminal.status).toBe('succeeded');
    } finally {
      resolveClaim?.(new Response(null, { status: 204 }));
      await runner.close();
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
      await runner.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
  it('keeps a terminal Job occupying its slot until callback transport completes', async () => {
    const evidenceRoot = await mkdtemp(
      join(tmpdir(), 'compte-rendu-runner-oversized-concurrency-'),
    );
    const jobA = independentJob(42, 'run-oversized-a');
    const jobB = independentJob(43, 'run-oversized-b');
    const jobC = independentJob(44, 'run-oversized-c');
    const jobD = independentJob(45, 'run-oversized-d');
    const bigExport = (() => {
      const exported = JSON.parse(sessionExportJson('oversized-session')) as {
        messages: unknown[];
      };
      exported.messages.unshift({
        type: 'assistant',
        id: 'preamble',
        finish: 'stop',
        content: [{ type: 'text', text: 'x'.repeat(25 * 1024 * 1024) }],
      });
      return JSON.stringify(exported);
    })();
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
    let dAgentStarted!: () => void;
    const dAgentObserved = new Promise<void>((resolve) => {
      dAgentStarted = resolve;
    });
    let cAgents = 0;
    let dAgents = 0;
    const runner = createRunner({
      concurrency: 2,
      authToken: 'runner-test-token',
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
        const sessionId =
          sandbox?.endsWith(jobA.id) === true ? 'oversized-session' : 'concurrency-session';
        if (args[0] === 'exec' && args.includes('--agent')) {
          if (sandbox?.endsWith(jobB.id) === true) {
            bAgentStarted();
            await gateB;
          } else if (sandbox?.endsWith(jobC.id) === true) {
            cAgents += 1;
            cAgentStarted();
            await gateC;
          } else if (sandbox?.endsWith(jobD.id) === true) {
            dAgents += 1;
            dAgentStarted();
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
    try {
      runner.enqueue(jobA);
      await Promise.race([
        firstCallbackObserved,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('terminal callback was not reached')), 3_000),
        ),
      ]);

      runner.enqueue(jobB);
      await bAgentObserved;
      runner.enqueue(jobC);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cAgents).toBe(0);

      releaseB?.();
      expect((await waitForTerminal(runner, jobB.id)).status).toBe('succeeded');

      await cAgentObserved;
      runner.enqueue(jobD);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(dAgents).toBe(0);

      releaseA?.();
      expect((await waitForTerminal(runner, jobA.id)).status).toBe('succeeded');
      await dAgentObserved;

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
      await runner.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('aborts a contradictory same-pull-request claim with a terminal callback while unrelated work progresses', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-runner-abort-claim-'));
    const existing = independentJob(42, 'run-abort-existing');
    const contradictory = independentJob(42, 'run-abort-claim');
    const unrelated = independentJob(43, 'run-abort-unrelated');
    let allowClaims = false;
    let existingClaimed = false;
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
      evidenceRoot,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: async () => {
        if (!existingClaimed) {
          existingClaimed = true;
          return Response.json(existing);
        }
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
    try {
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

      expect(createdSandboxes.some((name) => name.endsWith(contradictory.id))).toBe(false);
      expect(clones).toBe(2);
      expect(callbackBodies).toContainEqual({
        runId: contradictory.runId,
        status: 'aborted',
      });
    } finally {
      releaseAgents?.();
      await waitForTerminal(runner, existing.id).catch(() => undefined);
      await runner.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe('Runner claim scheduling', () => {
  it('reclaims after an initial readiness outage clears', async () => {
    let health: SandboxHealth = 'outage';
    let readinessChecks = 0;
    const backend: SandboxBackend = {
      kind: 'fixture',
      health: () => health,
      checkReady: async () => {
        readinessChecks += 1;
        if (readinessChecks === 1) return 'outage';
        health = 'ready';
        return 'ready';
      },
      reconcileOrphans: async () => ({
        ok: true,
        recovered: 0,
        recoveredJobIds: [],
        failures: [],
      }),
      createJob: () => {
        throw new Error('job creation is not used by this test');
      },
    };
    const execution = createClaimExecution();
    const runner = createRunner({
      sandboxBackend: backend,
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: execution.claimFetch,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
    });
    try {
      await vi.waitFor(() => expect(execution.claimRequests.length).toBeGreaterThan(0));
      expect(readinessChecks).toBeGreaterThanOrEqual(2);
    } finally {
      await runner.close();
    }
  });
});

describe('Runner claim reservations', () => {
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
    const queued: Array<Record<string, unknown>> = [];
    const queuedJob = (n: number) => ({
      id: `claims-${n}`,
      runId: `claims-${n}`,
      attempt: 1,
      repositoryName: 'acme/repo',
      pullRequestNumber: n,
      repositoryUrl: 'https://github.com/acme/repo.git',
      repositoryReadToken: 'fixture-token',
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
    });
    const runner = createRunner({
      authToken: 'test-auth',
      modelConfig: standardModelConfig,
      concurrency: 2,
      evidenceRoot: root,
      claimUrl: 'http://claim.test/runner-claim',
      claimIntervalMs: 1,
      claimTimeoutMs: 1_000,
      callbackUrl: 'https://callback.test/runner-callback',
      callbackToken: 'test-callback',
      claimFetch: async () => {
        const next = queued.shift();
        if (next !== undefined) {
          startupDone = true;
          return Response.json(next);
        }
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
        if (args[0] === 'ls') return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        if (args.includes('clone')) await cloneGate;
        return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
      },
    });
    try {
      for (let i = 0; i < 200 && !startupDone; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(startupDone).toBe(true);
      queued.push(queuedJob(1), queuedJob(2));
      releaseClones();
      for (let i = 0; i < 200 && callbackReleases.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(callbackReleases).toHaveLength(2);
      measure = true;
      for (const release of callbackReleases) release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(peak).toBe(1);
    } finally {
      for (const release of claimReleases) release();
      await runner.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

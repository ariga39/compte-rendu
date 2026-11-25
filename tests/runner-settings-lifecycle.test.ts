import { describe, expect, it, vi } from 'vitest';
import {
  RunnerProcessResult,
  createRunner,
  finalMarkdownJsonl,
  runAgentScenario,
  runnerJobFields,
  sharedEvidenceRoot,
  standardModelConfig,
  waitForTerminal,
  writeEvidenceFixture,
} from './support/runner-harness';

describe('Runner desired concurrency', () => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  const concurrencyHeader = 'x-compte-rendu-concurrency';
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
  type RunnerHandle = { handle(request: Request): Promise<Response> };
  const get = async (runner: RunnerHandle, id: string) =>
    (
      await runner.handle(new Request(`http://runner/jobs/${id}`, { headers: auth }))
    ).json() as Promise<{
      status: string;
    }>;
  const maintenance = async (runner: RunnerHandle) =>
    (
      await runner.handle(new Request('http://runner/maintenance', { headers: auth }))
    ).json() as Promise<{
      draining: boolean;
      drained: boolean;
      activeJobs: number;
      claimInFlight: boolean;
      claimPollingHalted: boolean;
    }>;
  const captureLogs = () => {
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    return {
      desired: (cap: number) =>
        logs.some((line) => line.includes(`runner desired concurrency=${cap}`)),
      lines: () => logs.slice(),
      restore: () => spy.mockRestore(),
    };
  };
  const startFixture = (options: {
    readonly concurrency: number;
    readonly claimFetch: typeof fetch;
    readonly claimIntervalMs?: number;
    readonly claimProbeIntervalMs?: number;
  }) => {
    const gates: Array<() => void> = [];
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      evidenceRoot: sharedEvidenceRoot,
      concurrency: options.concurrency,
      claimUrl: 'https://ingress.test/runner-claim',
      claimTimeoutMs: 1_000_000,
      claimIntervalMs: options.claimIntervalMs ?? 1_000_000,
      claimProbeIntervalMs: options.claimProbeIntervalMs ?? 10,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'test-callback',
      callbackTimeoutMs: 1_000_000,
      claimFetch: options.claimFetch,
      callbackFetch: async () => new Response(null, { status: 202 }),
      process: async (_command, args, processOptions = {}): Promise<RunnerProcessResult> => {
        if (args[0] === 'exec' && args.includes('--agent')) {
          await new Promise<void>((resolve) => gates.push(resolve));
          await writeEvidenceFixture(args, processOptions, finalMarkdownJsonl());
          return {
            exitCode: 0,
            stdout: `${finalMarkdownJsonl()}\n`,
            timedOut: false,
            truncated: false,
          };
        }
        await writeEvidenceFixture(args, processOptions, finalMarkdownJsonl());
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
    const releaseOne = () => gates.shift()?.();
    const releaseAll = () => {
      for (const gate of gates.splice(0)) gate();
    };
    return { runner, releaseOne, releaseAll };
  };
  const parseBody = (init?: RequestInit) =>
    typeof init?.body === 'string'
      ? (JSON.parse(init.body) as { requestId?: string; probeOnly?: boolean })
      : {};

  it('rejects RUNNER_SETTINGS_FILE at startup with the D1 migration message', () => {
    const previous = process.env.RUNNER_SETTINGS_FILE;
    process.env.RUNNER_SETTINGS_FILE = '/tmp/legacy-runner-settings.toml';
    try {
      expect(() =>
        createRunner({
          authToken: 'runner-test-token',
          evidenceRoot: sharedEvidenceRoot,
          claimFetch: async () => new Response(null, { status: 204 }),
        }),
      ).toThrow('RUNNER_SETTINGS_FILE is no longer supported');
    } finally {
      if (previous === undefined) delete process.env.RUNNER_SETTINGS_FILE;
      else process.env.RUNNER_SETTINGS_FILE = previous;
    }
  });

  it('uses a non-claiming probe to raise capacity while a long review keeps the runner full', async () => {
    const logs = captureLogs();
    const bodies = [jobBody('probe-raise-a'), jobBody('probe-raise-b')];
    const probes: Array<{ requestId?: string; probeOnly?: boolean }> = [];
    let claims = 0;
    const h = startFixture({
      concurrency: 1,
      claimFetch: async (_url, init) => {
        const body = parseBody(init);
        if (body.probeOnly === true) {
          probes.push(body);
          return new Response(null, {
            status: 204,
            headers: { [concurrencyHeader]: '2' },
          });
        }
        const next = bodies[claims++];
        return next === undefined
          ? new Response(null, { status: 204 })
          : new Response(next, { status: 200 });
      },
    });
    try {
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'probe-raise-a')).status).toBe('running');
      });
      await vi.waitFor(() => expect(probes.length).toBeGreaterThan(0));
      expect(probes[0]).toEqual({ probeOnly: true });
      expect(probes[0]?.requestId).toBeUndefined();
      expect((await maintenance(h.runner)).claimInFlight).toBe(false);
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'probe-raise-b')).status).toBe('running');
      });
      // The first review is still active: the probe discovered the increase
      // without waiting for it to finish.
      expect((await get(h.runner, 'probe-raise-a')).status).toBe('running');
      await vi.waitFor(() => expect(logs.desired(2)).toBe(true));
    } finally {
      logs.restore();
      h.releaseAll();
      await h.runner.close();
    }
  });

  it('probes without a claim ID and stops probing while drained', async () => {
    const probes: Array<{ requestId?: string; probeOnly?: boolean }> = [];
    let releaseProbe: (() => void) | undefined;
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    let claims = 0;
    const h = startFixture({
      concurrency: 1,
      claimProbeIntervalMs: 10,
      claimFetch: async (_url, init) => {
        const body = parseBody(init);
        if (body.probeOnly === true) {
          probes.push(body);
          probeStarted();
          return new Promise<Response>((resolve) => {
            releaseProbe = () => resolve(new Response(null, { status: 204 }));
          });
        }
        claims += 1;
        return claims === 1
          ? new Response(jobBody('probe-held-a'), { status: 200 })
          : new Response(null, { status: 204 });
      },
    });
    try {
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'probe-held-a')).status).toBe('running');
      });
      await started;
      expect(probes).toEqual([{ probeOnly: true }]);

      const drain = await h.runner.handle(
        new Request('http://runner/maintenance/drain', { method: 'POST', headers: auth }),
      );
      expect(await drain.json()).toMatchObject({ draining: true });
      releaseProbe?.();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(probes).toHaveLength(1);

      const resume = await h.runner.handle(
        new Request('http://runner/maintenance/resume', { method: 'POST', headers: auth }),
      );
      expect(await resume.json()).toMatchObject({ draining: false });
      await vi.waitFor(() => expect(probes.length).toBeGreaterThanOrEqual(2));
      expect(
        probes.every((probe) => probe.probeOnly === true && probe.requestId === undefined),
      ).toBe(true);
      expect(claims).toBe(1);
    } finally {
      h.releaseAll();
      await h.runner.close();
    }
  });

  it('honors a decrease without aborting active reviews and waits before claiming more', async () => {
    const probes: Array<{ probeOnly?: boolean }> = [];
    let claims = 0;
    const h = startFixture({
      concurrency: 2,
      claimIntervalMs: 5,
      claimProbeIntervalMs: 10,
      claimFetch: async (_url, init) => {
        const body = parseBody(init);
        if (body.probeOnly === true) {
          probes.push(body);
          return new Response(null, {
            status: 204,
            headers: { [concurrencyHeader]: '1' },
          });
        }
        const ids = ['probe-lower-a', 'probe-lower-b', 'probe-lower-c'];
        const id = ids[claims++];
        return id === undefined
          ? new Response(null, { status: 204 })
          : new Response(jobBody(id), { status: 200 });
      },
    });
    try {
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'probe-lower-a')).status).toBe('running');
        expect((await get(h.runner, 'probe-lower-b')).status).toBe('running');
      });
      await vi.waitFor(() => expect(probes.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect((await get(h.runner, 'probe-lower-c')).status).not.toBe('running');
      expect(claims).toBe(2);

      h.releaseOne();
      await vi.waitFor(async () => {
        expect((await maintenance(h.runner)).activeJobs).toBe(1);
      });
      // One active review still fills the lowered desired value of one.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect((await get(h.runner, 'probe-lower-c')).status).not.toBe('running');
      expect(claims).toBe(2);

      h.releaseOne();
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'probe-lower-c')).status).toBe('running');
      });
      expect(claims).toBe(3);
    } finally {
      h.releaseAll();
      await h.runner.close();
    }
  });

  it('distinguishes an explicit default from a transient missing or invalid header', async () => {
    const logs = captureLogs();
    let claims = 0;
    let probes = 0;
    const h = startFixture({
      concurrency: 2,
      claimIntervalMs: 5,
      claimProbeIntervalMs: 10,
      claimFetch: async (_url, init) => {
        const body = parseBody(init);
        if (body.probeOnly === true) {
          probes += 1;
          if (probes === 1) return new Response(null, { status: 204 });
          if (probes === 2)
            return new Response(null, {
              status: 204,
              headers: { [concurrencyHeader]: 'not-a-number' },
            });
          if (probes === 3)
            return new Response(null, {
              status: 204,
              headers: { [concurrencyHeader]: 'default' },
            });
          return new Response(null, { status: 204 });
        }
        const ids = ['probe-default-a', 'probe-default-b', 'probe-default-c'];
        const id = ids[claims];
        if (id === undefined) return new Response(null, { status: 204 });
        claims += 1;
        return new Response(jobBody(id), {
          status: 200,
          headers: { [concurrencyHeader]: '3' },
        });
      },
    });
    try {
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'probe-default-a')).status).toBe('running');
        expect((await get(h.runner, 'probe-default-b')).status).toBe('running');
        expect((await get(h.runner, 'probe-default-c')).status).toBe('running');
      });
      await vi.waitFor(() => expect(probes).toBeGreaterThanOrEqual(3));
      // A missing or invalid header left the target at three. The explicit
      // default then returned it to the startup value of two.
      await vi.waitFor(() => expect(logs.desired(2)).toBe(true));
      expect(logs.lines().filter((line) => line.includes('runner desired concurrency='))).toEqual([
        'runner desired concurrency=3',
        'runner desired concurrency=2',
      ]);
      // The decrease did not abort the three active reviews.
      expect((await maintenance(h.runner)).activeJobs).toBe(3);
      expect(claims).toBe(3);
    } finally {
      logs.restore();
      h.releaseAll();
      await h.runner.close();
    }
  });

  it('keeps probing after a transient probe error and never replays it as a claim', async () => {
    const probes: Array<{ requestId?: string; probeOnly?: boolean }> = [];
    let probeAttempts = 0;
    let claims = 0;
    const h = startFixture({
      concurrency: 1,
      claimProbeIntervalMs: 10,
      claimFetch: async (_url, init) => {
        const body = parseBody(init);
        if (body.probeOnly === true) {
          probes.push(body);
          probeAttempts += 1;
          if (probeAttempts === 1) throw new Error('transient probe failure');
          return new Response(null, {
            status: 204,
            headers: { [concurrencyHeader]: '2' },
          });
        }
        const ids = ['probe-retry-a', 'probe-retry-b'];
        const id = ids[claims++];
        return id === undefined
          ? new Response(null, { status: 204 })
          : new Response(jobBody(id), { status: 200 });
      },
    });
    try {
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'probe-retry-a')).status).toBe('running');
      });
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'probe-retry-b')).status).toBe('running');
      });
      expect(probes.length).toBeGreaterThanOrEqual(2);
      expect(
        probes.every((probe) => probe.probeOnly === true && probe.requestId === undefined),
      ).toBe(true);
    } finally {
      h.releaseAll();
      await h.runner.close();
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
      process: async (_command, args) => ({
        exitCode: args[0] === 'ls' ? 0 : 1,
        stdout: '',
        timedOut: false,
        truncated: false,
      }),
    });
    try {
      runner.enqueue({
        ...runnerJobFields,
        id: 'progress-stalled',
        runId: 'progress-stalled-run',
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
      });
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
        { stage: 'sandbox', startedAt: expect.any(String), runtime: 'sbx' },
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
        { stage: 'sandbox', startedAt: expect.any(String), runtime: 'sbx' },
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

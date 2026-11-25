import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  RunnerProcessResult,
  createProductionRunner,
  createRunner,
  finalMarkdownJsonl,
  runAgentScenario,
  runnerJobFields,
  sharedEvidenceRoot,
  standardModelConfig,
  waitForTerminal,
} from './support/runner-harness';

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
    const callbackBodies = new Map<string, string>();
    let disposed = false;
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      evidenceRoot: sharedEvidenceRoot,
      settingsFile: file,
      claimUrl: 'https://ingress.test/runner-claim',
      claimTimeoutMs: 1_000_000,
      claimIntervalMs: 1_000_000,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'test-callback',
      callbackTimeoutMs: 1_000_000,
      process: async (_command, args): Promise<RunnerProcessResult> => ({
        exitCode: args[0] === 'ls' ? 0 : 1,
        stdout: '',
        timedOut: false,
        truncated: false,
      }),
      callbackFetch: async (_url, init) => {
        if (disposed) return new Response(null, { status: 202 });
        const body = init?.body as string;
        const id = (JSON.parse(body) as { id: string }).id;
        callbackBodies.set(id, body);
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
    return {
      dir,
      file,
      runner,
      callbackReleases,
      callbackBodies,
      releaseCallback,
      releaseCallbacks,
      close,
    };
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
    const logs = captureLogs();
    const queued: Array<Record<string, unknown>> = [];
    const job = (id: string) => JSON.parse(jobBody(id)) as Record<string, unknown>;
    let claims = 0;
    let releaseHeldClaim: (() => void) | undefined;
    const h = await startFixture(3, {
      claimIntervalMs: 20,
      claimFetch: async () => {
        const next = queued.shift();
        if (next !== undefined) return Response.json(next);
        claims += 1;
        if (claims === 1) return Response.json(job('settings-lower-a'));
        if (claims === 2) {
          return new Promise<Response>((resolve) => {
            releaseHeldClaim = () => resolve(Response.json(job('settings-lower-b')));
          });
        }
        return new Response(null, { status: 204 });
      },
    });
    try {
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lower-a')).status).toBe('running');
      });
      await vi.waitFor(() => expect(claims).toBeGreaterThanOrEqual(2));
      await writeCap(h.dir, 1);
      await vi.waitFor(() => expect(logs.reloadedTo(1)).toBe(true));
      queued.push(job('settings-lower-probe'));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect((await get(h.runner, 'settings-lower-probe')).status).not.toBe('running');
      expect(claims).toBe(2);
      releaseHeldClaim?.();
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lower-b')).status).toBe('running');
      });
      expect((await get(h.runner, 'settings-lower-a')).status).toBe('running');
      expect((await get(h.runner, 'settings-lower-probe')).status).not.toBe('running');
      await vi.waitFor(() => expect(h.callbackReleases.size).toBe(2));
      h.releaseCallbacks();
      await vi.waitFor(() => expect(h.callbackBodies.has('settings-lower-b')).toBe(true));
      const callback = JSON.parse(h.callbackBodies.get('settings-lower-b')!) as {
        status: string;
        sandbox: { cleanup: string };
      };
      expect(callback.status).toBe('failed');
      expect(callback.sandbox.cleanup).toBe('destroyed');
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lower-b')).status).toBeUndefined();
      });
    } finally {
      logs.restore();
      await h.close();
    }
  });

  it('keeps the last valid cap across invalid, deletion, and applies an atomic recreation', async () => {
    const logs = captureLogs();
    const queued: Array<Record<string, unknown>> = [];
    const job = (id: string) => JSON.parse(jobBody(id)) as Record<string, unknown>;
    const h = await startFixture(2, {
      claimIntervalMs: 20,
      claimFetch: async () => {
        const next = queued.shift();
        return next === undefined ? new Response(null, { status: 204 }) : Response.json(next);
      },
    });
    try {
      queued.push(job('settings-lastgood-a'), job('settings-lastgood-b'));
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lastgood-a')).status).toBe('running');
        expect((await get(h.runner, 'settings-lastgood-b')).status).toBe('running');
      });
      await vi.waitFor(() => expect(h.callbackReleases.size).toBe(2));
      queued.push(job('settings-lastgood-c'));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect((await get(h.runner, 'settings-lastgood-c')).status).not.toBe('running');
      await writeRaw(h.dir, 'concurrency = 0\n');
      await vi.waitFor(() => expect(logs.ignored()).toBeGreaterThanOrEqual(1));
      await writeRaw(h.dir, 'concurrency = "two"\nnot = toml =\n');
      await vi.waitFor(() => expect(logs.ignored()).toBeGreaterThanOrEqual(2));
      expect((await get(h.runner, 'settings-lastgood-c')).status).not.toBe('running');
      await rm(h.file, { force: true });
      await vi.waitFor(() => expect(logs.ignored()).toBeGreaterThanOrEqual(3));
      expect((await get(h.runner, 'settings-lastgood-a')).status).toBe('running');
      h.releaseCallback('settings-lastgood-a');
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lastgood-a')).status).not.toBe('running');
      });
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lastgood-c')).status).toBe('running');
      });
      queued.push(job('settings-lastgood-d'));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect((await get(h.runner, 'settings-lastgood-d')).status).not.toBe('running');
      await writeCap(h.dir, 3);
      await vi.waitFor(() => expect(logs.reloadedTo(3)).toBe(true));
      await vi.waitFor(async () => {
        expect((await get(h.runner, 'settings-lastgood-d')).status).toBe('running');
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
      await vi.waitFor(() => expect(h.callbackReleases.size).toBe(2));
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

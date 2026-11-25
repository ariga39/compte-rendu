import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  RunnerProcess,
  RunnerProcessResult,
  createRunner,
  finalMarkdownJsonl,
  runnerJobFields,
  sharedEvidenceRoot,
  waitForTerminal,
  writeEvidenceFixture,
} from './support/runner-harness';

describe('Runner maintenance drain', () => {
  const auth = { authorization: 'Bearer runner-test-token' };
  const maintenance = (
    runner: ReturnType<typeof createRunner>,
    method: 'GET' | 'POST',
    path: string,
    authorized = true,
  ) =>
    runner.handle(
      new Request(`http://runner${path}`, {
        method,
        headers: authorized ? auth : {},
      }),
    );
  const status = async (
    runner: ReturnType<typeof createRunner>,
    method: 'GET' | 'POST' = 'GET',
    path = '/maintenance',
  ) =>
    (await (await maintenance(runner, method, path)).json()) as {
      draining: boolean;
      drained: boolean;
      activeJobs: number;
      claimInFlight: boolean;
      claimPollingHalted: boolean;
      cleanupBlockedJobs: number;
    };

  const jobBody = (id: string, pullRequestNumber: number) =>
    JSON.stringify({
      ...runnerJobFields,
      id,
      runId: id,
      attempt: 1,
      pullRequestNumber,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
    });
  const reviewProcess = (options: {
    readonly onCleanup?: () => void | Promise<void>;
    readonly cleanupFails?: boolean;
  }): RunnerProcess => {
    const baseSha = '1'.repeat(40);
    const headSha = '2'.repeat(40);
    const result = finalMarkdownJsonl(undefined, 'maintenance-session');
    return async (_command, args, processOptions = {}) => {
      if (args[0] === 'rm' && args[1] === '--force') {
        await options.onCleanup?.();
        return {
          exitCode: options.cleanupFails === true ? 1 : 0,
          stdout: '',
          timedOut: false,
          truncated: false,
        };
      }
      if (args[0] === 'exec' && args.includes('--agent')) {
        await writeEvidenceFixture(args, processOptions, result);
        return {
          exitCode: 0,
          stdout: `${result}\n`,
          timedOut: false,
          truncated: false,
        };
      }
      await writeEvidenceFixture(args, processOptions, result);
      return {
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : args.includes('session')
            ? '[{"id":"maintenance-session"}]\n'
            : processOptions.captureStdout === true
              ? `${result}\n`
              : '',
        timedOut: false,
        truncated: false,
      };
    };
  };

  it('protects maintenance endpoints and reports drain/resume status idempotently', async () => {
    const runner = createRunner({ authToken: 'runner-test-token', claimUrl: '' });
    try {
      for (const [method, path] of [
        ['GET', '/maintenance'],
        ['POST', '/maintenance/drain'],
        ['POST', '/maintenance/resume'],
      ] as const) {
        expect((await maintenance(runner, method, path, false)).status).toBe(401);
      }
      expect(await status(runner)).toEqual({
        draining: false,
        drained: false,
        activeJobs: 0,
        claimInFlight: false,
        claimPollingHalted: false,
        cleanupBlockedJobs: 0,
      });

      await status(runner, 'POST', '/maintenance/drain');
      await vi.waitFor(async () => expect((await status(runner)).drained).toBe(true));
      expect(await status(runner)).toEqual({
        draining: true,
        drained: true,
        activeJobs: 0,
        claimInFlight: false,
        claimPollingHalted: false,
        cleanupBlockedJobs: 0,
      });
      expect(await status(runner, 'POST', '/maintenance/drain')).toEqual({
        draining: true,
        drained: true,
        activeJobs: 0,
        claimInFlight: false,
        claimPollingHalted: false,
        cleanupBlockedJobs: 0,
      });

      expect(await status(runner, 'POST', '/maintenance/resume')).toEqual({
        draining: false,
        drained: false,
        activeJobs: 0,
        claimInFlight: false,
        claimPollingHalted: false,
        cleanupBlockedJobs: 0,
      });
      expect(await status(runner, 'POST', '/maintenance/resume')).toEqual({
        draining: false,
        drained: false,
        activeJobs: 0,
        claimInFlight: false,
        claimPollingHalted: false,
        cleanupBlockedJobs: 0,
      });
    } finally {
      await runner.close();
    }
  });

  it('does not claim or probe while draining and resumes with one in-flight claim', async () => {
    let claims = 0;
    let probes = 0;
    let pending = 0;
    let peak = 0;
    const heldClaims: Array<() => void> = [];
    const runner = createRunner({
      authToken: 'runner-test-token',
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1_000_000_000,
      claimProbeIntervalMs: 5,
      claimFetch: async (_url, init) => {
        if (init?.method === 'HEAD') {
          probes += 1;
          return new Response(null, { status: 204 });
        }
        claims += 1;
        if (claims === 1) return new Response(null, { status: 204 });
        pending += 1;
        peak = Math.max(peak, pending);
        return new Promise<Response>((resolve) =>
          heldClaims.push(() => {
            pending -= 1;
            resolve(new Response(null, { status: 204 }));
          }),
        );
      },
    });
    try {
      await vi.waitFor(() => expect(claims).toBe(1));
      expect((await status(runner, 'POST', '/maintenance/drain')).drained).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(claims).toBe(1);
      expect(probes).toBe(0);

      const resumed = await Promise.all([
        status(runner, 'POST', '/maintenance/resume'),
        status(runner, 'POST', '/maintenance/resume'),
      ]);
      expect(resumed.map((value) => value.draining)).toEqual([false, false]);
      await vi.waitFor(() => expect(claims).toBe(2));
      expect(peak).toBe(1);
      for (const release of heldClaims.splice(0)) release();
      await vi.waitFor(async () => expect((await status(runner)).claimInFlight).toBe(false));
    } finally {
      for (const release of heldClaims.splice(0)) release();
      await runner.close();
    }
  });

  it('admits and completes an already-reserved claim after drain', async () => {
    const job = jobBody('maintenance-held-claim', 6111);
    let claimRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      claimRequested = resolve;
    });
    let resolveClaim: ((response: Response) => void) | undefined;
    const claimResponse = new Promise<Response>((resolve) => {
      resolveClaim = resolve;
    });
    let claims = 0;
    const runner = createRunner({
      authToken: 'runner-test-token',
      evidenceRoot: sharedEvidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1_000_000_000,
      claimFetch: async () => {
        claims += 1;
        claimRequested();
        return claimResponse;
      },
      process: async (_command, args) => ({
        exitCode: args[0] === 'ls' ? 0 : 1,
        stdout: '',
        timedOut: false,
        truncated: false,
      }),
    });
    try {
      await requested;
      expect(await status(runner, 'POST', '/maintenance/drain')).toEqual({
        draining: true,
        drained: false,
        activeJobs: 0,
        claimInFlight: true,
        claimPollingHalted: false,
        cleanupBlockedJobs: 0,
      });
      resolveClaim?.(Response.json(JSON.parse(job)));
      await expect(waitForTerminal(runner, 'maintenance-held-claim')).resolves.toMatchObject({
        status: 'failed',
        failure: { reason: 'checkout' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(claims).toBe(1);
      await vi.waitFor(async () => {
        expect(await status(runner)).toMatchObject({
          draining: true,
          drained: true,
          activeJobs: 0,
          claimInFlight: false,
        });
      });
    } finally {
      resolveClaim?.(new Response(null, { status: 204 }));
      await runner.close();
    }
  });

  it('stays undrained through held cleanup and callback delivery', async () => {
    let cleanupStarted!: () => void;
    const cleanupObserved = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let callbackStarted!: () => void;
    const callbackObserved = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const runner = createRunner({
      authToken: 'runner-test-token',
      evidenceRoot: sharedEvidenceRoot,
      process: reviewProcess({
        onCleanup: async () => {
          cleanupStarted();
          await cleanupGate;
        },
      }),
      callbackFetch: async () => {
        callbackStarted();
        await callbackGate;
        return new Response(null, { status: 202 });
      },
    });
    try {
      runner.enqueue(JSON.parse(jobBody('maintenance-held-cleanup', 6112)));
      await vi.waitFor(async () => expect((await status(runner)).activeJobs).toBe(1));
      expect((await status(runner, 'POST', '/maintenance/drain')).draining).toBe(true);

      await cleanupObserved;
      expect(await status(runner)).toMatchObject({
        draining: true,
        drained: false,
        activeJobs: 1,
        claimInFlight: false,
        cleanupBlockedJobs: 0,
      });

      releaseCleanup();
      await callbackObserved;
      expect(await status(runner)).toMatchObject({
        draining: true,
        drained: false,
        activeJobs: 1,
        cleanupBlockedJobs: 0,
      });

      releaseCallback();
      await waitForTerminal(runner, 'maintenance-held-cleanup');
      await vi.waitFor(async () => {
        expect(await status(runner)).toMatchObject({
          draining: true,
          drained: true,
          activeJobs: 0,
          cleanupBlockedJobs: 0,
        });
      });
    } finally {
      releaseCleanup();
      releaseCallback();
      await runner.close();
    }
  });

  it('keeps an ambiguous halted claim blocking drain across resume', async () => {
    let claims = 0;
    const runner = createRunner({
      authToken: 'runner-test-token',
      evidenceRoot: sharedEvidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1_000_000_000,
      claimFetch: async () => {
        claims += 1;
        return new Response('{}', { status: 200 });
      },
      process: reviewProcess({}),
    });
    try {
      await vi.waitFor(async () => expect((await status(runner)).claimPollingHalted).toBe(true));
      expect(await status(runner, 'POST', '/maintenance/drain')).toEqual({
        draining: true,
        drained: false,
        activeJobs: 0,
        claimInFlight: false,
        claimPollingHalted: true,
        cleanupBlockedJobs: 0,
      });
      expect(await status(runner, 'POST', '/maintenance/resume')).toMatchObject({
        draining: false,
        drained: false,
        claimPollingHalted: true,
        cleanupBlockedJobs: 0,
      });
      expect(claims).toBe(1);
    } finally {
      await runner.close();
    }
  });

  it('times out a stalled claim body so maintenance drain does not hang', async () => {
    let claims = 0;
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const runner = createRunner({
      authToken: 'runner-test-token',
      evidenceRoot: sharedEvidenceRoot,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1_000_000_000,
      claimTimeoutMs: 20,
      claimFetch: async () => {
        claims += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await bodyGate;
              controller.enqueue(new TextEncoder().encode('{}'));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
      process: reviewProcess({}),
    });
    try {
      await vi.waitFor(() => expect(claims).toBe(1));
      // The body deadline releases claiming while retaining the ambiguous
      // request identity for a same-ID replay.
      await vi.waitFor(async () => {
        const state = await status(runner);
        expect(state.claimInFlight).toBe(false);
        expect(state.claimPollingHalted).toBe(true);
      });
      expect(await status(runner, 'POST', '/maintenance/drain')).toEqual({
        draining: true,
        drained: false,
        activeJobs: 0,
        claimInFlight: false,
        claimPollingHalted: true,
        cleanupBlockedJobs: 0,
      });
      expect(claims).toBe(1);
    } finally {
      releaseBody();
      await runner.close();
    }
  });

  it('replays a prepared claim through drain without a new request ID', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'cr-staged-drain-'));
    const baseSha = '1'.repeat(40);
    const headSha = '2'.repeat(40);
    const job = {
      ...runnerJobFields,
      id: 'staged-drain-claim',
      runId: 'run-staged-drain-claim',
      attempt: 1,
      pullRequestNumber: 78,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    };
    const result = finalMarkdownJsonl(undefined, 'staged-drain-session');
    const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    const requestIds: string[] = [];
    let prepared!: () => void;
    const preparedClaim = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    let releaseLost!: () => void;
    const lostResponse = new Promise<void>((resolve) => {
      releaseLost = resolve;
    });
    let lost = false;
    const claimFetch: typeof fetch = async (input, init) => {
      const body = (await new Request(input, init).json()) as { requestId: string };
      requestIds.push(body.requestId);
      if (!lost) {
        lost = true;
        prepared();
        await lostResponse;
        throw new Error('claim response lost after Core prepared the job');
      }
      return Response.json(job);
    };
    const runner = createRunner({
      evidenceRoot,
      authToken: 'runner-test-token',
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 10,
      claimFetch,
      process: async (_command, args, options = {}) => {
        if (args[0] === 'secret' && args[1] === 'ls')
          return { ...ok, stdout: JSON.stringify({ secrets: [], custom_secrets: [] }) };
        if (args[0] === 'inspect')
          return { ...ok, exitCode: 1, stderr: `error: sandbox '${args[1]}' not found` };
        if (args[0] === 'exec' && args.includes('--agent')) {
          await writeEvidenceFixture(args, options, result);
          return { ...ok, stdout: `${result}\n` };
        }
        await writeEvidenceFixture(args, options, result);
        return {
          ...ok,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"staged-drain-session"}]\n'
              : options.captureStdout === true
                ? `${result}\n`
                : '',
        };
      },
    });
    try {
      await preparedClaim;
      expect(await status(runner, 'POST', '/maintenance/drain')).toMatchObject({
        draining: true,
        drained: false,
      });
      releaseLost();
      await vi.waitFor(() => expect(requestIds).toHaveLength(2), { timeout: 1_000 });
      expect(requestIds[0]).toBe(requestIds[1]);
      expect(await waitForTerminal(runner, job.id)).toMatchObject({
        status: 'succeeded',
        sandbox: { cleanup: 'destroyed' },
      });
      await vi.waitFor(async () => {
        expect(await status(runner)).toMatchObject({
          draining: true,
          drained: true,
          activeJobs: 0,
          claimPollingHalted: false,
          cleanupBlockedJobs: 0,
        });
      });
    } finally {
      releaseLost();
      await runner.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps failed cleanup blocking drain across resume without a halted claim', async () => {
    const runner = createRunner({
      authToken: 'runner-test-token',
      evidenceRoot: sharedEvidenceRoot,
      process: reviewProcess({ cleanupFails: true }),
    });
    try {
      runner.enqueue(JSON.parse(jobBody('maintenance-blocked-cleanup', 6113)));
      await expect(waitForTerminal(runner, 'maintenance-blocked-cleanup')).resolves.toMatchObject({
        sandbox: { cleanup: 'failed' },
      });
      runner.claimExecution?.stopClaims();
      await status(runner, 'POST', '/maintenance/drain');
      await vi.waitFor(async () => {
        expect(await status(runner, 'GET', '/maintenance')).toEqual({
          draining: true,
          drained: false,
          activeJobs: 0,
          claimInFlight: false,
          claimPollingHalted: false,
          cleanupBlockedJobs: 1,
        });
      });
      expect(await status(runner, 'POST', '/maintenance/resume')).toMatchObject({
        draining: false,
        drained: false,
        claimPollingHalted: false,
        cleanupBlockedJobs: 1,
      });
    } finally {
      await runner.close();
    }
  });
});

describe('Runner same-PR admission', () => {
  it('keeps a known failed cleanup blocking past the retained claim budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-same-pr-expiry-'));
    const baseSha = '1'.repeat(40);
    const oldHead = '2'.repeat(40);
    const newHead = '3'.repeat(40);
    const oldId = 'same-pr-old';
    const replacementId = 'same-pr-replacement';
    const present = new Map<string, { workspace: string; config: string }>();
    const created: string[] = [];
    const agentSandboxes: string[] = [];
    const removals: Array<{ name: string; exitCode: number }> = [];
    const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    let checkouts = 0;
    const notFound = (name: string): RunnerProcessResult => ({
      ...ok,
      exitCode: 1,
      stderr: `error: sandbox '${name}' not found`,
    });
    const inspectView = async (name: string, workspace: string, config: string) => {
      const text = await readFile(
        new URL('./fixtures/sbx-inspect-view.json', import.meta.url),
        'utf8',
      );
      return JSON.parse(
        text
          .replaceAll('__SANDBOX_NAME__', name)
          .replaceAll('__WORKSPACE__', workspace)
          .replaceAll('__CONFIG__', config),
      ) as Record<string, unknown>;
    };
    const process: RunnerProcess = async (_command, args, options = {}) => {
      if (args[0] === 'secret' && args[1] === 'ls')
        return {
          ...ok,
          stdout: JSON.stringify({ secrets: [], custom_secrets: [] }),
        };
      if (args[0] === 'create') {
        const name = args[args.indexOf('--name') + 1]!;
        present.set(name, { workspace: args.at(-2)!, config: args.at(-1)! });
        created.push(name);
        return ok;
      }
      if (args[0] === 'inspect') {
        const name = args[1]!;
        const entry = present.get(name);
        if (entry === undefined) return notFound(name);
        return {
          ...ok,
          stdout: JSON.stringify(await inspectView(name, entry.workspace, entry.config)),
        };
      }
      if (args[0] === 'rm' && args[1] === '--force') {
        const name = args[2]!;
        const exitCode = created[0] === name ? 1 : 0;
        removals.push({ name, exitCode });
        if (exitCode === 0) present.delete(name);
        return { ...ok, exitCode };
      }
      if (args[0] === 'exec' && args.includes('--agent')) {
        agentSandboxes.push(args[1]!);
        const result = finalMarkdownJsonl(undefined, 'same-pr-session');
        await writeEvidenceFixture(args, options, result);
        return { ...ok, stdout: `${result}\n` };
      }
      const result = finalMarkdownJsonl(undefined, 'same-pr-session');
      await writeEvidenceFixture(args, options, result);
      return {
        ...ok,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${checkouts++ === 0 ? oldHead : newHead}\n`
          : args.includes('session')
            ? '[{"id":"same-pr-session"}]\n'
            : options.captureStdout === true
              ? `${result}\n`
              : '',
      };
    };
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const runner = createRunner({
      evidenceRoot: root,
      authToken: 'runner-test-token',
      claimIntervalMs: 10,
      process,
      callbackFetch: async () => {
        return new Response(null, { status: 202 });
      },
    });
    const maintenance = async () =>
      (await (
        await runner.handle(
          new Request('http://runner/maintenance', {
            headers: { authorization: 'Bearer runner-test-token' },
          }),
        )
      ).json()) as { activeJobs: number; cleanupBlockedJobs: number };
    try {
      runner.enqueue({
        ...runnerJobFields,
        id: oldId,
        runId: 'run-same-pr-old',
        attempt: 1,
        pullRequestNumber: 77,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha: oldHead,
        claimDeadlineAt: Date.now() + 90 * 60 * 1000,
      });
      expect(await waitForTerminal(runner, oldId)).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });
      const oldName = created[0]!;
      expect(present.has(oldName)).toBe(true);
      expect(await maintenance()).toMatchObject({ activeJobs: 0, cleanupBlockedJobs: 1 });

      // Core admits the replacement only after the retained claim budget expires.
      offset = 91 * 60 * 1000;
      runner.enqueue({
        ...runnerJobFields,
        id: replacementId,
        runId: 'run-same-pr-replacement',
        attempt: 1,
        pullRequestNumber: 77,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha: newHead,
        claimDeadlineAt: Date.now() + 90 * 60 * 1000,
      });
      expect(await waitForTerminal(runner, replacementId)).toMatchObject({
        status: 'aborted',
        sandbox: { cleanup: 'destroyed' },
      });
      expect(created).toEqual([oldName]);
      expect(agentSandboxes).toEqual([oldName]);
      // The unresolved original VM is neither reused nor removed without proof.
      expect(present.has(oldName)).toBe(true);
      expect(removals).toContainEqual({ name: oldName, exitCode: 1 });
      expect(removals).not.toContainEqual({ name: oldName, exitCode: 0 });
      expect(await maintenance()).toMatchObject({ activeJobs: 0, cleanupBlockedJobs: 1 });
    } finally {
      clock.mockRestore();
      await runner.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

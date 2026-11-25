import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  RunnerProcessResult,
  SqliteD1Database,
  createCoreWorker,
  createD1ReviewStateStore,
  createProductionRunnerWithMergeBase,
  createRelayControl,
  createRunner,
  finalMarkdownJsonl,
  relayInferenceModelConfig,
  routeRelayControl,
  runAgentScenario,
  runnerJobFields,
  standardModelConfig,
  waitForTerminal,
} from './support/runner-harness';

describe('Runner terminal callback retention', () => {
  const auth = { authorization: 'Bearer runner-test-token' };

  it('delivers the callback when the retained copy cannot be persisted', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-callback-recovery-'));
    const callbackRequests: Request[] = [];
    try {
      const result = await runAgentScenario({
        runId: 'run-callback-persist-failure',
        output: finalMarkdownJsonl(),
        evidenceRoot,
        callbackRequests,
        onAgentStart: async () => {
          for (const entry of await readdir(evidenceRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              await mkdir(join(evidenceRoot, entry.name, 'callback.json.tmp'), {
                recursive: true,
              });
            }
          }
        },
      });

      expect(result.terminal.status).toBe('succeeded');
      expect(callbackRequests).toHaveLength(1);
      await expect(
        stat(join(evidenceRoot, result.terminal.evidenceId as string, 'callback.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('does not expose a manual callback replay endpoint for a retained callback', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-callback-recovery-'));
    const originalRequests: Request[] = [];
    try {
      const result = await runAgentScenario({
        runId: 'run-callback-retained',
        output: finalMarkdownJsonl(),
        evidenceRoot,
        callbackRequests: originalRequests,
        callbackStatuses: [503, 503, 503, 503, 503],
        callbackRetryDelaysMs: [0, 0, 0, 0, 0],
      });
      const replayRequests: Request[] = [];
      const executionCalls: string[][] = [];
      const restarted = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        claimUrl: '',
        callbackFetch: async (input, init) => {
          replayRequests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
        process: async (_command, args) => {
          if (!['ls', 'policy', 'secret'].includes(args[0]!)) executionCalls.push([...args]);
          return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
        },
      });
      try {
        const response = await restarted.handle(
          new Request('http://runner/maintenance/replay-callback', {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({
              evidenceId: result.terminal.evidenceId,
              jobId: runnerJobFields.id,
              runId: 'run-callback-retained',
              attempt: 1,
              baseSha: result.manifest.baseSha,
              headSha: result.manifest.headSha,
            }),
          }),
        );
        expect(response.status).toBe(404);
        expect(replayRequests).toHaveLength(0);
        expect(executionCalls).toEqual([]);
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('retains the exact final callback body in the evidence directory before delivery', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-callback-recovery-'));
    const callbackRequests: Request[] = [];
    try {
      const result = await runAgentScenario({
        runId: 'run-callback-retained',
        output: finalMarkdownJsonl(),
        evidenceRoot,
        callbackRequests,
      });

      expect(callbackRequests).toHaveLength(1);
      const delivered = await callbackRequests[0]!.clone().text();
      const evidencePath = join(evidenceRoot, result.terminal.evidenceId as string);
      const retained = await readFile(join(evidencePath, 'callback.json'), 'utf8');

      expect(retained).toBe(delivered);
      expect(retained).not.toContain('callback-token');
      expect(retained).not.toContain('https://ingress.test');
      expect((await stat(join(evidencePath, 'callback.json'))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe('Runner confirmed cleanup recovery', () => {
  it.each([false, true])(
    'creates a restricted microsandbox with Fake IP mode %s',
    async (enabled) => {
      const root = await mkdtemp(join(tmpdir(), 'cr-msb-profile-'));
      vi.stubEnv('MSB_HOME', root);
      vi.stubEnv('MICROSANDBOX_ALLOW_FAKE_IP', enabled ? '1' : undefined);
      try {
        await mkdir(join(root, 'db'));
        await writeFile(join(root, 'db', 'msb.db'), '');
        const run = await runAgentScenario({
          microsandbox: true,
          output: finalMarkdownJsonl(),
          relayControl: createRelayControl(),
          modelConfig: relayInferenceModelConfig(),
          evidenceRoot: root,
          runId: 'msb-profile',
        });
        const args = run.createArgs ?? [];
        expect(args[args.indexOf('--deployment-profile') + 1]).toBe(
          enabled ? 'single-tenant' : 'multi-tenant',
        );
        expect(args.includes('--no-dns-rebind-protection')).toBe(enabled);
        expect(args[args.indexOf('--max-tcp-connections') + 1]).toBe('1024');
        expect(args[args.indexOf('--max-udp-connections') + 1]).toBe('1024');
        expect(args[args.indexOf('--security') + 1]).toBe('restricted');
        expect(args[args.indexOf('--net-default') + 1]).toBe('deny');
        expect(args[args.indexOf('--net-rule') + 1]).toBe(
          'allow@inference.example:tcp:443,allow@api.github.com:tcp:443',
        );
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('runs through microsandbox and reconciles failed teardown only against the original backend after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-recovery-'));
    const relay = createRelayControl();
    const modelConfig = relayInferenceModelConfig('deepseek-review');
    const previousHome = process.env.MSB_HOME;
    process.env.MSB_HOME = root;
    await mkdir(join(root, 'db'));
    const catalog = join(root, 'db', 'msb.db');
    await writeFile(catalog, '');
    try {
      const scenario = {
        microsandbox: true,
        output: finalMarkdownJsonl(),
        relayControl: relay,
        modelConfig,
        evidenceRoot: root,
      };
      const callbacks: Request[] = [];
      const success = await runAgentScenario({
        ...scenario,
        runId: 'msb-success',
        callbackRequests: callbacks,
      });
      expect(success.terminal).toMatchObject({
        status: 'succeeded',
        sandbox: { cleanup: 'destroyed' },
      });
      expect(success.manifest.runtime).toBe('microsandbox');
      expect(callbacks).toHaveLength(1);
      const lifecycle = (await callbacks[0].json()) as {
        lifecycle: { milestones: Array<{ stage: string; runtime?: string }> };
      };
      expect(
        lifecycle.lifecycle.milestones.find((milestone) => milestone.stage === 'sandbox'),
      ).toMatchObject({
        runtime: 'microsandbox',
      });
      expect(success.createArgs).toContain(
        'allow@inference.example:tcp:443,allow@api.github.com:tcp:443',
      );
      const failed = await runAgentScenario({
        ...scenario,
        runId: 'msb-cleanup',
        cleanupFailure: true,
      });
      expect(failed.terminal).toMatchObject({ status: 'failed', sandbox: { cleanup: 'failed' } });
      const { runId, jobId, evidenceId, attempt, baseSha, headSha } = failed.manifest;
      const request = new Request('http://runner/maintenance/recover-cleanup', {
        method: 'POST',
        headers: { authorization: 'Bearer runner-test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ runId, jobId, evidenceId, attempt, baseSha, headSha }),
      });
      for (const kind of ['sbx', 'microsandbox'] as const) {
        const reports: Request[] = [];
        vi.stubEnv('RUNNER_SANDBOX_RUNTIME', kind);
        vi.stubEnv('MICROSANDBOX_IMAGE', 'review:fixture');
        const runner = createProductionRunnerWithMergeBase({
          authToken: 'runner-test-token',
          evidenceRoot: root,
          claimUrl: '',
          modelConfig,
          llmRelay: true,
          callbackFetch: routeRelayControl(relay, async (input, init) => {
            reports.push(new Request(input, init));
            return new Response(null, { status: 202 });
          }),
          process: async (_cmd, args) => ({
            exitCode: 1,
            stdout: '',
            stderr: 'error: sandbox not found: ' + args.at(-1),
            truncated: false,
            timedOut: false,
          }),
        });
        try {
          const response = await runner.handle(request.clone());
          expect(response.status).toBe(kind === 'sbx' ? 409 : 202);
          expect(reports).toHaveLength(kind === 'sbx' ? 0 : 1);
          if (kind === 'microsandbox') {
            await rename(catalog, catalog + '.previous');
            await writeFile(catalog, '');
            expect((await runner.handle(request.clone())).status).toBe(502);
            expect(reports).toHaveLength(1);
          }
        } finally {
          await runner.close();
        }
      }
    } finally {
      if (previousHome === undefined) delete process.env.MSB_HOME;
      else process.env.MSB_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a failed job pending after a transient cleanup report and retires it on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-report-retry-'));
    const relay = createRelayControl();
    const modelConfig = relayInferenceModelConfig('deepseek-review');
    const previousHome = process.env.MSB_HOME;
    process.env.MSB_HOME = root;
    await mkdir(join(root, 'db'));
    await writeFile(join(root, 'db', 'msb.db'), '');
    let runner: ReturnType<typeof createRunner> | undefined;
    try {
      const callbacks: Request[] = [];
      const scenario = await runAgentScenario({
        microsandbox: true,
        output: finalMarkdownJsonl(),
        relayControl: relay,
        modelConfig,
        evidenceRoot: root,
        runId: 'msb-cleanup-report-retry',
        cleanupRemovalFailures: 1,
        callbackRequests: callbacks,
        callbackStatuses: [202, 503, 202],
        claimIntervalMs: 5,
        onRunner: (started) => {
          runner = started;
        },
      });
      expect(scenario.terminal).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });
      const maintenance = async () =>
        (await (
          await runner!.handle(
            new Request('http://runner/maintenance', {
              headers: { authorization: 'Bearer runner-test-token' },
            }),
          )
        ).json()) as {
          activeJobs: number;
          cleanupBlockedJobs: number;
        };
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const waitForCallback = (expected: number) =>
        vi.waitFor(
          () => {
            if (callbacks.length < expected) now += 31_000;
            expect(callbacks).toHaveLength(expected);
          },
          { timeout: 5_000 },
        );
      try {
        // One bounded wait per public checkpoint. Each not-yet-observed
        // callback advances the frozen clock by one retry interval, then the
        // normal poll tick re-schedules the deferred recovery. Once the target
        // is reached the clock stays frozen so 503/pending remains observable.
        await waitForCallback(2);
        expect(await maintenance()).toMatchObject({ activeJobs: 0, cleanupBlockedJobs: 1 });
        await waitForCallback(3);
      } finally {
        clock.mockRestore();
      }
      // The initial terminal callback was consumed by terminal polling. Read the
      // two cleanup confirmations once after they have all settled; never clone
      // their retained request streams during an assertion retry loop.
      for (const callback of [callbacks[1]!, callbacks[2]!]) {
        expect(await callback.json()).toMatchObject({
          version: 2,
          id: scenario.manifest.jobId,
          runId: scenario.manifest.runId,
          attempt: scenario.manifest.attempt,
          status: 'failed',
          baseSha: scenario.manifest.baseSha,
          headSha: scenario.manifest.headSha,
          sandbox: { cleanup: 'destroyed' },
          failure: { reason: expect.any(String) },
        });
      }
      await vi.waitFor(async () =>
        expect(await maintenance()).toMatchObject({ activeJobs: 0, cleanupBlockedJobs: 0 }),
      );
      const drained = await runner!.handle(
        new Request('http://runner/maintenance/drain', {
          method: 'POST',
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      );
      expect(await drained.json()).toMatchObject({
        draining: true,
        drained: true,
        cleanupBlockedJobs: 0,
      });
    } finally {
      await runner?.close();
      if (previousHome === undefined) delete process.env.MSB_HOME;
      else process.env.MSB_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it.each(['finished', 'cancelled'] as const)(
    'reconciles a retained %s cleanup after restart without changing its evidence',
    async (execution) => {
      const evidenceRoot = await mkdtemp(join(tmpdir(), 'cr-cleanup-recovery-'));
      let originalRunner: ReturnType<typeof createRunner> | undefined;
      let cancellation: Promise<Response> | undefined;
      const result = await runAgentScenario({
        runId: 'run-cleanup-recovery',
        output: finalMarkdownJsonl(),
        cleanupFailure: true,
        evidenceRoot,
        onRunner: (runner) => {
          originalRunner = runner;
        },
        onAgentStart: () => {
          if (execution === 'cancelled')
            cancellation = originalRunner!.handle(
              new Request(`http://runner/jobs/${runnerJobFields.id}`, {
                method: 'DELETE',
                headers: { authorization: 'Bearer runner-test-token' },
              }),
            );
        },
      });
      await cancellation;
      await originalRunner?.close();
      expect(result.terminal.status).toBe('failed');
      const evidenceId = result.terminal.evidenceId as string;
      const original = await readFile(join(evidenceRoot, evidenceId, 'callback.json'), 'utf8');
      const manifest = JSON.parse(
        await readFile(join(evidenceRoot, evidenceId, 'manifest.json'), 'utf8'),
      );
      const reports: Request[] = [];
      let releaseInspect!: () => void;
      let inspectStarted!: () => void;
      const inspecting = new Promise<void>((resolve) => {
        inspectStarted = resolve;
      });
      const inspectGate = new Promise<void>((resolve) => {
        releaseInspect = resolve;
      });
      const runner = createProductionRunnerWithMergeBase({
        authToken: 'runner-test-token',
        evidenceRoot,
        claimUrl: '',
        callbackFetch: async (input, init) => {
          reports.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
        process: async (_command, args) => {
          if (args[0] === 'inspect') {
            inspectStarted();
            await inspectGate;
          }
          if (args[0] === 'inspect')
            return {
              exitCode: 1,
              stdout: '',
              stderr: `error: sandbox '${manifest.sandboxName}' not found`,
              timedOut: false,
              truncated: false,
            };
          return {
            exitCode: 0,
            stdout: args[0] === 'policy' ? '{"rules":[]}' : '',
            timedOut: false,
            truncated: false,
          };
        },
      });
      try {
        const recoveryRequest = () =>
          new Request('http://runner/maintenance/recover-cleanup', {
            method: 'POST',
            headers: {
              authorization: 'Bearer runner-test-token',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              evidenceId,
              jobId: manifest.jobId,
              runId: manifest.runId,
              attempt: manifest.attempt,
              baseSha: manifest.baseSha,
              headSha: manifest.headSha,
            }),
          });
        const pending = runner.handle(recoveryRequest());
        await inspecting;
        expect((await runner.handle(recoveryRequest())).status).toBe(409);
        const draining = await runner.handle(
          new Request('http://runner/maintenance/drain', {
            method: 'POST',
            headers: { authorization: 'Bearer runner-test-token' },
          }),
        );
        expect(await draining.json()).toMatchObject({ draining: true, drained: false });
        releaseInspect();
        const response = await pending;
        expect(response.status).toBe(202);
        expect(reports).toHaveLength(1);
        expect(new URL(reports[0].url).pathname).toBe('/runner-callback');
        expect(await reports[0].json()).toMatchObject({
          version: 2,
          id: manifest.jobId,
          runId: manifest.runId,
          attempt: manifest.attempt,
          status: 'failed',
          baseSha: manifest.baseSha,
          headSha: manifest.headSha,
          sandbox: { cleanup: 'destroyed' },
          failure: { reason: 'cleanup' },
        });
        expect(await readFile(join(evidenceRoot, evidenceId, 'callback.json'), 'utf8')).toBe(
          original,
        );
        expect(await readFile(join(evidenceRoot, evidenceId, 'manifest.json'), 'utf8')).toBe(
          JSON.stringify(manifest, null, 2) + '\n',
        );
        expect((await runner.handle(recoveryRequest())).status).toBe(202);
        expect(reports).toHaveLength(2);
      } finally {
        releaseInspect();
        await runner.close();
        await rm(evidenceRoot, { recursive: true, force: true });
      }
    },
  );
  it.each([
    'unauthorized',
    'wrong-identity',
    'legacy-host-cleanup',
    'legacy-untagged-callback',
    'present-sandbox',
    'auth-error',
    'truncated-inspect',
    'policy-error',
    'secret-error',
    'delivery-error',
  ])('keeps cleanup unresolved for %s', async (failure) => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'cr-recovery-rejected-'));
    const scenario = await runAgentScenario({
      runId: 'run-cleanup-rejected',
      output: finalMarkdownJsonl(),
      cleanupFailure: true,
      evidenceRoot,
    });
    // Exercise the explicit recovery contract rather than the startup sweep.
    const evidenceId = scenario.terminal.evidenceId as string;
    const callbackPath = join(evidenceRoot, evidenceId, 'callback.json');
    if (failure === 'legacy-host-cleanup') {
      const manifestPath = join(evidenceRoot, evidenceId, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      delete manifest.hostCleanupConfirmed;
      await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    }
    if (failure === 'legacy-untagged-callback') {
      const callback = JSON.parse(await readFile(callbackPath, 'utf8'));
      delete callback.version;
      await writeFile(callbackPath, JSON.stringify(callback), { mode: 0o600 });
    }
    const original = await readFile(callbackPath, 'utf8');
    const manifest = scenario.manifest;
    const commands: string[][] = [];
    const delivered: Request[] = [];
    const runner = createProductionRunnerWithMergeBase({
      authToken: 'runner-test-token',
      evidenceRoot,
      claimUrl: '',
      callbackFetch: async (input, init) => {
        delivered.push(new Request(input, init));
        return new Response(null, { status: 503 });
      },
      process: async (_command, args) => {
        commands.push([...args]);
        if (args[0] === 'inspect')
          return {
            exitCode: failure === 'present-sandbox' ? 0 : 1,
            stdout: '',
            stderr:
              failure === 'auth-error'
                ? 'not signed in'
                : `error: sandbox '${manifest.sandboxName}' not found`,
            timedOut: false,
            truncated: failure === 'truncated-inspect',
          };
        return {
          exitCode:
            (failure === 'policy-error' && args[0] === 'policy') ||
            (failure === 'secret-error' && args[0] === 'secret')
              ? 1
              : 0,
          stdout: args[0] === 'policy' ? '{"rules":[]}' : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    try {
      const response = await runner.handle(
        new Request('http://runner/maintenance/recover-cleanup', {
          method: 'POST',
          headers: {
            authorization: failure === 'unauthorized' ? 'Bearer bad' : 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            evidenceId,
            jobId: manifest.jobId,
            runId: failure === 'wrong-identity' ? 'other-run' : manifest.runId,
            attempt: manifest.attempt,
            baseSha: manifest.baseSha,
            headSha: manifest.headSha,
          }),
        }),
      );
      expect(response.status).toBe(
        failure === 'unauthorized'
          ? 401
          : ['wrong-identity', 'legacy-host-cleanup', 'legacy-untagged-callback'].includes(failure)
            ? 409
            : 502,
      );
      expect(delivered).toHaveLength(failure === 'delivery-error' ? 1 : 0);
      expect(commands.some((args) => args[0] === 'rm')).toBe(false);
      if (
        [
          'unauthorized',
          'wrong-identity',
          'legacy-host-cleanup',
          'legacy-untagged-callback',
        ].includes(failure)
      )
        expect(
          commands.filter(
            (args) =>
              !(
                (args[0] === 'ls' && args[1] === '-q') ||
                (args[0] === 'policy' && args[1] === 'ls') ||
                (args[0] === 'secret' && args[1] === 'ls')
              ),
          ),
        ).toEqual([]);
      expect(await readFile(callbackPath, 'utf8')).toBe(original);
    } finally {
      await runner.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe('Runner backend outage recovery', () => {
  // Genuine native sbx proof: an empty scoped secret inventory. Fixtures that
  // model an outage must fail before this point.
  const sbxNativeProof = (args: readonly string[]): RunnerProcessResult | undefined =>
    args[0] === 'secret' && args[1] === 'ls'
      ? {
          exitCode: 0,
          stdout: JSON.stringify({ secrets: [], custom_secrets: [] }),
          timedOut: false,
          truncated: false,
        }
      : undefined;

  it('pauses claims during an sbx outage and reconciles the failed cleanup after access returns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-backend-outage-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const baseSha = '1'.repeat(40);
    const oldHead = '2'.repeat(40);
    const newHead = '3'.repeat(40);
    const firstJobId = 'outage-first-job';
    const replacementJobId = 'outage-replacement-job';
    let backendUp = true;
    let phase: 'first' | 'replacement' = 'first';
    let recoveryAttempts = 0;
    let releaseRecoveryRetry!: () => void;
    const recoveryRetryGate = new Promise<void>((resolve) => {
      releaseRecoveryRetry = resolve;
    });
    const callbacks: Request[] = [];
    const recoveryReports: Array<Record<string, unknown>> = [];
    const commands: string[][] = [];
    const authFailure = {
      exitCode: 1,
      stdout: '',
      stderr: 'not signed in',
      timedOut: false,
      truncated: false,
    };
    const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    const jobBody = (id: string, headSha: string) => ({
      ...runnerJobFields,
      id,
      runId: `run-${id}`,
      attempt: 1,
      pullRequestNumber: 42,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    });
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: root,
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      claimIntervalMs: 2,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async (input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '{}';
        const parsed = JSON.parse(body) as {
          status?: string;
          sandbox?: { cleanup?: string };
        };
        const recovery = parsed.status === 'failed' && parsed.sandbox?.cleanup === 'destroyed';
        if (recovery) {
          recoveryAttempts += 1;
          recoveryReports.push(JSON.parse(body) as Record<string, unknown>);
          if (recoveryAttempts === 1) return new Response(null, { status: 503 });
          await recoveryRetryGate;
          return new Response(null, { status: 202 });
        }
        callbacks.push(new Request(input, init));
        return new Response(null, { status: 202 });
      },
      process: async (_command, args) => {
        commands.push([...args]);
        if (args[0] === 'ls') return backendUp ? ok : authFailure;
        if (!backendUp) return authFailure;
        const proof = sbxNativeProof(args);
        if (proof !== undefined) return proof;
        if (args[0] === 'secret' && args[1] === 'set-custom' && phase === 'first') {
          backendUp = false;
          return authFailure;
        }
        if (args[0] === 'inspect')
          return {
            ...ok,
            exitCode: 1,
            stderr: `error: sandbox '${args[1]}' not found`,
          };
        if (args[0] === 'policy' && args[1] === 'ls') return { ...ok, stdout: '{"rules":[]}' };
        if (args.includes('rev-parse'))
          return {
            ...ok,
            stdout:
              phase === 'first' ? `${baseSha}\n${oldHead}\n` : `${baseSha}\n${'4'.repeat(40)}\n`,
          };
        return ok;
      },
    });
    try {
      runner.enqueue(jobBody(firstJobId, oldHead));
      const first = await waitForTerminal(runner, firstJobId);
      expect(first).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });
      const evidenceId = first.evidenceId as string;
      const callbackPath = join(root, evidenceId, 'callback.json');
      const manifestPath = join(root, evidenceId, 'manifest.json');
      const originalCallback = await readFile(callbackPath, 'utf8');
      const originalManifest = await readFile(manifestPath, 'utf8');

      await vi.waitFor(async () => {
        const status = (await (
          await runner.handle(
            new Request('http://runner/maintenance', {
              headers: { authorization: 'Bearer runner-test-token' },
            }),
          )
        ).json()) as { claimPollingHalted: boolean };
        expect(status.claimPollingHalted).toBe(true);
      });
      const claimsWhileBlocked = runner.claimExecution?.claimRequests.length ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(runner.claimExecution?.claimRequests.length ?? 0).toBe(claimsWhileBlocked);
      expect(commands.filter((args) => args[0] === 'ls').length).toBeGreaterThan(0);

      backendUp = true;
      await vi.waitFor(() => expect(recoveryReports).toHaveLength(1));
      expect(recoveryReports[0]).toMatchObject({
        version: 2,
        id: firstJobId,
        runId: `run-${firstJobId}`,
        attempt: 1,
        status: 'failed',
        baseSha,
        headSha: oldHead,
        sandbox: { cleanup: 'destroyed' },
        failure: { reason: 'cleanup' },
      });
      const recoveryCommandsAfterFirst = commands.filter(
        (args) => args[0] === 'inspect' || (args[0] === 'policy' && args[1] === 'ls'),
      ).length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(recoveryReports).toHaveLength(1);
      expect(
        commands.filter(
          (args) => args[0] === 'inspect' || (args[0] === 'policy' && args[1] === 'ls'),
        ),
      ).toHaveLength(recoveryCommandsAfterFirst);
      const claimsAfterRejectedReport = runner.claimExecution?.claimRequests.length ?? 0;
      // A transient report failure must retry, while unrelated claim polling
      // continues on the same idle cadence.
      await vi.waitFor(() =>
        expect(runner.claimExecution?.claimRequests.length ?? 0).toBeGreaterThan(
          claimsAfterRejectedReport,
        ),
      );
      const advanceRetryClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      try {
        releaseRecoveryRetry();
        await vi.waitFor(() => expect(recoveryReports).toHaveLength(2), { timeout: 5_000 });
      } finally {
        advanceRetryClock.mockRestore();
      }
      expect(recoveryReports[1]).toMatchObject({
        version: 2,
        id: firstJobId,
        runId: `run-${firstJobId}`,
        attempt: 1,
        status: 'failed',
        baseSha,
        headSha: oldHead,
        sandbox: { cleanup: 'destroyed' },
        failure: { reason: 'cleanup' },
      });
      phase = 'replacement';
      runner.enqueue(jobBody(replacementJobId, newHead));
      const replacement = await waitForTerminal(runner, replacementJobId);
      expect(replacement).toMatchObject({
        status: 'failed',
        failure: { reason: 'checkout' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(await readFile(callbackPath, 'utf8')).toBe(originalCallback);
      expect(await readFile(manifestPath, 'utf8')).toBe(originalManifest);
    } finally {
      releaseRecoveryRetry();
      await runner.close();
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
    }
  });

  it('stops automatic cleanup delivery after a permanent Core rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-permanent-recovery-rejection-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const baseSha = '1'.repeat(40);
    const headSha = '2'.repeat(40);
    const jobId = 'permanent-recovery-job';
    let backendUp = true;
    let reports = 0;
    const commands: string[][] = [];
    const events: unknown[] = [];
    const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    const authFailure = { ...ok, exitCode: 1, stderr: 'not signed in' };
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: root,
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      claimIntervalMs: 2,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async (_input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '{}';
        const parsed = JSON.parse(body) as {
          status?: string;
          sandbox?: { cleanup?: string };
        };
        if (parsed.status === 'failed' && parsed.sandbox?.cleanup === 'destroyed') reports += 1;
        return new Response(null, { status: 403 });
      },
      log: { record: (event) => void events.push(event) },
      process: async (_command, args) => {
        commands.push([...args]);
        if (args[0] === 'ls') return backendUp ? ok : authFailure;
        if (args[0] === 'secret' && args[1] === 'set-custom') {
          backendUp = false;
          return authFailure;
        }
        if (!backendUp) return authFailure;
        const proof = sbxNativeProof(args);
        if (proof !== undefined) return proof;
        if (args[0] === 'inspect')
          return { ...ok, exitCode: 1, stderr: `error: sandbox '${args[1]}' not found` };
        if (args[0] === 'policy' && args[1] === 'ls') return { ...ok, stdout: '{"rules":[]}' };
        if (args.includes('rev-parse')) return { ...ok, stdout: `${baseSha}\n${headSha}\n` };
        return ok;
      },
    });
    try {
      runner.enqueue({
        ...runnerJobFields,
        id: jobId,
        runId: 'run-permanent-recovery',
        attempt: 1,
        pullRequestNumber: 47,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      });
      expect(await waitForTerminal(runner, jobId)).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });
      backendUp = true;
      await vi.waitFor(() => expect(reports).toBe(1));
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            phase: 'runner',
            outcome: 'callback',
            runId: 'run-permanent-recovery',
            jobId,
            attempt: 1,
            result: 'http-error',
            status: 403,
          }),
        ),
      );
      const recoveryCommands = commands.filter(
        (args) => args[0] === 'inspect' || (args[0] === 'policy' && args[1] === 'ls'),
      ).length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(reports).toBe(1);
      const advanceRetryClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(reports).toBe(1);
        expect(
          commands.filter(
            (args) => args[0] === 'inspect' || (args[0] === 'policy' && args[1] === 'ls'),
          ),
        ).toHaveLength(recoveryCommands);
      } finally {
        advanceRetryClock.mockRestore();
      }
    } finally {
      await runner.close();
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
    }
  });

  it('never replays the original callback after a permanent 409 recovery rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-permanent-409-recovery-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const baseSha = '1'.repeat(40);
    const headSha = '2'.repeat(40);
    const jobId = 'permanent-409-job';
    let backendUp = true;
    let recoveryReports = 0;
    const originalBodies: string[] = [];
    const events: unknown[] = [];
    const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    const authFailure = { ...ok, exitCode: 1, stderr: 'not signed in' };
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: root,
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      claimIntervalMs: 2,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async (_input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '{}';
        const parsed = JSON.parse(body) as {
          status?: string;
          sandbox?: { cleanup?: string };
        };
        if (parsed.status === 'failed' && parsed.sandbox?.cleanup === 'destroyed') {
          recoveryReports += 1;
          return new Response(null, { status: 409 });
        }
        originalBodies.push(body);
        return new Response(null, { status: 202 });
      },
      log: { record: (event) => void events.push(event) },
      process: async (_command, args) => {
        if (args[0] === 'ls') return backendUp ? ok : authFailure;
        if (args[0] === 'secret' && args[1] === 'set-custom') {
          backendUp = false;
          return authFailure;
        }
        if (!backendUp) return authFailure;
        const proof = sbxNativeProof(args);
        if (proof !== undefined) return proof;
        if (args[0] === 'inspect')
          return { ...ok, exitCode: 1, stderr: `error: sandbox '${args[1]}' not found` };
        if (args[0] === 'policy' && args[1] === 'ls') return { ...ok, stdout: '{"rules":[]}' };
        if (args.includes('rev-parse')) return { ...ok, stdout: `${baseSha}\n${headSha}\n` };
        return ok;
      },
    });
    try {
      runner.enqueue({
        ...runnerJobFields,
        id: jobId,
        runId: 'run-permanent-409',
        attempt: 1,
        pullRequestNumber: 49,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      });
      expect(await waitForTerminal(runner, jobId)).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });
      backendUp = true;
      await vi.waitFor(() => expect(recoveryReports).toBe(1));
      expect(originalBodies).toHaveLength(1);
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            phase: 'runner',
            outcome: 'callback',
            runId: 'run-permanent-409',
            jobId,
            result: 'http-error',
            status: 409,
          }),
        ),
      );
      const advanceRetryClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(recoveryReports).toBe(1);
        expect(originalBodies).toHaveLength(1);
      } finally {
        advanceRetryClock.mockRestore();
      }
      const retained = await runner.handle(
        new Request(`http://runner/jobs/${jobId}`, {
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      );
      expect(await retained.json()).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });
    } finally {
      await runner.close();
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
    }
  });

  it('keeps unrelated claims moving after a single job cleanup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-single-cleanup-failure-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const baseSha = '1'.repeat(40);
    const firstHead = '2'.repeat(40);
    const unrelatedHead = '3'.repeat(40);
    const firstJobId = 'single-cleanup-failed-job';
    const unrelatedJobId = 'single-cleanup-unrelated-job';
    let phase: 'first' | 'unrelated' = 'first';
    let setupFailed = false;
    const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    const authFailure = { ...ok, exitCode: 1, stderr: 'not signed in' };
    const jobBody = (id: string, pullRequestNumber: number, headSha: string) => ({
      ...runnerJobFields,
      id,
      runId: `run-${id}`,
      attempt: 1,
      pullRequestNumber,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    });
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: root,
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      claimIntervalMs: 2,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async () => new Response(null, { status: 202 }),
      process: async (_command, args) => {
        if (args[0] === 'ls') return ok;
        if (args[0] === 'secret' && args[1] === 'set-custom' && phase === 'first') {
          setupFailed = true;
          return authFailure;
        }
        if (args[0] === 'policy' && args[1] === 'ls' && setupFailed && phase === 'first')
          return authFailure;
        if (args[0] === 'inspect') return ok;
        if (args.includes('rev-parse'))
          return {
            ...ok,
            stdout:
              phase === 'first' ? `${baseSha}\n${firstHead}\n` : `${baseSha}\n${'4'.repeat(40)}\n`,
          };
        return ok;
      },
    });
    try {
      runner.enqueue(jobBody(firstJobId, 42, firstHead));
      expect(await waitForTerminal(runner, firstJobId)).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });

      phase = 'unrelated';
      runner.enqueue(jobBody(unrelatedJobId, 43, unrelatedHead));
      expect(await waitForTerminal(runner, unrelatedJobId)).toMatchObject({
        status: 'failed',
        failure: { reason: 'checkout' },
      });
      const status = (await (
        await runner.handle(
          new Request('http://runner/maintenance', {
            headers: { authorization: 'Bearer runner-test-token' },
          }),
        )
      ).json()) as { claimPollingHalted: boolean };
      expect(status.claimPollingHalted).toBe(false);
    } finally {
      await runner.close();
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
    }
  });

  it('recovers a failed cleanup while drained', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-direct-drain-recovery-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const baseSha = '1'.repeat(40);
    const headSha = '2'.repeat(40);
    const jobId = 'direct-drain-recovery-job';
    let backendUp = true;
    const reports: Array<Record<string, unknown>> = [];
    const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    const authFailure = { ...ok, exitCode: 1, stderr: 'not signed in' };
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: root,
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      claimIntervalMs: 5,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async (_input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '{}';
        const parsed = JSON.parse(body) as {
          status?: string;
          sandbox?: { cleanup?: string };
        };
        if (parsed.status === 'failed' && parsed.sandbox?.cleanup === 'destroyed') {
          reports.push(JSON.parse(body) as Record<string, unknown>);
        }
        return new Response(null, { status: 202 });
      },
      process: async (_command, args) => {
        if (args[0] === 'ls') return backendUp ? ok : authFailure;
        if (args[0] === 'secret' && args[1] === 'set-custom') {
          backendUp = false;
          return authFailure;
        }
        if (!backendUp) return authFailure;
        const proof = sbxNativeProof(args);
        if (proof !== undefined) return proof;
        if (args[0] === 'policy' && args[1] === 'ls') return { ...ok, stdout: '{"rules":[]}' };
        if (args[0] === 'inspect')
          return { ...ok, exitCode: 1, stderr: `error: sandbox '${args[1]}' not found` };
        if (args.includes('rev-parse')) return { ...ok, stdout: `${baseSha}\n${headSha}\n` };
        return ok;
      },
    });
    try {
      runner.enqueue({
        ...runnerJobFields,
        id: jobId,
        runId: 'run-direct-drain-recovery',
        attempt: 1,
        pullRequestNumber: 46,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      });
      expect(await waitForTerminal(runner, jobId)).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });
      const drain = (await (
        await runner.handle(
          new Request('http://runner/maintenance/drain', {
            method: 'POST',
            headers: { authorization: 'Bearer runner-test-token' },
          }),
        )
      ).json()) as { draining: boolean; drained: boolean };
      expect(drain).toMatchObject({ draining: true, drained: false });

      backendUp = true;
      await vi.waitFor(() => expect(reports).toHaveLength(1), { timeout: 5_000 });
      await vi.waitFor(async () => {
        const status = (await (
          await runner.handle(
            new Request('http://runner/maintenance', {
              headers: { authorization: 'Bearer runner-test-token' },
            }),
          )
        ).json()) as { draining: boolean; drained: boolean; cleanupBlockedJobs: number };
        expect(status).toMatchObject({
          draining: true,
          drained: true,
          cleanupBlockedJobs: 0,
        });
      });
      expect(reports[0]).toMatchObject({
        id: jobId,
        runId: 'run-direct-drain-recovery',
        attempt: 1,
        status: 'failed',
        baseSha,
        headSha,
        sandbox: { cleanup: 'destroyed' },
      });
    } finally {
      await runner.close();
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
    }
  });

  it('stages an in-flight claim across a confirmed outage for replay after recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-inflight-claim-outage-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const baseSha = '1'.repeat(40);
    const directHead = '2'.repeat(40);
    const claimedHead = '3'.repeat(40);
    const directJobId = 'inflight-outage-direct';
    const claimedJobId = 'inflight-outage-claimed';
    let backendUp = true;
    let phase: 'direct' | 'claimed' = 'direct';
    let releaseFirstClaim!: () => void;
    let firstClaimServed!: () => void;
    const firstClaimGate = new Promise<void>((resolve) => {
      releaseFirstClaim = resolve;
    });
    const firstClaimObserved = new Promise<void>((resolve) => {
      firstClaimServed = resolve;
    });
    let secondClaimServed!: () => void;
    const secondClaimObserved = new Promise<void>((resolve) => {
      secondClaimServed = resolve;
    });
    let replayed = false;
    const claimRequests: Array<{ requestId?: string }> = [];
    const events: Array<Record<string, unknown>> = [];
    const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    const authFailure = { ...ok, exitCode: 1, stderr: 'not signed in' };
    const jobBody = (id: string, pullRequestNumber: number, headSha: string) => ({
      ...runnerJobFields,
      id,
      runId: `run-${id}`,
      attempt: 1,
      pullRequestNumber,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    });
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: root,
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      concurrency: 2,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 2,
      claimFetch: async (_input, init) => {
        const body =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as { requestId?: string }) : {};
        claimRequests.push(body);
        if (claimRequests.length === 1) return Response.json(jobBody(directJobId, 44, directHead));
        if (claimRequests.length === 2) {
          secondClaimServed();
          await firstClaimGate;
          firstClaimServed();
          return Response.json(jobBody(claimedJobId, 45, claimedHead));
        }
        if (claimRequests.length === 3 && !replayed) {
          replayed = true;
          return Response.json(jobBody(claimedJobId, 45, claimedHead));
        }
        return new Response(null, { status: 204 });
      },
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async () => new Response(null, { status: 202 }),
      log: {
        record: async (event) => {
          events.push(event as Record<string, unknown>);
        },
      },
      process: async (_command, args) => {
        if (args[0] === 'ls') return backendUp ? ok : authFailure;
        if (args[0] === 'secret' && args[1] === 'set-custom' && phase === 'direct') {
          await secondClaimObserved;
          backendUp = false;
          return authFailure;
        }
        if (!backendUp) return authFailure;
        const proof = sbxNativeProof(args);
        if (proof !== undefined) return proof;
        if (args[0] === 'policy' && args[1] === 'ls') return { ...ok, stdout: '{"rules":[]}' };
        if (args[0] === 'inspect')
          return { ...ok, exitCode: 1, stderr: `error: sandbox '${args[1]}' not found` };
        if (args.includes('rev-parse'))
          return {
            ...ok,
            stdout:
              phase === 'direct'
                ? `${baseSha}\n${directHead}\n`
                : `${baseSha}\n${'4'.repeat(40)}\n`,
          };
        return ok;
      },
    });
    try {
      expect(await waitForTerminal(runner, directJobId)).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });
      await vi.waitFor(async () => {
        const status = (await (
          await runner.handle(
            new Request('http://runner/maintenance', {
              headers: { authorization: 'Bearer runner-test-token' },
            }),
          )
        ).json()) as { claimPollingHalted: boolean };
        expect(status.claimPollingHalted).toBe(true);
      });

      releaseFirstClaim();
      await firstClaimObserved;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        (
          await runner.handle(
            new Request(`http://runner/jobs/${claimedJobId}`, {
              headers: { authorization: 'Bearer runner-test-token' },
            }),
          )
        ).status,
      ).toBe(404);
      const drain = (await (
        await runner.handle(
          new Request('http://runner/maintenance/drain', {
            method: 'POST',
            headers: { authorization: 'Bearer runner-test-token' },
          }),
        )
      ).json()) as { draining: boolean; drained: boolean };
      expect(drain).toMatchObject({ draining: true, drained: false });
      const claimsAfterDrain = claimRequests.length;

      phase = 'claimed';
      backendUp = true;
      const resumed = await runner.handle(
        new Request('http://runner/maintenance/resume', {
          method: 'POST',
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      );
      expect(resumed.status).toBe(200);
      await vi.waitFor(() =>
        expect(claimRequests.length).toBeGreaterThanOrEqual(claimsAfterDrain + 1),
      );
      expect(claimRequests[claimsAfterDrain]?.requestId).toBe(
        claimRequests[claimsAfterDrain - 1]?.requestId,
      );
      expect(await waitForTerminal(runner, claimedJobId)).toMatchObject({
        status: 'failed',
        failure: { reason: 'checkout' },
        sandbox: { cleanup: 'destroyed' },
      });
      await vi.waitFor(async () => {
        const finalDrain = (await (
          await runner.handle(
            new Request('http://runner/maintenance/drain', {
              method: 'POST',
              headers: { authorization: 'Bearer runner-test-token' },
            }),
          )
        ).json()) as { draining: boolean; drained: boolean };
        expect(finalDrain).toMatchObject({ draining: true, drained: true });
      });
      expect(claimRequests.length).toBeGreaterThanOrEqual(claimsAfterDrain + 1);
      expect(events.filter((event) => event.reason === 'backend-outage')).toEqual([
        expect.objectContaining({
          phase: 'runner',
          outcome: 'claim',
          reason: 'backend-outage',
          staged: true,
          pollingHalted: true,
        }),
      ]);
    } finally {
      releaseFirstClaim();
      await runner.close();
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
    }
  });

  it('keeps deferred cleanup recovery pending while polling races cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-cleanup-recovery-race-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const baseSha = '1'.repeat(40);
    const headSha = '2'.repeat(40);
    const jobId = 'cleanup-recovery-race-job';
    const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    let cleanupFailedOnce = false;
    const reports: Array<Record<string, unknown>> = [];
    let releaseProbe!: () => void;
    let probeStarted!: () => void;
    const probing = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: root,
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      concurrency: 2,
      claimIntervalMs: 2,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async (_input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '{}';
        const parsed = JSON.parse(body) as {
          status?: string;
          sandbox?: { cleanup?: string };
        };
        if (parsed.status === 'failed' && parsed.sandbox?.cleanup === 'destroyed') {
          reports.push(JSON.parse(body) as Record<string, unknown>);
        }
        return new Response(null, { status: 202 });
      },
      process: async (_command, args) => {
        if (args[0] === 'ls') {
          probeStarted();
          await probeGate;
          return ok;
        }
        if (args[0] === 'secret' && args[1] === 'set-custom')
          return { ...ok, exitCode: 1, stderr: 'setup failed' };
        const proof = sbxNativeProof(args);
        if (proof !== undefined) return proof;
        if (args[0] === 'policy' && args[1] === 'ls') {
          if (!cleanupFailedOnce) {
            cleanupFailedOnce = true;
            return { ...ok, exitCode: 1, stderr: 'inventory failed' };
          }
          return { ...ok, stdout: '{"rules":[]}' };
        }
        if (args[0] === 'inspect')
          return { ...ok, exitCode: 1, stderr: `error: sandbox '${args[1]}' not found` };
        if (args.includes('rev-parse')) return { ...ok, stdout: `${baseSha}\n${headSha}\n` };
        return ok;
      },
    });
    try {
      runner.enqueue({
        ...runnerJobFields,
        id: jobId,
        runId: 'run-cleanup-recovery-race',
        attempt: 1,
        pullRequestNumber: 44,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      });
      await probing;
      const claimsWhileCleaning = runner.claimExecution?.claimRequests.length ?? 0;
      await vi.waitFor(() =>
        expect(runner.claimExecution?.claimRequests.length ?? 0).toBeGreaterThan(
          claimsWhileCleaning,
        ),
      );
      releaseProbe();
      expect(await waitForTerminal(runner, jobId)).toMatchObject({ status: 'failed' });
      await vi.waitFor(() => expect(reports).toHaveLength(1));
      expect(reports[0]).toMatchObject({
        id: jobId,
        runId: 'run-cleanup-recovery-race',
        attempt: 1,
        status: 'failed',
        baseSha,
        headSha,
      });
    } finally {
      releaseProbe();
      await runner.close();
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
    }
  });

  it('records the real failure and unlocks the same PR through real Core after confirmed teardown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-core-outage-recovery-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const baseSha = '1'.repeat(40);
    const oldHead = '2'.repeat(40);
    const newHead = '3'.repeat(40);
    let pulledJobId = '';
    let claimTargetHead = oldHead;
    let backendUp = true;
    const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    const authFailure = { ...ok, exitCode: 1, stderr: 'not signed in' };
    const waitUntilTasks: Promise<unknown>[] = [];
    const comments: string[] = [];
    const reactions: string[] = [];
    const checkUpdates: string[] = [];
    const env = {
      REVIEW_DB: database,
      GITHUB_APP_ID: '1234567',
      GITHUB_APP_PRIVATE_KEY: 'test-private-key',
      EVIDENCE_BUCKET: { put: async () => undefined },
    };
    const dispatch = (request: Request) =>
      createCoreWorker(env, {
        github: {
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          loadReviewTarget: async () => ({ headSha: claimTargetHead }),
          createIssueComment: async ({ body }) => {
            comments.push(body);
            return { id: 123, body };
          },
          addReaction: async ({ content }) => {
            reactions.push(content);
          },
          updateCheckRun: async ({ status }) => {
            checkUpdates.push(status);
          },
        },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2030-01-01T00:00:00.000Z',
        }),
      }).fetch(request, env, {
        waitUntil: (task) => {
          waitUntilTasks.push(task);
        },
      });
    const coreClaim = async () => {
      const response = await dispatch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
          body: '{}',
        }),
      );
      await Promise.all(waitUntilTasks.splice(0));
      return response;
    };
    const postCoreCallback = async (body: string) => {
      const response = await dispatch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body,
        }),
      );
      await Promise.all(waitUntilTasks.splice(0));
      return response;
    };
    const originalBodies: string[] = [];
    let recoveryBody = '';
    const callbackFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : String(input),
      );
      if (url.pathname !== '/runner-callback') return new Response(null, { status: 202 });
      const body = typeof init?.body === 'string' ? init.body : '';
      const parsed = JSON.parse(body) as {
        status?: string;
        sandbox?: { cleanup?: string };
      };
      if (parsed.status === 'failed' && parsed.sandbox?.cleanup === 'failed') {
        // The original terminal result never reaches Core. The retained local
        // archive is the only source until teardown is confirmed.
        originalBodies.push(body);
        return new Response(null, { status: 503 });
      }
      if (parsed.status === 'failed' && parsed.sandbox?.cleanup === 'destroyed')
        recoveryBody = body;
      return postCoreCallback(body);
    };
    let firstPullTaken = false;
    let replacementRunId = '';
    try {
      const old = await stateStore.claimReview({
        deliveryId: 'core-outage-old',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 42,
          baseSha,
          headSha: oldHead,
          trigger: 'automatic',
        },
        occurredAt: new Date().toISOString(),
      });
      if (old.kind !== 'claimed') throw new Error('old review was not claimed');
      expect(await stateStore.recordCheckRun({ runId: old.runId, checkRunId: 321 })).toBe(true);
      const runner = createProductionRunnerWithMergeBase({
        evidenceRoot: root,
        authToken: 'runner-test-token',
        modelConfig: standardModelConfig,
        claimUrl: 'https://ingress.test/runner-claim',
        claimIntervalMs: 2,
        claimFetch: async () => {
          if (firstPullTaken) return new Response(null, { status: 204 });
          firstPullTaken = true;
          const response = await coreClaim();
          if (response.status === 200) {
            const payload = (await response.clone().json()) as { id: string };
            pulledJobId = payload.id;
          }
          return response;
        },
        callbackUrl: 'https://ingress.test/runner-callback',
        callbackToken: 'callback-token',
        callbackRetryDelaysMs: [0, 0, 0, 0, 0],
        callbackFetch,
        process: async (_command, args) => {
          if (args[0] === 'ls') return backendUp ? ok : authFailure;
          if (!backendUp) return authFailure;
          const proof = sbxNativeProof(args);
          if (proof !== undefined) return proof;
          if (args[0] === 'secret' && args[1] === 'set-custom') {
            backendUp = false;
            return authFailure;
          }
          if (args[0] === 'inspect')
            return { ...ok, exitCode: 1, stderr: `error: sandbox '${args[1]}' not found` };
          if (args[0] === 'policy' && args[1] === 'ls') return { ...ok, stdout: '{"rules":[]}' };
          if (args.includes('rev-parse')) return { ...ok, stdout: `${baseSha}\n${oldHead}\n` };
          return ok;
        },
      });
      try {
        await vi.waitFor(() => expect(pulledJobId).not.toBe(''));
        expect(await waitForTerminal(runner, pulledJobId)).toMatchObject({
          status: 'failed',
          sandbox: { cleanup: 'failed' },
        });
        await vi.waitFor(() => expect(originalBodies.length).toBeGreaterThan(0));
        const original = JSON.parse(originalBodies[0]!) as {
          failure: { reason: string };
          sandbox: { cleanup: string };
        };
        expect(original.sandbox.cleanup).toBe('failed');
        const expectedReason =
          original.failure.reason === 'invalid-output' ? 'invalid_output' : original.failure.reason;
        backendUp = true;
        await vi.waitFor(
          async () => {
            expect(await stateStore.getPublicRun(old.runId)).toMatchObject({
              status: 'failed',
              runnerCleanupStatus: 'destroyed',
              failureReason: expectedReason,
              runnerJobId: pulledJobId,
            });
          },
          { timeout: 5_000 },
        );
        expect(recoveryBody).not.toBe('');
        const recovered = await stateStore.getPublicRun(old.runId);
        expect(recovered?.resultReceivedAt).toBeTruthy();
        expect(recovered?.cleanupCompletedAt).toBeTruthy();
        expect(comments).toHaveLength(1);
        expect(reactions).toEqual([]);
        expect(checkUpdates).toEqual(['in_progress', 'failure']);

        // A repeated real failure callback cannot regress the confirmed teardown
        // or duplicate comments; its terminal Check write stays best effort.
        expect((await postCoreCallback(recoveryBody)).status).toBe(202);
        const repeated = await stateStore.getPublicRun(old.runId);
        expect(repeated).toMatchObject({
          status: 'failed',
          runnerCleanupStatus: 'destroyed',
          failureReason: expectedReason,
        });
        expect(repeated?.cleanupCompletedAt).toBe(recovered?.cleanupCompletedAt);
        expect(repeated?.resultReceivedAt).toBe(recovered?.resultReceivedAt);
        expect(repeated?.terminalAt).toBe(recovered?.terminalAt);
        expect(comments).toHaveLength(1);
        expect(checkUpdates).toEqual(['in_progress', 'failure', 'failure']);

        // The delayed original callback still reports the failed cleanup, but
        // the already-confirmed destruction wins monotonically.
        expect((await postCoreCallback(originalBodies[0]!)).status).toBe(202);
        const delayed = await stateStore.getPublicRun(old.runId);
        expect(delayed).toMatchObject({
          status: 'failed',
          runnerCleanupStatus: 'destroyed',
          failureReason: expectedReason,
        });
        expect(delayed?.cleanupCompletedAt).toBe(recovered?.cleanupCompletedAt);
        expect(delayed?.resultReceivedAt).toBe(recovered?.resultReceivedAt);
        expect(comments).toHaveLength(1);
        expect(reactions).toEqual([]);
        expect(checkUpdates).toEqual(['in_progress', 'failure', 'failure', 'failure']);

        claimTargetHead = newHead;
        const replacement = await stateStore.claimReview({
          deliveryId: 'core-outage-new',
          job: {
            repositoryId: 11,
            installationId: 7,
            pullRequestNumber: 42,
            baseSha,
            headSha: newHead,
            trigger: 'automatic',
          },
          occurredAt: new Date().toISOString(),
        });
        if (replacement.kind !== 'claimed') throw new Error('replacement was not scheduled');
        replacementRunId = replacement.runId;
        const released = await coreClaim();
        expect(released.status).toBe(200);
        expect(await released.json()).toMatchObject({
          runId: replacementRunId,
          pullRequestNumber: 42,
          headSha: newHead,
        });
        const drain = await runner.handle(
          new Request('http://runner/maintenance/drain', {
            method: 'POST',
            headers: { authorization: 'Bearer runner-test-token' },
          }),
        );
        expect(drain.status).toBe(200);
        await vi.waitFor(async () => {
          const status = (await (
            await runner.handle(
              new Request('http://runner/maintenance', {
                headers: { authorization: 'Bearer runner-test-token' },
              }),
            )
          ).json()) as { draining: boolean; drained: boolean };
          expect(status).toMatchObject({ draining: true, drained: true });
        });
      } finally {
        await runner.close();
      }
    } finally {
      database.close();
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
    }
  });
});

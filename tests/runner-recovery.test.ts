import { createHash } from 'node:crypto';
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

describe('Runner callback recovery', () => {
  const auth = { authorization: 'Bearer runner-test-token' };
  const baseSha = '1'.repeat(40);
  const headSha = '2'.repeat(40);
  const replayIdentity = (evidenceId: string, overrides: Record<string, unknown> = {}) => ({
    evidenceId,
    jobId: runnerJobFields.id,
    runId: 'run-callback-retained',
    attempt: 1,
    baseSha,
    headSha,
    ...overrides,
  });

  it('delivers the callback when the recovery copy cannot be persisted', async () => {
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

  const replay = (
    runner: ReturnType<typeof createRunner>,
    identity: Record<string, unknown>,
    authorized = true,
  ) =>
    runner.handle(
      new Request('http://runner/maintenance/replay-callback', {
        method: 'POST',
        headers: {
          ...(authorized ? auth : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify(identity),
      }),
    );

  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

  const prepareArchive = async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-callback-recovery-'));
    const requests: Request[] = [];
    const result = await runAgentScenario({
      runId: 'run-callback-retained',
      output: finalMarkdownJsonl(),
      evidenceRoot,
      callbackRequests: requests,
      callbackStatuses: [503, 503],
    });
    const evidenceId = result.terminal.evidenceId as string;
    return {
      evidenceRoot,
      evidenceId,
      retained: await readFile(join(evidenceRoot, evidenceId, 'callback.json'), 'utf8'),
    };
  };

  const replayRunner = (evidenceRoot: string) => {
    const requests: Request[] = [];
    let processCalls = 0;
    const runner = createRunner({
      authToken: 'runner-test-token',
      evidenceRoot,
      claimUrl: '',
      callbackFetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 202 });
      },
      process: async () => {
        processCalls += 1;
        return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
      },
    });
    return { runner, requests, processCalls: () => processCalls };
  };

  const rewriteCallback = async (
    evidenceRoot: string,
    evidenceId: string,
    mutate: (callback: Record<string, any>) => void,
  ) => {
    const path = join(evidenceRoot, evidenceId, 'callback.json');
    const callback = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
    mutate(callback);
    const next = join(evidenceRoot, evidenceId, 'callback.json.next');
    await writeFile(next, JSON.stringify(callback), { mode: 0o600 });
    await rename(next, path);
  };

  const rewriteManifest = (callback: Record<string, any>, mutate: (manifest: any) => void) => {
    const bytes = Buffer.from(callback.evidence.manifest.content, 'base64');
    const manifest = JSON.parse(bytes.toString('utf8'));
    mutate(manifest);
    const next = Buffer.from(JSON.stringify(manifest));
    callback.evidence.manifest = {
      content: next.toString('base64'),
      size: next.byteLength,
      sha256: sha256(next),
    };
  };

  it('rejects an unauthenticated callback replay before delivery', async () => {
    let deliveries = 0;
    const runner = createRunner({
      authToken: 'runner-test-token',
      claimUrl: '',
      callbackFetch: async () => {
        deliveries += 1;
        return new Response(null, { status: 202 });
      },
    });
    try {
      expect(
        (await replay(runner, replayIdentity('00000000-0000-4000-8000-000000000000'), false))
          .status,
      ).toBe(401);
      const wrongToken = await runner.handle(
        new Request('http://runner/maintenance/replay-callback', {
          method: 'POST',
          headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
          body: JSON.stringify(replayIdentity('00000000-0000-4000-8000-000000000000')),
        }),
      );
      expect(wrongToken.status).toBe(401);
      expect(deliveries).toBe(0);
    } finally {
      await runner.close();
    }
  });

  it('rejects mismatched identity and revision before delivery', async () => {
    const archive = await prepareArchive();
    const { runner, requests } = replayRunner(archive.evidenceRoot);
    try {
      for (const identity of [
        replayIdentity(archive.evidenceId, { jobId: 'other-job' }),
        replayIdentity(archive.evidenceId, { runId: 'other-run' }),
        replayIdentity(archive.evidenceId, { attempt: 2 }),
        replayIdentity(archive.evidenceId, { baseSha: '3'.repeat(40) }),
        replayIdentity(archive.evidenceId, { headSha: '4'.repeat(40) }),
      ]) {
        const response = await replay(runner, identity);
        expect(response.status).toBe(409);
      }
      expect(requests).toHaveLength(0);

      await rewriteCallback(archive.evidenceRoot, archive.evidenceId, (callback) => {
        rewriteManifest(callback, (manifest) => {
          manifest.baseSha = '3'.repeat(40);
        });
      });
      const manifestMismatch = await replay(runner, replayIdentity(archive.evidenceId));
      expect(manifestMismatch.status).toBe(409);
      expect(await manifestMismatch.json()).toMatchObject({ reason: 'identity-mismatch' });
      expect(requests).toHaveLength(0);
    } finally {
      await runner.close();
      await rm(archive.evidenceRoot, { recursive: true, force: true });
    }
  });

  it('rejects unconfirmed cleanup before delivery', async () => {
    const archive = await prepareArchive();
    const { runner, requests } = replayRunner(archive.evidenceRoot);
    try {
      await rewriteCallback(archive.evidenceRoot, archive.evidenceId, (callback) => {
        rewriteManifest(callback, (manifest) => {
          manifest.cleanup.status = 'failed';
        });
      });
      const response = await replay(runner, replayIdentity(archive.evidenceId));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: 'cleanup-not-confirmed' });
      expect(requests).toHaveLength(0);
    } finally {
      await runner.close();
      await rm(archive.evidenceRoot, { recursive: true, force: true });
    }
  });

  it('rejects a manifest result that differs from the retained callback', async () => {
    const archive = await prepareArchive();
    const { runner, requests } = replayRunner(archive.evidenceRoot);
    try {
      await rewriteCallback(archive.evidenceRoot, archive.evidenceId, (callback) => {
        rewriteManifest(callback, (manifest) => {
          manifest.result.decision = 'approve';
        });
      });
      const response = await replay(runner, replayIdentity(archive.evidenceId));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: 'result-mismatch' });
      expect(requests).toHaveLength(0);
    } finally {
      await runner.close();
      await rm(archive.evidenceRoot, { recursive: true, force: true });
    }
  });

  it('rejects oversized or invalid retained callbacks before delivery', async () => {
    const archive = await prepareArchive();
    const { runner, requests } = replayRunner(archive.evidenceRoot);
    try {
      const oversizedId = '22222222-2222-4222-8222-222222222222';
      const oversized = join(archive.evidenceRoot, oversizedId);
      await mkdir(oversized);
      await writeFile(join(oversized, 'callback.json'), Buffer.alloc(32 * 1024 * 1024 + 1, 0x20), {
        mode: 0o600,
      });
      const oversizedResponse = await replay(runner, replayIdentity(oversizedId));
      expect(oversizedResponse.status).toBe(413);
      expect(await oversizedResponse.json()).toMatchObject({ reason: 'oversized-callback' });

      const invalidId = '33333333-3333-4333-8333-333333333333';
      const invalid = join(archive.evidenceRoot, invalidId);
      await mkdir(invalid);
      await writeFile(join(invalid, 'callback.json'), '{}', { mode: 0o600 });
      const invalidResponse = await replay(runner, replayIdentity(invalidId));
      expect(invalidResponse.status).toBe(409);
      expect(await invalidResponse.json()).toMatchObject({ reason: 'invalid-callback' });
      expect(requests).toHaveLength(0);
    } finally {
      await runner.close();
      await rm(archive.evidenceRoot, { recursive: true, force: true });
    }
  });

  it('rejects missing, legacy and non-UUID archives before delivery', async () => {
    const archive = await prepareArchive();
    const { runner, requests } = replayRunner(archive.evidenceRoot);
    try {
      const missing = await replay(runner, replayIdentity('00000000-0000-4000-8000-000000000000'));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ reason: 'missing-evidence' });

      const legacyId = '11111111-1111-4111-8111-111111111111';
      await mkdir(join(archive.evidenceRoot, legacyId));
      const legacy = await replay(runner, replayIdentity(legacyId));
      expect(legacy.status).toBe(409);
      expect(await legacy.json()).toMatchObject({ reason: 'missing-callback' });

      const traversal = await replay(runner, replayIdentity('../outside'));
      expect(traversal.status).toBe(400);
      expect(await traversal.json()).toMatchObject({ reason: 'invalid-request' });
      expect(requests).toHaveLength(0);
    } finally {
      await runner.close();
      await rm(archive.evidenceRoot, { recursive: true, force: true });
    }
  });

  it('rejects the active attempt but delivers an older attempt from the same run', async () => {
    const archive = await prepareArchive();
    const callbackRequests: Request[] = [];
    let releaseAgent: () => void = () => {};
    const agentGate = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    let signalAgentStarted: () => void = () => {};
    const agentStarted = new Promise<void>((resolve) => {
      signalAgentStarted = resolve;
    });
    let activeRunner: ReturnType<typeof createRunner> | undefined;
    try {
      const scenario = runAgentScenario({
        runId: 'run-callback-retained',
        jobId: 'active-attempt-job',
        attempt: 2,
        output: finalMarkdownJsonl(),
        evidenceRoot: archive.evidenceRoot,
        callbackRequests,
        agentGate,
        onAgentStart: () => signalAgentStarted(),
        onRunner: (runner) => {
          activeRunner = runner;
        },
      });
      await agentStarted;

      const active = await replay(
        activeRunner!,
        replayIdentity('00000000-0000-4000-8000-000000000000', {
          jobId: 'other-job',
          runId: 'run-callback-retained',
          attempt: 2,
        }),
      );
      expect(active.status).toBe(409);
      expect(await active.json()).toEqual({
        accepted: false,
        error: 'job is active',
        reason: 'active-job',
      });
      expect(callbackRequests).toHaveLength(0);

      const older = await replay(activeRunner!, replayIdentity(archive.evidenceId));
      expect(older.status).toBe(202);
      expect(await older.json()).toEqual({ accepted: true });
      expect(callbackRequests).toHaveLength(1);
      expect(await callbackRequests[0]!.clone().text()).toBe(archive.retained);

      releaseAgent();
      await scenario;
    } finally {
      releaseAgent();
      await activeRunner?.close();
      await rm(archive.evidenceRoot, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 10,
      });
    }
  });

  it('records only safe replay diagnostics and accepts only HTTP 202', async () => {
    const archive = await prepareArchive();
    await rewriteCallback(archive.evidenceRoot, archive.evidenceId, (callback) => {
      callback.attempt = 2;
      rewriteManifest(callback, (manifest) => {
        manifest.attempt = 2;
      });
    });
    const identity = replayIdentity(archive.evidenceId, { attempt: 2 });
    const cases = [
      {
        fetch: async () => new Response(null, { status: 202 }),
        expectedStatus: 202,
        result: 'accepted',
        upstreamStatus: 202,
      },
      {
        fetch: async () => new Response('secret upstream body', { status: 500 }),
        expectedStatus: 502,
        result: 'http-error',
        upstreamStatus: 500,
      },
      {
        fetch: async () => {
          throw new Error('token callback-token');
        },
        expectedStatus: 502,
        result: 'transport-error',
      },
      {
        fetch: async () => new Promise<Response>(() => undefined),
        expectedStatus: 504,
        result: 'timeout',
        timeoutMs: 5,
      },
    ] as const;
    try {
      for (const scenario of cases) {
        const logEvents: Array<Record<string, unknown>> = [];
        const runner = createRunner({
          authToken: 'runner-test-token',
          evidenceRoot: archive.evidenceRoot,
          claimUrl: '',
          callbackTimeoutMs: 'timeoutMs' in scenario ? scenario.timeoutMs : undefined,
          callbackFetch: scenario.fetch,
          log: {
            record: async (event) => {
              logEvents.push(event as unknown as Record<string, unknown>);
            },
          },
        });
        try {
          const response = await replay(runner, identity);
          expect(response.status).toBe(scenario.expectedStatus);
          if (scenario.expectedStatus !== 202) {
            const body = (await response.json()) as Record<string, unknown>;
            expect(body).toMatchObject({ accepted: false, reason: scenario.result });
            expect(JSON.stringify(body)).not.toContain('callback-token');
          }
          expect(logEvents).toContainEqual({
            phase: 'runner',
            outcome: 'callback',
            runId: 'run-callback-retained',
            jobId: runnerJobFields.id,
            attempt: 1,
            result: scenario.result,
            ...('upstreamStatus' in scenario ? { status: scenario.upstreamStatus } : {}),
          });
          expect(JSON.stringify(logEvents)).not.toContain('callback-token');
          expect(JSON.stringify(logEvents)).not.toContain('secret upstream body');
        } finally {
          await runner.close();
        }
      }
    } finally {
      await rm(archive.evidenceRoot, { recursive: true, force: true });
    }
  });

  it('rejects tampered evidence artifacts before delivery', async () => {
    const archive = await prepareArchive();
    const { runner, requests } = replayRunner(archive.evidenceRoot);
    try {
      await rewriteCallback(archive.evidenceRoot, archive.evidenceId, (callback) => {
        callback.evidence.opencodeJsonl.content = Buffer.from('tampered').toString('base64');
      });
      const response = await replay(runner, replayIdentity(archive.evidenceId));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        accepted: false,
        error: 'callback recovery rejected',
        reason: 'integrity-mismatch',
      });
      expect(requests).toHaveLength(0);
    } finally {
      await runner.close();
      await rm(archive.evidenceRoot, { recursive: true, force: true });
    }
  });

  it('replays the retained callback after a restart without re-executing the job', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-callback-recovery-'));
    const originalRequests: Request[] = [];
    try {
      const result = await runAgentScenario({
        runId: 'run-callback-retained',
        output: finalMarkdownJsonl(),
        evidenceRoot,
        callbackRequests: originalRequests,
        callbackStatuses: [503, 503],
      });
      const evidenceId = result.terminal.evidenceId as string;
      const retained = await readFile(join(evidenceRoot, evidenceId, 'callback.json'), 'utf8');

      const replayRequests: Request[] = [];
      let processCalls = 0;
      const restarted = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        claimUrl: '',
        callbackFetch: async (input, init) => {
          replayRequests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
        process: async () => {
          processCalls += 1;
          return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
        },
      });
      try {
        const response = await replay(restarted, replayIdentity(evidenceId));
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ accepted: true });
        expect(replayRequests).toHaveLength(1);
        expect(replayRequests[0]!.url).toBe('https://ingress.test/runner-callback');
        expect(replayRequests[0]!.headers.get('authorization')).toBe('Bearer callback-token');
        expect(await replayRequests[0]!.clone().text()).toBe(retained);
        expect(processCalls).toBe(0);
        expect(await readFile(join(evidenceRoot, evidenceId, 'callback.json'), 'utf8')).toBe(
          retained,
        );
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('accepts a repeated replay and leaves Core to deduplicate publication', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-callback-recovery-'));
    const originalRequests: Request[] = [];
    try {
      const result = await runAgentScenario({
        runId: 'run-callback-retained',
        output: finalMarkdownJsonl(),
        evidenceRoot,
        callbackRequests: originalRequests,
        callbackStatuses: [503, 503],
      });
      const evidenceId = result.terminal.evidenceId as string;
      const retained = await readFile(join(evidenceRoot, evidenceId, 'callback.json'), 'utf8');
      const replayRequests: Request[] = [];
      const restarted = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        claimUrl: '',
        callbackFetch: async (input, init) => {
          replayRequests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
      });
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await replay(restarted, replayIdentity(evidenceId));
          expect(response.status).toBe(202);
          expect(await response.json()).toEqual({ accepted: true });
        }
        expect(replayRequests).toHaveLength(2);
        for (const request of replayRequests) {
          expect(await request.clone().text()).toBe(retained);
        }
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
          llmRelayGeneration: 'generation-a',
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

  it('recovers a retained microsandbox failure with the legacy catalog identity field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-legacy-proof-'));
    const relay = createRelayControl();
    const modelConfig = relayInferenceModelConfig('deepseek-review');
    const previousHome = process.env.MSB_HOME;
    process.env.MSB_HOME = root;
    await mkdir(join(root, 'db'));
    await writeFile(join(root, 'db', 'msb.db'), '');
    try {
      const failed = await runAgentScenario({
        microsandbox: true,
        output: finalMarkdownJsonl(),
        cleanupFailure: true,
        relayControl: relay,
        modelConfig,
        evidenceRoot: root,
        runId: 'msb-legacy-proof',
      });
      const evidenceId = failed.terminal.evidenceId as string;
      const callbackPath = join(root, evidenceId, 'callback.json');
      const callback = JSON.parse(await readFile(callbackPath, 'utf8'));
      const manifest = JSON.parse(
        Buffer.from(callback.evidence.manifest.content, 'base64').toString('utf8'),
      );
      const catalogIdentity = manifest.recoveryProof.catalogIdentity as string;
      delete manifest.recoveryProof;
      manifest.catalogIdentity = catalogIdentity;
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      callback.evidence.manifest = {
        content: manifestBytes.toString('base64'),
        size: manifestBytes.length,
        sha256: createHash('sha256').update(manifestBytes).digest('hex'),
      };
      await writeFile(callbackPath, JSON.stringify(callback));

      const reports: Request[] = [];
      vi.stubEnv('RUNNER_SANDBOX_RUNTIME', 'microsandbox');
      vi.stubEnv('MICROSANDBOX_IMAGE', 'review:fixture');
      const runner = createProductionRunnerWithMergeBase({
        authToken: 'runner-test-token',
        evidenceRoot: root,
        claimUrl: '',
        modelConfig,
        llmRelay: true,
        llmRelayGeneration: 'generation-a',
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
        const { runId, jobId, attempt, baseSha, headSha } = failed.manifest;
        const response = await runner.handle(
          new Request('http://runner/maintenance/recover-cleanup', {
            method: 'POST',
            headers: {
              authorization: 'Bearer runner-test-token',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ runId, jobId, evidenceId, attempt, baseSha, headSha }),
          }),
        );
        expect(response.status).toBe(202);
        expect(reports).toHaveLength(1);
        expect(new URL(reports[0]!.url).pathname).toBe('/runner-cleanup-recovery');
      } finally {
        await runner.close();
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
        onRunner: (started) => {
          runner = started;
        },
      });
      expect(scenario.terminal).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });
      const reports = () =>
        callbacks.filter((request) => new URL(request.url).pathname === '/runner-cleanup-recovery');
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
      const markerFiles = async () => {
        const owners = await readdir(join(root, 'sandbox-owners')).catch(() => []);
        const files: string[] = [];
        for (const owner of owners) {
          files.push(
            ...(await readdir(join(root, 'sandbox-owners', owner, 'microsandbox')).catch(() => [])),
          );
        }
        return files;
      };
      // A verification failure schedules the scoped owned reaper. It removes
      // the surviving VM and marker while the failed job stays mapped.
      await vi.waitFor(
        async () => {
          expect(await markerFiles()).toEqual([]);
          expect(await maintenance()).toMatchObject({ activeJobs: 0, cleanupBlockedJobs: 1 });
        },
        { timeout: 5_000 },
      );
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        now += 31_000;
        await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 5_000 });
        expect(await maintenance()).toMatchObject({ activeJobs: 0, cleanupBlockedJobs: 1 });
        now += 31_000;
        await vi.waitFor(() => expect(reports()).toHaveLength(2), { timeout: 5_000 });
      } finally {
        clock.mockRestore();
      }
      expect(await reports()[1]!.json()).toMatchObject({
        jobId: scenario.manifest.jobId,
        evidenceId: scenario.manifest.evidenceId,
        sandboxName: scenario.manifest.sandboxName,
      });
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
        const recoveryRequest = new Request('http://runner/maintenance/recover-cleanup', {
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
        const pending = runner.handle(recoveryRequest.clone());
        await inspecting;
        expect((await runner.handle(recoveryRequest.clone())).status).toBe(409);
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
        expect(new URL(reports[0].url).pathname).toBe('/runner-cleanup-recovery');
        expect(await reports[0].json()).toMatchObject({
          runId: manifest.runId,
          jobId: manifest.jobId,
          sandboxName: manifest.sandboxName,
        });
        expect(await readFile(join(evidenceRoot, evidenceId, 'callback.json'), 'utf8')).toBe(
          original,
        );
        expect(
          JSON.parse(
            await readFile(join(evidenceRoot, evidenceId, 'cleanup-recovery.json'), 'utf8'),
          ),
        ).toMatchObject({ jobId: manifest.jobId });
        expect((await runner.handle(recoveryRequest.clone())).status).toBe(202);
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
    // Exercise the explicit recovery contract; startup reconciliation only
    // handles ownership records retained from an interrupted Runner.
    await rm(join(evidenceRoot, 'sandbox-owners'), { recursive: true, force: true });
    const evidenceId = scenario.terminal.evidenceId as string;
    const callbackPath = join(evidenceRoot, evidenceId, 'callback.json');
    if (failure === 'legacy-host-cleanup') {
      const callback = JSON.parse(await readFile(callbackPath, 'utf8'));
      const manifest = JSON.parse(
        Buffer.from(callback.evidence.manifest.content, 'base64').toString('utf8'),
      );
      delete manifest.hostCleanupConfirmed;
      const bytes = Buffer.from(JSON.stringify(manifest));
      callback.evidence.manifest = {
        content: bytes.toString('base64'),
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      await writeFile(callbackPath, JSON.stringify(callback));
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
          : ['wrong-identity', 'legacy-host-cleanup'].includes(failure)
            ? 409
            : 502,
      );
      expect(delivered).toHaveLength(failure === 'delivery-error' ? 1 : 0);
      expect(commands.some((args) => args[0] === 'rm')).toBe(false);
      if (['unauthorized', 'wrong-identity', 'legacy-host-cleanup'].includes(failure))
        expect(commands).toEqual([]);
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
        const path = new URL(
          input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        ).pathname;
        if (path === '/runner-cleanup-recovery') {
          recoveryAttempts += 1;
          if (recoveryAttempts === 1) {
            recoveryReports.push(
              JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
                string,
                unknown
              >,
            );
            return new Response(null, { status: 409 });
          }
          await recoveryRetryGate;
          recoveryReports.push(
            JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
              string,
              unknown
            >,
          );
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
      const manifest = JSON.parse(originalManifest) as { sandboxName: string };

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
        evidenceId,
        jobId: firstJobId,
        runId: `run-${firstJobId}`,
        attempt: 1,
        baseSha,
        headSha: oldHead,
        sandboxName: manifest.sandboxName,
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
        evidenceId,
        jobId: firstJobId,
        runId: `run-${firstJobId}`,
        attempt: 1,
        baseSha,
        headSha: oldHead,
        sandboxName: manifest.sandboxName,
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
      expect(
        JSON.parse(await readFile(join(root, evidenceId, 'cleanup-recovery.json'), 'utf8')),
      ).toMatchObject({ jobId: firstJobId, sandboxName: manifest.sandboxName });
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
      callbackFetch: async (input) => {
        if (
          new URL(input instanceof Request ? input.url : input).pathname ===
          '/runner-cleanup-recovery'
        )
          reports += 1;
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
            outcome: 'cleanup-recovery',
            runId: 'run-permanent-recovery',
            jobId,
            attempt: 1,
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

  it('stops automatic delivery when the original callback is permanently rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-permanent-callback-rejection-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const baseSha = '1'.repeat(40);
    const headSha = '2'.repeat(40);
    const jobId = 'permanent-callback-job';
    let backendUp = true;
    let reports = 0;
    let callbackAttempts = 0;
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
      callbackFetch: async (input) => {
        if (
          new URL(input instanceof Request ? input.url : input).pathname ===
          '/runner-cleanup-recovery'
        ) {
          reports += 1;
          return new Response(null, { status: 409 });
        }
        callbackAttempts += 1;
        return new Response(null, { status: 403 });
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
        runId: 'run-permanent-callback',
        attempt: 1,
        pullRequestNumber: 48,
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
      await vi.waitFor(() => expect(callbackAttempts).toBe(3));
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            phase: 'runner',
            outcome: 'callback',
            runId: 'run-permanent-callback',
            jobId,
            result: 'http-error',
            status: 403,
          }),
        ),
      );
      const advanceRetryClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(reports).toBe(1);
        expect(callbackAttempts).toBe(3);
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

  it('does not replay the callback after a repeated 409 recovery rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-repeat-409-recovery-rejection-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const baseSha = '1'.repeat(40);
    const headSha = '2'.repeat(40);
    const jobId = 'repeat-409-job';
    let backendUp = true;
    let reports = 0;
    let callbackAttempts = 0;
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
      callbackFetch: async (input) => {
        if (
          new URL(input instanceof Request ? input.url : input).pathname ===
          '/runner-cleanup-recovery'
        ) {
          reports += 1;
          return new Response(null, { status: 409 });
        }
        callbackAttempts += 1;
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
        runId: 'run-repeat-409',
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
      await vi.waitFor(() => expect(reports).toBe(2));
      await vi.waitFor(() => expect(callbackAttempts).toBe(2));
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            phase: 'runner',
            outcome: 'cleanup-recovery',
            runId: 'run-repeat-409',
            jobId,
            status: 409,
          }),
        ),
      );
      const advanceRetryClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(reports).toBe(2);
        expect(callbackAttempts).toBe(2);
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

  it('keeps a permanently rejected cleanup visible after an ownership rescan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-permanent-rescan-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const instanceId = 'permanent-rescan';
    const ownershipRoot = join(root, 'sandbox-owners', instanceId);
    await mkdir(ownershipRoot, { recursive: true });
    await writeFile(join(ownershipRoot, 'foreign.json'), '{}');
    const baseSha = '1'.repeat(40);
    const headSha = '2'.repeat(40);
    const jobId = 'permanent-rescan-job';
    let backendUp = true;
    let reports = 0;
    const events: unknown[] = [];
    const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    const authFailure = { ...ok, exitCode: 1, stderr: 'not signed in' };
    const runner = createProductionRunnerWithMergeBase({
      evidenceRoot: root,
      instanceId,
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      claimIntervalMs: 2,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async (input) => {
        if (
          new URL(input instanceof Request ? input.url : input).pathname ===
          '/runner-cleanup-recovery'
        )
          reports += 1;
        return new Response(null, { status: 403 });
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
    const rejections = () =>
      events.filter(
        (event) =>
          (event as { outcome?: string }).outcome === 'cleanup-recovery' &&
          (event as { status?: number }).status === 403,
      ).length;
    try {
      runner.enqueue({
        ...runnerJobFields,
        id: jobId,
        runId: 'run-permanent-rescan',
        attempt: 1,
        pullRequestNumber: 50,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      });
      expect(await waitForTerminal(runner, jobId)).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });
      backendUp = true;
      await vi.waitFor(() => expect(rejections()).toBeGreaterThanOrEqual(1));
      const resumed = await runner.handle(
        new Request('http://runner/maintenance/resume', {
          method: 'POST',
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      );
      expect(resumed.status).toBe(200);
      await vi.waitFor(() => expect(rejections()).toBeGreaterThanOrEqual(2));
      expect(reports).toBeGreaterThanOrEqual(2);
      const status = (await (
        await runner.handle(
          new Request('http://runner/maintenance', {
            headers: { authorization: 'Bearer runner-test-token' },
          }),
        )
      ).json()) as { activeJobs: number; cleanupBlockedJobs: number };
      expect(status).toMatchObject({ activeJobs: 0, cleanupBlockedJobs: 1 });
      const retained = await runner.handle(
        new Request(`http://runner/jobs/${jobId}`, {
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      );
      expect(retained.status).toBe(200);
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
  }, 20_000);

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
      callbackFetch: async (input, init) => {
        const path = new URL(
          input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        ).pathname;
        if (path === '/runner-cleanup-recovery') {
          reports.push(
            JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
              string,
              unknown
            >,
          );
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
        jobId,
        runId: 'run-direct-drain-recovery',
        attempt: 1,
        baseSha,
        headSha,
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
      const finalDrain = (await (
        await runner.handle(
          new Request('http://runner/maintenance/drain', {
            method: 'POST',
            headers: { authorization: 'Bearer runner-test-token' },
          }),
        )
      ).json()) as { draining: boolean; drained: boolean };
      expect(finalDrain).toMatchObject({ draining: true, drained: true });
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
      callbackFetch: async (input, init) => {
        const path = new URL(
          input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        ).pathname;
        if (path === '/runner-cleanup-recovery') {
          reports.push(
            JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
              string,
              unknown
            >,
          );
          return new Response(null, { status: 202 });
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
        jobId,
        runId: 'run-cleanup-recovery-race',
        attempt: 1,
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

  it('releases the same-PR queue through real Core after automatic recovery', async () => {
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
    let terminalAttempts = 0;
    const callbackFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      );
      const recovery = url.pathname === '/runner-cleanup-recovery';
      if (!recovery) {
        terminalAttempts += 1;
        if (terminalAttempts <= 2) return new Response(null, { status: 503 });
      }
      const response = await dispatch(
        new Request(
          recovery
            ? 'https://core.internal/runner-cleanup-recovery'
            : 'https://core.internal/runner-results',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(recovery
                ? { 'x-compte-rendu-runner-cleanup-recovery': 'verified' }
                : { 'x-compte-rendu-runner-callback': 'verified' }),
            },
            body: typeof init?.body === 'string' ? init.body : '',
          },
        ),
      );
      await Promise.all(waitUntilTasks.splice(0));
      return response;
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
        backendUp = true;
        await vi.waitFor(
          async () => {
            expect(await stateStore.getPublicRun(old.runId)).toMatchObject({
              status: 'failed',
              runnerCleanupStatus: 'destroyed',
            });
          },
          { timeout: 5_000 },
        );
        expect(terminalAttempts).toBe(3);

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

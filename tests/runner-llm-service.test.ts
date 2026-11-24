import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  RelayControl,
  createProductionRunnerWithMergeBase,
  createRelayControl,
  createRunner,
  finalMarkdownJsonl,
  readTextTree,
  relayInferenceModelConfig,
  routeRelayControl,
  runAgentScenario,
  runnerJobFields,
  sessionExportJson,
  sharedEvidenceRoot,
  standardModelConfig,
  waitForTerminal,
  writeEvidenceFixture,
} from './support/runner-harness';

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
    'https://models.example/v1?token=private',
    'https://models.example:8443/v1',
    'https://127.0.0.1/v1',
    'http://inference.example/v1',
    'https://models.example/v2',
    'https://models.example/v1/chat/completions',
  ])('rejects a relay endpoint outside the dedicated HTTPS inference origin: %s', (baseUrl) => {
    expect(() =>
      createRunner({
        llmRelay: true,
        llmRelayGeneration: 'generation-a',
        modelConfig: JSON.stringify({
          id: 'opencode-go/review',
          baseUrl,
          definition: { name: 'Review' },
        }),
      }),
    ).toThrow();
  });

  it('issues a job grant, injects it through the sbx token file, revokes it, and leaves no usable token behind', async () => {
    const callbacks: Request[] = [];
    const usage = {
      version: 1,
      models: [
        {
          route: 'deepseek-review',
          model: 'deepseek-v4.1-flash',
          requests: 1,
          incompleteRequests: 0,
          inputTokens: { total: 120, reportedRequests: 1 },
          uncachedInputTokens: { total: 20, reportedRequests: 1 },
          cacheReadTokens: { total: 100, reportedRequests: 1 },
          cacheWriteTokens: null,
          outputTokens: { total: 40, reportedRequests: 1 },
          reasoningTokens: null,
        },
      ],
    };
    const relay = createRelayControl({ usage });
    const serviceModelConfig = JSON.stringify({
      id: 'opencode-go/deepseek-review',
      baseUrl: 'https://inference.example/v1',
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
      callbackRequests: callbacks,
      modelConfig: serviceModelConfig,
      relayControl: relay,
      sessionExport: sessionExportJson('scenario-session', {
        model: { providerID: 'compte-rendu', id: 'deepseek-review' },
      }),
      onModelSecret: async (args) => {
        const command = args[args.indexOf('--command') + 1];
        const path = command.slice("/usr/bin/cat '".length, -1);
        injectedToken = await readFile(path, 'utf8');
      },
      onAgentStart: async () => {
        usableDuringReview = [...relay.activeTokens.values()].includes(runnerJobFields.id);
        expect(injectedToken).toBe('relay-grant-token-1');
      },
    });

    expect(scenario.terminal).toMatchObject({
      status: 'succeeded',
      sandbox: { cleanup: 'destroyed' },
    });
    expect(await callbacks[0].clone().json()).toMatchObject({ usage });
    const manifest = JSON.parse(
      await readFile(
        join(sharedEvidenceRoot, scenario.terminal.evidenceId as string, 'manifest.json'),
        'utf8',
      ),
    );
    expect(manifest.usage).toEqual(usage);
    const jobId = runnerJobFields.id;
    expect(usableDuringReview).toBe(true);
    expect(relay.issued).toHaveLength(1);
    expect(relay.issued[0]).toMatchObject({ jobId, routes: ['deepseek-review'] });
    expect(relay.revoked).toEqual([jobId]);
    expect(relay.activeTokens.size).toBe(0);

    const token = relay.issued[0].token;
    const secretArgs = scenario.secretArgs ?? [];
    const command = secretArgs[secretArgs.indexOf('--command') + 1];
    expect(command).toMatch(/^\/usr\/bin\/cat '/);
    expect(secretArgs[secretArgs.indexOf('--host') + 1]).toBe('inference.example');
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
  });
});

describe('Runner LLM token output', () => {
  it('does not publish or retain a review that unexpectedly contains its host grant', async () => {
    const token = 'unexpected-host-grant-value';
    const relay = createRelayControl({ token });
    const callbacks: Request[] = [];
    const scenario = await runAgentScenario({
      runId: 'run-llm-leaked-review',
      output: finalMarkdownJsonl(`## Review:\n${token}`),
      sessionExport: JSON.stringify({
        ...JSON.parse(sessionExportJson('scenario-session')),
        diagnostic: token,
      }),
      callbackRequests: callbacks,
      modelConfig: relayInferenceModelConfig(),
      relayControl: relay,
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
    expect(relay.revoked).toEqual([runnerJobFields.id]);
  });
});

describe('Runner LLM lifecycle failures', () => {
  const modelConfig = relayInferenceModelConfig();
  const fixture = async (issue: 'normal' | 'malformed' | 'short' = 'normal') => {
    const root = await mkdtemp(join(tmpdir(), 'cr-llm-life-'));
    const token = 'lifecycle-test-grant';
    const relay = createRelayControl({ issuance: issue, token });
    return {
      root,
      relay,
      token,
      close: async () => {
        await rm(root, { recursive: true, force: true });
      },
    };
  };
  const relayOptions = (relay: RelayControl) => ({
    modelConfig,
    llmRelay: true,
    llmRelayGeneration: 'generation-a',
    callbackFetch: routeRelayControl(relay, async () => new Response(null, { status: 202 })),
  });
  it.each(['malformed', 'short'] as const)(
    'revokes an unusable %s issuance without starting the agent',
    async (issue) => {
      const f = await fixture(issue);
      try {
        const result = await runAgentScenario({
          runId: `llm-${issue}`,
          output: finalMarkdownJsonl(),
          relayControl: f.relay,
          modelConfig,
          evidenceRoot: join(f.root, 'evidence'),
          callbackRequests: [],
        });
        expect(result.terminal).toMatchObject({
          status: 'failed',
          sandbox: { cleanup: 'destroyed' },
        });
        expect(result.agentInvoked).toBe(false);
        expect(f.relay.revoked).toEqual([runnerJobFields.id]);
        expect(f.relay.activeTokens.size).toBe(0);
      } finally {
        await f.close();
      }
    },
  );
  it('keeps a valid review and cleanup successful when optional usage is unavailable', async () => {
    const f = await fixture();
    const callbacks: Request[] = [];
    try {
      const result = await runAgentScenario({
        runId: 'usage-unavailable',
        output: finalMarkdownJsonl(),
        modelConfig,
        relayControl: f.relay,
        evidenceRoot: join(f.root, 'evidence'),
        callbackRequests: callbacks,
        sessionExport: sessionExportJson('scenario-session', {
          model: { providerID: 'compte-rendu', id: 'deepseek-review' },
        }),
      });
      expect(result.terminal).toMatchObject({
        status: 'succeeded',
        sandbox: { cleanup: 'destroyed' },
      });
      expect(await callbacks[0].clone().json()).not.toHaveProperty('usage');
      expect(f.relay.revoked).toEqual([runnerJobFields.id]);
    } finally {
      await f.close();
    }
  });
  it('fails without a vote when revocation is unavailable, then recovers before a fresh Runner can claim', async () => {
    const f = await fixture();
    f.relay.setRejectRevoke(true);
    const evidenceRoot = join(f.root, 'evidence');
    const callbacks: Request[] = [];
    let activeRunner: ReturnType<typeof createRunner> | undefined;
    let restarted: ReturnType<typeof createRunner> | undefined;
    try {
      const result = await runAgentScenario({
        runId: 'llm-revoke-failed',
        output: finalMarkdownJsonl(),
        modelConfig,
        relayControl: f.relay,
        evidenceRoot,
        callbackRequests: callbacks,
        onRunner: (runner) => {
          activeRunner = runner;
        },
      });
      expect(result.terminal).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'destroyed' },
      });
      expect(result.terminal).not.toHaveProperty('result');
      expect((await callbacks[0].json()).result).toBeUndefined();
      expect(f.relay.revoked).toEqual([]);
      expect(f.relay.activeTokens.size).toBe(1);
      // A failed terminal revocation leaves a startup marker, but confirmed
      // Sandbox destruction still lets this process drain. The next startup
      // resolves the marker before accepting work.
      const drain = await activeRunner!.handle(
        new Request('http://runner/maintenance/drain', {
          method: 'POST',
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      );
      expect(await drain.json()).toMatchObject({
        draining: true,
        drained: true,
        cleanupBlockedJobs: 0,
        claimPollingHalted: false,
      });
      let unexpectedClaim = false;
      const blocked = createRunner({
        ...relayOptions(f.relay),
        authToken: 'runner-test-token',
        evidenceRoot,
        claimIntervalMs: 1,
        claimFetch: async () => {
          unexpectedClaim = true;
          return new Response(null, { status: 204 });
        },
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(unexpectedClaim).toBe(false);
        expect(f.relay.activeTokens.size).toBe(1);
      } finally {
        await blocked.close();
      }
      f.relay.setRejectRevoke(false);
      let claimedWithRevokedGrant = false;
      restarted = createRunner({
        ...relayOptions(f.relay),
        authToken: 'runner-test-token',
        evidenceRoot,
        claimIntervalMs: 60000,
        claimFetch: async () => {
          claimedWithRevokedGrant = f.relay.activeTokens.size === 0;
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
    f.relay.setRejectRevoke(true);
    try {
      const result = await runAgentScenario({
        runId: 'llm-revoke-cleanup-failed',
        output: finalMarkdownJsonl(),
        modelConfig,
        relayControl: f.relay,
        evidenceRoot: join(f.root, 'evidence'),
        cleanupFailure: true,
      });
      expect(result.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'cleanup' },
        sandbox: { cleanup: 'failed' },
      });
      expect(result.manifest.terminal).toMatchObject({ status: 'failed', reason: 'cleanup' });
      expect(f.relay.revoked).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it('resumes claiming after explicit cleanup recovery resolves a failed startup grant gate', async () => {
    const f = await fixture();
    f.relay.setRejectRevoke(true);
    const evidenceRoot = join(f.root, 'evidence');
    let restarted: ReturnType<typeof createRunner> | undefined;
    try {
      const failed = await runAgentScenario({
        runId: 'recovery-grant-gate',
        output: finalMarkdownJsonl(),
        modelConfig,
        relayControl: f.relay,
        evidenceRoot,
        cleanupFailure: true,
      });
      // Preserve this test's grant-recovery focus; startup sbx reconciliation
      // is covered separately through retained ownership records.
      await rm(join(evidenceRoot, 'sandbox-owners'), { recursive: true, force: true });
      let blocked = false;
      let claims = 0;
      restarted = createProductionRunnerWithMergeBase({
        ...relayOptions(f.relay),
        authToken: 'runner-test-token',
        evidenceRoot,
        claimUrl: 'https://ingress.test/runner-claim',
        claimIntervalMs: 60000,
        log: {
          record: (event) => {
            if (event.outcome === 'claim' && event.reason === 'grant-recovery-failed')
              blocked = true;
          },
        },
        claimFetch: async () => {
          claims += 1;
          return new Response(null, { status: 204 });
        },
        process: async (_command, args) =>
          args[0] === 'inspect'
            ? {
                exitCode: 1,
                stdout: '',
                stderr: `error: sandbox '${failed.manifest.sandboxName}' not found`,
                timedOut: false,
                truncated: false,
              }
            : {
                exitCode: 0,
                stdout: args[0] === 'policy' ? '{"rules":[]}' : '',
                timedOut: false,
                truncated: false,
              },
      });
      await vi.waitFor(() => expect(blocked).toBe(true));
      expect(claims).toBe(0);
      expect(f.relay.activeTokens.size).toBe(1);
      const maintenanceRequest = (path: string) =>
        new Request(`http://runner/maintenance/${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer runner-test-token' },
        });
      expect(await (await restarted.handle(maintenanceRequest('drain'))).json()).toMatchObject({
        drained: false,
        claimPollingHalted: true,
      });
      // Enable revocation before resume so a resume-triggered scan would
      // succeed if it ran at all. Resume only clears the pause; the failed
      // startup gate, its marker and the claim halt must remain.
      const revokedBeforeResume = f.relay.revoked.length;
      f.relay.setRejectRevoke(false);
      expect(await (await restarted.handle(maintenanceRequest('resume'))).json()).toMatchObject({
        draining: false,
        drained: false,
        claimPollingHalted: true,
      });
      expect(claims).toBe(0);
      expect(f.relay.revoked).toHaveLength(revokedBeforeResume);
      expect(f.relay.activeTokens.size).toBe(1);
      expect(await (await restarted.handle(maintenanceRequest('drain'))).json()).toMatchObject({
        draining: true,
        drained: false,
        claimPollingHalted: true,
      });
      const manifest = failed.manifest;
      const recovery = await restarted.handle(
        new Request('http://runner/maintenance/recover-cleanup', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            evidenceId: failed.terminal.evidenceId,
            jobId: manifest.jobId,
            runId: manifest.runId,
            attempt: manifest.attempt,
            baseSha: manifest.baseSha,
            headSha: manifest.headSha,
          }),
        }),
      );
      expect(recovery.status).toBe(202);
      expect(f.relay.activeTokens.size).toBe(0);
      await vi.waitFor(async () => {
        expect(await (await restarted!.handle(maintenanceRequest('drain'))).json()).toMatchObject({
          drained: true,
          claimPollingHalted: false,
        });
      });
      await restarted.handle(maintenanceRequest('resume'));
      await vi.waitFor(() => expect(claims).toBeGreaterThan(0));
    } finally {
      await restarted?.close();
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
      output: finalMarkdownJsonl(),
      relayControl: f.relay,
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
      expect(f.relay.activeTokens.size).toBe(1);
      cancelled = runner!.handle(
        new Request(`http://runner/jobs/${runnerJobFields.id}`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      );
      await vi.waitFor(() => expect(f.relay.activeTokens.size).toBe(0));
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

describe('Runner transport diagnostics', () => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  type LogEvent = Record<string, unknown>;
  const claimEvents = (events: readonly LogEvent[]) =>
    events.filter((event) => event.outcome === 'claim');

  const runClaimLogScenario = async (options: {
    readonly respond: () => Response | Promise<Response>;
    readonly waitMs?: number;
    readonly waitForJobId?: string;
  }) => {
    const events: LogEvent[] = [];
    let claims = 0;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelConfig: standardModelConfig,
      concurrency: 2,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: async () => new Response(null, { status: 202 }),
      progressFetch: async () => new Response(null, { status: 202 }),
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimTimeoutMs: 5,
      log: {
        record: async (event) => {
          events.push(event as LogEvent);
        },
      },
      claimFetch: async () => {
        claims += 1;
        return options.respond();
      },
      process: async (_command, args, processOptions = {}) => {
        await writeEvidenceFixture(args, processOptions, finalMarkdownJsonl());
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"scenario-session"}]\n'
              : processOptions.captureStdout === true
                ? `${finalMarkdownJsonl()}\n`
                : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, options.waitMs ?? 40));
    if (options.waitForJobId !== undefined) await waitForTerminal(runner, options.waitForJobId);
    await runner.close();
    return { events, claims: () => claims };
  };

  it('does not log an empty claim poll', async () => {
    const { events, claims } = await runClaimLogScenario({
      respond: () => new Response(null, { status: 204 }),
    });

    expect(claims()).toBeGreaterThanOrEqual(2);
    expect(claimEvents(events)).toHaveLength(0);
  });

  it('classifies claim HTTP errors and keeps polling', async () => {
    const { events, claims } = await runClaimLogScenario({
      respond: () => new Response(null, { status: 503 }),
    });

    expect(claims()).toBeGreaterThanOrEqual(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'claim',
        reason: 'http-error',
        status: 503,
        pollingHalted: false,
      }),
    );
  });

  it('classifies a claim timeout without exposing the endpoint', async () => {
    const { events } = await runClaimLogScenario({
      respond: () => new Promise<Response>(() => undefined),
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'claim',
        reason: 'timeout',
        pollingHalted: false,
      }),
    );
    expect(JSON.stringify(events)).not.toContain('ingress.test');
    expect(JSON.stringify(events)).not.toContain('runner-claim');
  });

  it('classifies a claim transport error without logging the thrown message', async () => {
    const canary = 'claim-transport-secret-canary';
    const { events, claims } = await runClaimLogScenario({
      respond: () => {
        throw new Error(`claim failed ${canary}`);
      },
    });

    expect(claims()).toBeGreaterThanOrEqual(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'claim',
        reason: 'transport-error',
        pollingHalted: false,
      }),
    );
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it('classifies an oversized claim response and halts polling', async () => {
    const { events, claims } = await runClaimLogScenario({
      respond: () => new Response('x'.repeat(64 * 1024 + 1), { status: 200 }),
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'claim',
        reason: 'oversized-response',
        pollingHalted: true,
      }),
    );
    expect(claims()).toBe(1);
  });

  it('classifies a malformed claim response and halts polling', async () => {
    const { events, claims } = await runClaimLogScenario({
      respond: () => new Response('not-json', { status: 200 }),
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'claim',
        reason: 'malformed-response',
        pollingHalted: true,
      }),
    );
    expect(claims()).toBe(1);
  });

  it('classifies an invalid claim payload and halts polling', async () => {
    const { events, claims } = await runClaimLogScenario({
      respond: () => new Response('{}', { status: 200 }),
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'claim',
        reason: 'invalid-response',
        pollingHalted: true,
      }),
    );
    expect(claims()).toBe(1);
  });

  it('classifies a rejected claimed admission and halts polling', async () => {
    let calls = 0;
    const claimedJob = (id: string) => ({
      ...runnerJobFields,
      id,
      runId: 'run-claim-admission',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    });
    const { events, claims } = await runClaimLogScenario({
      respond: () => {
        calls += 1;
        return Response.json(
          claimedJob(calls === 1 ? 'runner-claim-first' : 'runner-claim-second'),
          {
            status: 200,
          },
        );
      },
      waitMs: 60,
      // Let the admitted job finish before the shared evidence-root cleanup.
      waitForJobId: 'runner-claim-first',
    });

    expect(claims()).toBe(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'claim',
        reason: 'admission-rejected',
        pollingHalted: true,
      }),
    );
  });

  const runCallbackLogScenario = async (options: {
    readonly runId: string;
    readonly callbackStatuses?: readonly number[];
    readonly callbackThrows?: string;
    readonly callbackHangs?: boolean;
    readonly callbackTimeoutMs?: number;
  }) => {
    const events: LogEvent[] = [];
    const result = await runAgentScenario({
      runId: options.runId,
      output: finalMarkdownJsonl(),
      callbackRequests: [],
      callbackStatuses: options.callbackStatuses,
      callbackThrows: options.callbackThrows,
      callbackHangs: options.callbackHangs,
      callbackTimeoutMs: options.callbackTimeoutMs,
      logEvents: events,
    });
    if (options.callbackHangs === true || options.callbackThrows !== undefined) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (events.some((event) => event.outcome === 'callback-delivery-failed')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return { terminal: result.terminal, events };
  };

  it('records an accepted callback attempt and a terminal diagnostic', async () => {
    const runId = 'run-callback-log-accepted';
    const { terminal, events } = await runCallbackLogScenario({ runId });

    expect(terminal.status).toBe('succeeded');
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'callback',
        runId,
        jobId: runnerJobFields.id,
        attempt: 1,
        result: 'accepted',
        status: 202,
      }),
    );
    expect(events.some((event) => event.outcome === 'callback-delivery-failed')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'terminal',
        runId,
        jobId: runnerJobFields.id,
        status: 'succeeded',
        cleanup: 'destroyed',
      }),
    );
  });

  it('records every callback HTTP error and an explicit delivery failure', async () => {
    const runId = 'run-callback-log-http';
    const { terminal, events } = await runCallbackLogScenario({
      runId,
      callbackStatuses: [503, 503],
    });

    expect(terminal.status).toBe('succeeded');
    expect(events).toContainEqual(
      expect.objectContaining({
        outcome: 'callback',
        attempt: 1,
        result: 'http-error',
        status: 503,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        outcome: 'callback',
        attempt: 2,
        result: 'http-error',
        status: 503,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'callback-delivery-failed',
        runId,
        jobId: runnerJobFields.id,
      }),
    );
  });

  it('records callback timeouts and an explicit delivery failure', async () => {
    const runId = 'run-callback-log-timeout';
    const { terminal, events } = await runCallbackLogScenario({
      runId,
      callbackHangs: true,
      callbackTimeoutMs: 5,
    });

    expect(terminal.status).toBe('succeeded');
    expect(events).toContainEqual(
      expect.objectContaining({ outcome: 'callback', attempt: 1, result: 'timeout' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ outcome: 'callback', attempt: 2, result: 'timeout' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ outcome: 'callback-delivery-failed', runId }),
    );
  });

  it('records callback transport errors without logging the thrown message or endpoint', async () => {
    const canary = 'callback-transport-secret-canary';
    const runId = 'run-callback-log-transport';
    const { events } = await runCallbackLogScenario({
      runId,
      callbackThrows: `callback failed ${canary}`,
    });

    expect(events).toContainEqual(
      expect.objectContaining({ outcome: 'callback', attempt: 1, result: 'transport-error' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ outcome: 'callback-delivery-failed', runId }),
    );
    expect(JSON.stringify(events)).not.toContain(canary);
    expect(JSON.stringify(events)).not.toContain('ingress.test');
  });

  it('records abortRequested on commands after cancellation', async () => {
    const events: LogEvent[] = [];
    const zeroResults = JSON.stringify({
      type: 'text',
      sessionID: 'scenario-session',
      part: { type: 'text', messageID: 'msg-final', text: 'Completed without submitting.' },
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      log: {
        record: async (event) => {
          events.push(event as LogEvent);
        },
      },
      process: async (_command, args, processOptions = {}) => {
        const isAgent = args[0] === 'exec' && args.includes('--agent');
        if (isAgent) {
          started();
          await gate;
          await writeEvidenceFixture(args, processOptions, zeroResults);
          return { exitCode: 0, stdout: `${zeroResults}\n`, timedOut: false, truncated: false };
        }
        await writeEvidenceFixture(args, processOptions, '');
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-abort-command-log',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;
    await startedPromise;
    const aborted = runner.handle(
      new Request(`http://runner/jobs/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );
    release();
    expect((await aborted).status).toBe(200);
    await waitForTerminal(runner, id);

    const commands = events.filter((event) => event.outcome === 'command');
    expect(commands.some((event) => event.abortRequested === true)).toBe(true);
    for (const command of commands) {
      expect(command).toHaveProperty('truncated');
      expect(command).toHaveProperty('stderrTruncated');
      expect(command).toHaveProperty('streamError');
      expect(command).toHaveProperty('abortRequested');
      expect(command).toHaveProperty('processError');
    }
  });

  const runProcessThrowScenario = async (errorCode?: string) => {
    const canary = 'process-throw-secret-canary';
    const events: LogEvent[] = [];
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      log: {
        record: async (event) => {
          events.push(event as LogEvent);
        },
      },
      process: async (_command, args) => {
        if (args[0] === 'create') {
          const error = new Error(`spawn failed ${canary}`) as Error & { code?: string };
          if (errorCode !== undefined) error.code = errorCode;
          throw error;
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-process-throw-log',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;
    await waitForTerminal(runner, id);
    return { events, canary };
  };

  it('classifies a thrown process invocation with its safe Node error code', async () => {
    const { events, canary } = await runProcessThrowScenario('ENOENT');

    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'command',
        command: 'create',
        processError: true,
        errorCode: 'ENOENT',
      }),
    );
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it('omits an unrecognized process error code rather than guessing', async () => {
    const { events, canary } = await runProcessThrowScenario('EWEIRDCODE');

    const createEvent = events.find(
      (event) => event.outcome === 'command' && event.command === 'create',
    );
    expect(createEvent).toMatchObject({ processError: true });
    expect(createEvent).not.toHaveProperty('errorCode');
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it('records a real spawn ENOENT through the default process runner', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'cr-spawn-enoent-'));
    const emptyPath = await mkdtemp(join(tmpdir(), 'cr-empty-path-'));
    const events: LogEvent[] = [];
    const originalPath = process.env.PATH;
    const runner = createRunner({
      evidenceRoot,
      authToken: 'runner-test-token',
      log: {
        record: async (event) => {
          events.push(event as LogEvent);
        },
      },
      callbackFetch: async () => new Response(null, { status: 202 }),
    });
    try {
      // With no PATH the real `git` binary cannot be spawned, so the default
      // process runner observes a genuine ENOENT before any network or Sandbox.
      process.env.PATH = emptyPath;
      const submittedJob = {
        ...runnerJobFields,
        runId: 'run-enoent-log',
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      };
      runner.enqueue(submittedJob);
      const id = submittedJob.id;
      const terminal = await waitForTerminal(runner, id);

      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'checkout' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          phase: 'runner',
          outcome: 'command',
          command: 'clone',
          exitCode: 1,
          processError: true,
          errorCode: 'ENOENT',
        }),
      );
      // Only the safe code is logged, never the raw spawn message or the path.
      expect(JSON.stringify(events)).not.toContain('no such file');
      expect(JSON.stringify(events)).not.toContain('syscall');
      expect(JSON.stringify(events)).not.toContain(emptyPath);
    } finally {
      process.env.PATH = originalPath;
      await rm(emptyPath, { recursive: true, force: true });
      await runner.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('records a one-time grant recovery failure and preserves the claim gate', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'cr-claim-grant-'));
    const jobId = 'job-grant-gate';
    await mkdir(join(evidenceRoot, 'llm-grant-pending'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(
        evidenceRoot,
        'llm-grant-pending',
        `${createHash('sha256').update(jobId).digest('hex')}.marker`,
      ),
      JSON.stringify({
        version: 1,
        jobId,
        issuer: {
          transport: 'relay',
          origin: 'https://ingress.test',
          generation: 'generation-a',
        },
      }),
      { mode: 0o600 },
    );
    const relay = createRelayControl({ rejectRevoke: true });
    const events: LogEvent[] = [];
    let claims = 0;
    const runner = createRunner({
      evidenceRoot,
      authToken: 'runner-test-token',
      modelConfig: relayInferenceModelConfig('review'),
      llmRelay: true,
      llmRelayGeneration: 'generation-a',
      callbackFetch: relay.fetch,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: async () => {
        claims += 1;
        return new Response(null, { status: 204 });
      },
      log: {
        record: async (event) => {
          events.push(event as LogEvent);
        },
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(events.filter((event) => event.outcome === 'claim')).toEqual([
        expect.objectContaining({ reason: 'grant-recovery-failed', pollingHalted: true }),
      ]);
      expect(claims).toBe(0);
      expect(relay.requests).toContainEqual(
        expect.objectContaining({ path: '/runner-llm/revoke' }),
      );
    } finally {
      await runner.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it.each(['exit failure', 'rejection'] as const)(
    'retries a transient microsandbox preflight (%s) and caches success',
    async (failure) => {
      const events: LogEvent[] = [];
      let claims = 0;
      let doctorCalls = 0;
      let healthy = false;
      const realNow = Date.now.bind(Date);
      let offset = 0;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
      vi.stubEnv('RUNNER_SANDBOX_RUNTIME', 'microsandbox');
      vi.stubEnv('MICROSANDBOX_IMAGE', 'review:test');
      const runner = createRunner({
        authToken: 'runner-test-token',
        llmRelay: true,
        llmRelayGeneration: 'generation-a',
        modelConfig: relayInferenceModelConfig('review'),
        claimUrl: 'https://ingress.test/runner-claim',
        claimIntervalMs: 1,
        claimFetch: async () => {
          claims += 1;
          return new Response(null, { status: 204 });
        },
        log: {
          record: async (event) => {
            events.push(event as LogEvent);
          },
        },
        process: async (_command, args) => {
          if (args[0] === 'doctor') doctorCalls += 1;
          if (!healthy && args[0] === 'doctor' && failure === 'rejection')
            throw new Error('doctor unavailable');
          return {
            exitCode: healthy ? 0 : 1,
            stdout: '',
            timedOut: false,
            truncated: false,
          };
        },
      });
      try {
        await vi.waitFor(() =>
          expect(events.filter((event) => event.outcome === 'claim')).toHaveLength(1),
        );
        expect(events.filter((event) => event.outcome === 'claim')).toEqual([
          expect.objectContaining({ reason: 'runtime-preflight-failed', pollingHalted: false }),
        ]);
        expect(claims).toBe(0);
        expect(doctorCalls).toBe(1);
        const status = (await (
          await runner.handle(
            new Request('http://runner/maintenance', {
              headers: { authorization: 'Bearer runner-test-token' },
            }),
          )
        ).json()) as { claimPollingHalted: boolean };
        expect(status.claimPollingHalted).toBe(false);

        healthy = true;
        offset = 31_000;
        await vi.waitFor(() => expect(claims).toBeGreaterThan(0));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(doctorCalls).toBe(2);
      } finally {
        clock.mockRestore();
        await runner.close();
      }
    },
  );

  it('does not claim after close during a suspended runtime preflight', async () => {
    let started!: () => void;
    const preflightStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const preflightGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claims: Request[] = [];
    vi.stubEnv('RUNNER_SANDBOX_RUNTIME', 'microsandbox');
    vi.stubEnv('MICROSANDBOX_IMAGE', 'review:test');
    const runner = createRunner({
      authToken: 'runner-test-token',
      llmRelay: true,
      llmRelayGeneration: 'generation-a',
      modelConfig: relayInferenceModelConfig('review'),
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: async (input) => {
        claims.push(new Request(input));
        return new Response(null, { status: 204 });
      },
      process: async (_command, args) => {
        if (args[0] === 'doctor') {
          started();
          await preflightGate;
        }
        return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
      },
    });
    try {
      await preflightStarted;
      const closing = runner.close();
      release();
      await closing;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(claims).toHaveLength(0);
    } finally {
      release();
      await runner.close();
    }
  });

  it('does not admit a late claim response after close', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'cr-close-late-claim-'));
    const job = {
      ...runnerJobFields,
      id: 'late-claim-after-close',
      runId: 'run-late-claim-after-close',
      attempt: 1,
      pullRequestNumber: 79,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
    };
    let started!: () => void;
    const claimStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let commands = 0;
    let callbacks = 0;
    const runner = createRunner({
      evidenceRoot,
      authToken: 'runner-test-token',
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 10,
      claimTimeoutMs: 1_000,
      claimFetch: async () => {
        started();
        await claimGate;
        return Response.json(job);
      },
      callbackFetch: async () => {
        callbacks += 1;
        return new Response(null, { status: 202 });
      },
      process: async () => {
        commands += 1;
        return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
      },
    });
    try {
      await claimStarted;
      const closing = runner.close();
      release();
      await closing;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(commands).toBe(0);
      expect(callbacks).toBe(0);
      const unknown = await runner.handle(
        new Request(`http://runner/jobs/${job.id}`, {
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      );
      expect(unknown.status).toBe(404);
    } finally {
      release();
      await runner.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});

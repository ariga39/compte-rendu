import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunner } from '../apps/runner/src/runner';
import { createRelayLlmServiceClient } from '../apps/runner/src/llm-service-client';
import type { SandboxJobSpec } from '../apps/runner/src/sandbox-runtime';
import { createClaimExecution } from './support/runner-execution';

const evidenceRoots: string[] = [];

const evidenceRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'cr-relay-runner-'));
  evidenceRoots.push(root);
  return root;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of evidenceRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

const relayModelConfig = (baseUrl = 'https://relay.example/v1') =>
  JSON.stringify({
    id: 'opencode-go/deepseek-review',
    baseUrl,
    definition: { name: 'DeepSeek review' },
  });

const relayBaseOptions = (baseUrl = 'https://relay.example/v1') => ({
  authToken: 'runner-test-token',
  callbackUrl: 'https://ingress.test/runner-callback',
  callbackToken: 'callback-token',
  callbackFetch: async () => new Response(null, { status: 204 }),
  claimUrl: '',
  llmRelay: true,
  llmRelayGeneration: 'generation-a',
  modelConfig: relayModelConfig(baseUrl),
});

describe('Runner relay control client', () => {
  it('uses the callback credential for issue, revoke and usage on the relay control paths', async () => {
    const requests: Array<{ path: string; authorization?: string; body: unknown }> = [];
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      const authorization = incoming.headers.authorization;
      requests.push({
        path: incoming.url ?? '',
        ...(typeof authorization === 'string' ? { authorization } : {}),
        body,
      });
      if (incoming.url === '/runner-llm/issue') {
        outgoing.writeHead(201, { 'content-type': 'application/json' });
        outgoing.end(
          JSON.stringify({
            token: 'job-bearer',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
        return;
      }
      if (incoming.url === '/runner-llm/revoke') {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      if (incoming.url === '/runner-llm/usage') {
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ version: 1, models: [] }));
        return;
      }
      outgoing.writeHead(404);
      outgoing.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no relay listener');
    try {
      const client = createRelayLlmServiceClient({
        origin: `http://127.0.0.1:${address.port}`,
        token: 'relay-callback-token',
        fetch: globalThis.fetch,
      });
      const grant = await client.issue({ runId: 'run-1', jobId: 'job-1', attempt: 2 }, [
        'reviewer-a',
        'reviewer-b',
      ]);
      expect(grant.token).toBe('job-bearer');
      await client.revoke('job-1');
      await client.usage('job-1');

      expect(requests).toEqual([
        {
          path: '/runner-llm/issue',
          authorization: 'Bearer relay-callback-token',
          body: {
            runId: 'run-1',
            jobId: 'job-1',
            attempt: 2,
            routes: ['reviewer-a', 'reviewer-b'],
          },
        },
        {
          path: '/runner-llm/revoke',
          authorization: 'Bearer relay-callback-token',
          body: { jobId: 'job-1' },
        },
        {
          path: '/runner-llm/usage',
          authorization: 'Bearer relay-callback-token',
          body: { jobId: 'job-1' },
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sanitizes issue, revoke and usage transport failures', async () => {
    const client = createRelayLlmServiceClient({
      origin: 'https://relay.example',
      token: 'relay-token',
      fetch: async () => {
        throw new Error('private relay diagnostic');
      },
    });
    const issue = client
      .issue({ runId: 'run-failure', jobId: 'job-failure', attempt: 1 }, ['reviewer-a'])
      .catch((error: unknown) => error);
    const usage = client.usage('job-failure').catch((error: unknown) => error);
    const revoke = client.revoke('job-failure').catch((error: unknown) => error);

    await expect(issue).resolves.toHaveProperty('message', 'LLM service grant unavailable');
    await expect(usage).resolves.toHaveProperty('message', 'LLM usage unavailable');
    await expect(revoke).resolves.toHaveProperty('message', 'LLM service control request failed');
    for (const error of await Promise.all([issue, usage, revoke])) {
      expect(String(error)).not.toContain('private relay diagnostic');
    }
  });

  it('maps a timed-out body read to the sanitized error and aborts the signal', async () => {
    vi.useFakeTimers();
    let aborted = false;
    let bodyStarted = false;
    let signalSeen = false;
    try {
      const client = createRelayLlmServiceClient({
        origin: 'https://relay.example',
        token: 'relay-token',
        fetch: async (_input, init) => {
          signalSeen = init?.signal !== undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                bodyStarted = true;
                controller.enqueue(new TextEncoder().encode('{"version":1,'));
                init?.signal?.addEventListener('abort', () => {
                  aborted = true;
                  controller.error(new Error('aborted'));
                });
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      });
      const pending = client.usage('job-timeout').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5000);
      const error = await pending;

      expect(signalSeen).toBe(true);
      expect(bodyStarted).toBe(true);
      expect(aborted).toBe(true);
      expect(error).toHaveProperty('message', 'LLM usage unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      'a schema-invalid successful issue',
      () =>
        Response.json(
          {
            token: 'schema-token-canary',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            descriptors: [{ routeId: 'reviewer-a', profile: 'custom-script' }],
          },
          { status: 201 },
        ),
      'invalid-response',
    ],
    [
      'a route-set-mismatched successful issue',
      () =>
        Response.json(
          {
            token: 'route-set-token-canary',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            descriptors: [{ routeId: 'other-route-body-canary', profile: 'chat' }],
          },
          { status: 201 },
        ),
      'invalid-response',
    ],
    [
      'an HTTP-rejected issue',
      () => new Response('http-body-canary', { status: 503 }),
      'http-error',
    ],
    [
      'a transport-failed issue',
      () => {
        throw new Error('transport-message-canary');
      },
      'transport-error',
    ],
  ])('classifies %s without exposing the body or credential', async (_label, respond, reason) => {
    const client = createRelayLlmServiceClient({
      grantVersion: 2,
      origin: 'https://relay.example',
      token: 'relay-token',
      fetch: async () => respond(),
    });
    const error = await client
      .issue({ runId: 'run-classify', jobId: 'job-classify', attempt: 1 }, ['reviewer-a'])
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      name: 'LlmGrantIssueError',
      message: 'LLM service grant unavailable',
      reason,
      ...(reason === 'http-error' ? { status: 503 } : {}),
    });
    expect(JSON.stringify(error)).not.toContain('canary');
  });

  it('classifies an issue timeout separately from transport and HTTP failures', async () => {
    vi.useFakeTimers();
    try {
      const client = createRelayLlmServiceClient({
        grantVersion: 2,
        origin: 'https://relay.example',
        token: 'relay-token',
        fetch: async () => new Promise<Response>(() => undefined),
      });
      const pending = client
        .issue({ runId: 'run-timeout', jobId: 'job-timeout', attempt: 1 }, ['reviewer-a'])
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5000);

      expect(await pending).toMatchObject({
        name: 'LlmGrantIssueError',
        reason: 'timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Runner relay configuration', () => {
  it.each([
    'http://relay.example/v1',
    'https://relay.example:8443/v1',
    'https://user:password@relay.example/v1',
    'https://relay.example/v1?token=private',
    'https://relay.example/v1#fragment',
    'https://*.relay.example/v1',
    'https://127.0.0.1/v1',
    'https://relay.example/v2',
    'https://relay.example/v1/chat/completions',
  ])('rejects an unsafe inference origin: %s', (baseUrl) => {
    expect(() => createRunner(relayBaseOptions(baseUrl))).toThrow();
  });

  it.each(['https://relay.example/v1', 'https://relay.example:443/v1'])(
    'accepts a strict HTTPS inference origin: %s',
    async (baseUrl) => {
      const runner = createRunner(relayBaseOptions(baseUrl));
      await runner.close();
    },
  );

  it('rejects the callback hostname as the inference hostname', () => {
    expect(() => createRunner(relayBaseOptions('https://ingress.test/v1'))).toThrow(
      /dedicated inference hostname/,
    );
  });

  it('does not admit relay work without the callback transport settings', () => {
    expect(() =>
      createRunner({
        ...relayBaseOptions(),
        callbackUrl: undefined,
        callbackToken: undefined,
      }),
    ).toThrow();
  });

  it('requires a backend generation for the relay issuer identity', () => {
    expect(() => createRunner({ ...relayBaseOptions(), llmRelayGeneration: undefined })).toThrow();
  });

  it('rejects an http callback origin before transmitting the relay credential', () => {
    let transmitted = 0;
    expect(() =>
      createRunner({
        ...relayBaseOptions(),
        callbackUrl: 'http://insecure.example/runner-callback',
        callbackFetch: async () => {
          transmitted += 1;
          return new Response(null, { status: 204 });
        },
      }),
    ).toThrow(/HTTPS/);
    expect(transmitted).toBe(0);
  });

  it.each(['/run/user/1000/compte-rendu-llm/control.sock', 'relative/control.sock'])(
    'fails closed when the retired local service socket is configured: %s',
    async (socketPath) => {
      const previous = process.env.RUNNER_LLM_SERVICE_SOCKET;
      process.env.RUNNER_LLM_SERVICE_SOCKET = socketPath;
      try {
        expect(() =>
          createRunner({
            authToken: 'runner-test-token',
            modelConfig: JSON.stringify({
              id: 'opencode-go/deepseek-review',
              definition: { name: 'DeepSeek review' },
            }),
            claimUrl: '',
          }),
        ).toThrow(/RUNNER_LLM_SERVICE_SOCKET|Unix socket|retired|relay/i);
      } finally {
        if (previous === undefined) delete process.env.RUNNER_LLM_SERVICE_SOCKET;
        else process.env.RUNNER_LLM_SERVICE_SOCKET = previous;
      }
    },
  );
});

describe('Runner relay admission and recovery', () => {
  it('fails a relay claim without a frozen selection before checkout', async () => {
    const commands: string[] = [];
    const execution = createClaimExecution();
    const runner = createRunner({
      ...relayBaseOptions(),
      evidenceRoot: await evidenceRoot(),
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: execution.claimFetch,
      callbackFetch: execution.callbackFetch,
      process: async (_command, args) => {
        commands.push([...args].join(' '));
        return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
      },
    });
    try {
      execution.enqueue({
        id: 'relay-no-selection',
        runId: 'run-relay-no-selection',
        attempt: 1,
        repositoryName: 'acme/reviewed',
        pullRequestNumber: 42,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '2222222222222222222222222222222222222222',
        repositoryReadToken: 'github-read-token',
      });
      const terminal = await execution.waitForTerminal('relay-no-selection');
      expect(terminal.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'configuration' },
      });
      expect(commands).toEqual([]);
    } finally {
      await runner.close();
    }
  });

  it('runs a relay job over the authenticated HTTPS relay with a frozen selection', async () => {
    const root = await evidenceRoot();
    const specs: SandboxJobSpec[] = [];
    const issued: Array<Record<string, unknown>> = [];
    const revoked: string[] = [];
    let injectedToken = '';
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const execution = createClaimExecution();
    const runner = createRunner({
      ...relayBaseOptions('https://inference.example/v1'),
      evidenceRoot: root,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: execution.claimFetch,
      sandboxBackend: {
        kind: 'sbx',
        health: () => 'ready',
        checkReady: async () => 'ready',
        reconcileOrphans: async () => ({
          ok: true,
          recovered: 0,
          recoveredJobIds: [],
          failures: [],
        }),
        createJob: (spec) => {
          specs.push(spec);
          let hostCleanupConfirmed = false;
          const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
          return {
            metadata: {
              created: true,
              get hostCleanupConfirmed() {
                return hostCleanupConfirmed;
              },
              id: spec.name,
              name: spec.name,
              runtime: 'sbx',
              imageRef: 'review:test',
              evidenceRoot: '/tmp/compte-rendu-evidence',
            },
            setup: async () => {
              injectedToken = await readFile(spec.modelTokenFile!, 'utf8');
            },
            exec: async () => ok,
            copyOut: async () => ok,
            destroy: async () => {
              hostCleanupConfirmed = true;
            },
          };
        },
      },
      callbackFetch: async (input, init) => {
        const inputUrl =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        const path = new URL(inputUrl).pathname;
        if (!path.startsWith('/runner-llm/')) return execution.callbackFetch(input, init);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        if (path === '/runner-llm/issue') {
          issued.push(body as Record<string, unknown>);
          return Response.json(
            {
              token: 'relay-job-token',
              expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            },
            { status: 201 },
          );
        }
        if (path === '/runner-llm/revoke') {
          revoked.push(String((body as Record<string, unknown>).jobId));
          return new Response(null, { status: 204 });
        }
        if (path === '/runner-llm/usage') return Response.json({ version: 1, models: [] });
        return new Response(null, { status: 202 });
      },
      process: async (_command, args, options = {}) => ({
        exitCode: 0,
        stdout: args.includes('merge-base')
          ? `${baseSha}\n`
          : args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : options.captureStdout === true
              ? '[]\n'
              : '',
        timedOut: false,
        truncated: false,
      }),
    });
    try {
      execution.enqueue({
        id: 'relay-job',
        runId: 'run-relay-job',
        attempt: 1,
        repositoryName: 'acme/reviewed',
        pullRequestNumber: 42,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
        repositoryReadToken: 'github-read-token',
        reviewConfiguration: {
          revision: 4,
          selection: { reviewers: ['reviewer-a'], synthesis: 'reviewer-a' },
        },
      });
      await execution.waitForTerminal('relay-job');
      expect(specs).toHaveLength(1);
      expect(specs[0]).toMatchObject({
        modelResource: 'inference.example:443',
        modelTokenFile: expect.any(String),
      });
      expect(injectedToken).toBe('relay-job-token');
      expect(issued).toContainEqual({
        runId: 'run-relay-job',
        jobId: 'relay-job',
        attempt: 1,
        routes: ['reviewer-a'],
      });
      expect(revoked).toEqual(['relay-job']);
    } finally {
      await runner.close();
    }
  });

  it('issues with the full claim identity and revokes through the relay transport', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const execution = createClaimExecution();
    const runner = createRunner({
      ...relayBaseOptions(),
      evidenceRoot: await evidenceRoot(),
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 1,
      claimFetch: execution.claimFetch,
      callbackFetch: async (input, init) => {
        const inputUrl =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        const path = new URL(inputUrl).pathname;
        if (!path.startsWith('/runner-llm/')) return execution.callbackFetch(input, init);
        const bodyValue = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        requests.push({ path, body: bodyValue as Record<string, unknown> });
        if (path === '/runner-llm/issue') {
          return Response.json(
            {
              token: 'relay-job-token',
              expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            },
            { status: 201 },
          );
        }
        if (path === '/runner-llm/usage') return Response.json({ version: 1, models: [] });
        return new Response(null, { status: 204 });
      },
      process: async (_command, args, options = {}) => ({
        exitCode: 0,
        stdout: args.includes('merge-base')
          ? `${baseSha}\n`
          : args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : options.captureStdout === true
              ? '[]\n'
              : '',
        timedOut: false,
        truncated: false,
      }),
    });
    try {
      execution.enqueue({
        id: 'relay-issue-job',
        runId: 'run-relay-issue',
        attempt: 3,
        repositoryName: 'acme/reviewed',
        pullRequestNumber: 42,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
        repositoryReadToken: 'github-read-token',
        reviewConfiguration: {
          revision: 2,
          selection: { reviewers: ['reviewer-a'], synthesis: 'reviewer-a' },
        },
      });
      await execution.waitForTerminal('relay-issue-job');
      expect(requests).toContainEqual({
        path: '/runner-llm/issue',
        body: {
          runId: 'run-relay-issue',
          jobId: 'relay-issue-job',
          attempt: 3,
          routes: ['reviewer-a'],
        },
      });
      expect(requests).toContainEqual({
        path: '/runner-llm/revoke',
        body: { jobId: 'relay-issue-job' },
      });
    } finally {
      await runner.close();
    }
  });

  it('keeps a foreign issuer marker and does not clear it through the configured backend', async () => {
    const root = await evidenceRoot();
    const markerRoot = join(root, 'llm-grant-pending');
    const jobId = 'foreign-relay-job';
    const markerPath = join(
      markerRoot,
      `${createHash('sha256').update(jobId).digest('hex')}.marker`,
    );
    await mkdir(markerRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        jobId,
        issuer: {
          transport: 'relay',
          origin: 'https://old.example',
          generation: 'generation-old',
        },
      }),
      { mode: 0o600 },
    );
    let controlCalls = 0;
    const runner = createRunner({
      ...relayBaseOptions(),
      evidenceRoot: root,
      callbackUrl: 'https://new.example/runner-callback',
      llmRelayGeneration: 'generation-new',
      callbackFetch: async () => {
        controlCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(controlCalls).toBe(0);
      expect(await readFile(markerPath, 'utf8')).toContain('old.example');
    } finally {
      await runner.close();
    }
  });

  it('treats a legacy plaintext marker as the local issuer and refuses a foreign backend', async () => {
    const root = await evidenceRoot();
    const markerRoot = join(root, 'llm-grant-pending');
    const jobId = 'legacy-local-job';
    const markerPath = join(
      markerRoot,
      `${createHash('sha256').update(jobId).digest('hex')}.marker`,
    );
    await mkdir(markerRoot, { recursive: true, mode: 0o700 });
    await writeFile(markerPath, jobId, { mode: 0o600 });
    let controlCalls = 0;
    const runner = createRunner({
      ...relayBaseOptions(),
      evidenceRoot: root,
      callbackFetch: async () => {
        controlCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(controlCalls).toBe(0);
      expect(await readFile(markerPath, 'utf8')).toBe('legacy-local-job');
    } finally {
      await runner.close();
    }
  });

  it('scans stale markers in direct mode and gates admission, claims and diagnostics', async () => {
    const root = await evidenceRoot();
    const markerRoot = join(root, 'llm-grant-pending');
    const jobId = 'direct-stale-job';
    const markerPath = join(
      markerRoot,
      `${createHash('sha256').update(jobId).digest('hex')}.marker`,
    );
    await mkdir(markerRoot, { recursive: true, mode: 0o700 });
    await writeFile(markerPath, jobId, { mode: 0o600 });
    const events: Array<Record<string, unknown>> = [];
    const execution = createClaimExecution();
    vi.stubEnv('MODEL_SECRET_COMMAND', 'secret-resolver get MODEL_API_KEY');
    const runner = createRunner({
      evidenceRoot: root,
      authToken: 'runner-test-token',
      modelConfig: JSON.stringify({
        id: 'opencode-go/deepseek-flash',
        definition: { name: 'DeepSeek V4.1 Flash' },
      }),
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackFetch: execution.callbackFetch,
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 10,
      claimFetch: execution.claimFetch,
      log: {
        record: async (event) => {
          events.push(event as Record<string, unknown>);
        },
      },
    });
    try {
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({ outcome: 'claim', reason: 'grant-recovery-failed' }),
        ),
      );
      expect(execution.claimRequests).toHaveLength(0);
      expect(await readFile(markerPath, 'utf8')).toBe(jobId);
    } finally {
      await runner.close();
    }
  });

  it('fails closed for a legacy plaintext id starting with a brace when its filename matches', async () => {
    const root = await evidenceRoot();
    const markerRoot = join(root, 'llm-grant-pending');
    const jobId = '{"legacy-but-not-json":';
    const markerPath = join(
      markerRoot,
      `${createHash('sha256').update(jobId).digest('hex')}.marker`,
    );
    await mkdir(markerRoot, { recursive: true, mode: 0o700 });
    await writeFile(markerPath, jobId, { mode: 0o600 });
    let controlCalls = 0;
    const runner = createRunner({
      ...relayBaseOptions(),
      evidenceRoot: root,
      callbackFetch: async () => {
        controlCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(controlCalls).toBe(0);
      expect(await readFile(markerPath, 'utf8')).toBe(jobId);
    } finally {
      await runner.close();
    }
  });

  it('fails closed for malformed JSON that is not a matching legacy plaintext id', async () => {
    const root = await evidenceRoot();
    const markerRoot = join(root, 'llm-grant-pending');
    const markerPath = join(
      markerRoot,
      `${createHash('sha256').update('intended-job').digest('hex')}.marker`,
    );
    await mkdir(markerRoot, { recursive: true, mode: 0o700 });
    await writeFile(markerPath, '{"legacy":', { mode: 0o600 });
    let controlCalls = 0;
    const runner = createRunner({
      ...relayBaseOptions(),
      evidenceRoot: root,
      callbackFetch: async () => {
        controlCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(controlCalls).toBe(0);
      expect(await readFile(markerPath, 'utf8')).toBe('{"legacy":');
    } finally {
      await runner.close();
    }
  });

  it('refuses a marker whose filename does not match its encoded job', async () => {
    const root = await evidenceRoot();
    const markerRoot = join(root, 'llm-grant-pending');
    const encodedJob = 'encoded-job';
    const markerPath = join(
      markerRoot,
      `${createHash('sha256').update('different-job').digest('hex')}.marker`,
    );
    await mkdir(markerRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        jobId: encodedJob,
        issuer: {
          transport: 'relay',
          origin: 'https://ingress.test',
          generation: 'generation-a',
        },
      }),
      { mode: 0o600 },
    );
    let controlCalls = 0;
    const runner = createRunner({
      ...relayBaseOptions(),
      evidenceRoot: root,
      callbackFetch: async () => {
        controlCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(controlCalls).toBe(0);
      expect(await readFile(markerPath, 'utf8')).toContain(encodedJob);
    } finally {
      await runner.close();
    }
  });
});

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRunner } from '../apps/runner/src/runner';
import { createRelayLlmServiceClient } from '../apps/runner/src/llm-service-client';

const evidenceRoots: string[] = [];

const evidenceRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'cr-relay-runner-'));
  evidenceRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(evidenceRoots.map((root) => rm(root, { recursive: true, force: true })));
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

const waitForTerminal = async (runner: ReturnType<typeof createRunner>, jobId: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await runner.handle(
      new Request(`http://runner/jobs/${jobId}`, {
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );
    const state = (await response.json()) as { status: string };
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'aborted')
      return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Runner Job did not reach a terminal state');
};

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
});

describe('Runner relay admission and recovery', () => {
  it('fails a relay claim without a frozen selection before checkout', async () => {
    const commands: string[] = [];
    const runner = createRunner({
      ...relayBaseOptions(),
      evidenceRoot: await evidenceRoot(),
      process: async (_command, args) => {
        commands.push([...args].join(' '));
        return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
      },
    });
    try {
      const submitted = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            id: 'relay-no-selection',
            runId: 'run-relay-no-selection',
            attempt: 1,
            repositoryName: 'acme/reviewed',
            pullRequestNumber: 42,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha: '1111111111111111111111111111111111111111',
            headSha: '2222222222222222222222222222222222222222',
            repositoryReadToken: 'github-read-token',
          }),
        }),
      );
      expect(submitted.status).toBe(202);
      const terminal = await waitForTerminal(runner, 'relay-no-selection');
      expect(terminal).toMatchObject({ status: 'failed' });
      expect(commands).toEqual([]);
    } finally {
      await runner.close();
    }
  });

  it('issues with the full claim identity and revokes through the relay transport', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const runner = createRunner({
      ...relayBaseOptions(),
      evidenceRoot: await evidenceRoot(),
      callbackFetch: async (input, init) => {
        const inputUrl =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        const path = new URL(inputUrl).pathname;
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
      const submitted = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
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
          }),
        }),
      );
      expect(submitted.status).toBe(202);
      await waitForTerminal(runner, 'relay-issue-job');
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

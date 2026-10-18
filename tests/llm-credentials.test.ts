import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPiUpstream } from '../apps/llm-service/src/upstream';
import { createCredentialResolver } from '../apps/llm-service/src/credentials';

it('uses a host-only credential file without exposing its contents to the client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-credentials-'));
  try {
    const credentialFile = join(dir, 'model-key');
    await writeFile(credentialFile, 'private-key\n', { mode: 0o600 });
    const route = {
      id: 'review',
      protocol: 'chat-completions' as const,
      model: 'deepseek-flash',
      baseUrl: 'https://provider.invalid/v1',
      credentialFile,
    };
    const request = createPiUpstream({
      routes: [route],
      credential: createCredentialResolver([route]),
      fetch: async (_url, init) => {
        if (new Headers(init?.headers).get('authorization') !== 'Bearer private-key')
          return new Response('secret upstream diagnostic', { status: 401 });
        return new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const result = await request(
      'review',
      { model: 'review', stream: true, messages: [] },
      new AbortController().signal,
    );
    expect(result.status).toBe(200);
    const body = await result.text();
    expect(body).toContain('Ready');
    expect(body).not.toContain('private-key');
    expect(body).not.toContain('secret upstream diagnostic');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('serializes subscription refresh and preserves the rotated credential across service restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-oauth-'));
  const realFetch = globalThis.fetch;
  const access =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  try {
    const credentialFile = join(dir, 'subscription');
    await writeFile(
      credentialFile,
      JSON.stringify({ type: 'oauth', access: 'expired', refresh: 'old-refresh', expires: 1 }),
      { mode: 0o600 },
    );
    let used = false;
    globalThis.fetch = async (_url, init) => {
      if (
        used ||
        !(init?.body instanceof URLSearchParams) ||
        init.body.get('refresh_token') !== 'old-refresh'
      )
        return new Response(null, { status: 400 });
      used = true;
      return Response.json({
        access_token: access,
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      });
    };
    const route = {
      id: 'subscription',
      protocol: 'codex-responses' as const,
      model: 'gpt-6.1-sol',
      baseUrl: 'https://chatgpt.com/backend-api',
      credentialFile,
    };
    const resolver = createCredentialResolver([route]);
    const makeRequest = (credential: typeof resolver) =>
      createPiUpstream({
        routes: [route],
        credential,
        fetch: async (_url, init) => {
          if (new Headers(init?.headers).get('authorization') !== 'Bearer ' + access)
            return new Response(null, { status: 401 });
          return new Response(
            'data: {"type":"response.completed","response":{"id":"ok","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
    const review = async (credential: typeof resolver) => {
      const result = await makeRequest(credential)(
        'subscription',
        { model: 'subscription', stream: true, input: [], store: false },
        new AbortController().signal,
      );
      expect(result.status).toBe(200);
      expect(await result.text()).toContain('response.completed');
    };
    await Promise.all([review(resolver), review(resolver)]);
    await review(createCredentialResolver([route]));
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

it('uses a dedicated device login for subsequent subscription inference', async () => {
  const { loginSubscription } = await import('../apps/llm-service/src/credentials');
  const dir = await mkdtemp(join(tmpdir(), 'llm-login-'));
  const realFetch = globalThis.fetch;
  const access =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  try {
    const credentialFile = join(dir, 'subscription');
    let deviceShown = false;
    globalThis.fetch = async (url) => {
      const address = url instanceof Request ? url.url : url.toString();
      if (address.endsWith('/deviceauth/usercode'))
        return Response.json({ device_auth_id: 'device', user_code: 'TEST-CODE', interval: 1 });
      if (address.endsWith('/deviceauth/token') && deviceShown)
        return Response.json({ authorization_code: 'code', code_verifier: 'verifier' });
      if (address.endsWith('/oauth/token'))
        return Response.json({
          access_token: access,
          refresh_token: 'new-refresh',
          expires_in: 3600,
        });
      return new Response(null, { status: 400 });
    };
    await loginSubscription(credentialFile, {
      prompt: async () => 'device_code',
      notify: (event) => {
        if (event.type === 'device_code' && event.userCode === 'TEST-CODE') deviceShown = true;
      },
    });
    const route = {
      id: 'subscription',
      protocol: 'codex-responses' as const,
      model: 'gpt-6.1-sol',
      baseUrl: 'https://chatgpt.com/backend-api',
      credentialFile,
    };
    const upstream = createPiUpstream({
      routes: [route],
      credential: createCredentialResolver([route]),
      fetch: async (_url, init) => {
        if (new Headers(init?.headers).get('authorization') !== 'Bearer ' + access)
          return new Response(null, { status: 401 });
        return new Response(
          'data: {"type":"response.completed","response":{"id":"ok","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const result = await upstream(
      'subscription',
      { model: 'subscription', stream: true, input: [], store: false },
      new AbortController().signal,
    );
    expect(result.status).toBe(200);
    expect(await result.text()).toContain('response.completed');
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

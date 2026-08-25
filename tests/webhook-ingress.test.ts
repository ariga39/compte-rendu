import { describe, expect, it } from 'vitest';
import {
  MAX_WEBHOOK_BYTES,
  createIngressWorker,
  type IngressDependencies,
} from '../apps/ingress/src/index';

const secret = 'test-webhook-secret';

const payload = {
  action: 'opened',
  number: 42,
  installation: { id: 7 },
  repository: { id: 11 },
  pull_request: {
    base: { sha: 'base-sha' },
    head: { sha: 'head-sha' },
  },
};

async function signedRequest(value: unknown = payload) {
  const body = JSON.stringify(value);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  );
  const signature = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return new Request('https://example.com/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-1',
      'x-hub-signature-256': `sha256=${signature}`,
    },
    body,
  });
}

describe('Webhook ingress', () => {
  it('forwards one normalized supported pull request event and acknowledges it', async () => {
    const forwarded: Request[] = [];
    const dependencies: IngressDependencies = {
      secret,
      crypto: globalThis.crypto,
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    };
    const worker = createIngressWorker(dependencies);

    const response = await worker.fetch(await signedRequest());

    expect(response.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    expect(await forwarded[0].clone().json()).toEqual({
      deliveryId: 'delivery-1',
      event: 'pull_request',
      action: 'opened',
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      baseSha: 'base-sha',
      headSha: 'head-sha',
    });
  });
  it('rejects an invalid signature without contacting core', async () => {
    const forwarded: Request[] = [];
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });
    const request = await signedRequest();
    request.headers.set('x-hub-signature-256', 'sha256=' + 'a'.repeat(64));

    const response = await worker.fetch(request);

    expect(response.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });
  it('rejects a missing or empty delivery id without contacting core', async () => {
    const forwarded: Request[] = [];
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });

    const missingRequest = await signedRequest();
    missingRequest.headers.delete('x-github-delivery');
    const missingResponse = await worker.fetch(missingRequest);
    const emptyRequest = await signedRequest();
    emptyRequest.headers.set('x-github-delivery', '');
    const emptyResponse = await worker.fetch(emptyRequest);

    expect(missingResponse.status).toBe(400);
    expect(emptyResponse.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });
  it('rejects a malformed supported payload without contacting core', async () => {
    const forwarded: Request[] = [];
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });

    const response = await worker.fetch(await signedRequest({ action: 'opened' }));

    expect(response.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });
  it('ignores an unsupported GitHub event without contacting core', async () => {
    const forwarded: Request[] = [];
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });
    const request = await signedRequest();
    request.headers.set('x-github-event', 'issues');

    const response = await worker.fetch(request);

    expect(response.status).toBe(204);
    expect(forwarded).toHaveLength(0);
  });

  it('ignores an unsupported pull request action without contacting core', async () => {
    const forwarded: Request[] = [];
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });

    const response = await worker.fetch(await signedRequest({ ...payload, action: 'closed' }));

    expect(response.status).toBe(204);
    expect(forwarded).toHaveLength(0);
  });
  it('rejects an over-cap Content-Length before reading the body', async () => {
    let textReads = 0;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      },
    });
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      core: {
        fetch: async () => new Response(null, { status: 202 }),
      },
    });
    class TrackingRequest extends Request {
      override text() {
        textReads += 1;
        return super.text();
      }
    }
    const request = new TrackingRequest('https://example.com/webhooks/github', {
      method: 'POST',
      headers: {
        'content-length': String(MAX_WEBHOOK_BYTES + 1),
        'x-github-event': 'pull_request',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const response = await worker.fetch(request);

    expect(response.status).toBe(400);
    expect(textReads).toBe(0);
  });
  it('rejects a body above the ingress payload cap without contacting core', async () => {
    const forwarded: Request[] = [];
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });
    const oversizedPayload = { ...payload, padding: 'x'.repeat(MAX_WEBHOOK_BYTES) };

    const response = await worker.fetch(await signedRequest(oversizedPayload));

    expect(response.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });
  it('returns 503 when core responds with a non-2xx status', async () => {
    let calls = 0;
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      core: {
        fetch: async () => {
          calls += 1;
          return new Response(null, { status: 500 });
        },
      },
    });

    const response = await worker.fetch(await signedRequest());

    expect(response.status).toBe(503);
    expect(calls).toBe(1);
  });
  it('does not acknowledge a core failure and asks GitHub to retry', async () => {
    let calls = 0;
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      core: {
        fetch: async () => {
          calls += 1;
          throw new Error('core unavailable');
        },
      },
    });

    const response = await worker.fetch(await signedRequest());

    expect(response.status).toBe(503);
    expect(calls).toBe(1);
  });
});

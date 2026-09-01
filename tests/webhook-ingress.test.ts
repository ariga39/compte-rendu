import { describe, expect, it } from 'vitest';
import {
  MAX_WEBHOOK_BYTES,
  createIngressWorker as createIngressWorkerWithConfig,
  type IngressDependencies,
} from '../apps/ingress/src/index';
import { MAX_RUNNER_CALLBACK_BYTES } from '../packages/contracts/src';
import type { OperationalLogEvent } from '../packages/contracts/src';

const secret = 'test-webhook-secret';

type TestIngressDependencies = Omit<IngressDependencies, 'allowedInstallationIds'> &
  Partial<Pick<IngressDependencies, 'allowedInstallationIds'>>;

const createIngressWorker = (dependencies: TestIngressDependencies) =>
  createIngressWorkerWithConfig({ allowedInstallationIds: '[7]', ...dependencies });

const payload = {
  action: 'opened',
  number: 42,
  installation: { id: 7 },
  repository: { id: 11, visibility: 'private' },
  pull_request: {
    draft: false,
    user: { login: 'maintainer', type: 'User' },
    base: { sha: '1111111111111111111111111111111111111111', repo: { id: 11 } },
    head: { sha: '2222222222222222222222222222222222222222', repo: { id: 99 } },
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

const collectingLog = () => {
  const events: OperationalLogEvent[] = [];
  return {
    events,
    log: {
      record: async (event: OperationalLogEvent) => {
        events.push(event);
      },
    },
  };
};

describe('Webhook ingress', () => {
  it('forwards an authenticated runner callback through the public ingress route', async () => {
    const forwarded: Request[] = [];
    const callbackBody = JSON.stringify({ runId: 'run-callback-1', status: 'succeeded' });
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      allowedInstallationIds: '[7]',
      runnerCallbackToken: 'callback-token',
      core: {
        fetch: async (request) => {
          forwarded.push(request.clone());
          return new Response(null, { status: 202 });
        },
      },
    });

    const response = await worker.fetch(
      new Request('https://ingress.internal/runner-callback', {
        method: 'POST',
        headers: {
          authorization: 'Bearer callback-token',
          'content-type': 'application/json',
        },
        body: callbackBody,
      }),
    );

    expect(response.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    expect(await forwarded[0]?.text()).toBe(callbackBody);
    expect(forwarded[0]?.url).toBe('https://core.internal/runner-results');
  });

  it('rejects an unauthenticated runner callback without contacting core', async () => {
    const forwarded: Request[] = [];
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      allowedInstallationIds: '[7]',
      runnerCallbackToken: 'callback-token',
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });

    const response = await worker.fetch(
      new Request('https://ingress.internal/runner-callback', {
        method: 'POST',
        body: '{}',
      }),
    );

    expect(response.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it('rejects an oversized runner callback Content-Length before buffering', async () => {
    let bodyReads = 0;
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      runnerCallbackToken: 'callback-token',
      core: { fetch: async () => new Response(null, { status: 202 }) },
    });
    class TrackingRequest extends Request {
      override arrayBuffer() {
        bodyReads += 1;
        return super.arrayBuffer();
      }
    }

    const request = new TrackingRequest('https://ingress.internal/runner-callback', {
      method: 'POST',
      headers: {
        authorization: 'Bearer callback-token',
        'content-length': String(MAX_RUNNER_CALLBACK_BYTES + 1),
      },
      body: '{}',
    });
    const response = await worker.fetch(request);

    expect(response.status).toBe(413);
    expect(bodyReads).toBe(0);
  });

  it('rejects a runner callback whose buffered body exceeds 32 MiB without contacting core', async () => {
    const forwarded: Request[] = [];
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      runnerCallbackToken: 'callback-token',
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });

    const response = await worker.fetch(
      new Request('https://ingress.internal/runner-callback', {
        method: 'POST',
        headers: { authorization: 'Bearer callback-token' },
        body: new Uint8Array(MAX_RUNNER_CALLBACK_BYTES + 1),
      }),
    );

    expect(response.status).toBe(413);
    expect(forwarded).toHaveLength(0);
  });

  it('ignores eligible webhooks from an unapproved installation before reaching core', async () => {
    const forwarded: Request[] = [];
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      allowedInstallationIds: '[7]',
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });
    const requests = [
      await signedRequest({ ...payload, installation: { id: 99 } }),
      await signedRequest({
        action: 'created',
        installation: { id: 99 },
        repository: { id: 11 },
        issue: {
          number: 42,
          pull_request: { url: 'https://api.github.com/repos/example/repo/pulls/42' },
        },
        comment: {
          id: 987654,
          body: '/ai-review',
          user: { login: 'maintainer' },
        },
      }),
    ];
    requests[1].headers.set('x-github-event', 'issue_comment');

    expect((await worker.fetch(requests[0])).status).toBe(204);
    expect((await worker.fetch(requests[1])).status).toBe(204);
    expect(forwarded).toHaveLength(0);
  });

  it('fails closed without forwarding when the installation allowlist is missing or malformed', async () => {
    for (const allowedInstallationIds of [undefined, 'not-json', '[]', '[0]']) {
      const forwarded: Request[] = [];
      const worker = createIngressWorkerWithConfig({
        secret,
        crypto: globalThis.crypto,
        allowedInstallationIds,
        core: {
          fetch: async (request) => {
            forwarded.push(request);
            return new Response(null, { status: 202 });
          },
        },
      });

      const response = await worker.fetch(await signedRequest());

      expect(response.status).toBe(503);
      expect(forwarded).toHaveLength(0);
    }
  });

  it('forwards one normalized supported pull request event and acknowledges it', async () => {
    const forwarded: Request[] = [];
    const { events, log } = collectingLog();
    const dependencies: IngressDependencies = {
      secret,
      crypto: globalThis.crypto,
      allowedInstallationIds: '[7]',
      log,
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
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'accepted',
        deliveryId: 'delivery-1',
        event: 'pull_request',
      },
    ]);
    expect(forwarded).toHaveLength(1);
    expect(await forwarded[0].clone().json()).toEqual({
      deliveryId: 'delivery-1',
      event: 'pull_request',
      action: 'opened',
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      repositoryVisibility: 'private',
      baseRepositoryId: 11,
      headRepositoryId: 99,
      draft: false,
      baseSha: '1111111111111111111111111111111111111111',
      headSha: '2222222222222222222222222222222222222222',
    });
  });
  it('ignores an automatic pull request authored by a GitHub Bot', async () => {
    const forwarded: Request[] = [];
    const { events, log } = collectingLog();
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      log,
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });

    const response = await worker.fetch(
      await signedRequest({
        ...payload,
        pull_request: {
          ...payload.pull_request,
          user: { login: 'dependabot[bot]', type: 'Bot' },
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(forwarded).toHaveLength(0);
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        event: 'pull_request',
        reason: 'bot_pull_request',
      },
    ]);
  });
  it('keeps the accepted response when operational logging fails', async () => {
    let forwarded = false;
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      log: {
        record: () => {
          throw new Error('log sink unavailable');
        },
      },
      core: {
        fetch: async () => {
          forwarded = true;
          return new Response(null, { status: 202 });
        },
      },
    });

    const response = await worker.fetch(await signedRequest());

    expect(response.status).toBe(202);
    expect(forwarded).toBe(true);
  });
  it('rejects an invalid signature without contacting core', async () => {
    const forwarded: Request[] = [];
    const { events, log } = collectingLog();
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      log,
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });
    const request = await signedRequest();
    request.headers.set('x-hub-signature-256', 'sha256=' + 'a'.repeat(64));
    const rawBody = await request.clone().text();

    const response = await worker.fetch(request);

    expect(response.status).toBe(400);
    expect(forwarded).toHaveLength(0);
    expect(events).toEqual([
      { phase: 'ingress', outcome: 'rejected', reason: 'invalid_signature' },
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(request.headers.get('x-hub-signature-256'));
    expect(JSON.stringify(events)).not.toContain(rawBody);
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

  it('rejects a pull request with an empty or malformed SHA without contacting core', async () => {
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

    for (const headSha of ['', 'not-a-github-sha']) {
      const request = await signedRequest({
        ...payload,
        pull_request: {
          ...payload.pull_request,
          head: { ...payload.pull_request.head, sha: headSha },
        },
      });

      const response = await worker.fetch(request);

      expect(response.status).toBe(400);
    }

    expect(forwarded).toHaveLength(0);
  });
  it('ignores an unsupported GitHub event without contacting core', async () => {
    const forwarded: Request[] = [];
    const { events, log } = collectingLog();
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      log,
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
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        reason: 'unsupported_event',
      },
    ]);
  });

  it('ignores an unsupported pull request action without contacting core', async () => {
    const forwarded: Request[] = [];
    const { events, log } = collectingLog();
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      log,
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
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        event: 'pull_request',
        reason: 'unsupported_action',
      },
    ]);
  });

  it('ignores an unsupported pull request action even without a delivery id', async () => {
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
    const request = await signedRequest({ ...payload, action: 'closed' });
    request.headers.delete('x-github-delivery');

    const response = await worker.fetch(request);

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
    const { events, log } = collectingLog();
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      log,
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
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'retryable',
        deliveryId: 'delivery-1',
        event: 'pull_request',
        reason: 'core_unavailable',
      },
    ]);
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

  it('forwards a signed /ai-review issue comment as a normalized event', async () => {
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

    const request = await signedRequest({
      action: 'created',
      installation: { id: 7 },
      repository: { id: 11, visibility: 'private' },
      issue: {
        number: 42,
        pull_request: { url: 'https://api.github.com/repos/example/repo/pulls/42' },
      },
      comment: {
        id: 987654,
        body: '/ai-review',
        user: { login: 'maintainer' },
      },
    });
    request.headers.set('x-github-event', 'issue_comment');

    const response = await worker.fetch(request);

    expect(response.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    expect(await forwarded[0].clone().json()).toEqual({
      deliveryId: 'delivery-1',
      event: 'issue_comment',
      action: 'created',
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      commentId: 987654,
      commenterLogin: 'maintainer',
      command: '/ai-review',
    });
  });
  it('ignores an issue comment action other than created', async () => {
    const { events, log } = collectingLog();
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      log,
      core: {
        fetch: async () => new Response(null, { status: 202 }),
      },
    });
    const request = await signedRequest({
      action: 'edited',
      installation: { id: 7 },
      repository: { id: 11, visibility: 'private' },
      issue: {
        number: 42,
        pull_request: { url: 'https://api.github.com/repos/example/repo/pulls/42' },
      },
      comment: {
        id: 987655,
        body: '/ai-review',
        user: { login: 'maintainer' },
      },
    });
    request.headers.set('x-github-event', 'issue_comment');

    const response = await worker.fetch(request);

    expect(response.status).toBe(204);
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        event: 'issue_comment',
        reason: 'unsupported_action',
      },
    ]);
  });

  it('ignores issue comments whose body is not exactly /ai-review', async () => {
    const forwarded: Request[] = [];
    const { events, log } = collectingLog();
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      log,
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });

    for (const body of [' /ai-review', '/ai-review ', '/ai-review\n']) {
      const request = await signedRequest({
        action: 'created',
        installation: { id: 7 },
        repository: { id: 11, visibility: 'private' },
        issue: {
          number: 42,
          pull_request: { url: 'https://api.github.com/repos/example/repo/pulls/42' },
        },
        comment: {
          id: 987656,
          body,
          user: { login: 'maintainer' },
        },
      });
      request.headers.set('x-github-event', 'issue_comment');

      const response = await worker.fetch(request);

      expect(response.status).toBe(204);
    }

    expect(forwarded).toHaveLength(0);
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        event: 'issue_comment',
        reason: 'unsupported_action',
      },
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        event: 'issue_comment',
        reason: 'unsupported_action',
      },
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        event: 'issue_comment',
        reason: 'unsupported_action',
      },
    ]);
  });

  it('ignores a signed command on a non-PR issue without contacting core', async () => {
    const forwarded: Request[] = [];
    const { events, log } = collectingLog();
    const worker = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      log,
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });
    const request = await signedRequest({
      action: 'created',
      installation: { id: 7 },
      repository: { id: 11, visibility: 'private' },
      issue: { number: 42 },
      comment: {
        id: 987657,
        body: '/ai-review',
        user: { login: 'maintainer' },
      },
    });
    request.headers.set('x-github-event', 'issue_comment');

    const response = await worker.fetch(request);

    expect(response.status).toBe(204);
    expect(forwarded).toHaveLength(0);
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        event: 'issue_comment',
        reason: 'non_pull_request_issue',
      },
    ]);
  });
});

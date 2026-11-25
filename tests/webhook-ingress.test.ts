import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
  MAX_WEBHOOK_BYTES,
  handleGitHubWebhookEffect,
  type WebhookCoreSink,
} from '../apps/ingress/src/index';
import type {
  MetadataInvalidationEvent,
  OperationalLog,
  OperationalLogEvent,
  ReviewEvent,
} from '../packages/contracts/src';

const secret = 'test-webhook-secret';

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

type WebhookHarnessOptions = {
  readonly allowedInstallationIds?: unknown;
  readonly allowedBotAuthorIds?: unknown;
  readonly log?: OperationalLog;
  readonly submitReviewEvent?: WebhookCoreSink['submitReviewEvent'];
  readonly invalidateMetadata?: WebhookCoreSink['invalidateMetadata'];
};

const createWebhookHarness = (options: WebhookHarnessOptions = {}) => {
  const reviews: ReviewEvent[] = [];
  const metadata: MetadataInvalidationEvent[] = [];
  return {
    reviews,
    metadata,
    fetch: (request: Request) =>
      Effect.runPromise(
        handleGitHubWebhookEffect(request, {
          secret,
          crypto: globalThis.crypto,
          allowedInstallationIds:
            'allowedInstallationIds' in options ? options.allowedInstallationIds : '[7]',
          ...(options.allowedBotAuthorIds === undefined
            ? {}
            : { allowedBotAuthorIds: options.allowedBotAuthorIds }),
          ...(options.log === undefined ? {} : { log: options.log }),
          core: {
            submitReviewEvent: (event) =>
              Effect.gen(function* () {
                reviews.push(event);
                return options.submitReviewEvent === undefined
                  ? ('accepted' as const)
                  : yield* options.submitReviewEvent(event);
              }),
            invalidateMetadata: (event) =>
              Effect.gen(function* () {
                metadata.push(event);
                if (options.invalidateMetadata !== undefined)
                  yield* options.invalidateMetadata(event);
              }),
          },
        }),
      ),
  };
};

describe('Webhook ingress', () => {
  it('delivers one normalized supported pull request event and acknowledges it', async () => {
    const { events, log } = collectingLog();
    const worker = createWebhookHarness({ log });

    const response = await worker.fetch(await signedRequest());

    expect(response.status).toBe(202);
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'accepted',
        deliveryId: 'delivery-1',
        event: 'metadata',
      },
      {
        phase: 'ingress',
        outcome: 'accepted',
        deliveryId: 'delivery-1',
        event: 'pull_request',
      },
    ]);
    expect(worker.metadata).toEqual([
      {
        deliveryId: 'delivery-1',
        event: 'metadata',
        reason: 'repository_private',
        installationId: 7,
        repositoryIds: [11],
        visibility: 'private',
      },
    ]);
    expect(worker.reviews).toEqual([
      {
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
      },
    ]);
  });

  it('delivers normalized branch refs when the webhook supplies them', async () => {
    const worker = createWebhookHarness();

    const response = await worker.fetch(
      await signedRequest({
        ...payload,
        pull_request: {
          ...payload.pull_request,
          base: { ...payload.pull_request.base, ref: 'main' },
          head: { ...payload.pull_request.head, ref: 'feature/drawer' },
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(worker.reviews[0]).toMatchObject({
      event: 'pull_request',
      baseRef: 'main',
      headRef: 'feature/drawer',
    });
  });

  it('preserves human pull request handling when the author ID is explicitly null', async () => {
    const worker = createWebhookHarness();

    const response = await worker.fetch(
      await signedRequest({
        ...payload,
        pull_request: {
          ...payload.pull_request,
          user: { login: 'maintainer', type: 'User', id: null },
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(worker.metadata).toHaveLength(1);
    expect(worker.reviews).toHaveLength(1);
  });

  it('ignores an automatic pull request authored by a GitHub Bot', async () => {
    const { events, log } = collectingLog();
    const worker = createWebhookHarness({ log });

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
    expect(worker.metadata).toHaveLength(1);
    expect(worker.reviews).toHaveLength(0);
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'accepted',
        deliveryId: 'delivery-1',
        event: 'metadata',
      },
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        event: 'pull_request',
        reason: 'bot_pull_request',
      },
    ]);
  });

  it('delivers an automatic pull request from an allowlisted Bot author', async () => {
    const worker = createWebhookHarness({ allowedBotAuthorIds: '[12345]' });

    const response = await worker.fetch(
      await signedRequest({
        ...payload,
        pull_request: {
          ...payload.pull_request,
          user: { login: 'dependabot[bot]', id: 12345, type: 'Bot' },
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(worker.reviews).toHaveLength(1);
  });

  it('fails closed for Bot pull requests with null or missing author IDs', async () => {
    const worker = createWebhookHarness({ allowedBotAuthorIds: '[12345]' });

    for (const user of [
      { login: 'bot-with-null-id[bot]', type: 'Bot', id: null },
      { login: 'bot-without-id[bot]', type: 'Bot' },
    ]) {
      const response = await worker.fetch(
        await signedRequest({
          ...payload,
          pull_request: { ...payload.pull_request, user },
        }),
      );

      expect(response.status).toBe(204);
    }

    expect(worker.reviews).toHaveLength(0);
  });

  it('ignores an allowlisted Bot author from an unapproved installation before reaching core', async () => {
    const worker = createWebhookHarness({ allowedBotAuthorIds: '[12345]' });

    const response = await worker.fetch(
      await signedRequest({
        ...payload,
        installation: { id: 99 },
        pull_request: {
          ...payload.pull_request,
          user: { login: 'dependabot[bot]', id: 12345, type: 'Bot' },
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(worker.metadata).toHaveLength(0);
    expect(worker.reviews).toHaveLength(0);
  });

  it('ignores eligible webhooks from an unapproved installation before reaching core', async () => {
    const worker = createWebhookHarness();
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
    expect(worker.metadata).toHaveLength(0);
    expect(worker.reviews).toHaveLength(0);
  });

  it('fails closed without delivering an event when the installation allowlist is missing or malformed', async () => {
    for (const allowedInstallationIds of [undefined, 'not-json', '[]', '[0]']) {
      const worker = createWebhookHarness({ allowedInstallationIds });

      const response = await worker.fetch(await signedRequest());

      expect(response.status).toBe(503);
      expect(worker.metadata).toHaveLength(0);
      expect(worker.reviews).toHaveLength(0);
    }
  });

  it('delivers a manual review command when the Bot author allowlist is malformed', async () => {
    const worker = createWebhookHarness({ allowedBotAuthorIds: 'not-json' });
    const request = await signedRequest({
      action: 'created',
      installation: { id: 7 },
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
    });
    request.headers.set('x-github-event', 'issue_comment');

    const response = await worker.fetch(request);

    expect(response.status).toBe(202);
    expect(worker.reviews).toEqual([
      {
        deliveryId: 'delivery-1',
        event: 'issue_comment',
        action: 'created',
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        commentId: 987654,
        commenterLogin: 'maintainer',
        command: '/ai-review',
      },
    ]);
  });

  it('keeps non-allowlisted or malformed Bot events ignored without disabling humans', async () => {
    for (const allowedBotAuthorIds of ['[54321]', 'not-json']) {
      const worker = createWebhookHarness({ allowedBotAuthorIds });

      const botResponse = await worker.fetch(
        await signedRequest({
          ...payload,
          pull_request: {
            ...payload.pull_request,
            user: { login: 'other-bot[bot]', id: 12345, type: 'Bot' },
          },
        }),
      );
      const humanResponse = await worker.fetch(await signedRequest());

      expect(botResponse.status).toBe(204);
      expect(humanResponse.status).toBe(202);
      expect(worker.metadata).toHaveLength(2);
      expect(worker.reviews).toHaveLength(1);
    }
  });

  it('keeps the accepted response when operational logging fails', async () => {
    const worker = createWebhookHarness({
      log: {
        record: () => {
          throw new Error('log sink unavailable');
        },
      },
    });

    const response = await worker.fetch(await signedRequest());

    expect(response.status).toBe(202);
    expect(worker.reviews).toHaveLength(1);
  });

  it('rejects an invalid signature without delivering events', async () => {
    const { events, log } = collectingLog();
    const worker = createWebhookHarness({ log });
    const request = await signedRequest();
    request.headers.set('x-hub-signature-256', 'sha256=' + 'a'.repeat(64));
    const rawBody = await request.clone().text();

    const response = await worker.fetch(request);

    expect(response.status).toBe(400);
    expect(worker.metadata).toHaveLength(0);
    expect(worker.reviews).toHaveLength(0);
    expect(events).toEqual([
      { phase: 'ingress', outcome: 'rejected', reason: 'invalid_signature' },
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(request.headers.get('x-hub-signature-256'));
    expect(JSON.stringify(events)).not.toContain(rawBody);
  });

  it('rejects a missing or empty delivery id without delivering events', async () => {
    const worker = createWebhookHarness();

    const missingRequest = await signedRequest();
    missingRequest.headers.delete('x-github-delivery');
    const missingResponse = await worker.fetch(missingRequest);
    const emptyRequest = await signedRequest();
    emptyRequest.headers.set('x-github-delivery', '');
    const emptyResponse = await worker.fetch(emptyRequest);

    expect(missingResponse.status).toBe(400);
    expect(emptyResponse.status).toBe(400);
    expect(worker.metadata).toHaveLength(0);
    expect(worker.reviews).toHaveLength(0);
  });

  it('rejects a malformed supported payload without delivering events', async () => {
    const worker = createWebhookHarness();

    const response = await worker.fetch(await signedRequest({ action: 'opened' }));

    expect(response.status).toBe(400);
    expect(worker.metadata).toHaveLength(0);
    expect(worker.reviews).toHaveLength(0);
  });

  it('rejects a pull request with an empty or malformed SHA without scheduling a review', async () => {
    const worker = createWebhookHarness();

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

    expect(worker.metadata).toHaveLength(2);
    expect(worker.reviews).toHaveLength(0);
  });

  it('ignores an unsupported GitHub event without delivering events', async () => {
    const { events, log } = collectingLog();
    const worker = createWebhookHarness({ log });
    const request = await signedRequest();
    request.headers.set('x-github-event', 'issues');

    const response = await worker.fetch(request);

    expect(response.status).toBe(204);
    expect(worker.metadata).toHaveLength(0);
    expect(worker.reviews).toHaveLength(0);
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        reason: 'unsupported_event',
      },
    ]);
  });

  it('ignores an unsupported pull request action without delivering a review', async () => {
    const { events, log } = collectingLog();
    const worker = createWebhookHarness({ log });

    const response = await worker.fetch(await signedRequest({ ...payload, action: 'closed' }));

    expect(response.status).toBe(204);
    expect(worker.metadata).toHaveLength(1);
    expect(worker.reviews).toHaveLength(0);
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'accepted',
        deliveryId: 'delivery-1',
        event: 'metadata',
      },
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
    const worker = createWebhookHarness();
    const request = await signedRequest({ ...payload, action: 'closed' });
    request.headers.delete('x-github-delivery');

    const response = await worker.fetch(request);

    expect(response.status).toBe(204);
    expect(worker.metadata).toHaveLength(0);
    expect(worker.reviews).toHaveLength(0);
  });

  it('returns 503 when the Core sink rejects the event', async () => {
    const { events, log } = collectingLog();
    const worker = createWebhookHarness({
      log,
      submitReviewEvent: () => Effect.succeed('failed'),
    });

    const response = await worker.fetch(await signedRequest());

    expect(response.status).toBe(503);
    expect(worker.reviews).toHaveLength(1);
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'accepted',
        deliveryId: 'delivery-1',
        event: 'metadata',
      },
      {
        phase: 'ingress',
        outcome: 'retryable',
        deliveryId: 'delivery-1',
        event: 'pull_request',
        reason: 'core_unavailable',
      },
    ]);
  });

  it('does not acknowledge a Core failure and asks GitHub to retry', async () => {
    let calls = 0;
    const worker = createWebhookHarness({
      invalidateMetadata: () =>
        Effect.tryPromise({
          try: async () => {
            calls += 1;
            throw new Error('core unavailable');
          },
          catch: (cause) => cause,
        }),
    });

    const response = await worker.fetch(await signedRequest());

    expect(response.status).toBe(503);
    expect(calls).toBe(1);
    expect(worker.reviews).toHaveLength(0);
  });

  it('accepts a signed webhook at exactly the byte limit', async () => {
    const worker = createWebhookHarness();
    const value = { ...payload, padding: '界' };
    const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    value.padding += 'x'.repeat(MAX_WEBHOOK_BYTES - byteLength);
    expect((await worker.fetch(await signedRequest(value))).status).toBe(202);
    expect(worker.reviews).toHaveLength(1);
  });

  it('rejects a body above the ingress payload cap without delivering events', async () => {
    const worker = createWebhookHarness();
    const oversizedPayload = { ...payload, padding: 'x'.repeat(MAX_WEBHOOK_BYTES) };

    const response = await worker.fetch(await signedRequest(oversizedPayload));

    expect(response.status).toBe(400);
    expect(worker.metadata).toHaveLength(0);
    expect(worker.reviews).toHaveLength(0);
  });

  it('stops reading an oversized unknown-length webhook request', async () => {
    let cancelled = false;
    let sent = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) controller.close();
          else controller.enqueue(new Uint8Array(MAX_WEBHOOK_BYTES + 1));
          sent = true;
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const worker = createWebhookHarness();
    const response = await worker.fetch(
      new Request('https://example.com/webhooks/github', {
        method: 'POST',
        headers: { 'x-github-event': 'pull_request' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
  });

  it('rejects oversized webhook Content-Length before pulling the body', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const worker = createWebhookHarness();
    const request = new Request('https://example.com/webhooks/github', {
      method: 'POST',
      headers: {
        'content-length': String(MAX_WEBHOOK_BYTES + 1),
        'x-github-event': 'pull_request',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect((await worker.fetch(request)).status).toBe(400);
    expect(pulled).toBe(false);
  });

  it('delivers a signed /ai-review issue comment as a normalized event', async () => {
    const worker = createWebhookHarness();

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
    expect(worker.reviews).toEqual([
      {
        deliveryId: 'delivery-1',
        event: 'issue_comment',
        action: 'created',
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        commentId: 987654,
        commenterLogin: 'maintainer',
        command: '/ai-review',
      },
    ]);
  });

  it('ignores an issue comment action other than created', async () => {
    const { events, log } = collectingLog();
    const worker = createWebhookHarness({ log });
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
    expect(worker.reviews).toHaveLength(0);
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
    const { events, log } = collectingLog();
    const worker = createWebhookHarness({ log });

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

    expect(worker.reviews).toHaveLength(0);
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

  it('ignores a signed command on a non-PR issue without delivering events', async () => {
    const { events, log } = collectingLog();
    const worker = createWebhookHarness({ log });
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
    expect(worker.reviews).toHaveLength(0);
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

  it('delivers a signed check_run rerequested event for an approved installation', async () => {
    const { events, log } = collectingLog();
    const worker = createWebhookHarness({ log });
    const request = await signedRequest({
      action: 'rerequested',
      installation: { id: 7 },
      repository: { id: 11 },
      check_run: { id: 555, external_id: 'run-ext-1' },
      sender: { login: 'maintainer' },
    });
    request.headers.set('x-github-event', 'check_run');

    const response = await worker.fetch(request);

    expect(response.status).toBe(202);
    expect(worker.reviews).toEqual([
      {
        deliveryId: 'delivery-1',
        event: 'check_run',
        action: 'rerequested',
        repositoryId: 11,
        installationId: 7,
        checkRunId: 555,
        externalRunId: 'run-ext-1',
        senderLogin: 'maintainer',
      },
    ]);
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'accepted',
        deliveryId: 'delivery-1',
        event: 'check_run',
      },
    ]);
  });

  it('delivers a signed check_suite rerequested event for an approved installation', async () => {
    const worker = createWebhookHarness();
    const request = await signedRequest({
      action: 'rerequested',
      installation: { id: 7 },
      repository: { id: 11 },
      check_suite: { id: 555 },
      sender: { login: 'maintainer' },
    });
    request.headers.set('x-github-event', 'check_suite');

    const response = await worker.fetch(request);

    expect(response.status).toBe(202);
    expect(worker.reviews).toEqual([
      {
        deliveryId: 'delivery-1',
        event: 'check_suite',
        action: 'rerequested',
        repositoryId: 11,
        installationId: 7,
        checkSuiteId: 555,
        senderLogin: 'maintainer',
      },
    ]);
  });

  it.each([
    { action: 'completed' },
    { action: 'requested_action', requested_action: { identifier: 'other' } },
  ])('ignores unsupported Check action $action without delivering events', async (action) => {
    const { events, log } = collectingLog();
    const worker = createWebhookHarness({ log });
    const checkRun = await signedRequest({
      ...action,
      installation: { id: 7 },
      repository: { id: 11 },
      check_run: { id: 555, external_id: 'run-ext-1' },
      sender: { login: 'maintainer' },
    });
    checkRun.headers.set('x-github-event', 'check_run');
    const checkSuite = await signedRequest({
      action: 'requested',
      installation: { id: 7 },
      repository: { id: 11 },
      check_suite: { id: 555 },
      sender: { login: 'maintainer' },
    });
    checkSuite.headers.set('x-github-event', 'check_suite');

    expect((await worker.fetch(checkRun)).status).toBe(204);
    expect((await worker.fetch(checkSuite)).status).toBe(204);
    expect(worker.reviews).toHaveLength(0);
    expect(events).toEqual([
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        event: 'check_run',
        reason: 'unsupported_action',
      },
      {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: 'delivery-1',
        event: 'check_suite',
        reason: 'unsupported_action',
      },
    ]);
  });

  it('rejects a check re-request with a missing or null sender', async () => {
    const worker = createWebhookHarness();

    for (const sender of [undefined, null]) {
      const request = await signedRequest({
        action: 'rerequested',
        installation: { id: 7 },
        repository: { id: 11 },
        check_run: { id: 555, external_id: 'run-ext-1' },
        sender,
      });
      request.headers.set('x-github-event', 'check_run');

      expect((await worker.fetch(request)).status).toBe(400);
    }

    expect(worker.reviews).toHaveLength(0);
  });

  it('ignores a check re-request from an unapproved installation before reaching core', async () => {
    const worker = createWebhookHarness();
    const request = await signedRequest({
      action: 'rerequested',
      installation: { id: 99 },
      repository: { id: 11 },
      check_run: { id: 555, external_id: 'run-ext-1' },
      sender: { login: 'maintainer' },
    });
    request.headers.set('x-github-event', 'check_run');

    expect((await worker.fetch(request)).status).toBe(204);
    expect(worker.reviews).toHaveLength(0);
  });
});

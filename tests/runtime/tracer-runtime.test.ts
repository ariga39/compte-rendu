/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

const webhookSecret = 'runtime-test-webhook-secret';
const runnerCallbackToken = 'runtime-test-runner-callback-token';
const deliveryId = 'runtime-tracer-eligible-1';
const invalidDeliveryId = 'runtime-tracer-invalid-1';
const payload = {
  action: 'opened',
  number: 42,
  installation: { id: 7 },
  repository: { id: 11, visibility: 'private' },
  pull_request: {
    draft: false,
    user: { login: 'maintainer', type: 'User' },
    base: {
      sha: '1111111111111111111111111111111111111111',
      repo: { id: 11 },
    },
    head: {
      sha: '2222222222222222222222222222222222222222',
      repo: { id: 99 },
    },
  },
};

interface CapturedRunnerJob {
  readonly runId: string;
  readonly attempt: number;
  readonly repositoryUrl: string;
  readonly repositoryName: string;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly repositoryReadToken: string;
}

interface DeliveryOutcome {
  readonly deliveryId: string;
  readonly status: string;
  readonly runId: string;
}

const signedWebhook = async (
  id = deliveryId,
  event = 'pull_request',
  webhookPayload: unknown = payload,
) => {
  const body = JSON.stringify(webhookPayload);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  );
  const signature = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return new Request('https://tracer.internal/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': id,
      'x-hub-signature-256': `sha256=${signature}`,
    },
    body,
  });
};

const runtimeHarness = {
  send: (request: Request) => SELF.fetch(request),
  clearCapture: async () => {
    const response = await SELF.fetch(
      new Request('https://tracer.internal/__test/capture', { method: 'DELETE' }),
    );
    if (!response.ok) throw new Error(`could not clear runner capture: ${response.status}`);
  },
  readCapture: async (): Promise<readonly CapturedRunnerJob[]> => {
    const response = await SELF.fetch('https://tracer.internal/__test/capture');
    return (await response.json()) as readonly CapturedRunnerJob[];
  },
  claim: () =>
    SELF.fetch(
      new Request('https://tracer.internal/runner-claim', {
        method: 'POST',
        headers: { authorization: `Bearer ${runnerCallbackToken}` },
      }),
    ),
  readDeliveryOutcome: async (id: string): Promise<DeliveryOutcome | undefined> => {
    const response = await SELF.fetch(
      `https://tracer.internal/__test/outcome?deliveryId=${encodeURIComponent(id)}`,
    );
    if (response.status === 404) return undefined;
    return (await response.json()) as DeliveryOutcome;
  },
};

describe('local Worker runtime tracer', () => {
  beforeEach(() => runtimeHarness.clearCapture());

  it('routes a signed webhook to D1, then pulls its Job through public ingress', async () => {
    const response = await runtimeHarness.send(await signedWebhook());

    expect(response.status).toBe(202);
    expect(await runtimeHarness.readCapture()).toEqual([]);

    const claim = await runtimeHarness.claim();
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as CapturedRunnerJob & { readonly id: string };
    expect(claimed).toMatchObject({
      id: expect.any(String),
      runId: expect.any(String),
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      repositoryName: 'acme/reviewed',
      pullRequestNumber: 42,
      baseSha: payload.pull_request.base.sha,
      headSha: payload.pull_request.head.sha,
      repositoryReadToken: 'test-read-token',
    });

    const outcome = await runtimeHarness.readDeliveryOutcome(deliveryId);
    expect(outcome).toMatchObject({
      deliveryId,
      status: 'scheduled',
      runId: claimed.runId,
    });
  });

  it('accepts a signed installation removal larger than the D1 parameter limit', async () => {
    const removed = Array.from({ length: 101 }, (_, i) => ({
      id: 5000 + i,
      name: `repo-${i}`,
      full_name: `acme/repo-${i}`,
      private: false,
    }));
    const response = await runtimeHarness.send(
      await signedWebhook('runtime-bulk-removal', 'installation_repositories', {
        action: 'removed',
        installation: { id: 7 },
        repositories_removed: removed,
      }),
    );
    expect(response.status).toBe(202);
  });

  it('rejects an invalid signature before admission and leaves no runtime outcome', async () => {
    const request = await signedWebhook(invalidDeliveryId);
    request.headers.set('x-hub-signature-256', `sha256=${'0'.repeat(64)}`);

    const response = await runtimeHarness.send(request);

    expect(response.status).toBe(400);
    expect(await runtimeHarness.readCapture()).toEqual([]);
    expect(await runtimeHarness.readDeliveryOutcome(invalidDeliveryId)).toBeUndefined();
  });

  it.each([
    ['failed', 'rerequested', 43],
    ['cancelled', 'rerequested', 46],
    ['cancelled', 'requested_action', 47],
  ] as const)(
    'restarts a %s review through a signed %s Check event',
    async (status, action, pr) => {
      const fixture = await SELF.fetch(`https://tracer.internal/__test/${status}-review?pr=${pr}`, {
        method: 'POST',
      });
      expect(fixture.status).toBe(200);
      const original = (await fixture.json()) as { runId: string; checkRunId: number };
      const rerunPayload = {
        action,
        ...(action === 'requested_action'
          ? { requested_action: { identifier: 'retry_review' } }
          : {}),
        installation: { id: 7 },
        repository: { id: 11 },
        sender: { login: 'maintainer' },
        check_run: { id: original.checkRunId, external_id: original.runId, pull_requests: [] },
      };
      const rerunDelivery = `runtime-check-rerequest-${pr}`;
      const response = await runtimeHarness.send(
        await signedWebhook(rerunDelivery, 'check_run', rerunPayload),
      );
      expect(response.status).toBe(202);

      const claim = await runtimeHarness.claim();
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as CapturedRunnerJob;
      expect(claimed).toMatchObject({
        runId: expect.any(String),
        attempt: 1,
        pullRequestNumber: pr,
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '3333333333333333333333333333333333333333',
      });
      expect(claimed.runId).not.toBe(original.runId);
      expect(await runtimeHarness.readDeliveryOutcome(`runtime-original-${pr}`)).toMatchObject({
        runId: original.runId,
        status,
      });

      const replay = await runtimeHarness.send(
        await signedWebhook(rerunDelivery, 'check_run', rerunPayload),
      );
      expect(replay.status).toBe(202);
      expect(await runtimeHarness.readDeliveryOutcome(rerunDelivery)).toMatchObject({
        runId: claimed.runId,
        status: 'scheduled',
      });
      expect((await runtimeHarness.claim()).status).toBe(204);
    },
  );

  it('renews a claimed read token through the unified application ingress', async () => {
    const renewalDelivery = 'runtime-tracer-read-renewal';
    const renewalPayload = { ...payload, number: 45 };
    const scheduled = await runtimeHarness.send(
      await signedWebhook(renewalDelivery, 'pull_request', renewalPayload),
    );
    expect(scheduled.status).toBe(202);

    const claim = await runtimeHarness.claim();
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as CapturedRunnerJob & {
      readonly id: string;
      readonly attempt: number;
    };

    const renewal = await SELF.fetch(
      new Request('https://tracer.internal/runner-read-token', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runnerCallbackToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          runId: claimed.runId,
          jobId: claimed.id,
          attempt: claimed.attempt,
        }),
      }),
    );

    expect(renewal.status).toBe(200);
    expect(renewal.headers.get('cache-control')).toBe('no-store');
    expect(await renewal.json()).toMatchObject({
      token: 'test-read-token',
      expiresAt: expect.any(String),
    });
  });
});

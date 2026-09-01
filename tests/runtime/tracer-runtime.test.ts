/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

const webhookSecret = 'runtime-test-webhook-secret';
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

const signedWebhook = async (id = deliveryId) => {
  const body = JSON.stringify(payload);
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
      'x-github-event': 'pull_request',
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

  it('routes a signed eligible webhook through ingress, CORE, D1, and immediate Runner submission', async () => {
    const response = await runtimeHarness.send(await signedWebhook());

    expect(response.status).toBe(202);
    const captures = await runtimeHarness.readCapture();
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
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
      runId: captures[0].runId,
    });
  });

  it('rejects an invalid signature before CORE and leaves no runtime outcome', async () => {
    const request = await signedWebhook(invalidDeliveryId);
    request.headers.set('x-hub-signature-256', `sha256=${'0'.repeat(64)}`);

    const response = await runtimeHarness.send(request);

    expect(response.status).toBe(400);
    expect(await runtimeHarness.readCapture()).toEqual([]);
    expect(await runtimeHarness.readDeliveryOutcome(invalidDeliveryId)).toBeUndefined();
  });
});

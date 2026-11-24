import { describe, expect, it, vi } from 'vitest';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import type { OperationalLogEvent } from '../packages/contracts/src';
import { SqliteD1Database } from './support/d1-database';
import { claimRunnerJob } from './support/runner-claim';
import {
  eligibleEvent,
  coreEnv,
  successfulCallback,
  failedCallback,
  abortedCallback,
  postHogEvents,
  postHogTestDefaults,
  capturePostHogTransport,
  failReadAfterSchedulingWrite,
} from './support/core-worker-harness';

describe('Core lifecycle telemetry and terminal classification', () => {
  it.each([
    {
      failure: { reason: 'upstream', cause: 'upstream-error', httpStatus: 400 },
      expected: { phase: 'agent', reason: 'upstream', httpStatus: 400 },
    },
    {
      failure: { reason: 'upstream', cause: 'upstream-error', httpStatus: 429 },
      expected: { phase: 'agent', reason: 'upstream', httpStatus: 429 },
    },
    {
      failure: { reason: 'upstream', cause: 'upstream-error', httpStatus: 503 },
      expected: { phase: 'agent', reason: 'upstream', httpStatus: 503 },
    },
    {
      failure: { reason: 'upstream', cause: 'upstream-error' },
      expected: { phase: 'agent', reason: 'upstream' },
    },
    {
      failure: { reason: 'invalid-output', cause: 'result-schema-failure' },
      expected: { phase: 'output_validation', reason: 'invalid_output' },
    },
  ])(
    'persists callback failure $failure as a distinct dashboard failure after worker recreation',
    async ({ failure, expected }) => {
      const database = new SqliteD1Database();
      const store = createD1ReviewStateStore(database);
      const review = await store.claimReview({
        deliveryId: 'failure-classification-run',
        job: {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          baseSha: '1'.repeat(40),
          headSha: '2'.repeat(40),
          trigger: 'automatic',
          repositoryVisibility: 'private',
        },
        occurredAt: '2026-10-19T00:00:00.000Z',
      });
      if (review.kind !== 'claimed') throw new Error('not admitted');
      await store.claimNextJob({
        jobId: 'failure-job',
        attempt: 1,
        occurredAt: '2026-10-19T00:00:01.000Z',
      });
      const env = { ...coreEnv(database), EVIDENCE_BUCKET: { put: async () => undefined } };
      const worker = createCoreWorker(env, { stateStore: store, github: {} });
      const callback = {
        ...JSON.parse(await failedCallback(review.runId, 'failure-job')),
        failure,
      };
      const post = (body: unknown) =>
        worker.fetch(
          new Request('https://core.internal/runner-results', {
            method: 'POST',
            headers: { 'x-compte-rendu-runner-callback': 'verified' },
            body: JSON.stringify(body),
          }),
        );
      expect((await post({ ...callback, id: 'foreign-job' })).status).toBe(409);
      expect((await post({ ...callback, failure: { ...failure, httpStatus: 999 } })).status).toBe(
        400,
      );
      expect((await post(callback)).status).toBe(202);
      const reader = createCoreWorker(env);
      const detail = await (
        await reader.fetch(new Request(`https://core.internal/api/jobs/${review.runId}`))
      ).json();
      expect(detail).toMatchObject({
        task: { status: 'failed', identity: { kind: 'anonymous' }, failure: expected },
      });
      const history = await (
        await reader.fetch(new Request('https://core.internal/api/jobs'))
      ).json();
      expect(history.tasks[0].failure).toEqual(expected);
      database.close();
    },
  );

  it('persists job model usage from an owned failed callback without exposing private repository identity', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const review = await store.claimReview({
      deliveryId: 'usage-run',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        trigger: 'automatic',
        repositoryVisibility: 'private',
      },
      occurredAt: '2026-10-19T00:00:00.000Z',
    });
    if (review.kind !== 'claimed') throw new Error('not admitted');
    await store.claimNextJob({
      jobId: 'usage-job',
      attempt: 1,
      occurredAt: '2026-10-19T00:00:01.000Z',
    });
    const env = { ...coreEnv(database), EVIDENCE_BUCKET: { put: async () => undefined } };
    const worker = createCoreWorker(env, { stateStore: store, github: {} });
    const usage = {
      version: 1,
      models: [
        {
          route: 'reviewer',
          model: 'deepseek-v4.1-flash',
          requests: 2,
          incompleteRequests: 1,
          inputTokens: { total: 1200, reportedRequests: 2 },
          uncachedInputTokens: { total: 300, reportedRequests: 2 },
          cacheReadTokens: { total: 900, reportedRequests: 2 },
          cacheWriteTokens: null,
          outputTokens: { total: 80, reportedRequests: 1 },
          reasoningTokens: { total: 30, reportedRequests: 1 },
        },
      ],
    };
    const callback = { ...JSON.parse(await failedCallback(review.runId, 'usage-job')), usage };
    const post = (body: unknown) =>
      worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-callback': 'verified' },
          body: JSON.stringify(body),
        }),
      );
    const detail = async () =>
      (
        await createCoreWorker(env).fetch(
          new Request(`https://core.internal/api/jobs/${review.runId}`),
        )
      ).json();
    expect((await post({ ...callback, id: 'foreign-job' })).status).toBe(409);
    expect(await detail()).toMatchObject({ usage: null });
    expect(
      (
        await post({
          ...callback,
          usage: { ...usage, models: [{ ...usage.models[0], requests: -1 }] },
        })
      ).status,
    ).toBe(400);
    expect((await post(callback)).status).toBe(202);
    expect((await post({ ...callback, usage: { version: 1, models: [] } })).status).toBe(202);
    expect(await detail()).toMatchObject({
      usage,
      task: { identity: { kind: 'anonymous' }, status: 'failed' },
    });
    expect(JSON.stringify(await detail())).not.toContain('repositoryId');
    database.close();
  });

  it('captures an enabled scheduled lifecycle event after the response is accepted', async () => {
    const database = new SqliteD1Database();
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const env = {
      ...coreEnv(database),
      ...postHogTestDefaults.environment,
    };
    const worker = createCoreWorker(env, postHogTestDefaults.dependencies);

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            freeFormAcceptanceNote142: 'must-not-reach-posthog-wire-payload',
          }),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );

      expect(response.status).toBe(202);
      expect(waitUntilTasks).toHaveLength(2);
      await Promise.all(waitUntilTasks);
      expect(requests).toHaveLength(1);
      const wirePayload = await requests[0].text();
      expect(wirePayload).not.toContain('must-not-reach-posthog-wire-payload');
      expect(wirePayload).not.toContain(eligibleEvent.deliveryId);
      expect(wirePayload).not.toContain(eligibleEvent.baseSha);
      expect(wirePayload).not.toContain(eligibleEvent.headSha);
      const requestPayload = JSON.parse(wirePayload) as {
        api_key: string;
        sent_at: string;
        batch: Array<{
          event: string;
          distinct_id: string;
          properties: Record<string, unknown>;
        }>;
      };
      expect(requests[0].url).toBe('https://posthog.example.test/batch/');
      expect(requests[0].headers.get('content-type')).toBe('application/json');
      expect(requests[0].headers.get('authorization')).toBeNull();
      expect(requestPayload.api_key).toBe('phc_test_project_key');
      expect(requestPayload.sent_at).toEqual(expect.any(String));
      const payload = requestPayload.batch[0];
      expect(payload).toEqual({
        event: 'review scheduled',
        distinct_id: expect.any(String),
        timestamp: expect.any(String),
        uuid: expect.any(String),
        properties: {
          schema_version: 1,
          environment: 'staging',
          deployment: 'test-installation',
          run_id: expect.any(String),
          trigger: 'automatic',
          $process_person_profile: false,
          $is_server: true,
          $geoip_disable: true,
        },
      });
      expect(payload.properties.run_id).toBe(payload.distinct_id);
    } finally {
      fetcher.mockRestore();
      database.close();
    }
  });

  it('keeps a configured PostHog base path before /batch/', async () => {
    const database = new SqliteD1Database();
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const env = {
      ...coreEnv(database),
      ...postHogTestDefaults.environment,
      POSTHOG_HOST: 'https://posthog.example.test/ingest',
    };
    const worker = createCoreWorker(env, postHogTestDefaults.dependencies);

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            deliveryId: 'delivery-posthog-base-path',
          }),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );

      expect(response.status).toBe(202);
      await Promise.all(waitUntilTasks);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('https://posthog.example.test/ingest/batch/');
    } finally {
      fetcher.mockRestore();
      database.close();
    }
  });

  it('sends no lifecycle requests when PostHog is disabled', async () => {
    const database = new SqliteD1Database();
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const env = { ...coreEnv(database), POSTHOG_ENABLED: 'false' };
    const worker = createCoreWorker(env, postHogTestDefaults.dependencies);

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-posthog-disabled' }),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );

      expect(response.status).toBe(202);
      await Promise.all(waitUntilTasks);
      expect(requests).toHaveLength(0);
    } finally {
      fetcher.mockRestore();
      database.close();
    }
  });

  it('keeps scheduling successful and skips capture for invalid enabled PostHog configuration', async () => {
    const database = new SqliteD1Database();
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = {
      ...coreEnv(database),
      ...postHogTestDefaults.environment,
      POSTHOG_PROJECT_API_KEY: 'not-a-project-key',
      POSTHOG_HOST: 'http://posthog.example.test',
    };
    const worker = createCoreWorker(env, postHogTestDefaults.dependencies);

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            deliveryId: 'delivery-posthog-invalid-configuration',
          }),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );

      expect(response.status).toBe(202);
      await Promise.all(waitUntilTasks);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith('PostHog telemetry unavailable: configuration');
      expect(requests).toHaveLength(0);
    } finally {
      fetcher.mockRestore();
      warning.mockRestore();
      database.close();
    }
  });

  it('keeps scheduling, claim, publication, and terminal state successful when PostHog capture fails', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const { fetcher, waitUntilTasks } = capturePostHogTransport(400);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let published = false;
    const env = {
      ...coreEnv(database),
      EVIDENCE_BUCKET: { put: async () => undefined },
      ...postHogTestDefaults.environment,
    };
    const worker = createCoreWorker(env, {
      ...postHogTestDefaults.dependencies,
      stateStore,
      github: {
        ...postHogTestDefaults.dependencies.github,
        loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
        createReview: async ({ payload }) => {
          published = true;
          return { kind: 'created' as const, review: payload };
        },
      },
    });

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            deliveryId: 'delivery-posthog-capture-failure',
          }),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );

      expect(response.status).toBe(202);
      await Promise.all(waitUntilTasks.splice(0));

      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { id: string; runId: string; attempt: number };
      await Promise.all(waitUntilTasks.splice(0));

      const callback = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: await successfulCallback(claimed.runId, claimed.id, claimed.attempt),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );
      expect(callback.status).toBe(202);
      await Promise.all(waitUntilTasks);

      expect(published).toBe(true);
      await expect(stateStore.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'completed',
      });
      expect(warning).toHaveBeenCalledWith('PostHog telemetry unavailable: capture');
    } finally {
      fetcher.mockRestore();
      warning.mockRestore();
      database.close();
    }
  });

  it('captures a finished lifecycle event when an unclaimed old head is superseded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1788480000000);
    const database = new SqliteD1Database();
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const env = {
      ...coreEnv(database),
      ...postHogTestDefaults.environment,
    };
    const worker = createCoreWorker(env, postHogTestDefaults.dependencies);

    try {
      const oldSchedule = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            deliveryId: 'delivery-old-head-no-runner-job',
          }),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );
      expect(oldSchedule.status).toBe(202);
      await Promise.all(waitUntilTasks.splice(0));

      vi.setSystemTime(1788480005000);
      const newerSchedule = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            action: 'synchronize',
            deliveryId: 'delivery-newer-head-admitted',
            headSha: '3333333333333333333333333333333333333333',
          }),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );
      expect(newerSchedule.status).toBe(202);
      await Promise.all(waitUntilTasks);

      const events = await postHogEvents(requests);
      expect(events).toHaveLength(3);
      const scheduledEvents = events.filter(
        (event) => (event as { event: string }).event === 'review scheduled',
      ) as Array<{ distinct_id: string; properties: Record<string, unknown> }>;
      expect(scheduledEvents).toHaveLength(2);
      const oldRunId = scheduledEvents[0]?.distinct_id;
      expect(oldRunId).toEqual(expect.any(String));
      const finishedEvents = events.filter(
        (event) => (event as { event: string }).event === 'review finished',
      ) as Array<{ distinct_id: string; properties: Record<string, unknown> }>;
      expect(finishedEvents).toHaveLength(1);
      const finished = finishedEvents[0];
      if (finished === undefined || oldRunId === undefined)
        throw new Error('lifecycle event missing');
      expect(finished).toMatchObject({
        properties: {
          outcome: 'superseded',
          published: false,
          total_duration_ms: 5000,
          cleanup_status: 'unknown',
          evidence_status: 'unknown',
        },
      });
      expect(finished.distinct_id).toBe(oldRunId);
      expect(finished.properties.run_id).toBe(oldRunId);
      expect(finished.properties).not.toHaveProperty('failure_phase');
      expect(finished.properties).not.toHaveProperty('failure_reason');
    } finally {
      fetcher.mockRestore();
      database.close();
      vi.useRealTimers();
    }
  });

  it('captures a claimed lifecycle event after the atomic Runner claim', async () => {
    const database = new SqliteD1Database();
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const env = {
      ...coreEnv(database),
      ...postHogTestDefaults.environment,
    };
    const worker = createCoreWorker(env, postHogTestDefaults.dependencies);

    try {
      const scheduled = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-claim-lifecycle' }),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );
      expect(scheduled.status).toBe(202);
      await Promise.all(waitUntilTasks.splice(0));

      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );

      expect(claim.status).toBe(200);
      await Promise.all(waitUntilTasks);
      const events = await postHogEvents(requests);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        event: 'review claimed',
        distinct_id: expect.any(String),
        properties: {
          queue_wait_ms: expect.any(Number),
          $process_person_profile: false,
        },
      });
      expect(
        (events[1] as { properties: { queue_wait_ms: number } }).properties.queue_wait_ms,
      ).toBeGreaterThanOrEqual(0);
    } finally {
      fetcher.mockRestore();
      database.close();
    }
  });

  it('captures a finished lifecycle event after a terminal failed callback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'));
    const database = new SqliteD1Database();
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const env = {
      ...coreEnv(database),
      EVIDENCE_BUCKET: { put: async () => undefined },
      ...postHogTestDefaults.environment,
    };
    const worker = createCoreWorker(env, postHogTestDefaults.dependencies);

    try {
      const scheduled = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-finished-lifecycle' }),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );
      expect(scheduled.status).toBe(202);
      await Promise.all(waitUntilTasks.splice(0));

      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { id: string; runId: string; attempt: number };
      await Promise.all(waitUntilTasks.splice(0));

      vi.setSystemTime(new Date('2026-09-04T00:00:06.000Z'));
      const callbackBody = JSON.parse(
        await failedCallback(claimed.runId, claimed.id, claimed.attempt),
      ) as Record<string, unknown>;
      callbackBody.timestamps = {
        executionStartedAt: '2026-09-04T00:00:01.000Z',
        cleanupCompletedAt: '2026-09-04T00:00:06.000Z',
      };

      const callback = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: JSON.stringify(callbackBody),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );

      expect(callback.status).toBe(202);
      await Promise.all(waitUntilTasks);
      const events = await postHogEvents(requests);
      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({
        event: 'review finished',
        distinct_id: expect.any(String),
        properties: {
          outcome: 'failed',
          published: false,
          total_duration_ms: 6000,
          cleanup_status: 'destroyed',
          evidence_status: 'incomplete',
          failure_phase: 'agent',
          failure_reason: 'agent',
          $process_person_profile: false,
        },
      });
      expect((events[2] as { properties: Record<string, unknown> }).properties).not.toHaveProperty(
        'queue_wait_ms',
      );
    } finally {
      fetcher.mockRestore();
      database.close();
      vi.useRealTimers();
    }
  });

  it('captures a completed lifecycle event after successful publication', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:10.000Z'));
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-finished-success-lifecycle',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('success lifecycle run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const env = {
      REVIEW_DB: database,
      EVIDENCE_BUCKET: { put: async () => undefined },
      GITHUB_APP_ID: '1234567',
      GITHUB_APP_PRIVATE_KEY: 'test-private-key',
      ...postHogTestDefaults.environment,
    };
    const worker = createCoreWorker(env, {
      ...postHogTestDefaults.dependencies,
      stateStore,
      github: {
        loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
        createReview: async ({ payload }) => ({ kind: 'created', review: payload }),
      },
    });

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: await successfulCallback(claimed.runId),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );

      expect(response.status).toBe(202);
      await Promise.all(waitUntilTasks);
      const events = await postHogEvents(requests);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'review finished',
        properties: {
          outcome: 'completed',
          published: true,
          total_duration_ms: 10000,
        },
      });
      const properties = (events[0] as { properties: Record<string, unknown> }).properties;
      expect(properties).not.toHaveProperty('failure_phase');
      expect(properties).not.toHaveProperty('failure_reason');
    } finally {
      fetcher.mockRestore();
      database.close();
      vi.useRealTimers();
    }
  });

  it('captures a finished lifecycle event when a running old head is superseded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'));
    const database = new SqliteD1Database();
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    let oldRunId = '';
    const env = {
      ...coreEnv(database, async (request) => {
        if (request.method !== 'DELETE') return new Response(null, { status: 404 });
        return Response.json({
          id: new URL(request.url).pathname.split('/').pop(),
          runId: oldRunId,
          attempt: 1,
          evidence: { id: 'evidence-old', status: 'pending' },
          status: 'aborted',
          stage: 'cleanup',
          sandbox: { cleanup: 'destroyed' },
        });
      }),
      ...postHogTestDefaults.environment,
    };
    const worker = createCoreWorker(env, postHogTestDefaults.dependencies);
    const context = { waitUntil: (task: Promise<unknown>) => waitUntilTasks.push(task) };

    try {
      const scheduled = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            deliveryId: 'delivery-running-old-head-lifecycle',
          }),
        }),
        env,
        context,
      );
      expect(scheduled.status).toBe(202);
      await Promise.all(waitUntilTasks.splice(0));

      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
        env,
        context,
      );
      expect(claim.status).toBe(200);
      oldRunId = ((await claim.json()) as { runId: string }).runId;
      await Promise.all(waitUntilTasks.splice(0));

      vi.setSystemTime(new Date('2026-09-04T00:00:05.000Z'));
      const replacement = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            action: 'synchronize',
            deliveryId: 'delivery-running-new-head-lifecycle',
            headSha: '3333333333333333333333333333333333333333',
          }),
        }),
        env,
        context,
      );
      expect(replacement.status).toBe(202);
      await Promise.all(waitUntilTasks);

      const finished = (await postHogEvents(requests)).find(
        (event) =>
          (event as { event: string; distinct_id: string }).event === 'review finished' &&
          (event as { event: string; distinct_id: string }).distinct_id === oldRunId,
      );
      expect(finished).toMatchObject({
        event: 'review finished',
        distinct_id: oldRunId,
        properties: {
          run_id: oldRunId,
          outcome: 'superseded',
          published: false,
          total_duration_ms: 5000,
        },
      });
    } finally {
      fetcher.mockRestore();
      database.close();
      vi.useRealTimers();
    }
  });

  it('captures a superseded lifecycle event when the head changes during publication', async () => {
    const database = new SqliteD1Database();
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const env = {
      ...coreEnv(database),
      EVIDENCE_BUCKET: { put: async () => undefined },
      ...postHogTestDefaults.environment,
    };
    let currentHead = eligibleEvent.headSha;
    const worker = createCoreWorker(env, {
      ...postHogTestDefaults.dependencies,
      github: {
        ...postHogTestDefaults.dependencies.github,
        loadReviewTarget: async () => ({ headSha: currentHead }),
        createReview: async ({ payload }) => ({ kind: 'created', review: payload }),
      },
    });

    try {
      const scheduled = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            deliveryId: 'delivery-finished-head-changed-lifecycle',
          }),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );
      expect(scheduled.status).toBe(202);
      await Promise.all(waitUntilTasks.splice(0));

      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { id: string; runId: string; attempt: number };
      await Promise.all(waitUntilTasks.splice(0));
      currentHead = '3333333333333333333333333333333333333333';

      const callback = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: await successfulCallback(claimed.runId, claimed.id, claimed.attempt),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );

      expect(callback.status).toBe(202);
      await Promise.all(waitUntilTasks);
      const events = await postHogEvents(requests);
      expect(events).toHaveLength(3);
      const finished = events.find(
        (event) => (event as { event: string }).event === 'review finished',
      ) as { properties: Record<string, unknown> } | undefined;
      expect(finished).toMatchObject({
        event: 'review finished',
        properties: {
          outcome: 'superseded',
          published: false,
        },
      });
      expect(finished?.properties).not.toHaveProperty('failure_phase');
      expect(finished?.properties).not.toHaveProperty('failure_reason');
    } finally {
      fetcher.mockRestore();
      database.close();
    }
  });

  it.each([successfulCallback, failedCallback, abortedCallback])(
    'keeps a cancelled claim and its evidence when a late %s arrives',
    async (makeCallback) => {
      const database = new SqliteD1Database();
      const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
      try {
        const state = createD1ReviewStateStore(database);
        const queued = await state.claimReview({
          deliveryId: 'cancelled-before-callback',
          job: {
            repositoryId: 11,
            pullRequestNumber: 42,
            installationId: 7,
            baseSha: eligibleEvent.baseSha,
            headSha: eligibleEvent.headSha,
            trigger: 'automatic',
          },
          occurredAt: '2026-09-01T00:00:00.000Z',
        });
        if (queued.kind !== 'claimed') throw new Error('expected scheduled run');
        const { runId } = queued;
        const jobId = 'runner-job-1';
        await state.claimNextJob({ jobId, attempt: 1, occurredAt: '2026-09-01T00:01:00.000Z' });
        await state.cancelRun({ runId, requestedByUid: 1, occurredAt: '2026-09-01T00:02:00.000Z' });
        const env = {
          ...coreEnv(database),
          ...postHogTestDefaults.environment,
          EVIDENCE_BUCKET: { put: async () => undefined },
        };
        const createReview = vi.fn();
        const createIssueComment = vi.fn();
        const worker = createCoreWorker(env, {
          stateStore: state,
          github: { createReview, createIssueComment },
        });
        const reply = await worker.fetch(
          new Request('https://core.internal/runner-results', {
            method: 'POST',
            headers: { 'x-compte-rendu-runner-callback': 'verified' },
            body: await makeCallback(runId, jobId, 1),
          }),
          env,
          { waitUntil: (task) => waitUntilTasks.push(task) },
        );
        expect(reply.status).toBe(202);
        expect(await state.getRunOutcome(runId)).toMatchObject({
          status: 'cancelled',
          runnerJobId: jobId,
          runnerAttempt: 1,
          evidence: { key: 'reviews/' + runId },
        });
        await Promise.all(waitUntilTasks);
        expect(await postHogEvents(requests)).not.toContainEqual(
          expect.objectContaining({
            event: 'review finished',
            properties: expect.objectContaining({ outcome: 'failed' }),
          }),
        );
        expect(createReview).not.toHaveBeenCalled();
        expect(createIssueComment).not.toHaveBeenCalled();
      } finally {
        fetcher.mockRestore();
        database.close();
      }
    },
  );

  it.each([
    ['cancellation wins at the failure-notification claim', 'cancel', 'cancelled', false, false],
    ['the post-write read fails after owning publication', 'owned', 'failed', true, true],
    ['the post-write read fails without publication ownership', 'unowned', 'failed', false, false],
  ] as const)(
    'handles invalid evidence when %s',
    async (_name, kind, expectedStatus, expectReaction, expectLifecycle) => {
      const database = new SqliteD1Database();
      const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
      const state = createD1ReviewStateStore(database);
      const claimed = await state.claimReview({
        deliveryId: `late-invalid-evidence-${kind}`,
        job: {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'manual',
          commentId: 987654,
        },
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (claimed.kind !== 'claimed') throw new Error('manual run was not claimed');
      const { runId } = claimed;
      await state.claimNextJob({
        jobId: 'runner-job-1',
        attempt: 1,
        occurredAt: '2026-09-01T00:01:00.000Z',
      });
      const reactions: unknown[] = [];
      const env = {
        ...coreEnv(database),
        ...postHogTestDefaults.environment,
        EVIDENCE_BUCKET: { put: async () => undefined },
      };
      const stateStore =
        kind === 'cancel'
          ? {
              ...state,
              claimRunPublication: async (
                input: Parameters<NonNullable<typeof state.claimRunPublication>>[0],
              ) => {
                await state.cancelRun({
                  runId,
                  requestedByUid: 1,
                  occurredAt: new Date().toISOString(),
                });
                return state.claimRunPublication(input);
              },
            }
          : failReadAfterSchedulingWrite(state, kind);
      const worker = createCoreWorker(env, {
        stateStore,
        github: { addReaction: async (input) => void reactions.push(input) },
      });
      try {
        const callback = JSON.parse(await successfulCallback(runId)) as {
          evidence: { manifest: { sha256: string } };
        };
        callback.evidence.manifest.sha256 = '0'.repeat(64);
        const response = await worker.fetch(
          new Request('https://core.internal/runner-results', {
            method: 'POST',
            headers: {
              'x-compte-rendu-runner-callback': 'verified',
              'content-type': 'application/json',
            },
            body: JSON.stringify(callback),
          }),
          env,
          { waitUntil: (task) => waitUntilTasks.push(task) },
        );
        expect(response.status).toBe(202);
        expect(await state.getRunOutcome(runId)).toMatchObject({ status: expectedStatus });
        await Promise.all(waitUntilTasks);
        expect(reactions).toEqual(
          expectReaction
            ? [{ repositoryId: 11, installationId: 7, commentId: 987654, content: '-1' }]
            : [],
        );
        const failedLifecycle = (await postHogEvents(requests)).some(
          (event) =>
            (event as { event?: string }).event === 'review finished' &&
            (event as { properties?: { outcome?: string } }).properties?.outcome === 'failed',
        );
        expect(failedLifecycle).toBe(expectLifecycle);
      } finally {
        fetcher.mockRestore();
        database.close();
      }
    },
  );

  it.each([
    ['cancellation wins at the failure claim', 'cancel', 202, 'cancelled', false],
    ['the post-write read fails after owning publication', 'owned', 503, 'failed', true],
  ] as const)(
    'handles completion failure when %s',
    async (_name, kind, expectedStatus, settledStatus, expectFeedback) => {
      const database = new SqliteD1Database();
      const state = createD1ReviewStateStore(database);
      const claimed = await state.claimReview({
        deliveryId: `late-target-lookup-${kind}`,
        job: {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'manual',
          commentId: 987654,
        },
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (claimed.kind !== 'claimed') throw new Error('manual run was not claimed');
      const { runId } = claimed;
      await state.claimNextJob({
        jobId: 'runner-job-1',
        attempt: 1,
        occurredAt: '2026-09-01T00:01:00.000Z',
      });
      const reactions: unknown[] = [];
      const logs: OperationalLogEvent[] = [];
      const createReview = vi.fn();
      const env = {
        ...coreEnv(database),
        EVIDENCE_BUCKET: { put: async () => undefined },
      };
      const stateStore =
        kind === 'cancel'
          ? {
              ...state,
              claimRunPublication: async (
                input: Parameters<NonNullable<typeof state.claimRunPublication>>[0],
              ) => {
                await state.cancelRun({
                  runId,
                  requestedByUid: 1,
                  occurredAt: new Date().toISOString(),
                });
                return state.claimRunPublication(input);
              },
            }
          : failReadAfterSchedulingWrite(state, kind);
      const worker = createCoreWorker(env, {
        stateStore,
        log: { record: (event) => void logs.push(event) },
        github: {
          addReaction: async (input) => void reactions.push(input),
          loadReviewTarget: async () => undefined,
          createReview,
        },
      });
      try {
        const response = await worker.fetch(
          new Request('https://core.internal/runner-results', {
            method: 'POST',
            headers: {
              'x-compte-rendu-runner-callback': 'verified',
              'content-type': 'application/json',
            },
            body: await successfulCallback(runId),
          }),
          env,
        );
        expect(response.status).toBe(expectedStatus);
        expect(await state.getRunOutcome(runId)).toMatchObject({ status: settledStatus });
        expect(createReview).not.toHaveBeenCalled();
        expect(reactions).toEqual(
          expectFeedback
            ? [{ repositoryId: 11, installationId: 7, commentId: 987654, content: '-1' }]
            : [],
        );
        expect(
          logs.filter((event) => event.phase === 'publication' && event.outcome === 'failed'),
        ).toHaveLength(expectFeedback ? 1 : 0);
      } finally {
        database.close();
      }
    },
  );

  it('captures a superseded lifecycle event for a late successful callback', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-finished-superseded-lifecycle',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('superseded lifecycle run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    await stateStore.markRunSuperseded({
      runId: claimed.runId,
      occurredAt: '2026-09-01T00:00:01.000Z',
    });
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const env = {
      REVIEW_DB: database,
      EVIDENCE_BUCKET: { put: async () => undefined },
      GITHUB_APP_ID: '1234567',
      GITHUB_APP_PRIVATE_KEY: 'test-private-key',
      ...postHogTestDefaults.environment,
    };
    const worker = createCoreWorker(env, {
      ...postHogTestDefaults.dependencies,
      stateStore,
      github: {},
    });

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: await successfulCallback(claimed.runId),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );

      expect(response.status).toBe(202);
      await Promise.all(waitUntilTasks);
      const events = await postHogEvents(requests);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'review finished',
        properties: {
          outcome: 'superseded',
          published: false,
        },
      });
    } finally {
      fetcher.mockRestore();
      database.close();
    }
  });

  it('captures a failed lifecycle event after durable claim preparation failure', async () => {
    const database = new SqliteD1Database();
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const env = {
      ...coreEnv(database),
      ...postHogTestDefaults.environment,
    };
    const worker = createCoreWorker(env, {
      ...postHogTestDefaults.dependencies,
      github: {
        getRepositoryUrl: async () => {
          throw new Error('repository lookup failed');
        },
        loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
      },
    });

    try {
      const scheduled = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            deliveryId: 'delivery-claim-preparation-failure',
          }),
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );
      expect(scheduled.status).toBe(202);
      await Promise.all(waitUntilTasks.splice(0));

      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
        env,
        { waitUntil: (task) => waitUntilTasks.push(task) },
      );
      expect(claim.status).toBe(503);
      await Promise.all(waitUntilTasks);
      const events = await postHogEvents(requests);
      expect(events).toHaveLength(3);
      const lifecycle = events as Array<{
        readonly event: string;
        readonly distinct_id: string;
        readonly properties: { readonly run_id: string };
      }>;
      const runId = lifecycle[0]?.distinct_id;
      expect(runId).toEqual(expect.any(String));
      expect(lifecycle.map((entry) => [entry.distinct_id, entry.properties.run_id])).toEqual([
        [runId, runId],
        [runId, runId],
        [runId, runId],
      ]);
      // PostHog transport delivery order is not guaranteed, so compare the
      // exact set of captured lifecycle events rather than their positions.
      expect(lifecycle.map((entry) => entry.event).sort()).toEqual([
        'review claimed',
        'review finished',
        'review scheduled',
      ]);
      const finished = lifecycle.find((entry) => entry.event === 'review finished');
      expect(finished).toMatchObject({
        event: 'review finished',
        properties: {
          outcome: 'failed',
          published: false,
          failure_phase: 'unknown',
          failure_reason: 'unknown',
        },
      });
    } finally {
      fetcher.mockRestore();
      database.close();
    }
  });
});

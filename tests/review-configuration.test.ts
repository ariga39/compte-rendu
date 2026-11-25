import { expect, it } from 'vitest';
import { createCoreWorker } from './support/core-worker-runtime';
import { SqliteD1Database } from './support/d1-database';
import { createApplication } from '../apps/dashboard/src/lib/server/application';
import { createD1ReviewStateStore } from '../apps/core/src/index';

const selection = {
  reviewers: ['deepseek-review', 'step-review'],
  synthesis: 'deepseek-review',
};
const environment = (database: SqliteD1Database) => ({
  REVIEW_DB: database,
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  REVIEW_CONFIGURATION_TOKEN: 'operator-token',
  INFERENCE_RELAY: {
    catalog: async () => ({
      routes: [
        ...selection.reviewers,
        'another-review',
        'review-provider/deepseek-v4.1-flash',
        'review-provider/mimo-v2.6-flash',
      ],
      efforts: {},
      lastAttemptAt: null,
      lastSuccessAt: null,
      rejected: 0,
      lastRefreshError: null,
    }),
    refreshCatalog: async () => {},
    issueV2: async () => ({ kind: 'invalid' as const }),
    revoke: async () => ({ kind: 'revoked' as const }),
    usage: async () => null,
    effortStates: async () => ({ routes: [] }),
    effortDetails: async () => null,
  },
});

it('freezes model selection at admission even when a queued job is claimed after an update', async () => {
  const database = new SqliteD1Database();
  try {
    const dependencies = {
      github: {
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
        loadReviewTarget: async () => ({ headSha: '2'.repeat(40) }),
      },
      getReadInstallationToken: async () => ({
        token: 'read-token',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    };
    const core = createCoreWorker(environment(database), dependencies);
    const store = createD1ReviewStateStore(database);
    const admit = (number: number) =>
      store.claimReview({
        deliveryId: `delivery-${number}`,
        occurredAt: '2026-10-19T00:00:00Z',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: number,
          baseSha: '1'.repeat(40),
          headSha: '2'.repeat(40),
          trigger: 'automatic',
        },
      });
    const claim = async () => {
      const worker = createCoreWorker(environment(database), dependencies);
      const response = await worker.claimRunnerJob(
        new Request('https://reviews.test/runner-claim', {
          method: 'POST',
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    await core.handleReviewConfiguration(settingsRequest('PUT', { revision: 0, selection }));
    await admit(42);
    const running = await claim();
    expect(running.reviewConfiguration).toEqual({ revision: 1, selection });
    await admit(43);
    const replacement = { reviewers: ['step-review', 'another-review'], synthesis: 'step-review' };
    expect(
      (
        await core.handleReviewConfiguration(
          settingsRequest('PUT', { revision: 1, selection: replacement }),
        )
      ).status,
    ).toBe(200);
    await admit(44);
    const queued = await claim();
    expect(queued.pullRequestNumber).toBe(43);
    expect(queued.reviewConfiguration).toEqual({ revision: 1, selection });
    const next = await claim();
    expect(next.pullRequestNumber).toBe(44);
    expect(next.reviewConfiguration).toEqual({ revision: 2, selection: replacement });
    expect(running.reviewConfiguration).toEqual({ revision: 1, selection });
  } finally {
    database.close();
  }
});
const settingsRequest = (method: string, body?: unknown, token = 'operator-token') =>
  new Request('https://reviews.test/api/review-configuration', {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

it('persists operator-selected review models across fresh Core workers', async () => {
  const database = new SqliteD1Database();
  try {
    const worker = createCoreWorker(environment(database));
    const initial = await worker.handleReviewConfiguration(settingsRequest('GET'));
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ revision: 0, selection: null, concurrency: null });
    const saved = await worker.handleReviewConfiguration(
      settingsRequest('PUT', { revision: 0, selection }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ revision: 1, selection, concurrency: null });
    const restored = await createCoreWorker(environment(database)).handleReviewConfiguration(
      settingsRequest('GET'),
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ revision: 1, selection, concurrency: null });
  } finally {
    database.close();
  }
});

it('protects settings through ingress and preserves valid settings on invalid or stale updates', async () => {
  const database = new SqliteD1Database();
  try {
    const app = createApplication({
      ...environment(database),
      WEBHOOK_SECRET: 'webhook-secret',
      ALLOWED_INSTALLATION_IDS: '[7]',
    });
    const request = (method: string, body?: unknown, token?: string) => {
      const input = settingsRequest(method, body, token);
      return app.fetch(new Request('https://reviews.example/api/review-configuration', input));
    };
    expect((await request('PUT', { revision: 0, selection }, '')).status).toBe(401);
    expect((await request('GET', undefined, 'runner-token')).status).toBe(401);
    expect((await request('PUT', { revision: 0, selection })).status).toBe(200);
    for (const invalid of [
      { ...selection, synthesis: 'removed-model' },
      { reviewers: [], synthesis: 'deepseek-review' },
      { reviewers: ['deepseek-review', 'deepseek-review'], synthesis: 'deepseek-review' },
      { reviewers: ['deepseek-review', 'step-review'] },
      { ...selection, baseUrl: 'https://arbitrary.example' },
    ]) {
      expect((await request('PUT', { revision: 1, selection: invalid })).status).toBe(400);
    }
    expect((await request('PUT', { revision: 0, selection: null })).status).toBe(409);
    const current = await request('GET');
    expect(current.headers.get('cache-control')).toBe('no-store');
    expect(await current.json()).toEqual({ revision: 1, selection, concurrency: null });
  } finally {
    database.close();
  }
});

it('accepts one reviewer as a persisted review configuration', async () => {
  const database = new SqliteD1Database();
  try {
    const chosen = { reviewers: ['deepseek-review'], synthesis: 'deepseek-review' };
    const core = createCoreWorker(environment(database));
    const response = await core.handleReviewConfiguration(
      settingsRequest('PUT', { revision: 0, selection: chosen }),
    );
    expect(response.status).toBe(200);
    const restored = await createCoreWorker(environment(database)).handleReviewConfiguration(
      settingsRequest('GET'),
    );
    expect(await restored.json()).toEqual({ revision: 1, selection: chosen, concurrency: null });
  } finally {
    database.close();
  }
});

it('persists native provider/model catalog IDs without renaming the selected models', async () => {
  const database = new SqliteD1Database();
  try {
    const chosen = {
      reviewers: ['review-provider/deepseek-v4.1-flash', 'review-provider/mimo-v2.6-flash'],
      synthesis: 'review-provider/deepseek-v4.1-flash',
    };
    const core = createCoreWorker(environment(database));
    const response = await core.handleReviewConfiguration(
      settingsRequest('PUT', { revision: 0, selection: chosen }),
    );
    expect(response.status).toBe(200);
    const restored = await createCoreWorker(environment(database)).handleReviewConfiguration(
      settingsRequest('GET'),
    );
    expect(await restored.json()).toEqual({ revision: 1, selection: chosen, concurrency: null });
  } finally {
    database.close();
  }
});

it('claims the relay default frozen at admission after the configured default changes', async () => {
  const database = new SqliteD1Database();
  try {
    const store = createD1ReviewStateStore(database, 'provider/original');
    await store.claimReview({
      deliveryId: 'default-at-admission',
      occurredAt: '2026-11-18T00:00:00Z',
      job: {
        repositoryId: 11,
        installationId: 7,
        pullRequestNumber: 42,
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        trigger: 'automatic',
      },
    });
    const restarted = createD1ReviewStateStore(database, 'provider/replacement');
    const claimed = await restarted.claimNextJob({
      jobId: 'relay-job',
      attempt: 1,
      occurredAt: '2026-11-18T00:01:00Z',
    });
    expect(claimed).toMatchObject({
      kind: 'claimed',
      job: {
        reviewConfiguration: {
          revision: 0,
          selection: { reviewers: ['provider/original'], synthesis: 'provider/original' },
        },
      },
    });
  } finally {
    database.close();
  }
});

it('persists desired runner concurrency independently of selection and preserves it when omitted', async () => {
  const database = new SqliteD1Database();
  try {
    const worker = createCoreWorker(environment(database));
    const initial = await worker.handleReviewConfiguration(settingsRequest('GET'));
    expect(await initial.json()).toEqual({ revision: 0, selection: null, concurrency: null });

    const targeted = await worker.handleReviewConfiguration(
      settingsRequest('PUT', { revision: 0, selection: null, concurrency: 3 }),
    );
    expect(targeted.status).toBe(200);
    expect(await targeted.json()).toEqual({ revision: 1, selection: null, concurrency: 3 });

    const selectionUpdate = await worker.handleReviewConfiguration(
      settingsRequest('PUT', { revision: 1, selection }),
    );
    expect(selectionUpdate.status).toBe(200);
    expect(await selectionUpdate.json()).toEqual({
      revision: 2,
      selection,
      concurrency: 3,
    });

    const restored = await createCoreWorker(environment(database)).handleReviewConfiguration(
      settingsRequest('GET'),
    );
    expect(await restored.json()).toEqual({ revision: 2, selection, concurrency: 3 });

    const reset = await worker.handleReviewConfiguration(
      settingsRequest('PUT', { revision: 2, selection, concurrency: null }),
    );
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ revision: 3, selection, concurrency: null });
    const after = await worker.handleReviewConfiguration(settingsRequest('GET'));
    expect(await after.json()).toEqual({ revision: 3, selection, concurrency: null });
  } finally {
    database.close();
  }
});

it('rejects invalid desired runner concurrency without advancing the revision', async () => {
  const database = new SqliteD1Database();
  try {
    const worker = createCoreWorker(environment(database));
    for (const concurrency of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', true]) {
      const response = await worker.handleReviewConfiguration(
        settingsRequest('PUT', { revision: 0, selection: null, concurrency }),
      );
      expect(response.status).toBe(400);
    }
    const current = await worker.handleReviewConfiguration(settingsRequest('GET'));
    expect(await current.json()).toEqual({ revision: 0, selection: null, concurrency: null });
  } finally {
    database.close();
  }
});

it('accepts a concurrency-only update while the selection stays on the instance default', async () => {
  const database = new SqliteD1Database();
  try {
    const worker = createCoreWorker(environment(database));
    const saved = await worker.handleReviewConfiguration(
      settingsRequest('PUT', { revision: 0, selection: null, concurrency: 2 }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ revision: 1, selection: null, concurrency: 2 });
  } finally {
    database.close();
  }
});

it('seeds runner concurrency without rewriting the installed roster or effort snapshot', async () => {
  const database = new SqliteD1Database();
  try {
    const worker = createCoreWorker(environment(database));
    expect(
      (await worker.handleReviewConfiguration(settingsRequest('PUT', { revision: 0, selection })))
        .status,
    ).toBe(200);
    const before = database.database
      .prepare('SELECT selection, effort_snapshot FROM review_configuration WHERE id = 1')
      .get() as { selection: string; effort_snapshot: string };
    database.database
      .prepare('UPDATE review_configuration SET runner_concurrency = 6 WHERE id = 1')
      .run();
    const after = database.database
      .prepare(
        'SELECT selection, effort_snapshot, runner_concurrency FROM review_configuration WHERE id = 1',
      )
      .get() as { selection: string; effort_snapshot: string; runner_concurrency: number };
    expect(after.runner_concurrency).toBe(6);
    expect(after.selection).toBe(before.selection);
    expect(after.effort_snapshot).toBe(before.effort_snapshot);
    const restored = await worker.handleReviewConfiguration(settingsRequest('GET'));
    expect(await restored.json()).toEqual({ revision: 1, selection, concurrency: 6 });
  } finally {
    database.close();
  }
});

it('changes only concurrency without relay access or rewriting the frozen effort snapshot', async () => {
  const database = new SqliteD1Database();
  try {
    let relayAvailable = true;
    const baseEnvironment = environment(database);
    const listener = createCoreWorker({
      ...baseEnvironment,
      INFERENCE_RELAY: {
        ...baseEnvironment.INFERENCE_RELAY,
        catalog: async () => {
          if (!relayAvailable) throw new Error('relay unavailable');
          return baseEnvironment.INFERENCE_RELAY.catalog();
        },
      },
    });
    expect(
      (await listener.handleReviewConfiguration(settingsRequest('PUT', { revision: 0, selection })))
        .status,
    ).toBe(200);
    const before = database.database
      .prepare('SELECT selection, effort_snapshot FROM review_configuration WHERE id = 1')
      .get() as { selection: string; effort_snapshot: string };

    relayAvailable = false;
    const updated = await listener.handleReviewConfiguration(
      settingsRequest('PUT', { revision: 1, concurrency: 5 }),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ revision: 2, selection, concurrency: 5 });
    const afterSet = database.database
      .prepare(
        'SELECT selection, effort_snapshot, runner_concurrency FROM review_configuration WHERE id = 1',
      )
      .get() as {
      selection: string;
      effort_snapshot: string;
      runner_concurrency: number;
    };
    expect(afterSet.runner_concurrency).toBe(5);
    expect(afterSet.selection).toBe(before.selection);
    expect(afterSet.effort_snapshot).toBe(before.effort_snapshot);

    const cleared = await listener.handleReviewConfiguration(
      settingsRequest('PUT', { revision: 2, concurrency: null }),
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ revision: 3, selection, concurrency: null });
    const afterClear = database.database
      .prepare(
        'SELECT selection, effort_snapshot, runner_concurrency FROM review_configuration WHERE id = 1',
      )
      .get() as {
      selection: string;
      effort_snapshot: string;
      runner_concurrency: number | null;
    };
    expect(afterClear.runner_concurrency).toBeNull();
    expect(afterClear.selection).toBe(before.selection);
    expect(afterClear.effort_snapshot).toBe(before.effort_snapshot);
  } finally {
    database.close();
  }
});

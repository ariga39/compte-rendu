import { describe, expect, it } from 'vitest';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { createInMemoryReviewStateStore } from '../apps/core/src/index';
import { createGitHubPublicationAdapter } from '../apps/core/src/github-review-adapter';
import type { ReviewEvent } from '../packages/contracts/src';
import type { OperationalLogEvent } from '../packages/contracts/src';
import { SqliteD1Database } from './support/d1-database';

const eligibleEvent: ReviewEvent = {
  deliveryId: 'delivery-core-worker-1',
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
};

describe('Core Worker', () => {
  it('accepts an eligible event and schedules only immutable workflow identity', async () => {
    const database = new SqliteD1Database();
    const workflowInputs: unknown[] = [];
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        REVIEW_WORKFLOW: {
          create: async (input: unknown) => {
            workflowInputs.push(input);
            return undefined;
          },
        },
        REVIEW_LEASE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
        },
        Sandbox: {},
        GITHUB_APP_ID: '4528386',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        MODEL_API_KEY: 'test-model-key',
      },
      {
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(eligibleEvent),
        }),
      );

      expect(response.status).toBe(202);
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'scheduled',
          deliveryId: eligibleEvent.deliveryId,
          runId: expect.any(String),
        },
      ]);
      expect(workflowInputs).toHaveLength(1);
      expect(workflowInputs[0]).toEqual({
        id: expect.any(String),
        params: {
          runId: expect.any(String),
          job: {
            repositoryId: eligibleEvent.repositoryId,
            pullRequestNumber: eligibleEvent.pullRequestNumber,
            installationId: eligibleEvent.installationId,
            baseSha: eligibleEvent.baseSha,
            headSha: eligibleEvent.headSha,
            trigger: 'automatic',
          },
        },
      });
    } finally {
      database.close();
    }
  });

  it('keeps an eligible schedule when core operational logging fails', async () => {
    const database = new SqliteD1Database();
    const workflowInputs: unknown[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        REVIEW_WORKFLOW: {
          create: async (input: unknown) => {
            workflowInputs.push(input);
          },
        },
        REVIEW_LEASE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
        },
        Sandbox: {},
        GITHUB_APP_ID: '4528386',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        MODEL_API_KEY: 'test-model-key',
      },
      {
        log: {
          record: () => {
            throw new Error('log sink unavailable');
          },
        },
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify(eligibleEvent),
        }),
      );

      expect(response.status).toBe(202);
      expect(workflowInputs).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('redacts unsafe delivery identifiers in core operational logs', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        REVIEW_WORKFLOW: {
          create: async () => undefined,
        },
        REVIEW_LEASE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
        },
        Sandbox: {},
        GITHUB_APP_ID: '4528386',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        MODEL_API_KEY: 'test-model-key',
      },
      {
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery\nunsafe' }),
        }),
      );

      expect(response.status).toBe(202);
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'scheduled',
          deliveryId: 'redacted',
          runId: expect.any(String),
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('accepts a manual review after production GitHub policy reads', async () => {
    const database = new SqliteD1Database();
    const workflowInputs: unknown[] = [];
    const reactionBodies: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      if (url.pathname === '/repositories/11') {
        return new Response(
          JSON.stringify({
            full_name: 'acme/reviewed',
            clone_url: 'https://github.com/acme/reviewed.git',
          }),
        );
      }
      if (url.pathname === '/repos/acme/reviewed/pulls/42') {
        return new Response(
          JSON.stringify({
            draft: false,
            base: { sha: eligibleEvent.baseSha, repo: { id: 11, visibility: 'public' } },
            head: { sha: eligibleEvent.headSha, repo: { id: 99 } },
          }),
        );
      }
      if (url.pathname === '/repos/acme/reviewed/collaborators/alice/permission') {
        return new Response(JSON.stringify({ permission: 'write' }));
      }
      if (url.pathname === '/repos/acme/reviewed/issues/comments/987654/reactions') {
        reactionBodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    };
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        REVIEW_WORKFLOW: {
          create: async (input: unknown) => {
            workflowInputs.push(input);
            return undefined;
          },
        },
        REVIEW_LEASE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
        },
        Sandbox: {},
        GITHUB_APP_ID: '4528386',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        MODEL_API_KEY: 'test-model-key',
      },
      {
        github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }),
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            deliveryId: 'delivery-core-worker-manual',
            event: 'issue_comment',
            action: 'created',
            repositoryId: 11,
            pullRequestNumber: 42,
            installationId: 7,
            commentId: 987654,
            commenterLogin: 'alice',
            command: '/ai-review',
          }),
        }),
      );

      expect(response.status).toBe(202);
      expect(workflowInputs[0]).toMatchObject({
        params: { job: { trigger: 'manual', headSha: eligibleEvent.headSha } },
      });
      expect(reactionBodies).toEqual([{ content: 'eyes' }]);
    } finally {
      database.close();
    }
  });

  it('treats a production GitHub 404 for the manual PR as confirmed missing', async () => {
    const database = new SqliteD1Database();
    let workflowCreated = false;
    const fetcher: typeof fetch = async (input) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      if (url.pathname === '/repositories/11') {
        return new Response(JSON.stringify({ full_name: 'acme/reviewed' }));
      }
      if (url.pathname === '/repos/acme/reviewed/pulls/42') {
        return new Response('{}', { status: 404 });
      }
      if (url.pathname === '/repos/acme/reviewed/issues/comments/987655/reactions') {
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    };
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        REVIEW_WORKFLOW: {
          create: async () => {
            workflowCreated = true;
          },
        },
        REVIEW_LEASE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
        },
        Sandbox: {},
        GITHUB_APP_ID: '4528386',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        MODEL_API_KEY: 'test-model-key',
      },
      {
        github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }),
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            deliveryId: 'delivery-core-worker-manual-missing',
            event: 'issue_comment',
            action: 'created',
            repositoryId: 11,
            pullRequestNumber: 42,
            installationId: 7,
            commentId: 987655,
            commenterLogin: 'alice',
            command: '/ai-review',
          }),
        }),
      );

      expect(response.status).toBe(202);
      expect(workflowCreated).toBe(false);
    } finally {
      database.close();
    }
  });

  it('treats production collaborator permission none as confirmed denial', async () => {
    const database = new SqliteD1Database();
    let workflowCreated = false;
    const fetcher: typeof fetch = async (input) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      if (url.pathname === '/repositories/11') {
        return new Response(JSON.stringify({ full_name: 'acme/reviewed' }));
      }
      if (url.pathname === '/repos/acme/reviewed/pulls/42') {
        return new Response(
          JSON.stringify({
            draft: false,
            base: { sha: eligibleEvent.baseSha, repo: { id: 11, visibility: 'public' } },
            head: { sha: eligibleEvent.headSha, repo: { id: 99 } },
          }),
        );
      }
      if (url.pathname === '/repos/acme/reviewed/collaborators/alice/permission') {
        return new Response(JSON.stringify({ permission: 'none' }));
      }
      if (url.pathname === '/repos/acme/reviewed/issues/comments/987656/reactions') {
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    };
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        REVIEW_WORKFLOW: {
          create: async () => {
            workflowCreated = true;
          },
        },
        REVIEW_LEASE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
        },
        Sandbox: {},
        GITHUB_APP_ID: '4528386',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        MODEL_API_KEY: 'test-model-key',
      },
      {
        github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }),
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            deliveryId: 'delivery-core-worker-permission-none',
            event: 'issue_comment',
            action: 'created',
            repositoryId: 11,
            pullRequestNumber: 42,
            installationId: 7,
            commentId: 987656,
            commenterLogin: 'alice',
            command: '/ai-review',
          }),
        }),
      );

      expect(response.status).toBe(202);
      expect(workflowCreated).toBe(false);
    } finally {
      database.close();
    }
  });

  it('returns 503 when manual GitHub facts remain uncertain', async () => {
    const database = new SqliteD1Database();
    let workflowCreated = false;
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        REVIEW_WORKFLOW: {
          create: async () => {
            workflowCreated = true;
          },
        },
        REVIEW_LEASE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
        },
        Sandbox: {},
        GITHUB_APP_ID: '4528386',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        MODEL_API_KEY: 'test-model-key',
      },
      {
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
        github: {
          getPullRequest: async () => {
            throw new Error('GitHub facts unavailable');
          },
        },
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            deliveryId: 'delivery-core-worker-manual-uncertain',
            event: 'issue_comment',
            action: 'created',
            repositoryId: 11,
            pullRequestNumber: 42,
            installationId: 7,
            commentId: 987657,
            commenterLogin: 'alice',
            command: '/ai-review',
          }),
        }),
      );

      expect(response.status).toBe(503);
      expect(workflowCreated).toBe(false);
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: 'delivery-core-worker-manual-uncertain',
          reason: 'pull_request_facts_uncertain',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('returns 503 when manual commenter permission remains uncertain', async () => {
    const database = new SqliteD1Database();
    let workflowCreated = false;
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        REVIEW_WORKFLOW: {
          create: async () => {
            workflowCreated = true;
          },
        },
        REVIEW_LEASE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
        },
        Sandbox: {},
        GITHUB_APP_ID: '4528386',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        MODEL_API_KEY: 'test-model-key',
      },
      {
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
        github: {
          getPullRequest: async () => ({
            repositoryVisibility: 'public',
            baseRepositoryId: 11,
            headRepositoryId: 99,
            draft: false,
            baseSha: eligibleEvent.baseSha,
            headSha: eligibleEvent.headSha,
          }),
          getCommenterPermission: async () => {
            throw new Error('GitHub permission unavailable');
          },
        },
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            deliveryId: 'delivery-core-worker-permission-uncertain',
            event: 'issue_comment',
            action: 'created',
            repositoryId: 11,
            pullRequestNumber: 42,
            installationId: 7,
            commentId: 987658,
            commenterLogin: 'alice',
            command: '/ai-review',
          }),
        }),
      );

      expect(response.status).toBe(503);
      expect(workflowCreated).toBe(false);
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: 'delivery-core-worker-permission-uncertain',
          reason: 'commenter_permission_uncertain',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('keeps Workflow creation failure fail-closed', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        REVIEW_WORKFLOW: {
          create: async () => {
            throw new Error('workflow creation failed');
          },
        },
        REVIEW_LEASE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
        },
        Sandbox: {},
        GITHUB_APP_ID: '4528386',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        MODEL_API_KEY: 'test-model-key',
      },
      {
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            deliveryId: 'delivery-core-worker-schedule-failed',
          }),
        }),
      );

      expect(response.status).toBe(503);
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: 'delivery-core-worker-schedule-failed',
          reason: 'scheduling_failure',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('returns 503 and records a retryable state failure when claiming fails', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const baseStateStore = createInMemoryReviewStateStore();
    const stateStore = {
      ...baseStateStore,
      claimReview: async () => {
        throw new Error('state unavailable');
      },
    };
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        REVIEW_WORKFLOW: {
          create: async () => undefined,
        },
        REVIEW_LEASE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
        },
        Sandbox: {},
        GITHUB_APP_ID: '4528386',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        MODEL_API_KEY: 'test-model-key',
      },
      {
        stateStore,
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify(eligibleEvent),
        }),
      );

      expect(response.status).toBe(503);
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: eligibleEvent.deliveryId,
          reason: 'state_failure',
        },
      ]);
    } finally {
      database.close();
    }
  });
});

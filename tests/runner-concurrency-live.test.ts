import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { createApplication } from '../apps/dashboard/src/lib/server/application';
import { SqliteD1Database } from './support/d1-database';
import {
  createRunner,
  finalMarkdownJsonl,
  standardModelConfig,
  writeEvidenceFixture,
  type RunnerProcessResult,
} from './support/runner-harness';

const environment = (database: SqliteD1Database) => ({
  REVIEW_DB: database,
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  REVIEW_CONFIGURATION_TOKEN: 'operator-token',
});
const settingsRequest = (method: string, body?: unknown) =>
  new Request('https://reviews.test/api/review-configuration', {
    method,
    headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('Runner live desired concurrency', () => {
  it('discovers a D1 increase through the real claim endpoint while a long review is active', async () => {
    const database = new SqliteD1Database();
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-live-concurrency-'));
    const gates: Array<() => void> = [];
    const claimed: string[] = [];
    const probeMethods: string[] = [];
    try {
      const app = createApplication(
        {
          ...environment(database),
          WEBHOOK_SECRET: 'test',
          ALLOWED_INSTALLATION_IDS: '[7]',
          RUNNER_CALLBACK_TOKEN: 'callback-token',
        },
        {
          github: {
            getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
            loadReviewTarget: async () => ({ headSha: '2'.repeat(40) }),
          },
          getReadInstallationToken: async () => ({
            token: 'read-token',
            expiresAt: '2099-01-01T00:00:00Z',
          }),
        },
      );
      expect(
        (await app.fetch(settingsRequest('PUT', { revision: 0, selection: null, concurrency: 1 })))
          .status,
      ).toBe(200);
      const store = createD1ReviewStateStore(database);
      for (const pullRequestNumber of [42, 43]) {
        await store.claimReview({
          deliveryId: `live-${pullRequestNumber}`,
          occurredAt: '2026-10-19T00:00:00Z',
          job: {
            repositoryId: 11,
            installationId: 7,
            pullRequestNumber,
            baseSha: '1'.repeat(40),
            headSha: '2'.repeat(40),
            trigger: 'automatic',
          },
        });
      }

      const runner = createRunner({
        concurrency: 1,
        authToken: 'runner-test-token',
        modelConfig: standardModelConfig,
        evidenceRoot,
        claimUrl: 'https://reviews.test/runner-claim',
        claimTimeoutMs: 1_000_000,
        claimIntervalMs: 1_000_000,
        claimProbeIntervalMs: 10,
        callbackUrl: 'https://reviews.test/runner-callback',
        callbackToken: 'callback-token',
        callbackFetch: async () => new Response(null, { status: 202 }),
        claimFetch: async (url, init) => {
          if (init?.method === 'HEAD') probeMethods.push(init.method);
          const response = await app.fetch(new Request(url, init));
          if (response.status === 200) {
            claimed.push(((await response.clone().json()) as { id: string }).id);
          }
          return response;
        },
        process: async (_command, args, processOptions = {}): Promise<RunnerProcessResult> => {
          if (args[0] === 'exec' && args.includes('--agent')) {
            await new Promise<void>((resolve) => gates.push(resolve));
            await writeEvidenceFixture(args, processOptions, finalMarkdownJsonl());
            return {
              exitCode: 0,
              stdout: `${finalMarkdownJsonl()}\n`,
              timedOut: false,
              truncated: false,
            };
          }
          await writeEvidenceFixture(args, processOptions, finalMarkdownJsonl());
          return {
            exitCode: 0,
            stdout: args.includes('rev-parse')
              ? `${'1'.repeat(40)}\n${'2'.repeat(40)}\n`
              : args.includes('session')
                ? '[{"id":"live-concurrency-session"}]\n'
                : '',
            timedOut: false,
            truncated: false,
          };
        },
      });
      const status = async (id: string) =>
        (await runner
          .handle(
            new Request(`http://runner/jobs/${id}`, {
              headers: { authorization: 'Bearer runner-test-token' },
            }),
          )
          .then((reply) => reply.json())) as { status?: string };
      try {
        await vi.waitFor(() => expect(claimed).toHaveLength(1));
        await vi.waitFor(async () => expect((await status(claimed[0]!)).status).toBe('running'));

        // The active review still holds the only slot. A non-claiming probe
        // reads the D1 increase and immediately claims the queued review.
        expect(
          (
            await app.fetch(
              settingsRequest('PUT', { revision: 1, selection: null, concurrency: 2 }),
            )
          ).status,
        ).toBe(200);
        await vi.waitFor(() => expect(claimed).toHaveLength(2), { timeout: 5000 });
        expect(probeMethods).toContain('HEAD');
        await vi.waitFor(async () => {
          expect((await status(claimed[0]!)).status).toBe('running');
          expect((await status(claimed[1]!)).status).toBe('running');
        });
      } finally {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          for (const release of gates.splice(0)) release();
          const reply = await runner.handle(
            new Request('http://runner/maintenance', {
              headers: { authorization: 'Bearer runner-test-token' },
            }),
          );
          if (((await reply.json()) as { activeJobs: number }).activeJobs === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await runner.close();
      }
    } finally {
      database.close();
      await rm(evidenceRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
    }
  });
});

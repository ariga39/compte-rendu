import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreWorker } from './support/core-http-adapter';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { createRunner } from '../apps/runner/src/runner';
import { sandboxResourceName } from '../apps/runner/src/sandbox-resource-name';
import type { RunnerProcessResult } from '../apps/runner/src/sandbox-runtime';
import { SqliteD1Database } from './support/d1-database';
import { claimGithub, coreEnv } from './support/core-worker-harness';
import { claimRunnerJob } from './support/runner-claim';
import { finalMarkdownJsonl, runAgentScenario, runnerJobFields } from './support/runner-harness';

const baseSha = '1'.repeat(40);
const oldHead = '2'.repeat(40);
const newHead = '3'.repeat(40);
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const claimRun = async (
  stateStore: ReturnType<typeof createD1ReviewStateStore>,
  input: {
    readonly deliveryId: string;
    readonly headSha: string;
    readonly occurredAt: string;
  },
) => {
  const run = await stateStore.claimReview({
    deliveryId: input.deliveryId,
    job: {
      repositoryId: 11,
      installationId: 7,
      pullRequestNumber: 77,
      baseSha,
      headSha: input.headSha,
      trigger: 'automatic',
    },
    occurredAt: input.occurredAt,
  });
  if (run.kind !== 'claimed') throw new Error('run was not admitted');
  return run;
};

const callbackRequest = (body: string) =>
  new Request('https://core.internal/runner-results', {
    method: 'POST',
    headers: {
      'x-compte-rendu-runner-callback': 'verified',
      'content-type': 'application/json',
    },
    body,
  });

describe('age cleanup and same-PR blocker release', () => {
  it('does not release a failed-cleanup blocker until the retained absence callback is accepted', async () => {
    const database = new SqliteD1Database();
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'cr-age-blocker-'));
    roots.push(evidenceRoot);
    try {
      const stateStore = createD1ReviewStateStore(database);
      const worker = createCoreWorker(
        {
          ...coreEnv(database),
          EVIDENCE_BUCKET: { put: async () => undefined },
        },
        {
          stateStore,
          github: {
            ...claimGithub(() => oldHead),
            createIssueComment: async () => undefined,
            updateCheckRun: async () => undefined,
          },
        },
      );
      const failedRun = await claimRun(stateStore, {
        deliveryId: 'delivery-age-cleanup-failed',
        headSha: oldHead,
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      await claimRunnerJob(stateStore, {
        runId: failedRun.runId,
        jobId: runnerJobFields.id,
      });

      const failed = await runAgentScenario({
        runId: failedRun.runId,
        output: finalMarkdownJsonl(),
        cleanupFailure: true,
        evidenceRoot,
      });
      expect(failed.terminal).toMatchObject({
        status: 'failed',
        sandbox: { cleanup: 'failed' },
      });
      const evidenceId = failed.terminal.evidenceId as string;
      const callbackBody = await readFile(join(evidenceRoot, evidenceId, 'callback.json'), 'utf8');
      expect((await worker.fetch(callbackRequest(callbackBody))).status).toBe(202);

      const nextRun = await claimRun(stateStore, {
        deliveryId: 'delivery-age-cleanup-next',
        headSha: newHead,
        occurredAt: '2026-09-01T00:00:05.000Z',
      });
      await expect(
        stateStore.claimNextJob({
          jobId: 'age-cleanup-blocked',
          attempt: 1,
          occurredAt: '2026-09-01T00:00:06.000Z',
        }),
      ).resolves.toEqual({ kind: 'empty' });

      const expired = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
      let expiredPresent = true;
      const ok: RunnerProcessResult = {
        exitCode: 0,
        stdout: '',
        timedOut: false,
        truncated: false,
      };
      const process = async (_command: string, args: readonly string[]) => {
        if (args[0] === 'ls' && args[1] === '-q')
          return { ...ok, stdout: expiredPresent ? expired : '' };
        if (args[0] === 'policy' && args[1] === 'ls') return { ...ok, stdout: '{"rules":[]}' };
        if (args[0] === 'secret' && args[1] === 'ls')
          return { ...ok, stdout: '{"secrets":[],"custom_secrets":[]}' };
        if (args[0] === 'inspect') {
          const name = args[1]!;
          if (name === expired && expiredPresent) {
            return { ...ok, stdout: JSON.stringify({ name }) };
          }
          return {
            ...ok,
            exitCode: 1,
            stderr: `error: sandbox '${name}' not found`,
          };
        }
        if (args[0] === 'rm') expiredPresent = false;
        return ok;
      };
      const restarted = createRunner({
        evidenceRoot,
        authToken: 'runner-test-token',
        modelConfig: JSON.stringify({
          id: 'opencode-go/review',
          baseUrl: 'https://llm.internal.example/v1',
          definition: { name: 'Review' },
        }),
        llmRelay: true,
        claimUrl: '',
        callbackUrl: 'https://core.internal/runner-results',
        callbackToken: 'callback-token',
        callbackFetch: async (input, init) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname.startsWith('/runner-llm/'))
            return new Response(null, { status: 204 });
          const headers = new Headers(request.headers);
          headers.set('x-compte-rendu-runner-callback', 'verified');
          const result = await worker.fetch(
            new Request(request.url, {
              method: request.method,
              headers,
              body: await request.text(),
            }),
          );
          return result;
        },
        process,
      });
      try {
        await vi.waitFor(() => expect(expiredPresent).toBe(false), { timeout: 5_000 });
        // The physical sweep removed the old resource but Core still serializes
        // the same PR: backend deletion alone is not a cleanup confirmation.
        await expect(
          stateStore.claimNextJob({
            jobId: 'age-cleanup-still-blocked',
            attempt: 1,
            occurredAt: '2026-09-01T00:00:07.000Z',
          }),
        ).resolves.toEqual({ kind: 'empty' });

        const manifest = JSON.parse(
          await readFile(join(evidenceRoot, evidenceId, 'manifest.json'), 'utf8'),
        ) as {
          jobId: string;
          runId: string;
          attempt: number;
          baseSha: string;
          headSha: string;
        };
        const response = await restarted.handle(
          new Request('http://runner/maintenance/recover-cleanup', {
            method: 'POST',
            headers: {
              authorization: 'Bearer runner-test-token',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              evidenceId,
              jobId: manifest.jobId,
              runId: manifest.runId,
              attempt: manifest.attempt,
              baseSha: manifest.baseSha,
              headSha: manifest.headSha,
            }),
          }),
        );
        expect(response.status).toBe(202);

        await expect(
          stateStore.claimNextJob({
            jobId: 'age-cleanup-released',
            attempt: 1,
            occurredAt: '2026-09-01T00:00:08.000Z',
          }),
        ).resolves.toMatchObject({
          kind: 'claimed',
          runId: nextRun.runId,
          job: { pullRequestNumber: 77, headSha: newHead },
        });
      } finally {
        await restarted.close();
      }
    } finally {
      database.close();
    }
  }, 20_000);
});

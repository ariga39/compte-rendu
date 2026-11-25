import { describe, expect, it, vi } from 'vitest';
import { createCoreWorker } from './support/core-http-adapter';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { createGitHubPublicationAdapter } from '../apps/core/src/github-review-adapter';
import { SqliteD1Database } from './support/d1-database';
import { claimRunnerJob } from './support/runner-claim';
import { eligibleEvent, coreEnv, recordTestEvidence } from './support/core-worker-harness';

describe('Core cancelled Check retry feedback', () => {
  it('schedules a fresh run when a failed Check is rerequested through the Worker', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const failed = await stateStore.claimReview({
      deliveryId: 'delivery-core-worker-failed-check',
      job: {
        repositoryId: 11,
        installationId: 7,
        pullRequestNumber: 43,
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '2222222222222222222222222222222222222222',
        trigger: 'automatic',
      },
      occurredAt: '2026-09-12T00:00:00.000Z',
    });
    if (failed.kind !== 'claimed') throw new Error('failed run was not claimed');
    await stateStore.recordCheckRun({ runId: failed.runId, checkRunId: 321 });
    await stateStore.markSchedulingFailed({
      runId: failed.runId,
      occurredAt: '2026-09-12T00:01:00.000Z',
    });
    const reactions: unknown[] = [];
    const worker = createCoreWorker(coreEnv(database), {
      stateStore,
      github: {
        getPullRequest: async () => ({
          repositoryVisibility: 'public',
          baseRepositoryId: 11,
          headRepositoryId: 99,
          draft: false,
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '3333333333333333333333333333333333333333',
        }),
        getCommenterPermission: async () => 'write',
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
        loadReviewTarget: async () => ({
          headSha: '3333333333333333333333333333333333333333',
        }),
        addReaction: async (input) => {
          reactions.push(input);
        },
      },
      getReadInstallationToken: async () => ({
        token: 'read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      }),
    });

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            deliveryId: 'delivery-core-worker-check-rerequest',
            event: 'check_run',
            action: 'rerequested',
            repositoryId: 11,
            installationId: 7,
            checkRunId: 321,
            externalRunId: failed.runId,
            senderLogin: 'maintainer',
          }),
        }),
      );
      expect(response.status).toBe(202);
      expect(await stateStore.getRunOutcome(failed.runId)).toMatchObject({ status: 'failed' });

      const claimResponse = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(claimResponse.status).toBe(200);
      expect(await claimResponse.json()).toMatchObject({
        pullRequestNumber: 43,
        headSha: '3333333333333333333333333333333333333333',
      });
      expect(reactions).toEqual([]);
    } finally {
      database.close();
    }
  });

  it.each(['pending', 'failed'] as const)(
    'explains a cancelled Check retry while cleanup is %s and retries after confirmation',
    async (initialCleanup) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
      const database = new SqliteD1Database();
      const stateStore = createD1ReviewStateStore(database);
      try {
        const initial = await stateStore.claimReview({
          deliveryId: `delivery-cancel-retry-${initialCleanup}`,
          job: {
            repositoryId: 11,
            installationId: 7,
            pullRequestNumber: 44,
            baseSha: eligibleEvent.baseSha,
            headSha: eligibleEvent.headSha,
            trigger: 'automatic',
          },
          occurredAt: '2026-09-12T00:00:00.000Z',
        });
        if (initial.kind !== 'claimed') throw new Error('cancelled run was not admitted');
        const runId = initial.runId;
        await stateStore.recordCheckRun({ runId, checkRunId: 321 });
        await claimRunnerJob(stateStore, {
          runId,
          jobId: 'runner-job-cancel-retry',
          occurredAt: '2026-09-12T00:00:10.000Z',
        });
        await stateStore.cancelRun({
          runId,
          requestedByUid: 1,
          occurredAt: '2026-09-12T00:00:20.000Z',
        });
        const evidence = {
          key: `reviews/${runId}`,
          status: 'incomplete' as const,
          size: 1,
          sha256: 'a'.repeat(64),
          uploadedAt: '2026-09-12T00:00:30.000Z',
        };
        if (initialCleanup === 'failed')
          await recordTestEvidence(stateStore, { runId, evidence, sandboxCleanup: 'failed' });

        let permission: 'read' | 'write' = 'read';
        const updates: unknown[] = [];
        const worker = createCoreWorker(coreEnv(database), {
          stateStore,
          github: {
            getPullRequest: async () => ({
              repositoryVisibility: 'public',
              baseRepositoryId: 11,
              headRepositoryId: 99,
              draft: false,
              baseSha: eligibleEvent.baseSha,
              headSha: eligibleEvent.headSha,
            }),
            getCommenterPermission: async () => permission,
            updateCheckRun: async (input) => {
              updates.push(input);
            },
            getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
            loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          },
          getReadInstallationToken: async () => ({
            token: 'read-token',
            expiresAt: '2026-09-01T01:00:00.000Z',
          }),
        });
        const retry = (deliveryId: string) =>
          worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({
                deliveryId,
                event: 'check_run',
                action: 'rerequested',
                repositoryId: 11,
                installationId: 7,
                checkRunId: 321,
                externalRunId: runId,
                senderLogin: 'maintainer',
              }),
            }),
          );

        expect((await retry(`retry-${initialCleanup}-unauthorized`)).status).toBe(202);
        expect(updates).toEqual([]);

        permission = 'write';
        expect((await retry(`retry-${initialCleanup}-blocked`)).status).toBe(202);
        expect(updates).toEqual([
          expect.objectContaining({
            checkRunId: 321,
            status: 'cancelled',
            cancellationReason: 'manual',
            retryBlocked: initialCleanup === 'failed' ? 'cleanup-failed' : 'cleanup-pending',
            retryQueued: false,
          }),
        ]);
        await expect(
          stateStore.claimNextJob({
            jobId: 'probe-blocked-retry',
            attempt: 1,
            occurredAt: '2026-09-12T00:01:00.000Z',
          }),
        ).resolves.toEqual({ kind: 'empty' });

        await recordTestEvidence(stateStore, { runId, evidence, sandboxCleanup: 'destroyed' });
        vi.setSystemTime(new Date('2026-09-12T00:01:05Z'));
        expect((await retry(`retry-${initialCleanup}-recovered`)).status).toBe(202);
        expect(updates).toHaveLength(1);
        const claim = await worker.fetch(
          new Request('https://core.internal/runner-claims', {
            method: 'POST',
            headers: { 'x-compte-rendu-runner-claim': 'verified' },
          }),
        );
        expect(claim.status).toBe(200);
        expect(await claim.json()).toMatchObject({
          pullRequestNumber: 44,
          headSha: eligibleEvent.headSha,
        });
      } finally {
        database.close();
        vi.useRealTimers();
      }
    },
  );

  it('reports the actual newer cleanup blocker when an older cancelled Check is retried', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-12T00:01:05Z'));
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    try {
      const older = await stateStore.claimReview({
        deliveryId: 'delivery-older-cancel',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 46,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-12T00:00:00.000Z',
      });
      if (older.kind !== 'claimed') throw new Error('older run was not admitted');
      await stateStore.recordCheckRun({ runId: older.runId, checkRunId: 331 });
      const olderJob = await claimRunnerJob(stateStore, {
        runId: older.runId,
        jobId: 'runner-job-older-cancel',
        occurredAt: '2026-09-12T00:00:10.000Z',
      });
      await stateStore.cancelRun({
        runId: older.runId,
        requestedByUid: 1,
        occurredAt: '2026-09-12T00:00:20.000Z',
      });
      await stateStore.confirmRunnerDestroyed({
        runId: older.runId,
        jobId: olderJob.jobId,
        attempt: olderJob.attempt,
        occurredAt: '2026-09-12T00:00:30.000Z',
      });

      const newer = await stateStore.claimReview({
        deliveryId: 'delivery-newer-cancel',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 46,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'manual',
        },
        occurredAt: '2026-09-12T00:00:40.000Z',
      });
      if (newer.kind !== 'claimed') throw new Error('newer run was not admitted');
      await stateStore.recordCheckRun({ runId: newer.runId, checkRunId: 332 });
      const newerJob = await claimRunnerJob(stateStore, {
        runId: newer.runId,
        jobId: 'runner-job-newer-cancel',
        occurredAt: '2026-09-12T00:00:50.000Z',
      });
      await stateStore.cancelRun({
        runId: newer.runId,
        requestedByUid: 1,
        occurredAt: '2026-09-12T00:01:00.000Z',
      });

      const updates: unknown[] = [];
      const worker = createCoreWorker(coreEnv(database), {
        stateStore,
        github: {
          getPullRequest: async () => ({
            repositoryVisibility: 'public',
            baseRepositoryId: 11,
            headRepositoryId: 99,
            draft: false,
            baseSha: eligibleEvent.baseSha,
            headSha: eligibleEvent.headSha,
          }),
          getCommenterPermission: async () => 'write',
          updateCheckRun: async (input) => {
            updates.push(input);
          },
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
        },
        getReadInstallationToken: async () => ({
          token: 'read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      });

      const retry = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            deliveryId: 'retry-older-check',
            event: 'check_run',
            action: 'rerequested',
            repositoryId: 11,
            installationId: 7,
            checkRunId: 331,
            externalRunId: older.runId,
            senderLogin: 'maintainer',
          }),
        }),
      );
      expect(retry.status).toBe(202);
      expect(updates).toEqual([
        expect.objectContaining({
          checkRunId: 331,
          status: 'cancelled',
          cancellationReason: 'manual',
          retryBlocked: 'cleanup-pending',
          retryQueued: true,
        }),
      ]);
      expect(updates).not.toContainEqual(expect.objectContaining({ checkRunId: 332 }));
      await expect(
        stateStore.claimNextJob({
          jobId: 'probe-older-blocked',
          attempt: 1,
          occurredAt: '2026-09-12T00:01:10.000Z',
        }),
      ).resolves.toEqual({ kind: 'empty' });

      await stateStore.confirmRunnerDestroyed({
        runId: newer.runId,
        jobId: newerJob.jobId,
        attempt: newerJob.attempt,
        occurredAt: '2026-09-12T00:02:00.000Z',
      });
      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { runId?: string };
      expect(claimed).toMatchObject({
        pullRequestNumber: 46,
        headSha: eligibleEvent.headSha,
      });
      expect(claimed.runId).not.toBe(older.runId);
      expect(claimed.runId).not.toBe(newer.runId);
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('does not report a stale cleanup as a manual retry blocker', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    try {
      const initial = await stateStore.claimReview({
        deliveryId: 'delivery-stale-clear-retry',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 52,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-12T00:00:00.000Z',
      });
      if (initial.kind !== 'claimed') throw new Error('stale run was not admitted');
      await stateStore.recordCheckRun({ runId: initial.runId, checkRunId: 351 });
      await claimRunnerJob(stateStore, {
        runId: initial.runId,
        jobId: 'runner-job-stale-clear-retry',
        occurredAt: '2026-09-12T00:00:10.000Z',
      });
      await stateStore.cancelRun({
        runId: initial.runId,
        requestedByUid: 1,
        occurredAt: '2026-09-12T00:00:20.000Z',
      });

      vi.setSystemTime(new Date('2026-09-12T01:31:00Z'));
      const updates: unknown[] = [];
      const worker = createCoreWorker(coreEnv(database), {
        stateStore,
        github: {
          getPullRequest: async () => ({
            repositoryVisibility: 'public',
            baseRepositoryId: 11,
            headRepositoryId: 99,
            draft: false,
            baseSha: eligibleEvent.baseSha,
            headSha: eligibleEvent.headSha,
          }),
          getCommenterPermission: async () => 'write',
          updateCheckRun: async (input) => {
            updates.push(input);
          },
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
        },
        getReadInstallationToken: async () => ({
          token: 'read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      });

      const retry = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            deliveryId: 'retry-stale-clear',
            event: 'check_run',
            action: 'rerequested',
            repositoryId: 11,
            installationId: 7,
            checkRunId: 351,
            externalRunId: initial.runId,
            senderLogin: 'maintainer',
          }),
        }),
      );
      expect(retry.status).toBe(202);
      expect(updates).toEqual([]);
      await expect(
        stateStore.claimNextJob({
          jobId: 'probe-stale-clear',
          attempt: 1,
          occurredAt: '2026-09-12T01:31:00.000Z',
        }),
      ).resolves.toMatchObject({
        kind: 'claimed',
        job: { pullRequestNumber: 52, headSha: eligibleEvent.headSha },
      });
      await expect(stateStore.getRunOutcome(initial.runId)).resolves.toMatchObject({
        status: 'cancelled',
        cleanup: 'pending',
      });
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('does not repaint a failed Check when retry feedback is blocked by cleanup', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    try {
      const failed = await stateStore.claimReview({
        deliveryId: 'delivery-failed-check-feedback',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 49,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-12T00:00:00.000Z',
      });
      if (failed.kind !== 'claimed') throw new Error('failed run was not admitted');
      await stateStore.recordCheckRun({ runId: failed.runId, checkRunId: 341 });
      await stateStore.markSchedulingFailed({
        runId: failed.runId,
        occurredAt: '2026-09-12T00:00:10.000Z',
      });

      const newer = await stateStore.claimReview({
        deliveryId: 'delivery-newer-cleanup-for-failed-check',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 49,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'manual',
        },
        occurredAt: '2026-09-12T00:00:20.000Z',
      });
      if (newer.kind !== 'claimed') throw new Error('newer run was not admitted');
      await claimRunnerJob(stateStore, {
        runId: newer.runId,
        jobId: 'runner-job-newer-for-failed-check',
        occurredAt: '2026-09-12T00:00:30.000Z',
      });
      await stateStore.cancelRun({
        runId: newer.runId,
        requestedByUid: 1,
        occurredAt: '2026-09-12T00:00:40.000Z',
      });

      const updates: unknown[] = [];
      const worker = createCoreWorker(coreEnv(database), {
        stateStore,
        github: {
          getPullRequest: async () => ({
            repositoryVisibility: 'public',
            baseRepositoryId: 11,
            headRepositoryId: 99,
            draft: false,
            baseSha: eligibleEvent.baseSha,
            headSha: eligibleEvent.headSha,
          }),
          getCommenterPermission: async () => 'write',
          updateCheckRun: async (input) => {
            updates.push(input);
          },
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
        },
        getReadInstallationToken: async () => ({
          token: 'read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      });

      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            deliveryId: 'retry-failed-check',
            event: 'check_run',
            action: 'rerequested',
            repositoryId: 11,
            installationId: 7,
            checkRunId: 341,
            externalRunId: failed.runId,
            senderLogin: 'maintainer',
          }),
        }),
      );
      expect(response.status).toBe(202);
      expect(updates).toEqual([]);
      await expect(stateStore.getRunOutcome(failed.runId)).resolves.toMatchObject({
        status: 'failed',
      });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: 'before the deadline',
      occurredAt: '2026-09-12T00:01:00.000Z',
      scheduled: false,
    },
    {
      label: 'after the deadline',
      occurredAt: '2026-09-12T01:31:00.000Z',
      scheduled: true,
    },
  ] as const)(
    'handles an authorized /ai-review comment with cancelled cleanup $label',
    async ({ occurredAt, scheduled }) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
      const database = new SqliteD1Database();
      const stateStore = createD1ReviewStateStore(database);
      try {
        const cancelled = await stateStore.claimReview({
          deliveryId: 'delivery-comment-blocked',
          job: {
            repositoryId: 11,
            installationId: 7,
            pullRequestNumber: 47,
            baseSha: eligibleEvent.baseSha,
            headSha: eligibleEvent.headSha,
            trigger: 'automatic',
          },
          occurredAt: '2026-09-12T00:00:00.000Z',
        });
        if (cancelled.kind !== 'claimed') throw new Error('cancelled run was not admitted');
        await claimRunnerJob(stateStore, {
          runId: cancelled.runId,
          jobId: 'runner-job-comment-blocked',
          occurredAt: '2026-09-12T00:00:10.000Z',
        });
        await stateStore.cancelRun({
          runId: cancelled.runId,
          requestedByUid: 1,
          occurredAt: '2026-09-12T00:00:20.000Z',
        });
        const updates: unknown[] = [];
        const reactions: unknown[] = [];
        const worker = createCoreWorker(coreEnv(database), {
          stateStore,
          github: {
            getPullRequest: async () => ({
              repositoryVisibility: 'public',
              baseRepositoryId: 11,
              headRepositoryId: 99,
              draft: false,
              baseSha: eligibleEvent.baseSha,
              headSha: eligibleEvent.headSha,
            }),
            getCommenterPermission: async () => 'write',
            updateCheckRun: async (input) => {
              updates.push(input);
            },
            addReaction: async (input) => {
              reactions.push(input);
            },
            getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
            loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          },
          getReadInstallationToken: async () => ({
            token: 'read-token',
            expiresAt: '2026-09-01T01:00:00.000Z',
          }),
        });

        vi.setSystemTime(new Date(occurredAt));
        const response = await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({
              deliveryId: 'comment-during-cleanup',
              event: 'issue_comment',
              action: 'created',
              repositoryId: 11,
              pullRequestNumber: 47,
              installationId: 7,
              commentId: 987,
              commenterLogin: 'maintainer',
              command: '/ai-review',
            }),
          }),
        );
        expect(response.status).toBe(202);
        expect(updates).toEqual([]);
        expect(reactions).toEqual(
          scheduled
            ? [
                {
                  repositoryId: 11,
                  installationId: 7,
                  commentId: 987,
                  content: 'eyes',
                },
              ]
            : [],
        );
        await expect(
          stateStore.getDeliveryOutcome('comment-during-cleanup'),
        ).resolves.toMatchObject({ status: scheduled ? 'scheduled' : 'cancelled' });
        await expect(
          stateStore.claimNextJob({
            jobId: 'probe-comment-cleanup',
            attempt: 1,
            occurredAt,
          }),
        ).resolves.toMatchObject(
          scheduled
            ? {
                kind: 'claimed',
                job: { pullRequestNumber: 47, headSha: eligibleEvent.headSha },
              }
            : { kind: 'empty' },
        );
      } finally {
        database.close();
        vi.useRealTimers();
      }
    },
  );

  it('logs a sanitized failure when cancelled Check retry feedback cannot be updated', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    try {
      const cancelled = await stateStore.claimReview({
        deliveryId: 'delivery-feedback-failed',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 48,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-12T00:00:00.000Z',
      });
      if (cancelled.kind !== 'claimed') throw new Error('cancelled run was not admitted');
      await stateStore.recordCheckRun({ runId: cancelled.runId, checkRunId: 333 });
      await claimRunnerJob(stateStore, {
        runId: cancelled.runId,
        jobId: 'runner-job-feedback-failed',
        occurredAt: '2026-09-12T00:00:10.000Z',
      });
      await stateStore.cancelRun({
        runId: cancelled.runId,
        requestedByUid: 1,
        occurredAt: '2026-09-12T00:00:20.000Z',
      });
      const logs: unknown[] = [];
      const worker = createCoreWorker(coreEnv(database), {
        stateStore,
        log: {
          record: async (event) => {
            logs.push(event);
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
          getCommenterPermission: async () => 'write',
          updateCheckRun: async () => {
            throw new Error('feedback transport exposed private details');
          },
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
        },
        getReadInstallationToken: async () => ({
          token: 'read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      });

      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            deliveryId: 'retry-feedback-failure',
            event: 'check_run',
            action: 'rerequested',
            repositoryId: 11,
            installationId: 7,
            checkRunId: 333,
            externalRunId: cancelled.runId,
            senderLogin: 'maintainer',
          }),
        }),
      );
      expect(response.status).toBe(202);
      expect(logs).toContainEqual({
        phase: 'core',
        outcome: 'retry_feedback_failed',
        deliveryId: 'retry-feedback-failure',
      });
      expect(JSON.stringify(logs)).not.toContain('private details');
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('retries a cancelled Check that never dispatched a Sandbox without cleanup feedback', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    try {
      const initial = await stateStore.claimReview({
        deliveryId: 'delivery-cancel-retry-never-dispatched',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 45,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-12T00:00:00.000Z',
      });
      if (initial.kind !== 'claimed') throw new Error('cancelled run was not admitted');
      const runId = initial.runId;
      await stateStore.recordCheckRun({ runId, checkRunId: 322 });
      await stateStore.cancelRun({
        runId,
        requestedByUid: 1,
        occurredAt: '2026-09-12T00:00:20.000Z',
      });
      const updates: unknown[] = [];
      const worker = createCoreWorker(coreEnv(database), {
        stateStore,
        github: {
          getPullRequest: async () => ({
            repositoryVisibility: 'public',
            baseRepositoryId: 11,
            headRepositoryId: 99,
            draft: false,
            baseSha: eligibleEvent.baseSha,
            headSha: eligibleEvent.headSha,
          }),
          getCommenterPermission: async () => 'write',
          updateCheckRun: async (input) => {
            updates.push(input);
          },
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
        },
        getReadInstallationToken: async () => ({
          token: 'read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      });

      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            deliveryId: 'retry-never-dispatched',
            event: 'check_run',
            action: 'rerequested',
            repositoryId: 11,
            installationId: 7,
            checkRunId: 322,
            externalRunId: runId,
            senderLogin: 'maintainer',
          }),
        }),
      );
      expect(response.status).toBe(202);
      expect(updates).toEqual([]);
      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(claim.status).toBe(200);
      expect(await claim.json()).toMatchObject({
        pullRequestNumber: 45,
        headSha: eligibleEvent.headSha,
      });
    } finally {
      database.close();
    }
  });

  it('lists the latest product Check runs for a suite with the exact query', async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/repositories/11') return Response.json({ full_name: 'acme/reviewed' });
      if (url.pathname === '/repos/acme/reviewed/check-suites/555/check-runs') {
        return Response.json({ total_count: 1, check_runs: [{ id: 321, external_id: 'run-1' }] });
      }
      return new Response('{}', { status: 404 });
    };
    const github = createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher });

    await expect(
      github.findCheckRunForSuite?.({ repositoryId: 11, installationId: 7, checkSuiteId: 555 }),
    ).resolves.toEqual({ candidates: [{ id: 321, externalId: 'run-1' }] });
    expect(requests).toContain(
      '/repos/acme/reviewed/check-suites/555/check-runs?check_name=Compte-rendu%20review&filter=latest&per_page=100',
    );
  });
});

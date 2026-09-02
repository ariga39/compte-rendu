import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitHubAdapter } from '../apps/core/src/index';
import type { RunnerJobInput } from '../packages/contracts/src';
import { createGitHubPublicationProbe } from '../scripts/github-publication-probe.mts';

const job: RunnerJobInput = {
  id: 'probe-job-1',
  runId: 'probe-run-1',
  attempt: 1,
  repositoryUrl: 'https://github.com/acme/reviewed.git',
  repositoryName: 'acme/reviewed',
  pullRequestNumber: 42,
  baseSha: '1111111111111111111111111111111111111111',
  headSha: '2222222222222222222222222222222222222222',
  repositoryReadToken: 'read-only-token-must-not-be-persisted',
};

const encoded = (value: string) => Buffer.from(value).toString('base64');

const evidenceField = (content: string) => ({
  content,
  size: Buffer.from(content, 'utf8').byteLength,
  sha256: '0'.repeat(64),
});

const successfulCallback = {
  id: job.id,
  runId: job.runId,
  attempt: job.attempt,
  status: 'succeeded' as const,
  stage: 'cleanup' as const,
  sandbox: { cleanup: 'destroyed' as const },
  timestamps: {
    executionStartedAt: '2026-09-02T00:00:01.000Z',
    submissionCompletedAt: '2026-09-02T00:00:02.000Z',
    cleanupCompletedAt: '2026-09-02T00:00:03.000Z',
  },
  evidence: {
    id: 'probe-evidence-1',
    status: 'complete' as const,
    manifest: evidenceField(encoded('{}')),
    opencodeJsonl: evidenceField(encoded('{}')),
    opencodeStderr: evidenceField(encoded('')),
    validatedReview: evidenceField(encoded('## Review:\n\nProbe result.\n')),
    opencodeSessionList: evidenceField(encoded('[]')),
    opencodeExport: {
      sessionId: 'probe-session-1',
      content: evidenceField(encoded('{}')),
    },
  },
  result: '## Review:\n\nProbe result.\n',
};

describe('GitHub publication probe', () => {
  it('durably captures an exact succeeded callback publication without invoking upstream writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compte-rendu-publication-probe-'));
    const jobsPath = join(root, 'jobs.json');
    const evidenceRoot = join(root, 'evidence');
    await writeFile(jobsPath, JSON.stringify([{ repositoryId: 11, installationId: 7, job }]), {
      mode: 0o600,
    });
    await chmod(jobsPath, 0o600);

    const upstreamReviewCalls: unknown[] = [];
    const upstreamReactionCalls: unknown[] = [];
    const upstream: GitHubAdapter = {
      loadReviewTarget: async () => ({ headSha: job.headSha }),
      addReaction: async (input) => {
        upstreamReactionCalls.push(input);
        throw new Error('upstream reaction write must not be called');
      },
      createReview: async (input) => {
        upstreamReviewCalls.push(input);
        throw new Error('upstream review write must not be called');
      },
    };
    const probe = await createGitHubPublicationProbe({
      jobsPath,
      evidenceRoot,
      callbackToken: 'probe-token',
      readAdapter: upstream,
    });

    const claim = await probe.fetch(
      new Request('http://127.0.0.1/runner-claim', {
        method: 'POST',
        headers: { authorization: 'Bearer probe-token' },
      }),
    );
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toEqual(job);

    const callback = await probe.fetch(
      new Request('http://127.0.0.1/runner-callback', {
        method: 'POST',
        headers: {
          authorization: 'Bearer probe-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(successfulCallback),
      }),
    );
    expect(callback.status).toBe(202);

    const files = await readdir(evidenceRoot);
    expect(files.sort()).toEqual(['callback-1.json', 'captured-review-1.json']);
    await expect(stat(evidenceRoot).then((value) => value.mode & 0o777)).resolves.toBe(0o700);
    for (const file of files) {
      await expect(
        stat(join(evidenceRoot, file)).then((value) => value.mode & 0o777),
      ).resolves.toBe(0o600);
    }
    const rawCallback = await readFile(join(evidenceRoot, 'callback-1.json'), 'utf8');
    expect(JSON.parse(rawCallback)).toEqual(successfulCallback);
    const capturedReview = JSON.parse(
      await readFile(join(evidenceRoot, 'captured-review-1.json'), 'utf8'),
    );
    expect(capturedReview).toEqual({
      repositoryId: 11,
      pullRequestNumber: job.pullRequestNumber,
      installationId: 7,
      payload: {
        event: 'COMMENT',
        commit_id: job.headSha,
        body: `<!-- compte-rendu:run:${job.runId} -->\n${successfulCallback.result}`,
      },
    });
    expect(`${rawCallback}\n${JSON.stringify(capturedReview)}`).not.toContain(
      job.repositoryReadToken,
    );
    expect(upstreamReviewCalls).toEqual([]);
    expect(upstreamReactionCalls).toEqual([]);
  });

  it('rejects an unclaimed or mismatched callback before creating a review artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compte-rendu-publication-probe-'));
    const jobsPath = join(root, 'jobs.json');
    await writeFile(jobsPath, JSON.stringify([{ repositoryId: 11, installationId: 7, job }]), {
      mode: 0o600,
    });
    await chmod(jobsPath, 0o600);
    const probe = await createGitHubPublicationProbe({
      jobsPath,
      evidenceRoot: join(root, 'evidence'),
      callbackToken: 'probe-token',
      readAdapter: {},
    });

    const response = await probe.fetch(
      new Request('http://127.0.0.1/runner-callback', {
        method: 'POST',
        headers: {
          authorization: 'Bearer probe-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(successfulCallback),
      }),
    );

    expect(response.status).toBe(404);
    await expect(readdir(join(root, 'evidence'))).resolves.toEqual([]);
  });
});

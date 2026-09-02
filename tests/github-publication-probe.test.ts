import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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

  it('retains exact callback evidence without a review when the head is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compte-rendu-publication-probe-'));
    const jobsPath = join(root, 'jobs.json');
    const evidenceRoot = join(root, 'evidence');
    await writeFile(jobsPath, JSON.stringify([{ repositoryId: 11, installationId: 7, job }]), {
      mode: 0o600,
    });
    await chmod(jobsPath, 0o600);
    const probe = await createGitHubPublicationProbe({
      jobsPath,
      evidenceRoot,
      callbackToken: 'probe-token',
      readAdapter: {
        loadReviewTarget: async () => ({
          headSha: '4444444444444444444444444444444444444444',
        }),
      },
    });
    await expect(
      probe.fetch(
        new Request('http://127.0.0.1/runner-claim', {
          method: 'POST',
          headers: { authorization: 'Bearer probe-token' },
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });

    const callbackResponse = await probe.fetch(
      new Request('http://127.0.0.1/runner-callback', {
        method: 'POST',
        headers: {
          authorization: 'Bearer probe-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(successfulCallback),
      }),
    );

    expect(callbackResponse.status).toBe(409);
    await expect(readdir(evidenceRoot)).resolves.toEqual(['callback-1.json']);
    await expect(readFile(join(evidenceRoot, 'callback-1.json'), 'utf8')).resolves.toBe(
      JSON.stringify(successfulCallback),
    );
    await expect(
      stat(join(evidenceRoot, 'callback-1.json')).then((value) => value.mode & 0o777),
    ).resolves.toBe(0o600);
  });

  it('moves a succeeded pair when an external review claims its reserved suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compte-rendu-publication-probe-'));
    const jobsPath = join(root, 'jobs.json');
    const evidenceRoot = join(root, 'evidence');
    const externalReview = 'external review must remain unchanged';
    await writeFile(jobsPath, JSON.stringify([{ repositoryId: 11, installationId: 7, job }]), {
      mode: 0o600,
    });
    await chmod(jobsPath, 0o600);
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const probe = await createGitHubPublicationProbe({
      jobsPath,
      evidenceRoot,
      callbackToken: 'probe-token',
      readAdapter: {
        loadReviewTarget: async () => {
          await writeFile(join(evidenceRoot, 'captured-review-1.json'), externalReview, {
            flag: 'wx',
            mode: 0o600,
          });
          await chmod(join(evidenceRoot, 'captured-review-1.json'), 0o600);
          return { headSha: job.headSha };
        },
      },
    });
    await expect(
      probe.fetch(
        new Request('http://127.0.0.1/runner-claim', {
          method: 'POST',
          headers: { authorization: 'Bearer probe-token' },
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });

    const callbackResponse = await probe.fetch(
      new Request('http://127.0.0.1/runner-callback', {
        method: 'POST',
        headers: {
          authorization: 'Bearer probe-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(successfulCallback),
      }),
    );

    expect(callbackResponse.status).toBe(202);
    await expect(readFile(join(evidenceRoot, 'captured-review-1.json'), 'utf8')).resolves.toBe(
      externalReview,
    );
    await expect(readdir(evidenceRoot).then((files) => files.sort())).resolves.toEqual([
      'callback-2.json',
      'captured-review-1.json',
      'captured-review-2.json',
    ]);
    await expect(readFile(join(evidenceRoot, 'callback-2.json'), 'utf8')).resolves.toBe(
      JSON.stringify(successfulCallback),
    );
    await expect(readFile(join(evidenceRoot, 'captured-review-2.json'), 'utf8')).resolves.toContain(
      `<!-- compte-rendu:run:${job.runId} -->`,
    );
    for (const file of await readdir(evidenceRoot)) {
      await expect(
        stat(join(evidenceRoot, file)).then((value) => value.mode & 0o777),
      ).resolves.toBe(0o600);
    }
  });

  it('skips a captured review suffix for a non-succeeded callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compte-rendu-publication-probe-'));
    const jobsPath = join(root, 'jobs.json');
    const evidenceRoot = join(root, 'evidence');
    const externalReview = 'external review must remain unchanged';
    const abortedCallback = {
      id: job.id,
      runId: job.runId,
      attempt: job.attempt,
      status: 'aborted' as const,
      stage: 'cleanup' as const,
      sandbox: { cleanup: 'destroyed' as const },
      evidence: {
        id: 'probe-evidence-aborted',
        status: 'incomplete' as const,
        manifest: evidenceField(encoded('{}')),
        opencodeJsonl: evidenceField(encoded('{}')),
        opencodeStderr: evidenceField(encoded('')),
      },
      timestamps: { cleanupCompletedAt: '2026-09-02T00:00:03.000Z' },
    };
    await writeFile(jobsPath, JSON.stringify([{ repositoryId: 11, installationId: 7, job }]), {
      mode: 0o600,
    });
    await chmod(jobsPath, 0o600);
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(evidenceRoot, 'captured-review-1.json'), externalReview, {
      mode: 0o600,
    });
    await chmod(join(evidenceRoot, 'captured-review-1.json'), 0o600);
    const probe = await createGitHubPublicationProbe({
      jobsPath,
      evidenceRoot,
      callbackToken: 'probe-token',
    });
    await expect(
      probe.fetch(
        new Request('http://127.0.0.1/runner-claim', {
          method: 'POST',
          headers: { authorization: 'Bearer probe-token' },
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });

    const callbackResponse = await probe.fetch(
      new Request('http://127.0.0.1/runner-callback', {
        method: 'POST',
        headers: {
          authorization: 'Bearer probe-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(abortedCallback),
      }),
    );

    expect(callbackResponse.status).toBe(202);
    await expect(readFile(join(evidenceRoot, 'captured-review-1.json'), 'utf8')).resolves.toBe(
      externalReview,
    );
    await expect(readdir(evidenceRoot).then((files) => files.sort())).resolves.toEqual([
      'callback-2.json',
      'captured-review-1.json',
    ]);
    await expect(readFile(join(evidenceRoot, 'callback-2.json'), 'utf8')).resolves.toBe(
      JSON.stringify(abortedCallback),
    );
    for (const file of await readdir(evidenceRoot)) {
      await expect(
        stat(join(evidenceRoot, file)).then((value) => value.mode & 0o777),
      ).resolves.toBe(0o600);
    }
  });

  it('keeps earlier callback and captured-review evidence after a probe restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compte-rendu-publication-probe-'));
    const evidenceRoot = join(root, 'evidence');
    const firstJobsPath = join(root, 'first-jobs.json');
    const secondJobsPath = join(root, 'second-jobs.json');
    const secondJob: RunnerJobInput = {
      ...job,
      id: 'probe-job-2',
      runId: 'probe-run-2',
      pullRequestNumber: 43,
      headSha: '3333333333333333333333333333333333333333',
    };
    const secondCallback = {
      ...successfulCallback,
      id: secondJob.id,
      runId: secondJob.runId,
      result: '## Review:\n\nSecond probe result.\n',
      evidence: {
        ...successfulCallback.evidence,
        id: 'probe-evidence-2',
        validatedReview: evidenceField(encoded('## Review:\n\nSecond probe result.\n')),
      },
    };
    await writeFile(firstJobsPath, JSON.stringify([{ repositoryId: 11, installationId: 7, job }]), {
      mode: 0o600,
    });
    await chmod(firstJobsPath, 0o600);
    await writeFile(
      secondJobsPath,
      JSON.stringify([{ repositoryId: 11, installationId: 7, job: secondJob }]),
      { mode: 0o600 },
    );
    await chmod(secondJobsPath, 0o600);

    const firstProbe = await createGitHubPublicationProbe({
      jobsPath: firstJobsPath,
      evidenceRoot,
      callbackToken: 'probe-token',
    });
    const firstClaim = await firstProbe.fetch(
      new Request('http://127.0.0.1/runner-claim', {
        method: 'POST',
        headers: { authorization: 'Bearer probe-token' },
      }),
    );
    expect(firstClaim.status).toBe(200);
    const firstCallback = await firstProbe.fetch(
      new Request('http://127.0.0.1/runner-callback', {
        method: 'POST',
        headers: {
          authorization: 'Bearer probe-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(successfulCallback),
      }),
    );
    expect(firstCallback.status).toBe(202);
    const firstCallbackBytes = await readFile(join(evidenceRoot, 'callback-1.json'));
    const firstReviewBytes = await readFile(join(evidenceRoot, 'captured-review-1.json'));

    const secondProbe = await createGitHubPublicationProbe({
      jobsPath: secondJobsPath,
      evidenceRoot,
      callbackToken: 'probe-token',
    });
    const secondClaim = await secondProbe.fetch(
      new Request('http://127.0.0.1/runner-claim', {
        method: 'POST',
        headers: { authorization: 'Bearer probe-token' },
      }),
    );
    expect(secondClaim.status).toBe(200);
    const secondCallbackResponse = await secondProbe.fetch(
      new Request('http://127.0.0.1/runner-callback', {
        method: 'POST',
        headers: {
          authorization: 'Bearer probe-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(secondCallback),
      }),
    );
    expect(secondCallbackResponse.status).toBe(202);

    await expect(readFile(join(evidenceRoot, 'callback-1.json'))).resolves.toEqual(
      firstCallbackBytes,
    );
    await expect(readFile(join(evidenceRoot, 'captured-review-1.json'))).resolves.toEqual(
      firstReviewBytes,
    );
    await expect(readdir(evidenceRoot).then((files) => files.sort())).resolves.toEqual([
      'callback-1.json',
      'callback-2.json',
      'captured-review-1.json',
      'captured-review-2.json',
    ]);
    await expect(readFile(join(evidenceRoot, 'callback-2.json'), 'utf8')).resolves.toBe(
      JSON.stringify(secondCallback),
    );
    expect(
      JSON.parse(await readFile(join(evidenceRoot, 'captured-review-2.json'), 'utf8')),
    ).toEqual({
      repositoryId: 11,
      pullRequestNumber: secondJob.pullRequestNumber,
      installationId: 7,
      payload: {
        event: 'COMMENT',
        commit_id: secondJob.headSha,
        body: `<!-- compte-rendu:run:${secondJob.runId} -->\n${secondCallback.result}`,
      },
    });
    for (const file of await readdir(evidenceRoot)) {
      await expect(
        stat(join(evidenceRoot, file)).then((value) => value.mode & 0o777),
      ).resolves.toBe(0o600);
    }
  });

  it('reserves one suffix for each concurrent callback and captured-review pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compte-rendu-publication-probe-'));
    const evidenceRoot = join(root, 'evidence');
    const jobsPath = join(root, 'jobs.json');
    const secondJob: RunnerJobInput = {
      ...job,
      id: 'probe-job-2',
      runId: 'probe-run-2',
      pullRequestNumber: 43,
      headSha: '3333333333333333333333333333333333333333',
    };
    const secondCallback = {
      ...successfulCallback,
      id: secondJob.id,
      runId: secondJob.runId,
      result: '## Review:\n\nSecond concurrent result.\n',
      evidence: {
        ...successfulCallback.evidence,
        id: 'probe-evidence-2',
        validatedReview: evidenceField(encoded('## Review:\n\nSecond concurrent result.\n')),
      },
    };
    const preexisting = {
      'callback-1.json': 'preexisting callback one',
      'captured-review-3.json': 'preexisting captured review three',
      'callback-5.json': 'preexisting callback five',
      'captured-review-6.json': 'preexisting captured review six',
    };
    await writeFile(
      jobsPath,
      JSON.stringify([
        { repositoryId: 11, installationId: 7, job },
        { repositoryId: 11, installationId: 7, job: secondJob },
      ]),
      { mode: 0o600 },
    );
    await chmod(jobsPath, 0o600);
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    await Promise.all(
      Object.entries(preexisting).map(async ([file, content]) => {
        await writeFile(join(evidenceRoot, file), content, { mode: 0o600 });
        await chmod(join(evidenceRoot, file), 0o600);
      }),
    );

    let releaseReads!: () => void;
    const bothReads = new Promise<void>((resolveReads) => {
      releaseReads = resolveReads;
    });
    let readCount = 0;
    const readAdapter: GitHubAdapter = {
      loadReviewTarget: async ({ pullRequestNumber }) => {
        readCount += 1;
        if (readCount === 2) releaseReads();
        await bothReads;
        return {
          headSha: pullRequestNumber === job.pullRequestNumber ? job.headSha : secondJob.headSha,
        };
      },
    };
    const probe = await createGitHubPublicationProbe({
      jobsPath,
      evidenceRoot,
      callbackToken: 'probe-token',
      readAdapter,
    });
    const claimRequest = () =>
      new Request('http://127.0.0.1/runner-claim', {
        method: 'POST',
        headers: { authorization: 'Bearer probe-token' },
      });
    await expect(probe.fetch(claimRequest())).resolves.toMatchObject({ status: 200 });
    await expect(probe.fetch(claimRequest())).resolves.toMatchObject({ status: 200 });

    const firstCallbackRequest = probe.fetch(
      new Request('http://127.0.0.1/runner-callback', {
        method: 'POST',
        headers: {
          authorization: 'Bearer probe-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(successfulCallback),
      }),
    );
    const secondCallbackRequest = probe.fetch(
      new Request('http://127.0.0.1/runner-callback', {
        method: 'POST',
        headers: {
          authorization: 'Bearer probe-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(secondCallback),
      }),
    );
    await bothReads;
    releaseReads();
    const callbackResponses = await Promise.all([firstCallbackRequest, secondCallbackRequest]);
    expect(
      callbackResponses.map((response) => response.status).sort((left, right) => left - right),
    ).toEqual([202, 202]);

    const files = (await readdir(evidenceRoot)).sort();
    expect(files).toEqual([
      'callback-1.json',
      'callback-2.json',
      'callback-4.json',
      'callback-5.json',
      'captured-review-2.json',
      'captured-review-3.json',
      'captured-review-4.json',
      'captured-review-6.json',
    ]);
    for (const [file, content] of Object.entries(preexisting)) {
      await expect(readFile(join(evidenceRoot, file), 'utf8')).resolves.toBe(content);
    }

    const readArtifacts = async (pattern: RegExp, prefix: string) =>
      new Map(
        await Promise.all(
          (await readdir(evidenceRoot))
            .filter((file) => pattern.test(file))
            .map(
              async (file) =>
                [
                  file.slice(prefix.length, -'.json'.length),
                  JSON.parse(await readFile(join(evidenceRoot, file), 'utf8')),
                ] as const,
            ),
        ),
      );
    const callbackArtifacts = await readArtifacts(/^callback-[24]\.json$/, 'callback-');
    const reviewArtifacts = await readArtifacts(/^captured-review-[24]\.json$/, 'captured-review-');
    for (const [suffix, callback] of callbackArtifacts) {
      const matchingReviews = [...reviewArtifacts.entries()].filter(([, review]) =>
        review.payload.body.includes(`<!-- compte-rendu:run:${callback.runId} -->`),
      );
      expect(matchingReviews).toHaveLength(1);
      expect(matchingReviews[0]?.[0]).toBe(suffix);
    }
    for (const file of files) {
      await expect(
        stat(join(evidenceRoot, file)).then((value) => value.mode & 0o777),
      ).resolves.toBe(0o600);
    }
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

import { Schema } from 'effect';
import { GitHubSha } from '@compte-rendu/contracts';
import type { GitHubAdapter } from './index';

const Repository = Schema.Struct({
  full_name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
});

const RepositoryClone = Schema.Struct({
  clone_url: Schema.String.check(
    Schema.isPattern(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/),
  ),
});

const PullRequest = Schema.Struct({
  head: Schema.Struct({ sha: GitHubSha }),
});

const PullRequestDetails = Schema.Struct({
  draft: Schema.Boolean,
  base: Schema.Struct({
    sha: GitHubSha,
    repo: Schema.Struct({
      id: Schema.Int,
      visibility: Schema.Literals(['private', 'public']),
    }),
  }),
  head: Schema.Struct({
    sha: GitHubSha,
    repo: Schema.Struct({ id: Schema.Int }),
  }),
});

const PermissionResponse = Schema.Struct({
  permission: Schema.Literals(['none', 'read', 'triage', 'write', 'maintain', 'admin']),
});

const ReviewRecord = Schema.Struct({
  id: Schema.Int,
  body: Schema.NullOr(Schema.String),
});

const ReviewRecords = Schema.Array(ReviewRecord);
const pageSize = 100;
const maxReviewPages = 10;

const CreatedReview = Schema.Struct({
  id: Schema.Int,
  body: Schema.NullOr(Schema.String),
});

const IssueComment = Schema.Struct({
  id: Schema.Int,
  body: Schema.NullOr(Schema.String),
});

const IssueComments = Schema.Array(IssueComment);
const failureMarkerPattern = /<!-- compte-rendu:failure:run:[^>]+ -->/;

const CheckRun = Schema.Struct({
  id: Schema.Int,
  external_id: Schema.optional(Schema.NullOr(Schema.String)),
});

const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(CheckRun),
});
const checkName = 'Petit Chiba Review';

class MarkerLookupFailed extends Error {}
class GitHubNotFoundError extends Error {}

type TokenProvider = string | ((installationId: number) => Promise<string>);

export interface GitHubPublicationAdapterOptions {
  readonly token: TokenProvider;
  readonly fetch?: typeof fetch;
  readonly apiBaseUrl?: string;
}

export const createGitHubPublicationAdapter = (
  options: GitHubPublicationAdapterOptions,
): GitHubAdapter => {
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');

  const requestJson = async (
    installationId: number,
    path: string,
    init: Pick<RequestInit, 'body' | 'method'> = { method: 'GET' },
  ): Promise<unknown> => {
    const token =
      typeof options.token === 'function' ? await options.token(installationId) : options.token;
    const response = await fetcher(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'compte-rendu-core',
      },
    });
    if (response.status === 404) throw new GitHubNotFoundError('GitHub resource not found');
    if (!response.ok) throw new Error(`GitHub request failed with ${response.status}`);
    return response.json();
  };

  const repositoryName = async (repositoryId: number, installationId: number) => {
    const value = await requestJson(installationId, `/repositories/${repositoryId}`);
    return (await Schema.decodeUnknownPromise(Repository)(value)).full_name;
  };

  const pullRequestPath = async (
    repositoryId: number,
    pullRequestNumber: number,
    installationId: number,
  ) => `/repos/${await repositoryName(repositoryId, installationId)}/pulls/${pullRequestNumber}`;

  const currentHead = async (
    repositoryId: number,
    pullRequestNumber: number,
    installationId: number,
  ) => {
    const value = await requestJson(
      installationId,
      await pullRequestPath(repositoryId, pullRequestNumber, installationId),
    );
    return (await Schema.decodeUnknownPromise(PullRequest)(value)).head.sha;
  };

  const findReviewByMarkerPage = async ({
    repositoryId,
    pullRequestNumber,
    installationId,
    marker,
  }: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    marker: string;
  }) => {
    for (let page = 1; page <= maxReviewPages; page += 1) {
      const value = await requestJson(
        installationId,
        `${await pullRequestPath(repositoryId, pullRequestNumber, installationId)}/reviews?per_page=${pageSize}&page=${page}`,
      );
      const reviews = await Schema.decodeUnknownPromise(ReviewRecords)(value);
      const existing = reviews.find((review) => review.body?.includes(marker));
      if (existing !== undefined) return existing;
      if (reviews.length < pageSize) return undefined;
    }
    throw new Error('GitHub review listing exceeded the safe page limit');
  };

  const findReviewByMarker = async (input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    marker: string;
  }) => {
    let attempt = 0;
    while (attempt < 2) {
      try {
        return await findReviewByMarkerPage(input);
      } catch (error) {
        attempt += 1;
        if (attempt === 2) throw error;
      }
    }
    throw new Error('GitHub review marker lookup retry exhausted');
  };

  const findIssueCommentByMarker = async ({
    repositoryId,
    pullRequestNumber,
    installationId,
    marker,
  }: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    marker: string;
  }) => {
    for (let page = 1; page <= maxReviewPages; page += 1) {
      const value = await requestJson(
        installationId,
        `/repos/${await repositoryName(repositoryId, installationId)}/issues/${pullRequestNumber}/comments?per_page=${pageSize}&page=${page}`,
      );
      const comments = await Schema.decodeUnknownPromise(IssueComments)(value);
      const existing = comments.find((comment) => comment.body?.includes(marker));
      if (existing !== undefined) return existing;
      if (comments.length < pageSize) return undefined;
    }
    throw new Error('GitHub issue comment listing exceeded the safe page limit');
  };

  const findCheckRun = async ({
    repositoryId,
    installationId,
    headSha,
    runId,
  }: {
    repositoryId: number;
    installationId: number;
    headSha: string;
    runId: string;
  }) => {
    const value = await requestJson(
      installationId,
      `/repos/${await repositoryName(repositoryId, installationId)}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(checkName)}&per_page=${pageSize}`,
    );
    const checks = await Schema.decodeUnknownPromise(CheckRuns)(value);
    return checks.check_runs.find((check) => check.external_id === runId);
  };

  return {
    getPullRequest: async ({ repositoryId, pullRequestNumber, installationId }) => {
      try {
        const value = await requestJson(
          installationId,
          await pullRequestPath(repositoryId, pullRequestNumber, installationId),
        );
        const pullRequest = await Schema.decodeUnknownPromise(PullRequestDetails)(value);
        return {
          repositoryVisibility: pullRequest.base.repo.visibility,
          baseRepositoryId: pullRequest.base.repo.id,
          headRepositoryId: pullRequest.head.repo.id,
          draft: pullRequest.draft,
          baseSha: pullRequest.base.sha,
          headSha: pullRequest.head.sha,
        };
      } catch (error) {
        if (error instanceof GitHubNotFoundError) return undefined;
        throw error;
      }
    },
    getCommenterPermission: async ({ repositoryId, installationId, commenterLogin }) => {
      try {
        const value = await requestJson(
          installationId,
          `/repos/${await repositoryName(repositoryId, installationId)}/collaborators/${encodeURIComponent(commenterLogin)}/permission`,
        );
        return (await Schema.decodeUnknownPromise(PermissionResponse)(value)).permission;
      } catch (error) {
        if (error instanceof GitHubNotFoundError) return undefined;
        throw error;
      }
    },
    addReaction: async ({ repositoryId, installationId, commentId, content }) => {
      await requestJson(
        installationId,
        `/repos/${await repositoryName(repositoryId, installationId)}/issues/comments/${commentId}/reactions`,
        { method: 'POST', body: JSON.stringify({ content }) },
      );
    },
    createIssueComment: async ({ repositoryId, pullRequestNumber, installationId, body }) => {
      const marker = failureMarkerPattern.exec(body)?.[0];
      if (marker === undefined) throw new Error('Failure comment marker is required');
      const lookup = () =>
        findIssueCommentByMarker({
          repositoryId,
          pullRequestNumber,
          installationId,
          marker,
        });
      const existing = await lookup();
      if (existing !== undefined) return existing;
      try {
        const value = await requestJson(
          installationId,
          `/repos/${await repositoryName(repositoryId, installationId)}/issues/${pullRequestNumber}/comments`,
          { method: 'POST', body: JSON.stringify({ body }) },
        );
        return await Schema.decodeUnknownPromise(IssueComment)(value);
      } catch (error) {
        const recovered = await lookup();
        if (recovered !== undefined) return recovered;
        throw error;
      }
    },
    createCheckRun: async ({ repositoryId, installationId, headSha, runId }) => {
      const lookup = () => findCheckRun({ repositoryId, installationId, headSha, runId });
      const existing = await lookup();
      if (existing !== undefined) return { id: existing.id };
      try {
        const value = await requestJson(
          installationId,
          `/repos/${await repositoryName(repositoryId, installationId)}/check-runs`,
          {
            method: 'POST',
            body: JSON.stringify({
              name: checkName,
              head_sha: headSha,
              status: 'queued',
              external_id: runId,
              output: {
                title: 'Review queued',
                summary: 'Waiting for an available review runner.',
              },
            }),
          },
        );
        const check = await Schema.decodeUnknownPromise(CheckRun)(value);
        return { id: check.id };
      } catch (error) {
        const recovered = await lookup();
        if (recovered !== undefined) return { id: recovered.id };
        throw error;
      }
    },
    updateCheckRun: async ({ repositoryId, installationId, checkRunId, status }) => {
      const payload =
        status === 'in_progress'
          ? {
              status,
              output: { title: 'Review in progress', summary: 'The review agent is running.' },
            }
          : status === 'success'
            ? {
                status: 'completed',
                conclusion: status,
                output: { title: 'Review completed', summary: 'The Review was published.' },
              }
            : status === 'failure'
              ? {
                  status: 'completed',
                  conclusion: status,
                  output: {
                    title: 'Review failed',
                    summary: 'See the failure comment on this pull request.',
                  },
                }
              : {
                  status: 'completed',
                  conclusion: status,
                  output: {
                    title: 'Review cancelled',
                    summary: 'A newer pull request revision replaced this run.',
                  },
                };
      await requestJson(
        installationId,
        `/repos/${await repositoryName(repositoryId, installationId)}/check-runs/${checkRunId}`,
        { method: 'PATCH', body: JSON.stringify(payload) },
      );
    },
    getRepositoryUrl: async ({ repositoryId, installationId }) => {
      const value = await requestJson(installationId, `/repositories/${repositoryId}`);
      return (await Schema.decodeUnknownPromise(RepositoryClone)(value)).clone_url;
    },
    loadReviewTarget: async ({ repositoryId, pullRequestNumber, installationId }) => {
      const pullRequestValue = await requestJson(
        installationId,
        await pullRequestPath(repositoryId, pullRequestNumber, installationId),
      );
      const pullRequest = await Schema.decodeUnknownPromise(PullRequest)(pullRequestValue);
      return { headSha: pullRequest.head.sha };
    },
    createReview: async ({ repositoryId, pullRequestNumber, installationId, payload }) => {
      let attempt = 0;
      while (attempt < 2) {
        try {
          const headSha = await currentHead(repositoryId, pullRequestNumber, installationId);
          if (headSha !== payload.commit_id) {
            return { kind: 'stale', currentHeadSha: headSha };
          }
          try {
            const value = await requestJson(
              installationId,
              `${await pullRequestPath(repositoryId, pullRequestNumber, installationId)}/reviews`,
              { method: 'POST', body: JSON.stringify(payload) },
            );
            return {
              kind: 'created',
              review: await Schema.decodeUnknownPromise(CreatedReview)(value),
            };
          } catch (error) {
            const marker = /<!-- compte-rendu:run:[^>]+ -->/.exec(payload.body)?.[0];
            if (marker !== undefined) {
              let existing: Awaited<ReturnType<typeof findReviewByMarker>>;
              try {
                existing = await findReviewByMarker({
                  repositoryId,
                  pullRequestNumber,
                  installationId,
                  marker,
                });
              } catch {
                throw new MarkerLookupFailed('GitHub review marker lookup failed');
              }
              if (existing !== undefined) return { kind: 'created', review: existing };
            }
            throw error;
          }
        } catch (error) {
          if (error instanceof MarkerLookupFailed) throw error;
          attempt += 1;
          if (attempt === 2) throw error;
        }
      }
      throw new Error('GitHub review publication retry exhausted');
    },
    findReviewByMarker,
  };
};

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

const PullRequestFile = Schema.Struct({
  filename: Schema.NonEmptyString,
  patch: Schema.optional(Schema.NullOr(Schema.String)),
});

const ReviewRecord = Schema.Struct({
  id: Schema.Int,
  body: Schema.NullOr(Schema.String),
});

const ReviewRecords = Schema.Array(ReviewRecord);
const PullRequestFiles = Schema.Array(PullRequestFile);
const pageSize = 100;
const maxFilePages = 30;
const maxReviewPages = 10;

const CreatedReview = Schema.Struct({
  id: Schema.Int,
  body: Schema.NullOr(Schema.String),
});

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

  const listFiles = async (
    repositoryId: number,
    pullRequestNumber: number,
    installationId: number,
  ) => {
    const files: Array<typeof PullRequestFile.Type> = [];
    for (let page = 1; page <= maxFilePages; page += 1) {
      const value = await requestJson(
        installationId,
        `${await pullRequestPath(repositoryId, pullRequestNumber, installationId)}/files?per_page=${pageSize}&page=${page}`,
      );
      const pageFiles = await Schema.decodeUnknownPromise(PullRequestFiles)(value);
      files.push(...pageFiles);
      if (pageFiles.length < pageSize) return files;
    }
    return files;
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
      const files = await listFiles(repositoryId, pullRequestNumber, installationId);
      return {
        headSha: pullRequest.head.sha,
        files: files.map((file) => ({ path: file.filename, patch: file.patch })),
      };
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

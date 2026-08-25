import { Schema } from 'effect';
import { GitHubSha } from '@compte-rendu/contracts';
import type { GitHubAdapter } from './index';

const Repository = Schema.Struct({
  full_name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
});

const PullRequest = Schema.Struct({
  head: Schema.Struct({ sha: GitHubSha }),
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

type TokenProvider = string | (() => Promise<string>);

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
    path: string,
    init: Pick<RequestInit, 'body' | 'method'> = { method: 'GET' },
  ): Promise<unknown> => {
    const token = typeof options.token === 'function' ? await options.token() : options.token;
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
    if (!response.ok) throw new Error(`GitHub request failed with ${response.status}`);
    return response.json();
  };

  const repositoryName = async (repositoryId: number) => {
    const value = await requestJson(`/repositories/${repositoryId}`);
    return (await Schema.decodeUnknownPromise(Repository)(value)).full_name;
  };

  const pullRequestPath = async (repositoryId: number, pullRequestNumber: number) =>
    `/repos/${await repositoryName(repositoryId)}/pulls/${pullRequestNumber}`;

  const currentHead = async (repositoryId: number, pullRequestNumber: number) => {
    const value = await requestJson(await pullRequestPath(repositoryId, pullRequestNumber));
    return (await Schema.decodeUnknownPromise(PullRequest)(value)).head.sha;
  };

  const findReviewByMarkerPage = async ({
    repositoryId,
    pullRequestNumber,
    marker,
  }: {
    repositoryId: number;
    pullRequestNumber: number;
    marker: string;
  }) => {
    for (let page = 1; page <= maxReviewPages; page += 1) {
      const value = await requestJson(
        `${await pullRequestPath(repositoryId, pullRequestNumber)}/reviews?per_page=${pageSize}&page=${page}`,
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

  const listFiles = async (repositoryId: number, pullRequestNumber: number) => {
    const files: Array<typeof PullRequestFile.Type> = [];
    for (let page = 1; page <= maxFilePages; page += 1) {
      const value = await requestJson(
        `${await pullRequestPath(repositoryId, pullRequestNumber)}/files?per_page=${pageSize}&page=${page}`,
      );
      const pageFiles = await Schema.decodeUnknownPromise(PullRequestFiles)(value);
      files.push(...pageFiles);
      if (pageFiles.length < pageSize) return files;
    }
    return files;
  };

  return {
    loadReviewTarget: async ({ repositoryId, pullRequestNumber }) => {
      const pullRequestValue = await requestJson(
        await pullRequestPath(repositoryId, pullRequestNumber),
      );
      const pullRequest = await Schema.decodeUnknownPromise(PullRequest)(pullRequestValue);
      const files = await listFiles(repositoryId, pullRequestNumber);
      return {
        headSha: pullRequest.head.sha,
        files: files.map((file) => ({ path: file.filename, patch: file.patch })),
      };
    },
    createReview: async ({ repositoryId, pullRequestNumber, payload }) => {
      let attempt = 0;
      while (attempt < 2) {
        try {
          const headSha = await currentHead(repositoryId, pullRequestNumber);
          if (headSha !== payload.commit_id) {
            return { kind: 'stale', currentHeadSha: headSha };
          }
          try {
            const value = await requestJson(
              `${await pullRequestPath(repositoryId, pullRequestNumber)}/reviews`,
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

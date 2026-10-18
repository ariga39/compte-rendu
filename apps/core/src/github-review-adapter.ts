import { Schema } from 'effect';
import { GitHubSha } from '@compte-rendu/contracts';
import { GitHubNotFoundError, GitHubRequestError, parseRetryAfterMs } from './github-http';
import type { GitHubAdapter } from './index';

const Repository = Schema.Struct({
  full_name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
});

const RepositoryClone = Schema.Struct({
  clone_url: Schema.String.check(
    Schema.isPattern(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/),
  ),
});

const RepositoryMetadataResponse = Schema.Struct({
  full_name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  visibility: Schema.Literals(['public', 'private']),
});

const PullRequest = Schema.Struct({
  head: Schema.Struct({ sha: GitHubSha }),
});

const PullRequestDetails = Schema.Struct({
  draft: Schema.Boolean,
  base: Schema.Struct({
    sha: GitHubSha,
    ref: Schema.optional(Schema.NonEmptyString),
    repo: Schema.Struct({
      id: Schema.Int,
      visibility: Schema.Literals(['private', 'public']),
    }),
  }),
  head: Schema.Struct({
    sha: GitHubSha,
    ref: Schema.optional(Schema.NonEmptyString),
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

const ConfirmedReview = Schema.Struct({
  id: Schema.Int,
  body: Schema.NullOr(Schema.String),
  commit_id: GitHubSha,
  state: Schema.Literals(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
  user: Schema.Struct({ login: Schema.NonEmptyString, type: Schema.NonEmptyString }),
});
const ReviewRecords = Schema.Array(ReviewRecord);
const expectedReviewState = (event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT') =>
  event === 'APPROVE'
    ? 'APPROVED'
    : event === 'REQUEST_CHANGES'
      ? 'CHANGES_REQUESTED'
      : 'COMMENTED';
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
  output: Schema.optional(
    Schema.NullOr(Schema.Struct({ title: Schema.String, summary: Schema.String })),
  ),
});

const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(CheckRun),
});

class MarkerLookupFailed extends Error {}
class ReviewConfirmationFailed extends Error {}
export { GitHubNotFoundError, GitHubRequestError } from './github-http';

type TokenProvider = string | ((installationId: number, signal?: AbortSignal) => Promise<string>);

export interface GitHubPublicationAdapterOptions {
  readonly token: TokenProvider;
  readonly fetch?: typeof fetch;
  readonly apiBaseUrl?: string;
  readonly dashboardOrigin?: string;
  readonly getReviewAuthorLogin?: () => Promise<string>;
  readonly checkName?: string;
}

export const createGitHubPublicationAdapter = (
  options: GitHubPublicationAdapterOptions,
): GitHubAdapter => {
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const checkName = options.checkName?.trim() || 'Petit Chiba Review';
  const dashboardOrigin = options.dashboardOrigin?.trim();
  if (dashboardOrigin) {
    const parsed = new URL(dashboardOrigin);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('DASHBOARD_ORIGIN must be an HTTPS origin');
    }
  }
  const checkLink = (runId: string, output: { title: string; summary: string }) => {
    if (!dashboardOrigin) return { output };
    const detailsUrl = new URL(`/jobs/${encodeURIComponent(runId)}`, dashboardOrigin).href;
    return {
      details_url: detailsUrl,
      output: {
        ...output,
        summary: output.summary.includes(detailsUrl)
          ? output.summary
          : `${output.summary}\n\n[View review task](${detailsUrl})`,
      },
    };
  };

  const requestJson = async (
    installationId: number,
    path: string,
    init: Pick<RequestInit, 'body' | 'method'> & { signal?: AbortSignal } = { method: 'GET' },
  ): Promise<unknown> => {
    const token =
      typeof options.token === 'function'
        ? await options.token(installationId, init.signal)
        : options.token;
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
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
    if (!response.ok) {
      if (response.body !== null) void response.body.cancel().catch(() => undefined);
      if (response.status === 404) throw new GitHubNotFoundError();
      throw new GitHubRequestError(response.status, parseRetryAfterMs(response));
    }
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

  const confirmReview = async (
    value: unknown,
    expected: { headSha: string; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' },
    allowDismissed: boolean,
  ) => {
    let review: typeof ConfirmedReview.Type;
    try {
      review = await Schema.decodeUnknownPromise(ConfirmedReview)(value);
    } catch {
      throw new ReviewConfirmationFailed('GitHub review response is invalid');
    }
    if (
      options.getReviewAuthorLogin === undefined ||
      review.user.type !== 'Bot' ||
      review.user.login !== (await options.getReviewAuthorLogin()) ||
      review.commit_id !== expected.headSha ||
      (review.state !== expectedReviewState(expected.event) &&
        !(allowDismissed && review.state === 'DISMISSED'))
    )
      throw new ReviewConfirmationFailed('GitHub review identity or decision does not match');
    return review;
  };

  const findReviewByMarkerPage = async ({
    repositoryId,
    pullRequestNumber,
    installationId,
    marker,
    expected,
  }: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    marker: string;
    expected?: { headSha: string; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' };
  }) => {
    for (let page = 1; page <= maxReviewPages; page += 1) {
      const value = await requestJson(
        installationId,
        `${await pullRequestPath(repositoryId, pullRequestNumber, installationId)}/reviews?per_page=${pageSize}&page=${page}`,
      );
      const reviews = await Schema.decodeUnknownPromise(Schema.Array(Schema.Unknown))(value);
      const parsedReviews = await Schema.decodeUnknownPromise(ReviewRecords)(reviews);
      const index = parsedReviews.findIndex((review) => review.body?.includes(marker));
      if (index !== -1)
        return expected === undefined
          ? parsedReviews[index]
          : confirmReview(reviews[index], expected, true);
      if (reviews.length < pageSize) return undefined;
    }
    throw new Error('GitHub review listing exceeded the safe page limit');
  };

  const findReviewByMarker = async (input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    marker: string;
    expected?: { headSha: string; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' };
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

  const findCheckRunForSuite = async ({
    repositoryId,
    installationId,
    checkSuiteId,
  }: {
    repositoryId: number;
    installationId: number;
    checkSuiteId: number;
  }) => {
    const value = await requestJson(
      installationId,
      `/repos/${await repositoryName(repositoryId, installationId)}/check-suites/${checkSuiteId}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=latest&per_page=${pageSize}`,
    );
    const checks = await Schema.decodeUnknownPromise(CheckRuns)(value);
    return {
      candidates: checks.check_runs.map((check) => ({
        id: check.id,
        externalId: check.external_id ?? null,
      })),
    };
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
          ...(pullRequest.base.ref === undefined ? {} : { baseRef: pullRequest.base.ref }),
          ...(pullRequest.head.ref === undefined ? {} : { headRef: pullRequest.head.ref }),
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
      const recover = async (check: typeof CheckRun.Type) => {
        if (dashboardOrigin) {
          await requestJson(
            installationId,
            `/repos/${await repositoryName(repositoryId, installationId)}/check-runs/${check.id}`,
            {
              method: 'PATCH',
              body: JSON.stringify(
                checkLink(
                  runId,
                  check.output ?? {
                    title: 'Review task',
                    summary: 'View the recorded review status.',
                  },
                ),
              ),
            },
          );
        }
        return { id: check.id };
      };
      const existing = await lookup();
      if (existing !== undefined) return recover(existing);
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
              ...checkLink(runId, {
                title: 'Review queued',
                summary: 'Waiting for an available review runner.',
              }),
            }),
          },
        );
        const check = await Schema.decodeUnknownPromise(CheckRun)(value);
        return { id: check.id };
      } catch (error) {
        const recovered = await lookup();
        if (recovered !== undefined) return recover(recovered);
        throw error;
      }
    },
    findCheckRunForSuite,
    updateCheckRun: async ({
      repositoryId,
      installationId,
      checkRunId,
      runId,
      status,
      decision,
    }) => {
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
                output:
                  decision === undefined
                    ? { title: 'Review completed', summary: 'The Review was published.' }
                    : {
                        title: `Review published: ${decision === 'approve' ? 'Approve' : decision === 'request_changes' ? 'Request changes' : 'Comment'}`,
                        summary:
                          'The review decision was published for this revision. Repository rules determine merge eligibility.',
                      },
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
        {
          method: 'PATCH',
          body: JSON.stringify({ ...payload, ...checkLink(runId, payload.output) }),
        },
      );
    },
    getRepositoryUrl: async ({ repositoryId, installationId }) => {
      const value = await requestJson(installationId, `/repositories/${repositoryId}`);
      return (await Schema.decodeUnknownPromise(RepositoryClone)(value)).clone_url;
    },
    getRepositoryMetadata: async ({ repositoryId, installationId, signal }) => {
      const value = await requestJson(installationId, `/repositories/${repositoryId}`, {
        method: 'GET',
        ...(signal === undefined ? {} : { signal }),
      });
      return await Schema.decodeUnknownPromise(RepositoryMetadataResponse)(value);
    },
    loadReviewTarget: async ({ repositoryId, pullRequestNumber, installationId }) => {
      const pullRequestValue = await requestJson(
        installationId,
        await pullRequestPath(repositoryId, pullRequestNumber, installationId),
      );
      const pullRequest = await Schema.decodeUnknownPromise(PullRequest)(pullRequestValue);
      return { headSha: pullRequest.head.sha };
    },
    createReview: async ({
      repositoryId,
      pullRequestNumber,
      installationId,
      payload,
      verifyPublication,
    }) => {
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
              review: verifyPublication
                ? await confirmReview(
                    value,
                    { headSha: payload.commit_id, event: payload.event },
                    false,
                  )
                : await Schema.decodeUnknownPromise(CreatedReview)(value),
            };
          } catch (error) {
            if (error instanceof ReviewConfirmationFailed) throw error;
            const marker = /<!-- compte-rendu:run:[^>]+ -->/.exec(payload.body)?.[0];
            if (marker !== undefined) {
              let existing: Awaited<ReturnType<typeof findReviewByMarker>>;
              try {
                existing = await findReviewByMarker({
                  repositoryId,
                  pullRequestNumber,
                  installationId,
                  marker,
                  ...(verifyPublication
                    ? { expected: { headSha: payload.commit_id, event: payload.event } }
                    : {}),
                });
              } catch {
                throw new MarkerLookupFailed('GitHub review marker lookup failed');
              }
              if (existing !== undefined) return { kind: 'created', review: existing };
            }
            throw error;
          }
        } catch (error) {
          if (error instanceof MarkerLookupFailed || error instanceof ReviewConfirmationFailed)
            throw error;
          attempt += 1;
          if (attempt === 2) throw error;
        }
      }
      throw new Error('GitHub review publication retry exhausted');
    },
    findReviewByMarker,
  };
};

# Complete pull-request context from GitHub

Research date: 2026-08-31

## Decision

Let the review agent query GitHub directly with the official `gh` CLI. Give
each run a separate installation token restricted to exactly the target
repository and to `Contents`, `Issues`, `Pull requests`, and `Metadata` read.
Expose only a Docker custom-secret placeholder inside the Sandbox and allow
egress only to `api.github.com:443`; Core retains the App's write authority for
publication.

Do not build or transport a duplicate PR-context snapshot. The required
review skill tells the agent which complete GitHub surfaces to inspect and how
to paginate them. The immutable base/head pair remains the code-review and
publication anchor, while discussion is intentionally read live.

GraphQL is the smallest complete read surface because `PullRequest` exposes
the PR metadata plus connections for commits, issue comments, submitted
reviews, and **all review threads**. `PullRequestReviewThread` exposes
`isResolved` and `isOutdated`, while each thread has its own paginated comment
connection. GitHub's REST review-comment endpoint supplies a flat list and an
`in_reply_to_id`, but does not expose the thread's resolved state. A REST-only
implementation therefore cannot satisfy the issue without inventing or
omitting state; a REST-plus-GraphQL implementation would add matching and
consistency work without adding useful behavior.

Primary sources:

- [`PullRequest` GraphQL object](https://docs.github.com/en/graphql/reference/objects#pullrequest)
- [`PullRequestReviewThread` GraphQL object](https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread)
- [`PullRequestReviewComment` GraphQL object](https://docs.github.com/en/graphql/reference/objects#pullrequestreviewcomment)
- [REST list review comments](https://docs.github.com/en/rest/pulls/comments?apiVersion=2022-11-28#list-review-comments-on-a-pull-request)

| Required surface                     | REST                                           | GraphQL                                                             |
| ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------- |
| PR title/body/author/base/head       | `GET /pulls/{number}`                          | `PullRequest` scalar fields                                         |
| PR commits                           | Dedicated endpoint, but documented maximum 250 | Cursor-paginated `PullRequest.commits` with `totalCount`            |
| Issue comments                       | Paginated, ascending ID                        | Cursor-paginated `PullRequest.comments`                             |
| Submitted review bodies/state/commit | Paginated, chronological                       | Cursor-paginated `PullRequest.reviews`                              |
| Inline replies                       | Flat comments joined with `in_reply_to_id`     | Each thread has a `comments` connection and comments have `replyTo` |
| Resolution/outdated state            | No thread resolution field                     | `isResolved`, `resolvedBy`, `isOutdated`, plus comment `outdated`   |
| Path/line/commit association         | Present on flat review comments                | Thread line/range/sides plus comment current/original commits       |

The GraphQL thread schema currently has `isResolved` and `resolvedBy`, but no
`resolvedAt`; a resolution timestamp is therefore not available from this
surface and must not be fabricated. Source:
[`PullRequestReviewThread`](https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread).

## Data to capture

Use raw Markdown bodies (`body`), not rendered HTML. Every body is untrusted
data. Preserve stable GraphQL node IDs so equally-timed items can be ordered
deterministically and replies can be related without comparing text.

### Pull request

Capture:

- `id`, `number`, `title`, `body`;
- `author { __typename login }`, allowing `author: null` for a deleted actor;
- `authorAssociation`, `createdAt`, `updatedAt`;
- `baseRefName`, `baseRefOid`, `headRefName`, and `headRefOid`.

The schema defines `baseRefOid` and `headRefOid` even when the corresponding
ref was deleted. These OIDs are the revision anchors; ref names are only useful
for diagnostics and Git fetching. Source: [`PullRequest`](https://docs.github.com/en/graphql/reference/objects#pullrequest).

### Commits

Paginate `PullRequest.commits`. For every `PullRequestCommit.commit`, capture:

- `oid` and full `message`;
- primary `author { name email user { login } }`;
- `authoredDate`;
- `committer { name email user { login } }` and `committedDate`.

The `Commit` schema separately defines author and committer details and their
timestamps. It also offers an `authors` connection derived from the Git author
plus `Co-authored-by` trailers; that connection is not needed to represent the
actual Git author, but if product behavior later displays co-authors it must be
paginated like every other connection. Sources:
[`PullRequestCommit`](https://docs.github.com/en/graphql/reference/objects#pullrequestcommit)
and [`Commit`](https://docs.github.com/en/graphql/reference/objects#commit).

Keep the connection order as `ordinal` and verify the resulting SHA sequence
against the full Git graph in the Runner before agent execution. The agent can
then use `git show <oid>` to inspect each intermediate change, not only the net
base-to-head diff.

Do not use REST `GET /pulls/{pull_number}/commits` as the complete source.
GitHub documents a hard maximum of 250 commits for that endpoint and directs
larger callers to the general commit listing API. GraphQL instead provides a
cursor connection with `totalCount` and `pageInfo`; the ordinary GraphQL page
and node limits still apply. Source: [REST list commits on a pull
request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#list-commits-on-a-pull-request).

### Issue comments

Paginate `PullRequest.comments`. For every `IssueComment`, capture:

- `id`, `author { __typename login }`, and `authorAssociation`;
- `body`, `createdAt`, `publishedAt`, `updatedAt`, and `lastEditedAt`.

Sort the completed set by `createdAt`, then stable node ID, while retaining the
API ordinal. REST confirms the equivalent pull-request issue-comment surface
is ordered by ascending ID and that a pull request is also an issue. Sources:
[`IssueComment`](https://docs.github.com/en/graphql/reference/objects#issuecomment)
and [REST list issue comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#list-issue-comments).

### Submitted reviews

Paginate `PullRequest.reviews`. Capture each review's:

- `id`, `author { __typename login }`, and `authorAssociation`;
- `body`, `state`, `createdAt`, `publishedAt`, `submittedAt`, `updatedAt`;
- associated `commit { oid }` when present.

Only include submitted reviews: require a non-null `submittedAt` and reject or
exclude `PENDING`. GitHub's REST documentation explicitly says pending reviews
are not submitted and therefore omit `submitted_at`; it also says the review
list is chronological. Preserve the returned ordinal and normalize the final
list by `submittedAt`, then ID. Sources:
[`PullRequestReview`](https://docs.github.com/en/graphql/reference/objects#pullrequestreview)
and [REST list reviews](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28#list-reviews-for-a-pull-request).

Do not also paginate `review.comments`: all inline conversations are captured
once through `reviewThreads`, which carries the required thread state.

### Inline review threads and replies

Paginate `PullRequest.reviewThreads`. Capture each thread's:

- `id`, `isResolved`, `resolvedBy { login }`, and `isOutdated`;
- `subjectType`, `path`, `diffSide`, `startDiffSide`;
- current `line`/`startLine` and original `originalLine`/`originalStartLine`;
- every node in the thread's own `comments` connection.

For every `PullRequestReviewComment`, capture:

- `id`, `replyTo { id }`, and `pullRequestReview { id }`;
- `author { __typename login }` and `authorAssociation`;
- `body`, `createdAt`, `publishedAt`, and `updatedAt`;
- `state` and `outdated`;
- `path`, `line`, `startLine`, `originalLine`, `originalStartLine`, and
  `subjectType`;
- current `commit { oid }` and `originalCommit { oid }` when present.

The thread is the authoritative location for diff sides and resolution; the
comment is the authoritative location for its current/original commit
association and reply parent. Null line fields are valid for file-level or
outdated comments. Order comments within a thread by `createdAt`, then ID, and
order threads by their first comment's timestamp, then thread ID. Sources:

- [`PullRequestReviewThread`](https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread)
- [`PullRequestReviewComment`](https://docs.github.com/en/graphql/reference/objects#pullrequestreviewcomment)
- [REST review-comment response fields](https://docs.github.com/en/rest/pulls/comments?apiVersion=2022-11-28#list-review-comments-on-a-pull-request)

## Pagination algorithm

Use `gh api graphql` inside the Sandbox. `GH_TOKEN` contains a proxy placeholder;
Docker substitutes the real repository-scoped installation token only for
requests to `api.github.com`. GitHub documents that installation access tokens
work with both GraphQL and REST, subject to the installation's repository
access and permissions. Source: [Authenticating as a GitHub App
installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

GraphQL requires `first` or `last` on every connection, with values from 1 to 100. `pageInfo.endCursor` plus `hasNextPage` drives forward pagination. One
request may select at most 500,000 total nodes, and GitHub terminates a query
that takes longer than ten seconds. Therefore do not build one giant nested
query. Sources: [GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
and [GraphQL query limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#node-limit).

Use this bounded sequence:

1. Resolve `repository(owner:, name:) { pullRequest(number:) }` and capture the
   PR node ID, metadata, `baseRefOid`, and `headRefOid`. Require those OIDs to
   equal the already-admitted job revision.
2. By PR node ID, independently paginate `commits(first: 100, after:)`,
   `comments(first: 100, after:)`, `reviews(first: 100, after:)`, and
   `reviewThreads(first: 100, after:)`. Include the PR's base/head OIDs in each
   response and fail immediately if either changes.
3. For **every** returned thread node ID, independently paginate
   `comments(first: 100, after:)` until `hasNextPage` is false. Include the
   thread's `pullRequest { baseRefOid headRefOid }` on every reply page and
   apply the same revision check. A completed top-level `reviewThreads` cursor
   says nothing about whether a thread has more than 100 replies.
4. Check each connection's observed item count against `totalCount` where the
   connection exposes it. A cursor that does not advance, a missing node, or a
   final count mismatch means the context read is incomplete and must not be
   presented as complete.
5. Re-read PR base/head OIDs after all pages. If either differs from the job,
   stop rather than reviewing a mixed revision.

A representative commit page has this shape; issue comments, reviews, and
threads use separate operations with the same anchor and cursor pattern:

```graphql
query PullRequestCommits($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      baseRefOid
      headRefOid
      commits(first: 100, after: $after) {
        totalCount
        pageInfo {
          endCursor
          hasNextPage
        }
        nodes {
          commit {
            oid
            message
            authoredDate
            committedDate
            author {
              name
              email
              user {
                login
              }
            }
            committer {
              name
              email
              user {
                login
              }
            }
          }
        }
      }
    }
  }
  rateLimit {
    cost
    remaining
    resetAt
  }
}
```

Nested replies must use their own cursor rather than trying to advance them
through the parent connection:

```graphql
query ReviewThreadReplies($threadId: ID!, $after: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      id
      pullRequest {
        baseRefOid
        headRefOid
      }
      comments(first: 100, after: $after) {
        totalCount
        pageInfo {
          endCursor
          hasNextPage
        }
        nodes {
          id
          body
          createdAt
          updatedAt
          replyTo {
            id
          }
        }
      }
    }
  }
  rateLimit {
    cost
    remaining
    resetAt
  }
}
```

GitHub does not document transaction/snapshot isolation across separate
GraphQL requests. This product intentionally accepts live discussion: the
agent must exhaust each relevant cursor and keep checking the admitted
base/head OIDs, while Core independently rechecks the head before publication.
Do not claim that the GitHub discussion was an atomic snapshot.

## Rate-limit facts

For a GitHub App installation outside Enterprise Cloud, GitHub documents a
primary GraphQL limit of 5,000 points/hour per installation, scaling by 50
points for each repository and organization user beyond 20, capped at 12,500.
The secondary limits include 100 concurrent REST-plus-GraphQL requests and
2,000 GraphQL points/minute. The agent may query
`rateLimit { cost remaining resetAt }`; rate-limit or timeout failures must not
be described as a complete context read. Source: [GraphQL rate and query
limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api).

Sequential page reads are simplest and avoid a nested fan-out burst. Thread
comment pages may be fetched with small bounded concurrency only if the same
fail-closed count and revision checks remain in place.

## GitHub App permissions

No new GitHub App permission is needed for this behavior.

The deployed permission set already has:

- **Pull requests: write**, which is at least the `read` level required by get
  PR, list PR commits, list reviews, and list review comments, and remains
  necessary for publishing the final review;
- **Issues: write**, which is at least the `read` level accepted for issue
  comments and remains necessary for the existing reaction behavior;
- **Contents: read**, which remains necessary for authenticated Git fetch of a
  private repository; and
- **Metadata: read**, the normal repository metadata permission.

The endpoint permission tables list `Pull requests: read` for PR commits,
reviews, and review comments. Issue comments accept either `Issues: read` or
`Pull requests: read`; get-PR accepts either `Pull requests: read` or
`Contents: read`. Sources:

- [Get a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request)
- [List commits on a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#list-commits-on-a-pull-request)
- [List reviews](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28#list-reviews-for-a-pull-request)
- [List review comments](https://docs.github.com/en/rest/pulls/comments?apiVersion=2022-11-28#list-review-comments-on-a-pull-request)
- [List issue comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#list-issue-comments)

Mint a distinct token for each run with exactly one `repository_id` and the
four read permissions above. Validate the effective repositories, permissions,
and expiry returned by GitHub. Use this same read token for checkout and live
GitHub queries, revoke it after the Runner reaches a terminal result, and rely
on GitHub's one-hour expiry only as fallback. The App's write-capable token
never crosses the Core-to-Runner interface.

## Full Git history in the Sandbox

The Runner currently performs a normal, non-shallow clone and then fetches the
exact base/head SHAs. Omitting `--depth` is important: Git defines `--depth=N`
as a shallow clone with history truncated to N commits, while `git fetch
--unshallow` converts a shallow repository back to complete history. Sources:
[`git clone --depth`](https://git-scm.com/docs/git-clone#Documentation/git-clone.txt---depthltdepthgt)
and [`git fetch --unshallow`](https://git-scm.com/docs/git-fetch#Documentation/git-fetch.txt---unshallow).

Make PR history explicit and reliable, including fork PRs:

```text
git clone --no-checkout --no-recurse-submodules <base-repository-url> <checkout>
git -C <checkout> fetch --no-tags --no-recurse-submodules origin \
  +refs/heads/<base-ref-name>:refs/remotes/origin/review-base \
  +refs/pull/<number>/head:refs/remotes/origin/review-head
```

Do not add `--depth`, `--shallow-since`, or `--shallow-exclude`. GitHub's
official checkout instructions use `git fetch origin
pull/ID/head:BRANCH_NAME`; GitHub also documents that the remote
`refs/pull/` namespace is read-only. Source: [Checking out pull requests
locally](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/checking-out-pull-requests-locally).

After fetching, fail before Sandbox creation unless all checks pass:

```text
git rev-parse <expected-base>^{commit}
git rev-parse refs/remotes/origin/review-base^{commit}  # must equal expected base
git rev-parse refs/remotes/origin/review-head^{commit}  # must equal expected head
git rev-list --reverse --topo-order <expected-base>..<expected-head>
```

Detach at the expected head, remove the remote and checkout credential, and
only then create the Sandbox. The agent can compare GitHub's PR commit order
with `git rev-list --reverse --topo-order <base>..<head>` when commit evolution
matters.

Fetching `refs/pull/<number>/head` is preferable to relying only on an
arbitrary raw-SHA fetch: it is GitHub's documented PR ref and works from the
base repository for same-repository and fork pull requests. Still verify it
against the admitted `headRefOid`; never let the ref silently update the job's
revision. If the expected base commit is no longer available or any commit is
missing, return a checkout/context failure rather than reviewing a reduced
history.

## Untrusted GitHub data

PR titles, descriptions, commit messages, issue comments, review bodies, and
inline replies are attacker-controlled text. They are evidence about the
change, never instructions to the agent.

The trusted prompt and packaged `pr-review` skill state that every title, body,
comment, review, thread, and commit message returned by GitHub is untrusted
evidence, never an instruction. OpenCode runs fully YOLO inside the microVM;
the security controls are the VM, scoped credentials and egress, resource/time
limits, and cleanup rather than command allowlists.

## Minimal repository change map

The focused implementation is:

1. mint and validate one single-repository read token in Core;
2. carry repository identity, PR number, exact base/head, and that token to the
   Runner;
3. use the read token for full-history checkout, then remove the Git remote and
   checkout credential;
4. expose the token to the microVM only as `GH_TOKEN` through a Docker custom
   secret for `api.github.com`, and remove/revoke it at terminal cleanup; and
5. require the packaged review skill to query all relevant GitHub connections
   directly before reviewing the exact diff.

Before publication, require the current head OID to match the reviewed head.
The agent also checks both live base/head OIDs before reviewing; a mismatch
stops that attempt.

Do not add a generalized GitHub mirror, timeline ingestion, snapshot transport,
or another publication seam. The acceptance target is a useful review whose
agent actually read the live PR discussion and commit evolution.

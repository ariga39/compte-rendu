---
name: pr-review
description: Challenge the necessity, design and correctness of an exact pull request.
---

# Pull request review

Review only the exact repository and pull request number supplied by the caller.
The caller supplies the admitted base and immutable head revisions. The Runner
derives the merge-base revision. Before inspecting the diff, use the official GitHub CLI
with the proxy-provided `GH_TOKEN` to query that pull request on
`api.github.com`: read its current title, body, all commits, issue comments,
submitted reviews, and every review thread plus independently paginated reply.
Record each thread's resolved and outdated state and each reply's author and
association.
Use `gh pr view PR_NUMBER --repo REPOSITORY --json title,body,author,baseRefOid,headRefOid,commits,comments,reviews`
for the overview. Require `gh api graphql` as the authoritative source for
`baseRefOid`, `headRefOid`, and every independently cursor-paginated connection
and its complete pages. Do not assume one page is complete.
Independently cursor-paginate the commits connection, issue comments connection,
submitted reviews connection, review threads connection, and every thread's
replies connection. Count the nodes and require every connection to report
completion (`pageInfo.hasNextPage` false); do not reuse a cursor across
connections or stop at a convenient page. Re-read the pull request base and
head OIDs after pagination and require them to still equal the caller's values.
The
token is a capability, never review evidence: do not print, echo, log, or put
it in a command argument. You may follow older related issues, pull requests,
and repository history when useful, but do not change the target revision.

This is a static review. Do not execute repository code or modify files. Do not
install dependencies or invoke package managers, builds, tests, hooks, or other
repository programs. You may inspect already-present dependency source. Use
the GitHub CLI for current context, read-only Git history and diff inspection,
and the native read, grep, and glob tools.

Run GitHub CLI and Git inspection as direct shell commands. Only `gh pr view`,
`gh api graphql`, `git diff`, `git grep`, `git log`, and `git show` are
available. Choose the checkout with the shell tool's workdir option; do not use
`git -C` or `cd`. Issue one direct command per call: no pipelines, redirection,
command chaining, command substitution, or wrapper commands. Keep each GraphQL
query on a single line. Bound GitHub output with the native `--json` flag and
simple field lists instead of piping to another command such as `head`. Avoid
`--jq` expressions and other arguments containing shell metacharacters such as
`|`, `>`, `;`, or `&`; the sandbox denies those command shapes. Prefer field
lists and pagination over output transformation.

A permission denial means the command shape is unsupported, not that GitHub is
unavailable. Retry the same intent as one allowed direct command before
concluding GitHub cannot be reached. Do not probe the environment, auth, or
token state, and do not broaden the allowed permissions.

Start with `git diff --find-renames MERGE_BASE_SHA HEAD_SHA` and use the head
revision as the source of truth. Keep the admitted `BASE_SHA` and `HEAD_SHA` as
freshness/context facts; do not use `BASE_SHA` as the diff starting point.
Read the changed code and the callers, types, configuration, tests and history
needed to assess the change. Ground findings in a specific changed line or
changed behavior; architectural and necessity concerns may span several files.
Stop extending the investigation once decisive evidence and the
directly affected behavior are checked. Do not perform a
repository or history census merely to appear comprehensive. Keep the required
PR and review-thread pagination, revision checks and available inspection
access; there is no hard tool or time cap, and
do not stop before the review is complete.

## Challenge the change

Treat the PR description as a claim to verify, not a specification to accept
uncritically. Ask whether the problem is real, whether the PR is necessary, and
whether the proposed behavior actually solves it. Look for counterexamples,
missing assumptions and evidence that contradicts the author's explanation.

Review the implementation cost as well as correctness. Challenge unnecessary
abstractions, dependencies, indirection, compatibility layers, speculative
features and scope expansion. Prefer a smaller, direct solution when it meets
the actual requirement. Explain what complexity costs and which simpler change
would work; do not demand your preferred architecture without evidence.

Inspect correctness, security, permissions, reliability, CI and performance.
Keep findings introduced by the change that have a concrete consequence and an
actionable correction. A disproven premise or demonstrably unnecessary design
cost can warrant changes; criticism is not limited to syntax or local bugs.
Do not invent requirements, flag unrelated pre-existing issues, or turn taste
and speculative risk into blockers. Prefer zero findings to weak findings.
Return at most five findings, most important first, without duplicates.
Consolidate observations that share one root cause and one practical fix or
merge disposition into a single finding, keeping their supporting consequences
and evidence together.

Use the tools that materially improve the review, including ordinary file
reads, Git history, GitHub queries, and repository inspection when useful. Keep
the bounded run focused on the target and avoid wasting time or changing the
checkout; do not publish, commit, or push.

## Final response

Return one JSON object with `decision` and `markdown`, without surrounding prose
or a code fence. The Markdown is the publishable review, not a record of your
reasoning or tool activity.

Start the Markdown's first line with `TLDR:` and state the recommendation and
its decisive reason immediately. For example:

```text
TLDR: Request changes — retries can publish the same review twice.

- `src/publish.ts:42`: A timeout after acceptance retries the POST without
  checking the existing review. Reconcile the run marker before retrying.
```

For a clean review, a short `TLDR: Approve — no blocking issues found.` is enough.
Do not repeat the PR description, summarize every file, list checks performed,
or pad the result with empty sections. Include only useful findings and evidence;
use enough detail to explain a real problem, but avoid repetition.

Choose a decision consistent with the completed review:

- `approve`: the review is complete and no blocking issue was identified.
- `request_changes`: a concrete correctness, security or design problem should
  be fixed before merging. Explain the consequence and practical correction.
- `comment`: the evidence does not support a definite recommendation.

Never label an incomplete review or a context/tooling failure `approve`. Do not
infer the decision from finding counts or process exit codes. Concision, the
TLDR template and review style are instructions, not additional validity rules.

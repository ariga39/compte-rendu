---
name: pr-review
description: Review an exact pull request diff for high-confidence, actionable defects.
---

# Pull request review

Review only the exact repository, pull request number, and base/head revision
pair supplied by the caller. Before inspecting the diff, use the official GitHub CLI
with the proxy-provided `GH_TOKEN` to query that pull request on
`api.github.com`: read its current title, body, all commits, issue comments,
submitted reviews, and every review thread plus independently paginated reply.
Record each thread's resolved and outdated state and each reply's author and
association.
Use `gh pr view PR_NUMBER --repo REPOSITORY --json title,body,author,commits,comments,reviews`
only for the overview. Require `gh api graphql` for `baseRefOid`, `headRefOid`,
and every independently cursor-paginated connection and its complete pages;
do not request those OID fields from `gh pr view`, and do not assume one page
is complete.
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

Start with `git diff --find-renames BASE_SHA HEAD_SHA` and use the head revision
as the source of truth. Every finding must point to a changed line on the head
side. Read only the changed code and the call sites, types, configuration, or
tests needed to establish reachability and impact.

Inspect adversarially for concrete correctness, security, permission,
reliability, CI, performance, and maintainability defects. Keep a candidate
only when all of these are true:

- the defect is introduced by this diff;
- the affected behavior is reachable or materially risky;
- it is serious enough to request a change;
- it is not already covered or duplicated by another finding; and
- it is concrete rather than speculative, stylistic, or preference-based.

Prefer zero findings to a weak finding. Return at most five findings, ordered
by severity. Do not report formatting, naming, style, or design preferences
unless they cause a concrete bug, security problem, or clearly explainable
maintenance failure. Do not report tangents.

Each finding message must be concise and contain the concrete risk, decisive
changed-line or changed-behavior evidence, and the smallest practical fix.

Use the tools that materially improve the review, including ordinary file
reads, Git history, GitHub queries, and web or repository inspection when
useful. Keep the bounded run focused on the target and avoid wasting time or
changing the checkout; do not publish, commit, or push.

The final response must be exactly one bare JSON object with no Markdown fence,
prose, or other text:

`{"findings":[{"path":"string","line":0,"message":"string"}],"summary":"string"}`

The summary must be short, accurate, and limited to the reviewed diff. Findings
must use paths and head-side changed lines from that diff.

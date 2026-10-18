# Explicit review decisions

Status: implementation design, 2026-10-18. Production activation requires the rollout below.

## Product behavior

Each completed review should state whether the reviewed revision is ready to
merge, needs changes, or receives feedback without a merge recommendation.
The same decision must appear in the GitHub Review and the dashboard.

| Decision        | GitHub event      | Meaning                                                                                                                              |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Approve         | `APPROVE`         | The reviewed change has no identified blocking defect. Non-blocking suggestions may remain.                                          |
| Request changes | `REQUEST_CHANGES` | At least one concrete, actionable defect should be fixed before merging. The review explains its impact and the required correction. |
| Comment         | `COMMENT`         | Feedback without approval or a request to block merging; for example, insufficient context for a definite recommendation.            |

The model makes an explicit decision. Do not infer it from a finding count,
Markdown keywords, a successful process exit, or a numerical confidence score.
Style preferences and speculative risks do not justify Request changes.
Approve describes the static review's conclusion; it does not assert that tests
ran or that GitHub permits merging.

Execution failures, invalid output, incomplete required evidence, and failed
cleanup retain the existing failure path. They never become Request changes
or an implicit Comment review. A missing or unknown decision in a new-format
result is invalid output, never approval.

## Submission and publication

Extend the existing `submit_review` tool with a required enum `decision` beside
`markdown`. Retain exactly one completed submission, the existing Markdown size
and heading rules, and normal terminal completion requirements. No second model
or prose classifier is needed.

Use the tool-output pattern documented in
[the output reliability research](review-output-reliability-research.md).
Return invalid tool arguments to the model inside the running OpenCode session.
The existing execution deadline bounds this tool loop. Allow one Runner reminder
for a missing submission after normal completion.
Rejected invalid attempts do not count as successful submissions. Multiple
successful submissions remain ambiguous and fail; never select the first or last.
Refusal, truncation and process failure publish no vote. Event JSONL is not
schema enforcement. V2 plugin registration and export-based normal completion
were verified with the pinned binary and real model probes.

### Correction belongs to the live Sandbox phase

OpenCode handles tool errors inside the live session; Runner owns the bounded
missing-submission reminder. Core and the publication callback never resume an agent.
The lifecycle is: execute review → validate submission/completion → optionally
correct in the same Sandbox and session → validate again → export final session
and evidence → destroy Sandbox and scoped resources → finalize manifest/callback
→ Core publication. Failed attempts still export available evidence and clean up.

A tool argument rejection is returned to the running agent as a tool error; it
must not persist an accepted result. A missing submission discovered after normal
CLI exit can use one awaited `runtime.exec` with the exact same session ID, inside
the still-live Sandbox. CLI exit is not Sandbox destruction. Both paths share the original execution deadline. Only the missing-submission
reminder starts another CLI invocation; argument corrections stay in OpenCode. V2 tool-error feedback is now verified with a real binary and scripted provider.
The tool loop has no automatic one-correction bound; use the existing job deadline
instead of adding a second retry controller.

No detached correction task, new Sandbox, second review, or post-cleanup retry is
allowed. Abort, exhausted budget, ambiguous session identity or multiple accepted
results skip correction. Archival starts after correction settles and includes
both attempts; cleanup remains unconditional even when correction or export fails.
Later evidence/publication validation can reject a result but cannot reopen it.

Behavior tests must prove correction executes while the original Sandbox is live,
uses the original session, is included in the exported evidence, and finishes
before destruction. Also cover correction timeout/abort/invalid output leading
to cleanup and no vote, and exhaustion of the shared execution deadline.

Carry the decision through the Runner result, terminal callback, durable
evidence, Core validation, and persisted run outcome. Preserve the Markdown
artifact and retain `{version: 2, decision, markdown}` in `manifest.result`
only for a validated successful result. Core must validate their agreement before publication; an unauthenticated
or inconsistent decision cannot authorize a GitHub vote.

Core remains the sole publisher. Its existing publication claim and run marker
still provide duplicate suppression. The result supplies only the bounded
decision and Markdown, never the repository, PR, commit, API URL, or publisher.
Core derives those from the admitted run and rechecks the current head before
publishing against the immutable reviewed SHA.

Publication confirmation must include the GitHub review ID, author, commit SHA,
and returned review state, not just a matching marker in a body. Apply the same
checks when recovering a lost publication response. Expected submitted states
are `APPROVED`, `CHANGES_REQUESTED`, and `COMMENTED`. A pending review or a
different author's copied marker cannot prove publication. If a previously
published vote has subsequently been dismissed, accept `DISMISSED` as evidence
of prior publication and do not create a duplicate vote to undo the dismissal.
The dashboard records the original decision, not its current GitHub vote state.

GitHub rejection or an ambiguous publication response must not silently downgrade
Approve or Request changes to Comment. Retain the intended decision and report
the existing publication failure/uncertainty state.

## Lifecycle and UI

Keep execution/publication status separate from the review decision. A successfully
published Request changes review is a completed task, not a failed model run.
The Check continues to describe whether the review was delivered; its title and
summary should also state the decision. Repository review requirements govern
merge approval. This feature does not change branch protection or auto-merge.

The dashboard should show a Decision column/badge with the exact labels above,
and show the same field in the detail drawer and Help. Keep Status for Queued,
In progress, Published, Failed, and Superseded. Pending and historical unknown decisions display an em dash. A separate decision
filter is outside this slice.
Public APIs remain DB-only and retain the existing private-repository redaction.
Do not expose finding text or repository identity through the new field.

Historical runs have no recorded decision. Leave them unknown; do not classify
their Markdown or backfill them as approvals. Do not label Comment as Approved.

## Revisions and rollout

A later revision receives a fresh review with its own decision. The service does
not automatically dismiss earlier reviews, revoke another reviewer's vote, or
modify repository rules. A new Comment must not be presented as clearing a
previous Request changes vote. GitHub remains authoritative for current merge
eligibility and stale-approval rules. Head checks narrow the publication race;
they cannot make a GitHub read and subsequent review POST atomic.

Deploy Core/contracts support before restarting upgraded Runners. Existing
in-flight legacy results retain their COMMENT behavior and do not acquire a
decision retroactively. New-format results require a decision. Drain before
changing a Runner's result format. Historical records and existing evidence must
remain readable. No general plugin, policy engine, or per-repository voting
framework is needed for this feature.

## Acceptance through existing public seams

- A valid tool submission produces the same decision in terminal result,
  evidence, authenticated Core callback, GitHub payload, and dashboard detail.
- Each decision maps to its exact GitHub event and reviewed commit.
- Missing/invalid/duplicate submissions and contradictory evidence do not vote.
- A changed head is superseded without publishing a stale approval.
- Duplicate callbacks and a lost successful response create one review; marker
  recovery cannot accept another author, commit, or decision.
- A published Request changes run completes successfully while displaying its
  decision; runtime failure publishes no vote.
- Legacy callbacks retain Comment behavior; historical rows remain unknown.
- Exercise Request changes followed by a fixed revision's Approve on a dedicated
  test PR, retaining actual GitHub review states. Test repository protection
  separately before claiming either vote blocks or permits merging.

## First-party references

- [GitHub review decisions](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews)
- [Create a pull request review](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request): `event`, `commit_id`, and pending/submitted semantics.
- [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches): required approvals, stale approvals, dismissals, and bypasses.

Current implementation anchors: `apps/runner/tools/submit_review.js`,
`packages/contracts/src/index.ts`, `apps/core/src/review-publication-format.ts`,
and `apps/core/src/github-review-adapter.ts`. Legacy Markdown-only callbacks
retain COMMENT publication; new structured results use the explicit decision
and verify publication identity and state.

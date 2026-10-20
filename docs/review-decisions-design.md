# Explicit review decisions

Current result and publication contract. See [architecture](design.md) for the
job lifecycle and [operations](operations.md) for release procedures.

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

## Final output and publication

OpenCode returns one final assistant JSON object containing `decision` and
`markdown`. No custom submission tool is required. Runner validates the shared
structural contract: a known decision, non-empty Markdown and the size bound.
It also verifies the exact session and authoritative normal completion. The
final Markdown is preserved unchanged for Core publication.

One prompt serves every roster size, including a single configured model. It
asks for concise adversarial review: challenge the PR's claimed need, verify its
premises and consequences, and consider smaller, lighter implementations. The
first Markdown line should be `TLDR:` followed by the conclusion. These are
prompt instructions only; style or heading differences do not fail a review.

### Correction belongs to the live Sandbox phase

A normally completed session with missing or malformed final JSON can receive
one correction using its existing analysis and the same session, model, agent
and execution deadline. This applies to both one-model and multi-model jobs.
Core and the callback never resume an agent. The lifecycle is: execute review →
validate final output/completion → optionally correct in the same live Sandbox
and session → validate again → export evidence → destroy Sandbox and scoped
resources → finalize manifest/callback → Core publication.

No detached correction, new Sandbox, second review, or post-cleanup retry is
allowed. Abort, exhausted budget, truncation or ambiguous session identity skip
correction. Failed attempts still preserve evidence and clean up. An unresolved
invalid result publishes no vote. Event JSONL formatting alone does not enforce
a result schema; do not describe this explicit validation/correction path as an
OpenCode-native schema guarantee.

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
The Check continues to describe whether the review was delivered; its title states the decision and its summary confirms delivery. Repository review requirements govern
merge approval. This feature does not change branch protection or auto-merge.

The dashboard shows a Decision column with the exact labels above,
and the same field in the detail drawer and Help. Keep Status for Queued,
In progress, Published, Failed, and Superseded. Pending and historical unknown decisions display an em dash. A decision filter is not implemented.
Public APIs remain DB-only and retain the existing private-repository redaction.
Do not expose finding text or repository identity through the new field.

Historical runs have no recorded decision. Leave them unknown; do not classify
their Markdown or backfill them as approvals. Do not label Comment as Approved.

## Revisions and rollout

A newly scheduled round attempts to dismiss this installation's earlier `APPROVED` and
`CHANGES_REQUESTED` GitHub reviews on the same PR. Core checks again before handing
the job to a Runner, including when admission and claim overlap. A replay that
creates no new run does not reset the current round's conclusion.

Candidates must belong to a database run earlier than this round, match its
installation/repository/PR, carry the exact run marker, and be authored by the
configured GitHub App bot. Listing must finish within the existing pagination
bound and the current head must match. The reset never dismisses a later run,
another author/App, or an unrecognized review. Comments and dismissed reviews are
left alone. GitHub review bodies/discussion and the original decisions stored in
D1 remain historical records; this changes the effective GitHub vote, not history.

A dismissal is confirmed by exact review ID, author, body, commit and `DISMISSED`
state. If a request response is lost or another reset already succeeded, Core
reads that exact review to confirm. An eager reset failure is logged and retried on claim; it cannot overwrite a
Runner that has already confirmed the reset. If claim-time confirmation fails,
the round records `review_reset_failed` and is not delivered to a Runner; the GitHub Check fails rather than
claiming the old vote was cleared. A partial failure does not restore votes already
dismissed. Correct permission/service issues, then request `/ai-review` to retry.

The App needs Pull requests write permission. Protected-branch dismissal policies
may impose additional restrictions; the service does not change those policies
or revoke another reviewer's vote. GitHub remains authoritative for merge
eligibility. Head checks narrow races; they cannot make a GitHub read and subsequent
mutation atomic. If the new round fails after reset, the old vote stays dismissed;
failure never restores an earlier approval or Request changes.

Deploy Core/contracts support before restarting upgraded Runners. Existing
in-flight legacy results retain their COMMENT behavior and do not acquire a
decision retroactively. New-format results require a decision. Drain before
changing a Runner's result format. Historical records and existing evidence must
remain readable. No general plugin, policy engine, or per-repository voting
framework is needed for this feature.

## Acceptance through existing public seams

- A valid final assistant result produces the same decision in terminal result,
  evidence, authenticated Core callback, GitHub payload, and dashboard detail.
- Each decision maps to its exact GitHub event and reviewed commit.
- Missing/invalid final results and contradictory evidence do not vote.
- A changed head is superseded without publishing a stale approval.
- Duplicate callbacks and a lost successful response create one review; marker
  recovery cannot accept another author, commit, or decision.
- A published Request changes run completes successfully while displaying its
  decision; runtime failure publishes no vote.
- Legacy callbacks retain Comment behavior; historical rows remain unknown.
- Tests establish decision mapping/publication, not repository branch protection.
  Validate protection on the target repository before claiming a vote blocks or
  permits merging.

## First-party references

- [GitHub review decisions](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews)
- [Create a pull request review](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request): `event`, `commit_id`, and pending/submitted semantics.
- [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches): required approvals, stale approvals, dismissals, and bypasses.

- [GitHub review dismissal API and permissions](https://docs.github.com/en/rest/pulls/reviews#dismiss-a-review-for-a-pull-request)

Current implementation anchors: `apps/runner/src/review-prompt.ts`,
`packages/contracts/src/index.ts`, `apps/core/src/review-publication-format.ts`,
and `apps/core/src/github-review-adapter.ts`. Legacy Markdown-only callbacks
retain COMMENT publication; new structured results use the explicit decision
and verify publication identity and state.

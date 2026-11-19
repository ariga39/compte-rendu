# Dashboard sign-in and review cancellation

**Proposed for approval.** Give an authorized operator a reliable way to stop a review before increasing the shared review budget from 30 to 60 minutes. The budget applies to automatically triggered and manually requested reviews, whether anyone has the dashboard open or not.

## What an operator sees

The shared header offers **Sign in with GitHub** on Overview, History, Help, Settings and job details. After sign-in it shows the account and **Sign out**. Return to the page that initiated sign-in, including a job permalink or supported list filters. Keep the return target in the state-bound OAuth flow and accept only local dashboard routes; fall back to Overview. Sign-out is a same-origin POST.

Anyone may still read the public dashboard. Signing in establishes identity. The existing per-instance numeric GitHub UID allowlist grants both editing model settings and cancelling runs. Retain its current configuration key for deployment compatibility and document the expanded authority. A signed-in account outside the list sees its account and sign-out, without operator controls. Reuse each instance’s GitHub App, encrypted host-only session, PKCE, state and expiry. Do not add a second login, new GitHub permission or 2FA check.

Keep public SSR, hydration and public API responses independent of personal state. The header gets viewer state from a private, no-store session endpoint after hydration. Anonymous requests without a session cookie require no GitHub lookup. A GitHub outage must leave public browsing usable. On protected operations, the server resolves the GitHub user and checks the current allowlist again; a displayed button grants no authority. Logging out clears private client state.

A cancellable run shows **Cancel review** in its detail page and drawer. Confirmation identifies that run and explains that it will publish no review. Keep keyboard focus in the confirmation and return it to the detail view afterwards. Show **Cancelling** after acceptance, **Cancelled** when execution has stopped and cleanup is confirmed. Explain cleanup failure separately if intervention is needed. A refresh, closed tab or expired login after acceptance does not interrupt cancellation. History, filters, overview counts and the GitHub Check distinguish manual cancellation from failure and supersession. Preserve the existing privacy projection, including on private-repository rows. The operator's UID stays in the private audit record.

## One owner for cancellation and publication

Expose a same-origin authenticated `POST /api/jobs/:runId/cancel`. The public run ID identifies one immutable attempt. Core resolves its exact Runner job ID and attempt from D1; clients never supply a Runner ID. A session is required (401); a disallowed UID or wrong origin gets 403. Return 404 for an unknown run after authorization. Repeated requests return the current cancellation state without duplicating side effects.

| State when Core receives the request | Outcome |
| --- | --- |
| Queued, no Runner claim | Atomically finish as cancelled (200). A racing claim cannot take it. There is no Sandbox to clean up. |
| Claimed, publication unclaimed | Persist cancellation intent, requester UID and timestamp (202). Prevent new grants and publication for this attempt, and dispatch the stop to Runner. |
| Cancellation already pending or complete | Return 202 or 200 respectively. The job page can resume polling by run ID. |
| Publication already claimed, or any other terminal state | Return 409 and refresh the detail. An existing GitHub review is never withdrawn by this action. |

The D1 conditional write for cancellation and the existing publication claim must exclude one another. A successful agent result alone does not win publication. After cancellation wins, a late success callback may record usage, evidence and cleanup for its exact attempt but cannot publish a review, change the verdict or turn cancellation into failure. Automatic supersession, retries and late callbacks must preserve the winning disposition. A new review of the same PR waits for confirmed cleanup of the previous Runner claim. No cancellation can target the replacement run.

Store intent durably and add a distinct cancelled terminal disposition. Update D1 constraints, claim and recovery queries, contracts and in-memory store together. Enforce the cancellation guard on check setup as well: if a Check is created in flight, reconcile its ID and end it with GitHub conclusion `cancelled` and manual-cancellation wording. The existing cancelled Check message specifically says a newer revision replaced the run. Keep previously dismissed reviews dismissed, and publish neither a failure comment nor an approval/change request for a cancelled run.

Reuse Runner’s authenticated `DELETE /jobs/:id` abort, grant revocation, Sandbox destruction and terminal callback. It can wait for teardown, so persist intent first and issue the stop independently of the browser response. Use the existing Worker scheduled path to retry a bounded set of outstanding stops and GitHub Check updates after delivery failures or Worker restarts. A Runner 404 can also mean the claim is in transit: retain the stop request. Handle the claim-to-admission race and check pending cancellation before authorizing inference. An in-flight grant must still be revoked during cleanup. A matching callback or verified Runner terminal response can confirm teardown even if execution finished just before DELETE arrived. A lost response, a killed CLI client, or an unconfirmed Sandbox never counts as destruction. Keep unresolved cleanup visible and the same-PR guard in force through recovery. Preserve model usage incurred before cancellation.

## One hour of review time

Increase the existing shared `REVIEW_ATTEMPT_BUDGET_MS` once cancellation works on both installations. Independent reviewers, synthesis and any existing correction share one budget. Queue time is separate; setup, finalization, callback and cleanup keep their own existing bounds. Report timeout as timeout and manual cancellation as cancellation. The browser session and job clocks are independent.

The relay grant TTL already uses four times the budget and therefore becomes four hours; normal completion or cancellation revokes it sooner. OpenSandbox requests the same four-times lifetime; update its documented two-hour server maximum before enabling the new setting there. Check the separate admission/setup deadline, transport deadlines and GitHub read installation token expiry against a late GitHub read in an hour-long attempt. Core currently receives the token expiry but sends Runner only the token. If a supported path loses access near the deadline, resolve that credential dependency before rollout. Keep cleanup reserves and publication credentials independent of the agent budget.

## Delivery and acceptance

1. **Shared sign-in.** Extract the existing authentication path, add header and private viewer state, preserve Settings authorization. Test anonymous SSR with GitHub unavailable, an allowed and disallowed user, direct job return, logout, expired sessions and rejected external return targets.
2. **Durable job control.** Implement the operator endpoint, state transitions, stop delivery and Check reconciliation. Exercise queued cancellation against claim, claimed cancellation against publication, retries after a dropped response, cleanup recovery, late success and a subsequent retry of the same PR. Verify exactly one outcome and no published review when cancellation wins.
3. **Operator controls.** Add confirmation, pending/terminal states and history in the detail views. Test both drawer and permalink, including reload while cancelling and an unauthorized direct POST. Verify an actual disposable review stops, its grant becomes unusable, its Sandbox is destroyed and its GitHub Check says cancelled.
4. **Increase the budget.** Deploy this last. With controlled clocks verify a review can continue past 30 minutes and reaches timeout at the new boundary without resetting the budget. Check the actual runtime and credential limits, rollout documentation and rollback to 30 minutes. Drain Runners for binary replacement so running attempts finish under the version that admitted them.

Each step gets a separately reviewable PR. Approving this document authorizes implementation; runtime and production changes follow their own review and rollout.

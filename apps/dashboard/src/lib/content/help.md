# Help

How to read this dashboard. It is read-only and reflects persisted review state; nothing here starts, stops, or changes a review.

## On this page

- [Overview counts](#overview-counts)
- [Current work](#current-work)
- [Cleanup attention](#cleanup-attention)
- [Finding and paging through history](#finding-and-paging-through-history)
- [Task detail and stages](#task-detail-and-stages)
- [Published, Failed and Superseded](#published-failed-and-superseded)
- [Timestamps and older records](#timestamps-and-older-records)
- [Updates and refresh](#updates-and-refresh)
- [Public task identity](#public-task-identity)
- [GitHub Check link](#github-check-link)

## Overview counts

- **Queued**: waiting to be claimed.
- **Claimed**: accepted and taken by a worker, including preparation and archiving. It is not a count of model calls.
- **Published** and **Failed** count work received (created) in the last 24 hours that ended with that outcome, not terminal events that occurred in the last 24 hours.

Queued and Claimed describe the current database state.

## Current work

Claimed work is listed first, then queued work oldest first. A claimed row is an observation from persisted state, not a live process. For claimed work, the page shows the last progress report or notes that none has arrived yet.

## Cleanup attention

The review outcome and cleanup result are separate facts. A failed or superseded review can still complete cleanup afterwards, and cleanup that failed needs attention on its own.

- **Cleanup needs attention** lists only failed cleanup, or terminal work whose cleanup is still pending. Cleanup that is pending while a review is still running is normal and is not shown as attention.
- **Destroyed** means cleanup completion was confirmed.
- **Failed** cleanup needs an operator to resolve.
- **Unknown** means cleanup was not recorded, which is expected for some older records.

## Finding and paging through history

- **View**: all history, current work, or cleanup attention.
- **Outcome**: all, active, published, failed, or superseded.
- **Cleanup**: all, pending, destroyed, failed, or unknown.
- **From** and **To** are dates in **UTC** and each includes the whole selected day.
- Choose your filters, then select **Apply filters**.
- **Older runs** loads the next page and **Back to latest** returns to the newest page.
- Select a task to open its detail page.

Filters stay in the address, so a filtered view can be shared or reloaded. Changing a filter returns to the latest page, older pages keep the same position, and a row can leave an active-only filter after it completes.

## Task detail and stages

A task page shows the stages that were recorded, in order:

- **Checkout**: fetch the code for the revision.
- **Preparing sandbox**: set up the isolated environment.
- **Reviewing**: the review agent runs.
- **Archiving evidence**: store the run's evidence.
- **Cleaning up**: remove the environment and its resources.
- **Result received** and **Publishing**: the result is processed and then published.

Stages that never ran are skipped. Where a value was not recorded it is shown as not recorded rather than estimated.

## Published, Failed and Superseded

- **Published**: the review was recorded as published.
- **Failed**: the review did not complete; a short failure category is shown when it was recorded.
- **Superseded**: a newer revision replaced this review before publication. A superseded run keeps its own page and history.

## Timestamps and older records

Times are observations from persisted state, not exact live measurements. Older records may have gaps because some steps were not recorded at the time; those gaps are shown as not recorded and are not filled in later.

## Updates and refresh

- While work is active, the page refreshes about every **15 seconds**.
- When nothing is active, it refreshes about every **60 seconds**.
- After errors it waits longer before retrying.
- Automatic refresh pauses while the tab is hidden or the device is offline, and resumes on return.
- A manual refresh is always available.

The data comes from stored review state and is read-only. A refresh updates the page without changing any review.

## Public task identity

A task from a repository confirmed public shows its repository and pull request. A private, unverified, or expired identity is shown anonymously as **Protected task**, with no repository details. Public identity is time-limited and may become anonymous again.

## GitHub Check link

A review Check on GitHub can show a Details link to its task page when that link is available. Older checks may not have one. A link always points to the same durable task.

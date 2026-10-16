# Help

How to read this dashboard. It is read-only and reflects the latest recorded review state; nothing here starts, stops, or changes a review.

## On this page

- [Overview counts](#overview-counts)
- [Current reviews](#current-reviews)
- [Cleanup attention](#cleanup-attention)
- [Finding and paging through history](#finding-and-paging-through-history)
- [Review details](#review-details)
- [Published, Failed and Superseded](#published-failed-and-superseded)
- [Timestamps and older records](#timestamps-and-older-records)
- [Updates and refresh](#updates-and-refresh)
- [Anonymous reviews](#anonymous-reviews)
- [GitHub Check link](#github-check-link)

## Overview counts

- **Queued**: waiting to start.
- **In progress**: accepted for processing. This includes preparation, progress reports, and publication. It is not a count of model calls and does not prove a process is currently alive.
- **Published** and **Failed** count reviews received in the past 24 hours that ended that way.

## Current reviews

In-progress reviews are listed first, then queued reviews oldest first. A row shows **Awaiting first update** until the first progress report arrives, then **Last progress update** with the most recent report.

## Cleanup attention

This section lists reviews with failed cleanup, or cleanup still pending after the review ended. A review whose cleanup was not recorded is not counted here. Cleanup follows the review and is not an error.

- **Cleanup after review**: normal while a review is in progress. Cleanup is confirmed after the review ends.
- **Cleaning up**: resource cleanup has started; confirmation is pending.
- **Cleanup pending**: the review has ended, but cleanup has not been confirmed.
- **Cleaned up**: cleanup was confirmed.
- **Cleanup failed**: cleanup failed and needs an operator.
- **Cleanup not recorded**: cleanup was not recorded, which is expected for some older reviews.

## Finding and paging through history

- **View**: all history, current reviews, or cleanup attention.
- **Outcome**: all, **queued or in progress**, published, failed, or superseded.
- **Cleanup**: all, pending, cleaned up, failed, or not recorded.
- **From (UTC)** and **To (UTC)** are dates in UTC and each includes the whole selected day.
- Choose your filters, then select **Apply filters**. A changed date does not apply until you select it.
- **Older runs** loads the next page and **Back to latest** returns to the newest page.
- Select a review to open its details.

Reviews are listed newest first, and filters stay in the page address so a filtered view can be shared or reloaded. Changing a filter returns to the latest page. Older pages keep the same position, and a review can leave a queued-or-in-progress filter after it ends.

## Review details

- **Received**, **Accepted**, and **Finished** are the recorded times for the review.
- **Time in queue** and **Total time** are shown when both endpoints were recorded.
- **Last progress update** is the most recent progress report, when there is one.
- **Status** summarises the review. **Timeline** lists the stages that were recorded, in order, using the latest reported stage.
- **Execution details** are recorded observations: **Execution started**, **Result processing observed**, and **Cleanup attempt finished**. A recorded observation does not guarantee a successful outcome.

Stages that never ran are skipped. Missing history is shown as not recorded and is not filled in later.

## Published, Failed and Superseded

- **Published**: the review was published to GitHub. This does not mean no findings were made.
- **Failed**: the review ended with an error; the phase and reason are shown when they were recorded.
- **Superseded**: a newer revision replaced this review before publication. A superseded review keeps its own page.

## Timestamps and older records

Times are the latest recorded observations, not live guarantees. Older reviews may have gaps because some steps were not recorded at the time; those gaps are shown as not recorded.

## Updates and refresh

- On **Overview**, **History**, and review detail pages, data refreshes automatically: about every **15 seconds** while work is active, and about every **60 seconds** when nothing is active.
- After errors it waits longer before retrying.
- Automatic refresh pauses while the tab is hidden or the device is offline, and resumes on return.
- **Refresh now** is available on **Overview** and **History**.
- **Help** is a static page and does not refresh.

**Last updated** on Overview and History is the time of the last successful data refresh. The data comes from stored review state and is read-only.

## Anonymous reviews

A review from a repository confirmed public shows its repository and pull request. A private repository, or one whose visibility has not been verified, is shown as **Anonymous review** with no repository details. This does not guarantee the repository is private. Public identity is time-limited and may become anonymous again.

## GitHub Check link

A review Check on GitHub can show a Details link to its review page when that link is available. Older checks may not have one. A link always points to the same review.

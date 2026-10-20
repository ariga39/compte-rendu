# Help

How to read this dashboard. It is read-only and reflects the latest recorded review state; nothing here starts, stops, or changes a review.

## On this page

- [Overview counts](#overview-counts)
- [Current reviews](#current-reviews)
- [Technical details](#technical-details)
- [Finding and paging through history](#finding-and-paging-through-history)
- [Review details](#review-details)
- [Review decisions](#review-decisions)
- [Published, Failed and Superseded](#published-failed-and-superseded)
- [Timestamps and older records](#timestamps-and-older-records)
- [Updates and refresh](#updates-and-refresh)
- [Anonymous reviews](#anonymous-reviews)
- [GitHub Check link](#github-check-link)

## Overview counts

- **Queued**: waiting to start.
- **In progress**: assigned to a runner and preparing, reviewing, or publishing. This is not a count of model calls and does not prove a process is currently alive.
- **Published** and **Failed** count reviews received in the past 24 hours that ended that way.

## Current reviews

In-progress reviews are listed first, then queued reviews oldest first. A row shows **Awaiting first update** until the first progress report arrives, then **Last progress update** with the most recent report.

## Technical details

Cleanup follows the review and is not an error. Cleanup is shown on a review's page under **Technical details**, collapsed by default.

- **Cleanup after review**: normal while a review is in progress. Cleanup is confirmed after the review ends.
- **Cleaning up**: resource cleanup has started; confirmation is pending.
- **Cleanup pending**: the review has ended, but cleanup has not been confirmed.
- **Cleaned up**: cleanup was confirmed.
- **Cleanup failed**: cleanup failed and needs an operator.
- **Cleanup not recorded**: cleanup was not recorded, which is expected for some older reviews.

## Finding and paging through history

- **Status**: all, queued, in progress, published, failed, or superseded.
- **From (UTC)** and **To (UTC)** are dates in UTC and each includes the whole selected day.
- Choose your filters, then select **Apply filters**. A changed date does not apply until you select it.
- **Older runs** loads the next page and **Back to latest** returns to the newest page.
- Select a review to open its details beside the list, so you can keep browsing and switch reviews. **Open full page** opens the review's own shareable address. On a narrow screen the details fill the screen with **Previous** and **Next** to switch quickly. Use your browser Back button or **Close** to return to the list; the list keeps its filters, page and position.

Reviews are listed newest first, and filters stay in the page address so a filtered view can be shared or reloaded. Changing a filter returns to the latest page. Older pages keep the same position, and a review can leave a status filter after it ends.

## Review details

- **Received**, **Assigned**, and **Finished** are the recorded times for the review. Assigned means a runner took the review; it is not the start of execution.
- **Time in queue** and **Total time** are shown when both endpoints were recorded.
- **Last progress update** is the most recent progress report, when there is one.
- **Decision** is the review's conclusion: **Approve**, **Request changes**, or **Comment**, explained below.
- **Status** summarises the review. **Timeline** lists the stages that were recorded, in order: **Fetching code**, **Preparing environment**, **Reviewing**, **Saving run records**, and **Finishing up**, followed by **Result received** and **Publishing** for result processing.
- **Revision** shows **Source branch** and **Target branch** (the reviewed head branch and its target base branch), then the **Reviewed commit** and **Base commit** SHAs. Branch names are shown only for a confirmed-public review, are captured when the review is admitted, and say **Not recorded** when they were not captured — they are never looked up or guessed later.
- **Technical details** (collapsed by default) contains the runner observations — **Runner execution started**, **Result checks started**, and **Cleanup attempt finished** — and the cleanup result. A recorded observation does not guarantee a successful outcome.

Stages that never ran are skipped. Missing history is shown as not recorded and is not filled in later.

## Review decisions

A published review records one decision:

- **Approve**: the review found no blocking defect. Non-blocking suggestions may remain.
- **Request changes**: at least one concrete defect should be fixed before merging.
- **Comment**: feedback without approval or a request to block merging.

The decision is the review's original conclusion at the time it ran, not current merge eligibility. Repository rules and the pull request's own review state decide whether merging is allowed, and a decision can be out of date after a newer revision. A failed review publishes no vote, so its decision shows an em dash. Historical reviews that predate decisions also have no recorded decision and show an em dash; they are never labelled as approvals.

## Published, Failed and Superseded

- **Published**: the review was published to GitHub.
- **Failed**: the review did not finish successfully; the phase and reason are shown when they were recorded.
- **Superseded**: a newer revision replaced this review before publication. A superseded review keeps its own page.

## Timestamps and older records

Absolute timestamps are shown in UTC.

Times are the latest recorded observations, not live guarantees. Older reviews may have gaps because some steps were not recorded at the time; those gaps are shown as not recorded.

## Updates and refresh

- On **Overview**, **History**, and review detail pages, data refreshes automatically: about every **15 seconds** while work is active, and about every **60 seconds** when nothing is active.
- After errors it waits longer before retrying.
- Automatic refresh pauses while the tab is hidden or the device is offline, and resumes on return.
- **Refresh now** is available on **Overview**, **History**, and review detail pages.
- **Help** is a static page and does not refresh.

**Last updated** is the time of the last successful data refresh for the page you are viewing. The data comes from stored review state and is read-only.

## Anonymous reviews

A review from a repository confirmed public shows its repository, pull request, branch names and commits. A private repository, or one whose visibility has not been verified, is shown as **Anonymous review** with no repository, branch or commit details. This does not guarantee the repository is private. Public identity is time-limited and may become anonymous again.

## GitHub Check link

A review Check on GitHub can show a Details link to its review page when that link is available. Older checks may not have one. A link always points to the same review.

## Models and tokens

The **Models and tokens** section follows **Timing** in review details. Model names
are shown without the provider prefix. Expand a model to see its token and request
counts.
A route is the configured model alias. The reported model name can differ from
that alias; if the service did not report a name, it is shown as unknown.

- **Input total** includes cached input. **Uncached input** is input total minus cache reads.
- **Cache read** is reused input; **Cache write** is input stored in the cache, when reported.
- **Output total** includes **Reasoning** tokens when the provider reports that breakdown.

These breakdowns overlap; do not add every row together. A partial count says how
many requests reported it. **Not reported** is different from zero. Failed or
interrupted reviews can still have recorded usage. Older reviews and reviews that
bypass the model service show no usage; this does not mean they consumed no tokens.
Statistics appear after execution ends. No monetary cost is estimated.

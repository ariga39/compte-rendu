<script lang="ts">
  const sections = [
    ['overview-counts', 'Overview counts'],
    ['current-work', 'Current work'],
    ['cleanup-attention', 'Cleanup and outcomes'],
    ['history-filters', 'Finding and paging through history'],
    ['task-detail', 'Task detail and stages'],
    ['lifecycle-outcomes', 'Published, Failed and Superseded'],
    ['timestamps', 'Timestamps and older records'],
    ['updates', 'Updates and refresh'],
    ['public-identity', 'Public task identity'],
    ['github-check', 'GitHub Check link'],
  ] as const;

  const sectionClass = 'mt-9 max-w-[860px] scroll-mt-6';
  const headingClass = 'mb-3 text-xl font-bold';
  const bodyClass = 'break-words text-muted-ink';
  const listClass = 'mt-3 list-disc break-words pl-5 text-muted-ink';
</script>

<svelte:head>
  <title>Help | Compte rendu</title>
</svelte:head>

<section class="mb-7 max-w-[760px]">
  <span class="text-xs font-extrabold uppercase tracking-[0.16em] text-accent">Guide</span>
  <h1 class="my-1.5 mb-4 text-[clamp(1.6rem,3.2vw,2.35rem)] font-extrabold leading-tight tracking-[-0.03em]">
    Help
  </h1>
  <p class="text-muted-ink">
    How to read this dashboard. It is read-only and reflects persisted review state; nothing here starts, stops, or changes a review.
  </p>
</section>

<nav aria-label="On this page" class="my-6 max-w-[860px] rounded-[14px] border border-line bg-panel p-[18px]">
  <h2 class="mb-2 text-base font-bold">On this page</h2>
  <ul class="grid list-disc break-words pl-5 text-accent sm:grid-cols-2">
    {#each sections as [id, label] (id)}
      <li><a href={`#${id}`}>{label}</a></li>
    {/each}
  </ul>
</nav>

<section id="overview-counts" class={sectionClass}>
  <h2 class={headingClass}>Overview counts</h2>
  <ul class={listClass}>
    <li><strong>Queued</strong>: waiting to be claimed.</li>
    <li>
      <strong>Claimed</strong>: accepted and taken by a worker, including preparation and archiving. It is not a count of model calls.
    </li>
    <li>
      <strong>Published</strong> and <strong>Failed</strong> count work received (created) in the last 24 hours that ended with that outcome, not terminal events that occurred in the last 24 hours.
    </li>
  </ul>
  <p class={`mt-3 ${bodyClass}`}>Queued and Claimed describe the current database state.</p>
</section>

<section id="current-work" class={sectionClass}>
  <h2 class={headingClass}>Current work</h2>
  <p class={bodyClass}>
    Claimed work is listed first, then queued work oldest first. A claimed row is an observation from persisted state, not a live process. For claimed work, the page shows the last progress report or notes that none has arrived yet.
  </p>
</section>

<section id="cleanup-attention" class={sectionClass}>
  <h2 class={headingClass}>Cleanup and outcomes</h2>
  <p class={bodyClass}>
    The review outcome and cleanup result are separate facts. A failed or superseded review can still complete cleanup afterwards, and cleanup that failed needs attention on its own.
  </p>
  <ul class={listClass}>
    <li>
      <strong>Cleanup needs attention</strong> lists only failed cleanup, or terminal work whose cleanup is still pending. Cleanup that is pending while a review is still running is normal and is not shown as attention.
    </li>
    <li><strong>Destroyed</strong> means cleanup completion was confirmed.</li>
    <li><strong>Failed</strong> cleanup needs an operator to resolve.</li>
    <li><strong>Unknown</strong> means cleanup was not recorded, which is expected for some older records.</li>
  </ul>
</section>

<section id="history-filters" class={sectionClass}>
  <h2 class={headingClass}>Finding and paging through history</h2>
  <ul class={listClass}>
    <li><strong>View</strong>: all history, current work, or cleanup attention.</li>
    <li><strong>Outcome</strong>: all, active, published, failed, or superseded.</li>
    <li><strong>Cleanup</strong>: all, pending, destroyed, failed, or unknown.</li>
    <li>
      <strong>From</strong> and <strong>To</strong> are dates in <strong>UTC</strong> and each includes the whole selected day.
    </li>
    <li>Choose your filters, then select <strong>Apply filters</strong>.</li>
    <li><strong>Older runs</strong> loads the next page and <strong>Back to latest</strong> returns to the newest page.</li>
    <li>Select a task to open its detail page.</li>
  </ul>
  <p class={`mt-3 ${bodyClass}`}>
    Filters stay in the address, so a filtered view can be shared or reloaded. Changing a filter returns to the latest page, older pages keep the same position, and a row can leave an active-only filter after it completes.
  </p>
</section>

<section id="task-detail" class={sectionClass}>
  <h2 class={headingClass}>Task detail and stages</h2>
  <p class={bodyClass}>A task page shows the stages that were recorded, in order:</p>
  <ul class={listClass}>
    <li><strong>Checkout</strong>: fetch the code for the revision.</li>
    <li><strong>Preparing sandbox</strong>: set up the isolated environment.</li>
    <li><strong>Reviewing</strong>: the review agent runs.</li>
    <li><strong>Archiving evidence</strong>: store the run's evidence.</li>
    <li><strong>Cleaning up</strong>: remove the environment and its resources.</li>
    <li><strong>Result received</strong> and <strong>Publishing</strong>: the result is processed and then published.</li>
  </ul>
  <p class={`mt-3 ${bodyClass}`}>
    Stages that never ran are skipped. Where a value was not recorded it is shown as not recorded rather than estimated.
  </p>
</section>

<section id="lifecycle-outcomes" class={sectionClass}>
  <h2 class={headingClass}>Published, Failed and Superseded</h2>
  <ul class={listClass}>
    <li><strong>Published</strong>: the review was recorded as published.</li>
    <li><strong>Failed</strong>: the review did not complete; a short failure category is shown when it was recorded.</li>
    <li><strong>Superseded</strong>: a newer revision replaced this review before publication. A superseded run keeps its own page and history.</li>
  </ul>
</section>

<section id="timestamps" class={sectionClass}>
  <h2 class={headingClass}>Timestamps and older records</h2>
  <p class={bodyClass}>
    Times are observations from persisted state, not exact live measurements. Older records may have gaps because some steps were not recorded at the time; those gaps are shown as not recorded and are not filled in later.
  </p>
</section>

<section id="updates" class={sectionClass}>
  <h2 class={headingClass}>Updates and refresh</h2>
  <ul class={listClass}>
    <li>While work is active, the page refreshes about every <strong>15 seconds</strong>.</li>
    <li>When nothing is active, it refreshes about every <strong>60 seconds</strong>.</li>
    <li>After errors it waits longer before retrying.</li>
    <li>Automatic refresh pauses while the tab is hidden or the device is offline, and resumes on return.</li>
    <li>A manual refresh is always available.</li>
  </ul>
  <p class={`mt-3 ${bodyClass}`}>
    The data comes from stored review state and is read-only. A refresh updates the page without changing any review.
  </p>
</section>

<section id="public-identity" class={sectionClass}>
  <h2 class={headingClass}>Public task identity</h2>
  <p class={bodyClass}>
    A task from a repository confirmed public shows its repository and pull request. A private, unverified, or expired identity is shown anonymously as <strong>Protected task</strong>, with no repository details. Public identity is time-limited and may become anonymous again.
  </p>
</section>

<section id="github-check" class={sectionClass}>
  <h2 class={headingClass}>GitHub Check link</h2>
  <p class={bodyClass}>
    A review Check on GitHub can show a Details link to its task page when that link is available. Older checks may not have one. A link always points to the same durable task.
  </p>
</section>

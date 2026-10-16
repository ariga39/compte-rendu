<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import Badge from '#lib/components/Badge.svelte';
  import { createDashboard, createExpiryClock } from '#lib/dashboard.svelte.ts';
  import {
    absoluteTime,
    cleanupLabel,
    cleanupNote,
    cleanupTone,
    formatDuration,
    milestoneLabel,
    outcomeSummary,
    relativeTime,
    statusLabel,
    statusTone,
  } from '#lib/format.ts';
  import {
    buildDetail,
    detailActive,
    identityDeadline,
    liveIdentity,
    mergeMilestones,
  } from '#lib/model.ts';
  import type { DetailModel, ExecutionStage, ProcessingStage, TaskFailure } from '#lib/types.ts';

  const runId = $derived(page.params.runId ?? '');
  const encodedRunId = $derived(encodeURIComponent(runId));

  const dash = createDashboard<DetailModel>({
    key: () => `/jobs/${runId}`,
    urls: () => [`/api/jobs/${encodedRunId}`],
    build: (results, timing) => buildDetail(results, timing),
    isActive: (model) => detailActive(model),
    detail: true,
  });

  const clock = createExpiryClock();

  let backHref = $state('/history');
  let knownPredecessor = $state(false);

  afterNavigate(({ from }) => {
    const fromUrl = from?.url;
    if (fromUrl && fromUrl.pathname === '/history') {
      backHref = `${fromUrl.pathname}${fromUrl.search}`;
      knownPredecessor = true;
    } else {
      backHref = '/history';
      knownPredecessor = false;
    }
  });

  function onBack(event: MouseEvent) {
    if (!knownPredecessor) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    window.history.back();
  }

  $effect(() => {
    const model = dash.data;
    if (!model || dash.error) {
      clock.clear();
      return;
    }
    clock.schedule([identityDeadline(model.task)]);
  });

  const identity = $derived(
    dash.error || !dash.data ? null : liveIdentity(dash.data.task, clock.now),
  );
  const title = $derived(
    identity
      ? `${identity.repositoryFullName} #${identity.pullRequestNumber}`
      : 'Protected task',
  );
  const timeline = $derived(dash.data ? mergeMilestones(dash.data.detail) : []);

  const failureNotice = (failure: TaskFailure) =>
    `Failure category: ${failure.phase}`;
</script>

{#snippet timeFact(label: string, value: string | null | undefined)}
  <div class="fact">
    <b>{label}</b>
    {#if value}
      <time datetime={value}>{absoluteTime(value)}</time>
      <span class="text-muted-ink">({relativeTime(value)})</span>
    {:else}
      Not recorded
    {/if}
  </div>
{/snippet}

{#snippet textFact(label: string, value: string)}
  <div class="fact"><b>{label}</b>{value}</div>
{/snippet}

{#if dash.error === 'notfound'}
  <section class="detail max-w-[760px]">
    <span class="text-xs font-extrabold uppercase tracking-[0.16em] text-accent">Not found</span>
    <h1 class="wrap-anywhere my-1.5 mb-4 text-[clamp(1.6rem,3.2vw,2.35rem)] font-extrabold">Page not found</h1>
    <p class="text-muted-ink">This dashboard address does not identify a task.</p>
    <p>
      <a
        class="inline-block rounded-[9px] border border-line bg-panel px-3 py-2"
        href="/history"
        data-back
        data-testid="back"
        onclick={onBack}
      >
        Back to history
      </a>
    </p>
  </section>
{:else if dash.data}
  {#if dash.error}
    <div role="alert" class="notice error my-[18px] rounded-xl border border-[#75464b] bg-[#111923] px-4 py-3 text-danger">
      {dash.error === 'offline' ? 'You appear to be offline.' : 'The dashboard is temporarily unavailable.'}
      Showing the last refresh from {dash.lastGoodAt ? new Date(dash.lastGoodAt).toISOString() : 'not yet'}.
      <button
        type="button"
        class="ml-2 cursor-pointer rounded-[9px] border border-line bg-panel px-3 py-1.5 text-ink"
        onclick={dash.refresh}
      >
        Retry
      </button>
    </div>
  {/if}
  <section class="detail">
    <a
      class="inline-block rounded-[9px] border border-line bg-panel px-3 py-2"
      href={backHref}
      data-back
      data-testid="back"
      onclick={onBack}
    >
      ← Back to history
    </a>
    <span class="mt-5 block text-xs font-extrabold uppercase tracking-[0.16em] text-accent">Task detail</span>
    <h1 class="wrap-anywhere my-1.5 mb-4 text-[clamp(1.6rem,3.2vw,2.35rem)] font-extrabold leading-tight tracking-[-0.03em]">
      {title}
    </h1>
    <p class="flex flex-wrap gap-2.5">
      <Badge tone={statusTone(dash.data.task)}>{statusLabel(dash.data.task)}</Badge>
      <Badge tone={cleanupTone(dash.data.task.cleanup)}>{cleanupLabel(dash.data.task.cleanup)}</Badge>
    </p>
    {#if identity}
      <p>
        <a href={identity.pullRequestUrl} target="_blank" rel="noopener noreferrer">
          Open pull request on GitHub
        </a>
      </p>
    {/if}

    <div class="facts my-6 grid gap-2.5">
      {@render timeFact('Received', dash.data.task.receivedAt)}
      {@render timeFact('Claimed', dash.data.task.claimedAt)}
      {@render timeFact('Terminal', dash.data.task.terminalAt)}
      {@render textFact('Queue wait', formatDuration(dash.data.task.queueWaitMs))}
      {@render textFact('Total duration', formatDuration(dash.data.task.totalDurationMs))}
      {@render textFact(
        'Last progress',
        dash.data.task.lastProgressAt ? relativeTime(dash.data.task.lastProgressAt) : 'Not recorded',
      )}
    </div>

    <h2 class="mb-3 mt-8 text-xl">Outcome</h2>
    <p>{outcomeSummary(dash.data.task)}</p>

    <h2 class="mb-3 mt-8 text-xl">Reported observations</h2>
    <div class="facts my-6 grid gap-2.5">
      {@render timeFact('Execution start reported', dash.data.task.executionStartedAt)}
      {@render timeFact('Result processing observed', dash.data.task.submissionCompletedAt)}
      {@render timeFact('Cleanup attempt finished', dash.data.task.cleanupCompletedAt)}
    </div>

    <h2 class="mb-3 mt-8 text-xl">Recorded milestones</h2>
    {#if timeline.length}
      <ol class="timeline m-0 list-none p-0">
        {#each timeline as milestone (milestone.stage + milestone.startedAt)}
          <li class="my-2.5 border-l border-line pl-3.5">
            <strong>{milestoneLabel(milestone.stage as ExecutionStage | ProcessingStage)}</strong><br />
            <time datetime={milestone.startedAt}>{absoluteTime(milestone.startedAt)}</time>
            <span class="text-muted-ink">({relativeTime(milestone.startedAt)})</span>
          </li>
        {/each}
      </ol>
    {:else}
      <p class="text-muted-ink">Not recorded</p>
    {/if}

    <h2 class="mb-3 mt-8 text-xl">Cleanup</h2>
    <p class="flex flex-wrap items-center gap-2.5">
      <Badge tone={cleanupTone(dash.data.task.cleanup)}>{cleanupLabel(dash.data.task.cleanup)}</Badge>
      <span>{cleanupNote(dash.data.task.cleanup)}</span>
    </p>

    {#if dash.data.task.failure}
      <div class="notice error mt-[18px] rounded-xl border border-[#75464b] bg-[#111923] px-4 py-3" role="alert">
        <strong>{failureNotice(dash.data.task.failure)}</strong><br />
        {dash.data.task.failure.reason}
      </div>
    {/if}
  </section>
{:else if dash.loading}
  <p class="text-muted-ink" aria-busy="true">Loading…</p>
{:else}
  <section class="max-w-[760px]">
    <span class="text-xs font-extrabold uppercase tracking-[0.16em] text-accent">Unavailable</span>
    <h1 class="wrap-anywhere my-1.5 mb-4 text-[clamp(1.6rem,3.2vw,2.35rem)] font-extrabold">
      We could not load the dashboard.
    </h1>
    <p class="text-muted-ink">
      {dash.error === 'offline' ? 'You appear to be offline.' : 'The dashboard is temporarily unavailable.'}
    </p>
    <button
      type="button"
      class="cursor-pointer rounded-[9px] border border-line bg-panel px-3 py-2"
      onclick={dash.refresh}
    >
      Try again
    </button>
  </section>
{/if}

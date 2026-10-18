<script lang="ts">
  import {
    Accordion,
    AccordionItem,
    Button,
    ContainedList,
    ContainedListItem,
    StructuredList,
    StructuredListCell,
    StructuredListRow,
  } from 'carbon-components-svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Toolbar from '#lib/components/Toolbar.svelte';
  import { createDashboard, createExpiryClock } from '#lib/dashboard.svelte.ts';
  import {
    absoluteTime,
    cleanupLabel,
    cleanupNote,
    cleanupTone,
    DECISION_NOTE,
    DECISION_UNKNOWN,
    decisionLabel,
    failurePhaseLabel,
    failureReasonLabel,
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
  import type { DetailModel, ExecutionStage, ProcessingStage } from '#lib/types.ts';

  interface DetailNav {
    hasPrev: boolean;
    hasNext: boolean;
    prev: () => void;
    next: () => void;
  }

  let {
    runId,
    variant = 'page',
    back = null,
    onClose = null,
    nav = null,
  }: {
    runId: string;
    variant?: 'page' | 'drawer';
    back?: { href: string; onBack: (event: MouseEvent) => void } | null;
    onClose?: (() => void) | null;
    nav?: DetailNav | null;
  } = $props();

  const encodedRunId = $derived(encodeURIComponent(runId));
  const fullPageHref = $derived(`/jobs/${encodedRunId}`);

  const dash = createDashboard<DetailModel>({
    key: () => `/jobs/${runId}`,
    urls: () => [`/api/jobs/${encodedRunId}`],
    build: (results, timing) => buildDetail(results, timing),
    isActive: (model) => detailActive(model),
    detail: true,
  });

  const clock = createExpiryClock();

  $effect(() => {
    const model = dash.data;
    if (!model || dash.error) {
      clock.clear();
      return;
    }
    clock.schedule([identityDeadline(model.task)]);
  });

  const identity = $derived(dash.error || !dash.data ? null : liveIdentity(dash.data.task, clock.now));
  const title = $derived(
    identity
      ? `${identity.repositoryFullName} #${identity.pullRequestNumber}`
      : 'Anonymous review',
  );
  const timeline = $derived(dash.data ? mergeMilestones(dash.data.detail) : []);
  const lastGoodLabel = $derived(
    dash.lastGoodAt ? absoluteTime(new Date(dash.lastGoodAt).toISOString()) : 'not yet',
  );
</script>

{#snippet timeFact(label: string, value: string | null | undefined)}
  <StructuredListRow class="fact">
    <StructuredListCell><b>{label}</b></StructuredListCell>
    <StructuredListCell>
      {#if value}
        <time datetime={value}>{absoluteTime(value)}</time>
        <span class="muted">({relativeTime(value)})</span>
      {:else}
        <span class="muted">Not recorded</span>
      {/if}
    </StructuredListCell>
  </StructuredListRow>
{/snippet}

{#snippet textFact(label: string, value: string)}
  <StructuredListRow class="fact">
    <StructuredListCell><b>{label}</b></StructuredListCell>
    <StructuredListCell><span>{value}</span></StructuredListCell>
  </StructuredListRow>
{/snippet}

{#snippet revisionGrid()}
  {#if identity}
    <h2>Revision</h2>
    <dl class="revision">
      <div>
        <dt>Source branch</dt>
        <dd>{identity.headRef ?? 'Not recorded'}</dd>
      </div>
      <div>
        <dt>Target branch</dt>
        <dd>{identity.baseRef ?? 'Not recorded'}</dd>
      </div>
      <div>
        <dt>Reviewed commit</dt>
        <dd><code>{identity.headSha ?? 'Not recorded'}</code></dd>
      </div>
      <div>
        <dt>Base commit</dt>
        <dd><code>{identity.baseSha ?? 'Not recorded'}</code></dd>
      </div>
    </dl>
  {/if}
{/snippet}

{#if variant === 'drawer'}
  <div class="drawer-actions">
    <Button size="small" data-testid="detail-close" on:click={() => onClose?.()}>Close</Button>
    <a
      class="bx--btn bx--btn--tertiary bx--btn--sm"
      data-testid="open-full-page"
      href={fullPageHref}
    >
      Open full page
    </a>
    <div class="drawer-local-refresh">
      <span class="muted" data-testid="drawer-last-updated">Last updated: {lastGoodLabel}</span>
      <Button size="small" kind="ghost" data-testid="drawer-refresh" on:click={dash.refresh}>
        Refresh now
      </Button>
    </div>
  </div>
  {#if nav}
    <div class="drawer-nav" data-testid="drawer-nav">
      <Button
        size="small"
        kind="ghost"
        data-testid="detail-prev"
        disabled={!nav.hasPrev}
        on:click={nav.prev}
      >
        ← Previous
      </Button>
      <Button
        size="small"
        kind="ghost"
        data-testid="detail-next"
        disabled={!nav.hasNext}
        on:click={nav.next}
      >
        Next →
      </Button>
    </div>
  {/if}
{/if}

{#if dash.error === 'notfound'}
  <section class="detail">
    <h1>Page not found</h1>
    <p class="muted">This dashboard address does not identify a task.</p>
    {#if variant === 'page'}
      <a
        class="bx--btn bx--btn--tertiary"
        href={back?.href ?? '/history'}
        data-back
        data-testid="back"
        onclick={back?.onBack}
      >
        Back to history
      </a>
    {/if}
  </section>
{:else if dash.data}
  {#if dash.error}
    <div role="alert" class="notice error">
      {dash.error === 'offline'
        ? 'You are offline. Updates will resume when you reconnect.'
        : 'Could not refresh reviews. Showing the last available data.'}
      <span class="muted">Last updated: {lastGoodLabel}.</span>
      <Button size="small" on:click={dash.refresh}>Retry</Button>
    </div>
  {/if}
  <Toolbar lastGoodAt={dash.lastGoodAt} onRefresh={dash.refresh} priority={1} />
  <section class="detail">
    {#if variant === 'page'}
      <a
        class="bx--btn bx--btn--tertiary"
        href={back?.href ?? '/history'}
        data-back
        data-testid="back"
        onclick={back?.onBack}
      >
        ← Back to history
      </a>
    {/if}
    <h1>{title}</h1>
    <p>
      <Badge tone={statusTone(dash.data.task)}>{statusLabel(dash.data.task)}</Badge>
    </p>
    {#if identity}
      <p>
        <a href={identity.pullRequestUrl} target="_blank" rel="noopener noreferrer">
          Open pull request on GitHub
        </a>
      </p>
    {/if}

    <h2>Status</h2>
    <p>{outcomeSummary(dash.data.task)}</p>

    {#if dash.data.task.failure}
      <div class="notice error" role="alert">
        <strong>{failurePhaseLabel(dash.data.task.failure.phase)}</strong><br />
        {failureReasonLabel(dash.data.task.failure.reason)}
      </div>
    {/if}

    <h2>Decision</h2>
    <p class="decision-block">
      <span
        class="decision-value"
        class:unknown={dash.data.task.decision === null}
        data-testid="detail-decision"
      >
        {decisionLabel(dash.data.task.decision)}
      </span>
    </p>
    <p class="muted">
      {dash.data.task.decision ? DECISION_NOTE : DECISION_UNKNOWN}
    </p>

    {@render revisionGrid()}

    <h2>Timeline</h2>
    {#if timeline.length}
      <div class="timeline">
        <ContainedList labelText="Timeline" hideLabel>
          {#each timeline as milestone (milestone.stage + milestone.startedAt)}
            <ContainedListItem>
              <strong>{milestoneLabel(milestone.stage as ExecutionStage | ProcessingStage)}</strong><br />
              <time datetime={milestone.startedAt}>{absoluteTime(milestone.startedAt)}</time>
              <span class="muted">({relativeTime(milestone.startedAt)})</span>
            </ContainedListItem>
          {/each}
        </ContainedList>
      </div>
    {:else}
      <p class="muted">Not recorded</p>
    {/if}

    <h2>Timing</h2>
    <StructuredList>
      {@render timeFact('Received', dash.data.task.receivedAt)}
      {@render timeFact('Assigned', dash.data.task.claimedAt)}
      {@render timeFact('Finished', dash.data.task.terminalAt)}
      {@render textFact('Time in queue', formatDuration(dash.data.task.queueWaitMs))}
      {@render textFact('Total time', formatDuration(dash.data.task.totalDurationMs))}
      {@render textFact(
        'Last progress update',
        dash.data.task.lastProgressAt ? relativeTime(dash.data.task.lastProgressAt) : 'Not recorded',
      )}
    </StructuredList>

    <Accordion>
      <AccordionItem title="Technical details">
        <h3>Execution details</h3>
        <StructuredList>
          {@render timeFact('Runner execution started', dash.data.task.executionStartedAt)}
          {@render timeFact('Result checks started', dash.data.task.submissionCompletedAt)}
          {@render timeFact('Cleanup attempt finished', dash.data.task.cleanupCompletedAt)}
        </StructuredList>
        <h3>Cleanup</h3>
        <div class="cleanup-block">
          <Badge tone={cleanupTone(dash.data.task)}>{cleanupLabel(dash.data.task)}</Badge>
          <p class="muted">{cleanupNote(dash.data.task)}</p>
        </div>
      </AccordionItem>
    </Accordion>
  </section>
{:else if dash.loading}
  <p class="muted" aria-busy="true">Loading reviews…</p>
{:else}
  <section>
    <h1 class="page-head">Could not load reviews</h1>
    <p class="muted">
      {dash.error === 'offline' ? 'You are offline.' : 'Could not load reviews right now.'}
    </p>
    <Button size="small" on:click={dash.refresh}>Try again</Button>
  </section>
{/if}

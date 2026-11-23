<script lang="ts">
  import type { DehydratedState } from "@tanstack/svelte-query";
  import {
    Accordion,
    AccordionItem,
    Button,
    StructuredList,
    StructuredListCell,
    StructuredListRow,
  } from 'carbon-components-svelte';
  import Badge from '#lib/components/Badge.svelte';
  import ModelUsage from '#lib/components/ModelUsage.svelte';
  import Toolbar from '#lib/components/Toolbar.svelte';
  import { requestCancellation } from '#lib/api.ts';
  import { createDashboard, createExpiryClock } from '#lib/dashboard.svelte.ts';
  import { useOperator, useViewerRefresh } from '#lib/dashboard-operator.ts';
  import {
    absoluteTime,
    cancellationRequestLabel,
    cleanupLabel,
    cleanupNote,
    cleanupTone,
    DECISION_NOTE,
    DECISION_UNKNOWN,
    decisionLabel,
    failurePhaseLabel,
    failureReasonLabel,
    formatDuration,
    isCancelling,
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
  import type { DetailModel } from '#lib/types.ts';

  interface DetailNav {
    hasPrev: boolean;
    hasNext: boolean;
    prev: () => void;
    next: () => void;
  }

  let {
    runId,
    dehydrated,
    variant = 'page',
    back = null,
    onClose = null,
    nav = null,
  }: {
    runId: string;
    dehydrated?: DehydratedState;
    variant?: 'page' | 'drawer';
    back?: { href: string; onBack: (event: MouseEvent) => void } | null;
    onClose?: (() => void) | null;
    nav?: DetailNav | null;
  } = $props();

  const encodedRunId = $derived(encodeURIComponent(runId));
  const fullPageHref = $derived(`/jobs/${encodedRunId}`);

  const dash = createDashboard<DetailModel>({
    dehydrated: () => dehydrated,
    key: () => `/jobs/${runId}`,
    url: () => `/api/jobs/${encodedRunId}`,
    build: buildDetail,
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
  const runtimeLabels = { sbx: 'Docker Sandbox (sbx)', microsandbox: 'microsandbox', opensandbox: 'OpenSandbox', openshell: 'OpenShell' };
  const runtime = $derived(dash.data?.detail.milestones.find((entry) => entry.stage === 'sandbox')?.runtime);
  const timeline = $derived(dash.data ? mergeMilestones(dash.data.detail) : []);
  const currentStage = $derived(dash.data?.task.processing ?? dash.data?.task.stage);
  const currentIndex = $derived(dash.data?.task.status === 'scheduled'
    ? timeline.findLastIndex((entry) => entry.stage === currentStage)
    : -1);
  const lastGoodLabel = $derived(
    dash.lastGoodAt ? absoluteTime(new Date(dash.lastGoodAt).toISOString()) : 'not yet',
  );

  const operator = useOperator();
  const refreshViewer = useViewerRefresh();
  let confirming = $state(false);
  let submitting = $state(false);
  let cancelError = $state<string | null>(null);
  let cancelNotice = $state<string | null>(null);
  let announcement = $state('');
  let accepted = $state<{ runId: string; pendingCleanup: boolean } | null>(null);
  let heading = $state<HTMLHeadingElement | null>(null);
  let cancelTrigger = $state<HTMLButtonElement | null>(null);
  let confirmDialog = $state<HTMLDialogElement | null>(null);
  let dismissButton = $state<HTMLButtonElement | null>(null);
  let activeRunId = $state<string | null>(null);
  let announcedCancellation = $state<string | null>(null);

  $effect(() => {
    if (activeRunId === runId) return;
    activeRunId = runId;
    confirming = false;
    submitting = false;
    cancelError = null;
    cancelNotice = null;
    announcement = '';
    announcedCancellation = null;
    accepted = null;
  });

  $effect(() => {
    if ((accepted === null && cancelNotice === null) || task === null) {
      announcedCancellation = null;
      return;
    }
    if (task.status !== 'cancelled') return;
    const next = isCancelling(task)
      ? 'cancelling'
      : task.cleanup === 'failed'
        ? 'failed'
        : 'cancelled';
    if (next === announcedCancellation) return;
    announcedCancellation = next;
    announcement =
      next === 'cancelling'
        ? 'Cancellation accepted. Waiting for cleanup confirmation.'
        : next === 'failed'
          ? 'Review cancelled. Cleanup failed and needs an operator.'
          : task.cleanup === 'destroyed'
            ? 'Review cancelled. Cleanup confirmed.'
            : 'Review cancelled. No review was published.';
  });

  const task = $derived(dash.data?.task ?? null);
  // The local POST reply is provisional. Once the refreshed task records the
  // disposition, its cleanup state is authoritative.
  const acceptedForCurrent = $derived(
    accepted !== null &&
      task !== null &&
      accepted.runId === task.runId &&
      task.status === 'scheduled'
      ? accepted
      : null,
  );
  const cancellationLabel = $derived(
    acceptedForCurrent === null
      ? null
      : acceptedForCurrent.pendingCleanup
        ? 'Cancelling'
        : 'Cancelled',
  );
  const canCancel = $derived(
    operator() &&
      acceptedForCurrent === null &&
      task !== null &&
      task.status === 'scheduled' &&
      task.processing !== 'publishing',
  );

  $effect(() => {
    if (!confirming || confirmDialog === null) return;
    if (!confirmDialog.open) confirmDialog.showModal();
    (dismissButton ?? confirmDialog).focus({ preventScroll: true });
  });

  function announce(message: string) {
    announcement = message;
  }

  function openConfirmation() {
    cancelError = null;
    cancelNotice = null;
    confirming = true;
  }

  function closeConfirmation(returnTo: 'trigger' | 'heading' = 'trigger') {
    const dialog = confirmDialog;
    confirming = false;
    if (dialog?.open) dialog.close();
    requestAnimationFrame(() => {
      const target =
        returnTo === 'heading'
          ? heading
          : cancelTrigger !== null && !cancelTrigger.disabled
            ? cancelTrigger
            : heading;
      target?.focus({ preventScroll: true });
    });
  }

  function onDialogKeydown(event: KeyboardEvent) {
    // Keep Escape and Tab away from the page or drawer beneath the dialog.
    event.stopPropagation();
    if (event.key !== 'Tab' || confirmDialog === null) return;
    const focusable = [
      ...confirmDialog.querySelectorAll<HTMLElement>('button:not([disabled])'),
    ];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  }

  function onDialogCancel(event: Event) {
    event.preventDefault();
    closeConfirmation('trigger');
  }

  async function submitCancellation() {
    if (submitting) return;
    const requestedRunId = runId;
    submitting = true;
    cancelError = null;
    cancelNotice = null;
    announce('Cancelling review.');
    const result = await requestCancellation(requestedRunId);
    if (requestedRunId !== runId || activeRunId !== requestedRunId) return;
    submitting = false;
    if (result.kind === 'accepted') {
      accepted = { runId: requestedRunId, pendingCleanup: result.pendingCleanup };
      announce(
        result.pendingCleanup
          ? 'Cancellation accepted. Waiting for cleanup confirmation.'
          : 'Review cancelled.',
      );
      if (confirming) closeConfirmation('heading');
      dash.refresh();
      return;
    }
    if (result.kind === 'ambiguous') {
      cancelNotice = 'Cancellation could not be confirmed yet. The review details are refreshing.';
      announce(cancelNotice);
      if (confirming) closeConfirmation('trigger');
      dash.refresh();
      return;
    }
    if (result.kind === 'expired') {
      cancelError = 'Your session expired. Sign in again to cancel reviews.';
      announce(cancelError);
      if (confirming) closeConfirmation('heading');
      void refreshViewer();
      return;
    }
    if (result.kind === 'forbidden') {
      cancelError = 'You are not allowed to cancel reviews.';
      announce(cancelError);
      if (confirming) closeConfirmation('heading');
      void refreshViewer();
      return;
    }
    const messages: Record<'conflict' | 'notfound' | 'failed', string> = {
      conflict:
        'This review can no longer be cancelled because publication has started or it has already finished. The details were refreshed.',
      notfound: 'This review no longer exists.',
      failed: 'Could not cancel the review right now. Try again.',
    };
    cancelError = messages[result.kind];
    announce(cancelError);
    if (confirming) closeConfirmation('trigger');
    if (result.kind === 'conflict' || result.kind === 'notfound') dash.refresh();
  }
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
  {@const view = task ?? dash.data.task}
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
  <div
    class="sr-only"
    role="status"
    aria-live="polite"
    aria-atomic="true"
    data-testid="cancel-announcement"
  >
    {announcement}
  </div>
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
    <header class="review-heading">
      <Badge
        tone={acceptedForCurrent
          ? acceptedForCurrent.pendingCleanup
            ? 'warn'
            : 'muted'
          : statusTone(view)}
      >
        {acceptedForCurrent ? cancellationLabel : statusLabel(view)}
      </Badge>
      <h1 bind:this={heading} tabindex="-1">{title}</h1>
      {#if identity}
        <a href={identity.pullRequestUrl} target="_blank" rel="noopener noreferrer">Open pull request on GitHub</a>
      {/if}
      <p>
        {acceptedForCurrent
          ? acceptedForCurrent.pendingCleanup
            ? 'Cancellation accepted. Execution is stopping and cleanup is not yet confirmed.'
            : 'Review cancelled; no review was published.'
          : outcomeSummary(view)}
      </p>
      {#if canCancel}
        <Button
          kind="danger"
          size="small"
          data-testid="cancel-review"
          bind:ref={cancelTrigger}
          disabled={submitting}
          on:click={openConfirmation}
        >
          Cancel review
        </Button>
      {/if}
    </header>

    {#if cancelError}
      <div class="notice error" role="alert" data-testid="cancel-error">
        {cancelError}
      </div>
    {/if}

    {#if cancelNotice && task?.status === 'scheduled'}
      <div class="notice" role="status" data-testid="cancel-notice">
        {cancelNotice}
      </div>
    {/if}

    {#if confirming}
      <dialog
        class="cancel-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-busy={submitting ? 'true' : undefined}
        aria-labelledby="cancel-confirm-title"
        aria-describedby="cancel-confirm-description"
        data-testid="cancel-confirm"
        bind:this={confirmDialog}
        onkeydown={onDialogKeydown}
        oncancel={onDialogCancel}
      >
        <h2 id="cancel-confirm-title">Cancel this review?</h2>
        <p id="cancel-confirm-description">
          Cancel <strong>{title}</strong>? Run <code>{runId}</code> will stop and it will publish
          no review.
        </p>
        <div class="cancel-confirm-actions">
          <Button
            size="small"
            data-testid="cancel-confirm-dismiss"
            bind:ref={dismissButton}
            on:click={() => closeConfirmation('trigger')}
          >
            Keep review
          </Button>
          <Button
            kind="danger"
            size="small"
            loading={submitting}
            data-testid="cancel-confirm-submit"
            on:click={submitCancellation}
          >
            {submitting ? 'Cancelling…' : 'Cancel review'}
          </Button>
        </div>
      </dialog>
    {/if}

    {#if view.failure}
      <div class="notice error" role="alert">
        <strong>{failurePhaseLabel(view.failure.phase)}</strong><br />
        {failureReasonLabel(view.failure.reason)}{#if view.failure.httpStatus !== undefined}{' '}(HTTP {view.failure.httpStatus}){/if}
      </div>
    {/if}

    <h2>Decision</h2>
    <p class="decision-block">
      <span
        class="decision-value"
        class:unknown={view.decision === null}
        data-testid="detail-decision"
      >
        {decisionLabel(view.decision)}
      </span>
    </p>
    <p class="muted">
      {#if view.decision}{DECISION_NOTE}
      {:else if acceptedForCurrent}No review decision was published.
      {:else if view.status === 'scheduled'}No decision yet.
      {:else if view.status === 'completed'}{DECISION_UNKNOWN}
      {:else}No review decision was published.{/if}
    </p>

    <div class="detail-columns" class:page-columns={variant === 'page'}>
      <section>

        <h2>Timeline</h2>
        {#if timeline.length}
          <ol class="timeline" aria-label="Timeline">
            {#each timeline as milestone, index (milestone.stage + milestone.startedAt)}
              {@const current = index === currentIndex}
              {@const elapsed = Date.parse(milestone.startedAt) - Date.parse(view.receivedAt)}
              <li data-stage={milestone.stage} aria-current={current ? 'step' : undefined}>
                <strong>{milestoneLabel(milestone.stage, view.status)}</strong>
                {#if current}<span class="current-stage">Current</span>{/if}
                <time datetime={milestone.startedAt}>{absoluteTime(milestone.startedAt)}</time>
                {#if elapsed >= 0}<small title="Elapsed since received">+{formatDuration(elapsed)}</small>{/if}
              </li>
            {/each}
          </ol>
        {:else}
          <p class="muted">Not recorded</p>
        {/if}

      </section>
      <section>
        <h2>Timing</h2>
        <StructuredList>
          {@render timeFact('Received', view.receivedAt)}
          {@render timeFact('Assigned', view.claimedAt)}
          {@render timeFact(
            view.status === 'cancelled' ? cancellationRequestLabel(view) : 'Finished',
            view.terminalAt,
          )}
          {@render textFact('Time in queue', formatDuration(view.queueWaitMs))}
          {@render textFact('Total time', formatDuration(view.totalDurationMs))}
          {@render textFact(
            'Last progress update',
            view.lastProgressAt ? relativeTime(view.lastProgressAt) : 'Not recorded',
          )}
        </StructuredList>

        <ModelUsage usage={dash.data.detail.usage} />

      </section>
    </div>

    {@render revisionGrid()}
    <Accordion>
      <AccordionItem title="Technical details">
        <h3>Execution details</h3>
        <StructuredList>
          {@render textFact('Sandbox backend', runtime ? runtimeLabels[runtime] : 'Not recorded')}
          {@render timeFact('Runner execution started', view.executionStartedAt)}
          {@render timeFact('Result checks started', view.submissionCompletedAt)}
          {@render timeFact('Cleanup attempt finished', view.cleanupCompletedAt)}
        </StructuredList>
        <h3>Cleanup</h3>
        <div class="cleanup-block">
          <Badge tone={cleanupTone(view)}>{cleanupLabel(view)}</Badge>
          <p class="muted">{cleanupNote(view)}</p>
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

<script lang="ts">
  import {
    absoluteTime,
    cleanupLabel,
    cleanupTone,
    progressText,
    relativeTime,
    statusLabel,
    statusTone,
    taskLabel,
  } from '#lib/format.ts';
  import { liveIdentity } from '#lib/model.ts';
  import type { DatedTask } from '#lib/types.ts';
  import Badge from './Badge.svelte';

  let { task, now, stale = false }: { task: DatedTask; now: number; stale?: boolean } = $props();

  let identity = $derived(stale ? null : liveIdentity(task, now));
  let title = $derived(
    identity ? `${identity.repositoryFullName} #${identity.pullRequestNumber}` : 'Protected task',
  );
</script>

<article
  data-testid="task"
  class="my-2.5 grid grid-cols-[minmax(0,2fr)_auto_auto_auto] items-center gap-[18px] rounded-[14px] border border-line bg-gradient-to-br from-panel to-[#111820] p-[18px] max-md:grid-cols-2 max-sm:grid-cols-1"
>
  <div>
    <h3 class="wrap-anywhere m-0 mb-1 text-base">
      <a
        class="font-semibold text-accent hover:underline"
        href={`/jobs/${encodeURIComponent(task.runId)}`}
        data-testid="task-link"
        data-run-id={task.runId}
      >
        {title}
      </a>
    </h3>
    <p class="m-0 text-sm text-muted-ink">
      {taskLabel(task)} · received {relativeTime(task.receivedAt)}
      <span class="text-muted-ink">({absoluteTime(task.receivedAt)})</span>
    </p>
    {#if task.dispatch === 'claimed'}
      <p class="m-0 text-sm text-muted-ink">{progressText(task)}</p>
    {/if}
  </div>
  <div><Badge tone={statusTone(task)}>{statusLabel(task)}</Badge></div>
  <div><Badge tone={cleanupTone(task.cleanup)}>{cleanupLabel(task.cleanup)}</Badge></div>
  {#if identity}
    <div>
      <a href={identity.pullRequestUrl} target="_blank" rel="noopener noreferrer">Pull request</a>
    </div>
  {/if}
</article>

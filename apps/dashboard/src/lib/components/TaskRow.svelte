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
    identity ? `${identity.repositoryFullName} #${identity.pullRequestNumber}` : 'Anonymous review',
  );
</script>

<article data-testid="task" class="task-row">
  <div class="task-main">
    <h3 class="task-title">
      <a
        data-testid="task-link"
        data-run-id={task.runId}
        href={`/jobs/${encodeURIComponent(task.runId)}`}
      >
        {title}
      </a>
    </h3>
    <p class="task-meta">
      {taskLabel(task)} ·
      <time datetime={task.receivedAt} title={absoluteTime(task.receivedAt)} aria-label={absoluteTime(task.receivedAt)}>
        received {relativeTime(task.receivedAt)}
      </time>
    </p>
    {#if task.dispatch === 'claimed'}
      <p class="task-meta">{progressText(task)}</p>
    {/if}
  </div>
  <div class="task-badges">
    <Badge tone={statusTone(task)}>{statusLabel(task)}</Badge>
    <Badge tone={cleanupTone(task)}>{cleanupLabel(task)}</Badge>
  </div>
  <div class="task-pr-cell">
    {#if identity}
      <a class="task-pr" href={identity.pullRequestUrl} target="_blank" rel="noopener noreferrer">
        Pull request
      </a>
    {/if}
  </div>
</article>

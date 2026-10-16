<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
  } from 'carbon-components-svelte';
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
  import type { DatedTask, PublicIdentity } from '#lib/types.ts';
  import Badge from './Badge.svelte';

  let { tasks, now, stale = false }: { tasks: DatedTask[]; now: number; stale?: boolean } = $props();

  const identityOf = (task: DatedTask): PublicIdentity | null =>
    stale ? null : liveIdentity(task, now);
  const titleOf = (task: DatedTask): string => {
    const identity = identityOf(task);
    return identity
      ? `${identity.repositoryFullName} #${identity.pullRequestNumber}`
      : 'Anonymous review';
  };
</script>

<TableContainer>
  <Table>
    <TableHead>
      <TableRow>
        <TableHeader>Review</TableHeader>
        <TableHeader>Status</TableHeader>
        <TableHeader>Cleanup</TableHeader>
        <TableHeader>Received</TableHeader>
        <TableHeader>Pull request</TableHeader>
      </TableRow>
    </TableHead>
    <TableBody>
      {#each tasks as task (task.runId)}
        <TableRow data-testid="task">
          <TableCell>
            <a
              data-testid="task-link"
              data-run-id={task.runId}
              href={`/jobs/${encodeURIComponent(task.runId)}`}
            >
              {titleOf(task)}
            </a>
            <p class="task-meta">
              {taskLabel(task)} · {task.dispatch === 'claimed'
                ? progressText(task)
                : `received ${relativeTime(task.receivedAt)}`}
            </p>
          </TableCell>
          <TableCell><Badge tone={statusTone(task)}>{statusLabel(task)}</Badge></TableCell>
          <TableCell><Badge tone={cleanupTone(task)}>{cleanupLabel(task)}</Badge></TableCell>
          <TableCell>
            <time datetime={task.receivedAt} title={absoluteTime(task.receivedAt)}>
              {relativeTime(task.receivedAt)}
            </time>
          </TableCell>
          <TableCell>
            {#if identityOf(task)}
              <a
                class="task-pr"
                href={identityOf(task)?.pullRequestUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Pull request
              </a>
            {/if}
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
</TableContainer>

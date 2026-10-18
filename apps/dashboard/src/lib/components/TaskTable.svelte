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
    decisionLabel,
    relativeTime,
    statusDetail,
    statusLabel,
    statusTone,
  } from '#lib/format.ts';
  import { liveIdentity } from '#lib/model.ts';
  import type { DatedTask, PublicIdentity } from '#lib/types.ts';
  import Badge from './Badge.svelte';

  let {
    tasks,
    now,
    stale = false,
    compact = false,
    selectedRunId = null,
    onSelect = null,
  }: {
    tasks: DatedTask[];
    now: number;
    stale?: boolean;
    compact?: boolean;
    selectedRunId?: string | null;
    onSelect?: ((runId: string) => void) | null;
  } = $props();

  const identityOf = (task: DatedTask): PublicIdentity | null =>
    stale ? null : liveIdentity(task, now);
  const titleOf = (task: DatedTask): string => {
    const identity = identityOf(task);
    return identity
      ? `${identity.repositoryFullName} #${identity.pullRequestNumber}`
      : 'Anonymous review';
  };
  const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : '');

  function select(event: MouseEvent, task: DatedTask) {
    if (onSelect === null) return;
    if (event.defaultPrevented) return;
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    onSelect(task.runId);
  }
</script>

<TableContainer class={compact ? 'task-table task-table--compact' : 'task-table'}>
  <Table size="tall">
    <TableHead>
      <TableRow>
        <TableHeader>Review</TableHeader>
        <TableHeader>Status</TableHeader>
        <TableHeader>Decision</TableHeader>
        {#if !compact}
          <TableHeader>Received</TableHeader>
          <TableHeader>Pull request</TableHeader>
        {/if}
      </TableRow>
    </TableHead>
    <TableBody>
      {#each tasks as task (task.runId)}
        <TableRow
          data-testid="task"
          data-run-id={task.runId}
          data-selected={selectedRunId === task.runId ? 'true' : undefined}
        >
          <TableCell>
            <a
              class="task-link"
              data-testid="task-link"
              data-run-id={task.runId}
              aria-current={selectedRunId === task.runId ? 'true' : undefined}
              href={`/jobs/${encodeURIComponent(task.runId)}`}
              onclick={(event) => select(event, task)}
            >
              {titleOf(task)}
            </a>
            {#if identityOf(task) && (identityOf(task)?.headRef || identityOf(task)?.headSha)}
              {@const identity = identityOf(task)}
              <p class="task-branches" data-testid="task-branches">
                {#if identity?.headRef && identity?.baseRef}
                  <span class="branch">{identity.headRef}</span>
                  <span class="branch-arrow" aria-label="to">→</span>
                  <span class="branch">{identity.baseRef}</span>
                  {#if identity.headSha}
                    <span class="branch-sha">{shortSha(identity.headSha)}</span>
                  {/if}
                {:else if identity?.headRef}
                  <span class="branch">{identity.headRef}</span>
                  {#if identity.headSha}
                    <span class="branch-sha">{shortSha(identity.headSha)}</span>
                  {/if}
                {:else if identity?.headSha}
                  <span class="branch-sha">{shortSha(identity.headSha)}</span>
                {/if}
              </p>
            {/if}
          </TableCell>
          <TableCell>
            <Badge tone={statusTone(task)}>{statusLabel(task)}</Badge>
            {#if statusDetail(task)}
              <p class="task-meta">{statusDetail(task)}</p>
            {/if}
          </TableCell>
          <TableCell>
            <span
              class="task-decision"
              class:unknown={task.decision === null}
              data-testid="task-decision"
            >
              {decisionLabel(task.decision)}
            </span>
          </TableCell>
          {#if !compact}
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
              {:else}
                —
              {/if}
            </TableCell>
          {/if}
        </TableRow>
      {/each}
    </TableBody>
  </Table>
</TableContainer>

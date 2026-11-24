<script lang="ts">
  import type { DetailEfforts } from '#lib/types.ts';
  import Badge from '#lib/components/Badge.svelte';

  let { efforts }: { efforts: DetailEfforts } = $props();
  const outcomeLabel: Record<string, string> = {
    switched: 'This run switched to the upstream default',
    shared: 'Already using the upstream default',
    failed: 'Fallback failed',
  };
  const outcomeTone = (kind: string | null) =>
    kind === 'failed' ? 'bad' : kind === 'switched' ? 'warn' : 'muted';
  const selected = (name: string | null) => name ?? 'Default';
</script>

{#if efforts.selection.length > 0 || (efforts.summary?.length ?? 0) > 0}
  <section class="effort-summary" aria-label="Thinking effort">
    <h2>Thinking effort</h2>
    {#if efforts.selection.length > 0}
      <h3>Configured for this review</h3>
      <ul data-testid="effort-selection">
        {#each efforts.selection as entry (entry.route)}
          <li data-testid={`effort-selected-${entry.route}`}>
            <span>{entry.route}</span>
            <strong>{selected(entry.name)}</strong>
          </li>
        {/each}
      </ul>
    {/if}
    {#if efforts.summary !== null && efforts.summary.length > 0}
      <h3>This run</h3>
      <ul data-testid="effort-summary">
        {#each efforts.summary as route (route.route)}
          <li data-testid={`effort-summary-${route.route}`}>
            <span>{route.route} · configured {selected(route.selected)}</span>
            {#each route.outcomes as outcome (JSON.stringify(outcome))}
              <div class="outcome">
                <Badge tone={outcomeTone(outcome.kind)}>
                  {outcome.kind === null
                    ? 'No fallback recorded'
                    : (outcomeLabel[outcome.kind] ?? 'Fallback state unknown')}
                </Badge>
                <span class="muted">
                  {outcome.requests}
                  {outcome.requests === 1 ? 'request' : 'requests'}
                  {#if outcome.reason}{` · ${outcome.reason}`}{/if}
                </span>
              </div>
            {/each}
          </li>
        {/each}
      </ul>
      <p class="muted">
        These are the controls sent and the fallback outcome. The page does not report the
        upstream’s internal thinking strength.
      </p>
    {:else if efforts.selection.length > 0}
      <p class="muted">No route has been called yet, so only the configured effort is shown.</p>
    {/if}
  </section>
{/if}

<style>
  .effort-summary { margin-bottom: 1.5rem; }
  ul { list-style: none; padding: 0; display: grid; gap: 0.75rem; }
  li { display: grid; gap: 0.25rem; overflow-wrap: anywhere; }
  .outcome { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .muted { color: #c6c6c6; font-size: 0.875rem; }
</style>

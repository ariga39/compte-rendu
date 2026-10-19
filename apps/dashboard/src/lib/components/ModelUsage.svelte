<script lang="ts">
  import type { ModelUsageSummary } from '@compte-rendu/contracts';
  import { StructuredList, StructuredListCell, StructuredListRow } from 'carbon-components-svelte';

  let { usage }: { usage: ModelUsageSummary | null | undefined } = $props();
  const metrics = [
    ['inputTokens', 'Input total'],
    ['uncachedInputTokens', 'Uncached input'],
    ['cacheReadTokens', 'Cache read'],
    ['cacheWriteTokens', 'Cache write'],
    ['outputTokens', 'Output total'],
    ['reasoningTokens', 'Reasoning (included in output)'],
  ] as const;
  const number = new Intl.NumberFormat('en-US');
</script>

<section aria-label="Models and tokens" class="model-usage">
  <h2>Models and tokens</h2>
  {#if usage == null}
    <p class="muted">Usage not recorded for this review.</p>
  {:else if usage.models.length === 0}
    <p class="muted">No model requests recorded.</p>
  {:else}
    <p class="muted">Reported by the model service. Cache and reasoning breakdowns are included in the input and output totals.</p>
    {#if usage.truncated}
      <p class="muted">Only the first 32 model entries were recorded. These totals are incomplete.</p>
    {/if}
    {#each usage.models as model (model.route + ':' + model.model)}
      <div class="model-block">
        <h3>{model.model ?? 'Model not reported'}</h3>
        <p class="muted">Route: {model.route} · {number.format(model.requests)} {model.requests === 1 ? 'request' : 'requests'}</p>
        {#if model.incompleteRequests > 0}
          <p class="muted">{number.format(model.incompleteRequests)} interrupted {model.incompleteRequests === 1 ? 'request' : 'requests'}; usage may be incomplete.</p>
        {/if}
        <StructuredList>
          {#each metrics as [field, label] (field)}
            {@const count = model[field]}
            <StructuredListRow>
              <StructuredListCell>{label}</StructuredListCell>
              <StructuredListCell>
                {#if count === null}
                  <span class="muted">Not reported</span>
                {:else}
                  {number.format(count.total)}
                  {#if count.reportedRequests < model.requests}
                    <span class="coverage muted">Reported for {count.reportedRequests} of {model.requests} requests</span>
                  {/if}
                {/if}
              </StructuredListCell>
            </StructuredListRow>
          {/each}
        </StructuredList>
      </div>
    {/each}
  {/if}
</section>

<style>
  .model-block { margin-top: 1.5rem; }
  h3 { overflow-wrap: anywhere; }
  .model-block p { overflow-wrap: anywhere; }
  .coverage { display: block; margin-top: 0.5rem; font-size: 0.75rem; }
</style>

<script lang="ts">
  import type { ModelUsageSummary } from '@compte-rendu/contracts';
  import {
    Accordion,
    AccordionItem,
    StructuredList,
    StructuredListCell,
    StructuredListRow,
  } from 'carbon-components-svelte';

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
  const percentage = new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const cacheReadPercentage = (model: ModelUsageSummary['models'][number]): string | null => {
    const input = model.inputTokens;
    const cacheRead = model.cacheReadTokens;
    if (
      input === null ||
      cacheRead === null ||
      input.total <= 0 ||
      cacheRead.total > input.total ||
      input.reportedRequests !== model.requests ||
      cacheRead.reportedRequests !== model.requests
    ) {
      return null;
    }
    return percentage.format(cacheRead.total / input.total);
  };
  const displayModel = (model: string | null) => {
    if (model === null) return 'Model not reported';
    const separator = model.lastIndexOf('/');
    return separator === -1 ? model : model.slice(separator + 1) || model;
  };
  const collator = new Intl.Collator('en-US');
  const compareText = (left: string, right: string) => {
    const localized = collator.compare(left, right);
    if (localized !== 0) return localized;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  type UsageRow = ModelUsageSummary['models'][number];
  const compareUsageRows = (left: UsageRow, right: UsageRow) => {
    if (left.model === null || right.model === null) {
      if (left.model === null && right.model === null)
        return compareText(left.route, right.route);
      return left.model === null ? 1 : -1;
    }
    return (
      compareText(displayModel(left.model), displayModel(right.model)) ||
      compareText(left.model, right.model) ||
      compareText(left.route, right.route)
    );
  };
  // Usage is a read-only projection. Sort a copy so the incoming array keeps
  // its service order, while public detail and Storybook render deterministically.
  const orderedModels = $derived.by(() => [...(usage?.models ?? [])].sort(compareUsageRows));
</script>

<section aria-label="Models and tokens" class="model-usage">
  <h2>Models and tokens</h2>
  {#if usage == null}
    <p class="muted">Usage not recorded for this review.</p>
  {:else if orderedModels.length === 0}
    <p class="muted">No model requests recorded.</p>
  {:else}
    <p class="muted">Reported by the model service. Cache and reasoning breakdowns are included in the input and output totals.</p>
    {#if usage.truncated}
      <p class="muted">Only the first 32 model entries were recorded. These totals are incomplete.</p>
    {/if}
    <Accordion>
      {#each orderedModels as model (JSON.stringify([model.route, model.model]))}
        {@const cachePercent = cacheReadPercentage(model)}
        <AccordionItem title={displayModel(model.model)}>
          <div class="model-details">
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
                      {number.format(count.total)}{#if field === 'cacheReadTokens' && cachePercent !== null}{` (${cachePercent})`}{/if}
                      {#if count.reportedRequests < model.requests}
                        <span class="coverage muted">Reported for {count.reportedRequests} of {model.requests} requests</span>
                      {/if}
                    {/if}
                  </StructuredListCell>
                </StructuredListRow>
              {/each}
            </StructuredList>
          </div>
        </AccordionItem>
      {/each}
    </Accordion>
  {/if}
</section>

<style>
  .model-usage { margin-bottom: 1.5rem; }
  .model-details p { overflow-wrap: anywhere; }
  .coverage { display: block; margin-top: 0.5rem; font-size: 0.75rem; }
  .model-usage :global(.bx--accordion__title) { overflow-wrap: anywhere; }
</style>

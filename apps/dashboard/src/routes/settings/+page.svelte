<script lang="ts">
  import { invalidate } from '$app/navigation';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  let defaults = $derived(data.settings?.configuration.selection == null);
  let reviewers = $derived<string[]>([...(data.settings?.configuration.selection?.reviewers ?? [])]);
  let synthesis = $derived(data.settings?.configuration.selection?.synthesis ?? '');
  let message = $state('');
  let success = $state(false);
  let busy = $state(false);
  let stale = $state(false);
  let loadedRevision = $state<number | null>(null);
  let effortChoices = $state<Record<string, string>>({});
  let loadedConcurrency = $state<number | null>(null);
  let concurrencyDraft = $state('');
  let loadedSelectionSignature = $state('');
  type SelectionLike = {
    reviewers: readonly string[];
    synthesis: string;
    efforts?: Record<string, string>;
  };
  const selectionSignature = (selection: SelectionLike | null) =>
    JSON.stringify(
      selection === null
        ? null
        : {
            reviewers: [...selection.reviewers].sort(),
            synthesis: selection.synthesis,
            efforts: Object.fromEntries(
              Object.entries(selection.efforts ?? {}).sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            ),
          },
    );
  $effect(() => {
    const revision = data.settings?.configuration.revision ?? null;
    if (revision === loadedRevision) return;
    loadedRevision = revision;
    effortChoices = { ...data.settings?.configuration.selection?.efforts };
    loadedConcurrency = data.settings?.configuration.concurrency ?? null;
    concurrencyDraft = loadedConcurrency === null ? '' : String(loadedConcurrency);
    loadedSelectionSignature = selectionSignature(
      data.settings?.configuration.selection ?? null,
    );
  });
  const parsedConcurrency = $derived(
    concurrencyDraft.trim() === '' ? null : Number(concurrencyDraft),
  );
  const concurrencyInvalid = $derived(
    parsedConcurrency !== null &&
      (!Number.isSafeInteger(parsedConcurrency) || parsedConcurrency < 1),
  );
  const concurrencyDirty = $derived(parsedConcurrency !== loadedConcurrency);
  const effortOptions = (route: string) => data.settings?.efforts?.[route] ?? [];
  const selectedRoutes = $derived(
    reviewers.length > 1
      ? [...new Set([...reviewers, synthesis].filter((route) => route.length > 0))]
      : reviewers.slice(0, 1),
  );
  const effortState = (route: string) =>
    data.settings?.effortStates?.find((state) => state.routeId === route) ?? null;
  const staleEfforts = $derived(
    selectedRoutes.filter((route) => {
      const name = effortChoices[route];
      return name !== undefined && name !== '' && !effortOptions(route).some((option) => option.name === name);
    }),
  );
  const driftingEfforts = $derived(
    (data.settings?.effortDrift ?? []).filter((route) => selectedRoutes.includes(route)),
  );
  const executingEfforts = $derived(
    Object.fromEntries(
      Object.entries(effortChoices).filter(
        ([route, name]) => selectedRoutes.includes(route) && name !== '',
      ),
    ),
  );
  const nextSelection = $derived(
    defaults
      ? null
      : {
          reviewers,
          synthesis,
          ...(Object.keys(executingEfforts).length === 0 ? {} : { efforts: executingEfforts }),
        },
  );
  // Edit detection must compare the full saved selection, including an effort
  // on a non-executing synthesis route. A concurrency-only save then never
  // sends a filtered selection that would discard that effort.
  const editedSelection = $derived(
    defaults ? null : { reviewers, synthesis, efforts: effortChoices },
  );
  const selectionDirty = $derived(
    selectionSignature(editedSelection) !== loadedSelectionSignature,
  );
  const concurrencyOnly = $derived(concurrencyDirty && !selectionDirty);
  const selectionUnavailable = $derived(
    staleEfforts.length > 0 ||
      (!defaults &&
        (!reviewers.length ||
          reviewers.some((route) => !data.settings?.routes.includes(route)) ||
          !data.settings?.routes.includes(synthesis))),
  );
  async function reload() {
    busy = true;
    try {
      await invalidate('dashboard:model-settings');
      stale = false;
      message = '';
    } finally { busy = false; }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !data.settings) return;
    busy = true;
    success = false;
    message = '';
    try {
      // A concurrency-only save omits the selection so Core does not re-resolve
      // effort controls or require the inference relay to be reachable.
      const sendSelection = !concurrencyDirty || selectionDirty;
      const reply = await fetch('/api/model-settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revision: data.settings.configuration.revision,
          ...(sendSelection ? { selection: nextSelection } : {}),
          ...(concurrencyDirty ? { concurrency: parsedConcurrency } : {}),
        }),
      });
      if (reply.ok) {
        await invalidate('dashboard:model-settings');
        success = true;
        message = 'Saved. New reviews will use this selection.';
      } else if (reply.status === 409) {
        stale = true;
        message = 'The configuration changed. Reload the saved selection before editing again.';
      } else if (reply.status === 401 || reply.status === 403) {
        await invalidate('dashboard:model-settings');
        message = 'You no longer have access to save this selection.';
      } else {
        message = 'Could not save the selection. Reload to check the available models.';
      }
    } catch { message = 'Could not confirm the change. Reload the saved selection.'; }
    finally { busy = false; }
  }
  async function resetEffort(route: string) {
    if (busy || !data.settings) return;
    busy = true;
    success = false;
    message = '';
    try {
      const reply = await fetch('/api/model-settings/effort-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: data.settings.configuration.revision, route }),
      });
      if (reply.ok) {
        await invalidate('dashboard:model-settings');
        success = true;
        message = 'Configured thinking effort re-enabled for newly queued reviews.';
      } else if (reply.status === 409) {
        stale = true;
        message = 'The configuration changed. Reload before re-enabling this effort.';
      } else {
        message = 'Could not re-enable the configured effort. Reload and try again.';
      }
    } catch {
      message = 'Could not confirm the change. Reload the saved selection.';
    } finally {
      busy = false;
    }
  }
</script>

<section class="model-settings">
  <h1>Review models</h1>
  {#if data.status === 401}
    <a class="bx--btn bx--btn--primary" href="/auth/github?returnTo=%2Fsettings" data-sveltekit-reload>Sign in with GitHub</a>
  {:else if data.status === 403}
    <p>{data.error ?? 'Editing requires an authorized GitHub account.'}</p>
  {:else if !data.settings}
    <p>{data.error ?? 'Model settings are temporarily unavailable.'}</p>
  {:else}
    <p>Changes apply to newly admitted reviews.</p>
    {#if data.settings.catalogUnavailable}
      <p role="status">The model catalog is unavailable. Runner concurrency can still be changed.</p>
    {:else if data.settings.catalogRefreshFailed}
      <p role="status">The model list could not fully refresh. Some choices may be out of date.</p>
    {:else if data.settings.lastAttemptAt === null}
      <p role="status">Waiting for the first model list refresh.</p>
    {:else if !data.settings.routes.length}
      <p role="status">No models are currently listed.</p>
    {/if}
    {#if data.settings.effortStateUnavailable}
      <p role="status">Current thinking-effort fallback state could not be read.</p>
    {/if}
    <form onsubmit={save}>
      <fieldset disabled={busy}>
        <label><input type="checkbox" bind:checked={defaults} /> Use the instance default</label>
        {#if !defaults}
          <fieldset>
            <legend>Reviewers</legend>
            {#each Array.from(new Set([...data.settings.routes, ...reviewers])) as route (route)}
              <label><input type="checkbox" value={route} bind:group={reviewers} /> {route}{data.settings.routes.includes(route) ? '' : ' (unavailable)'}</label>
            {/each}
          </fieldset>
          <label>Synthesis model
            <select bind:value={synthesis}>
              <option value="">Select a model</option>
              {#if synthesis && !data.settings.routes.includes(synthesis)}
                <option value={synthesis} disabled>{synthesis} (unavailable)</option>
              {/if}
              {#each data.settings.routes as route (route)}<option value={route}>{route}</option>{/each}
            </select>
          </label>
          <fieldset class="efforts">
            <legend>Thinking effort</legend>
            {#if selectedRoutes.length === 0}
              <p class="muted">Select a reviewer route to configure its thinking effort.</p>
            {/if}
            {#each selectedRoutes as route (route)}
              {@const state = effortState(route)}
              {@const options = effortOptions(route)}
              {@const chosen = effortChoices[route] ?? ''}
              <div class="effort-row" data-testid={`effort-${route}`}>
                <strong>{route}</strong>
                {#if state}
                  <span class="fallback" data-testid={`effort-fallback-${route}`}>
                    Fallback · using upstream default
                  </span>
                  <span class="muted">
                    First switched {state.fallbackAt} · {state.reason}
                  </span>
                {/if}
                <label class="effort-select">Thinking effort for {route}
                  <select
                    value={chosen}
                    onchange={(event) => (effortChoices[route] = event.currentTarget.value)}
                  >
                    <option value="">Default (keep client setting)</option>
                    {#if chosen !== '' && !options.some((option) => option.name === chosen)}
                      <option value={chosen} disabled>{chosen} (unavailable)</option>
                    {/if}
                    {#each options as option (option.name)}
                      <option value={option.name}>{option.name}</option>
                    {/each}
                  </select>
                </label>
                {#if options.length === 0}
                  <span class="muted">No configurable efforts for this route.</span>
                {/if}
                {#if state}
                  <button
                    type="button"
                    class="bx--btn bx--btn--tertiary bx--btn--sm"
                    data-testid={`effort-reset-${route}`}
                    disabled={busy}
                    onclick={() => resetEffort(route)}
                  >
                    Re-enable configured effort
                  </button>
                  <span class="muted">Applies only to reviews queued after this reset.</span>
                {/if}
              </div>
            {/each}
            {#if driftingEfforts.length > 0}
              <p role="status" data-testid="effort-drift">
                The catalog controls for {driftingEfforts.join(', ')} changed since this
                selection was saved. New reviews keep the saved controls until you save this
                form; saving adopts the current catalog mapping.
              </p>
            {/if}
            {#if staleEfforts.length > 0 && !concurrencyOnly}
              <p role="alert">
                A saved thinking effort is no longer available. Choose a current effort or
                return the route to the default before saving.
              </p>
            {/if}
          </fieldset>
        {/if}
        <label class="runner-concurrency">Runner concurrency
          <input
            type="number"
            min="1"
            step="1"
            value={concurrencyDraft}
            placeholder="Runner startup default"
            oninput={(event) => (concurrencyDraft = event.currentTarget.value)}
          />
        </label>
        <p class="muted">
          Desired concurrent reviews for this deployment. Leave empty to use each Runner's
          <code>RUNNER_CONCURRENCY</code> startup fallback. Existing reviews keep running when the
          value decreases. Size hosts for the value you set.
        </p>
        {#if concurrencyInvalid}
          <p role="alert">Enter a positive whole number, or leave it empty.</p>
        {/if}
        {#if concurrencyOnly && selectionUnavailable}
          <p role="status" data-testid="concurrency-only">
            Only Runner concurrency will be saved; the saved model selection stays unchanged.
          </p>
        {/if}
        <button class="bx--btn bx--btn--primary" disabled={stale || concurrencyInvalid || (!concurrencyOnly && selectionUnavailable)}>Save changes</button>
      </fieldset>
    </form>
    {#if message}<p role={success ? 'status' : 'alert'}>{message}</p>{/if}
    {#if message && !success}<button class="bx--btn bx--btn--tertiary" onclick={reload} disabled={busy}>Reload saved selection</button>{/if}
  {/if}
</section>

<style>
  .model-settings { max-width: 42rem; display: grid; gap: 1rem; }
  h1 { font-size: 1.75rem; }
  fieldset { min-width: 0; display: grid; gap: 0.75rem; justify-items: start; }
  fieldset fieldset { border-block: 1px solid #525252; width: 100%; padding-block: 0.75rem; }
  legend { font-weight: 600; }
  label { overflow-wrap: anywhere; }
  select, input[type='number'] { display: block; margin-top: 0.5rem; max-width: 100%; background: #262626; color: #f4f4f4; padding: 0.5rem; font: inherit; }
  .runner-concurrency input { width: 12rem; }
  .efforts { gap: 1rem; }
  .effort-row { display: grid; gap: 0.5rem; justify-items: start; border-top: 1px solid #393939; padding-top: 0.75rem; width: 100%; }
  .effort-row:first-of-type { border-top: 0; padding-top: 0; }
  .fallback { color: #ff8389; font-weight: 600; }
  .muted { color: #c6c6c6; font-size: 0.875rem; }
</style>

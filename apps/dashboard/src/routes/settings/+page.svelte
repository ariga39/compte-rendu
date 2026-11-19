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
      const reply = await fetch('/api/model-settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: data.settings.configuration.revision, selection: defaults ? null : { reviewers, synthesis } }),
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
</script>

<section class="model-settings">
  <h1>Review models</h1>
  {#if data.status === 401}
    <a class="bx--btn bx--btn--primary" href="/auth/github" data-sveltekit-reload>Sign in with GitHub</a>
  {:else if data.status === 403}
    <p>{data.error ?? 'Editing requires an authorized GitHub account.'}</p>
  {:else if !data.settings}
    <p>{data.error ?? 'Model settings are temporarily unavailable.'}</p>
  {:else}
    <p>Changes apply to newly admitted reviews.</p>
    {#if data.settings.catalogRefreshFailed}
      <p role="status">The model list could not fully refresh. Some choices may be out of date.</p>
    {:else if !data.settings.routes.length}
      <p role="status">No models are currently listed.</p>
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
        {/if}
        <button class="bx--btn bx--btn--primary" disabled={stale || (!defaults && (!reviewers.length || reviewers.some(r => !data.settings?.routes.includes(r)) || !data.settings.routes.includes(synthesis)))}>Save changes</button>
      </fieldset>
    </form>
    {#if message}<p role={success ? 'status' : 'alert'}>{message}</p>{/if}
    {#if message && !success}<button class="bx--btn bx--btn--tertiary" onclick={reload} disabled={busy}>Reload saved selection</button>{/if}
  {/if}
  {#if data.settings || data.status === 403}
    <form method="POST" action="/auth/logout"><button class="bx--btn bx--btn--ghost">Sign out</button></form>
  {/if}
</section>

<style>
  .model-settings { max-width: 42rem; display: grid; gap: 1rem; }
  h1 { font-size: 1.75rem; }
  fieldset { min-width: 0; display: grid; gap: 0.75rem; justify-items: start; }
  fieldset fieldset { border-block: 1px solid #525252; width: 100%; padding-block: 0.75rem; }
  legend { font-weight: 600; }
  label { overflow-wrap: anywhere; }
  select { display: block; margin-top: 0.5rem; max-width: 100%; background: #262626; color: #f4f4f4; padding: 0.5rem; font: inherit; }
</style>

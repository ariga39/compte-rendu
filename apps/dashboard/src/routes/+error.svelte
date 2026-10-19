<script lang="ts">
  import { page } from '$app/state';
</script>

<section class="detail">
  <header class="page-head">
    <h1>{page.status === 404 ? 'Review not found' : 'Reviews are temporarily unavailable'}</h1>
  </header>
  <p class="muted">
    {page.status === 404
      ? 'This dashboard address does not identify a review.'
      : 'Please try again in a moment.'}
  </p>
  <div class="toolbar">
    {#if page.status !== 404}
      <a
        class="bx--btn bx--btn--primary"
        href={page.url.pathname + page.url.search}
        data-sveltekit-reload
      >Try again</a>
    {/if}
    <a class="bx--btn bx--btn--tertiary" href="/history">Back to history</a>
  </div>
</section>

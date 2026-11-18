import { error } from '@sveltejs/kit';
import { QueryClient, dehydrate } from '@tanstack/svelte-query';
import { parseRetryAfter } from './api';

/** Prefetch only document requests; client navigation uses the live query. */
export async function loadDashboard(fetcher: typeof fetch, key: string, url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await client.fetchQuery({
      queryKey: ['dashboard', key],
      queryFn: async () => {
        const startedAt = Date.now();
        let response: Response;
        try {
          response = await fetcher(url, { signal: AbortSignal.timeout(15000) });
        } catch {
          error(503, 'Reviews are temporarily unavailable.');
        }
        if (!response.ok)
          error(
            response.status >= 400 && response.status < 500 ? response.status : 503,
            response.status === 400
              ? 'Invalid history link.'
              : response.status === 404
                ? 'Review not found.'
                : 'Reviews are temporarily unavailable.',
          );
        const result = {
          ok: true,
          status: response.status,
          data: await response.json(),
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        };
        return { result, startedAt, receivedAt: Date.now() };
      },
    });
    return dehydrate(client);
  } finally {
    client.clear();
  }
}

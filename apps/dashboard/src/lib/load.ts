import { error } from '@sveltejs/kit';
import { QueryClient, dehydrate } from '@tanstack/svelte-query';
import { parseRetryAfter } from './api';

/** Prefetch only document requests; client navigation uses the live query. */
export async function loadDashboard(fetcher: typeof fetch, key: string, urls: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await client.fetchQuery({
      queryKey: ['dashboard', key],
      queryFn: async () => {
        const startedAt = Date.now();
        const results = await Promise.all(
          urls.map(async (url) => {
            let response: Response;
            try {
              response = await fetcher(url, { signal: AbortSignal.timeout(15000) });
            } catch {
              error(503, 'Reviews are temporarily unavailable.');
            }
            if (!response.ok)
              error(
                response.status === 404 ? 404 : 503,
                response.status === 404
                  ? 'Review not found.'
                  : 'Reviews are temporarily unavailable.',
              );
            return {
              ok: true,
              status: response.status,
              data: await response.json(),
              retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
            };
          }),
        );
        return { results, startedAt, receivedAt: Date.now() };
      },
    });
    return dehydrate(client);
  } finally {
    client.clear();
  }
}

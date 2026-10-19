import { loadDashboard } from '#lib/load.ts';
import { historyRequestUrl } from '#lib/filters.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ fetch, url, isDataRequest }) => ({
  dehydrated: isDataRequest
    ? undefined
    : await loadDashboard(fetch, `/history${url.search}`, [historyRequestUrl(url.search)]),
});

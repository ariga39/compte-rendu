import { loadDashboard } from '#lib/load.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ fetch, isDataRequest }) => ({
  dehydrated: isDataRequest ? undefined : await loadDashboard(fetch, '/', ['/api/dashboard']),
});

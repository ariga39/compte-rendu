import { loadDashboard } from '#lib/load.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ fetch, params, isDataRequest }) => ({
  dehydrated: isDataRequest
    ? undefined
    : await loadDashboard(fetch, `/jobs/${params.runId}`, [
        `/api/jobs/${encodeURIComponent(params.runId)}`,
      ]),
});

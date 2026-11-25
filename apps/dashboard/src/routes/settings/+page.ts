import type {
  EffortRouteState,
  ReviewConfiguration,
  RouteEffortOption,
} from '@compte-rendu/contracts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, depends }) => {
  depends('dashboard:model-settings');
  const reply = await fetch('/api/model-settings');
  if (!reply.ok) {
    const failure: unknown = await reply.json().catch(() => null);
    return {
      settings: null,
      status: reply.status,
      error:
        failure &&
        typeof failure === 'object' &&
        'error' in failure &&
        typeof failure.error === 'string'
          ? failure.error
          : null,
    };
  }
  const settings = (await reply.json()) as {
    configuration: ReviewConfiguration & { concurrency?: number | null };
    routes: string[];
    efforts?: Record<string, readonly RouteEffortOption[]>;
    effortStates?: readonly EffortRouteState[];
    effortStateUnavailable?: boolean;
    effortDrift?: readonly string[];
    catalogRefreshFailed: boolean;
    catalogUnavailable?: boolean;
    lastAttemptAt: string | null;
  };
  return { settings, status: reply.status, error: null };
};

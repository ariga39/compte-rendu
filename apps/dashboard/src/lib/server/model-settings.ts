import { canonicalDashboardOrigin } from '@compte-rendu/contracts';
import type { EffortRouteState, RouteEffortOption } from '@compte-rendu/contracts';
import {
  applyReviewConfiguration,
  resetReviewEffort,
} from '../../../../core/src/review-configuration';
import type { ApplicationEnv } from './application';
import { noStore, requireOperator } from './auth';

export type { LoginEnv } from './auth';

interface SavedEffort {
  routeId: string;
  generation: number;
  name?: string;
  controls?: unknown;
}

const readSavedEfforts = async (env: ApplicationEnv): Promise<readonly SavedEffort[]> => {
  const row = await env.REVIEW_DB.prepare(
    'SELECT effort_snapshot FROM review_configuration WHERE id = 1',
  ).first<{ effort_snapshot: string | null }>();
  if (row?.effort_snapshot == null) return [];
  try {
    const parsed: unknown = JSON.parse(row.effort_snapshot);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SavedEffort =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { routeId?: unknown }).routeId === 'string' &&
        typeof (entry as { generation?: unknown }).generation === 'number' &&
        ((entry as { name?: unknown }).name === undefined ||
          typeof (entry as { name?: unknown }).name === 'string') &&
        ((entry as { controls?: unknown }).controls === undefined ||
          (typeof (entry as { controls?: unknown }).controls === 'object' &&
            (entry as { controls?: unknown }).controls !== null)),
    );
  } catch {
    // An unreadable snapshot simply hides stale fallback markers and drift.
    return [];
  }
};

const catalogDrift = (
  saved: readonly SavedEffort[],
  efforts: Readonly<Record<string, readonly RouteEffortOption[]>> | undefined,
): readonly string[] =>
  saved
    .filter((entry) => {
      if (entry.name === undefined || entry.controls === undefined) return false;
      const current = efforts?.[entry.routeId]?.find((option) => option.name === entry.name);
      if (current === undefined) return false;
      return JSON.stringify(current.controls) !== JSON.stringify(entry.controls);
    })
    .map((entry) => entry.routeId);

export async function modelSettings(request: Request, env: ApplicationEnv): Promise<Response> {
  const url = new URL(request.url);
  const origin = canonicalDashboardOrigin(env.DASHBOARD_ORIGIN);
  const id = env.DASHBOARD_GITHUB_CLIENT_ID;
  const secret = env.DASHBOARD_GITHUB_CLIENT_SECRET;
  if (!origin || url.origin !== origin || !id || !secret)
    return noStore(503, { error: 'Login is unavailable.' });
  let unavailable = 'Model settings are temporarily unavailable.';
  const sameOrigin = request.headers.get('origin') === origin;
  const resetPath = url.pathname === '/api/model-settings/effort-reset';
  try {
    if (url.pathname !== '/api/model-settings' && !resetPath) return noStore(404);
    if (resetPath ? request.method !== 'POST' : !['GET', 'PUT'].includes(request.method))
      return noStore(405);
    if (request.method !== 'GET' && !sameOrigin) return noStore(403);
    const operator = await requireOperator(
      request,
      env,
      'This GitHub account is not authorized to edit review models.',
    );
    if (operator instanceof Response) return operator;
    unavailable = 'Could not load the model catalog.';
    if (!env.INFERENCE_RELAY) return noStore(503, { error: unavailable });
    if (resetPath) return resetReviewEffort(request, env.REVIEW_DB);
    if (request.method === 'PUT')
      return applyReviewConfiguration(request, env.REVIEW_DB, env.INFERENCE_RELAY);
    const { routes, efforts, lastAttemptAt, lastRefreshError } =
      await env.INFERENCE_RELAY.catalog();
    const saved = await readSavedEfforts(env);
    const generations = new Map(saved.map((entry) => [entry.routeId, entry.generation]));
    let effortStates: readonly EffortRouteState[] = [];
    let effortStateUnavailable = false;
    if (env.INFERENCE_RELAY.effortStates !== undefined) {
      try {
        // A reset advances Core's generation without clearing the relay row.
        // A state from an older generation no longer applies to new requests.
        effortStates = (await env.INFERENCE_RELAY.effortStates()).routes.filter(
          (state) => state.generation >= (generations.get(state.routeId) ?? 0),
        );
      } catch {
        effortStateUnavailable = true;
      }
    }
    unavailable = 'Could not read the saved model configuration.';
    const config = await applyReviewConfiguration(request, env.REVIEW_DB);
    return config.ok
      ? noStore(200, {
          configuration: await config.json(),
          routes,
          efforts: (efforts ?? {}) satisfies Readonly<Record<string, readonly RouteEffortOption[]>>,
          effortStates,
          effortStateUnavailable,
          effortDrift: catalogDrift(saved, efforts),
          catalogRefreshFailed: lastRefreshError !== null,
          lastAttemptAt,
        })
      : config;
  } catch {
    return noStore(503, { error: unavailable });
  }
}

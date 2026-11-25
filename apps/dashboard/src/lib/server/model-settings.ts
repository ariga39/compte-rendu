import { canonicalDashboardOrigin } from '@compte-rendu/contracts';
import type { EffortRouteState, RouteEffortOption } from '@compte-rendu/contracts';
import { Effect } from 'effect';
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

export function modelSettings(request: Request, env: ApplicationEnv): Effect.Effect<Response> {
  const url = new URL(request.url);
  const origin = canonicalDashboardOrigin(env.DASHBOARD_ORIGIN);
  const id = env.DASHBOARD_GITHUB_CLIENT_ID;
  const secret = env.DASHBOARD_GITHUB_CLIENT_SECRET;
  if (!origin || url.origin !== origin || !id || !secret)
    return Effect.succeed(noStore(503, { error: 'Login is unavailable.' }));
  const sameOrigin = request.headers.get('origin') === origin;
  const resetPath = url.pathname === '/api/model-settings/effort-reset';
  if (url.pathname !== '/api/model-settings' && !resetPath) return Effect.succeed(noStore(404));
  if (resetPath ? request.method !== 'POST' : !['GET', 'PUT'].includes(request.method))
    return Effect.succeed(noStore(405));
  if (request.method !== 'GET' && !sameOrigin) return Effect.succeed(noStore(403));
  let unavailable = 'Model settings are temporarily unavailable.';
  return Effect.gen(function* () {
    const operator = yield* Effect.tryPromise(() =>
      requireOperator(request, env, 'This GitHub account is not authorized to edit review models.'),
    );
    if (operator instanceof Response) return operator;
    if (resetPath) return yield* resetReviewEffort(request, env.REVIEW_DB);
    if (request.method === 'PUT')
      return yield* applyReviewConfiguration(request, env.REVIEW_DB, env.INFERENCE_RELAY);
    // Catalog failure must not hide the saved configuration: concurrency uses
    // the same revision CAS and does not need route or effort resolution.
    const catalog =
      env.INFERENCE_RELAY === undefined
        ? undefined
        : yield* Effect.tryPromise(() => env.INFERENCE_RELAY!.catalog()).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
    const catalogUnavailable = catalog === undefined;
    const routes: readonly string[] = catalog?.routes ?? [];
    const efforts: Readonly<Record<string, readonly RouteEffortOption[]>> = catalog?.efforts ?? {};
    const lastAttemptAt = catalog?.lastAttemptAt ?? null;
    const saved = yield* Effect.tryPromise(() => readSavedEfforts(env));
    const generations = new Map(saved.map((entry) => [entry.routeId, entry.generation]));
    let effortStates: readonly EffortRouteState[] = [];
    let effortStateUnavailable = false;
    if (env.INFERENCE_RELAY?.effortStates !== undefined) {
      // A reset advances Core's generation without clearing the relay row.
      // A state from an older generation no longer applies to new requests.
      const states = yield* Effect.promise(() =>
        env.INFERENCE_RELAY!.effortStates!()
          .then((value) => ({ kind: 'ok' as const, value }))
          .catch(() => ({ kind: 'failed' as const })),
      );
      if (states.kind === 'failed') effortStateUnavailable = true;
      else
        effortStates = states.value.routes.filter(
          (state) => state.generation >= (generations.get(state.routeId) ?? 0),
        );
    }
    unavailable = 'Could not read the saved model configuration.';
    const config = yield* applyReviewConfiguration(request, env.REVIEW_DB);
    return config.ok
      ? noStore(200, {
          configuration: yield* Effect.tryPromise(() => config.json()),
          routes,
          efforts,
          effortStates,
          effortStateUnavailable,
          effortDrift: catalogDrift(saved, efforts),
          catalogRefreshFailed: catalog !== undefined && catalog.lastRefreshError !== null,
          catalogUnavailable,
          lastAttemptAt,
        })
      : config;
  }).pipe(
    Effect.catch(() => Effect.succeed(noStore(503, { error: unavailable }))),
    Effect.catchDefect(() => Effect.succeed(noStore(503, { error: unavailable }))),
  );
}

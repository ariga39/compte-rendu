import { Effect, Option, Schema } from 'effect';
import {
  FrozenRouteEffort,
  ModelRouteId,
  ReviewModelSelection,
  readBoundedRequestBody,
  type RouteEffortOption,
} from '@compte-rendu/contracts';
import type { D1DatabaseLike } from './review-state-store';

interface ConfigurationRow {
  readonly revision: number;
  readonly selection: string | null;
  readonly effort_snapshot?: string | null;
  readonly runner_concurrency?: number | null;
}

interface ConcurrencyRow {
  readonly runner_concurrency: number | null;
}

interface GenerationRow {
  readonly route_id: string;
  readonly generation: number;
}

const response = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

type CatalogReader = {
  catalog(): Promise<{
    readonly routes: readonly string[];
    readonly efforts?: Readonly<Record<string, readonly RouteEffortOption[]>>;
  }>;
};

const DecodedEffortSnapshot = Schema.fromJsonString(Schema.Array(FrozenRouteEffort));

const decodeSnapshot = (value: string | null | undefined) =>
  value == null
    ? []
    : Option.getOrElse(
        Schema.decodeUnknownOption(DecodedEffortSnapshot)(value),
        () => [] as readonly FrozenRouteEffort[],
      );

const configuredRoutes = (selection: ReviewModelSelection): string[] => [
  ...new Set([...selection.reviewers, selection.synthesis]),
];

// A single reviewer returns directly and never calls the synthesis route, so
// only multi-reviewer jobs freeze or grant the synthesis route.
const executionRoutes = (selection: ReviewModelSelection): string[] =>
  selection.reviewers.length > 1 ? configuredRoutes(selection) : [selection.reviewers[0]!];

// Matches the predecessor TOML contract: any positive safe integer. Hardware
// safety remains an operator sizing decision, not a product-enforced cap.
const DesiredRunnerConcurrency = Schema.Int.check(Schema.isGreaterThan(0));

const ConfigurationInput = Schema.fromJsonString(
  Schema.Struct({
    revision: Schema.Natural,
    // Omitted preserves the installed selection and effort snapshot. This is
    // how a concurrency-only change avoids relay and effort re-resolution.
    selection: Schema.optional(Schema.NullOr(ReviewModelSelection)),
    // Omitted preserves the stored override. Explicit null clears it so each
    // Runner returns to its RUNNER_CONCURRENCY startup fallback.
    concurrency: Schema.optional(Schema.NullOr(DesiredRunnerConcurrency)),
  }),
);

export type DesiredRunnerConcurrencyState =
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'default' }
  | { readonly kind: 'unavailable' };

/**
 * Reads the deployment's desired Runner concurrency without claiming work.
 * A successful NULL read is an explicit default; a failed read is unavailable
 * so a Runner does not mistake a transient D1 problem for an operator clear.
 */
export const readDesiredRunnerConcurrency = async (
  database: D1DatabaseLike,
): Promise<DesiredRunnerConcurrencyState> => {
  try {
    const row = await database
      .prepare('SELECT runner_concurrency FROM review_configuration WHERE id = 1')
      .first<ConcurrencyRow>();
    if (row === null) return { kind: 'unavailable' };
    if (row.runner_concurrency == null) return { kind: 'default' };
    const decoded = Schema.decodeUnknownOption(DesiredRunnerConcurrency)(row.runner_concurrency);
    return Option.isSome(decoded)
      ? { kind: 'value', value: decoded.value }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
};

const concurrencyOf = (row: ConfigurationRow): number | null => row.runner_concurrency ?? null;

const readGenerations = async (database: D1DatabaseLike): Promise<Map<string, number>> => {
  const rows = await database
    .prepare('SELECT route_id, generation FROM review_effort_generations')
    .all<GenerationRow>();
  return new Map(rows.results.map((row) => [row.route_id, row.generation]));
};

const buildSnapshot = (input: {
  readonly selection: ReviewModelSelection;
  readonly catalog: {
    readonly routes: readonly string[];
    readonly efforts?: Readonly<Record<string, readonly RouteEffortOption[]>>;
  };
  readonly generations: ReadonlyMap<string, number>;
}): readonly FrozenRouteEffort[] | undefined => {
  const routes = executionRoutes(input.selection);
  const configured = configuredRoutes(input.selection);
  const requested = input.selection.efforts ?? {};
  if (Object.keys(requested).some((route) => !configured.includes(route))) return undefined;
  const allowed = new Set(input.catalog.routes);
  if (routes.some((route) => !allowed.has(route))) return undefined;
  const snapshot: FrozenRouteEffort[] = [];
  for (const routeId of routes) {
    const generation = input.generations.get(routeId) ?? 0;
    const name = requested[routeId];
    if (name === undefined) {
      // A default generation adds nothing: the relay has no fallback state to
      // apply before generation 0 advances, and a generation-only entry on a
      // non-Chat route would be rejected. Preserve only a nonzero generation so
      // an ordinary post-reset save cannot reactivate the old shared marker.
      if (generation > 0) snapshot.push({ routeId, generation });
      continue;
    }
    const option = input.catalog.efforts?.[routeId]?.find((entry) => entry.name === name);
    if (option === undefined) return undefined;
    snapshot.push({ routeId, generation, name, controls: option.controls });
  }
  return snapshot;
};

const parseSnapshot = (raw: string | null | undefined): readonly FrozenRouteEffort[] =>
  decodeSnapshot(raw);

const readConfiguration = async (database: D1DatabaseLike) =>
  database
    .prepare(
      `SELECT revision, selection, effort_snapshot, runner_concurrency
       FROM review_configuration WHERE id = 1`,
    )
    .first<ConfigurationRow>();

const decodeStoredSelection = (raw: string | null): ReviewModelSelection | null | undefined => {
  if (raw === null) return null;
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ReviewModelSelection), {
    onExcessProperty: 'error',
  })(raw);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

export const handleReviewConfiguration = (
  request: Request,
  database: D1DatabaseLike,
  operatorToken: string | undefined,
  relay?: CatalogReader,
): Effect.Effect<Response> => {
  if (!operatorToken?.trim() || request.headers.get('authorization') !== `Bearer ${operatorToken}`)
    return Effect.succeed(response({ error: 'unauthorized' }, 401));
  return applyReviewConfiguration(request, database, relay);
};

export const applyReviewConfiguration = (
  request: Request,
  database: D1DatabaseLike,
  relay?: CatalogReader,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (request.method === 'GET') {
      const row = yield* Effect.tryPromise(() => readConfiguration(database));
      if (row === null) return response({ error: 'configuration unavailable' }, 503);
      const selection = decodeStoredSelection(row.selection);
      if (selection === undefined) return response({ error: 'configuration unavailable' }, 503);
      return response({ revision: row.revision, selection, concurrency: concurrencyOf(row) });
    }
    if (request.method !== 'PUT') return response({ error: 'method not allowed' }, 405);
    const body = yield* Effect.tryPromise(() => readBoundedRequestBody(request, 16 * 1024));
    if (body.kind === 'too-large') return response({ error: 'configuration too large' }, 413);
    const configuration = Schema.decodeUnknownOption(ConfigurationInput, {
      onExcessProperty: 'error',
    })(body.text);
    if (Option.isNone(configuration)) return response({ error: 'invalid configuration' }, 400);
    const selectionInput = configuration.value.selection;
    const concurrency = configuration.value.concurrency;
    if (selectionInput === undefined && concurrency === undefined)
      return response({ error: 'invalid configuration' }, 400);
    let snapshot: readonly FrozenRouteEffort[] | null = null;
    if (selectionInput !== undefined && selectionInput !== null) {
      if (!relay) return response({ error: 'catalog unavailable' }, 503);
      const catalog = yield* Effect.tryPromise(() => relay.catalog());
      const generations = yield* Effect.tryPromise(() => readGenerations(database));
      const built = buildSnapshot({ selection: selectionInput, catalog, generations });
      if (built === undefined) return response({ error: 'model effort unavailable' }, 400);
      snapshot = built;
    }
    const selectionProvided = selectionInput === undefined ? 0 : 1;
    const selectionValue =
      selectionInput === undefined || selectionInput === null
        ? null
        : JSON.stringify(selectionInput);
    const concurrencyProvided = concurrency === undefined ? 0 : 1;
    // One revision CAS for every combination. Omitted columns are preserved in
    // place, so a concurrency-only update never re-reads or rewrites the
    // selection and frozen effort snapshot.
    const row = yield* Effect.tryPromise(() =>
      database
        .prepare(
          `UPDATE review_configuration
           SET revision = revision + 1,
               selection = CASE WHEN ? THEN ? ELSE selection END,
               effort_snapshot = CASE WHEN ? THEN ? ELSE effort_snapshot END,
               runner_concurrency = CASE WHEN ? THEN ? ELSE runner_concurrency END
           WHERE id = 1 AND revision = ?
           RETURNING revision, selection, runner_concurrency`,
        )
        .bind(
          selectionProvided,
          selectionValue,
          selectionProvided,
          snapshot === null ? null : JSON.stringify(snapshot),
          concurrencyProvided,
          concurrency === undefined ? null : concurrency,
          configuration.value.revision,
        )
        .first<ConfigurationRow>(),
    );
    if (row === null)
      return response({ error: 'configuration changed; reload before saving' }, 409);
    const storedSelection = decodeStoredSelection(row.selection);
    if (storedSelection === undefined) return response({ error: 'configuration unavailable' }, 503);
    return response({
      revision: row.revision,
      selection: storedSelection,
      concurrency: concurrencyOf(row),
    });
  }).pipe(
    Effect.catch(() => Effect.succeed(response({ error: 'configuration unavailable' }, 503))),
  );

export const resetReviewEffort = (
  request: Request,
  database: D1DatabaseLike,
  occurredAt: string = new Date().toISOString(),
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (request.method !== 'POST') return response({ error: 'method not allowed' }, 405);
    const body = yield* Effect.tryPromise(() => readBoundedRequestBody(request, 16 * 1024));
    if (body.kind === 'too-large') return response({ error: 'configuration too large' }, 413);
    const input = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({ revision: Schema.Natural, route: ModelRouteId })),
      { onExcessProperty: 'error' },
    )(body.text);
    if (Option.isNone(input)) return response({ error: 'invalid reset' }, 400);
    const row = yield* Effect.tryPromise(() => readConfiguration(database));
    if (row === null) return response({ error: 'configuration unavailable' }, 503);
    if (row.revision !== input.value.revision)
      return response({ error: 'configuration changed; reload before resetting' }, 409);
    const selection = decodeStoredSelection(row.selection);
    if (selection === undefined) return response({ error: 'configuration unavailable' }, 503);
    if (selection === null || !executionRoutes(selection).includes(input.value.route))
      return response({ error: 'model route is not configured' }, 400);

    const generations = yield* Effect.tryPromise(() => readGenerations(database));
    const current = new Map(
      parseSnapshot(row.effort_snapshot).map((entry) => [entry.routeId, entry]),
    );
    const target = current.get(input.value.route);
    const targetGeneration =
      Math.max(generations.get(input.value.route) ?? 0, target?.generation ?? 0) + 1;
    const entryFor = (
      routeId: string,
      generation: number,
      existing: FrozenRouteEffort | undefined,
    ): FrozenRouteEffort =>
      existing?.name === undefined || existing.controls === undefined
        ? { routeId, generation }
        : { routeId, generation, name: existing.name, controls: existing.controls };
    const nextSnapshot = executionRoutes(selection).flatMap((routeId) => {
      const existing = current.get(routeId);
      if (routeId === input.value.route) return [entryFor(routeId, targetGeneration, existing)];
      const generation = Math.max(generations.get(routeId) ?? 0, existing?.generation ?? 0);
      return existing?.name !== undefined || generation > 0
        ? [entryFor(routeId, generation, existing)]
        : [];
    });
    const results = yield* Effect.tryPromise(() =>
      database.batch([
        database
          .prepare(
            `INSERT INTO review_effort_generations (route_id, generation, reset_at)
             SELECT ?, ?, ? WHERE EXISTS (
               SELECT 1 FROM review_configuration WHERE id = 1 AND revision = ?
             )
             ON CONFLICT(route_id) DO UPDATE SET
               generation = excluded.generation, reset_at = excluded.reset_at`,
          )
          .bind(input.value.route, targetGeneration, occurredAt, input.value.revision),
        database
          .prepare(
            `UPDATE review_configuration SET revision = revision + 1, effort_snapshot = ?
             WHERE id = 1 AND revision = ?`,
          )
          .bind(JSON.stringify(nextSnapshot), input.value.revision),
      ]),
    );
    if (results.some((result) => result.meta.changes !== 1))
      return response({ error: 'configuration changed; reload before resetting' }, 409);
    return response({ revision: row.revision + 1, selection });
  }).pipe(
    Effect.catch(() => Effect.succeed(response({ error: 'configuration unavailable' }, 503))),
  );

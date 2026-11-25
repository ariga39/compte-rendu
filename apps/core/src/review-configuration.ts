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

const ConfigurationInput = Schema.fromJsonString(
  Schema.Struct({
    revision: Schema.Natural,
    selection: Schema.NullOr(ReviewModelSelection),
  }),
);

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
    .prepare('SELECT revision, selection, effort_snapshot FROM review_configuration WHERE id = 1')
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
): Promise<Response> => {
  if (!operatorToken?.trim() || request.headers.get('authorization') !== `Bearer ${operatorToken}`)
    return Promise.resolve(response({ error: 'unauthorized' }, 401));
  return applyReviewConfiguration(request, database, relay);
};

export const applyReviewConfiguration = (
  request: Request,
  database: D1DatabaseLike,
  relay?: CatalogReader,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (request.method === 'GET') {
        const row = yield* Effect.tryPromise(() => readConfiguration(database));
        if (row === null) return response({ error: 'configuration unavailable' }, 503);
        const selection = decodeStoredSelection(row.selection);
        if (selection === undefined) return response({ error: 'configuration unavailable' }, 503);
        return response({ revision: row.revision, selection });
      }
      if (request.method !== 'PUT') return response({ error: 'method not allowed' }, 405);
      const body = yield* Effect.tryPromise(() => readBoundedRequestBody(request, 16 * 1024));
      if (body.kind === 'too-large') return response({ error: 'configuration too large' }, 413);
      const configuration = Schema.decodeUnknownOption(ConfigurationInput, {
        onExcessProperty: 'error',
      })(body.text);
      if (Option.isNone(configuration)) return response({ error: 'invalid configuration' }, 400);
      const selected = configuration.value.selection;
      let snapshot: readonly FrozenRouteEffort[] | null = null;
      if (selected !== null) {
        if (!relay) return response({ error: 'catalog unavailable' }, 503);
        const catalog = yield* Effect.tryPromise(() => relay.catalog());
        const generations = yield* Effect.tryPromise(() => readGenerations(database));
        const built = buildSnapshot({ selection: selected, catalog, generations });
        if (built === undefined) return response({ error: 'model effort unavailable' }, 400);
        snapshot = built;
      }
      const row = yield* Effect.tryPromise(() =>
        database
          .prepare(
            `UPDATE review_configuration SET revision = revision + 1, selection = ?,
               effort_snapshot = ?
             WHERE id = 1 AND revision = ? RETURNING revision, selection`,
          )
          .bind(
            selected === null ? null : JSON.stringify(selected),
            snapshot === null ? null : JSON.stringify(snapshot),
            configuration.value.revision,
          )
          .first<ConfigurationRow>(),
      );
      if (row === null)
        return response({ error: 'configuration changed; reload before saving' }, 409);
      return response({ revision: row.revision, selection: selected });
    }).pipe(
      Effect.catch(() => Effect.succeed(response({ error: 'configuration unavailable' }, 503))),
    ),
  );

export const resetReviewEffort = (
  request: Request,
  database: D1DatabaseLike,
  occurredAt: string = new Date().toISOString(),
): Promise<Response> =>
  Effect.runPromise(
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
    ),
  );

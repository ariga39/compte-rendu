import { Effect, Option, Schema } from 'effect';
import {
  FrozenRouteEffort,
  REVIEW_ATTEMPT_BUDGET_MS,
  ModelRouteLimit,
  type ModelRouteDescriptor,
} from '@compte-rendu/contracts';
import { FrozenRouteMapping, RouteId, legacyFrozenMapping, type FrozenRoute } from './routes.ts';

export const GRANT_TTL_MS = 4 * REVIEW_ATTEMPT_BUDGET_MS;

const PRIMARY_CLOCK_MS = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

export const ResolvedGrantSnapshot = Schema.Struct({
  routes: Schema.Array(RouteId).check(
    Schema.isMinLength(1),
    Schema.makeFilter((routes) => new Set(routes).size === routes.length, {
      expected: 'distinct routes',
    }),
  ),
  efforts: Schema.optionalKey(
    Schema.Array(FrozenRouteEffort).check(
      Schema.makeFilter(
        (efforts) => new Set(efforts.map((effort) => effort.routeId)).size === efforts.length,
        { expected: 'distinct effort routes' },
      ),
    ),
  ),
});
export type ResolvedGrantSnapshot = typeof ResolvedGrantSnapshot.Type;

export const IssueGrantInput = Schema.Struct({
  jobId: Schema.NonEmptyString,
  snapshot: ResolvedGrantSnapshot,
  latestIssueDeadline: Schema.Natural,
});
export type IssueGrantInput = typeof IssueGrantInput.Type;

export type IssueGrantResult =
  | { readonly kind: 'issued'; readonly token: string; readonly expiresAt: string }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'deadline-exceeded' }
  | { readonly kind: 'invalid' };

export type IssueGrantV2Result =
  | {
      readonly kind: 'issued';
      readonly token: string;
      readonly expiresAt: string;
      readonly descriptors: readonly ModelRouteDescriptor[];
    }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'deadline-exceeded' }
  | { readonly kind: 'invalid' };

export const RevokeGrantInput = Schema.Struct({ jobId: Schema.NonEmptyString });
export type RevokeGrantInput = typeof RevokeGrantInput.Type;

export type RevokeGrantResult = { readonly kind: 'revoked' } | { readonly kind: 'invalid' };

export interface InferenceGrantControl {
  issue(input: IssueGrantInput): Promise<IssueGrantResult>;
  issueV2(input: IssueGrantInput): Promise<IssueGrantV2Result>;
  revoke(input: RevokeGrantInput): Promise<RevokeGrantResult>;
}

export interface D1ResultLike {
  readonly meta: {
    readonly changes: number;
  };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<D1ResultLike>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ readonly results: readonly T[] }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]>;
}

const base64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const randomToken = (): string => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
};

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

interface CatalogRouteRow {
  readonly routeId: string;
  readonly upstreamModel: string;
  readonly providerSlug: string;
  readonly credentialAlias: string;
  readonly profile: FrozenRoute['profile'];
  readonly limit_json: string | null;
}

const decodeStoredLimit = Schema.decodeUnknownOption(Schema.fromJsonString(ModelRouteLimit), {
  onExcessProperty: 'error',
});

const issueFor = (database: D1DatabaseLike, version: 1 | 2) =>
  Effect.fn('InferenceGrantControl.issue')(function* (input: IssueGrantInput) {
    const decoded = Schema.decodeUnknownOption(IssueGrantInput, {
      onExcessProperty: 'error',
    })(input);
    if (Option.isNone(decoded)) return { kind: 'invalid' as const };

    const rows = yield* Effect.promise(() =>
      database
        .prepare(
          `SELECT route_id AS routeId, upstream_model AS upstreamModel,
                 provider_slug AS providerSlug, credential_alias AS credentialAlias,
                 profile, limit_json
          FROM catalog_routes
          WHERE route_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify(decoded.value.snapshot.routes))
        .all<CatalogRouteRow>(),
    );
    const routes: FrozenRoute[] = [];
    for (const row of rows.results) {
      const { limit_json: limitJson, ...route } = row;
      if (limitJson === null) {
        routes.push(route);
        continue;
      }
      const limit = decodeStoredLimit(limitJson);
      if (Option.isNone(limit)) return { kind: 'invalid' as const };
      routes.push({ ...route, limit: limit.value });
    }
    const catalog = new Map(routes.map((route) => [route.routeId, route]));
    const frozen = Schema.decodeUnknownOption(FrozenRouteMapping)(
      decoded.value.snapshot.routes.map((id) => catalog.get(id)),
    );
    if (Option.isNone(frozen)) return { kind: 'invalid' as const };
    // v1 is a Chat Completions-only legacy contract. It must not hand a non-chat
    // profile to a Runner that cannot route it, and it must never silently drop
    // an explicit effort selection.
    if (version === 1) {
      if ((decoded.value.snapshot.efforts?.length ?? 0) > 0) return { kind: 'invalid' as const };
      if (frozen.value.some((route) => route.profile !== 'chat'))
        return { kind: 'invalid' as const };
    }

    // The frozen snapshot is authoritative; never re-check against the mutable
    // catalog effort menu. Validate only protocol/route compatibility here.
    const effortByRoute = new Map(
      (decoded.value.snapshot.efforts ?? []).map((effort) => [effort.routeId, effort]),
    );
    const withEffort: FrozenRoute[] = [];
    for (const route of frozen.value) {
      const effort = effortByRoute.get(route.routeId);
      if (effort === undefined) {
        withEffort.push(route);
        continue;
      }
      // Explicit controls are Chat-only. Generation-only metadata is accepted
      // for any granted profile and ignored where it has no meaning, so a legacy
      // Chat snapshot stays usable after the route's profile changes.
      if (effort.name !== undefined && route.profile !== 'chat')
        return { kind: 'invalid' as const };
      withEffort.push({
        ...route,
        effortGeneration: effort.generation,
        ...(effort.name === undefined || effort.controls === undefined
          ? {}
          : { effort: { name: effort.name, controls: effort.controls } }),
      });
    }
    if (effortByRoute.size !== (decoded.value.snapshot.efforts ?? []).length)
      return { kind: 'invalid' as const };
    for (const routeId of effortByRoute.keys())
      if (!catalog.has(routeId)) return { kind: 'invalid' as const };

    const token = randomToken();
    const tokenHash = yield* Effect.promise(() => sha256Hex(token));
    const inserted = yield* Effect.promise(() =>
      database
        .prepare(
          `WITH clock(now) AS (SELECT ${PRIMARY_CLOCK_MS})
          INSERT INTO grants (
            job_id, token_hash, snapshot, route_mapping, issued_at, expires_at,
            latest_issue_deadline, revoked_at
          )
          SELECT ?, ?, ?, ?, now, now + ?, ?, NULL
          FROM clock
          WHERE now < ?
          ON CONFLICT(job_id) DO NOTHING`,
        )
        .bind(
          decoded.value.jobId,
          tokenHash,
          JSON.stringify(decoded.value.snapshot),
          JSON.stringify(version === 1 ? legacyFrozenMapping(withEffort) : withEffort),
          GRANT_TTL_MS,
          decoded.value.latestIssueDeadline,
          decoded.value.latestIssueDeadline,
        )
        .run(),
    );
    if (inserted.meta.changes === 0) {
      const existing = yield* Effect.promise(() =>
        database
          .prepare('SELECT job_id FROM grants WHERE job_id = ?')
          .bind(decoded.value.jobId)
          .first<{ readonly job_id: string }>(),
      );
      return existing === null
        ? { kind: 'deadline-exceeded' as const }
        : { kind: 'duplicate' as const };
    }

    const stored = yield* Effect.promise(() =>
      database
        .prepare('SELECT expires_at FROM grants WHERE job_id = ?')
        .bind(decoded.value.jobId)
        .first<{ readonly expires_at: number }>(),
    );
    if (stored === null) return yield* Effect.die(new Error('issued grant row disappeared'));

    return {
      kind: 'issued' as const,
      token,
      expiresAt: new Date(stored.expires_at).toISOString(),
      frozen: withEffort,
    };
  });

export const createGrantControl = (database: D1DatabaseLike): InferenceGrantControl => {
  const issue = issueFor(database, 1);
  const issueV2 = issueFor(database, 2);

  const revoke = Effect.fn('InferenceGrantControl.revoke')(function* (input: RevokeGrantInput) {
    const decoded = Schema.decodeUnknownOption(RevokeGrantInput, {
      onExcessProperty: 'error',
    })(input);
    if (Option.isNone(decoded)) return { kind: 'invalid' as const };

    yield* Effect.promise(() =>
      database.batch([
        database
          .prepare(
            `WITH clock(now) AS (SELECT ${PRIMARY_CLOCK_MS})
            INSERT INTO grants (
              job_id, token_hash, snapshot, route_mapping, issued_at, expires_at,
              latest_issue_deadline, revoked_at
            )
            SELECT ?, NULL, NULL, NULL, now, now + ?, now, now
            FROM clock
            WHERE true
            ON CONFLICT(job_id) DO UPDATE SET
              revoked_at = COALESCE(grants.revoked_at, excluded.revoked_at)`,
          )
          .bind(decoded.value.jobId, GRANT_TTL_MS),
        database
          .prepare(
            `UPDATE inference_requests
            SET status = 'incomplete', finalized_at = ${PRIMARY_CLOCK_MS}
            WHERE job_id = ? AND status = 'pending'`,
          )
          .bind(decoded.value.jobId),
      ]),
    );
    return { kind: 'revoked' as const };
  });

  return {
    issue: (input) => Effect.runPromise(issue(input)),
    issueV2: async (input) => {
      const result = await Effect.runPromise(issueV2(input));
      if (result.kind !== 'issued') return result;
      return {
        kind: 'issued',
        token: result.token,
        expiresAt: result.expiresAt,
        descriptors: result.frozen.map(({ routeId, profile, limit }) => ({
          routeId,
          profile,
          ...(limit === undefined ? {} : { limit }),
        })),
      };
    },
    revoke: (input) => Effect.runPromise(revoke(input)),
  };
};

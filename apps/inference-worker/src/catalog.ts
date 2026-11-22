import { Schema } from 'effect';
import type { ModelProfile, ModelRouteLimit } from '@compte-rendu/contracts';
import {
  CatalogModelId,
  MAX_CATALOG_MODELS,
  MAX_CATALOG_PAGES,
  CATALOG_TIMEOUT_MS,
  PUBLIC_USER_AGENT,
  readModelCatalogPage,
} from './model-catalog-wire';
import type { D1DatabaseLike } from './grants';
import { gatewayHeaders, gatewayUrl, type GatewayConfig } from './gateway';
import { isGeminiUpstreamModel } from './routes';
import {
  sourceDefaultProfile,
  sourceProfiles,
  type RelayCatalogSource as Source,
} from './catalog-config';

const validId = Schema.is(CatalogModelId);

const normalizedLimit = (limit: ModelRouteLimit): ModelRouteLimit => ({
  ...(limit.context === undefined ? {} : { context: limit.context }),
  ...(limit.output === undefined ? {} : { output: limit.output }),
});
export interface RelayCatalogSnapshot {
  readonly routes: readonly string[];
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly rejected: number;
  readonly lastRefreshError: string | null;
}

interface RouteModel {
  readonly model: string;
  readonly profile: ModelProfile;
  readonly limit: ModelRouteLimit | null;
}

interface CatalogRead {
  readonly models: Record<string, RouteModel>;
  readonly rejected: number;
}

const readSource = async (
  source: Extract<Source, { prefix: string }>,
  gateway: GatewayConfig | null,
): Promise<CatalogRead> => {
  const headers: Record<string, string> = { accept: 'application/json' };
  let url: string;
  if ('discovery' in source) {
    if (gateway === null) throw new Error('Gateway unavailable');
    url = gatewayUrl(gateway, source.providerSlug, '/models');
    Object.assign(headers, gatewayHeaders(gateway, source.credentialAlias));
  } else {
    const target = new URL(source.url);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    )
      throw new Error('invalid public catalog');
    url = target.href;
    headers['user-agent'] = PUBLIC_USER_AGENT;
  }

  const models: Record<string, RouteModel> = {};
  const allowedProfiles = sourceProfiles(source);
  const preferredProfile = sourceDefaultProfile(source);
  // A source with no profile configuration keeps the historical behaviour:
  // every discovered ID is published as a Chat Completions route.
  const qualified = source.profiles !== undefined || source.profile !== undefined;
  let rejected = 0;
  const visited = new Set([url]);
  const signal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const response = await fetch(url, { headers, redirect: 'manual', signal });
    const result = await readModelCatalogPage(response, url);
    rejected += result.rejected;
    const overrides = 'models' in source ? source.models : undefined;
    for (const entry of result.models) {
      const routeId = source.prefix + entry.id;
      if (!validId(entry.id) || !validId(routeId)) {
        rejected += 1;
        continue;
      }
      // An explicit no-tools capability always wins, including over an
      // operator default. Review profiles require local tools.
      if (entry.toolsSupported === false) continue;
      // An ID-only listing establishes visibility only. When an explicit
      // allowlist is configured, it is the trusted review-capability source:
      // discovered IDs not named there stay invisible.
      const override = overrides?.[routeId];
      if (overrides !== undefined && override === undefined) continue;
      const profile =
        override !== undefined
          ? override.profile
          : !qualified
            ? 'chat'
            : entry.profiles === null
              ? // An ID-only listing cannot verify a non-chat operation.
                // Qualified sources may still expose a chat default, but
                // Responses, Messages and Gemini require an explicit
                // `models` override.
                preferredProfile === 'chat'
                ? 'chat'
                : undefined
              : (() => {
                  const supported = allowedProfiles.filter((candidate) =>
                    entry.profiles!.includes(candidate),
                  );
                  if (supported.length === 0) return undefined;
                  if (entry.recommended !== null && supported.includes(entry.recommended))
                    return entry.recommended;
                  if (supported.includes(preferredProfile)) return preferredProfile;
                  return supported[0];
                })();
      // A well-formed model that offers none of the configured protocols is
      // omitted rather than failing the source snapshot.
      if (profile === undefined) continue;
      if (profile === 'gemini' && !isGeminiUpstreamModel(entry.id)) {
        rejected += 1;
        continue;
      }
      models[routeId] = { model: entry.id, profile, limit: override?.limit ?? null };
    }
    if (result.next === null) return { models, rejected };
    if (visited.has(result.next)) throw new Error('catalog continuation loop');
    visited.add(result.next);
    url = result.next;
  }
  throw new Error('catalog pagination limit');
};

interface CandidateSource {
  key: string;
  provider: string;
  credential: string;
  aliases?: Record<string, string>;
  load(): Promise<CatalogRead>;
}

const sameLimit = (left: ModelRouteLimit | null, right: ModelRouteLimit | null): boolean =>
  (left?.context ?? null) === (right?.context ?? null) &&
  (left?.output ?? null) === (right?.output ?? null);

const sameRouteModel = (left: RouteModel, right: RouteModel): boolean =>
  left.model === right.model &&
  left.profile === right.profile &&
  sameLimit(left.limit, right.limit);

function candidateSources(sources: readonly Source[], gateway: GatewayConfig | null) {
  const groups = new Map<string, CandidateSource>();
  const aliases = new Map<
    string,
    {
      readonly provider: string;
      readonly credential: string;
      readonly models: Record<string, string>;
      readonly resolved: Record<string, RouteModel>;
      invalid: boolean;
    }
  >();
  for (const source of sources) {
    const provider = source.providerSlug;
    const credential = source.credentialAlias;
    if (source.aliases && Object.keys(source.aliases).length) {
      const key = JSON.stringify(['aliases', provider, credential]);
      const group = aliases.get(key) ?? {
        provider,
        credential,
        models: {},
        resolved: {},
        invalid: false,
      };
      const overrides = 'models' in source ? source.models : undefined;
      for (const [id, model] of Object.entries(source.aliases)) {
        group.models[id] = model;
        const override = overrides?.[id];
        if (overrides !== undefined && override === undefined) continue;
        const resolved: RouteModel = {
          model,
          profile: override?.profile ?? sourceDefaultProfile(source),
          limit: override?.limit ?? null,
        };
        if (resolved.profile === 'gemini' && !isGeminiUpstreamModel(model)) {
          group.invalid = true;
          continue;
        }
        const existing = group.resolved[id];
        if (existing !== undefined && !sameRouteModel(existing, resolved)) {
          // Two producing sources disagree about the same route's model,
          // profile or limit. Fail this source refresh rather than letting
          // configuration order decide which descriptor wins.
          group.invalid = true;
          continue;
        }
        group.resolved[id] = resolved;
      }
      aliases.set(key, group);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          provider,
          credential,
          aliases: group.models,
          load: async () => {
            if (group.invalid) return { models: {}, rejected: 1 };
            return { models: { ...group.resolved }, rejected: 0 };
          },
        });
      }
    }
    if (!('prefix' in source)) continue;
    const key = JSON.stringify([
      provider,
      credential,
      source.prefix,
      'url' in source ? source.url : 'gateway',
    ]);
    groups.set(key, {
      key,
      provider,
      credential,
      async load() {
        return readSource(source, gateway);
      },
    });
  }
  return [...groups.values()];
}

// Compare configured limits by their semantic fields, not JSON key order.
const canonicalLimit = (json: string) =>
  `(CASE WHEN ${json} IS NULL THEN '' ELSE coalesce(CAST(json_extract(${json}, '$.context') AS TEXT), '') || '|' || coalesce(CAST(json_extract(${json}, '$.output') AS TEXT), '') END)`;
const storedLimit = `coalesce((SELECT ${canonicalLimit('l.value')} FROM json_each(s.route_limits) l WHERE l.key=m.key), '')`;

// Both the picker and the budget count the same set, preferring discovered IDs
// when an alias refers to exactly the same upstream model, credential, profile
// and configured limit.
const active = `SELECT m.key AS id, m.value AS model, s.provider, s.credential,
  coalesce((SELECT p.value FROM json_each(s.route_profiles) p WHERE p.key=m.key), 'chat') AS profile,
  ${storedLimit} AS limit_key,
  s.is_alias
  FROM catalog_sources s JOIN json_each(?) cfg ON cfg.key=s.source_key, json_each(s.models) m
  WHERE (s.is_alias=0 OR EXISTS (SELECT 1 FROM json_each(cfg.value) a WHERE a.key=m.key AND a.value=m.value))`;
const visible = `SELECT DISTINCT id FROM (
  SELECT id, is_alias, MIN(is_alias) OVER (PARTITION BY provider, credential, model, profile, limit_key) AS preferred
  FROM candidates
) WHERE is_alias = preferred`;

// Every statement in the D1 batch observes this watermark. Advance it last so
// a slow fetch from an older cron invocation cannot undo a newer snapshot.
const fresh = '(SELECT last_attempt IS NULL OR last_attempt < ? FROM catalog_refresh WHERE id=1)';

export function createRelayCatalog(
  db: D1DatabaseLike,
  sources: readonly Source[],
  gateway?: GatewayConfig | null,
) {
  const groups = candidateSources(sources, gateway ?? null);
  const configured = JSON.stringify(
    Object.fromEntries(groups.map((group) => [group.key, group.aliases ?? null])),
  );
  return {
    async refresh(at: number) {
      const statements = [
        db
          .prepare(`DELETE FROM catalog_sources WHERE source_key NOT IN
        (SELECT key FROM json_each(?)) AND ${fresh}`)
          .bind(configured, at),
      ];
      for (const group of groups) {
        let models: Record<string, RouteModel> = {};
        let rejected = 0;
        let error: string | null = null;
        try {
          const result = await group.load();
          models = result.models;
          rejected =
            result.rejected +
            Object.entries(models).filter(([id, route]) => !validId(id) || !validId(route.model))
              .length;
          if (rejected) error = 'refresh failed';
          if (Object.keys(models).length > MAX_CATALOG_MODELS) error = 'catalog limit reached';
        } catch {
          error = 'refresh failed';
        }
        const proposedModels = JSON.stringify(
          error
            ? {}
            : Object.fromEntries(Object.entries(models).map(([id, route]) => [id, route.model])),
        );
        const proposedProfiles = JSON.stringify(
          error
            ? {}
            : Object.fromEntries(Object.entries(models).map(([id, route]) => [id, route.profile])),
        );
        const proposedLimits = JSON.stringify(
          error
            ? {}
            : Object.fromEntries(
                Object.entries(models).flatMap(([id, route]) =>
                  route.limit === null ? [] : [[id, normalizedLimit(route.limit)]],
                ),
              ),
        );
        const { key, provider, credential } = group;
        const alias = Number(group.aliases !== undefined);
        statements.push(
          db
            .prepare(`WITH candidates AS (
              ${active} AND s.source_key <> ?
              UNION ALL SELECT m.key, m.value, ?, ?, coalesce(p.value,'chat'),
                coalesce((SELECT ${canonicalLimit('l.value')} FROM json_each(?) l WHERE l.key=m.key), ''),
                ?
                FROM json_each(?) m LEFT JOIN json_each(?) p ON p.key=m.key
            )
            INSERT INTO catalog_sources(source_key, provider, credential, is_alias, rejected, error)
            SELECT ?, ?, ?, ?, ?, CASE
              WHEN ? IS NOT NULL THEN ?
              WHEN EXISTS (SELECT 1 FROM json_each(?) m
                LEFT JOIN json_each(?) p ON p.key=m.key
                JOIN catalog_routes r ON r.route_id=m.key
                WHERE r.upstream_model IS NOT m.value
                  OR r.provider_slug IS NOT ?
                  OR r.credential_alias IS NOT ?
                  OR r.profile IS NOT coalesce(p.value,'chat')
                  OR ${canonicalLimit('r.limit_json')} IS NOT
                    coalesce((SELECT ${canonicalLimit('l.value')} FROM json_each(?) l WHERE l.key=m.key), ''))
                THEN 'route mapping conflict'
              WHEN (SELECT COUNT(*) FROM (${visible})) > ? THEN 'catalog limit reached'
            END WHERE ${fresh}
            ON CONFLICT(source_key) DO UPDATE SET rejected=excluded.rejected,error=excluded.error`)
            .bind(
              configured,
              key,
              provider,
              credential,
              proposedLimits,
              alias,
              proposedModels,
              proposedProfiles,
              key,
              provider,
              credential,
              alias,
              rejected,
              error,
              error,
              proposedModels,
              proposedProfiles,
              provider,
              credential,
              proposedLimits,
              MAX_CATALOG_MODELS,
              at,
            ),
          db
            .prepare(
              `UPDATE catalog_sources SET models=?, route_profiles=?, route_limits=? WHERE source_key=? AND error IS NULL AND ${fresh}`,
            )
            .bind(proposedModels, proposedProfiles, proposedLimits, key, at),
          db
            .prepare(`INSERT INTO catalog_routes(route_id, upstream_model, provider_slug, credential_alias, profile, limit_json)
            SELECT m.key, m.value, s.provider, s.credential,
              coalesce((SELECT p.value FROM json_each(s.route_profiles) p WHERE p.key=m.key), 'chat'),
              (SELECT l.value FROM json_each(s.route_limits) l WHERE l.key=m.key)
            FROM catalog_sources s,json_each(s.models) m
            WHERE s.source_key=? AND s.error IS NULL AND ${fresh}
            ON CONFLICT(route_id) DO NOTHING`)
            .bind(key, at),
        );
      }
      statements.push(
        db
          .prepare(`UPDATE catalog_refresh SET last_attempt=?,
        rejected=coalesce((SELECT sum(rejected) FROM catalog_sources),0),
        error=(SELECT error FROM catalog_sources WHERE error IS NOT NULL ORDER BY source_key LIMIT 1),
        last_complete=CASE WHEN NOT EXISTS(SELECT 1 FROM catalog_sources WHERE error IS NOT NULL) THEN ? ELSE last_complete END
        WHERE id=1 AND ${fresh}`)
          .bind(at, at, at),
      );
      await db.batch(statements);
    },
    async get(): Promise<RelayCatalogSnapshot> {
      const meta = await db
        .prepare(`WITH candidates AS (${active})
        SELECT (SELECT json_group_array(id) FROM (${visible} ORDER BY id)) AS routes,
          EXISTS (SELECT 1 FROM catalog_sources JOIN json_each(?) cfg ON cfg.key=source_key) AS initialized,
          last_attempt,last_complete,rejected,error FROM catalog_refresh WHERE id=1`)
        .bind(configured, configured)
        .first<{
          routes: string;
          initialized: number;
          last_attempt: number | null;
          last_complete: number | null;
          rejected: number;
          error: string | null;
        }>();
      if (!meta) throw new Error('catalog unavailable');
      if (!meta.initialized)
        return {
          routes: [],
          lastAttemptAt: null,
          lastSuccessAt: null,
          rejected: 0,
          lastRefreshError: null,
        };
      return {
        routes: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
          meta.routes,
        ),
        lastAttemptAt:
          meta.last_attempt === null ? null : new Date(meta.last_attempt).toISOString(),
        lastSuccessAt:
          meta.last_complete === null ? null : new Date(meta.last_complete).toISOString(),
        rejected: meta.rejected,
        lastRefreshError: meta.error,
      };
    },
  };
}

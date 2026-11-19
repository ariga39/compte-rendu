import { Schema } from 'effect';
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
import type { RelayCatalogSource as Source } from './catalog-config';

const validId = Schema.is(CatalogModelId);
export interface RelayCatalogSnapshot {
  readonly routes: readonly string[];
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly rejected: number;
  readonly lastRefreshError: string | null;
}

interface CatalogRead {
  readonly ids: readonly string[];
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

  const ids: string[] = [];
  let rejected = 0;
  const visited = new Set([url]);
  const signal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const response = await fetch(url, { headers, redirect: 'manual', signal });
    const result = await readModelCatalogPage(response, url);
    ids.push(...result.ids);
    rejected += result.rejected;
    if (result.next === null) return { ids, rejected };
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
  aliases: boolean;
  load(): Promise<{ models: Record<string, string>; rejected: number }>;
}

function candidateSources(sources: readonly Source[], gateway: GatewayConfig | null) {
  const groups = new Map<string, CandidateSource>();
  for (const source of sources) {
    const provider = source.providerSlug;
    const credential = source.credentialAlias;
    if (source.aliases && Object.keys(source.aliases).length) {
      const models = Object.fromEntries(
        Object.entries(source.aliases).sort(([a], [b]) => a.localeCompare(b)),
      );
      const key = JSON.stringify([provider, credential, 'aliases', models]);
      groups.set(key, {
        key,
        provider,
        credential,
        aliases: true,
        load: async () => ({ models, rejected: 0 }),
      });
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
      aliases: false,
      async load() {
        const { ids, rejected } = await readSource(source, gateway);
        return {
          models: Object.fromEntries(ids.map((model) => [source.prefix + model, model])),
          rejected,
        };
      },
    });
  }
  return [...groups.values()];
}

// Both the picker and the budget count the same set, preferring discovered IDs
// when an alias refers to exactly the same upstream model and credential.
const active = `SELECT m.key AS id, m.value AS model, s.provider, s.credential, s.is_alias
  FROM catalog_sources s, json_each(s.models) m
  WHERE s.source_key IN (SELECT value FROM json_each(?))`;
const visible = `SELECT DISTINCT id FROM (
  SELECT id, is_alias, MIN(is_alias) OVER (PARTITION BY provider, credential, model) AS preferred
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
  const keys = JSON.stringify(groups.map((group) => group.key));
  return {
    async refresh(at: number) {
      const statements = [
        db
          .prepare(`DELETE FROM catalog_sources WHERE source_key NOT IN
        (SELECT value FROM json_each(?)) AND ${fresh}`)
          .bind(keys, at),
      ];
      for (const group of groups) {
        let models: Record<string, string> = {};
        let rejected = 0;
        let error: string | null = null;
        try {
          const result = await group.load();
          models = result.models;
          rejected =
            result.rejected +
            Object.entries(models).filter(([id, model]) => !validId(id) || !validId(model)).length;
          if (rejected) error = 'refresh failed';
          if (Object.keys(models).length > MAX_CATALOG_MODELS) error = 'catalog limit reached';
        } catch {
          error = 'refresh failed';
        }
        const proposed = JSON.stringify(error ? {} : models);
        const { key, provider, credential } = group;
        const alias = Number(group.aliases);
        statements.push(
          db
            .prepare(`WITH candidates AS (
              ${active} AND s.source_key <> ?
              UNION ALL SELECT key, value, ?, ?, ? FROM json_each(?)
            )
            INSERT INTO catalog_sources(source_key, provider, credential, is_alias, rejected, error)
            SELECT ?, ?, ?, ?, ?, CASE
              WHEN ? IS NOT NULL THEN ?
              WHEN EXISTS (SELECT 1 FROM json_each(?) m JOIN catalog_routes r ON r.route_id=m.key
                WHERE (r.upstream_model,r.provider_slug,r.credential_alias) <> (m.value,?,?))
                THEN 'route mapping conflict'
              WHEN (SELECT COUNT(*) FROM (${visible})) > ? THEN 'catalog limit reached'
            END WHERE ${fresh}
            ON CONFLICT(source_key) DO UPDATE SET rejected=excluded.rejected,error=excluded.error`)
            .bind(
              keys,
              key,
              provider,
              credential,
              alias,
              proposed,
              key,
              provider,
              credential,
              alias,
              rejected,
              error,
              error,
              proposed,
              provider,
              credential,
              MAX_CATALOG_MODELS,
              at,
            ),
          db
            .prepare(
              `UPDATE catalog_sources SET models=? WHERE source_key=? AND error IS NULL AND ${fresh}`,
            )
            .bind(proposed, key, at),
          db
            .prepare(`INSERT INTO catalog_routes(route_id, upstream_model, provider_slug, credential_alias)
            SELECT m.key, m.value, s.provider, s.credential FROM catalog_sources s,json_each(s.models) m
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
      const [routes, meta] = await Promise.all([
        db
          .prepare(`WITH candidates AS (${active}) ${visible} ORDER BY id`)
          .bind(keys)
          .all<{ id: string }>(),
        db
          .prepare(
            'SELECT last_attempt,last_complete,rejected,error FROM catalog_refresh WHERE id=1',
          )
          .first<{
            last_attempt: number | null;
            last_complete: number | null;
            rejected: number;
            error: string | null;
          }>(),
      ]);
      if (!meta) throw new Error('catalog unavailable');
      return {
        routes: routes.results.map((r) => r.id),
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

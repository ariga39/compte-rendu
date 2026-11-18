import { Option, Schema } from 'effect';
import {
  CatalogModelId,
  MAX_CATALOG_MODELS,
  CATALOG_TIMEOUT_MS,
  PUBLIC_USER_AGENT,
  readModelCatalog,
} from '../../llm-service/src/model-catalog-wire';
import type { D1DatabaseLike } from './grants';

import { gatewayHeaders, gatewayUrl, type GatewayConfig } from './gateway';
import type { RelayCatalogSource as Source } from './catalog-config';
type Mapping = { id: string; model: string; provider: string; alias: string };
const validId = Schema.decodeUnknownOption(CatalogModelId);

export interface RelayCatalogSnapshot {
  readonly routes: readonly string[];
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly rejected: number;
  readonly lastRefreshError: string | null;
}

export function createRelayCatalog(
  db: D1DatabaseLike,
  sources: readonly Source[],
  gateway?: GatewayConfig | null,
) {
  return {
    async refresh(at: number) {
      let rejected = 0;
      let error: string | null = null;
      const mappings = new Map<string, Mapping>();
      const add = (id: string, model: string, source: Source) => {
        if (Option.isNone(validId(id)) || Option.isNone(validId(model))) {
          rejected++;
          return;
        }
        if (!mappings.has(id))
          mappings.set(id, {
            id,
            model,
            provider: source.providerSlug,
            alias: source.credentialAlias,
          });
      };
      for (const s of sources)
        for (const [id, model] of Object.entries(s.aliases ?? {})) add(id, model, s);
      for (const source of sources) {
        if (!('prefix' in source)) continue;
        try {
          const headers: Record<string, string> = { accept: 'application/json' };
          let url: string;
          if ('discovery' in source) {
            if (!gateway) throw new Error('Gateway unavailable');
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
          const response = await fetch(url, {
            headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
          });
          const result = await readModelCatalog(response);
          rejected += result.rejected;
          for (const model of result.ids) add(source.prefix + model, model, source);
        } catch {
          error = 'refresh failed';
        }
      }
      const rows = JSON.stringify([...mappings.values()]);
      const missing = `SELECT value FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM catalog_routes WHERE route_id = json_extract(value,'$.id'))`;
      await db.batch([
        db
          .prepare(`INSERT INTO catalog_routes(route_id,upstream_model,provider_slug,credential_alias)
          SELECT json_extract(value,'$.id'), json_extract(value,'$.model'), json_extract(value,'$.provider'), json_extract(value,'$.alias')
          FROM (${missing}) LIMIT max(0,? - (SELECT COUNT(*) FROM catalog_routes))`)
          .bind(rows, MAX_CATALOG_MODELS),
        db
          .prepare(`WITH result(error) AS (SELECT coalesce(?,CASE WHEN EXISTS (
            SELECT 1 FROM json_each(?) JOIN catalog_routes ON route_id = json_extract(value,'$.id')
            WHERE upstream_model <> json_extract(value,'$.model') OR provider_slug <> json_extract(value,'$.provider')
              OR credential_alias <> json_extract(value,'$.alias')
          ) THEN 'route mapping conflict' WHEN EXISTS (${missing}) THEN 'catalog limit reached' END))
          UPDATE catalog_refresh SET last_attempt=?, rejected=?, error=(SELECT error FROM result),
          last_complete=CASE WHEN (SELECT error FROM result) IS NULL THEN ? ELSE last_complete END
          WHERE id=1 AND (last_attempt IS NULL OR last_attempt<=?)`)
          .bind(error, rows, rows, at, rejected, at, at),
      ]);
    },
    async get(): Promise<RelayCatalogSnapshot> {
      const [models, meta] = await Promise.all([
        db
          .prepare('SELECT route_id FROM catalog_routes ORDER BY route_id')
          .all<{ route_id: string }>(),
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
        routes: models.results.map((row) => row.route_id),
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

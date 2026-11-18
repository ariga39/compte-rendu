import { Effect, Option, Schema } from 'effect';
import type { LiteLlmRoute } from './upstream';

import {
  CatalogModelId,
  MAX_CATALOG_MODELS,
  CATALOG_TIMEOUT_MS,
  PUBLIC_USER_AGENT,
  readModelCatalog,
} from './model-catalog-wire';
export { CatalogModelId } from './model-catalog-wire';

export type CatalogSource =
  | {
      readonly kind: 'backend';
      readonly label: 'backend';
      readonly url: string;
      readonly credential: () => Promise<string>;
    }
  | {
      readonly kind: 'public';
      readonly label: string;
      readonly url: string;
      readonly prefix: string;
    };

type SourceResult = { readonly ok: true; readonly ids: readonly string[] } | { readonly ok: false };

export class ModelCatalog {
  readonly #sources: readonly CatalogSource[];
  readonly #models = new Map<string, LiteLlmRoute>();
  readonly #controller = new AbortController();
  #closed = false;
  #refreshing: Promise<void> | null = null;
  #intervalMs = 60000;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastAttemptAt: string | null = null;
  #lastSuccessAt: string | null = null;
  #lastRefreshError: string | null = null;

  constructor(options: { readonly sources: readonly CatalogSource[] }) {
    this.#sources = options.sources;
  }

  ids(): readonly string[] {
    return [...this.#models.keys()].sort();
  }

  routes(): readonly LiteLlmRoute[] {
    return [...this.#models.values()];
  }

  lastAttemptAt(): string | null {
    return this.#lastAttemptAt;
  }

  lastSuccessAt(): string | null {
    return this.#lastSuccessAt;
  }

  lastRefreshError(): string | null {
    return this.#lastRefreshError;
  }

  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#refreshing !== null) return this.#refreshing;
    this.#refreshing = this.#refresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  start(intervalMs: number): void {
    if (this.#closed || this.#timer !== null) return;
    this.#intervalMs = intervalMs;
    this.#schedule();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#controller.abort();
  }

  #schedule(): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.refresh().finally(() => this.#schedule());
    }, this.#intervalMs);
  }

  async #refresh(): Promise<void> {
    const attemptAt = new Date().toISOString();
    this.#lastAttemptAt = attemptAt;
    const results = await Promise.all(this.#sources.map((source) => this.#fetchSource(source)));
    if (this.#closed) return;
    let complete = true;
    let sourceFailed = false;
    let truncated = false;
    for (const result of results) {
      if (!result.ok) {
        complete = false;
        sourceFailed = true;
        continue;
      }
      for (const id of result.ids) {
        if (this.#models.has(id)) continue;
        if (this.#models.size >= MAX_CATALOG_MODELS) {
          complete = false;
          truncated = true;
          break;
        }
        this.#models.set(id, { id, model: id, protocol: 'chat-completions' });
      }
    }
    if (truncated) Effect.runSync(Effect.logWarning('llm.catalog.limit_reached'));
    if (complete) {
      this.#lastSuccessAt = attemptAt;
      this.#lastRefreshError = null;
    } else {
      this.#lastRefreshError = sourceFailed ? 'refresh failed' : 'catalog limit reached';
    }
  }

  async #fetchSource(source: CatalogSource): Promise<SourceResult> {
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (source.kind === 'backend') {
        headers.authorization = `Bearer ${await source.credential()}`;
      } else {
        headers['user-agent'] = PUBLIC_USER_AGENT;
      }
      const response = await fetch(source.url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.any([this.#controller.signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]),
      });
      const decoded = await readModelCatalog(response);
      const ids: string[] = [];
      let rejected = decoded.rejected;
      for (const id of decoded.ids) {
        const candidate = source.kind === 'public' ? `${source.prefix}${id}` : id;
        const route = Option.getOrUndefined(Schema.decodeUnknownOption(CatalogModelId)(candidate));
        if (route === undefined) {
          rejected += 1;
          continue;
        }
        ids.push(route);
      }
      if (rejected > 0)
        Effect.runSync(
          Effect.logWarning('llm.catalog.entries_rejected', {
            source: source.label,
            count: rejected,
          }),
        );
      return { ok: true, ids };
    } catch {
      if (this.#closed) return { ok: false };
      Effect.runSync(Effect.logWarning('llm.catalog.source_failed', { source: source.label }));
      return { ok: false };
    }
  }
}

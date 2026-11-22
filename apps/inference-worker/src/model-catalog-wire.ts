import { ModelProfile, readBoundedBody } from '@compte-rendu/contracts';
import { Option, Schema } from 'effect';

const MAX_CATALOG_BYTES = 256 * 1024;
export const MAX_CATALOG_MODELS = 1000;
export const MAX_CATALOG_PAGES = 20;
export const CATALOG_TIMEOUT_MS = 5000;
export const PUBLIC_USER_AGENT = 'compte-rendu/1.0';

export const CatalogModelId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:/-]+$/),
);

const apiEndpoint = Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown));
const apiEndpoints = {
  'chat-completions': apiEndpoint,
  responses: apiEndpoint,
  messages: apiEndpoint,
  'generate-content': apiEndpoint,
  interactions: apiEndpoint,
} as const;
const ApiProfile = {
  'chat-completions': 'chat',
  responses: 'responses',
  messages: 'messages',
  'generate-content': 'gemini',
} as const satisfies Record<string, ModelProfile>;
const CatalogEntry = Schema.Struct({
  id: Schema.String,
  api: Schema.optionalKey(Schema.Struct(apiEndpoints)),
  recommended_api: Schema.optionalKey(Schema.String),
  capabilities: Schema.optionalKey(
    Schema.Struct({
      tools: Schema.optionalKey(Schema.Struct({ supported: Schema.optionalKey(Schema.Boolean) })),
    }),
  ),
});
export interface CatalogModel {
  readonly id: string;
  /** Null means an ID-only listing without protocol metadata. */
  readonly profiles: readonly ModelProfile[] | null;
  readonly recommended: ModelProfile | null;
  readonly toolsSupported: boolean | null;
}
const optionalLink = Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString));
const noCursor = Schema.optionalKey(Schema.NullOr(Schema.Literal('')));
const paginationFields = {
  next: optionalLink,
  has_more: Schema.optionalKey(Schema.Boolean),
  hasMore: Schema.optionalKey(Schema.Boolean),
  next_cursor: noCursor,
  nextCursor: noCursor,
  next_page: noCursor,
  nextPage: noCursor,
  next_page_token: noCursor,
  nextPageToken: noCursor,
};
const CatalogEnvelope = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  ...paginationFields,
  links: Schema.optionalKey(Schema.Struct({ next: optionalLink })),
  pagination: Schema.optionalKey(Schema.Struct(paginationFields)),
});

const linkHeader = (response: Response): string[] => {
  const targets: string[] = [];
  for (const part of response.headers.get('link')?.split(/,(?=\s*<)/) ?? []) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(part);
    if (!rel) continue;
    if (!(rel[1] ?? rel[2])?.toLowerCase().split(/\s+/).includes('next')) continue;
    const match = /^\s*<([^>]+)>/.exec(part);
    if (!match?.[1]) throw new Error('invalid catalog continuation');
    targets.push(match[1]);
  }
  return targets;
};

const catalogModel = (entry: typeof CatalogEntry.Type): CatalogModel => {
  const toolsSupported = entry.capabilities?.tools?.supported ?? null;
  const supported =
    entry.api === undefined
      ? null
      : toolsSupported === false
        ? []
        : (Object.keys(ApiProfile) as (keyof typeof ApiProfile)[])
            .filter((name) => Object.hasOwn(entry.api!, name))
            .map((name) => ApiProfile[name]);
  const recommended =
    entry.recommended_api === undefined
      ? null
      : (Object.entries(ApiProfile).find(([name]) => name === entry.recommended_api)?.[1] ?? null);
  return { id: entry.id, profiles: supported, recommended, toolsSupported };
};

const NativeAnthropicPage = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Array(Schema.Struct({ id: CatalogModelId })),
    has_more: Schema.Boolean,
    last_id: Schema.optionalKey(Schema.NullOr(CatalogModelId)),
  }),
);
const PageToken = Schema.NonEmptyString.check(Schema.isMaxLength(2048));
const NativeGooglePage = Schema.fromJsonString(
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isPattern(/^models\/[a-zA-Z0-9._-]+$/)),
        supportedGenerationMethods: Schema.Array(Schema.String),
      }),
    ),
    nextPageToken: Schema.optionalKey(PageToken),
  }),
);
function cursorUrl(currentUrl: string, param: string, value: string): string {
  const next = new URL(currentUrl);
  next.searchParams.set(param, value);
  return next.href;
}

export const readModelCatalogPage = async (
  response: Response,
  currentUrl: string,
  gatewayProvider?: string,
) => {
  if (!response.ok) throw new Error('catalog unavailable');
  const body = await readBoundedBody(response.body, MAX_CATALOG_BYTES);
  if (body.kind !== 'ok') throw new Error('catalog too large');
  if (gatewayProvider === 'native:anthropic') {
    const page = Schema.decodeUnknownSync(NativeAnthropicPage)(body.text);
    if (page.has_more && !page.last_id) throw new Error('missing catalog cursor');
    return {
      models: page.data.map(catalogModel),
      rejected: 0,
      next: page.has_more && page.last_id ? cursorUrl(currentUrl, 'after_id', page.last_id) : null,
    };
  }
  if (gatewayProvider === 'native:google-ai-studio') {
    const page = Schema.decodeUnknownSync(NativeGooglePage)(body.text);
    return {
      models: page.models
        .filter((m) => m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => catalogModel({ id: m.name.slice('models/'.length) })),
      rejected: 0,
      next: page.nextPageToken ? cursorUrl(currentUrl, 'pageToken', page.nextPageToken) : null,
    };
  }
  const page = Schema.decodeUnknownSync(Schema.fromJsonString(CatalogEnvelope))(body.text);
  const current = new URL(currentUrl);
  let next: string | null = null;
  for (const link of [
    ...linkHeader(response),
    page.next,
    page.links?.next,
    page.pagination?.next,
  ]) {
    if (!link) continue;
    const url = new URL(link, current);
    if (
      url.origin !== current.origin ||
      url.pathname !== current.pathname ||
      url.username ||
      url.password ||
      url.hash ||
      (next !== null && next !== url.href)
    )
      throw new Error('invalid catalog continuation');
    next = url.href;
  }
  if (
    !next &&
    (page.has_more || page.hasMore || page.pagination?.has_more || page.pagination?.hasMore)
  )
    throw new Error('incomplete catalog');

  const models: CatalogModel[] = [];
  let rejected = 0;
  for (const entry of page.data) {
    const model = Schema.decodeUnknownOption(CatalogEntry)(entry);
    if (Option.isNone(model)) rejected++;
    else models.push(catalogModel(model.value));
  }
  return { models, rejected, next };
};

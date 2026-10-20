import { readFile, stat } from 'node:fs/promises';
import { Effect, Schema } from 'effect';
import { parse } from 'smol-toml';
import { startLlmServer } from './http-server';
import { ModelCatalog, type CatalogSource } from './model-catalog';
import { createLlmService, type LlmGrantConfiguration, type LlmRoute } from './service';
import { createLiteLlmUpstream, type LiteLlmRoute } from './upstream';

const AbsolutePath = Schema.String.check(Schema.isPattern(/^\//));
const PublicCatalog = Schema.Struct({
  url: Schema.String,
  prefix: Schema.String.check(Schema.isMaxLength(127), Schema.isPattern(/^[A-Za-z0-9._:-]+\/$/)),
});
const Discovery = Schema.Struct({
  refreshIntervalMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2_147_483_647)),
  ),
  publicCatalogs: Schema.optionalKey(Schema.Array(PublicCatalog).check(Schema.isMaxLength(16))),
});
const Config = Schema.Struct({
  controlSocket: AbsolutePath,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  upstream: Schema.Struct({
    baseUrl: Schema.NonEmptyString,
    credentialFile: AbsolutePath,
  }),
  routes: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      model: Schema.NonEmptyString,
      protocol: Schema.Literals(['chat-completions', 'responses']),
    }),
  ),
  discovery: Schema.optionalKey(Discovery),
});
type ConfigValue = typeof Config.Type;

const backendEndpoint = (baseUrl: string): URL => {
  const url = new URL(baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('invalid backend endpoint');
  return url;
};

const publicCatalogEndpoint = (value: string): URL => {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === '/'
  )
    throw new Error('invalid public catalog');
  return url;
};

const readBackendCredential = async (file: string): Promise<string> => {
  const info = await stat(file).catch(() => {
    throw new Error('model credential unavailable');
  });
  if ((info.mode & 0o077) !== 0) throw new Error('model credential must be private');
  const key = (
    await readFile(file, 'utf8').catch(() => {
      throw new Error('model credential unavailable');
    })
  ).trim();
  if (key.length === 0) throw new Error('model credential unavailable');
  return key;
};

export const readLlmConfig = (file: string) =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      const config = Schema.decodeUnknownSync(Config, { onExcessProperty: 'error' })(
        parse(await readFile(file, 'utf8')),
      );
      if (new Set(config.routes.map((route) => route.id)).size !== config.routes.length)
        throw new Error('duplicate route');
      if (config.discovery === undefined && config.routes.length === 0)
        throw new Error('missing route');
      backendEndpoint(config.upstream.baseUrl);
      for (const catalog of config.discovery?.publicCatalogs ?? [])
        publicCatalogEndpoint(catalog.url);
      return config;
    }).pipe(Effect.catch(() => Effect.fail(new Error('invalid LLM service configuration')))),
  );

const prepareConfiguredGrant = async (
  file: string,
  startup: ConfigValue,
  catalog: ModelCatalog | undefined,
): Promise<LlmGrantConfiguration> => {
  const config = await readLlmConfig(file);
  if (
    config.controlSocket !== startup.controlSocket ||
    config.port !== startup.port ||
    config.upstream.baseUrl !== startup.upstream.baseUrl ||
    config.upstream.credentialFile !== startup.upstream.credentialFile ||
    JSON.stringify(config.discovery) !== JSON.stringify(startup.discovery)
  )
    throw new Error('invalid LLM service configuration');
  const upstreamRoutes = new Map<string, LiteLlmRoute>();
  for (const route of catalog?.routes() ?? []) upstreamRoutes.set(route.id, route);
  for (const route of config.routes) upstreamRoutes.set(route.id, route);
  const routes = [...upstreamRoutes.values()];
  return {
    routes: routes.map((route): LlmRoute => ({
      id: route.id,
      path: route.protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions',
    })),
    upstream: createLiteLlmUpstream({
      baseUrl: config.upstream.baseUrl,
      routes,
      credential: () => readBackendCredential(config.upstream.credentialFile),
    }),
  };
};

export const startConfiguredService = async (file: string) => {
  const startup = await readLlmConfig(file);
  await readBackendCredential(startup.upstream.credentialFile);
  const sources: CatalogSource[] = [
    {
      kind: 'backend',
      label: 'backend',
      url: `${startup.upstream.baseUrl.replace(/\/+$/, '')}/v1/models`,
      credential: () => readBackendCredential(startup.upstream.credentialFile),
    },
    ...(startup.discovery?.publicCatalogs ?? []).map((catalog, index): CatalogSource => ({
      kind: 'public',
      label: `public-${index}`,
      url: catalog.url,
      prefix: catalog.prefix,
    })),
  ];
  const catalog = startup.discovery === undefined ? undefined : new ModelCatalog({ sources });
  if (catalog !== undefined) await catalog.refresh();
  const service = createLlmService({
    prepareGrant: () =>
      Effect.runPromise(
        Effect.tryPromise(() => prepareConfiguredGrant(file, startup, catalog)).pipe(
          Effect.catch(() =>
            Effect.logWarning('llm.configuration.reload-failed').pipe(
              Effect.andThen(Effect.fail(new Error('invalid LLM service configuration'))),
            ),
          ),
        ),
      ),
  });
  const controlService =
    catalog === undefined
      ? service
      : {
          control: async (request: Request) => {
            const url = new URL(request.url);
            if (url.pathname !== '/models') return service.control(request);
            if (request.method !== 'GET') return new Response(null, { status: 405 });
            let ids: readonly string[];
            try {
              const prepared = await prepareConfiguredGrant(file, startup, catalog);
              ids = prepared.routes.map((route) => route.id).sort();
            } catch {
              Effect.runSync(Effect.logWarning('llm.configuration.reload-failed'));
              return Response.json(
                { error: { message: 'service unavailable' } },
                { status: 503, headers: { 'cache-control': 'no-store' } },
              );
            }
            return Response.json(
              {
                ids,
                lastAttemptAt: catalog.lastAttemptAt(),
                lastSuccessAt: catalog.lastSuccessAt(),
                lastRefreshError: catalog.lastRefreshError(),
              },
              { headers: { 'cache-control': 'no-store' } },
            );
          },
          inference: (request: Request) => service.inference(request),
          close: () => {
            catalog.close();
            service.close();
          },
        };
  try {
    const server = await startLlmServer({
      service: controlService,
      controlSocket: startup.controlSocket,
      port: startup.port,
    });
    catalog?.start(startup.discovery?.refreshIntervalMs ?? 60000);
    return server;
  } catch (error) {
    catalog?.close();
    throw error;
  }
};

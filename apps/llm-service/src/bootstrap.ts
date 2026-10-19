import { readFile, stat } from 'node:fs/promises';
import { Effect, Schema } from 'effect';
import { parse } from 'smol-toml';
import { startLlmServer } from './http-server';
import { createLlmService, type LlmRoutePath } from './service';
import { createLiteLlmUpstream } from './upstream';

const AbsolutePath = Schema.String.check(Schema.isPattern(/^\//));
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
  ).check(Schema.isMinLength(1)),
});

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
      backendEndpoint(config.upstream.baseUrl);
      return config;
    }).pipe(Effect.catch(() => Effect.fail(new Error('invalid LLM service configuration')))),
  );

export const startConfiguredService = async (file: string) => {
  const config = await readLlmConfig(file);
  await readBackendCredential(config.upstream.credentialFile);
  const upstream = createLiteLlmUpstream({
    baseUrl: config.upstream.baseUrl,
    routes: config.routes,
    credential: () => readBackendCredential(config.upstream.credentialFile),
  });
  const service = createLlmService({
    routes: config.routes.map((route) => ({
      id: route.id,
      path: (route.protocol === 'responses'
        ? '/v1/responses'
        : '/v1/chat/completions') satisfies LlmRoutePath,
    })),
    upstream,
  });
  return startLlmServer({
    service,
    controlSocket: config.controlSocket,
    port: config.port,
  });
};

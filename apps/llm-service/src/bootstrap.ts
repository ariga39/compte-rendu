import { readFile, stat } from 'node:fs/promises';
import { Effect, Schema } from 'effect';
import { parse } from 'smol-toml';
import { ownSubscriptionCredential } from './credential-owner';
import { createCredentialResolver } from './credentials';
import { startLlmServer } from './http-server';
import { createLlmService, type LlmRoutePath } from './service';
import { createPiUpstream } from './upstream';

const AbsolutePath = Schema.String.check(Schema.isPattern(/^\//));
const Config = Schema.Struct({
  controlSocket: AbsolutePath,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  routes: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      provider: Schema.Literals(['opencode-go', 'openai-compatible', 'openai-codex']),
      protocol: Schema.Literals(['chat-completions', 'codex-responses']),
      model: Schema.NonEmptyString,
      baseUrl: Schema.NonEmptyString,
      credentialFile: AbsolutePath,
    }),
  ).check(Schema.isMinLength(1)),
});

export const readLlmConfig = (file: string) =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      const config = Schema.decodeUnknownSync(Config, { onExcessProperty: 'error' })(
        parse(await readFile(file, 'utf8')),
      );
      if (new Set(config.routes.map((route) => route.id)).size !== config.routes.length)
        throw new Error('duplicate route');
      for (const route of config.routes) {
        if ((route.provider === 'openai-codex') !== (route.protocol === 'codex-responses'))
          throw new Error('incompatible provider protocol');
        const url = new URL(route.baseUrl);
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          (url.protocol !== 'https:' &&
            !(
              url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            ))
        )
          throw new Error('invalid endpoint');
        if (
          route.protocol === 'codex-responses' &&
          route.baseUrl !== 'https://chatgpt.com/backend-api'
        )
          throw new Error('invalid subscription endpoint');
      }
      return config;
    }).pipe(Effect.catch(() => Effect.fail(new Error('invalid LLM service configuration')))),
  );

export const startConfiguredService = async (file: string) => {
  const config = await readLlmConfig(file);
  for (const route of config.routes) {
    const info = await stat(route.credentialFile).catch(() => {
      throw new Error('model credential unavailable');
    });
    if ((info.mode & 0o077) !== 0) throw new Error('model credential must be private');
  }
  const owners: Awaited<ReturnType<typeof ownSubscriptionCredential>>[] = [];
  try {
    for (const path of new Set(
      config.routes
        .filter((route) => route.protocol === 'codex-responses')
        .map((route) => route.credentialFile),
    )) {
      owners.push(await ownSubscriptionCredential(path));
    }
    const upstream = createPiUpstream({
      routes: config.routes,
      credential: createCredentialResolver(config.routes),
    });
    const service = createLlmService({
      routes: config.routes.map((route) => ({
        id: route.id,
        path: (route.protocol === 'codex-responses'
          ? '/v1/responses'
          : '/v1/chat/completions') satisfies LlmRoutePath,
      })),
      upstream,
    });
    const server = await startLlmServer({
      service,
      controlSocket: config.controlSocket,
      port: config.port,
    });
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        await server.close();
        await Promise.all(owners.map((owner) => owner.release()));
      })());
    for (const owner of owners) {
      owner.signal.addEventListener(
        'abort',
        () => {
          void close();
        },
        { once: true },
      );
      if (owner.signal.aborted) {
        await close();
        throw new Error('subscription credential lock lost');
      }
    }
    return { port: server.port, close };
  } catch (error) {
    await Promise.all(owners.map((owner) => owner.release()));
    throw error;
  }
};

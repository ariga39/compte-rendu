import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import { Effect, Schema } from 'effect';
import {
  createModels,
  type CredentialStore,
  type Models,
  type AuthInteraction,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { ModelRoute } from './upstream';
import { ownSubscriptionCredential } from './credential-owner';

export interface CredentialRoute extends ModelRoute {
  readonly credentialFile: string;
}
const OAuthCredential = Schema.Struct({
  type: Schema.Literal('oauth'),
  access: Schema.NonEmptyString,
  refresh: Schema.NonEmptyString,
  expires: Schema.Number,
  accountId: Schema.optionalKey(Schema.String),
});
const missing = Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }));

const readPrivate = Effect.fn('LlmCredentials.readPrivate')(function* (file: string) {
  const info = yield* Effect.tryPromise(() => stat(file));
  if ((info.mode & 0o077) !== 0)
    return yield* Effect.fail(new Error('model credential must be private'));
  return yield* Effect.tryPromise(() => readFile(file, 'utf8'));
});

const oauthStore = (file: string): CredentialStore => {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const read = async () => {
    try {
      await stat(file);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    return Schema.decodeUnknownSync(Schema.fromJsonString(OAuthCredential))(
      await Effect.runPromise(readPrivate(file)),
    );
  };
  return {
    read: () => serial(read),
    list: () =>
      serial(async () => ((await read()) ? [{ providerId: 'openai-codex', type: 'oauth' }] : [])),
    modify: (_provider, fn) =>
      serial(async () => {
        const current = await read();
        const next = await fn(current);
        if (next !== undefined && next !== current) {
          const validated = Schema.decodeUnknownSync(OAuthCredential)(next);
          const temp = `${file}.${randomUUID()}.tmp`;
          try {
            await writeFile(temp, JSON.stringify(validated), { flag: 'wx', mode: 0o600 });
            await rename(temp, file);
          } finally {
            await rm(temp, { force: true });
          }
        }
        return next ?? current;
      }),
    delete: () => serial(() => rm(file, { force: true })),
  };
};

const subscriptionModels = (file: string): Models => {
  const models = createModels({
    credentials: oauthStore(file),
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(openaiCodexProvider());
  return models;
};

export const loginSubscription = async (file: string, interaction: AuthInteraction) => {
  const owner = await ownSubscriptionCredential(file);
  try {
    return await subscriptionModels(file).login('openai-codex', 'oauth', {
      ...interaction,
      signal: AbortSignal.any([owner.signal, ...(interaction.signal ? [interaction.signal] : [])]),
    });
  } finally {
    await owner.release();
  }
};

export const createCredentialResolver = (routes: readonly CredentialRoute[]) => {
  const subscriptions = new Map<string, Models>();
  for (const route of routes) {
    if (route.protocol === 'codex-responses' && !subscriptions.has(route.credentialFile))
      subscriptions.set(route.credentialFile, subscriptionModels(route.credentialFile));
  }
  const resolve = Effect.fn('LlmCredentials.resolve')(function* (
    route: ModelRoute,
    signal: AbortSignal,
  ) {
    const configured = routes.find((candidate) => candidate.id === route.id);
    if (!configured) return yield* Effect.fail(new Error('model credential unavailable'));
    const models = subscriptions.get(configured.credentialFile);
    if (configured.protocol === 'codex-responses' && models) {
      const result = yield* Effect.tryPromise(() => models.getAuth('openai-codex', { signal }));
      if (!result?.auth.apiKey) return yield* Effect.fail(new Error('subscription login required'));
      return result.auth.apiKey;
    }
    const key = yield* readPrivate(configured.credentialFile);
    if (!key.trim()) return yield* Effect.fail(new Error('empty model credential'));
    return key.trim();
  });
  return (route: ModelRoute, signal: AbortSignal) => Effect.runPromise(resolve(route, signal));
};

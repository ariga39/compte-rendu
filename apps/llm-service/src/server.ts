import { Effect } from 'effect';
import { readLlmConfig, startConfiguredService } from './bootstrap';
import { loginSubscription } from './credentials';

const main = Effect.fn('LlmService.main')(function* () {
  const file = process.env.LLM_SERVICE_CONFIG;
  if (!file) return yield* Effect.fail(new Error('LLM_SERVICE_CONFIG is required'));
  if (process.argv[2] === 'login') {
    const config = yield* Effect.tryPromise(() => readLlmConfig(file));
    const route = config.routes.find(
      (entry) => entry.id === process.argv[3] && entry.protocol === 'codex-responses',
    );
    if (!route) return yield* Effect.fail(new Error('subscription route required'));
    yield* Effect.tryPromise(() =>
      loginSubscription(route.credentialFile, {
        signal: AbortSignal.timeout(15 * 60 * 1000),
        prompt: async (prompt) => {
          if (
            prompt.type === 'select' &&
            prompt.options.some((option) => option.id === 'device_code')
          )
            return 'device_code';
          throw new Error('unsupported login interaction');
        },
        notify: (event) => {
          if (event.type === 'device_code')
            console.log(`Open ${event.verificationUri} and enter ${event.userCode}`);
          else if (event.type === 'auth_url') console.log(event.url);
        },
      }),
    );
    console.log('Subscription login saved');
    return;
  }
  const server = yield* Effect.tryPromise(() => startConfiguredService(file));
  const shutdown = () => {
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.log(`LLM service listening on 127.0.0.1:${server.port}`);
});

void Effect.runPromise(main()).catch(() => {
  console.error(
    'LLM service failed; check configuration, private credential files and listener availability',
  );
  process.exitCode = 1;
});

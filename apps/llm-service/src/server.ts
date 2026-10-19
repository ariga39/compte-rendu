import { Effect } from 'effect';
import { startConfiguredService } from './bootstrap';

const main = Effect.fn('LlmService.main')(function* () {
  const file = process.env.LLM_SERVICE_CONFIG;
  if (!file) return yield* Effect.fail(new Error('LLM_SERVICE_CONFIG is required'));
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

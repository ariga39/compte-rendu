import { Effect, Schema } from 'effect';
import type { RunnerProcessResult, SandboxCommand } from './sandbox-runtime.js';

class CleanupRecoveryError extends Schema.TaggedError<CleanupRecoveryError>()(
  'CleanupRecoveryError',
  {},
) {}

const Policies = Schema.Struct({
  rules: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      sandbox_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      editable: Schema.Boolean,
    }),
  ),
});

const complete = (result: RunnerProcessResult) =>
  !result.timedOut &&
  !result.truncated &&
  !result.stderrTruncated &&
  !result.streamError &&
  !result.processError;

/** Recovery never removes a sandbox whose ownership cannot be reconstructed. */
export const confirmSbxCleanup = Effect.fn('confirmSbxCleanup')(function* (
  sandboxName: string,
  jobId: string,
  command: SandboxCommand,
) {
  const run = (args: readonly string[]) =>
    Effect.tryPromise({
      try: () => command(args, undefined, { captureStdout: true, captureStderr: true }),
      catch: () => new CleanupRecoveryError(),
    });
  const inspect = yield* run(['inspect', sandboxName, '--json']);
  if (
    !complete(inspect) ||
    inspect.exitCode !== 1 ||
    inspect.stdout.trim() !== '' ||
    !inspect.stderr?.split('\n').includes(`error: sandbox '${sandboxName}' not found`)
  ) {
    return yield* new CleanupRecoveryError();
  }
  const list = Effect.fn('listRecoveryPolicies')(function* () {
    const result = yield* run([
      'policy',
      'ls',
      '--json',
      '--include-inactive',
      '--type',
      'network',
    ]);
    if (!complete(result) || result.exitCode !== 0) return yield* new CleanupRecoveryError();
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Policies))(result.stdout).pipe(
      Effect.mapError(() => new CleanupRecoveryError()),
    );
  });
  const policies = yield* list();
  for (const rule of policies.rules.filter((rule) => rule.sandbox_id === sandboxName)) {
    if (!rule.editable) return yield* new CleanupRecoveryError();
    const removed = yield* run([
      'policy',
      'rm',
      'network',
      '--id',
      rule.id,
      '--sandbox',
      sandboxName,
      '--force',
    ]);
    if (!complete(removed) || removed.exitCode !== 0) return yield* new CleanupRecoveryError();
  }
  if ((yield* list()).rules.some((rule) => rule.sandbox_id === sandboxName))
    return yield* new CleanupRecoveryError();
  for (const args of [
    ['secret', 'rm', '--placeholder', `cr-${jobId}`, '--sandbox', sandboxName, '--force'],
    ['secret', 'rm', 'github', '--sandbox', sandboxName, '--force'],
  ]) {
    const result = yield* run(args);
    if (!complete(result) || result.exitCode !== 0) return yield* new CleanupRecoveryError();
  }
});

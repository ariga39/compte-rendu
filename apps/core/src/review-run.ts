import { DateTime, Effect, Option, Schema } from 'effect';
import {
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';

export interface ReviewLeaseHandle {
  readonly clear: () => Promise<void>;
  readonly rearm: () => Promise<void>;
}

export interface ReviewLeaseAdapter {
  readonly register: (input: {
    runId: string;
    attempt: number;
    generation: number;
    sandboxId: string;
    expiresAt: string;
  }) => Promise<ReviewLeaseHandle>;
}

export interface ReviewAgentResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

export interface ReviewCheckoutResult {
  readonly baseSha: string;
  readonly headSha: string;
}

export interface ReviewSandbox {
  readonly checkout: (input: {
    readonly repositoryUrl: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly checkoutToken: string;
  }) => Promise<ReviewCheckoutResult>;
  readonly removeCheckoutCredentials: () => Promise<void>;
  readonly runAgent: (input: { readonly modelCredential: string }) => Promise<ReviewAgentResult>;
  readonly destroy: () => Promise<void>;
}

export interface ReviewSandboxAdapter {
  readonly getSandbox: (sandboxId: string) => Promise<ReviewSandbox>;
}

export interface ReviewRunAdapters {
  readonly lease: ReviewLeaseAdapter;
  readonly sandbox: ReviewSandboxAdapter;
  readonly log?: OperationalLog;
}

export interface ReviewRunSpec {
  readonly runId: string;
  readonly repositoryUrl: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly checkoutToken: string;
  readonly modelCredential: string;
  readonly maxAttempts?: number;
}

export interface ReviewRunner {
  readonly runWithLease: (spec: ReviewRunSpec) => Promise<ReviewRunResult>;
}

export const ReviewRunOutput = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      line: Schema.Int,
      message: Schema.String,
    }),
  ),
  summary: Schema.String,
});

type ReviewOutput = typeof ReviewRunOutput.Type;

export type ReviewRunFailureReason =
  | 'lease'
  | 'checkout'
  | 'agent'
  | 'timeout'
  | 'invalid-output'
  | 'cleanup';

export type ReviewRunResult =
  | {
      readonly status: 'succeeded';
      readonly attempt: number;
      readonly sandboxId: string;
      readonly output: ReviewOutput;
    }
  | {
      readonly status: 'failed';
      readonly reason: ReviewRunFailureReason;
      readonly attempt: number;
      readonly sandboxId?: string;
      readonly retryable: boolean;
      readonly leaseRetained: boolean;
    };

const defaultAttempt = 1;
const leaseDurationMillis = 10 * 60 * 1000;

const failure = (
  reason: ReviewRunFailureReason,
  attempt: number,
  extra: Pick<Extract<ReviewRunResult, { status: 'failed' }>, 'sandboxId' | 'leaseRetained'> = {
    leaseRetained: false,
  },
): Extract<ReviewRunResult, { status: 'failed' }> => ({
  status: 'failed',
  reason,
  attempt,
  retryable: reason !== 'cleanup' && reason !== 'lease',
  ...extra,
});

const recordOperationalLog = (log: OperationalLog | undefined, event: OperationalLogEvent) =>
  log === undefined
    ? Effect.succeed(undefined)
    : Effect.tryPromise({
        try: async () => {
          await log.record(sanitizeOperationalLogEvent(event));
        },
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));

const OpenCodeTextEvent = Schema.Struct({
  type: Schema.Literal('text'),
  part: Schema.Struct({
    type: Schema.Literal('text'),
    text: Schema.String,
  }),
});

const OpenCodeErrorEvent = Schema.Struct({
  type: Schema.Literal('error'),
});

const maxAgentOutputBytes = 256 * 1024;

const parseReviewOutput = (stdout: string): Effect.Effect<ReviewOutput, unknown> =>
  Effect.tryPromise({
    try: async () => {
      if (new TextEncoder().encode(stdout).byteLength > maxAgentOutputBytes) {
        throw new Error('agent output is oversized');
      }

      const textEvents: string[] = [];
      for (const line of stdout.split(/\r?\n/).filter((value) => value.length > 0)) {
        const event: unknown = JSON.parse(line);
        if (Option.isSome(Schema.decodeUnknownOption(OpenCodeErrorEvent)(event))) {
          throw new Error('agent emitted an error event');
        }
        const textEvent = Schema.decodeUnknownOption(OpenCodeTextEvent)(event);
        if (Option.isSome(textEvent)) {
          textEvents.push(textEvent.value.part.text);
        }
      }

      if (textEvents.length !== 1) {
        throw new Error('agent output is ambiguous or missing');
      }

      const parsed: unknown = JSON.parse(textEvents[0]);
      return parsed;
    },
    catch: () => undefined,
  }).pipe(Effect.flatMap((value) => Schema.decodeUnknownEffect(ReviewRunOutput)(value)));

const run = (
  spec: ReviewRunSpec,
  adapters: ReviewRunAdapters,
  attempt: number,
): Effect.Effect<ReviewRunResult> =>
  Effect.gen(function* () {
    const sandboxId = `${spec.runId}-attempt-${attempt}`;
    const now = yield* DateTime.now;
    const expiresAt = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(now) + leaseDurationMillis),
    );
    const lease = yield* Effect.tryPromise({
      try: () =>
        adapters.lease.register({
          runId: spec.runId,
          attempt,
          generation: attempt,
          sandboxId,
          expiresAt,
        }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));

    if (lease === undefined) {
      return failure('lease', attempt);
    }

    const sandbox = yield* Effect.tryPromise({
      try: () => adapters.sandbox.getSandbox(sandboxId),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));

    if (sandbox === undefined) {
      const leaseCleared = yield* Effect.tryPromise({
        try: () => lease.clear(),
        catch: () => undefined,
      }).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );
      return leaseCleared
        ? failure('agent', attempt, { sandboxId, leaseRetained: false })
        : failure('cleanup', attempt, { sandboxId, leaseRetained: true });
    }

    const cleanup = { failed: false };
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const leasedSandbox = yield* Effect.acquireRelease(Effect.succeed(sandbox), () =>
          Effect.tryPromise({
            try: async () => {
              await sandbox.destroy();
              await lease.clear();
            },
            catch: () => undefined,
          }).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                cleanup.failed = true;
              }).pipe(
                Effect.flatMap(() =>
                  Effect.tryPromise({ try: () => lease.rearm(), catch: () => undefined }).pipe(
                    Effect.catch(() => Effect.succeed(undefined)),
                  ),
                ),
              ),
            ),
          ),
        );

        const checkout = yield* Effect.tryPromise({
          try: () =>
            leasedSandbox.checkout({
              repositoryUrl: spec.repositoryUrl,
              baseSha: spec.baseSha,
              headSha: spec.headSha,
              checkoutToken: spec.checkoutToken,
            }),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (
          checkout === undefined ||
          checkout.baseSha !== spec.baseSha ||
          checkout.headSha !== spec.headSha
        ) {
          return failure('checkout', attempt, { sandboxId, leaseRetained: true });
        }

        const credentialsRemoved = yield* Effect.tryPromise({
          try: () => leasedSandbox.removeCheckoutCredentials(),
          catch: () => undefined,
        }).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!credentialsRemoved) {
          return failure('checkout', attempt, { sandboxId, leaseRetained: true });
        }

        const command = yield* Effect.tryPromise({
          try: () => leasedSandbox.runAgent({ modelCredential: spec.modelCredential }),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));

        if (command === undefined || command.timedOut === true) {
          return failure('timeout', attempt, { sandboxId, leaseRetained: true });
        }
        if (command.exitCode !== 0) {
          return failure('agent', attempt, { sandboxId, leaseRetained: true });
        }

        const output = yield* parseReviewOutput(command.stdout).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const agentResult: ReviewRunResult =
          output === undefined
            ? failure('invalid-output', attempt, { sandboxId, leaseRetained: true })
            : { status: 'succeeded', attempt, sandboxId, output };
        return agentResult;
      }),
    );

    if (cleanup.failed) {
      return failure('cleanup', attempt, { sandboxId, leaseRetained: true });
    }

    return result.status === 'failed' ? { ...result, leaseRetained: false } : result;
  });

const runWithAdapters = async (
  spec: ReviewRunSpec,
  adapters: ReviewRunAdapters,
): Promise<ReviewRunResult> => {
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const attemptLimit = Math.max(1, Math.min(spec.maxAttempts ?? 1, 3));
        let result: ReviewRunResult = failure('lease', defaultAttempt);
        const recordFailure = (failed: Extract<ReviewRunResult, { status: 'failed' }>) =>
          recordOperationalLog(adapters.log, {
            phase: 'runner',
            outcome: 'failed',
            runId: spec.runId,
            attempt: failed.attempt,
            ...(failed.sandboxId === undefined ? {} : { sandboxId: failed.sandboxId }),
            reason: failed.reason,
            retryable: failed.retryable,
            leaseRetained: failed.leaseRetained,
          });

        for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
          result = yield* run(spec, adapters, attempt);
          if (result.status === 'succeeded') {
            yield* recordOperationalLog(adapters.log, {
              phase: 'runner',
              outcome: 'succeeded',
              runId: spec.runId,
              attempt: result.attempt,
              sandboxId: result.sandboxId,
              cleanup: 'sandbox_destroyed_lease_cleared',
            });
          }
          if (result.status === 'succeeded' || !result.retryable) {
            if (result.status === 'failed') yield* recordFailure(result);
            return result;
          }
        }

        if (result.status === 'failed') yield* recordFailure(result);
        return result;
      }),
    );
  } catch {
    return failure('lease', defaultAttempt);
  }
};

export const createReviewRunner = (adapters: ReviewRunAdapters): ReviewRunner => ({
  runWithLease: (spec) => runWithAdapters(spec, adapters),
});

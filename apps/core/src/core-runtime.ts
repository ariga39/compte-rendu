import { MetadataInvalidationEvent, ReviewEvent } from '@compte-rendu/contracts';
import { Context, Effect, Layer, Schema } from 'effect';
import { createCoreInfrastructure } from './core-infrastructure';
import { currentIso } from './core-observability';
import type { CoreWorkerDependencies, CoreWorkerEnv } from './core-worker';
import { createPostHogLifecycleLog } from './posthog';
import { createReviewAdmission } from './review-admission';
import type { ReviewCheckSetupDefer } from './review-records';

type WaitUntil = { waitUntil(task: Promise<unknown>): void };

export interface CoreRuntimeHost {
  /** Host lifecycle used for best-effort PostHog delivery. */
  readonly context?: WaitUntil;
  /**
   * Defers durable check setup. With a request context this stays background
   * work; without one admission completes inline at its original point.
   */
  readonly deferCheckSetup?: ReviewCheckSetupDefer;
}

export const makeCoreRuntimeHost = (context?: WaitUntil): CoreRuntimeHost =>
  context === undefined
    ? {}
    : {
        context,
        deferCheckSetup: (task) => context.waitUntil(Effect.runPromise(task)),
      };

export interface CoreRuntimeShape {
  readonly submitReviewEvent: (
    event: typeof ReviewEvent.Type,
  ) => Effect.Effect<'accepted' | 'failed', unknown>;
  readonly invalidateMetadata: (
    event: typeof MetadataInvalidationEvent.Type,
  ) => Effect.Effect<void, unknown>;
}

const makeSubmitReviewEvent = (
  stateStore: ReturnType<typeof createCoreInfrastructure>['stateStore'],
  admission: ReturnType<typeof createReviewAdmission>,
) =>
  Effect.fn('CoreRuntime.submitReviewEvent')(function* (event: typeof ReviewEvent.Type) {
    if (event.event === 'pull_request' && event.repositoryVisibility === 'private') {
      const observedAt = yield* currentIso;
      yield* Effect.tryPromise({
        try: () =>
          stateStore.invalidateRepositoryMetadata({
            installationId: event.installationId,
            repositoryId: event.repositoryId,
            visibility: 'private',
            updatedAt: observedAt,
            nextRefreshAt: observedAt,
          }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
    }

    const disposition = yield* admission
      .handleReviewEvent(event)
      .pipe(Effect.catch(() => Effect.succeed('failed' as const)));
    return disposition === 'failed' ? ('failed' as const) : ('accepted' as const);
  });

const makeInvalidateMetadata = (
  stateStore: ReturnType<typeof createCoreInfrastructure>['stateStore'],
) =>
  Effect.fn('CoreRuntime.invalidateMetadata')(function* (
    event: typeof MetadataInvalidationEvent.Type,
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(MetadataInvalidationEvent)(event);
    const observedAt = yield* currentIso;
    yield* Effect.tryPromise({
      try: () =>
        stateStore.invalidateRepositoryMetadataBatch({
          installationId: decoded.installationId,
          repositoryIds: decoded.repositoryIds,
          visibility: decoded.visibility,
          updatedAt: observedAt,
          nextRefreshAt: observedAt,
        }),
      catch: (cause) => cause,
    });
  });

/**
 * Builds one typed Core operation set for a single request/host lifecycle.
 * The ports remain Promise-based; only the orchestration runs in Effect.
 */
export const makeCoreRuntime = (
  env: CoreWorkerEnv,
  dependencies: CoreWorkerDependencies = {},
  host: CoreRuntimeHost = {},
): CoreRuntimeShape => {
  const { github, stateStore, log, runner } = createCoreInfrastructure(env, dependencies);
  const lifecycleLog = createPostHogLifecycleLog(env, host.context);
  const admission = createReviewAdmission({
    github,
    stateStore,
    log,
    lifecycleLog,
    ...(runner === undefined ? {} : { cancelRunnerJob: runner.cancelJob }),
    ...(host.deferCheckSetup === undefined ? {} : { deferCheckSetup: host.deferCheckSetup }),
  });

  return {
    submitReviewEvent: makeSubmitReviewEvent(stateStore, admission),
    invalidateMetadata: makeInvalidateMetadata(stateStore),
  };
};

/**
 * Shared Core infrastructure for the webhook -> admission -> check setup path.
 * Later Runner protocol, settings and scheduled slices can extend this service
 * instead of constructing their own Effect runtime.
 */
export class CoreRuntime extends Context.Service<CoreRuntime, CoreRuntimeShape>()(
  '@compte-rendu/core/CoreRuntime',
) {
  static readonly layer = (
    env: CoreWorkerEnv,
    dependencies: CoreWorkerDependencies = {},
    host: CoreRuntimeHost = {},
  ): Layer.Layer<CoreRuntime> =>
    Layer.sync(CoreRuntime, () => CoreRuntime.of(makeCoreRuntime(env, dependencies, host)));
}

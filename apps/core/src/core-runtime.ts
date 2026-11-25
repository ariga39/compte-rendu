import {
  DEFAULT_REVIEW_NAME,
  EffortJobDetail,
  MetadataInvalidationEvent,
  REVIEW_ATTEMPT_BUDGET_MS,
  ReviewEvent,
} from '@compte-rendu/contracts';
import { Cause, Context, Effect, Layer, Option, Result, Schema } from 'effect';
import { createCoreInfrastructure } from './core-infrastructure';
import { currentIso, recordOperationalLog } from './core-observability';
import type { CoreWorkerDependencies, CoreWorkerEnv } from './core-worker';
import { createJobControl } from './job-control';
import { readPublicationRecord } from './publication-record';
import { createReviewAdmission } from './review-admission';
import { publishTerminalCheck } from './review-publication';
import { handleReviewConfiguration } from './review-configuration';
import type { ReviewCheckSetupDefer } from './review-records';
import { createRunnerProtocol } from './runner-protocol';
import {
  getDashboardOverview,
  getPublicJobDetail,
  listPublicJobs,
  refreshRepositoryMetadata,
  validateProgressSnapshot,
  type RefreshSummary,
} from './dashboard';

type WaitUntil = { waitUntil(task: Promise<unknown>): void };

const port = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error: unknown) => error });

export interface CoreRuntimeHost {
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
        deferCheckSetup: (task) => context.waitUntil(Effect.runPromise(task)),
      };

export interface CoreRuntimeShape {
  readonly submitReviewEvent: (
    event: typeof ReviewEvent.Type,
  ) => Effect.Effect<'accepted' | 'failed', unknown>;
  readonly invalidateMetadata: (
    event: typeof MetadataInvalidationEvent.Type,
  ) => Effect.Effect<void, unknown>;
  readonly claimRunnerJob: (request: Request) => Effect.Effect<Response, unknown>;
  readonly readRunnerConcurrency: () => Effect.Effect<Response, unknown>;
  readonly renewRunnerReadToken: (request: Request) => Effect.Effect<Response, unknown>;
  readonly handleRunnerCallback: (request: Request) => Effect.Effect<Response, unknown>;
  readonly handleRunnerEvidence: (request: Request) => Effect.Effect<Response, unknown>;
  readonly handleRunnerProgress: (request: Request) => Effect.Effect<Response, unknown>;
  readonly cancelReview: (
    runId: string,
    requestedByUid: number,
  ) => Effect.Effect<Response, unknown>;
  readonly reconcileCancellations: (now: number, runId?: string) => Effect.Effect<void, unknown>;
  readonly reconcilePublications: (now: number) => Effect.Effect<void, unknown>;
  readonly reconcileRecoveries: (now: number) => Effect.Effect<void, unknown>;
  readonly refreshMetadata: () => Effect.Effect<RefreshSummary, unknown>;
  readonly effortDetail: (runId: string, cursor?: string) => Effect.Effect<Response, never>;
  readonly dashboardConfig: () => Effect.Effect<Response, never>;
  readonly dashboardOverview: () => Effect.Effect<Response, unknown>;
  readonly listPublicJobs: (searchParams: URLSearchParams) => Effect.Effect<Response, unknown>;
  readonly publicJobDetail: (runId: string) => Effect.Effect<Response, unknown>;
  readonly reviewConfiguration: (request: Request) => Effect.Effect<Response, never>;
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
    yield* port(() =>
      stateStore.invalidateRepositoryMetadataBatch({
        installationId: decoded.installationId,
        repositoryIds: decoded.repositoryIds,
        visibility: decoded.visibility,
        updatedAt: observedAt,
        nextRefreshAt: observedAt,
      }),
    );
  });

/**
 * Builds one typed Core operation set for a single request/host lifecycle.
 * Core and Ingress orchestration runs in Effect; D1, GitHub, Runner, R2 and
 * host I/O remain ordinary Promise ports.
 */
export const makeCoreRuntime = (
  env: CoreWorkerEnv,
  dependencies: CoreWorkerDependencies = {},
  host: CoreRuntimeHost = {},
): CoreRuntimeShape => {
  const { tokenProvider, github, stateStore, log, runner } = createCoreInfrastructure(
    env,
    dependencies,
  );
  const admission = createReviewAdmission({
    github,
    stateStore,
    log,
    ...(runner === undefined ? {} : { cancelRunnerJob: runner.cancelJob }),
    ...(host.deferCheckSetup === undefined ? {} : { deferCheckSetup: host.deferCheckSetup }),
  });
  const protocol = createRunnerProtocol({
    env,
    stateStore,
    github,
    tokenProvider,
    completeReview: admission.completeReview,
    validateProgressSnapshot,
    ...(dependencies.getReadInstallationToken === undefined
      ? {}
      : { getReadInstallationToken: dependencies.getReadInstallationToken }),
  });
  const jobControl = createJobControl(stateStore, github, runner, log);

  const reconcilePublications = Effect.fn('CoreRuntime.reconcilePublications')(function* (
    now: number,
  ) {
    const ids = yield* Effect.tryPromise({
      try: () =>
        stateStore.claimStalledPublications(
          new Date(now - REVIEW_ATTEMPT_BUDGET_MS).toISOString(),
          new Date(now).toISOString(),
          4,
        ),
      catch: (error: unknown) => error,
    });
    let incomplete = false;
    for (const runId of ids) {
      let reason: 'state' | 'evidence' | 'publication' | 'check' = 'state';
      const settled = yield* Effect.gen(function* () {
        const outcome = yield* port(() => stateStore.getRunOutcome(runId));
        if (outcome?.status !== 'scheduled' || !outcome.publicationClaimedAt) return true;
        if (outcome.runnerJobId === undefined || outcome.runnerAttempt === undefined) {
          return yield* Effect.fail(new Error('Current Runner identity is unavailable'));
        }
        reason = 'evidence';
        const publication = yield* port(() =>
          readPublicationRecord(env.EVIDENCE_BUCKET, {
            runId,
            jobId: outcome.runnerJobId!,
            attempt: outcome.runnerAttempt!,
          }),
        );
        if (publication.kind !== 'valid') {
          return yield* Effect.fail(
            new Error(
              publication.kind === 'invalid'
                ? 'Invalid publication record'
                : 'Publication record is unavailable',
            ),
          );
        }
        reason = 'publication';
        yield* admission.completeReview({
          runId,
          output: publication.record.result,
          reconcileClaimedAt: outcome.publicationClaimedAt,
        });
        const terminal = yield* port(() => stateStore.getRunOutcome(runId));
        if (!terminal || terminal.status === 'scheduled') {
          return yield* Effect.fail(new Error('Publication still pending'));
        }
        if (terminal.status === 'completed' && terminal.checkRunId !== undefined) {
          reason = 'check';
          yield* Effect.tryPromise(() => publishTerminalCheck({ github, stateStore, runId })).pipe(
            Effect.catch(() => Effect.succeed(false)),
          );
        }
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.gen(function* () {
                yield* recordOperationalLog(log, {
                  phase: 'publication',
                  outcome: 'reconciliation_incomplete',
                  runId,
                  reason,
                });
                return false;
              }),
        ),
      );
      if (!settled) incomplete = true;
    }
    if (incomplete) return yield* Effect.fail(new Error('Publication reconciliation incomplete'));
  });

  const reconcileRecoveries = Effect.fn('CoreRuntime.reconcileRecoveries')(function* (now: number) {
    const results = yield* Effect.all(
      [
        Effect.tryPromise({
          try: () => jobControl.reconcileCancellations(now),
          catch: (error: unknown) => error,
        }).pipe(Effect.catchDefect((defect) => Effect.fail(defect))),
        reconcilePublications(now).pipe(Effect.catchDefect((defect) => Effect.fail(defect))),
      ],
      { mode: 'result', concurrency: 'unbounded' },
    );
    const failures = results.flatMap((result) =>
      Result.isFailure(result) ? [result.failure] : [],
    );
    if (failures.length === 1) return yield* Effect.fail(failures[0]);
    if (failures.length > 1) {
      return yield* Effect.fail(
        new AggregateError(failures, 'Scheduled recovery failed: review cancellation, publication'),
      );
    }
  });

  const refreshMetadata = Effect.fn('CoreRuntime.refreshMetadata')(function* () {
    const summary = yield* port(() => refreshRepositoryMetadata({ stateStore, github }));
    yield* recordOperationalLog(log, { phase: 'core', outcome: 'metadata_refresh', ...summary });
    return summary;
  });

  const effortDetail = (runId: string, cursor?: string) =>
    Effect.gen(function* () {
      const noStore = { 'cache-control': 'no-store' };
      const outcome = yield* port(() => stateStore.getRunOutcome(runId));
      if (outcome?.runnerJobId === undefined)
        return Response.json(
          { error: 'effort details unavailable' },
          { status: 404, headers: noStore },
        );
      const detail = yield* port(() =>
        env.INFERENCE_RELAY!.effortDetails({
          jobId: outcome.runnerJobId!,
          ...(cursor === undefined || cursor === '' ? {} : { cursor }),
        }),
      );
      if (detail === null)
        return Response.json(
          { error: 'Effort request details are no longer retained.' },
          { status: 404, headers: noStore },
        );
      const decoded = Schema.decodeUnknownOption(EffortJobDetail, {
        onExcessProperty: 'error',
      })(detail);
      return Option.isSome(decoded)
        ? Response.json(decoded.value, { headers: noStore })
        : Response.json({ error: 'effort details unavailable' }, { status: 503, headers: noStore });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Response.json(
            { error: 'effort details unavailable' },
            { status: 503, headers: { 'cache-control': 'no-store' } },
          ),
        ),
      ),
    );

  return {
    submitReviewEvent: makeSubmitReviewEvent(stateStore, admission),
    invalidateMetadata: makeInvalidateMetadata(stateStore),
    claimRunnerJob: (request) => protocol.handleRunnerClaim(request),
    readRunnerConcurrency: () => protocol.handleRunnerClaimHead(),
    renewRunnerReadToken: (request) => protocol.handleRunnerReadToken(request),
    handleRunnerCallback: (request) => protocol.handleRunnerResult(request),
    handleRunnerEvidence: (request) => protocol.handleRunnerEvidence(request),
    handleRunnerProgress: (request) => protocol.handleRunnerProgress(request),
    cancelReview: (runId, requestedByUid) =>
      port(() => jobControl.cancelReview(runId, requestedByUid)),
    reconcileCancellations: (now, runId) =>
      port(() => jobControl.reconcileCancellations(now, runId)),
    reconcilePublications,
    reconcileRecoveries,
    refreshMetadata,
    effortDetail,
    dashboardConfig: () =>
      Effect.succeed(
        Response.json(
          { name: env.GITHUB_CHECK_NAME?.trim() || DEFAULT_REVIEW_NAME },
          { headers: { 'cache-control': 'no-store' } },
        ),
      ),
    dashboardOverview: () => port(() => getDashboardOverview(stateStore)),
    listPublicJobs: (searchParams) => port(() => listPublicJobs(stateStore, searchParams)),
    publicJobDetail: (runId) => port(() => getPublicJobDetail(stateStore, runId)),
    reviewConfiguration: (request) =>
      handleReviewConfiguration(
        request,
        env.REVIEW_DB,
        env.REVIEW_CONFIGURATION_TOKEN,
        env.INFERENCE_RELAY,
      ),
  };
};

/**
 * Shared Core infrastructure for every application and Worker operation.
 * The application supplies this service at its fetch/scheduled boundary and
 * runs the resulting Effect program once there.
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

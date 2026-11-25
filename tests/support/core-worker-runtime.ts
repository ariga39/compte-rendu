import { Effect } from 'effect';
import {
  makeCoreRuntime,
  makeCoreRuntimeHost,
  type CoreRuntimeShape,
} from '../../apps/core/src/core-runtime';
import type { CoreWorkerDependencies, CoreWorkerEnv } from '../../apps/core/src/core-worker';
import type { RefreshSummary } from '../../apps/core/src/dashboard';

export type {
  CoreEnv,
  CoreWorkerDependencies,
  CoreWorkerEnv,
  R2BucketLike,
} from '../../apps/core/src/core-worker';

type WaitUntil = { waitUntil(task: Promise<unknown>): void };

export type CoreWorker = {
  reconcileRecoveries(now: number): Promise<void>;
  reconcilePublications(now: number): Promise<void>;
  effortDetail(runId: string, cursor?: string): Promise<Response>;
  claimRunnerJob(request: Request, context?: WaitUntil): Promise<Response>;
  readRunnerConcurrency(): Promise<Response>;
  renewRunnerReadToken(request: Request): Promise<Response>;
  handleRunnerCallback(request: Request, context?: WaitUntil): Promise<Response>;
  handleRunnerEvidence(request: Request): Promise<Response>;
  handleRunnerProgress(request: Request): Promise<Response>;
  getDashboardConfig(): Response;
  getDashboardOverview(): Promise<Response>;
  listPublicJobs(searchParams: URLSearchParams): Promise<Response>;
  getPublicJobDetail(rawRunId: string): Promise<Response>;
  handleReviewConfiguration(request: Request): Promise<Response>;
  cancelReview(runId: string, requestedByUid: number): Promise<Response>;
  reconcileCancellations(now: number, runId?: string): Promise<void>;
};

/**
 * Compact service runner for tests that observe the actual Worker operations.
 * Production executes the same CoreRuntime program once at the application or
 * Worker entry instead of exposing this Promise facade.
 */
export const createCoreWorker = (
  env: CoreWorkerEnv,
  dependencies: CoreWorkerDependencies = {},
): CoreWorker => {
  const run = <A, E>(
    use: (core: CoreRuntimeShape) => Effect.Effect<A, E>,
    context?: WaitUntil,
  ): Promise<A> =>
    Effect.runPromise(use(makeCoreRuntime(env, dependencies, makeCoreRuntimeHost(context))));

  return {
    reconcileRecoveries: (now) => run((core) => core.reconcileRecoveries(now)),
    reconcilePublications: (now) => run((core) => core.reconcilePublications(now)),
    effortDetail: (runId, cursor) => run((core) => core.effortDetail(runId, cursor)),
    claimRunnerJob: (request, context) => run((core) => core.claimRunnerJob(request), context),
    readRunnerConcurrency: () => run((core) => core.readRunnerConcurrency()),
    renewRunnerReadToken: (request) => run((core) => core.renewRunnerReadToken(request)),
    handleRunnerCallback: (request, context) =>
      run((core) => core.handleRunnerCallback(request), context),
    handleRunnerEvidence: (request) => run((core) => core.handleRunnerEvidence(request)),
    handleRunnerProgress: (request) => run((core) => core.handleRunnerProgress(request)),
    getDashboardConfig: () => Effect.runSync(makeCoreRuntime(env, dependencies).dashboardConfig()),
    getDashboardOverview: () => run((core) => core.dashboardOverview()),
    listPublicJobs: (searchParams) => run((core) => core.listPublicJobs(searchParams)),
    getPublicJobDetail: (rawRunId) => run((core) => core.publicJobDetail(rawRunId)),
    handleReviewConfiguration: (request) => run((core) => core.reviewConfiguration(request)),
    cancelReview: (runId, requestedByUid) =>
      run((core) => core.cancelReview(runId, requestedByUid)),
    reconcileCancellations: (now, runId) => run((core) => core.reconcileCancellations(now, runId)),
  };
};

export const runScheduledMetadataRefresh = (
  env: CoreWorkerEnv,
  dependencies: CoreWorkerDependencies = {},
): Promise<RefreshSummary> =>
  Effect.runPromise(makeCoreRuntime(env, dependencies).refreshMetadata());

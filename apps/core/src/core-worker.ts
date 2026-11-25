import { Option, Schema } from 'effect';
import {
  createCloudflareOperationalLog,
  DEFAULT_REVIEW_NAME,
  REVIEW_ATTEMPT_BUDGET_MS,
  ReviewEvent,
  MetadataInvalidationEvent,
  EffortJobDetail,
  sanitizeOperationalLogEvent,
} from '@compte-rendu/contracts';
import { createD1ReviewStateStore, type D1DatabaseLike } from './review-state-store';
import { createGitHubPublicationAdapter } from './github-review-adapter';
import { createGitHubAppTokenProvider } from './github-app-token';
import { createReviewCoordinator } from './review-admission';
import { publishTerminalCheck } from './review-publication';
import { createRunnerJobClient, type RunnerJobBinding } from './runner-job-client';
import type { GitHubAdapter } from './github-adapter-contract';
import type { ReviewPublicationStateStore } from './review-state-store';
import { createJobControl } from './job-control';
import { createPostHogLifecycleLog } from './posthog';
import { handleReviewConfiguration } from './review-configuration';
import type { OperationalLog } from '@compte-rendu/contracts';
import { createRunnerProtocol } from './runner-protocol';
import { readPublicationRecord } from './publication-record';
import {
  getDashboardOverview,
  getPublicJobDetail,
  listPublicJobs,
  refreshRepositoryMetadata,
  validateProgressSnapshot,
  type RefreshSummary,
} from './dashboard';

type CoreRelayCatalog = Omit<
  import('../../inference-worker/src/catalog').RelayCatalogSnapshot,
  'efforts'
> & {
  // Old relay deployments do not return the effort catalog. Keep it optional so
  // Core can roll forward before the inference Worker is upgraded.
  readonly efforts?: import('../../inference-worker/src/catalog').RelayCatalogSnapshot['efforts'];
};

export interface CoreEnv {
  readonly RUNNER: RunnerJobBinding;
  readonly RUNNER_AUTH_TOKEN: string;
}

export interface CoreWorkerEnv extends Partial<CoreEnv> {
  readonly REVIEW_DB: D1DatabaseLike;
  readonly INFERENCE_RELAY?: import('./runner-llm-control').RelayControl & {
    catalog(input?: {
      readonly includeModels?: boolean;
      readonly models?: boolean;
    }): Promise<CoreRelayCatalog>;
    refreshCatalog(scheduledTime: number): Promise<void>;
  };
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly DASHBOARD_ORIGIN?: string;
  readonly GITHUB_CHECK_NAME?: string;
  readonly REVIEW_CONFIGURATION_TOKEN?: string;
  readonly RELAY_DEFAULT_MODEL_ROUTE?: string;
  readonly EVIDENCE_BUCKET?: R2BucketLike;
  readonly POSTHOG_ENABLED?: string;
  readonly POSTHOG_PROJECT_API_KEY?: string;
  readonly POSTHOG_HOST?: string;
  readonly POSTHOG_DEPLOYMENT?: string;
  readonly POSTHOG_ENVIRONMENT?: string;
  readonly [key: string]: unknown;
}

export interface R2BucketLike {
  readonly get?: (
    key: string,
  ) => Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  readonly put: (
    key: string,
    value: ArrayBuffer | string,
    options?: { readonly onlyIf?: { readonly etagDoesNotMatch?: string } },
  ) => Promise<unknown>;
}

export interface CoreWorkerDependencies {
  readonly github?: GitHubAdapter;
  readonly stateStore?: ReviewPublicationStateStore;
  readonly log?: OperationalLog;
  readonly getReadInstallationToken?: (input: {
    installationId: number;
    repositoryId: number;
  }) => Promise<{ readonly token: string; readonly expiresAt: string }>;
}

type WaitUntil = { waitUntil(task: Promise<unknown>): void };

export type CoreWorker = ReturnType<typeof createJobControl> & {
  reconcileRecoveries(now: number): Promise<void>;
  reconcilePublications(now: number): Promise<void>;
  effortDetail(runId: string, cursor?: string): Promise<Response>;
  submitReviewEvent(
    event: typeof ReviewEvent.Type,
    context?: WaitUntil,
  ): Promise<'accepted' | 'failed'>;
  invalidateMetadata(event: typeof MetadataInvalidationEvent.Type): Promise<void>;
  claimRunnerJob(request: Request, context?: WaitUntil): Promise<Response>;
  renewRunnerReadToken(request: Request): Promise<Response>;
  handleRunnerCallback(request: Request, context?: WaitUntil): Promise<Response>;
  handleRunnerEvidence(request: Request): Promise<Response>;
  handleRunnerProgress(request: Request): Promise<Response>;
  getDashboardConfig(): Response;
  getDashboardOverview(): Promise<Response>;
  listPublicJobs(searchParams: URLSearchParams): Promise<Response>;
  getPublicJobDetail(rawRunId: string): Promise<Response>;
  handleReviewConfiguration(request: Request): Promise<Response>;
};

export const createCoreWorker = (
  env: CoreWorkerEnv,
  dependencies: CoreWorkerDependencies = {},
): CoreWorker => {
  const tokenProvider = createGitHubAppTokenProvider({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    crypto: globalThis.crypto,
  });
  const github =
    dependencies.github ??
    createGitHubPublicationAdapter({
      token: tokenProvider.getInstallationToken,
      getReviewAuthorLogin: tokenProvider.getReviewAuthorLogin,
      dashboardOrigin: env.DASHBOARD_ORIGIN,
      checkName: env.GITHUB_CHECK_NAME,
    });
  const stateStore =
    dependencies.stateStore ??
    createD1ReviewStateStore(
      env.REVIEW_DB,
      env.INFERENCE_RELAY ? env.RELAY_DEFAULT_MODEL_ROUTE : undefined,
    );
  const runner =
    env.RUNNER === undefined || env.RUNNER_AUTH_TOKEN === undefined
      ? undefined
      : createRunnerJobClient({ binding: env.RUNNER, authToken: env.RUNNER_AUTH_TOKEN });
  const log = dependencies.log ?? createCloudflareOperationalLog();
  const coordinatorDependencies = {
    github,
    stateStore,
    ...(runner === undefined ? {} : { cancelRunnerJob: runner.cancelJob }),
    log,
  } as const;
  const createCoordinator = (
    lifecycleLog: ReturnType<typeof createPostHogLifecycleLog>,
    deferCheckSetup?: (task: Promise<unknown>) => void,
  ) =>
    createReviewCoordinator({
      ...coordinatorDependencies,
      lifecycleLog,
      ...(deferCheckSetup === undefined
        ? {}
        : { deferCheckSetup: (task: Promise<void>) => deferCheckSetup(task) }),
    });

  const protocol = createRunnerProtocol({
    env,
    stateStore,
    github,
    tokenProvider,
    createCoordinator,
    validateProgressSnapshot,
    ...(dependencies.getReadInstallationToken === undefined
      ? {}
      : { getReadInstallationToken: dependencies.getReadInstallationToken }),
  });

  const jobControl = createJobControl(stateStore, github, runner, log, (context) =>
    createPostHogLifecycleLog(env, context),
  );

  const reconcilePublications = async (now: number): Promise<void> => {
    const ids = await stateStore.claimStalledPublications(
      new Date(now - REVIEW_ATTEMPT_BUDGET_MS).toISOString(),
      new Date(now).toISOString(),
      4,
    );
    const captures: Promise<unknown>[] = [];
    const lifecycle = createPostHogLifecycleLog(env, {
      waitUntil: (task) => captures.push(task),
    });
    let incomplete = false;
    for (const runId of ids) {
      let reason: 'state' | 'evidence' | 'publication' | 'check' = 'state';
      try {
        const outcome = await stateStore.getRunOutcome(runId);
        if (outcome?.status !== 'scheduled' || !outcome.publicationClaimedAt) continue;
        if (outcome.runnerJobId === undefined || outcome.runnerAttempt === undefined) {
          throw new Error('Current Runner identity is unavailable');
        }
        reason = 'evidence';
        let output: unknown;
        const publication = await readPublicationRecord(env.EVIDENCE_BUCKET, {
          runId,
          jobId: outcome.runnerJobId,
          attempt: outcome.runnerAttempt,
        });
        if (publication.kind !== 'valid') {
          throw new Error(
            publication.kind === 'invalid'
              ? 'Invalid publication record'
              : 'Publication record is unavailable',
          );
        }
        output = publication.record.result;
        reason = 'publication';
        const disposition = await createCoordinator(lifecycle).completeReview({
          runId,
          output,
          reconcileClaimedAt: outcome.publicationClaimedAt,
        });
        const settled = await stateStore.getRunOutcome(runId);
        if (!settled || settled.status === 'scheduled')
          throw new Error('Publication still pending');
        if (
          (settled.status === 'completed' || settled.status === 'failed') &&
          disposition === settled.status
        ) {
          await protocol.recordFinishedLifecycle(
            lifecycle,
            settled,
            settled.status,
            undefined,
            settled.status === 'failed' ? { phase: 'publication', reason: 'unknown' } : undefined,
            runId,
          );
        }
        if (settled.status === 'completed' && settled.checkRunId !== undefined) {
          reason = 'check';
          await publishTerminalCheck({ github, stateStore, runId }).catch(() => undefined);
        }
      } catch {
        incomplete = true;
        try {
          await log.record({
            phase: 'publication',
            outcome: 'reconciliation_incomplete',
            runId,
            reason,
          });
        } catch {
          // Continue reconciling other runs if the log sink fails.
        }
      }
    }
    await Promise.allSettled(captures);
    if (incomplete) throw new Error('Publication reconciliation incomplete');
  };

  const reconcileRecoveries = async (now: number): Promise<void> => {
    const results = await Promise.allSettled([
      jobControl.reconcileCancellations(now),
      reconcilePublications(now),
    ]);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length === 1) throw failures[0]!.reason;
    if (failures.length > 1)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Scheduled recovery failed: review cancellation, publication',
      );
  };

  const submitReviewEvent = async (
    event: typeof ReviewEvent.Type,
    context?: WaitUntil,
  ): Promise<'accepted' | 'failed'> => {
    const lifecycleLog = createPostHogLifecycleLog(env, context);
    if (event.event === 'pull_request' && event.repositoryVisibility === 'private') {
      const observedAt = new Date().toISOString();
      await stateStore
        .invalidateRepositoryMetadata({
          installationId: event.installationId,
          repositoryId: event.repositoryId,
          visibility: 'private',
          updatedAt: observedAt,
          nextRefreshAt: observedAt,
        })
        .catch(() => false);
    }
    try {
      const eventCoordinator = createCoordinator(
        lifecycleLog,
        context === undefined ? undefined : (task) => context.waitUntil(task),
      );
      const disposition = await eventCoordinator.handleReviewEvent(event);
      return disposition === 'failed' ? 'failed' : 'accepted';
    } catch {
      return 'failed';
    }
  };

  return {
    ...jobControl,
    async effortDetail(runId, cursor) {
      const noStore = { 'cache-control': 'no-store' };
      if (env.INFERENCE_RELAY?.effortDetails === undefined)
        return Response.json(
          { error: 'effort details unavailable' },
          { status: 503, headers: noStore },
        );
      try {
        const outcome = await stateStore.getRunOutcome(runId);
        if (outcome?.runnerJobId === undefined)
          return Response.json(
            { error: 'effort details unavailable' },
            { status: 404, headers: noStore },
          );
        const detail = await env.INFERENCE_RELAY.effortDetails({
          jobId: outcome.runnerJobId,
          ...(cursor === undefined || cursor === '' ? {} : { cursor }),
        });
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
          : Response.json(
              { error: 'effort details unavailable' },
              { status: 503, headers: noStore },
            );
      } catch {
        return Response.json(
          { error: 'effort details unavailable' },
          { status: 503, headers: noStore },
        );
      }
    },
    reconcilePublications,
    reconcileRecoveries,
    submitReviewEvent,
    invalidateMetadata: protocol.invalidateMetadata,
    claimRunnerJob: (request, context) =>
      protocol.handleRunnerClaim(request, createPostHogLifecycleLog(env, context)),
    renewRunnerReadToken: (request) => protocol.handleRunnerReadToken(request),
    handleRunnerCallback: (request, context) =>
      protocol.handleRunnerResult(request, createPostHogLifecycleLog(env, context)),
    handleRunnerEvidence: protocol.handleRunnerEvidence,
    handleRunnerProgress: protocol.handleRunnerProgress,
    getDashboardConfig: () =>
      Response.json(
        { name: env.GITHUB_CHECK_NAME?.trim() || DEFAULT_REVIEW_NAME },
        { headers: { 'cache-control': 'no-store' } },
      ),
    getDashboardOverview: () => getDashboardOverview(stateStore),
    listPublicJobs: (searchParams) => listPublicJobs(stateStore, searchParams),
    getPublicJobDetail: (rawRunId) => getPublicJobDetail(stateStore, rawRunId),
    handleReviewConfiguration: (request) =>
      handleReviewConfiguration(
        request,
        env.REVIEW_DB,
        env.REVIEW_CONFIGURATION_TOKEN,
        env.INFERENCE_RELAY,
      ),
  };
};

export const runScheduledMetadataRefresh = async (
  env: CoreWorkerEnv,
  dependencies: CoreWorkerDependencies = {},
): Promise<RefreshSummary> => {
  const tokenProvider = createGitHubAppTokenProvider({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    crypto: globalThis.crypto,
  });
  const github =
    dependencies.github ??
    createGitHubPublicationAdapter({ token: tokenProvider.getInstallationToken });
  const stateStore =
    dependencies.stateStore ??
    createD1ReviewStateStore(
      env.REVIEW_DB,
      env.INFERENCE_RELAY ? env.RELAY_DEFAULT_MODEL_ROUTE : undefined,
    );
  const log = dependencies.log ?? createCloudflareOperationalLog();
  const summary = await refreshRepositoryMetadata({ stateStore, github });
  try {
    await log.record(
      sanitizeOperationalLogEvent({ phase: 'core', outcome: 'metadata_refresh', ...summary }),
    );
  } catch {
    // aggregate refresh facts are best-effort
  }
  return summary;
};

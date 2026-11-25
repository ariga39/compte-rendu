import { Option, Schema } from 'effect';
import {
  createCloudflareOperationalLog,
  DEFAULT_REVIEW_NAME,
  REVIEW_ATTEMPT_BUDGET_MS,
  ReviewEvent,
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
import type { WorkerEntrypoint } from '@compte-rendu/contracts';
import { createPostHogLifecycleLog } from './posthog';
import { handleReviewConfiguration } from './review-configuration';
import type { OperationalLog } from '@compte-rendu/contracts';
import { createRunnerProtocol } from './runner-protocol';
import { readPublicationRecord } from './publication-record';
import {
  handleDashboardRequest,
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

const reviewEventsPath = '/review-events';
const metadataEventsPath = '/metadata-events';
const runnerClaimsPath = '/runner-claims';
const runnerReadTokenPath = '/runner-read-token';
const runnerResultsPath = '/runner-results';
const runnerEvidencePath = '/runner-evidence';
const runnerProgressPath = '/runner-progress';
const responseForDisposition = (
  disposition: Awaited<ReturnType<ReturnType<typeof createReviewCoordinator>['handleReviewEvent']>>,
) => new Response(null, { status: disposition === 'failed' ? 503 : 202 });

export const createCoreWorker = (
  env: CoreWorkerEnv,
  dependencies: CoreWorkerDependencies = {},
): WorkerEntrypoint<CoreWorkerEnv> &
  ReturnType<typeof createJobControl> & {
    reconcileRecoveries(now: number): Promise<void>;
    reconcilePublications(now: number): Promise<void>;
    effortDetail(runId: string, cursor?: string): Promise<Response>;
  } => {
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

  return {
    ...protocol,
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
    fetch: async (request, _env, context) => {
      if (
        new URL(request.url).pathname === '/review-configuration' ||
        new URL(request.url).pathname === '/review-configuration/efforts/reset'
      ) {
        return handleReviewConfiguration(
          request,
          env.REVIEW_DB,
          env.REVIEW_CONFIGURATION_TOKEN,
          env.INFERENCE_RELAY,
        );
      }
      const lifecycleLog = createPostHogLifecycleLog(env, context);
      if (request.method === 'POST' && new URL(request.url).pathname === runnerClaimsPath) {
        try {
          return await protocol.handleRunnerClaim(request, lifecycleLog);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && new URL(request.url).pathname === runnerReadTokenPath) {
        try {
          return await protocol.handleRunnerReadToken(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && new URL(request.url).pathname === runnerResultsPath) {
        try {
          return await protocol.handleRunnerResult(request, lifecycleLog);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && new URL(request.url).pathname === runnerEvidencePath) {
        try {
          return await protocol.handleRunnerEvidence(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && new URL(request.url).pathname === runnerProgressPath) {
        try {
          return await protocol.handleRunnerProgress(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && new URL(request.url).pathname === metadataEventsPath) {
        try {
          return await protocol.handleMetadataInvalidation(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'GET' && new URL(request.url).pathname === '/api/dashboard-config') {
        return Response.json(
          { name: env.GITHUB_CHECK_NAME?.trim() || DEFAULT_REVIEW_NAME },
          { headers: { 'cache-control': 'no-store' } },
        );
      }
      if (request.method === 'GET') {
        try {
          const dashboardResponse = await handleDashboardRequest(request, { stateStore });
          if (dashboardResponse !== undefined) return dashboardResponse;
        } catch {
          const path = new URL(request.url).pathname;
          if (path === '/api/dashboard' || path === '/api/jobs' || path.startsWith('/api/jobs/')) {
            return new Response(null, {
              status: 503,
              headers: { 'cache-control': 'no-store' },
            });
          }
        }
      }
      if (request.method !== 'POST' || new URL(request.url).pathname !== reviewEventsPath) {
        return new Response(null, { status: 404 });
      }

      const body = await request.json().catch(() => undefined);
      if (body === undefined) return new Response(null, { status: 400 });

      const event = Option.getOrUndefined(Schema.decodeUnknownOption(ReviewEvent)(body));
      if (event === undefined) return new Response(null, { status: 400 });

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
        return responseForDisposition(disposition);
      } catch {
        return new Response(null, { status: 503 });
      }
    },
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

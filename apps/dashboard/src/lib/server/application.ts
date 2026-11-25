import { canonicalDashboardOrigin, createCloudflareOperationalLog } from '@compte-rendu/contracts';
import { Effect, Result } from 'effect';
import { authRoute, noStore, requireOperator, sessionViewer } from './auth';
import { modelSettings, type LoginEnv } from './model-settings';
import { handleRunnerLlmControl } from '../../../../core/src/runner-llm-control';
import type { CoreWorkerDependencies, CoreWorkerEnv } from '../../../../core/src/core-worker';
import {
  CoreRuntime,
  makeCoreRuntimeHost,
  type CoreRuntimeShape,
} from '../../../../core/src/core-runtime';
import { handleGitHubWebhookEffect, type WebhookIngressEnv } from '../../../../ingress/src/index';

export type ApplicationEnv = LoginEnv &
  CoreWorkerEnv &
  WebhookIngressEnv & {
    readonly RUNNER_CALLBACK_TOKEN?: string;
  };

type RequestContext = { waitUntil(task: Promise<unknown>): void };
const emptyNoStore = (status: number) =>
  new Response(null, { status, headers: { 'cache-control': 'no-store' } });
const runnerAuthorized = (request: Request, env: ApplicationEnv) =>
  Boolean(env.RUNNER_CALLBACK_TOKEN?.trim()) &&
  request.headers.get('authorization') === `Bearer ${env.RUNNER_CALLBACK_TOKEN}`;

export function createApplication(env: ApplicationEnv, dependencies: CoreWorkerDependencies = {}) {
  const withCore = <A, E>(
    use: (core: CoreRuntimeShape) => Effect.Effect<A, E>,
    context?: RequestContext,
  ) =>
    Effect.suspend(() =>
      Effect.gen(function* () {
        const core = yield* CoreRuntime;
        return yield* use(core);
      }).pipe(Effect.provide(CoreRuntime.layer(env, dependencies, makeCoreRuntimeHost(context)))),
    );
  const runCore = <A, E>(
    use: (core: CoreRuntimeShape) => Effect.Effect<A, E>,
    context?: RequestContext,
  ) => Effect.runPromise(withCore(use, context));

  const webhookDependencies = (context?: RequestContext) => ({
    secret: env.WEBHOOK_SECRET,
    crypto: globalThis.crypto,
    allowedInstallationIds: env.ALLOWED_INSTALLATION_IDS,
    allowedBotAuthorIds: env.ALLOWED_BOT_AUTHOR_IDS,
    core: {
      submitReviewEvent: (event: Parameters<CoreRuntimeShape['submitReviewEvent']>[0]) =>
        withCore((core) => core.submitReviewEvent(event), context),
      invalidateMetadata: (event: Parameters<CoreRuntimeShape['invalidateMetadata']>[0]) =>
        withCore((core) => core.invalidateMetadata(event), context),
    },
    ...(dependencies.log === undefined ? {} : { log: dependencies.log }),
  });

  const runnerOperations: Record<
    string,
    (core: CoreRuntimeShape, request: Request) => Effect.Effect<Response, unknown>
  > = {
    '/runner-claim': (core, request) => core.claimRunnerJob(request),
    '/runner-read-token': (core, request) => core.renewRunnerReadToken(request),
    '/runner-callback': (core, request) => core.handleRunnerCallback(request),
    '/runner-evidence': (core, request) => core.handleRunnerEvidence(request),
    '/runner-progress': (core, request) => core.handleRunnerProgress(request),
  };

  const select = (
    request: Request,
    context?: RequestContext,
  ): Effect.Effect<Response | null, unknown> =>
    Effect.suspend(() => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/api/session') return Effect.tryPromise(() => sessionViewer(request, env));
      if (path.startsWith('/auth/')) return Effect.tryPromise(() => authRoute(request, env));
      if (path === '/api/model-settings' || path === '/api/model-settings/effort-reset')
        return modelSettings(request, env);
      const cancel = /^\/api\/jobs\/([A-Za-z0-9._~-]{1,128})\/cancel$/.exec(path);
      if (cancel) {
        if (request.method !== 'POST') return Effect.succeed(noStore(405));
        const origin = canonicalDashboardOrigin(env.DASHBOARD_ORIGIN);
        if (!origin || url.origin !== origin || request.headers.get('origin') !== origin)
          return Effect.succeed(noStore(403));
        return Effect.gen(function* () {
          const operator = yield* Effect.tryPromise(() =>
            requireOperator(
              request,
              env,
              'This GitHub account is not authorized to cancel reviews.',
            ),
          );
          if (operator instanceof Response) return operator;
          const response = yield* withCore(
            (core) => core.cancelReview(cancel[1], operator.id),
            context,
          );
          if (response.ok && context)
            context.waitUntil(
              runCore((core) => core.reconcileCancellations(Date.now(), cancel[1]), context),
            );
          return response;
        }).pipe(
          Effect.catch(() =>
            Effect.succeed(
              noStore(503, { error: 'Review cancellation is temporarily unavailable.' }),
            ),
          ),
          Effect.catchDefect(() =>
            Effect.succeed(
              noStore(503, { error: 'Review cancellation is temporarily unavailable.' }),
            ),
          ),
        );
      }
      const effortDetail = /^\/api\/jobs\/([A-Za-z0-9._~-]{1,128})\/effort-details$/.exec(path);
      if (effortDetail) {
        if (request.method !== 'GET') return Effect.succeed(noStore(405));
        return Effect.gen(function* () {
          const operator = yield* Effect.tryPromise(() =>
            requireOperator(
              request,
              env,
              'This GitHub account is not authorized to inspect review requests.',
            ),
          );
          if (operator instanceof Response) return operator;
          return yield* withCore((core) =>
            core.effortDetail(effortDetail[1], url.searchParams.get('cursor') ?? undefined),
          );
        }).pipe(
          Effect.catch(() =>
            Effect.succeed(
              noStore(503, { error: 'Effort request details are temporarily unavailable.' }),
            ),
          ),
          Effect.catchDefect(() =>
            Effect.succeed(
              noStore(503, { error: 'Effort request details are temporarily unavailable.' }),
            ),
          ),
        );
      }
      if (path.startsWith('/runner-llm/'))
        return handleRunnerLlmControl(request, env, env.RUNNER_CALLBACK_TOKEN);
      if (path === '/api/review-configuration/catalog') {
        if (request.method !== 'GET') return Effect.succeed(new Response(null, { status: 405 }));
        if (
          !env.REVIEW_CONFIGURATION_TOKEN?.trim() ||
          request.headers.get('authorization') !== 'Bearer ' + env.REVIEW_CONFIGURATION_TOKEN
        )
          return Effect.succeed(new Response(null, { status: 401 }));
        if (!env.INFERENCE_RELAY) return Effect.succeed(new Response(null, { status: 503 }));
        const params = url.searchParams;
        const detail = (name: string) => ['1', 'true'].includes(params.get(name) ?? '');
        const includeModels = detail('models') || detail('includeModels');
        return Effect.promise(async () =>
          Response.json(
            await env.INFERENCE_RELAY!.catalog(includeModels ? { includeModels: true } : undefined),
            { headers: { 'cache-control': 'no-store' } },
          ),
        ).pipe(
          Effect.catch(() => Effect.succeed(new Response(null, { status: 503 }))),
          Effect.catchDefect(() => Effect.succeed(new Response(null, { status: 503 }))),
        );
      }
      if (path === '/api/review-configuration')
        return withCore((core) => core.reviewConfiguration(request)).pipe(
          Effect.catch(() => Effect.succeed(emptyNoStore(503))),
          Effect.catchDefect(() => Effect.succeed(emptyNoStore(503))),
        );
      if (path === '/api/dashboard-config' && request.method === 'GET')
        return withCore((core) => core.dashboardConfig());
      const publicRead =
        path === '/api/dashboard'
          ? () => withCore((core) => core.dashboardOverview())
          : path === '/api/jobs'
            ? () => withCore((core) => core.listPublicJobs(url.searchParams))
            : path.startsWith('/api/jobs/')
              ? () => withCore((core) => core.publicJobDetail(path.slice('/api/jobs/'.length)))
              : undefined;
      if (request.method === 'GET' && publicRead !== undefined)
        return publicRead().pipe(
          Effect.catch(() => Effect.succeed(emptyNoStore(503))),
          Effect.catchDefect(() => Effect.succeed(emptyNoStore(503))),
        );
      const runnerOperation = runnerOperations[path];
      if (runnerOperation !== undefined) {
        const isClaimHead = path === '/runner-claim' && request.method === 'HEAD';
        if (request.method !== 'POST' && !isClaimHead)
          return Effect.succeed(new Response(null, { status: 405 }));
        if (!runnerAuthorized(request, env))
          return Effect.succeed(new Response(null, { status: 401 }));
        return withCore(
          (core) => (isClaimHead ? core.readRunnerConcurrency() : runnerOperation(core, request)),
          context,
        ).pipe(
          Effect.catch(() => Effect.succeed(new Response(null, { status: 503 }))),
          Effect.catchDefect(() => Effect.succeed(new Response(null, { status: 503 }))),
        );
      }
      if (path === '/' || path === '/webhooks/github') {
        if (request.method === 'POST')
          return handleGitHubWebhookEffect(request, webhookDependencies(context));
        return Effect.succeed(null);
      }
      if (path.startsWith('/api/')) {
        // Unknown API paths retain the former ingress fallback: a non-POST
        // method is rejected, while a POST is treated as a webhook delivery.
        if (request.method !== 'POST') return Effect.succeed(new Response(null, { status: 405 }));
        return handleGitHubWebhookEffect(request, webhookDependencies(context));
      }
      if (path.startsWith('/auth/') || path.startsWith('/runner-'))
        return Effect.succeed(new Response(null, { status: 404 }));
      return Effect.succeed(null);
    });

  const handle = (request: Request, context?: RequestContext) =>
    Effect.runPromise(select(request, context));

  return {
    handle,
    async fetch(request: Request, context?: RequestContext): Promise<Response> {
      return (await handle(request, context)) ?? new Response(null, { status: 404 });
    },
  };
}

export async function runApplicationScheduled(
  controller: { scheduledTime: number },
  env: CoreWorkerEnv,
): Promise<void> {
  const scheduled = Effect.gen(function* () {
    const core = yield* CoreRuntime;
    const [metadata, relay, recoveries] = yield* Effect.all(
      [
        core.refreshMetadata().pipe(Effect.catchDefect((defect) => Effect.fail(defect))),
        Effect.tryPromise({
          try: () =>
            env.INFERENCE_RELAY?.refreshCatalog(controller.scheduledTime) ?? Promise.resolve(),
          catch: (error: unknown) => error,
        }).pipe(Effect.catchDefect((defect) => Effect.fail(defect))),
        core
          .reconcileRecoveries(controller.scheduledTime)
          .pipe(Effect.catchDefect((defect) => Effect.fail(defect))),
      ],
      { mode: 'result', concurrency: 'unbounded' },
    );
    if (Result.isFailure(relay)) {
      yield* Effect.promise(async () => {
        try {
          await createCloudflareOperationalLog().record({
            phase: 'relay',
            outcome: 'refresh_failed',
          });
        } catch {
          // Operational logging is best-effort and cannot skip recovery reporting.
        }
      });
    }
    const failures: unknown[] = [];
    const labels: string[] = [];
    if (Result.isFailure(metadata)) {
      failures.push(metadata.failure);
      labels.push('metadata refresh');
    }
    if (Result.isFailure(recoveries)) {
      failures.push(recoveries.failure);
      labels.push('review recovery');
    }
    if (failures.length === 1) return yield* Effect.fail(failures[0]);
    if (failures.length > 1)
      return yield* Effect.fail(
        new AggregateError(failures, `Scheduled reconciliation failed: ${labels.join(', ')}`),
      );
  });
  await Effect.runPromise(scheduled.pipe(Effect.provide(CoreRuntime.layer(env))));
}

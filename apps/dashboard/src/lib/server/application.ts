import { canonicalDashboardOrigin, createCloudflareOperationalLog } from '@compte-rendu/contracts';
import { authRoute, noStore, requireOperator, sessionViewer } from './auth';
import { modelSettings, type LoginEnv } from './model-settings';
import { handleRunnerLlmControl } from '../../../../core/src/runner-llm-control';
import {
  createCoreWorker,
  runScheduledMetadataRefresh,
  type CoreWorkerDependencies,
  type CoreWorkerEnv,
} from '../../../../core/src/core-worker';
import { handleGitHubWebhook, type WebhookIngressEnv } from '../../../../ingress/src/index';

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
  let core: ReturnType<typeof createCoreWorker> | undefined;
  const getCore = () => (core ??= createCoreWorker(env, dependencies));

  const runnerOperations: Record<
    string,
    (request: Request, context?: RequestContext) => Promise<Response>
  > = {
    '/runner-claim': (request, context) => getCore().claimRunnerJob(request, context),
    '/runner-read-token': (request) => getCore().renewRunnerReadToken(request),
    '/runner-callback': (request, context) => getCore().handleRunnerCallback(request, context),
    '/runner-evidence': (request) => getCore().handleRunnerEvidence(request),
    '/runner-progress': (request) => getCore().handleRunnerProgress(request),
  };

  const handleWebhook = (request: Request, context?: RequestContext) =>
    handleGitHubWebhook(request, {
      secret: env.WEBHOOK_SECRET,
      crypto: globalThis.crypto,
      allowedInstallationIds: env.ALLOWED_INSTALLATION_IDS,
      allowedBotAuthorIds: env.ALLOWED_BOT_AUTHOR_IDS,
      core: {
        submitReviewEvent: (event) => getCore().submitReviewEvent(event, context),
        invalidateMetadata: (event) => getCore().invalidateMetadata(event),
      },
      ...(dependencies.log === undefined ? {} : { log: dependencies.log }),
    });

  const handle = async (request: Request, context?: RequestContext): Promise<Response | null> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/api/session') return sessionViewer(request, env);
    if (path.startsWith('/auth/')) return authRoute(request, env);
    if (path === '/api/model-settings' || path === '/api/model-settings/effort-reset')
      return modelSettings(request, env);
    const cancel = /^\/api\/jobs\/([A-Za-z0-9._~-]{1,128})\/cancel$/.exec(path);
    if (cancel) {
      if (request.method !== 'POST') return noStore(405);
      const origin = canonicalDashboardOrigin(env.DASHBOARD_ORIGIN);
      if (!origin || url.origin !== origin || request.headers.get('origin') !== origin)
        return noStore(403);
      const operator = await requireOperator(
        request,
        env,
        'This GitHub account is not authorized to cancel reviews.',
      );
      if (operator instanceof Response) return operator;
      const worker = getCore();
      try {
        const response = await worker.cancelReview(cancel[1], operator.id, context);
        if (response.ok && context)
          context.waitUntil(worker.reconcileCancellations(Date.now(), cancel[1]));
        return response;
      } catch {
        return noStore(503, { error: 'Review cancellation is temporarily unavailable.' });
      }
    }
    const effortDetail = /^\/api\/jobs\/([A-Za-z0-9._~-]{1,128})\/effort-details$/.exec(path);
    if (effortDetail) {
      if (request.method !== 'GET') return noStore(405);
      const operator = await requireOperator(
        request,
        env,
        'This GitHub account is not authorized to inspect review requests.',
      );
      if (operator instanceof Response) return operator;
      try {
        return await getCore().effortDetail(
          effortDetail[1],
          url.searchParams.get('cursor') ?? undefined,
        );
      } catch {
        return noStore(503, { error: 'Effort request details are temporarily unavailable.' });
      }
    }
    if (path.startsWith('/runner-llm/'))
      return handleRunnerLlmControl(request, env, env.RUNNER_CALLBACK_TOKEN);
    if (path === '/api/review-configuration/catalog') {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      if (
        !env.REVIEW_CONFIGURATION_TOKEN?.trim() ||
        request.headers.get('authorization') !== 'Bearer ' + env.REVIEW_CONFIGURATION_TOKEN
      )
        return new Response(null, { status: 401 });
      if (!env.INFERENCE_RELAY) return new Response(null, { status: 503 });
      try {
        const params = url.searchParams;
        const detail = (name: string) => ['1', 'true'].includes(params.get(name) ?? '');
        const includeModels = detail('models') || detail('includeModels');
        return Response.json(
          await env.INFERENCE_RELAY.catalog(includeModels ? { includeModels: true } : undefined),
          { headers: { 'cache-control': 'no-store' } },
        );
      } catch {
        return new Response(null, { status: 503 });
      }
    }
    if (path === '/api/review-configuration') {
      try {
        return await getCore().handleReviewConfiguration(request);
      } catch {
        return emptyNoStore(503);
      }
    }
    if (path === '/api/dashboard-config' && request.method === 'GET')
      return getCore().getDashboardConfig();
    const publicRead =
      path === '/api/dashboard'
        ? () => getCore().getDashboardOverview()
        : path === '/api/jobs'
          ? () => getCore().listPublicJobs(url.searchParams)
          : path.startsWith('/api/jobs/')
            ? () => getCore().getPublicJobDetail(path.slice('/api/jobs/'.length))
            : undefined;
    if (request.method === 'GET' && publicRead !== undefined) {
      try {
        return await publicRead();
      } catch {
        return emptyNoStore(503);
      }
    }
    const runnerOperation = runnerOperations[path];
    if (runnerOperation !== undefined) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      if (!runnerAuthorized(request, env)) return new Response(null, { status: 401 });
      try {
        return await runnerOperation(request, context);
      } catch {
        return new Response(null, { status: 503 });
      }
    }
    if (path === '/' || path === '/webhooks/github') {
      if (request.method === 'POST') return handleWebhook(request, context);
      return null;
    }
    if (path.startsWith('/api/')) {
      // Unknown API paths retain the former ingress fallback: a non-POST
      // method is rejected, while a POST is treated as a webhook delivery.
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      return handleWebhook(request, context);
    }
    if (path.startsWith('/auth/') || path.startsWith('/runner-'))
      return new Response(null, { status: 404 });
    return null;
  };
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
  const core = createCoreWorker(env);
  const [metadata, relay, recoveries] = await Promise.allSettled([
    runScheduledMetadataRefresh(env),
    env.INFERENCE_RELAY?.refreshCatalog(controller.scheduledTime),
    core.reconcileRecoveries(controller.scheduledTime),
  ]);
  if (relay.status === 'rejected') {
    try {
      await createCloudflareOperationalLog().record({ phase: 'relay', outcome: 'refresh_failed' });
    } catch {
      // Operational logging is best-effort.
    }
  }
  const failures: unknown[] = [];
  const labels: string[] = [];
  if (metadata.status === 'rejected') {
    failures.push(metadata.reason);
    labels.push('metadata refresh');
  }
  if (recoveries.status === 'rejected') {
    failures.push(recoveries.reason);
    labels.push('review recovery');
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, `Scheduled reconciliation failed: ${labels.join(', ')}`);
}

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
import { createIngressWorker, type IngressEnv } from '../../../../ingress/src/index';

export type ApplicationEnv = LoginEnv & CoreWorkerEnv & IngressEnv;

export function createApplication(env: ApplicationEnv, dependencies: CoreWorkerDependencies = {}) {
  return {
    async fetch(
      request: Request,
      context?: { waitUntil(task: Promise<unknown>): void },
    ): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === '/api/session') return sessionViewer(request, env);
      if (path.startsWith('/auth/')) return authRoute(request, env);
      if (path === '/api/model-settings' || path === '/api/model-settings/effort-reset')
        return modelSettings(request, env);
      const cancel = /^\/api\/jobs\/([A-Za-z0-9._~-]{1,128})\/cancel$/.exec(path);
      if (cancel) {
        if (request.method !== 'POST') return noStore(405);
        const origin = canonicalDashboardOrigin(env.DASHBOARD_ORIGIN);
        if (
          !origin ||
          new URL(request.url).origin !== origin ||
          request.headers.get('origin') !== origin
        )
          return noStore(403);
        const operator = await requireOperator(
          request,
          env,
          'This GitHub account is not authorized to cancel reviews.',
        );
        if (operator instanceof Response) return operator;
        const core = createCoreWorker(env, dependencies);
        try {
          const response = await core.cancelReview(cancel[1], operator.id, context);
          if (response.ok && context)
            context.waitUntil(core.reconcileCancellations(Date.now(), cancel[1]));
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
          return await createCoreWorker(env, dependencies).effortDetail(
            effortDetail[1],
            new URL(request.url).searchParams.get('cursor') ?? undefined,
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
          const params = new URL(request.url).searchParams;
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
      const accepted =
        path.startsWith('/api/') ||
        [
          '/runner-callback',
          '/runner-evidence',
          '/runner-claim',
          '/runner-read-token',
          '/runner-progress',
        ].includes(path) ||
        ((path === '/' || path === '/webhooks/github') && request.method === 'POST');
      if (!accepted) return new Response(null, { status: 404 });
      const core = createCoreWorker(env, dependencies);
      return createIngressWorker({
        secret: env.WEBHOOK_SECRET,
        crypto: globalThis.crypto,
        allowedInstallationIds: env.ALLOWED_INSTALLATION_IDS,
        allowedBotAuthorIds: env.ALLOWED_BOT_AUTHOR_IDS,
        runnerCallbackToken: env.RUNNER_CALLBACK_TOKEN,
        core: { fetch: (forwarded) => core.fetch(forwarded, env, context) },
        log: dependencies.log,
      }).fetch(request);
    },
  };
}

export async function runApplicationScheduled(
  controller: { scheduledTime: number },
  env: CoreWorkerEnv,
): Promise<void> {
  const core = createCoreWorker(env);
  const [metadata, relay, cancellations, checks, publications] = await Promise.allSettled([
    runScheduledMetadataRefresh(env),
    env.INFERENCE_RELAY?.refreshCatalog(controller.scheduledTime),
    core.reconcileCancellations(controller.scheduledTime),
    core.reconcileCheckDeliveries(controller.scheduledTime),
    core.reconcilePublications(controller.scheduledTime),
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
  if (cancellations.status === 'rejected') {
    failures.push(new Error('Review cancellation reconciliation failed'));
    labels.push('review cancellation');
  }
  if (publications.status === 'rejected') {
    failures.push(new Error('Publication reconciliation failed'));
    labels.push('publication');
  }
  if (checks.status === 'rejected') {
    failures.push(new Error('Check delivery reconciliation failed'));
    labels.push('check delivery');
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, `Scheduled reconciliation failed: ${labels.join(', ')}`);
}

import { authRoute, sessionViewer } from './auth';
import { modelSettings, type LoginEnv } from './model-settings';
import { createCloudflareOperationalLog } from '../../../../core/src/operational-log';
import { handleRunnerLlmControl } from '../../../../core/src/runner-llm-control';
import {
  createCoreWorker,
  runScheduledMetadataRefresh,
  type CoreWorkerDependencies,
  type CoreWorkerEnv,
} from '../../../../core/src/core-worker';
import { createIngressWorker, type IngressEnv } from '../../../../ingress/src/index';

export type ApplicationEnv = LoginEnv & CoreWorkerEnv & Omit<IngressEnv, 'CORE' | 'ASSETS'>;

export function createApplication(env: ApplicationEnv, dependencies: CoreWorkerDependencies = {}) {
  return {
    async fetch(
      request: Request,
      context?: { waitUntil(task: Promise<unknown>): void },
    ): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === '/api/session') return sessionViewer(request, env);
      if (path.startsWith('/auth/')) return authRoute(request, env);
      if (path === '/api/model-settings') return modelSettings(request, env);
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
          return Response.json(await env.INFERENCE_RELAY.catalog(), {
            headers: { 'cache-control': 'no-store' },
          });
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      const accepted =
        path.startsWith('/api/') ||
        [
          '/runner-callback',
          '/runner-claim',
          '/runner-read-token',
          '/runner-progress',
          '/runner-cleanup-recovery',
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
  const [metadata, relay] = await Promise.allSettled([
    runScheduledMetadataRefresh(env),
    env.INFERENCE_RELAY?.refreshCatalog(controller.scheduledTime),
  ]);
  if (relay.status === 'rejected') {
    try {
      await createCloudflareOperationalLog().record({ phase: 'relay', outcome: 'refresh_failed' });
    } catch {
      // Operational logging is best-effort.
    }
  }
  if (metadata.status === 'rejected') throw metadata.reason;
}

import {
  createCoreWorker,
  type CoreWorkerDependencies,
  type CoreWorkerEnv,
} from '../../../../core/src/core-worker';
import { createIngressWorker, type IngressEnv } from '../../../../ingress/src/index';

export type ApplicationEnv = CoreWorkerEnv & Omit<IngressEnv, 'CORE' | 'ASSETS'>;

export function createApplication(env: ApplicationEnv, dependencies: CoreWorkerDependencies = {}) {
  return {
    async fetch(
      request: Request,
      context?: { waitUntil(task: Promise<unknown>): void },
    ): Promise<Response> {
      const path = new URL(request.url).pathname;
      const accepted =
        path.startsWith('/api/') ||
        ['/runner-callback', '/runner-claim', '/runner-progress'].includes(path) ||
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

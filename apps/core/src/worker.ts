import { createCoreWorker, type CoreWorkerEnv } from './core-worker';

export { createCoreWorker, type CoreWorkerDependencies, type CoreWorkerEnv } from './core-worker';
export * from './index';

const core = {
  fetch: (
    request: Request,
    env?: CoreWorkerEnv,
    context?: { waitUntil(task: Promise<unknown>): void },
  ) =>
    env === undefined
      ? new Response(null, { status: 501 })
      : createCoreWorker(env).fetch(request, env, context),
};

export default core;

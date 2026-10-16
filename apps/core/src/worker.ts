import { createCoreWorker, runScheduledMetadataRefresh, type CoreWorkerEnv } from './core-worker';

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
  scheduled: (
    _controller: unknown,
    env?: CoreWorkerEnv,
    context?: { waitUntil(task: Promise<unknown>): void },
  ) => {
    if (env === undefined) return;
    const task = runScheduledMetadataRefresh(env)
      .then(() => undefined)
      .catch(() => undefined);
    context?.waitUntil(task);
  },
};

export default core;

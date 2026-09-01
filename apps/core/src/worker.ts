import { createCoreWorker, type CoreWorkerEnv } from './core-worker';

export { createCoreWorker, type CoreWorkerDependencies, type CoreWorkerEnv } from './core-worker';
export * from './index';

const core = {
  fetch: (request: Request, env?: CoreWorkerEnv) =>
    env === undefined
      ? new Response(null, { status: 501 })
      : createCoreWorker(env).fetch(request, env),
};

export default core;

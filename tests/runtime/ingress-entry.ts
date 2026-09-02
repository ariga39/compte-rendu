import ingress from '../../apps/ingress/src/index';

interface RuntimeIngressEnv {
  readonly WEBHOOK_SECRET: string;
  readonly ALLOWED_INSTALLATION_IDS: string;
  readonly RUNNER_CALLBACK_TOKEN: string;
  readonly CORE: {
    readonly fetch: (request: Request) => Promise<Response>;
  };
}

export default {
  fetch: (request: Request, env: RuntimeIngressEnv) => {
    if (new URL(request.url).pathname.startsWith('/__test/')) {
      return env.CORE.fetch(request);
    }
    return ingress.fetch(request, env);
  },
};

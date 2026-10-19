declare module '*cloudflare/_worker.js' {
  import type { ApplicationEnv } from '#lib/server/application.ts';
  const worker: { fetch(request: Request, env: ApplicationEnv): Promise<Response> };
  export default worker;
}

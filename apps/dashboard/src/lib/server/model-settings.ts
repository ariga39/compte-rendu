import { applyReviewConfiguration } from '../../../../core/src/review-configuration';
import type { ApplicationEnv } from './application';
import { noStore, requireOperator } from './auth';

export type { LoginEnv } from './auth';

export async function modelSettings(request: Request, env: ApplicationEnv): Promise<Response> {
  const url = new URL(request.url);
  const origin = env.DASHBOARD_ORIGIN;
  const id = env.DASHBOARD_GITHUB_CLIENT_ID;
  const secret = env.DASHBOARD_GITHUB_CLIENT_SECRET;
  if (!origin || url.origin !== origin || url.protocol !== 'https:' || !id || !secret)
    return noStore(503, { error: 'Login is unavailable.' });
  let unavailable = 'Model settings are temporarily unavailable.';
  const sameOrigin = request.headers.get('origin') === origin;
  try {
    if (url.pathname !== '/api/model-settings') return noStore(404);
    if (!['GET', 'PUT'].includes(request.method)) return noStore(405);
    if (request.method === 'PUT' && !sameOrigin) return noStore(403);
    const operator = await requireOperator(
      request,
      env,
      'This GitHub account is not authorized to edit review models.',
    );
    if (operator instanceof Response) return operator;
    unavailable = 'Could not load the model catalog.';
    if (!env.INFERENCE_RELAY) return noStore(503, { error: unavailable });
    if (request.method === 'PUT')
      return applyReviewConfiguration(request, env.REVIEW_DB, env.INFERENCE_RELAY);
    const { routes, lastAttemptAt, lastRefreshError } = await env.INFERENCE_RELAY.catalog();
    unavailable = 'Could not read the saved model configuration.';
    const config = await applyReviewConfiguration(request, env.REVIEW_DB);
    return config.ok
      ? noStore(200, {
          configuration: await config.json(),
          routes,
          catalogRefreshFailed: lastRefreshError !== null,
          lastAttemptAt,
        })
      : config;
  } catch {
    return noStore(503, { error: unavailable });
  }
}

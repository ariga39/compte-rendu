import { env, waitUntil } from 'cloudflare:workers';
import type { Handle } from '@sveltejs/kit/hooks';
import { createApplication } from '#lib/server/application.ts';

export const handle: Handle = async ({ event, resolve }) => {
  const path = event.url.pathname;
  if (
    path.startsWith('/api/') ||
    path.startsWith('/runner-') ||
    ((path === '/' || path === '/webhooks/github') && event.request.method === 'POST')
  ) {
    return createApplication(env).fetch(event.request, { waitUntil });
  }
  const response = await resolve(event);
  response.headers.set('cache-control', 'no-store');
  return response;
};

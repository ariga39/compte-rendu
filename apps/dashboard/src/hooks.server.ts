import { env, waitUntil } from 'cloudflare:workers';
import type { Handle } from '@sveltejs/kit/hooks';
import { createApplication } from '#lib/server/application.ts';

export const handle: Handle = async ({ event, resolve }) => {
  const response = await createApplication(env).handle(event.request, { waitUntil });
  if (response) return response;
  const resolved = await resolve(event);
  resolved.headers.set('cache-control', 'no-store');
  return resolved;
};

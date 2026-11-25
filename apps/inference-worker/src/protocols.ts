import type { ModelProfile } from '@compte-rendu/contracts';

export const protocolPaths = {
  '/v1/chat/completions': 'chat',
  '/v1/responses': 'responses',
} as const satisfies Record<string, ModelProfile>;

export const protocolForPath = (pathname: string) =>
  Object.hasOwn(protocolPaths, pathname)
    ? protocolPaths[pathname as keyof typeof protocolPaths]
    : null;

export const protocolForRequest = (url: URL): ModelProfile | null => protocolForPath(url.pathname);

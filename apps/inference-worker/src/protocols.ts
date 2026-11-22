import type { ModelProfile } from '@compte-rendu/contracts';
import { isGeminiStreamQuery, parseGeminiPath } from './gemini.ts';

export const protocolPaths = {
  '/v1/chat/completions': 'chat',
  '/v1/responses': 'responses',
  '/v1/messages': 'messages',
} as const satisfies Record<string, ModelProfile>;

export const protocolForPath = (pathname: string) =>
  Object.hasOwn(protocolPaths, pathname)
    ? protocolPaths[pathname as keyof typeof protocolPaths]
    : null;

export interface ProtocolRouteRequest {
  readonly profile: ModelProfile;
  /** Opaque Gemini wire handle from the path; never a URL or decoded route id. */
  readonly handle?: string;
}

export const protocolForRequest = (url: URL): ProtocolRouteRequest | null => {
  const exact = protocolForPath(url.pathname);
  if (exact !== null) return { profile: exact };
  const handle = parseGeminiPath(url.pathname);
  if (handle === null || !isGeminiStreamQuery(url.search)) return null;
  return { profile: 'gemini', handle };
};

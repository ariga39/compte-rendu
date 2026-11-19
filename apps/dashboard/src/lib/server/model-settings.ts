import { CodeChallengeMethod, generateCodeVerifier, generateState, OAuth2Client } from 'arctic';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { Schema } from 'effect';
import { applyReviewConfiguration } from '../../../../core/src/review-configuration';
import type { ApplicationEnv } from './application';

export interface LoginEnv {
  readonly DASHBOARD_GITHUB_CLIENT_ID?: string;
  readonly DASHBOARD_GITHUB_CLIENT_SECRET?: string;
  readonly DASHBOARD_MODEL_EDITOR_IDS?: string;
}
const flowCookie = '__Host-cr-flow';
const sessionCookie = '__Host-cr-session';
const cookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
const response = (status: number, data: unknown = {}) =>
  Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
function redirect(to: string, cookies: string[]) {
  const headers = new Headers({
    location: to,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 303, headers });
}
function readCookie(request: Request, name: string) {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(name + '='))
    ?.slice(name.length + 1);
}

export async function modelSettings(request: Request, env: ApplicationEnv): Promise<Response> {
  const url = new URL(request.url);
  const origin = env.DASHBOARD_ORIGIN;
  const id = env.DASHBOARD_GITHUB_CLIENT_ID;
  const secret = env.DASHBOARD_GITHUB_CLIENT_SECRET;
  if (!origin || url.origin !== origin || url.protocol !== 'https:' || !id || !secret)
    return response(503, { error: 'Login is unavailable.' });
  const sameOrigin = request.headers.get('origin') === origin;
  try {
    const client = new OAuth2Client(id, secret, origin + '/auth/github/callback');
    if (url.pathname === '/auth/github' && request.method === 'GET') {
      const state = generateState();
      const verifier = generateCodeVerifier();
      const authorize = client.createAuthorizationURLWithPKCE(
        'https://github.com/login/oauth/authorize',
        state,
        CodeChallengeMethod.S256,
        verifier,
        [],
      );
      return redirect(authorize.href, [cookie(flowCookie, state + '.' + verifier, 600)]);
    }
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      return sameOrigin ? redirect('/settings', [cookie(sessionCookie, '', 0)]) : response(403);
    }
    const key = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('compte-rendu dashboard session v1:' + secret),
    );
    if (url.pathname === '/auth/github/callback' && request.method === 'GET') {
      const [state, verifier] = readCookie(request, flowCookie)?.split('.') ?? [];
      const code = url.searchParams.get('code');
      if (!state || !verifier || state !== url.searchParams.get('state') || !code)
        return response(400, { error: 'Invalid or expired sign-in. Start again from Settings.' });
      const tokens = await client.validateAuthorizationCode(
        'https://github.com/login/oauth/access_token',
        code,
        verifier,
      );
      const sealed = await new EncryptJWT({ token: tokens.accessToken() })
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .setIssuer(origin)
        .setAudience(id)
        .setExpirationTime('1h')
        .encrypt(new Uint8Array(key));
      return redirect('/settings', [
        cookie(flowCookie, '', 0),
        cookie(sessionCookie, sealed, 3600),
      ]);
    }
    if (url.pathname !== '/api/model-settings') return response(404);
    if (!['GET', 'PUT'].includes(request.method)) return response(405);
    if (request.method === 'PUT' && !sameOrigin) return response(403);
    const sealed = readCookie(request, sessionCookie);
    if (!sealed) return response(401);
    let token: unknown;
    try {
      const { payload } = await jwtDecrypt(sealed, new Uint8Array(key), {
        issuer: origin,
        audience: id,
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256GCM'],
      });
      token = payload.token;
    } catch {
      return response(401);
    }
    if (typeof token !== 'string') return response(401);
    const upstream = await fetch('https://api.github.com/user', {
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/vnd.github+json',
        'user-agent': 'compte-rendu',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) return response(upstream.status === 401 ? 401 : 503);
    const user = (await upstream.json()) as { id?: unknown; two_factor_authentication?: unknown };
    const allowed = Schema.decodeUnknownSync(Schema.Array(Schema.Number))(
      JSON.parse(env.DASHBOARD_MODEL_EDITOR_IDS ?? '[]'),
    );
    if (
      typeof user.id !== 'number' ||
      !Number.isSafeInteger(user.id) ||
      !allowed.includes(user.id) ||
      user.two_factor_authentication !== true
    )
      return response(403);
    if (!env.INFERENCE_RELAY) return response(503);
    const { routes } = await env.INFERENCE_RELAY.catalog();
    if (request.method === 'GET') {
      const config = await applyReviewConfiguration(request, env.REVIEW_DB);
      return config.ok ? response(200, { configuration: await config.json(), routes }) : config;
    }
    return applyReviewConfiguration(request, env.REVIEW_DB, routes);
  } catch {
    return response(503, { error: 'Model settings are temporarily unavailable.' });
  }
}

import * as oauth from 'oauth4webapi';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { Schema } from 'effect';
import { applyReviewConfiguration } from '../../../../core/src/review-configuration';
import type { ApplicationEnv } from './application';

export interface LoginEnv {
  readonly DASHBOARD_GITHUB_CLIENT_ID?: string;
  readonly DASHBOARD_GITHUB_CLIENT_SECRET?: string;
  readonly DASHBOARD_MODEL_EDITOR_IDS?: string;
}
const github = {
  issuer: 'https://github.com/login/oauth',
  token_endpoint: 'https://github.com/login/oauth/access_token',
};
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
  let unavailable = 'Model settings are temporarily unavailable.';
  const sameOrigin = request.headers.get('origin') === origin;
  try {
    const client = { client_id: id };
    const redirectUri = origin + '/auth/github/callback';
    if (url.pathname === '/auth/github' && request.method === 'GET') {
      const state = oauth.generateRandomState();
      const verifier = oauth.generateRandomCodeVerifier();
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.search = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
        code_challenge_method: 'S256',
        code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      }).toString();
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
      let params: URLSearchParams;
      try {
        params = oauth.validateAuthResponse(github, client, url, state);
      } catch {
        return response(400, {
          error: 'Invalid GitHub sign-in response. Start again from Settings.',
        });
      }
      const exchange = await oauth.authorizationCodeGrantRequest(
        github,
        client,
        oauth.ClientSecretBasic(secret),
        params,
        redirectUri,
        verifier,
        { signal: AbortSignal.timeout(8000) },
      );
      const tokens = await oauth.processAuthorizationCodeResponse(github, client, exchange);
      const sealed = await new EncryptJWT({ token: tokens.access_token })
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
    unavailable = 'Could not retrieve your GitHub account details.';
    const upstream = await fetch('https://api.github.com/user', {
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/vnd.github+json',
        'user-agent': 'compte-rendu',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok)
      return upstream.status === 401 ? response(401) : response(503, { error: unavailable });
    const user = (await upstream.json()) as { id?: unknown };
    unavailable = 'Could not read the dashboard editor allowlist.';
    const allowed = Schema.decodeUnknownSync(Schema.Array(Schema.Number))(
      JSON.parse(env.DASHBOARD_MODEL_EDITOR_IDS ?? '[]'),
    );
    if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || !allowed.includes(user.id))
      return response(403, {
        error: 'This GitHub account is not authorized to edit review models.',
      });
    unavailable = 'Could not load the model catalog.';
    if (!env.INFERENCE_RELAY) return response(503, { error: unavailable });
    const { routes } = await env.INFERENCE_RELAY.catalog();
    unavailable = 'Could not read the saved model configuration.';
    if (request.method === 'GET') {
      const config = await applyReviewConfiguration(request, env.REVIEW_DB);
      return config.ok ? response(200, { configuration: await config.json(), routes }) : config;
    }
    return applyReviewConfiguration(request, env.REVIEW_DB, routes);
  } catch {
    return response(503, { error: unavailable });
  }
}

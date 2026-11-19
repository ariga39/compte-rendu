import { Option, Schema } from 'effect';
import { EncryptJWT, jwtDecrypt } from 'jose';
import * as oauth from 'oauth4webapi';
import { cleanHistorySearch } from '../filters.ts';

export interface LoginEnv {
  readonly DASHBOARD_ORIGIN?: string;
  readonly DASHBOARD_GITHUB_CLIENT_ID?: string;
  readonly DASHBOARD_GITHUB_CLIENT_SECRET?: string;
  readonly DASHBOARD_MODEL_EDITOR_IDS?: string;
}

export const SESSION_COOKIE = '__Host-cr-session';
export const FLOW_COOKIE = '__Host-cr-flow';

const SESSION_KEY_PREFIX = 'compte-rendu dashboard session v1:';
const MAX_RETURN_TARGET_LENGTH = 512;
const RETURN_TARGET_BASE = 'https://dashboard.invalid';

const cookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;

function redirect(to: string, cookies: string[]) {
  const headers = new Headers({
    location: to,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 303, headers });
}

export const noStore = (status: number, data: unknown = {}) =>
  Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });

export function readCookie(request: Request, name: string) {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(name + '='))
    ?.slice(name.length + 1);
}

export async function sessionKey(secret: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(SESSION_KEY_PREFIX + secret));
}

export async function readSessionToken(request: Request, env: LoginEnv): Promise<string | null> {
  const sealed = readCookie(request, SESSION_COOKIE);
  const origin = env.DASHBOARD_ORIGIN;
  const id = env.DASHBOARD_GITHUB_CLIENT_ID;
  const secret = env.DASHBOARD_GITHUB_CLIENT_SECRET;
  if (!sealed || !origin || !id || !secret) return null;
  try {
    const key = await sessionKey(secret);
    const { payload } = await jwtDecrypt(sealed, new Uint8Array(key), {
      issuer: origin,
      audience: id,
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    return typeof payload.token === 'string' ? payload.token : null;
  } catch {
    return null;
  }
}

const GitHubProfile = Schema.Struct({
  id: Schema.Int,
  login: Schema.optional(Schema.String),
});

export type GitHubAccount = {
  readonly id: number;
  readonly login: string | null;
};

export type GitHubAccountResult =
  | { readonly kind: 'ok'; readonly account: GitHubAccount }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unavailable' };

export async function fetchGitHubAccount(token: string): Promise<GitHubAccountResult> {
  try {
    const upstream = await fetch('https://api.github.com/user', {
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/vnd.github+json',
        'user-agent': 'compte-rendu',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    if (upstream.status === 401) return { kind: 'unauthorized' };
    if (!upstream.ok) return { kind: 'unavailable' };
    const decoded = Schema.decodeUnknownOption(GitHubProfile)(await upstream.json());
    if (Option.isNone(decoded) || !Number.isSafeInteger(decoded.value.id))
      return { kind: 'unavailable' };
    return {
      kind: 'ok',
      account: {
        id: decoded.value.id,
        login: decoded.value.login?.trim() || null,
      },
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function operatorIds(env: LoginEnv): ReadonlyArray<number> | null {
  try {
    const decoded = Schema.decodeUnknownOption(Schema.Array(Schema.Int))(
      JSON.parse(env.DASHBOARD_MODEL_EDITOR_IDS ?? '[]'),
    );
    return Option.isSome(decoded) ? decoded.value : null;
  } catch {
    return null;
  }
}

const hasControlCharacter = (value: string) => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

export function safeReturnTarget(value: string | null | undefined, fallback = '/'): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RETURN_TARGET_LENGTH ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /%2e|%2f|%5c/i.test(value) ||
    hasControlCharacter(value)
  )
    return fallback;

  let url: URL;
  try {
    url = new URL(value, RETURN_TARGET_BASE);
  } catch {
    return fallback;
  }
  // URL normalizes dot segments. Only accept the route the caller supplied.
  if (url.origin !== RETURN_TARGET_BASE || url.pathname !== value.split(/[?#]/, 1)[0])
    return fallback;

  if (url.pathname === '/') return '/';
  if (url.pathname === '/help' || url.pathname === '/settings') return url.pathname;
  if (url.pathname === '/history') {
    const query = cleanHistorySearch(url.search.replace(/^\?/, ''));
    return query ? '/history?' + query : '/history';
  }
  if (/^\/jobs\/[A-Za-z0-9._~-]{1,128}$/.test(url.pathname)) return url.pathname;
  return fallback;
}

function requestedReturnTarget(url: URL): string {
  return url.searchParams.has('returnTo')
    ? safeReturnTarget(url.searchParams.get('returnTo'))
    : '/settings';
}

function parseFlowCookie(value: string | undefined) {
  if (!value) return { state: undefined, verifier: undefined, encodedReturnTo: undefined };
  const first = value.indexOf('.');
  if (first === -1) return { state: undefined, verifier: undefined, encodedReturnTo: undefined };
  const state = value.slice(0, first);
  const second = value.indexOf('.', first + 1);
  if (second === -1) return { state, verifier: value.slice(first + 1), encodedReturnTo: undefined };
  return {
    state,
    verifier: value.slice(first + 1, second),
    encodedReturnTo: value.slice(second + 1),
  };
}

export async function authRoute(request: Request, env: LoginEnv): Promise<Response> {
  const url = new URL(request.url);
  const origin = env.DASHBOARD_ORIGIN;
  const id = env.DASHBOARD_GITHUB_CLIENT_ID;
  const secret = env.DASHBOARD_GITHUB_CLIENT_SECRET;
  if (!origin || url.origin !== origin || url.protocol !== 'https:' || !id || !secret)
    return noStore(503, { error: 'Login is unavailable.' });
  const sameOrigin = request.headers.get('origin') === origin;
  try {
    const client = { client_id: id };
    const redirectUri = origin + '/auth/github/callback';
    if (url.pathname === '/auth/github') {
      if (request.method !== 'GET') return noStore(405);
      const state = oauth.generateRandomState();
      const verifier = oauth.generateRandomCodeVerifier();
      const returnTo = requestedReturnTarget(url);
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.search = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
        code_challenge_method: 'S256',
        code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      }).toString();
      return redirect(authorize.href, [
        cookie(FLOW_COOKIE, state + '.' + verifier + '.' + encodeURIComponent(returnTo), 600),
      ]);
    }
    if (url.pathname === '/auth/logout') {
      if (request.method !== 'POST') return noStore(405);
      if (!sameOrigin) return noStore(403);
      return redirect(requestedReturnTarget(url), [
        cookie(SESSION_COOKIE, '', 0),
        cookie(FLOW_COOKIE, '', 0),
      ]);
    }
    if (url.pathname === '/auth/github/callback') {
      if (request.method !== 'GET') return noStore(405);
      const { state, verifier, encodedReturnTo } = parseFlowCookie(
        readCookie(request, FLOW_COOKIE),
      );
      let returnTo = '/settings';
      if (encodedReturnTo !== undefined) {
        try {
          returnTo = safeReturnTarget(decodeURIComponent(encodedReturnTo));
        } catch {
          returnTo = '/';
        }
      }
      const code = url.searchParams.get('code');
      if (!state || !verifier || state !== url.searchParams.get('state') || !code)
        return noStore(400, { error: 'Invalid or expired sign-in. Start again from Settings.' });
      let params: URLSearchParams;
      try {
        params = oauth.validateAuthResponse(github, client, url, state);
      } catch {
        return noStore(400, {
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
        .encrypt(new Uint8Array(await sessionKey(secret)));
      return redirect(returnTo, [cookie(FLOW_COOKIE, '', 0), cookie(SESSION_COOKIE, sealed, 3600)]);
    }
    return noStore(404);
  } catch {
    return noStore(503, { error: 'Login is unavailable.' });
  }
}

const github = {
  issuer: 'https://github.com/login/oauth',
  token_endpoint: 'https://github.com/login/oauth/access_token',
};

export async function requireOperator(
  request: Request,
  env: LoginEnv,
  forbiddenMessage: string,
): Promise<GitHubAccount | Response> {
  const token = await readSessionToken(request, env);
  if (!token) return noStore(401);
  const account = await fetchGitHubAccount(token);
  if (account.kind === 'unauthorized') return noStore(401);
  if (account.kind === 'unavailable')
    return noStore(503, { error: 'Could not retrieve your GitHub account details.' });
  const allowed = operatorIds(env);
  if (!allowed) return noStore(503, { error: 'Could not read the dashboard editor allowlist.' });
  return allowed.includes(account.account.id)
    ? account.account
    : noStore(403, { error: forbiddenMessage });
}

export async function sessionViewer(request: Request, env: LoginEnv): Promise<Response> {
  const url = new URL(request.url);
  const origin = env.DASHBOARD_ORIGIN;
  const id = env.DASHBOARD_GITHUB_CLIENT_ID;
  const secret = env.DASHBOARD_GITHUB_CLIENT_SECRET;
  if (!origin || url.origin !== origin || url.protocol !== 'https:' || !id || !secret)
    return noStore(503, { error: 'Session is unavailable.' });
  if (request.method !== 'GET') return noStore(405);
  if (!readCookie(request, SESSION_COOKIE))
    return noStore(200, { signedIn: false, account: null, operator: false });
  const token = await readSessionToken(request, env);
  if (!token) return noStore(401, { error: 'Session expired.' });
  const account = await fetchGitHubAccount(token);
  if (account.kind === 'unauthorized') return noStore(401, { error: 'Session expired.' });
  if (account.kind === 'unavailable' || !account.account.login)
    return noStore(503, { error: 'Could not retrieve your GitHub account details.' });
  return noStore(200, {
    signedIn: true,
    account: { login: account.account.login },
    operator: operatorIds(env)?.includes(account.account.id) ?? false,
  });
}

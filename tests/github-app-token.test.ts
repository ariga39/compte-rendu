import { describe, expect, it } from 'vitest';
import { createGitHubAppTokenProvider } from '../apps/core/src/github-app-token';

const pemFromDer = (value: ArrayBuffer) => {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  const encoded = globalThis.btoa(binary);
  const lines = encoded.match(/.{1,64}/g)?.join('\n') ?? encoded;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
};

const decodeBase64UrlJson = (value: string) => {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + padding;
  return JSON.parse(globalThis.atob(padded)) as { iss: number; iat: number; exp: number };
};

describe('GitHub App token provider', () => {
  it('exchanges a signed app JWT for an installation token', async () => {
    const keyPair = await globalThis.crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const privateKey = pemFromDer(
      await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
    );
    let requestUrl = '';
    let requestHeaders: Headers | undefined;
    const provider = createGitHubAppTokenProvider({
      appId: '1234567',
      privateKey,
      crypto: globalThis.crypto,
      fetch: async (input, init) => {
        requestUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requestHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ token: 'installation-token-from-github' }));
      },
    });

    await expect(provider.getInstallationToken(7)).resolves.toBe('installation-token-from-github');

    expect(requestUrl).toBe('https://api.github.com/app/installations/7/access_tokens');
    expect(requestHeaders?.get('user-agent')).toBe('compte-rendu-core');
    const authorization = requestHeaders?.get('authorization');
    expect(authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
    const claims = decodeBase64UrlJson(authorization?.split('.')[1] ?? '');
    expect(claims.iss).toBe(1234567);
    expect(claims.exp - claims.iat).toBe(660);
  });

  it('rejects malformed credentials without exposing their material', async () => {
    const privateKey = 'malformed-test-private-key';
    const provider = createGitHubAppTokenProvider({
      appId: '1234567',
      privateKey,
      crypto: globalThis.crypto,
      fetch: async () => new Response('{}'),
    });

    const error = await provider.getInstallationToken(7).catch((cause) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(privateKey);
  });

  it('rejects a placeholder app ID before attempting token exchange', async () => {
    const keyPair = await globalThis.crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const privateKey = pemFromDer(
      await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
    );
    let fetchAttempts = 0;
    const provider = createGitHubAppTokenProvider({
      appId: 'REPLACE_WITH_GITHUB_APP_ID',
      privateKey,
      crypto: globalThis.crypto,
      fetch: async () => {
        fetchAttempts += 1;
        return new Response(JSON.stringify({ token: 'unexpected-token' }));
      },
    });

    await expect(provider.getInstallationToken(7)).rejects.toThrow('GitHub App ID is invalid');
    expect(fetchAttempts).toBe(0);
  });
});

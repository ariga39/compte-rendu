import { describe, expect, it } from 'vitest';
import { createGitHubAppTokenProvider } from '../apps/core/src/github-app-token';

const pemFromDer = (value: ArrayBuffer) => {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  const encoded = globalThis.btoa(binary);
  const lines = encoded.match(/.{1,64}/g)?.join('\n') ?? encoded;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
};

const derElement = (bytes: Uint8Array, offset: number) => {
  const lengthByte = bytes[offset + 1];
  const lengthSize = lengthByte < 0x80 ? 0 : lengthByte & 0x7f;
  let length = lengthByte < 0x80 ? lengthByte : 0;
  for (let index = 0; index < lengthSize; index += 1) {
    length = length * 256 + bytes[offset + 2 + index];
  }
  const valueStart = offset + 2 + lengthSize;
  return {
    next: valueStart + length,
    valueStart,
    valueEnd: valueStart + length,
  };
};

const pkcs1PemFromPkcs8 = (value: ArrayBuffer) => {
  const bytes = new Uint8Array(value);
  const privateKeyInfo = derElement(bytes, 0);
  let offset = privateKeyInfo.valueStart;
  offset = derElement(bytes, offset).next;
  offset = derElement(bytes, offset).next;
  const privateKey = derElement(bytes, offset);
  return pemFromDer(bytes.slice(privateKey.valueStart, privateKey.valueEnd).buffer)
    .replace('BEGIN PRIVATE KEY', 'BEGIN RSA PRIVATE KEY')
    .replace('END PRIVATE KEY', 'END RSA PRIVATE KEY');
};

const decodeBase64UrlJson = (value: string) => {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + padding;
  return JSON.parse(globalThis.atob(padded)) as { iss: number; iat: number; exp: number };
};

describe('GitHub App token provider', () => {
  it('mints a target-repository read token and validates its effective grant', async () => {
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
    let requestBody: unknown;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const provider = createGitHubAppTokenProvider({
      appId: '1234567',
      privateKey,
      crypto: globalThis.crypto,
      fetch: async (_input, init) => {
        if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
        requestBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            token: 'read-token',
            expires_at: expiresAt,
            repositories: [{ id: 11, full_name: 'acme/reviewed' }],
            permissions: {
              contents: 'read',
              issues: 'read',
              pull_requests: 'read',
              metadata: 'read',
            },
          }),
        );
      },
    });

    await expect(provider.getReadInstallationToken(7, 11)).resolves.toEqual({
      token: 'read-token',
      expiresAt,
    });
    expect(requestBody).toEqual({
      repository_ids: [11],
      permissions: {
        contents: 'read',
        issues: 'read',
        pull_requests: 'read',
        metadata: 'read',
      },
    });
  });

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

  it('exchanges a signed app JWT when GitHub provides a PKCS#1 private key', async () => {
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
    const privateKey = pkcs1PemFromPkcs8(
      await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
    );
    const provider = createGitHubAppTokenProvider({
      appId: '1234567',
      privateKey,
      crypto: globalThis.crypto,
      fetch: async () => new Response(JSON.stringify({ token: 'installation-token-from-github' })),
    });

    await expect(provider.getInstallationToken(7)).resolves.toBe('installation-token-from-github');
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

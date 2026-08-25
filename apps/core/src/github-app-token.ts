import { DateTime, Effect, Schema } from 'effect';

const InstallationTokenResponse = Schema.Struct({
  token: Schema.NonEmptyString,
});

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const encodedJson = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

const pemBytes = (privateKey: string): ArrayBuffer => {
  const match = /^-----BEGIN PRIVATE KEY-----([\s\S]+)-----END PRIVATE KEY-----$/.exec(
    privateKey.trim(),
  );
  if (match === null) throw new Error('GitHub App private key is invalid');

  const encoded = match[1].replace(/\s/g, '');
  let binary: string;
  try {
    binary = globalThis.atob(encoded);
  } catch {
    throw new Error('GitHub App private key is invalid');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
};

export interface GitHubAppTokenProviderOptions {
  readonly appId: string;
  readonly privateKey: string;
  readonly fetch?: typeof fetch;
  readonly crypto: Pick<Crypto, 'subtle'>;
  readonly apiBaseUrl?: string;
}

export interface GitHubAppTokenProvider {
  readonly getInstallationToken: (installationId: number) => Promise<string>;
}

export const createGitHubAppTokenProvider = (
  options: GitHubAppTokenProviderOptions,
): GitHubAppTokenProvider => {
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  let importedKey: CryptoKey | undefined;

  const getKey = async () => {
    if (importedKey !== undefined) return importedKey;
    try {
      importedKey = await options.crypto.subtle.importKey(
        'pkcs8',
        pemBytes(options.privateKey),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      return importedKey;
    } catch {
      throw new Error('GitHub App private key is invalid');
    }
  };

  return {
    getInstallationToken: async (installationId) => {
      const appId = Number(options.appId);
      if (!Number.isSafeInteger(appId) || appId < 1) {
        throw new Error('GitHub App ID is invalid');
      }
      const nowSeconds = Math.floor(
        (await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)))) / 1000,
      );
      const header = encodedJson({ alg: 'RS256', typ: 'JWT' });
      const payload = encodedJson({
        iss: appId,
        iat: nowSeconds - 60,
        exp: nowSeconds + 600,
      });
      const signingInput = `${header}.${payload}`;
      let signature: ArrayBuffer;
      try {
        signature = await options.crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          await getKey(),
          new TextEncoder().encode(signingInput),
        );
      } catch {
        throw new Error('GitHub App token could not be signed');
      }

      let response: Response;
      try {
        response = await fetcher(
          `${apiBaseUrl}/app/installations/${installationId}/access_tokens`,
          {
            method: 'POST',
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${signingInput}.${base64Url(new Uint8Array(signature))}`,
              'content-type': 'application/json',
              'user-agent': 'compte-rendu-core',
              'x-github-api-version': '2022-11-28',
            },
          },
        );
      } catch {
        throw new Error('GitHub App token exchange failed');
      }
      if (!response.ok) throw new Error('GitHub App token exchange failed');

      try {
        const value = await response.json();
        return (await Schema.decodeUnknownPromise(InstallationTokenResponse)(value)).token;
      } catch {
        throw new Error('GitHub App token response is invalid');
      }
    },
  };
};

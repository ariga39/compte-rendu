import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('renders the instance relay with a separate D1, private service binding and HTTPS inference domain', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-render-'));
  try {
    for (const app of ['dashboard', 'inference-worker']) {
      mkdirSync(join(root, 'apps', app), { recursive: true });
      copyFileSync(
        resolve('apps', app, 'wrangler.jsonc'),
        join(root, 'apps', app, 'wrangler.jsonc'),
      );
    }
    const config = {
      accountId: '1'.repeat(32),
      databaseId: '12345678-1234-4321-8123-123456789abc',
      hostname: 'inference.example.net',
      gatewayId: 'example-review',
      defaultRoute: 'p/model',
      catalogSources: [
        {
          discovery: 'gateway',
          prefix: 'p/',
          providerSlug: 'native:openai',
          credentialAlias: 'default',
          efforts: {
            'p/deepseek-v4.1-flash': [{ name: 'high', controls: { reasoning_effort: 'high' } }],
          },
        },
        {
          providerSlug: 'custom-legacy',
          credentialAlias: 'billing',
          aliases: { 'legacy-review': 'legacy-model' },
        },
      ],
    };
    const input = join(root, 'relay.json');
    writeFileSync(input, JSON.stringify(config), { encoding: 'utf8', flag: 'wx' });
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve('scripts/render-wrangler-config.mts'),
        'example',
        '42',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '[1]',
        '[]',
        '{"enabled":false}',
        '',
        input,
      ],
      { cwd: root },
    );
    const read = (app: string) =>
      JSON.parse(
        readFileSync(join(root, 'apps', app, 'wrangler.example.jsonc'), 'utf8').replace(
          /,\s*([}\]])/g,
          '$1',
        ),
      );
    expect(read('dashboard')).toMatchObject({
      account_id: config.accountId,
      services: [
        { binding: 'INFERENCE_RELAY', service: 'example-inference', entrypoint: 'InferenceWorker' },
      ],
      vars: { RELAY_DEFAULT_MODEL_ROUTE: 'p/model' },
    });
    expect(read('inference-worker')).toMatchObject({
      name: 'example-inference',
      account_id: config.accountId,
      workers_dev: false,
      routes: [{ pattern: config.hostname, custom_domain: true }],
      d1_databases: [{ binding: 'RELAY_DB', database_id: config.databaseId }],
      vars: {
        AI_GATEWAY_ID: config.gatewayId,
        AI_GATEWAY_ACCOUNT_ID: config.accountId,
      },
      secrets: { required: ['AI_GATEWAY_RUN_TOKEN'] },
      triggers: { crons: ['17 * * * *'] },
    });
    expect(JSON.parse(read('inference-worker').vars.RELAY_CATALOG_SOURCES)).toEqual(
      config.catalogSources,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects provider slugs, credential aliases and route IDs outside the frozen route boundary', () => {
  const base = {
    accountId: '1'.repeat(32),
    databaseId: '12345678-1234-4321-8123-123456789abc',
    hostname: 'inference.example.net',
    gatewayId: 'example-review',
    defaultRoute: 'p/model',
    catalogSources: [
      {
        url: 'https://models.example.net/v1/models',
        prefix: 'p/',
        providerSlug: 'custom-review',
        credentialAlias: 'default',
      },
    ],
  };
  const cases = [
    {
      ...base,
      catalogSources: [{ ...base.catalogSources[0], providerSlug: '-review' }],
    },
    {
      ...base,
      catalogSources: [{ ...base.catalogSources[0], providerSlug: 'native:../openai' }],
    },
    {
      ...base,
      catalogSources: [{ ...base.catalogSources[0], credentialAlias: '.default' }],
    },
    {
      ...base,
      catalogSources: [{ ...base.catalogSources[0], prefix: 'p model/' }],
    },
    {
      ...base,
      catalogSources: [{ ...base.catalogSources[0], prefix: `${'a'.repeat(127)}a` }],
    },
    {
      ...base,
      catalogSources: [
        {
          ...base.catalogSources[0],
          models: {
            'p/model': {
              profile: 'chat',
              efforts: [{ name: 'high', controls: { reasoning_effort: 'high' } }],
            },
          },
        },
      ],
    },
    {
      ...base,
      catalogSources: [
        {
          ...base.catalogSources[0],
          profile: 'responses',
          efforts: {
            'p/model': [{ name: 'high', controls: { reasoning_effort: 'high' } }],
          },
        },
      ],
    },
    { ...base, defaultRoute: 'review provider' },
  ];
  for (const config of cases) {
    const root = mkdtempSync(join(tmpdir(), 'relay-render-invalid-'));
    try {
      for (const app of ['dashboard', 'inference-worker']) {
        mkdirSync(join(root, 'apps', app), { recursive: true });
        copyFileSync(
          resolve('apps', app, 'wrangler.jsonc'),
          join(root, 'apps', app, 'wrangler.jsonc'),
        );
      }
      const input = join(root, 'relay.json');
      writeFileSync(input, JSON.stringify(config), { encoding: 'utf8', flag: 'wx' });
      expect(() =>
        execFileSync(
          process.execPath,
          [
            '--experimental-strip-types',
            resolve('scripts/render-wrangler-config.mts'),
            'example',
            '42',
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            '[1]',
            '[]',
            '{"enabled":false}',
            '',
            input,
          ],
          { cwd: root, stdio: 'pipe' },
        ),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

it('accepts empty and maximum-length discovery prefixes without over-restricting routes', () => {
  for (const prefix of ['', 'a'.repeat(127)]) {
    const root = mkdtempSync(join(tmpdir(), 'relay-render-prefix-'));
    try {
      for (const app of ['dashboard', 'inference-worker']) {
        mkdirSync(join(root, 'apps', app), { recursive: true });
        copyFileSync(
          resolve('apps', app, 'wrangler.jsonc'),
          join(root, 'apps', app, 'wrangler.jsonc'),
        );
      }
      const config = {
        accountId: '1'.repeat(32),
        databaseId: '12345678-1234-4321-8123-123456789abc',
        hostname: 'inference.example.net',
        gatewayId: 'example-review',
        defaultRoute: 'review',
        catalogSources: [
          {
            discovery: 'gateway',
            prefix,
            providerSlug: 'custom-review',
            credentialAlias: 'default',
          },
        ],
      };
      const input = join(root, 'relay.json');
      writeFileSync(input, JSON.stringify(config), { encoding: 'utf8', flag: 'wx' });
      execFileSync(
        process.execPath,
        [
          '--experimental-strip-types',
          resolve('scripts/render-wrangler-config.mts'),
          'example',
          '42',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '[1]',
          '[]',
          '{"enabled":false}',
          '',
          input,
        ],
        { cwd: root, stdio: 'pipe' },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

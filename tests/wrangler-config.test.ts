import { describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = resolve(repositoryRoot, 'scripts/render-wrangler-config.mts');
const githubAppId = '4715786';
const d1DatabaseId = '01234567-89ab-4cde-8123-456789abcdef';
const runnerVpcServiceId = '11234567-89ab-4cde-8123-456789abcdef';
const canonicalRunnerVpcServiceId = '01a04174-56d3-7160-ab77-fc3de2b68c57';
const allowedInstallationIds = '[7]';

type WranglerConfig = {
  workers_dev?: boolean;
  vars?: { GITHUB_APP_ID?: string; ALLOWED_INSTALLATION_IDS?: string };
  secrets?: { required?: readonly string[] };
  d1_databases?: readonly { database_id?: string }[];
  migrations?: readonly {
    tag?: string;
    new_sqlite_classes?: readonly string[];
    deleted_classes?: readonly string[];
  }[];
  containers?: unknown;
  durable_objects?: unknown;
};

const readConfig = (path: string) => readFileSync(resolve(repositoryRoot, path), 'utf8');
const parseConfigText = (source: string) =>
  JSON.parse(source.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')) as WranglerConfig;
const parseConfig = (path: string) => parseConfigText(readConfig(path));

type DeploymentFixture = {
  run: (instanceName: string) => string;
  runWithRunnerId: (instanceName: string, runnerId: string) => string;
  runWithoutRunnerId: (instanceName: string) => string;
  runWithoutInstallationIds: (instanceName: string) => string;
  runWithInstallationIds: (instanceName: string, installationIds: string) => string;
  outputs: (instanceName: string) => { core: string; ingress: string };
  read: (instanceName: string) => { core: string; ingress: string };
};

const withDeploymentFixture = <T>(callback: (fixture: DeploymentFixture) => T): T => {
  const root = mkdtempSync(join(tmpdir(), 'compte-rendu-render-'));
  const coreDirectory = join(root, 'apps/core');
  const ingressDirectory = join(root, 'apps/ingress');
  mkdirSync(coreDirectory, { recursive: true });
  mkdirSync(ingressDirectory, { recursive: true });
  copyFileSync(
    resolve(repositoryRoot, 'apps/core/wrangler.jsonc'),
    join(coreDirectory, 'wrangler.jsonc'),
  );
  copyFileSync(
    resolve(repositoryRoot, 'apps/ingress/wrangler.jsonc'),
    join(ingressDirectory, 'wrangler.jsonc'),
  );

  const outputs = (instanceName: string) => ({
    core: join(coreDirectory, `wrangler.${instanceName}.jsonc`),
    ingress: join(ingressDirectory, `wrangler.${instanceName}.jsonc`),
  });
  const invoke = (
    instanceName: string,
    runnerId?: string,
    configuredInstallationIds: string | null = allowedInstallationIds,
  ) =>
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cliPath,
        instanceName,
        githubAppId,
        d1DatabaseId,
        ...(runnerId === undefined ? [] : [runnerId]),
        ...(configuredInstallationIds === null ? [] : [configuredInstallationIds]),
      ],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' },
    );
  const read = (instanceName: string) => {
    const paths = outputs(instanceName);
    return {
      core: readFileSync(paths.core, 'utf8'),
      ingress: readFileSync(paths.ingress, 'utf8'),
    };
  };

  try {
    return callback({
      run: (instanceName) => invoke(instanceName, runnerVpcServiceId),
      runWithRunnerId: (instanceName, runnerId) => invoke(instanceName, runnerId),
      runWithoutRunnerId: (instanceName) => invoke(instanceName),
      runWithoutInstallationIds: (instanceName) => invoke(instanceName, runnerVpcServiceId, null),
      runWithInstallationIds: (instanceName, installationIds) =>
        invoke(instanceName, runnerVpcServiceId, installationIds),
      outputs,
      read,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('Wrangler deployment tooling', () => {
  it('renders independent named deployments through the real CLI', () => {
    withDeploymentFixture(({ run, read }) => {
      run('petit-chiba');
      run('second-instance');
      const first = read('petit-chiba');
      const second = read('second-instance');

      expect(first.core).toContain('"name": "petit-chiba-core"');
      expect(first.core).toContain('"database_name": "petit-chiba-review-state"');
      expect(first.core).toContain('"name": "petit-chiba-review"');
      expect(first.core).toContain('"main": "src/worker.ts"');
      expect(first.core).toContain('"migrations_dir": "migrations"');
      expect(first.core).toContain('"binding": "RUNNER"');
      expect(first.core).toContain(`"GITHUB_APP_ID": "${githubAppId}"`);
      expect(first.core).toContain(`"database_id": "${d1DatabaseId}"`);
      expect(first.ingress).toContain('"name": "petit-chiba-ingress"');
      expect(first.ingress).toContain('"service": "petit-chiba-core"');
      expect(first.ingress).toContain(`"ALLOWED_INSTALLATION_IDS": "${allowedInstallationIds}"`);

      expect(second.core).toContain('"name": "second-instance-core"');
      expect(second.core).toContain('"database_name": "second-instance-review-state"');
      expect(second.ingress).toContain('"service": "second-instance-core"');
      expect(first.core).not.toContain('second-instance');
      expect(second.core).not.toContain('petit-chiba');
    });
  });

  it('rejects empty, unsafe, or overlong instances before creating output', () => {
    withDeploymentFixture(({ run, outputs }) => {
      for (const instanceName of ['', 'unsafe/name', 'a'.repeat(51)]) {
        expect(() => run(instanceName)).toThrow();
        const paths = outputs(instanceName);
        expect(existsSync(paths.core)).toBe(false);
        expect(existsSync(paths.ingress)).toBe(false);
      }
    });
  });

  it('requires a Runner VPC Service UUID at the real renderer CLI seam', () => {
    withDeploymentFixture(({ runWithoutRunnerId: run, outputs }) => {
      expect(() => run('missing-runner-vpc')).toThrow();
      expect(existsSync(outputs('missing-runner-vpc').core)).toBe(false);
      expect(existsSync(outputs('missing-runner-vpc').ingress)).toBe(false);
    });
  });

  it('requires an installation allowlist at the real renderer CLI seam', () => {
    withDeploymentFixture(({ runWithoutInstallationIds: run, outputs }) => {
      expect(() => run('missing-installation-allowlist')).toThrow();
      expect(existsSync(outputs('missing-installation-allowlist').core)).toBe(false);
      expect(existsSync(outputs('missing-installation-allowlist').ingress)).toBe(false);
    });
  });

  it('rejects malformed installation IDs before creating output', () => {
    withDeploymentFixture(({ runWithInstallationIds: run, outputs }) => {
      expect(() => run('malformed-installation-allowlist', 'not-json')).toThrow();
      expect(existsSync(outputs('malformed-installation-allowlist').core)).toBe(false);
      expect(existsSync(outputs('malformed-installation-allowlist').ingress)).toBe(false);
    });
  });

  it('accepts the canonical Cloudflare UUIDv7 Runner VPC Service ID at the real renderer CLI seam', () => {
    withDeploymentFixture(({ runWithRunnerId: run, read }) => {
      run('canonical-vpc', canonicalRunnerVpcServiceId);

      expect(read('canonical-vpc').core).toContain(
        `"service_id": "${canonicalRunnerVpcServiceId}"`,
      );
    });
  });

  it('rejects a canonical-shape UUIDv6 Runner VPC Service ID before creating output', () => {
    const unsupportedRunnerVpcServiceId = '01a04174-56d3-6160-ab77-fc3de2b68c57';
    withDeploymentFixture(({ runWithRunnerId: run, outputs }) => {
      expect(() => run('unsupported-v6', unsupportedRunnerVpcServiceId)).toThrow();

      expect(existsSync(outputs('unsupported-v6').core)).toBe(false);
      expect(existsSync(outputs('unsupported-v6').ingress)).toBe(false);
    });
  });

  it('does not overwrite existing generated configs', () => {
    withDeploymentFixture(({ run, read }) => {
      run('petit-chiba');
      const original = read('petit-chiba');

      expect(() => run('petit-chiba')).toThrow();
      expect(read('petit-chiba')).toEqual(original);
    });
  });

  it('keeps tracked templates neutral and free of real deployment IDs', () => {
    const core = parseConfig('apps/core/wrangler.jsonc');
    const ingress = parseConfig('apps/ingress/wrangler.jsonc');

    expect(core.workers_dev).toBe(false);
    expect(ingress.workers_dev).toBe(true);
    expect(ingress.vars?.ALLOWED_INSTALLATION_IDS).toBe('REPLACE_WITH_GITHUB_INSTALLATION_IDS');
    expect(core.secrets?.required).toEqual(['GITHUB_APP_PRIVATE_KEY', 'RUNNER_AUTH_TOKEN']);
    expect(ingress.secrets?.required).toEqual(['WEBHOOK_SECRET']);
    expect(core.vars?.GITHUB_APP_ID).toBe('REPLACE_WITH_GITHUB_APP_ID');
    expect(core.d1_databases?.[0]?.database_id).toBe('REPLACE_WITH_D1_DATABASE_ID');
  });

  it('retains ordered Durable Object retirement migrations in tracked and rendered config', () => {
    const expectedMigrations = [
      {
        tag: 'v1',
        new_sqlite_classes: ['Sandbox', 'ReviewLeaseDurableObject'],
      },
      {
        tag: 'v2',
        deleted_classes: ['Sandbox', 'ReviewLeaseDurableObject'],
      },
    ];
    const tracked = parseConfig('apps/core/wrangler.jsonc');
    expect(tracked.migrations).toEqual(expectedMigrations);
    expect(tracked.containers).toBeUndefined();
    expect(tracked.durable_objects).toBeUndefined();

    withDeploymentFixture(({ run, read }) => {
      run('retired-objects');
      const rendered = parseConfigText(read('retired-objects').core);

      expect(rendered.migrations).toEqual(expectedMigrations);
      expect(rendered.containers).toBeUndefined();
      expect(rendered.durable_objects).toBeUndefined();
    });
  });
});

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

type WranglerConfig = {
  workers_dev?: boolean;
  vars?: { GITHUB_APP_ID?: string };
  secrets?: { required?: readonly string[] };
  d1_databases?: readonly { database_id?: string }[];
};

const readConfig = (path: string) => readFileSync(resolve(repositoryRoot, path), 'utf8');
const parseConfig = (path: string) =>
  JSON.parse(
    readConfig(path)
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,\s*([}\]])/g, '$1'),
  ) as WranglerConfig;

type DeploymentFixture = {
  run: (instanceName: string) => string;
  runWithoutRunnerId: (instanceName: string) => string;
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
  const invoke = (instanceName: string, runnerId?: string) =>
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cliPath,
        instanceName,
        githubAppId,
        d1DatabaseId,
        ...(runnerId === undefined ? [] : [runnerId]),
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
      runWithoutRunnerId: (instanceName) => invoke(instanceName),
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
    expect(core.secrets?.required).toEqual(['GITHUB_APP_PRIVATE_KEY', 'RUNNER_AUTH_TOKEN']);
    expect(ingress.secrets?.required).toEqual(['WEBHOOK_SECRET']);
    expect(core.vars?.GITHUB_APP_ID).toBe('REPLACE_WITH_GITHUB_APP_ID');
    expect(core.d1_databases?.[0]?.database_id).toBe('REPLACE_WITH_D1_DATABASE_ID');
  });
});

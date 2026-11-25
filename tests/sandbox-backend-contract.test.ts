import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMicrosandboxSandboxBackend } from '../apps/runner/src/sandbox-runtime-microsandbox';
import { createSbxSandboxBackend } from '../apps/runner/src/sandbox-runtime-sbx';
import { sandboxResourceName } from '../apps/runner/src/sandbox-resource-name';
import type {
  HostRun,
  JobSandbox,
  RunnerProcessResult,
  SandboxBackend,
  SandboxJobSpec,
} from '../apps/runner/src/sandbox-runtime';

const ok: RunnerProcessResult = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Rule = {
  id: string;
  resources: string[];
  sandbox_id: string;
  editable: boolean;
};
type Secret = { scope: string; type: string; name: string };
type CustomSecret = { scope: string; placeholder: string };

interface Fixture {
  readonly backend: SandboxBackend;
  readonly spec: SandboxJobSpec;
  readonly root: string;
  readonly hostRun: HostRun;
  readonly commands: string[][];
  readonly state: {
    present: boolean;
    names: string[];
    createdAt: string;
    createResult: RunnerProcessResult;
    listFailure?: RunnerProcessResult;
    policyListFailure?: RunnerProcessResult;
    rules: Rule[];
    secrets: Secret[];
    customSecrets: CustomSecret[];
    cascade: boolean;
  };
}

const specFor = (root: string, id: string, ageMs = 0): SandboxJobSpec => ({
  id,
  name: sandboxResourceName(id, Date.now() - ageMs),
  cpu: '1',
  memoryGib: 2,
  env: [],
  hostScratchRoot: join(root, 'host scratch'),
  checkoutRoot: join(root, 'checkout'),
  configRoot: join(root, 'config'),
  modelResource: 'llm.example.test:443',
  modelTokenFile: join(root, 'model-token'),
  githubResource: 'api.github.com:443',
  githubReadToken: 'fixture-github-token',
});

const createFixture = async (kind: 'sbx' | 'microsandbox'): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), `cr-contract-${kind}-`));
  roots.push(root);
  await mkdir(join(root, 'checkout'), { recursive: true });
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'model-token'), 'grant', { mode: 0o600 });
  const spec = specFor(root, crypto.randomUUID());
  await mkdir(spec.hostScratchRoot, { recursive: true, mode: 0o700 });
  const commands: string[][] = [];
  const state: Fixture['state'] = {
    present: false,
    names: [],
    createdAt: new Date().toISOString(),
    createResult: ok,
    rules: [],
    secrets: [],
    customSecrets: [],
    cascade: true,
  };
  vi.stubEnv('MODEL_SECRET_COMMAND', 'secret-resolver get MODEL_API_KEY');
  if (kind === 'microsandbox') {
    const home = join(root, 'msb');
    await mkdir(join(home, 'db'), { recursive: true });
    await writeFile(join(home, 'db', 'msb.db'), 'catalog', { mode: 0o600 });
    vi.stubEnv('MSB_HOME', home);
  }
  const hostRun: HostRun = async (_program, args) => {
    commands.push([...args]);
    if (args[0] === 'ls' && state.listFailure !== undefined) return state.listFailure;
    if (kind === 'microsandbox') {
      if (args[0] === 'ls') {
        if (state.listFailure !== undefined) return state.listFailure;
        return {
          ...ok,
          stdout: JSON.stringify(
            state.names.map((name) => ({ name, created_at: state.createdAt })),
          ),
        };
      }
      if (args[0] === 'create') {
        if (state.createResult.exitCode !== 0) return state.createResult;
        state.names = [args[args.indexOf('--name') + 1]!];
        state.present = true;
        return state.createResult;
      }
      if (args[0] === 'inspect') {
        const name = args.at(-1)!;
        if (!state.names.includes(name)) {
          return { ...ok, exitCode: 1, stderr: `error: sandbox not found: ${name}` };
        }
        return {
          ...ok,
          stdout: JSON.stringify({ name, created_at: state.createdAt }),
        };
      }
      if (args[0] === 'rm') {
        state.names = state.names.filter((name) => name !== args.at(-1));
        state.present = false;
        return ok;
      }
      return ok;
    }
    if (args[0] === 'ls' && args[1] === '-q') {
      return { ...ok, stdout: state.names.join('\n') };
    }
    if (args[0] === 'policy' && args[1] === 'ls') {
      if (state.policyListFailure !== undefined) return state.policyListFailure;
      return { ...ok, stdout: JSON.stringify({ rules: state.rules }) };
    }
    if (args[0] === 'policy' && args[1] === 'allow') {
      const resource = args.at(-1)!;
      state.rules.push({
        id: `rule-${state.rules.length + 1}`,
        resources: [resource],
        sandbox_id: spec.name,
        editable: true,
      });
      return ok;
    }
    if (args[0] === 'policy' && args[1] === 'rm') {
      const id = args[args.indexOf('--id') + 1];
      state.rules = state.rules.filter((rule) => rule.id !== id);
      return ok;
    }
    if (args[0] === 'secret' && args[1] === 'set-custom') {
      state.customSecrets.push({
        scope: spec.name,
        placeholder: args[args.indexOf('--placeholder') + 1]!,
      });
      return ok;
    }
    if (args[0] === 'secret' && args[1] === 'set') {
      state.secrets.push({ scope: spec.name, type: 'service', name: args[2]! });
      return ok;
    }
    if (args[0] === 'secret' && args[1] === 'ls') {
      const scope = args.includes('--sandbox') ? args[args.indexOf('--sandbox') + 1] : undefined;
      return {
        ...ok,
        stdout: JSON.stringify({
          secrets: state.secrets.filter((secret) => scope === undefined || secret.scope === scope),
          custom_secrets: state.customSecrets.filter(
            (secret) => scope === undefined || secret.scope === scope,
          ),
        }),
      };
    }
    if (args[0] === 'secret' && args[1] === 'rm') {
      const scope = args[args.indexOf('--sandbox') + 1];
      const placeholder = args.includes('--placeholder')
        ? args[args.indexOf('--placeholder') + 1]
        : undefined;
      const name = args[2]!;
      state.customSecrets = state.customSecrets.filter(
        (secret) => !(secret.scope === scope && secret.placeholder === placeholder),
      );
      state.secrets = state.secrets.filter(
        (secret) => !(secret.scope === scope && secret.name === name),
      );
      return ok;
    }
    if (args[0] === 'create') {
      if (state.createResult.exitCode !== 0) return state.createResult;
      state.names = [spec.name];
      state.present = true;
      return ok;
    }
    if (args[0] === 'inspect') {
      if (!state.names.includes(args[1]!)) {
        return { ...ok, exitCode: 1, stderr: `error: sandbox '${args[1]}' not found` };
      }
      return { ...ok, stdout: JSON.stringify({ name: args[1] }) };
    }
    if (args[0] === 'rm') {
      state.names = state.names.filter((name) => name !== args[2]);
      state.present = false;
      if (state.cascade) {
        state.rules = state.rules.filter((rule) => rule.sandbox_id !== args[2]);
        state.secrets = state.secrets.filter((secret) => secret.scope !== args[2]);
        state.customSecrets = state.customSecrets.filter((secret) => secret.scope !== args[2]);
      }
      return ok;
    }
    return ok;
  };
  const backend =
    kind === 'sbx'
      ? createSbxSandboxBackend({ hostRun, relayEnabled: false })
      : createMicrosandboxSandboxBackend({ hostRun, relayEnabled: true, image: 'review-image' });
  return { backend, spec, root, hostRun, commands, state };
};

const setup = async (fixture: Fixture): Promise<JobSandbox> => {
  const job = fixture.backend.createJob(fixture.spec);
  await job.setup({ run: fixture.hostRun });
  return job;
};

describe.each(['sbx', 'microsandbox'] as const)('%s backend contract', (kind) => {
  it('removes its exact sandbox after confirmed destruction', async () => {
    const fixture = await createFixture(kind);
    const job = await setup(fixture);
    await job.updateGithubReadToken?.('rotated');
    await job.destroy({ run: fixture.hostRun });
    expect(fixture.state.present).toBe(false);
    expect(fixture.state.names).toEqual([]);
    expect(job.metadata.hostCleanupConfirmed).toBe(true);
  });

  it('removes a present VM whose create installed non-editable scoped rules', async () => {
    const fixture = await createFixture(kind);
    const job = await setup(fixture);
    if (kind === 'sbx') {
      fixture.state.rules.push({
        id: 'create-installed',
        resources: ['api.github.com:443'],
        sandbox_id: fixture.spec.name,
        editable: false,
      });
    }
    await expect(job.destroy({ run: fixture.hostRun })).resolves.toBeUndefined();
    expect(fixture.state.names).toEqual([]);
    expect(fixture.state.rules.filter((rule) => rule.sandbox_id === fixture.spec.name)).toEqual([]);
  });

  it('fails closed when a non-editable scoped rule survives VM removal', async () => {
    const fixture = await createFixture('sbx');
    const job = await setup(fixture);
    fixture.state.cascade = false;
    fixture.state.rules.push({
      id: 'unremovable',
      resources: ['api.github.com:443'],
      sandbox_id: fixture.spec.name,
      editable: false,
    });
    await expect(job.destroy({ run: fixture.hostRun })).rejects.toThrow();
    expect(fixture.state.rules).toContainEqual(
      expect.objectContaining({ id: 'unremovable', sandbox_id: fixture.spec.name }),
    );
  });

  it('fails cleanup confirmation while the exact sandbox is present', async () => {
    const fixture = await createFixture(kind);
    const job = await setup(fixture);
    await expect(
      fixture.backend.confirmCleanupAbsent?.({
        jobId: fixture.spec.id,
        sandboxName: fixture.spec.name,
        recoveryProof: job.metadata.recoveryProof,
      }),
    ).rejects.toThrow();
    expect(fixture.state.present).toBe(true);
  });

  it('confirms absence and removes only scoped policies and secrets', async () => {
    const fixture = await createFixture(kind);
    const job = await setup(fixture);
    const foreignName = sandboxResourceName(crypto.randomUUID());
    if (kind === 'sbx') {
      fixture.state.rules.push({
        id: 'foreign-rule',
        resources: ['other.example.test:443'],
        sandbox_id: foreignName,
        editable: true,
      });
      fixture.state.secrets.push({ scope: foreignName, type: 'service', name: 'github' });
    }
    fixture.state.names = [];
    fixture.state.present = false;

    await expect(
      fixture.backend.confirmCleanupAbsent?.({
        jobId: fixture.spec.id,
        sandboxName: fixture.spec.name,
        recoveryProof: job.metadata.recoveryProof,
      }),
    ).resolves.toBeUndefined();
    if (kind === 'sbx') {
      expect(fixture.state.rules).toEqual([
        expect.objectContaining({ id: 'foreign-rule', sandbox_id: foreignName }),
      ]);
      expect(fixture.state.secrets).toEqual([
        expect.objectContaining({ scope: foreignName, name: 'github' }),
      ]);
    }
  });
});

describe('age sweeps', () => {
  it('removes expired exact resources and preserves fresh and unrelated resources', async () => {
    const fixture = await createFixture('sbx');
    const expired = sandboxResourceName(crypto.randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    const fresh = sandboxResourceName(crypto.randomUUID());
    const unrelated = 'other-owner-sandbox';
    fixture.state.names = [expired, fresh, unrelated];
    fixture.state.rules = [
      {
        id: 'expired-rule',
        resources: ['llm.example.test:443'],
        sandbox_id: expired,
        editable: true,
      },
      {
        id: 'fresh-rule',
        resources: ['llm.example.test:443'],
        sandbox_id: fresh,
        editable: true,
      },
      {
        id: 'unrelated-rule',
        resources: ['other.example.test:443'],
        sandbox_id: unrelated,
        editable: true,
      },
    ];
    fixture.state.secrets = [
      { scope: expired, type: 'service', name: 'github' },
      { scope: fresh, type: 'service', name: 'github' },
      { scope: unrelated, type: 'service', name: 'github' },
    ];
    fixture.state.customSecrets = [
      { scope: expired, placeholder: 'cr-expired' },
      { scope: fresh, placeholder: 'cr-fresh' },
    ];

    await expect(
      fixture.backend.reconcileOrphans!({ isLiveJob: () => false }),
    ).resolves.toMatchObject({ ok: true, recovered: 1 });

    expect(fixture.state.names).toEqual([fresh, unrelated]);
    expect(fixture.state.rules.map((rule) => rule.sandbox_id)).toEqual([fresh, unrelated]);
    expect(fixture.state.secrets.map((secret) => secret.scope)).toEqual([fresh, unrelated]);
    expect(fixture.state.customSecrets.map((secret) => secret.scope)).toEqual([fresh]);
  });

  it('removes an expired never-created scoped secret', async () => {
    const fixture = await createFixture('sbx');
    const expired = sandboxResourceName(crypto.randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    fixture.state.customSecrets = [{ scope: expired, placeholder: 'cr-never-created' }];

    await expect(
      fixture.backend.reconcileOrphans!({ isLiveJob: () => false }),
    ).resolves.toMatchObject({ ok: true, recovered: 1 });
    expect(fixture.state.customSecrets).toEqual([]);
  });

  it('skips a resource whose job is live in this Runner', async () => {
    const fixture = await createFixture('sbx');
    const expiredJob = crypto.randomUUID();
    const expired = sandboxResourceName(expiredJob, Date.now() - 3 * 60 * 60 * 1000);
    fixture.state.names = [expired];

    await expect(
      fixture.backend.reconcileOrphans!({ isLiveJob: (jobId) => jobId === expiredJob }),
    ).resolves.toMatchObject({ ok: true, recovered: 0 });
    expect(fixture.state.names).toEqual([expired]);
  });

  it.each([
    ['truncated', { ...ok, truncated: true }],
    ['failed', { ...ok, exitCode: 1, stderr: 'inventory unavailable' }],
  ])('does not remove anything when the inventory is %s', async (_name, failure) => {
    const fixture = await createFixture('sbx');
    const expired = sandboxResourceName(crypto.randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    fixture.state.names = [expired];
    fixture.state.listFailure = failure;

    await expect(
      fixture.backend.reconcileOrphans!({ isLiveJob: () => false }),
    ).resolves.toMatchObject({ ok: false, recovered: 0 });
    expect(fixture.state.names).toEqual([expired]);
  });

  it('removes only an exact retained target and rejects a mismatched identity', async () => {
    const fixture = await createFixture('microsandbox');
    const target = sandboxResourceName(crypto.randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    const other = sandboxResourceName(crypto.randomUUID());
    fixture.state.names = [target, other];

    await expect(
      fixture.backend.reconcileOrphans!({
        isLiveJob: () => false,
        only: {
          jobId: 'not-the-target',
          sandboxName: target,
          recoveryProof: { catalogIdentity: 'other-catalog' },
        },
      }),
    ).resolves.toMatchObject({ ok: false, recovered: 0 });
    expect(fixture.state.names).toEqual([target, other]);
  });
});

describe('sbx cleanup retries', () => {
  it('treats an already-removed scoped policy as done after a complete empty inventory', async () => {
    const fixture = await createFixture('sbx');
    const job = await setup(fixture);
    fixture.state.rules = [];

    await expect(job.destroy({ run: fixture.hostRun })).resolves.toBeUndefined();
    expect(fixture.state.present).toBe(false);
    expect(job.metadata.hostCleanupConfirmed).toBe(true);
  });

  it.each([
    ['truncated', { ...ok, truncated: true }],
    ['malformed', { ...ok, stdout: '{"rules":' }],
    ['failed', { ...ok, exitCode: 1, stderr: 'inventory unavailable' }],
  ])('fails closed when the cleanup policy inventory is %s', async (_name, failure) => {
    const fixture = await createFixture('sbx');
    const job = await setup(fixture);
    fixture.state.policyListFailure = failure;

    await expect(job.destroy({ run: fixture.hostRun })).rejects.toThrow();
    expect(fixture.state.rules).toHaveLength(2);
  });

  it('keeps the rotating GitHub token private under the host scratch root', async () => {
    const fixture = await createFixture('sbx');
    const job = await setup(fixture);
    await job.updateGithubReadToken!('rotated-host-token');

    const tokenPath = join(fixture.spec.hostScratchRoot, 'github-read-token');
    expect(fixture.spec.hostScratchRoot).toContain(' ');
    expect((await stat(fixture.spec.hostScratchRoot)).mode & 0o777).toBe(0o700);
    expect(tokenPath.startsWith(fixture.spec.checkoutRoot)).toBe(false);
    expect(tokenPath.startsWith(fixture.spec.configRoot)).toBe(false);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(tokenPath, 'utf8')).toBe('rotated-host-token');
    await expect(stat(`${tokenPath}.tmp`)).rejects.toThrow();

    const githubSecret = fixture.commands.find(
      (args) => args[0] === 'secret' && args[1] === 'set' && args[2] === 'github',
    )!;
    expect(githubSecret[githubSecret.indexOf('--command') + 1]).toBe(`cat '${tokenPath}'`);
    expect(githubSecret.join('\n')).not.toContain('fixture-github-token');
  });
});

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMicrosandboxSandboxBackend } from '../apps/runner/src/sandbox-runtime-microsandbox';
import { createSbxSandboxBackend } from '../apps/runner/src/sandbox-runtime-sbx';
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

const markerDirectory = (root: string, kind: 'sbx' | 'microsandbox') =>
  kind === 'sbx' ? root : join(root, 'microsandbox');

const markerFiles = async (root: string, kind: 'sbx' | 'microsandbox') => {
  try {
    return await readdir(markerDirectory(root, kind));
  } catch {
    return [];
  }
};

interface Fixture {
  readonly backend: SandboxBackend;
  readonly spec: SandboxJobSpec;
  readonly ownershipRoot: string;
  readonly root: string;
  readonly hostRun: HostRun;
  readonly commands: string[][];
  readonly state: {
    present: boolean;
    owner: string;
    createResult: RunnerProcessResult;
    policyListFailure?: RunnerProcessResult;
    rules: Array<{
      id: string;
      resources: string[];
      sandbox_id: string;
      editable: boolean;
    }>;
  };
}

const specFor = (root: string, id: string): SandboxJobSpec => ({
  id,
  name: `compte-rendu-${id}`,
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
  const ownershipRoot = join(root, 'owners');
  const spec = specFor(root, `contract-${kind}`);
  await mkdir(spec.hostScratchRoot, { recursive: true, mode: 0o700 });
  const commands: string[][] = [];
  const state: Fixture['state'] = {
    present: false,
    owner: '',
    createResult: ok,
    rules: [],
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
    if (args[0] === 'policy' && args[1] === 'ls' && state.policyListFailure !== undefined) {
      return state.policyListFailure;
    }
    if (kind === 'microsandbox') {
      if (args[0] === 'create') {
        if (state.createResult.exitCode !== 0) return state.createResult;
        state.owner = args[args.indexOf('--label') + 1]!.split('=')[1]!;
        state.present = true;
        return state.createResult;
      }
      if (args[0] === 'inspect') {
        if (!state.present) {
          return { ...ok, exitCode: 1, stderr: `error: sandbox not found: ${spec.name}` };
        }
        return {
          ...ok,
          stdout: JSON.stringify({
            name: spec.name,
            config: { labels: { 'cr-job-owner': state.owner } },
          }),
        };
      }
      if (args[0] === 'rm') {
        state.present = false;
        return ok;
      }
      return ok;
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
    if (args[0] === 'policy' && args[1] === 'ls') {
      return { ...ok, stdout: JSON.stringify({ rules: state.rules }) };
    }
    if (args[0] === 'policy' && args[1] === 'rm') {
      const id = args[args.indexOf('--id') + 1];
      state.rules = state.rules.filter((rule) => rule.id !== id);
      return ok;
    }
    if (args[0] === 'create') {
      if (state.createResult.exitCode !== 0) return state.createResult;
      state.owner = args[args.indexOf('--name') + 1] === spec.name ? 'owned' : 'unexpected';
      state.present = true;
      return ok;
    }
    if (args[0] === 'inspect') {
      if (!state.present) {
        return { ...ok, exitCode: 1, stderr: `error: sandbox '${spec.name}' not found` };
      }
      return {
        ...ok,
        stdout: JSON.stringify({
          name: spec.name,
          workspace: state.owner === 'foreign' ? join(root, 'foreign') : spec.checkoutRoot,
          additional_workspaces: [{ dir: spec.configRoot }],
        }),
      };
    }
    if (args[0] === 'rm') {
      state.present = false;
      return ok;
    }
    if (args[0] === 'secret' && args[1] === 'ls') {
      return { ...ok, stdout: JSON.stringify({ secrets: [], custom_secrets: [] }) };
    }
    return ok;
  };
  const backend =
    kind === 'sbx'
      ? createSbxSandboxBackend({
          hostRun,
          relayEnabled: false,
          ownershipRoot,
        })
      : createMicrosandboxSandboxBackend({
          hostRun,
          relayEnabled: true,
          ownershipRoot,
          image: 'review-image',
        });
  return { backend, spec, ownershipRoot, root, hostRun, commands, state };
};

const setup = async (fixture: Fixture): Promise<JobSandbox> => {
  const job = fixture.backend.createJob(fixture.spec);
  await job.setup({ run: fixture.hostRun });
  return job;
};

describe.each(['sbx', 'microsandbox'] as const)('%s backend contract', (kind) => {
  it('records ownership before attempting create', async () => {
    const fixture = await createFixture(kind);
    fixture.state.createResult = { ...ok, exitCode: 1, stderr: 'create failed' };
    const job = fixture.backend.createJob(fixture.spec);
    await expect(job.setup({ run: fixture.hostRun })).rejects.toThrow();
    expect(await markerFiles(fixture.ownershipRoot, kind)).toHaveLength(1);
  });

  it('removes its owned sandbox and marker after confirmed destruction', async () => {
    const fixture = await createFixture(kind);
    const job = await setup(fixture);
    await job.updateGithubReadToken?.('rotated');
    await job.destroy({ run: fixture.hostRun });
    expect(fixture.state.present).toBe(false);
    expect(job.metadata.hostCleanupConfirmed).toBe(true);
    expect(await markerFiles(fixture.ownershipRoot, kind)).toHaveLength(0);
  });

  it('refuses a same-name sandbox whose ownership proof does not match', async () => {
    const fixture = await createFixture(kind);
    await setup(fixture);
    if (kind === 'sbx') {
      const [marker] = await markerFiles(fixture.ownershipRoot, kind);
      const markerPath = join(markerDirectory(fixture.ownershipRoot, kind), marker!);
      const record = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
      await writeFile(
        markerPath,
        `${JSON.stringify({
          ...record,
          workspacePath: join(fixture.root, 'foreign'),
          configPath: join(fixture.root, 'foreign-config'),
        })}\n`,
        { mode: 0o600 },
      );
    } else {
      fixture.state.owner = 'foreign-owner';
    }
    const result = await fixture.backend.reconcileOrphans!({ isLiveJob: () => false });
    expect(result.ok).toBe(false);
    expect(fixture.state.present).toBe(true);
    expect(await markerFiles(fixture.ownershipRoot, kind)).toHaveLength(1);
  });

  it('refuses intent-only ownership records without removing a present sandbox', async () => {
    const fixture = await createFixture(kind);
    await setup(fixture);
    const [marker] = await markerFiles(fixture.ownershipRoot, kind);
    const markerPath = join(markerDirectory(fixture.ownershipRoot, kind), marker!);
    const record = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      markerPath,
      `${JSON.stringify({
        ...record,
        createAttempted: false,
        policyAttempted: false,
      })}\n`,
      { mode: 0o600 },
    );
    const result = await fixture.backend.reconcileOrphans!({ isLiveJob: () => false });
    expect(result.ok).toBe(false);
    expect(fixture.state.present).toBe(true);
    expect(await markerFiles(fixture.ownershipRoot, kind)).toHaveLength(1);
  });

  it('fails cleanup confirmation while the sandbox is present', async () => {
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
});

describe('sbx cleanup retries', () => {
  it('treats an already-removed owned policy as done after a complete empty inventory', async () => {
    const fixture = await createFixture('sbx');
    const job = await setup(fixture);
    fixture.state.rules = fixture.state.rules.filter((rule) => rule.id !== 'rule-1');

    await expect(job.destroy({ run: fixture.hostRun })).resolves.toBeUndefined();

    expect(fixture.state.present).toBe(false);
    expect(job.metadata.hostCleanupConfirmed).toBe(true);
    expect(await markerFiles(fixture.ownershipRoot, 'sbx')).toHaveLength(0);
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

    expect(await markerFiles(fixture.ownershipRoot, 'sbx')).toHaveLength(1);
    expect(fixture.state.rules).toHaveLength(2);
  });

  it('never removes a scoped policy it cannot prove it owns', async () => {
    const fixture = await createFixture('sbx');
    const job = await setup(fixture);
    fixture.state.rules.push({
      id: 'scoped-foreign',
      resources: ['other.example.test:443'],
      sandbox_id: fixture.spec.name,
      editable: true,
    });

    await expect(job.destroy({ run: fixture.hostRun })).rejects.toThrow();

    expect(fixture.state.rules.some((rule) => rule.id === 'scoped-foreign')).toBe(true);
    expect(fixture.commands).not.toContainEqual([
      'policy',
      'rm',
      'network',
      '--id',
      'scoped-foreign',
      '--sandbox',
      fixture.spec.name,
      '--force',
    ]);
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

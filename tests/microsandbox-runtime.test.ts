import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runProcess } from '../apps/runner/src/runner.js';
import { createMicrosandboxSandboxBackend } from '../apps/runner/src/sandbox-runtime-microsandbox.js';
import type { HostRun, SandboxExecPort } from '../apps/runner/src/sandbox-runtime.js';

it.skipIf(!process.env.CR_MICROSANDBOX_NATIVE_IMAGE)(
  'runs the review tools with read-only staging and exports evidence before destroying the VM',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-live-'));
    const id = randomUUID();
    const bin = process.env.RUNNER_SANDBOX_CLI ?? 'msb';
    const hostRun: HostRun = (_program, args, options) =>
      runProcess(bin, args, {
        captureStdout: true,
        captureStderr: true,
        maxBytes: 64 * 1024,
        timeoutMs: 60_000,
        ...options,
      });
    const exec: SandboxExecPort = { run: hostRun };
    const checkoutRoot = join(root, 'checkout');
    const configRoot = join(root, 'config');
    const token = join(root, 'grant');
    const runtime = createMicrosandboxSandboxBackend({
      hostRun,
      relayEnabled: true,
      ownershipRoot: join(root, 'owners'),
      image: process.env.CR_MICROSANDBOX_NATIVE_IMAGE!,
    }).createJob({
      id,
      name: 'compte-rendu-' + id,
      checkoutRoot,
      configRoot,
      cpu: '1',
      memoryGib: 2,
      env: [],
      modelResource: 'relay.review.test:443',
      githubResource: 'api.github.com:443',
      githubReadToken: 'synthetic-gh',
      modelTokenFile: token,
    });
    try {
      await mkdir(checkoutRoot, { mode: 0o700 });
      await mkdir(configRoot, { mode: 0o700 });
      await mkdir(join(configRoot, 'opencode'), { recursive: true });
      await writeFile(join(configRoot, 'opencode', 'skill'), 'method', { mode: 0o600 });
      await writeFile(join(checkoutRoot, 'input'), 'fixture');
      await writeFile(token, 'synthetic-grant');
      await runtime.setup(exec);
      const result = await runtime.exec(
        [
          'sh',
          '-ec',
          'test "$(cat "$XDG_CONFIG_HOME/opencode/skill")" = method; test "$(cat input)" = fixture; test -n "$GH_TOKEN"; test "$GH_TOKEN" != synthetic-gh; test "$OPENCODE_API_KEY" != synthetic-grant; ! touch forbidden; opencode --version; gh --version; mkdir -p /tmp/probe/logs; printf evidence > /tmp/probe/logs/output',
        ],
        exec,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('opencode v2.4.1');
      await expect(readFile(join(checkoutRoot, 'forbidden'))).rejects.toThrow();
      await runtime.updateGithubReadToken!('synthetic-rotated');
      const exported = await runtime.copyOut('/tmp/probe', join(root, 'output'), exec);
      expect(exported.exitCode, exported.stderr).toBe(0);
      expect(await readFile(join(root, 'output', 'logs', 'output'), 'utf8')).toBe('evidence');
    } finally {
      await runtime.destroy(exec);
      await rm(root, { recursive: true, force: true });
    }
    expect(runtime.metadata.hostCleanupConfirmed).toBe(true);
  },
  120_000,
);

it('destroys the sandbox after a pending credential update settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cr-msb-rotation-'));
  const previousHome = process.env.MSB_HOME;
  process.env.MSB_HOME = root;
  const name = 'compte-rendu-rotation';
  const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
  let owner: string | undefined;
  let rotating = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const hostRun: HostRun = async (_program, args) => {
    if (args[0] === 'create') owner = args[args.indexOf('--label') + 1]!.split('=')[1];
    if (args[0] === 'modify') {
      rotating = true;
      markStarted();
      await new Promise((resolve) => setTimeout(resolve, 100));
      rotating = false;
    }
    if (args[0] === 'inspect')
      return owner === undefined
        ? { ...ok, exitCode: 1, stderr: 'error: sandbox not found: ' + name }
        : {
            ...ok,
            stdout: JSON.stringify({ name, config: { labels: { 'cr-job-owner': owner } } }),
          };
    if (args[0] === 'rm') {
      if (rotating) return { ...ok, exitCode: 1, stderr: 'credential update in progress' };
      owner = undefined;
    }
    return ok;
  };
  const exec: SandboxExecPort = { run: hostRun };
  try {
    await mkdir(join(root, 'db'));
    await writeFile(join(root, 'db', 'msb.db'), '');
    const token = join(root, 'grant');
    await writeFile(token, 'test-grant');
    const runtime = createMicrosandboxSandboxBackend({
      hostRun,
      relayEnabled: true,
      ownershipRoot: join(root, 'owners'),
      image: 'fixture',
    }).createJob({
      id: 'rotation',
      name,
      checkoutRoot: root,
      configRoot: root,
      cpu: '1',
      memoryGib: 2,
      env: [],
      modelResource: 'relay.example:443',
      githubResource: 'api.github.com:443',
      githubReadToken: 'initial',
      modelTokenFile: token,
    });
    await runtime.setup(exec);
    const rotation = runtime.updateGithubReadToken!('replacement');
    await started;
    await Promise.all([runtime.destroy(exec), rotation]);
    expect(owner).toBeUndefined();
  } finally {
    if (previousHome === undefined) delete process.env.MSB_HOME;
    else process.env.MSB_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

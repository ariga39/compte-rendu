import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRunner, runProcess } from '../apps/runner/src/runner.js';
import { createMicrosandboxSandboxBackend } from '../apps/runner/src/sandbox-runtime-microsandbox.js';
import { sandboxResourceName } from '../apps/runner/src/sandbox-resource-name.js';
import type { HostRun, SandboxExecPort } from '../apps/runner/src/sandbox-runtime.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.skipIf(!process.env.CR_MICROSANDBOX_NATIVE_IMAGE)(
  'runs the review tools with read-only staging and exports evidence before destroying the VM',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-live-'));
    roots.push(root);
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
      image: process.env.CR_MICROSANDBOX_NATIVE_IMAGE!,
    }).createJob({
      id,
      name: sandboxResourceName(id),
      checkoutRoot,
      configRoot,
      hostScratchRoot: root,
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
  roots.push(root);
  const previousHome = process.env.MSB_HOME;
  process.env.MSB_HOME = root;
  const name = sandboxResourceName('rotation');
  const ok = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
  let present = false;
  let rotating = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const hostRun: HostRun = async (_program, args) => {
    if (args[0] === 'create') present = true;
    if (args[0] === 'modify') {
      rotating = true;
      markStarted();
      await new Promise((resolve) => setTimeout(resolve, 100));
      rotating = false;
    }
    if (args[0] === 'inspect')
      return present
        ? { ...ok, stdout: JSON.stringify({ name }) }
        : { ...ok, exitCode: 1, stderr: 'error: sandbox not found: ' + name };
    if (args[0] === 'rm') {
      if (rotating) return { ...ok, exitCode: 1, stderr: 'credential update in progress' };
      present = false;
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
      image: 'fixture',
    }).createJob({
      id: 'rotation',
      name,
      checkoutRoot: root,
      configRoot: root,
      hostScratchRoot: root,
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
    expect(present).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.MSB_HOME;
    else process.env.MSB_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

it('sweeps an expired VM on Runner startup and preserves a fresh VM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cr-msb-process-recovery-'));
  roots.push(root);
  const previous = {
    home: process.env.MSB_HOME,
    runtime: process.env.RUNNER_SANDBOX_RUNTIME,
    image: process.env.MICROSANDBOX_IMAGE,
  };
  try {
    await mkdir(join(root, 'db'));
    await writeFile(join(root, 'db', 'msb.db'), 'catalog');
    process.env.MSB_HOME = root;
    const expired = sandboxResourceName(crypto.randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    const fresh = sandboxResourceName(crypto.randomUUID());
    let names = [expired, fresh];
    const createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const fakeProcess = async (_command: string, args: readonly string[]) => {
      if (args[0] === 'ls')
        return {
          exitCode: 0,
          stdout: JSON.stringify(names.map((name) => ({ name, created_at: createdAt }))),
          timedOut: false,
          truncated: false,
        };
      if (args[0] === 'inspect') {
        const name = args.at(-1)!;
        return names.includes(name)
          ? {
              exitCode: 0,
              stdout: JSON.stringify({ name, created_at: createdAt }),
              timedOut: false,
              truncated: false,
            }
          : {
              exitCode: 1,
              stdout: '',
              stderr: `error: sandbox not found: ${name}`,
              timedOut: false,
              truncated: false,
            };
      }
      if (args[0] === 'rm') names = names.filter((name) => name !== args[2]);
      return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
    };
    process.env.RUNNER_SANDBOX_RUNTIME = 'microsandbox';
    process.env.MICROSANDBOX_IMAGE = 'fixture';
    const runner = createRunner({
      evidenceRoot: root,
      authToken: 'runner-test-token',
      claimUrl: '',
      llmRelay: true,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      modelConfig: JSON.stringify({
        id: 'opencode-go/review',
        baseUrl: 'https://llm.internal.example/v1',
        definition: { name: 'Review' },
      }),
      process: fakeProcess,
    });
    try {
      await vi.waitFor(() => expect(names).toEqual([fresh]), { timeout: 5_000 });
    } finally {
      await runner.close();
    }
  } finally {
    for (const [key, value] of [
      ['MSB_HOME', previous.home],
      ['RUNNER_SANDBOX_RUNTIME', previous.runtime],
      ['MICROSANDBOX_IMAGE', previous.image],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

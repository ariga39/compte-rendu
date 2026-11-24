import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRunner, runProcess } from '../apps/runner/src/runner.js';
import {
  createMicrosandboxSandboxBackend,
  microsandboxCatalogIdentity,
} from '../apps/runner/src/sandbox-runtime-microsandbox.js';
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

it('recovers an owned sandbox through the production process runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cr-msb-process-recovery-'));
  const previous = {
    home: process.env.MSB_HOME,
    cli: process.env.RUNNER_SANDBOX_CLI,
    runtime: process.env.RUNNER_SANDBOX_RUNTIME,
    image: process.env.MICROSANDBOX_IMAGE,
  };
  try {
    await mkdir(join(root, 'db'));
    await writeFile(join(root, 'db', 'msb.db'), 'catalog');
    process.env.MSB_HOME = root;
    const id = 'job-process-recovery';
    const sandboxName = `compte-rendu-${id}`;
    const instanceId = 'test-runner';
    const owners = join(root, 'sandbox-owners', instanceId);
    const markerRoot = join(owners, 'microsandbox');
    await mkdir(markerRoot, { recursive: true });
    const catalog = await microsandboxCatalogIdentity();
    await writeFile(
      join(markerRoot, `${createHash('sha256').update(id).digest('hex')}.json`),
      `${JSON.stringify({
        version: 1,
        jobId: id,
        sandboxName,
        catalog,
        owner: 'owner-1',
        createAttempted: true,
      })}\n`,
    );

    const stateRoot = join(root, 'state');
    await mkdir(stateRoot);
    await writeFile(join(stateRoot, 'present'), 'owner-1');
    const cli = join(root, 'msb-fixture-cli');
    await writeFile(
      cli,
      `#!/bin/sh
state="$MSB_HOME/state"
case "$1" in
  inspect)
    if [ -f "$state/present" ]; then
      owner=$(cat "$state/present")
      printf '{"name":"%s","config":{"labels":{"cr-job-owner":"%s"}}}\\n' "${sandboxName}" "$owner"
    else
      printf 'error: sandbox not found: %s\\n' "${sandboxName}" >&2
      exit 1
    fi
    ;;
  rm)
    rm -f "$state/present"
    ;;
esac
exit 0
`,
      { mode: 0o755 },
    );

    process.env.RUNNER_SANDBOX_CLI = cli;
    process.env.RUNNER_SANDBOX_RUNTIME = 'microsandbox';
    process.env.MICROSANDBOX_IMAGE = 'fixture';
    const runner = createRunner({
      evidenceRoot: root,
      instanceId,
      authToken: 'runner-test-token',
      claimUrl: '',
      llmRelay: true,
      llmRelayGeneration: 'generation-1',
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      modelConfig: JSON.stringify({
        id: 'opencode-go/review',
        baseUrl: 'https://llm.internal.example/v1',
        definition: { name: 'Review' },
      }),
      process: runProcess,
    });
    try {
      await vi.waitFor(
        async () => {
          await expect(readdir(markerRoot)).resolves.toHaveLength(0);
          await expect(readFile(join(stateRoot, 'present'))).rejects.toThrow();
        },
        { timeout: 5_000 },
      );
    } finally {
      await runner.close();
    }
  } finally {
    for (const [key, value] of [
      ['MSB_HOME', previous.home],
      ['RUNNER_SANDBOX_CLI', previous.cli],
      ['RUNNER_SANDBOX_RUNTIME', previous.runtime],
      ['MICROSANDBOX_IMAGE', previous.image],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

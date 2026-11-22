import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runProcess } from '../apps/runner/src/runner.js';
import { createMicrosandboxRuntimeFactory } from '../apps/runner/src/sandbox-runtime-microsandbox.js';
import type { SandboxCommand } from '../apps/runner/src/sandbox-runtime.js';

it.skipIf(!process.env.CR_MICROSANDBOX_NATIVE_IMAGE)(
  'runs the review tools with read-only staging and exports evidence before destroying the VM',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-live-'));
    const id = randomUUID();
    const bin = process.env.RUNNER_SANDBOX_CLI ?? 'msb';
    const command: SandboxCommand = (args, _diagnostic, options) =>
      runProcess(bin, args, {
        captureStdout: true,
        captureStderr: true,
        maxBytes: 64 * 1024,
        timeoutMs: 60_000,
        ...options,
      });
    const checkoutRoot = join(root, 'checkout');
    const configRoot = join(root, 'config');
    const token = join(root, 'grant');
    const runtime = createMicrosandboxRuntimeFactory(
      process.env.CR_MICROSANDBOX_NATIVE_IMAGE!,
      command,
    )({
      id,
      name: 'compte-rendu-' + id,
      checkoutRoot,
      configRoot,
      imageRef: 'unused',
      cpu: '1',
      memoryGib: 2,
      env: [],
      modelResource: 'relay.review.test:443',
      githubResource: 'api.github.com:443',
      githubReadToken: 'synthetic-gh',
      modelTokenFile: token,
    });
    try {
      await mkdir(checkoutRoot);
      await mkdir(join(configRoot, 'opencode'), { recursive: true });
      await writeFile(join(checkoutRoot, 'input'), 'fixture');
      await writeFile(token, 'synthetic-grant');
      await runtime.setup(command);
      const result = await runtime.exec(
        [
          'sh',
          '-ec',
          'test "$(cat input)" = fixture; test -n "$GH_TOKEN"; test "$GH_TOKEN" != synthetic-gh; test "$OPENCODE_API_KEY" != synthetic-grant; ! touch forbidden; opencode --version; gh --version; mkdir -p /tmp/probe/logs; printf evidence > /tmp/probe/logs/output',
        ],
        command,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('opencode v2.0.32');
      await expect(readFile(join(checkoutRoot, 'forbidden'))).rejects.toThrow();
      await runtime.rotateGithubReadToken!('synthetic-rotated');
      const exported = await runtime.copyOut('/tmp/probe', join(root, 'output'), command);
      expect(exported.exitCode, exported.stderr).toBe(0);
      expect(await readFile(join(root, 'output', 'logs', 'output'), 'utf8')).toBe('evidence');
    } finally {
      await runtime.destroy(command);
      await rm(root, { recursive: true, force: true });
    }
    expect(runtime.metadata.hostCleanupConfirmed).toBe(true);
  },
  120_000,
);

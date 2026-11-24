import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createOpenSandboxRuntimeFactory } from '../apps/runner/src/sandbox-runtime-opensandbox.js';
import type {
  SandboxCommand,
  SandboxOperation,
  RunnerProcessOptions,
  RunnerDiagnostic,
} from '../apps/runner/src/sandbox-runtime.js';

it.skipIf(process.env.CR_OPENSANDBOX_NATIVE_PROBE !== '1')(
  'runs the actual OpenSandbox adapter and confirms native cleanup',
  async () => {
    const stagingRoot = process.env.CR_OPENSANDBOX_PROBE_STAGE;
    const apiKeyFile = process.env.OPENSANDBOX_API_KEY_FILE;
    const image = process.env.CR_OPENSANDBOX_PROBE_IMAGE;
    if (!stagingRoot || !apiKeyFile || !image)
      throw new Error('native probe configuration missing');
    const apiKey = (await readFile(apiKeyFile, 'utf8')).trim();
    const root = await mkdtemp(join(stagingRoot, 'native-probe-'));
    const checkoutRoot = join(root, 'checkout');
    const configRoot = join(root, 'config');
    await mkdir(checkoutRoot);
    await mkdir(join(configRoot, 'opencode'), { recursive: true });
    await writeFile(join(checkoutRoot, 'fixture.txt'), 'read-only-checkout');
    const tokenFile = join(root, 'grant');
    await writeFile(tokenFile, 'dummy-model-grant', { mode: 0o600 });
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: process.env.OPENSANDBOX_ENDPOINT ?? 'http://127.0.0.1:8080',
      apiKey,
      image,
      lifetimeSeconds: 600,
    })({
      id: 'native-adapter-probe',
      name: 'native-adapter-probe',
      imageRef: 'unused',
      cpu: '1',
      memoryGib: 1,
      env: [],
      checkoutRoot,
      configRoot,
      modelResource: 'llm.compte-rendu.test:443',
      modelTokenFile: tokenFile,
      githubResource: 'api.github.com:443',
      githubReadToken: process.env.CR_OPENSANDBOX_GITHUB_TOKEN_FILE
        ? (await readFile(process.env.CR_OPENSANDBOX_GITHUB_TOKEN_FILE, 'utf8')).trim()
        : 'dummy-github-read-token',
    });
    const command: SandboxCommand = Object.assign(
      (args: readonly string[]) =>
        new Promise<{ exitCode: number; stdout: string; timedOut: boolean; truncated: boolean }>(
          (resolve, reject) => {
            const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            child.stdout?.on('data', (chunk) => {
              stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            });
            child.once('error', reject);
            child.once('close', (code) =>
              resolve({ exitCode: code ?? 1, stdout, timedOut: false, truncated: false }),
            );
          },
        ),
      {
        execute: (
          operation: SandboxOperation,
          _diagnostic?: RunnerDiagnostic,
          options?: RunnerProcessOptions,
        ) => operation({ timeoutMs: 60_000, ...options }),
      },
    );
    try {
      await runtime.setup(command);
      if (process.env.CR_OPENSANDBOX_PROBE_IMAGE !== undefined) {
        const versions = await runtime.exec(
          ['sh', '-c', 'opencode --version && gh --version'],
          command,
          { captureStdout: true, captureStderr: true, maxBytes: 4096 },
        );
        expect(versions.exitCode, versions.stderr).toBe(0);
        expect(versions.stdout).toContain('opencode v2.4.1');
        expect(versions.stdout).toContain('gh version 2.98.0');
      }
      if (process.env.CR_OPENSANDBOX_GITHUB_TOKEN_FILE) {
        expect(
          (await runtime.exec(['gh', 'api', '--silent', 'installation/repositories'], command))
            .exitCode,
        ).toBe(0);
      }
      const result = await runtime.exec(
        [
          'sh',
          '-c',
          'test "$(cat fixture.txt)" = read-only-checkout && test "$OPENCODE_API_KEY" = cr-native-adapter-probe && printf "native evidence" > /tmp/native-evidence.txt && mkdir -p /tmp/native-tree/logs && printf database > /tmp/native-tree/opencode.db && printf log > /tmp/native-tree/logs/review.log && printf native-ok',
        ],
        command,
        { captureStdout: true, maxBytes: 4096 },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('native-ok');
      const output = join(root, 'native-evidence.txt');
      expect((await runtime.copyOut('/tmp/native-evidence.txt', output, command)).exitCode).toBe(0);
      expect(await readFile(output, 'utf8')).toBe('native evidence');
      const tree = join(root, 'exported-tree');
      expect((await runtime.copyOut('/tmp/native-tree', tree, command)).exitCode).toBe(0);
      expect(await readFile(join(tree, 'opencode.db'), 'utf8')).toBe('database');
      expect(await readFile(join(tree, 'logs/review.log'), 'utf8')).toBe('log');
    } finally {
      await runtime.destroy(command);
      await rm(root, { recursive: true, force: true });
    }
    expect(runtime.metadata.hostCleanupConfirmed).toBe(true);
  },
  120_000,
);

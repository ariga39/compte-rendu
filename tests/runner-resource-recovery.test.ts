import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunner } from '../apps/runner/src/runner';
import {
  createMicrosandboxSandboxBackend,
  microsandboxCatalogIdentity,
} from '../apps/runner/src/sandbox-runtime-microsandbox';
import type {
  HostRun,
  RunnerProcessResult,
  SandboxExecPort,
  SandboxJobSpec,
} from '../apps/runner/src/sandbox-runtime';

const ok: RunnerProcessResult = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const modelConfig = JSON.stringify({
  id: 'opencode-go/review',
  baseUrl: 'https://inference.example/v1',
  definition: { name: 'Review' },
});

const markerRoot = (root: string, instanceId: string) =>
  join(root, 'sandbox-owners', instanceId, 'microsandbox');

const jobSpec = (root: string, id: string): SandboxJobSpec => ({
  id,
  name: `compte-rendu-${id}`,
  cpu: '1',
  memoryGib: 2,
  env: [],
  checkoutRoot: join(root, 'checkout'),
  configRoot: join(root, 'config'),
  modelResource: 'llm.example.test:443',
  modelTokenFile: join(root, 'model-token'),
  githubResource: 'api.github.com:443',
  githubReadToken: 'github-token',
});

const okHostRun: HostRun = async () => ok;
const execPort = (hostRun: HostRun): SandboxExecPort => ({ run: hostRun });
const createMsbBackend = (ownershipRoot: string, hostRun: HostRun = okHostRun) =>
  createMicrosandboxSandboxBackend({
    hostRun,
    relayEnabled: true,
    ownershipRoot,
    image: 'review-image',
  });
const createMsbJob = (spec: SandboxJobSpec, ownershipRoot: string, hostRun: HostRun = okHostRun) =>
  createMsbBackend(ownershipRoot, hostRun).createJob(spec);

describe('microsandbox ownership recovery', () => {
  it('removes the marker when destroy verifies the sandbox is already absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-absent-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog', { mode: 0o600 });
    await writeFile(join(root, 'model-token'), 'grant', { mode: 0o600 });
    vi.stubEnv('MSB_HOME', msbHome);
    const ownershipRoot = join(root, 'sandbox-owners', 'msb-absent-instance');
    const spec = jobSpec(root, 'msb-absent-job');
    const runtime = createMsbJob(spec, ownershipRoot);
    await runtime.setup(execPort(okHostRun));
    const absent: HostRun = async () => ({
      ...ok,
      exitCode: 1,
      stderr: `error: sandbox not found: ${spec.name}`,
    });
    await runtime.destroy(execPort(absent));
    await expect(readdir(join(ownershipRoot, 'microsandbox'))).resolves.toEqual([]);
  });

  it('leaves a present VM when the ownership marker is intent-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-intent-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog', { mode: 0o600 });
    await writeFile(join(root, 'model-token'), 'grant', { mode: 0o600 });
    vi.stubEnv('MSB_HOME', msbHome);
    const ownershipRoot = join(root, 'sandbox-owners', 'msb-intent-instance');
    const spec = jobSpec(root, 'msb-intent-job');
    const runtime = createMsbJob(spec, ownershipRoot);
    await runtime.setup(execPort(okHostRun));
    const markerDir = join(ownershipRoot, 'microsandbox');
    const [markerName] = await readdir(markerDir);
    const markerPath = join(markerDir, markerName!);
    const record = JSON.parse(await readFile(markerPath, 'utf8')) as {
      readonly owner: string;
    };
    await writeFile(markerPath, `${JSON.stringify({ ...record, createAttempted: false })}\n`, {
      mode: 0o600,
    });

    const removed: string[] = [];
    const command: HostRun = async (_program, args) => {
      if (args[0] === 'inspect')
        return {
          ...ok,
          stdout: JSON.stringify({
            name: spec.name,
            config: { labels: { 'cr-job-owner': record.owner } },
          }),
        };
      if (args[0] === 'rm') removed.push(args[2]!);
      return ok;
    };

    await expect(
      createMsbBackend(ownershipRoot, command).reconcileOrphans!({ isLiveJob: () => false }),
    ).resolves.toEqual({
      ok: false,
      recovered: 0,
      recoveredJobIds: [],
      failures: [{ jobId: spec.id, sandboxName: spec.name, step: 'record' }],
    });
    expect(removed).toEqual([]);
    expect(await readdir(markerDir)).toHaveLength(1);
  });

  it.each([
    [
      'missing grant file',
      (spec: SandboxJobSpec) => ({
        ...spec,
        modelTokenFile: join(spec.checkoutRoot, 'missing-token'),
      }),
    ],
    ['invalid host', (spec: SandboxJobSpec) => ({ ...spec, modelResource: 'api.github.com:443' })],
  ] as const)('does nothing on destroy after %s setup failure', async (failure, mutate) => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-setup-failure-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog', { mode: 0o600 });
    vi.stubEnv('MSB_HOME', msbHome);
    const ownershipRoot = join(root, 'sandbox-owners', failure);
    const spec = mutate(jobSpec(root, 'msb-setup-failure-job'));
    const runtime = createMsbJob(spec, ownershipRoot);
    const commands: string[] = [];
    const command: HostRun = async (_program, args) => {
      commands.push(args[0]!);
      return ok;
    };

    await expect(runtime.setup(execPort(command))).rejects.toThrow();
    await runtime.destroy(execPort(command));

    expect(commands).toEqual([]);
    await expect(readdir(join(ownershipRoot, 'microsandbox'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      createMsbBackend(ownershipRoot, command).reconcileOrphans!({ isLiveJob: () => false }),
    ).resolves.toEqual({
      ok: true,
      recovered: 0,
      recoveredJobIds: [],
      failures: [],
    });
  });

  it('does not reap a marker for a currently live job and still reaps a stale owned marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-live-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog', { mode: 0o600 });
    await writeFile(join(root, 'model-token'), 'grant', { mode: 0o600 });
    vi.stubEnv('MSB_HOME', msbHome);
    const ownershipRoot = join(root, 'sandbox-owners', 'msb-live-instance');
    const live = jobSpec(root, 'live-job');
    const stale = jobSpec(root, 'stale-job');
    for (const spec of [live, stale]) {
      const runtime = createMsbJob(spec, ownershipRoot);
      await runtime.setup(execPort(okHostRun));
    }
    const command: HostRun = async (_program, _args, options) => {
      const name = _args[_args.length - 1];
      if (_args[0] === 'inspect') {
        if (name === stale.name)
          return { ...ok, exitCode: 1, stderr: `error: sandbox not found: ${name}` };
        return {
          ...ok,
          stdout: JSON.stringify({
            name,
            config: { labels: { 'cr-job-owner': 'owner' } },
          }),
        };
      }
      return options?.captureStdout === true ? { ...ok, stdout: '' } : ok;
    };
    await expect(
      createMsbBackend(ownershipRoot, command).reconcileOrphans!({
        isLiveJob: (id) => id === live.id,
      }),
    ).resolves.toMatchObject({ recovered: 1, recoveredJobIds: [stale.id] });
    expect(await readdir(join(ownershipRoot, 'microsandbox'))).toHaveLength(1);
  });

  it('close stops future polls and aborts a pending claim fetch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-close-poll-'));
    roots.push(root);
    let claims = 0;
    let aborted = false;
    let started!: () => void;
    const claimStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubEnv('RUNNER_SANDBOX_RUNTIME', 'microsandbox');
    vi.stubEnv('MICROSANDBOX_IMAGE', 'review-image');
    const runner = createRunner({
      evidenceRoot: root,
      instanceId: 'close-poll-instance',
      authToken: 'runner-test-token',
      modelConfig,
      llmRelay: true,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 10,
      claimTimeoutMs: 100,
      process: async () => ok,
      claimFetch: async (_input, init) => {
        claims += 1;
        started();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('claim aborted'));
            },
            { once: true },
          );
        });
      },
    });
    await claimStarted;
    await runner.close();
    expect(aborted).toBe(true);
    expect(claims).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(claims).toBe(1);
  });

  it('close awaits the tracked ownership scan and skips remaining records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-close-scan-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog', { mode: 0o600 });
    await writeFile(join(root, 'model-token'), 'grant', { mode: 0o600 });
    vi.stubEnv('MSB_HOME', msbHome);
    const instanceId = 'close-scan-instance';
    const ownershipRoot = join(root, 'sandbox-owners', instanceId);
    for (const id of ['close-scan-a', 'close-scan-b']) {
      const runtime = createMsbJob(jobSpec(root, id), ownershipRoot);
      await runtime.setup(execPort(okHostRun));
    }
    let started!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspected: string[] = [];
    vi.stubEnv('RUNNER_SANDBOX_RUNTIME', 'microsandbox');
    vi.stubEnv('MICROSANDBOX_IMAGE', 'review-image');
    const runner = createRunner({
      evidenceRoot: root,
      instanceId,
      authToken: 'runner-test-token',
      modelConfig,
      llmRelay: true,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      claimUrl: '',
      claimIntervalMs: 10,
      process: async (_command, args) => {
        if (args[0] === 'inspect') {
          const name = args.at(-1)!;
          inspected.push(name);
          started();
          await scanGate;
          return { ...ok, exitCode: 1, stderr: `error: sandbox not found: ${name}` };
        }
        return ok;
      },
    });
    try {
      await scanStarted;
      let closed = false;
      const closing = runner.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(closed).toBe(false);
      release();
      await closing;
      expect(inspected).toHaveLength(1);
      expect(await readdir(join(ownershipRoot, 'microsandbox'))).toHaveLength(1);
    } finally {
      release();
      await runner.close();
    }
  });

  it('automatically removes an owned VM after the 30-second recovery retry and leaves a foreign VM untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-recovery-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog', { mode: 0o600 });
    await writeFile(join(root, 'model-token'), 'grant', { mode: 0o600 });
    vi.stubEnv('MSB_HOME', msbHome);
    const instanceId = 'msb-instance';
    const ownershipRoot = join(root, 'sandbox-owners', instanceId);
    const spec = jobSpec(root, 'msb-job');
    const runtime = createMsbJob(spec, ownershipRoot);
    await runtime.setup(execPort(okHostRun));
    const markerDir = markerRoot(root, instanceId);
    const [markerName] = await readdir(markerDir);
    const marker = JSON.parse(await readFile(join(markerDir, markerName!), 'utf8')) as {
      owner: string;
    };
    await expect(microsandboxCatalogIdentity()).resolves.toEqual(expect.any(String));

    let mode: 'down' | 'foreign' | 'owned' = 'down';
    let present = true;
    let inspectCalls = 0;
    let sawLocalBackend = false;
    const removed: string[] = [];
    const process = async (
      _command: string,
      args: readonly string[],
      options?: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      if (options?.env?.MSB_BACKEND === 'local') sawLocalBackend = true;
      if (args[0] === 'inspect') {
        inspectCalls += 1;
        if (mode === 'down') return { ...ok, exitCode: 1, stderr: 'microsandbox unavailable' };
        if (!present)
          return {
            ...ok,
            exitCode: 1,
            stderr: `error: sandbox not found: ${spec.name}`,
          };
        return {
          ...ok,
          stdout: JSON.stringify({
            name: spec.name,
            config: {
              labels: { 'cr-job-owner': mode === 'foreign' ? 'foreign-owner' : marker.owner },
            },
          }),
        };
      }
      if (args[0] === 'rm') {
        removed.push(args[2]!);
        present = false;
      }
      return ok;
    };

    const realSetTimeout = globalThis.setTimeout;
    let retryOwnership: (() => void) | undefined;
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 30_000) {
        retryOwnership = handler;
        return 0 as unknown as NodeJS.Timeout;
      }
      return realSetTimeout(handler, timeout, ...args);
    }) as typeof globalThis.setTimeout);
    vi.stubEnv('RUNNER_SANDBOX_RUNTIME', 'microsandbox');
    vi.stubEnv('MICROSANDBOX_IMAGE', 'review-image');
    const runner = createRunner({
      evidenceRoot: root,
      instanceId,
      authToken: 'runner-test-token',
      modelConfig,
      llmRelay: true,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      claimUrl: '',
      claimIntervalMs: 10,
      process,
    });
    try {
      await vi.waitFor(async () =>
        expect(
          await readdir(join(root, 'sandbox-owners', instanceId, 'microsandbox')),
        ).toHaveLength(1),
      );
      await vi.waitFor(async () => expect(inspectCalls).toBeGreaterThan(0));
      mode = 'foreign';
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(removed).toEqual([]);
      expect(await readdir(markerDir)).toHaveLength(1);

      mode = 'owned';
      await vi.waitFor(() => expect(retryOwnership).toBeDefined());
      retryOwnership!();
      await vi.waitFor(
        async () => expect(await readdir(markerDir).catch(() => [])).toHaveLength(0),
        { timeout: 2_000 },
      );
      expect(removed).toEqual([spec.name]);
      expect(present).toBe(false);
      expect(sawLocalBackend).toBe(true);
      expect(
        await (
          await runner.handle(
            new Request('http://runner/maintenance/drain', {
              method: 'POST',
              headers: { authorization: 'Bearer runner-test-token' },
            }),
          )
        ).json(),
      ).toMatchObject({ draining: true, drained: true, cleanupBlockedJobs: 0 });
    } finally {
      timerSpy.mockRestore();
      await runner.close();
    }
  });

  it('reports a non-ENOENT ownership root as a redacted record failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-broken-root-'));
    roots.push(root);
    const ownershipRoot = join(root, 'sandbox-owners', 'broken-instance');
    await mkdir(ownershipRoot, { recursive: true });
    // A non-directory marker root makes readdir fail with ENOTDIR, not ENOENT.
    await writeFile(join(ownershipRoot, 'microsandbox'), 'not a directory');

    const result = await createMsbBackend(ownershipRoot).reconcileOrphans!({
      isLiveJob: () => false,
    });

    expect(result).toEqual({
      ok: false,
      recovered: 0,
      recoveredJobIds: [],
      failures: [{ jobId: 'redacted', sandboxName: 'redacted', step: 'record' }],
    });
  });
});

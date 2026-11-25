import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunner } from '../apps/runner/src/runner';
import {
  createMicrosandboxSandboxBackend,
  microsandboxCatalogIdentity,
} from '../apps/runner/src/sandbox-runtime-microsandbox';
import { sandboxResourceName } from '../apps/runner/src/sandbox-resource-name';
import type { HostRun, RunnerProcessResult } from '../apps/runner/src/sandbox-runtime';

const ok: RunnerProcessResult = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const msbFixture = () => {
  const state = {
    names: [] as string[],
    createdAt: new Date().toISOString(),
    listFailure: undefined as RunnerProcessResult | undefined,
  };
  const hostRun: HostRun = async (_program, args) => {
    if (args[0] === 'ls') {
      if (state.listFailure !== undefined) return state.listFailure;
      return {
        ...ok,
        stdout: JSON.stringify(state.names.map((name) => ({ name, created_at: state.createdAt }))),
      };
    }
    if (args[0] === 'inspect') {
      const name = args.at(-1)!;
      return state.names.includes(name)
        ? { ...ok, stdout: JSON.stringify({ name, created_at: state.createdAt }) }
        : { ...ok, exitCode: 1, stderr: `error: sandbox not found: ${name}` };
    }
    if (args[0] === 'rm') state.names = state.names.filter((name) => name !== args[2]);
    return ok;
  };
  return { state, hostRun };
};

describe('microsandbox age cleanup', () => {
  it('removes an expired VM and preserves fresh and unrelated VMs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-sweep-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog');
    vi.stubEnv('MSB_HOME', msbHome);
    const { state, hostRun } = msbFixture();
    const expired = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    const fresh = sandboxResourceName(randomUUID());
    const unrelated = 'other-owner-vm';
    state.names = [expired, fresh, unrelated];
    state.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const backend = createMicrosandboxSandboxBackend({
      hostRun,
      relayEnabled: true,
      image: 'review-image',
    });

    await expect(backend.reconcileOrphans!({ isLiveJob: () => false })).resolves.toMatchObject({
      ok: true,
      recovered: 1,
    });
    expect(state.names).toEqual([fresh, unrelated]);
  });

  it('does not remove a VM whose created_at is recent even when the name is old', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-created-at-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog');
    vi.stubEnv('MSB_HOME', msbHome);
    const { state, hostRun } = msbFixture();
    const oldName = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    state.names = [oldName];
    state.createdAt = new Date().toISOString();
    const backend = createMicrosandboxSandboxBackend({
      hostRun,
      relayEnabled: true,
      image: 'review-image',
    });

    await expect(backend.reconcileOrphans!({ isLiveJob: () => false })).resolves.toMatchObject({
      ok: true,
      recovered: 0,
    });
    expect(state.names).toEqual([oldName]);
  });

  it('fails closed when the catalog inventory is incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-list-failure-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog');
    vi.stubEnv('MSB_HOME', msbHome);
    const { state, hostRun } = msbFixture();
    const expired = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    state.names = [expired];
    state.listFailure = { ...ok, truncated: true };
    const backend = createMicrosandboxSandboxBackend({
      hostRun,
      relayEnabled: true,
      image: 'review-image',
    });

    await expect(backend.reconcileOrphans!({ isLiveJob: () => false })).resolves.toMatchObject({
      ok: false,
      recovered: 0,
    });
    expect(state.names).toEqual([expired]);
  });

  it('rejects absence from a replacement catalog even when inspect says not found', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-catalog-'));
    roots.push(root);
    const originalHome = join(root, 'original');
    const otherHome = join(root, 'other');
    for (const home of [originalHome, otherHome]) {
      await mkdir(join(home, 'db'), { recursive: true });
      await writeFile(join(home, 'db', 'msb.db'), home);
    }
    vi.stubEnv('MSB_HOME', otherHome);
    const otherCatalog = await microsandboxCatalogIdentity();
    vi.stubEnv('MSB_HOME', originalHome);
    const backend = createMicrosandboxSandboxBackend({
      hostRun: async () => ({
        ...ok,
        exitCode: 1,
        stderr: 'error: sandbox not found: ' + sandboxResourceName('job'),
      }),
      relayEnabled: true,
      image: 'review-image',
    });

    await expect(
      backend.confirmCleanupAbsent?.({
        jobId: 'job',
        sandboxName: sandboxResourceName('job'),
        recoveryProof: { catalogIdentity: otherCatalog },
      }),
    ).rejects.toThrow();
  });

  it('treats a lost rm race as success when exact absence is confirmed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-rm-race-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog');
    vi.stubEnv('MSB_HOME', msbHome);
    const expired = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    let inspectCalls = 0;
    const ok: RunnerProcessResult = {
      exitCode: 0,
      stdout: '',
      timedOut: false,
      truncated: false,
    };
    const hostRun: HostRun = async (_program, args) => {
      if (args[0] === 'ls')
        return {
          ...ok,
          stdout: JSON.stringify([
            { name: expired, created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
          ]),
        };
      if (args[0] === 'inspect') {
        inspectCalls += 1;
        return inspectCalls <= 1
          ? {
              ...ok,
              stdout: JSON.stringify({
                name: expired,
                created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
              }),
            }
          : { ...ok, exitCode: 1, stderr: `error: sandbox not found: ${expired}` };
      }
      if (args[0] === 'rm') return { ...ok, exitCode: 1, stderr: 'another sweep removed the VM' };
      return ok;
    };
    const backend = createMicrosandboxSandboxBackend({
      hostRun,
      relayEnabled: true,
      image: 'review-image',
    });

    await expect(backend.reconcileOrphans!({ isLiveJob: () => false })).resolves.toMatchObject({
      ok: true,
      recovered: 1,
    });
  });

  it('keeps a surviving VM as a meaningful failure when rm also fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-rm-present-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog');
    vi.stubEnv('MSB_HOME', msbHome);
    const expired = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    const ok: RunnerProcessResult = {
      exitCode: 0,
      stdout: '',
      timedOut: false,
      truncated: false,
    };
    const hostRun: HostRun = async (_program, args) => {
      if (args[0] === 'ls')
        return {
          ...ok,
          stdout: JSON.stringify([
            { name: expired, created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
          ]),
        };
      if (args[0] === 'inspect')
        return {
          ...ok,
          stdout: JSON.stringify({
            name: expired,
            created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
          }),
        };
      if (args[0] === 'rm') return { ...ok, exitCode: 1, stderr: 'remove failed' };
      return ok;
    };
    const backend = createMicrosandboxSandboxBackend({
      hostRun,
      relayEnabled: true,
      image: 'review-image',
    });

    await expect(backend.reconcileOrphans!({ isLiveJob: () => false })).resolves.toMatchObject({
      ok: false,
      recovered: 0,
      failures: [
        expect.objectContaining({
          jobId: expect.any(String),
          sandboxName: expired,
          step: 'sandbox-present',
        }),
      ],
    });
  });

  it('sweeps an expired VM through Runner startup with an empty registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-msb-runner-sweep-'));
    roots.push(root);
    const msbHome = join(root, 'msb');
    await mkdir(join(msbHome, 'db'), { recursive: true });
    await writeFile(join(msbHome, 'db', 'msb.db'), 'catalog');
    vi.stubEnv('MSB_HOME', msbHome);
    vi.stubEnv('RUNNER_SANDBOX_RUNTIME', 'microsandbox');
    vi.stubEnv('MICROSANDBOX_IMAGE', 'review-image');
    const { state, hostRun } = msbFixture();
    const expired = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    const fresh = sandboxResourceName(randomUUID());
    state.names = [expired, fresh];
    state.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const runner = createRunner({
      evidenceRoot: root,
      authToken: 'runner-test-token',
      modelConfig: JSON.stringify({
        id: 'opencode-go/review',
        baseUrl: 'https://llm.internal.example/v1',
        definition: { name: 'Review' },
      }),
      llmRelay: true,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      claimUrl: '',
      process: async (_program, args) => hostRun('msb', args),
    });
    try {
      await vi.waitFor(() => expect(state.names).toEqual([fresh]), { timeout: 5_000 });
    } finally {
      await runner.close();
    }
  });
});

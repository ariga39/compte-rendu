import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunner } from '../apps/runner/src/runner';
import { createSbxSandboxBackend } from '../apps/runner/src/sandbox-runtime-sbx';
import { sandboxResourceName } from '../apps/runner/src/sandbox-resource-name';
import type { HostRun, RunnerProcessResult } from '../apps/runner/src/sandbox-runtime';
import { createClaimExecution } from './support/runner-execution';
import { runnerJobFields } from './support/runner-harness';

const ok: RunnerProcessResult = { exitCode: 0, stdout: '', timedOut: false, truncated: false };
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

type Rule = { id: string; resources: string[]; sandbox_id: string; editable: boolean };
type Secret = { scope: string; type: string; name: string };
type CustomSecret = { scope: string; placeholder: string };

const sandboxFixture = () => {
  const state = {
    names: [] as string[],
    rules: [] as Rule[],
    secrets: [] as Secret[],
    customSecrets: [] as CustomSecret[],
    listFailure: undefined as RunnerProcessResult | undefined,
    secretListFailure: undefined as RunnerProcessResult | undefined,
    cascade: true,
  };
  const hostRun: HostRun = async (_program, args) => {
    if (args[0] === 'ls' && args[1] === '-q') {
      if (state.listFailure !== undefined) return state.listFailure;
      return { ...ok, stdout: state.names.join('\n') };
    }
    if (args[0] === 'policy' && args[1] === 'ls')
      return { ...ok, stdout: JSON.stringify({ rules: state.rules }) };
    if (args[0] === 'policy' && args[1] === 'rm') {
      const id = args[args.indexOf('--id') + 1];
      state.rules = state.rules.filter((rule) => rule.id !== id);
      return ok;
    }
    if (args[0] === 'secret' && args[1] === 'ls') {
      if (state.secretListFailure !== undefined) return state.secretListFailure;
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
    if (args[0] === 'inspect') {
      const name = args[1]!;
      return state.names.includes(name)
        ? { ...ok, stdout: JSON.stringify({ name }) }
        : { ...ok, exitCode: 1, stderr: `error: sandbox '${name}' not found` };
    }
    if (args[0] === 'rm') {
      state.names = state.names.filter((name) => name !== args[2]);
      if (state.cascade) {
        state.rules = state.rules.filter((rule) => rule.sandbox_id !== args[2]);
        state.secrets = state.secrets.filter((secret) => secret.scope !== args[2]);
        state.customSecrets = state.customSecrets.filter((secret) => secret.scope !== args[2]);
      }
      return ok;
    }
    return ok;
  };
  return { state, hostRun };
};

const runnerOptions = (
  evidenceRoot: string,
  hostRun: HostRun,
  extra: Record<string, unknown> = {},
) => ({
  evidenceRoot,
  authToken: 'runner-test-token',
  modelConfig: JSON.stringify({
    id: 'opencode-go/review',
    baseUrl: 'https://llm.internal.example/v1',
    definition: { name: 'Review' },
  }),
  callbackUrl: 'https://ingress.test/runner-callback',
  callbackToken: 'callback-token',
  llmRelay: true,
  claimUrl: '',
  process: async (_command: string, args: readonly string[]) => hostRun('sbx', args),
  ...extra,
});

describe('sbx age cleanup', () => {
  it('removes expired VM, policies and secrets while preserving fresh and foreign resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-sweep-'));
    roots.push(root);
    const { state, hostRun } = sandboxFixture();
    const expired = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    const fresh = sandboxResourceName(randomUUID());
    const foreign = 'other-owner-sandbox';
    state.names = [expired, fresh, foreign];
    state.rules = [
      {
        id: 'expired-rule',
        resources: ['llm.example.test:443'],
        sandbox_id: expired,
        editable: true,
      },
      { id: 'fresh-rule', resources: ['llm.example.test:443'], sandbox_id: fresh, editable: true },
      {
        id: 'foreign-rule',
        resources: ['other.example.test:443'],
        sandbox_id: foreign,
        editable: true,
      },
    ];
    state.secrets = [
      { scope: expired, type: 'service', name: 'github' },
      { scope: fresh, type: 'service', name: 'github' },
      { scope: foreign, type: 'service', name: 'github' },
    ];
    state.customSecrets = [
      { scope: expired, placeholder: 'cr-expired' },
      { scope: fresh, placeholder: 'cr-fresh' },
    ];
    const runner = createRunner(runnerOptions(root, hostRun));

    try {
      await vi.waitFor(() => expect(state.names).toEqual([fresh, foreign]), { timeout: 5_000 });
      expect(state.rules.map((rule) => rule.sandbox_id)).toEqual([fresh, foreign]);
      expect(state.secrets.map((secret) => secret.scope)).toEqual([fresh, foreign]);
      expect(state.customSecrets.map((secret) => secret.scope)).toEqual([fresh]);
    } finally {
      await runner.close();
    }
  });

  it('removes an expired never-created scoped secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-orphan-secret-'));
    roots.push(root);
    const { state, hostRun } = sandboxFixture();
    const expired = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    state.customSecrets = [{ scope: expired, placeholder: 'cr-never-created' }];
    const backend = createSbxSandboxBackend({ hostRun, relayEnabled: true });

    await expect(backend.reconcileOrphans!({ isLiveJob: () => false })).resolves.toMatchObject({
      ok: true,
      recovered: 1,
    });
    expect(state.customSecrets).toEqual([]);
  });

  it('keeps concurrent sweeps idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-race-'));
    roots.push(root);
    const { state, hostRun } = sandboxFixture();
    const expired = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    state.names = [expired];
    state.secrets = [{ scope: expired, type: 'service', name: 'github' }];
    const backend = createSbxSandboxBackend({ hostRun, relayEnabled: true });

    const [first, second] = await Promise.all([
      backend.reconcileOrphans!({ isLiveJob: () => false }),
      backend.reconcileOrphans!({ isLiveJob: () => false }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(state.names).toEqual([]);
    expect(state.secrets).toEqual([]);
  });

  it('leaves everything in place when the sandbox inventory fails or truncates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-list-failure-'));
    roots.push(root);
    const { state, hostRun } = sandboxFixture();
    const expired = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    state.names = [expired];
    state.listFailure = { ...ok, truncated: true };
    const backend = createSbxSandboxBackend({ hostRun, relayEnabled: true });

    await expect(backend.reconcileOrphans!({ isLiveJob: () => false })).resolves.toMatchObject({
      ok: false,
      recovered: 0,
    });
    expect(state.names).toEqual([expired]);
  });

  it('leaves everything in place when the scoped secret inventory fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-secret-failure-'));
    roots.push(root);
    const { state, hostRun } = sandboxFixture();
    const expired = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    state.names = [expired];
    state.secretListFailure = { ...ok, exitCode: 1, stderr: 'secret inventory unavailable' };
    const backend = createSbxSandboxBackend({ hostRun, relayEnabled: true });

    await expect(backend.reconcileOrphans!({ isLiveJob: () => false })).resolves.toMatchObject({
      ok: false,
      recovered: 0,
    });
    expect(state.names).toEqual([expired]);
  });

  it('removes only an exact retained target from a trusted manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-target-'));
    roots.push(root);
    const { state, hostRun } = sandboxFixture();
    const jobId = randomUUID();
    const target = sandboxResourceName(jobId, Date.now() - 3 * 60 * 60 * 1000);
    const other = sandboxResourceName(randomUUID());
    state.names = [target, other];
    const backend = createSbxSandboxBackend({ hostRun, relayEnabled: true });

    await expect(
      backend.reconcileOrphans!({
        isLiveJob: () => false,
        only: { jobId, sandboxName: target },
      }),
    ).resolves.toMatchObject({ ok: true, recovered: 1, recoveredJobIds: [jobId] });
    expect(state.names).toEqual([other]);
  });

  it('rejects an exact target whose job identity does not match the name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-target-mismatch-'));
    roots.push(root);
    const { state, hostRun } = sandboxFixture();
    const target = sandboxResourceName(randomUUID(), Date.now() - 3 * 60 * 60 * 1000);
    state.names = [target];
    const backend = createSbxSandboxBackend({ hostRun, relayEnabled: true });

    await expect(
      backend.reconcileOrphans!({
        isLiveJob: () => false,
        only: { jobId: 'other-job', sandboxName: target },
      }),
    ).resolves.toMatchObject({ ok: false, recovered: 0 });
    expect(state.names).toEqual([target]);
  });

  it('holds queued work when sbx access is unavailable at cold start and claims after recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-cold-start-'));
    roots.push(root);
    let backendUp = false;
    let failedProbe!: () => void;
    const failedProbeSeen = new Promise<void>((resolve) => {
      failedProbe = resolve;
    });
    const execution = createClaimExecution();
    execution.enqueue({
      ...runnerJobFields,
      runId: 'run-cold-start',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
    });
    const runner = createRunner({
      ...runnerOptions(root, async (_command, args) => {
        if (backendUp) return ok;
        if (args[0] === 'ls') failedProbe();
        return { ...ok, exitCode: 1, stderr: 'not signed in to Docker' };
      }),
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 10,
      claimFetch: execution.claimFetch,
      callbackFetch: execution.callbackFetch,
    });
    try {
      await failedProbeSeen;
      expect(execution.claimRequests).toHaveLength(0);
      backendUp = true;
      await vi.waitFor(() => expect(execution.claimRequests.length).toBeGreaterThan(0), {
        timeout: 5_000,
      });
    } finally {
      await runner.close();
    }
  });

  it('does not hold a healthy claim behind a slow startup inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-claim-'));
    roots.push(root);
    const { hostRun } = sandboxFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const inventoryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const claim = createClaimExecution();
    const runner = createRunner({
      ...runnerOptions(root, async (program, args) => {
        if (args[0] === 'ls' && args[1] === '-q') {
          started();
          await gate;
        }
        return hostRun(program, args);
      }),
      claimUrl: 'https://ingress.test/runner-claim',
      claimIntervalMs: 10,
      claimFetch: claim.claimFetch,
      callbackFetch: claim.callbackFetch,
    });
    try {
      await inventoryStarted;
      await vi.waitFor(() => expect(claim.claimRequests.length).toBeGreaterThan(0));
    } finally {
      release();
      await runner.close();
    }
  });

  it('confirms absence only after the exact sandbox is gone and cleans scoped resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-confirm-'));
    roots.push(root);
    const { state, hostRun } = sandboxFixture();
    const jobId = randomUUID();
    const name = sandboxResourceName(jobId);
    state.names = [name];
    state.rules = [
      { id: 'owned-rule', resources: ['llm.example.test:443'], sandbox_id: name, editable: true },
    ];
    state.secrets = [{ scope: name, type: 'service', name: 'github' }];
    state.customSecrets = [{ scope: name, placeholder: `cr-${jobId}` }];
    const backend = createSbxSandboxBackend({ hostRun, relayEnabled: true });

    await expect(backend.confirmCleanupAbsent?.({ jobId, sandboxName: name })).rejects.toThrow();
    expect(state.rules).toHaveLength(1);

    state.names = [];
    await expect(
      backend.confirmCleanupAbsent?.({ jobId, sandboxName: name }),
    ).resolves.toBeUndefined();
    expect(state.rules).toEqual([]);
    expect(state.secrets).toEqual([]);
    expect(state.customSecrets).toEqual([]);
  });
});

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunner } from '../apps/runner/src/runner';
import { createClaimExecution } from './support/runner-execution';
import { createSbxRuntimeFactory } from '../apps/runner/src/sandbox-runtime-sbx';
import type {
  RunnerProcessResult,
  SandboxCommand,
  SandboxJobSpec,
  SandboxOperation,
} from '../apps/runner/src/sandbox-runtime';

const ok: RunnerProcessResult = {
  exitCode: 0,
  stdout: '',
  timedOut: false,
  truncated: false,
};

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const maintenance = (
  runner: ReturnType<typeof createRunner>,
  path: 'drain' | 'resume',
): Promise<Response> =>
  runner.handle(
    new Request(`http://runner/maintenance/${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer runner-test-token' },
    }),
  );

const expectDrained = async (runner: ReturnType<typeof createRunner>) => {
  await maintenance(runner, 'drain');
  await vi.waitFor(async () => {
    const response = await runner.handle(
      new Request('http://runner/maintenance', {
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );
    expect(await response.json()).toMatchObject({
      draining: true,
      drained: true,
      claimPollingHalted: false,
    });
  });
};

const jobSpec = (root: string, id: string): SandboxJobSpec => ({
  id,
  name: `compte-rendu-${id}`,
  imageRef: 'review-image',
  cpu: '1',
  memoryGib: 2,
  env: [],
  checkoutRoot: join(root, 'checkout'),
  configRoot: join(root, 'config'),
  modelResource: 'llm.example.test:443',
  githubResource: 'api.github.com:443',
  githubReadToken: 'host-only-github',
});

const setupCommand = (
  spec: SandboxJobSpec,
  failure: 'github' | 'policy' | 'create' | 'create-timeout' | null,
): SandboxCommand => {
  const rule = {
    id: 'owned-rule',
    resources: [spec.modelResource, spec.githubResource],
    sandbox_id: spec.name,
    editable: true,
  };
  return Object.assign(
    async (args: readonly string[]): Promise<RunnerProcessResult> => {
      if (args[0] === 'policy' && args[1] === 'ls')
        return { ...ok, stdout: JSON.stringify({ rules: [rule] }) };
      if (failure === 'github' && args[0] === 'secret' && args[1] === 'set')
        return { ...ok, exitCode: 1, stderr: 'github secret setup failed' };
      if (failure === 'create' && args[0] === 'create')
        return { ...ok, exitCode: 1, stderr: 'create failed' };
      if (failure === 'create-timeout' && args[0] === 'create')
        return { ...ok, exitCode: 1, timedOut: true };
      if (failure === 'policy' && args[0] === 'policy' && args[1] === 'allow')
        return { ...ok, exitCode: 1 };
      return ok;
    },
    {
      execute: async (operation: SandboxOperation) => operation({}),
    },
  );
};

// Sanitized `sbx inspect --json` fixture using the pinned 0.48.0 wire fields.
const inspectView = async (
  sandboxName: string,
  workspace: string,
  config: string,
): Promise<Record<string, unknown>> => {
  const text = await readFile(new URL('./fixtures/sbx-inspect-view.json', import.meta.url), 'utf8');
  return JSON.parse(
    text
      .replaceAll('__SANDBOX_NAME__', sandboxName)
      .replaceAll('__WORKSPACE__', workspace)
      .replaceAll('__CONFIG__', config),
  ) as Record<string, unknown>;
};

const DEFAULT_INSTANCE_ID = 'test-runner';
const ownershipRoot = (root: string, instanceId = DEFAULT_INSTANCE_ID) =>
  join(root, 'sandbox-owners', instanceId);

const runnerOptions = (
  evidenceRoot: string,
  process: (args: readonly string[]) => Promise<RunnerProcessResult>,
  instanceId = DEFAULT_INSTANCE_ID,
) => ({
  evidenceRoot,
  instanceId,
  authToken: 'runner-test-token',
  modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
  modelConfig: JSON.stringify({
    id: 'opencode-go/review',
    baseUrl: 'https://llm.internal.example/v1',
    definition: { name: 'Review' },
  }),
  callbackUrl: 'https://ingress.test/runner-callback',
  callbackToken: 'callback-token',
  claimUrl: '',
  process: async (_command: string, args: readonly string[]) => process(args),
});

const claimExecutions = new WeakMap<object, ReturnType<typeof createClaimExecution>>();

const createSbxRunner = (options: Parameters<typeof createRunner>[0]) => {
  const claim = createClaimExecution();
  const runner = createRunner({
    ...options,
    claimUrl: 'https://ingress.test/runner-claim',
    claimIntervalMs: 10,
    claimFetch: claim.claimFetch,
    callbackFetch: claim.callbackFetch,
  });
  claimExecutions.set(runner, claim);
  return runner;
};

const claimGate = (runner: ReturnType<typeof createRunner>) => {
  const claim = claimExecutions.get(runner);
  if (claim === undefined) throw new Error('missing claim fixture');
  return claim;
};

const claimGateOpen = async (runner: ReturnType<typeof createRunner>) => {
  await vi.waitFor(() => expect(claimGate(runner).claimRequests.length).toBeGreaterThan(0));
};

const notFound = (name: string): RunnerProcessResult => ({
  ...ok,
  exitCode: 1,
  stderr: `error: sandbox '${name}' not found`,
});

const secretState = () => ({
  custom: true,
  github: true,
});

const secretCommand = (
  args: readonly string[],
  state: ReturnType<typeof secretState>,
  spec: SandboxJobSpec,
): RunnerProcessResult | undefined => {
  if (args[0] !== 'secret') return undefined;
  if (args[1] === 'rm') {
    if (args[2] === '--placeholder') state.custom = false;
    if (args[2] === 'github') state.github = false;
    return ok;
  }
  if (args[1] === 'ls')
    return {
      ...ok,
      stdout: JSON.stringify({
        secrets: state.github ? [{ scope: spec.name, type: 'service', name: 'github' }] : [],
        custom_secrets: state.custom ? [{ scope: spec.name, placeholder: `cr-${spec.id}` }] : [],
      }),
    };
  return undefined;
};

describe('Runner sbx startup reconciliation', () => {
  it('removes a provably owned Sandbox left by interrupted setup without touching another sandbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-restart-'));
    roots.push(root);
    vi.stubEnv('TMPDIR', root);
    const spec = jobSpec(root, 'job-interrupted');
    await mkdir(spec.checkoutRoot, { recursive: true });
    await mkdir(spec.configRoot, { recursive: true });
    const runtime = createSbxRuntimeFactory({
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      ownershipRoot: ownershipRoot(root),
    })(spec);

    await expect(runtime.setup(setupCommand(spec, 'policy'))).rejects.toThrow();

    const ownedRule = {
      id: 'owned-rule',
      resources: [spec.modelResource, spec.githubResource],
      sandbox_id: spec.name,
      editable: true,
    };
    const foreignRule = {
      id: 'foreign-rule',
      resources: ['other.example.test:443'],
      sandbox_id: 'other-sandbox',
      editable: true,
    };
    let present = true;
    const secrets = secretState();
    const commands: string[][] = [];
    const runner = createSbxRunner(
      runnerOptions(root, async (args) => {
        commands.push([...args]);
        const secret = secretCommand(args, secrets, spec);
        if (secret !== undefined) return secret;
        if (args[0] === 'inspect') {
          if (!present) return notFound(spec.name);
          return {
            ...ok,
            stdout: JSON.stringify(
              await inspectView(spec.name, spec.checkoutRoot, spec.configRoot),
            ),
          };
        }
        if (args[0] === 'policy' && args[1] === 'ls')
          return {
            ...ok,
            stdout: JSON.stringify({ rules: present ? [ownedRule, foreignRule] : [] }),
          };
        if (args[0] === 'rm') present = false;
        return ok;
      }),
    );

    try {
      await vi.waitFor(() => expect(commands.some((args) => args[0] === 'rm')).toBe(true));
      expect(commands).toContainEqual([
        'policy',
        'rm',
        'network',
        '--id',
        'owned-rule',
        '--sandbox',
        spec.name,
        '--force',
      ]);
      expect(commands).not.toContainEqual([
        'policy',
        'rm',
        'network',
        '--id',
        'foreign-rule',
        '--sandbox',
        'other-sandbox',
        '--force',
      ]);
      expect(commands).toContainEqual([
        'secret',
        'rm',
        '--placeholder',
        `cr-${spec.id}`,
        '--sandbox',
        spec.name,
        '--force',
      ]);
      expect(commands).toContainEqual([
        'secret',
        'rm',
        'github',
        '--sandbox',
        spec.name,
        '--force',
      ]);
      expect(commands).toContainEqual(['secret', 'ls', '--json', '--sandbox', spec.name]);
      await claimGateOpen(runner);
      await expectDrained(runner);
    } finally {
      await runner.close();
    }
  });

  it('reconciles an interrupted setup that never created a Sandbox without touching policies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-restart-'));
    roots.push(root);
    vi.stubEnv('TMPDIR', root);
    const spec = jobSpec(root, 'job-no-create');
    await mkdir(spec.checkoutRoot, { recursive: true });
    await mkdir(spec.configRoot, { recursive: true });
    const runtime = createSbxRuntimeFactory({
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      ownershipRoot: ownershipRoot(root),
    })(spec);

    await expect(runtime.setup(setupCommand(spec, 'create'))).rejects.toThrow();

    const secrets = secretState();
    const commands: string[][] = [];
    const runner = createSbxRunner(
      runnerOptions(root, async (args) => {
        commands.push([...args]);
        const secret = secretCommand(args, secrets, spec);
        if (secret !== undefined) return secret;
        if (args[0] === 'inspect') return notFound(spec.name);
        return ok;
      }),
    );

    try {
      await vi.waitFor(() =>
        expect(
          commands.some(
            (args) => args[0] === 'secret' && args[1] === 'rm' && args[2] === '--placeholder',
          ),
        ).toBe(true),
      );
      expect(commands.some((args) => args[0] === 'rm')).toBe(false);
      expect(commands.some((args) => args[0] === 'policy')).toBe(false);
      expect(commands).toContainEqual([
        'secret',
        'rm',
        'github',
        '--sandbox',
        spec.name,
        '--force',
      ]);
      await claimGateOpen(runner);
    } finally {
      await runner.close();
    }
  });

  it('removes a timed-out created Sandbox without touching policies it never attempted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-restart-'));
    roots.push(root);
    vi.stubEnv('TMPDIR', root);
    const spec = jobSpec(root, 'job-create-timeout');
    await mkdir(spec.checkoutRoot, { recursive: true });
    await mkdir(spec.configRoot, { recursive: true });
    const runtime = createSbxRuntimeFactory({
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      ownershipRoot: ownershipRoot(root),
    })(spec);

    await expect(runtime.setup(setupCommand(spec, 'create-timeout'))).rejects.toThrow();

    let present = true;
    const secrets = secretState();
    const commands: string[][] = [];
    const runner = createSbxRunner(
      runnerOptions(root, async (args) => {
        commands.push([...args]);
        const secret = secretCommand(args, secrets, spec);
        if (secret !== undefined) return secret;
        if (args[0] === 'inspect') {
          if (!present) return notFound(spec.name);
          return {
            ...ok,
            stdout: JSON.stringify(
              await inspectView(spec.name, spec.checkoutRoot, spec.configRoot),
            ),
          };
        }
        if (args[0] === 'rm') present = false;
        return ok;
      }),
    );

    try {
      await vi.waitFor(() => expect(commands.some((args) => args[0] === 'rm')).toBe(true));
      expect(commands.some((args) => args[0] === 'policy')).toBe(false);
      await claimGateOpen(runner);
    } finally {
      await runner.close();
    }
  });

  it('rejects a present same-name Sandbox when creation was only an intent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-restart-'));
    roots.push(root);
    vi.stubEnv('TMPDIR', root);
    const spec = jobSpec(root, 'job-before-create');
    await mkdir(spec.checkoutRoot, { recursive: true });
    await mkdir(spec.configRoot, { recursive: true });
    const runtime = createSbxRuntimeFactory({
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      ownershipRoot: ownershipRoot(root),
    })(spec);

    await expect(runtime.setup(setupCommand(spec, 'github'))).rejects.toThrow();

    const secrets = secretState();
    const commands: string[][] = [];
    const runner = createSbxRunner(
      runnerOptions(root, async (args) => {
        commands.push([...args]);
        const secret = secretCommand(args, secrets, spec);
        if (secret !== undefined) return secret;
        if (args[0] === 'inspect')
          return {
            ...ok,
            stdout: JSON.stringify(
              await inspectView(spec.name, spec.checkoutRoot, spec.configRoot),
            ),
          };
        return ok;
      }),
    );

    try {
      await vi.waitFor(() => expect(commands.some((args) => args[0] === 'inspect')).toBe(true));
      await vi.waitFor(async () => {
        expect(await (await maintenance(runner, 'drain')).json()).toMatchObject({
          drained: false,
          claimPollingHalted: false,
        });
      });
      expect(commands.some((args) => args[0] === 'rm')).toBe(false);
      expect(commands.some((args) => args[0] === 'policy' && args[1] === 'rm')).toBe(false);
      expect(commands.some((args) => args[0] === 'secret' && args[1] === 'rm')).toBe(false);
      await claimGateOpen(runner);
    } finally {
      await runner.close();
    }
  });

  it('ignores an expected string in unrelated inspect metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-restart-'));
    roots.push(root);
    vi.stubEnv('TMPDIR', root);
    const spec = jobSpec(root, 'job-metadata');
    await mkdir(spec.checkoutRoot, { recursive: true });
    await mkdir(spec.configRoot, { recursive: true });
    const runtime = createSbxRuntimeFactory({
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      ownershipRoot: ownershipRoot(root),
    })(spec);
    await runtime.setup(setupCommand(spec, null));

    const foreign = await inspectView(
      spec.name,
      join(root, 'unrelated-workspace'),
      join(root, 'unrelated-config'),
    );
    foreign.kits = [spec.checkoutRoot];
    foreign.secrets = [{ name: `cr-${spec.id}` }];
    const secrets = secretState();
    const commands: string[][] = [];
    const runner = createSbxRunner(
      runnerOptions(root, async (args) => {
        commands.push([...args]);
        const secret = secretCommand(args, secrets, spec);
        if (secret !== undefined) return secret;
        if (args[0] === 'inspect') return { ...ok, stdout: JSON.stringify(foreign) };
        if (args[0] === 'policy' && args[1] === 'ls')
          return { ...ok, stdout: JSON.stringify({ rules: [] }) };
        return ok;
      }),
    );

    try {
      await vi.waitFor(() => expect(commands.some((args) => args[0] === 'inspect')).toBe(true));
      await vi.waitFor(async () => {
        expect(await (await maintenance(runner, 'drain')).json()).toMatchObject({
          drained: false,
          claimPollingHalted: false,
        });
      });
      expect(commands.some((args) => args[0] === 'rm')).toBe(false);
      expect(commands.some((args) => args[0] === 'policy' && args[1] === 'rm')).toBe(false);
      expect(commands.some((args) => args[0] === 'secret' && args[1] === 'rm')).toBe(false);
      await claimGateOpen(runner);
    } finally {
      await runner.close();
    }
  });

  it('keeps an uncertain verification fail-closed without deleting anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-restart-'));
    roots.push(root);
    vi.stubEnv('TMPDIR', root);
    const spec = jobSpec(root, 'job-uncertain');
    await mkdir(spec.checkoutRoot, { recursive: true });
    await mkdir(spec.configRoot, { recursive: true });
    const runtime = createSbxRuntimeFactory({
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      ownershipRoot: ownershipRoot(root),
    })(spec);
    await runtime.setup(setupCommand(spec, null));

    const secrets = secretState();
    const commands: string[][] = [];
    const runner = createSbxRunner(
      runnerOptions(root, async (args) => {
        commands.push([...args]);
        const secret = secretCommand(args, secrets, spec);
        if (secret !== undefined) return secret;
        if (args[0] === 'inspect')
          return {
            ...ok,
            exitCode: 1,
            stderr: 'not signed in to Docker',
          };
        return ok;
      }),
    );

    try {
      await vi.waitFor(() => expect(commands.some((args) => args[0] === 'inspect')).toBe(true));
      await vi.waitFor(async () => {
        expect(await (await maintenance(runner, 'drain')).json()).toMatchObject({
          drained: false,
          claimPollingHalted: false,
        });
      });
      expect(commands.some((args) => args[0] === 'rm')).toBe(false);
      expect(commands.some((args) => args[0] === 'policy' && args[1] === 'rm')).toBe(false);
      expect(commands.some((args) => args[0] === 'secret' && args[1] === 'rm')).toBe(false);
      await claimGateOpen(runner);
    } finally {
      await runner.close();
    }
  });

  it.each([
    {
      name: 'missing envelope',
      listed: { ...ok, stdout: '{"error":"unavailable"}' },
    },
    {
      name: 'unusable candidate identity',
      listed: { ...ok, stdout: '{"secrets":[{}],"custom_secrets":[]}' },
    },
    {
      name: 'stream error',
      listed: { ...ok, stdout: '{"secrets":[],"custom_secrets":[]}', streamError: true },
    },
  ])('keeps the record for malformed native secret listing: $name', async ({ listed }) => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-restart-'));
    roots.push(root);
    vi.stubEnv('TMPDIR', root);
    const spec = jobSpec(root, 'job-secret-malformed');
    await mkdir(spec.checkoutRoot, { recursive: true });
    await mkdir(spec.configRoot, { recursive: true });
    const runtime = createSbxRuntimeFactory({
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      ownershipRoot: ownershipRoot(root),
    })(spec);
    await runtime.setup(setupCommand(spec, null));

    let present = true;
    const commands: string[][] = [];
    const runner = createSbxRunner(
      runnerOptions(root, async (args) => {
        commands.push([...args]);
        if (args[0] === 'inspect') {
          if (!present) return notFound(spec.name);
          return {
            ...ok,
            stdout: JSON.stringify(
              await inspectView(spec.name, spec.checkoutRoot, spec.configRoot),
            ),
          };
        }
        if (args[0] === 'policy' && args[1] === 'ls')
          return { ...ok, stdout: JSON.stringify({ rules: [] }) };
        if (args[0] === 'rm') present = false;
        if (args[0] === 'secret' && args[1] === 'ls') return listed;
        return ok;
      }),
    );

    try {
      await vi.waitFor(() =>
        expect(commands).toContainEqual(['secret', 'ls', '--json', '--sandbox', spec.name]),
      );
      await vi.waitFor(async () => {
        expect(await (await maintenance(runner, 'drain')).json()).toMatchObject({
          drained: false,
          claimPollingHalted: false,
        });
      });
      await claimGateOpen(runner);
    } finally {
      await runner.close();
    }
  });

  it('keeps the record when native secret removal is not confirmed absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-restart-'));
    roots.push(root);
    vi.stubEnv('TMPDIR', root);
    const spec = jobSpec(root, 'job-secret-postcondition');
    await mkdir(spec.checkoutRoot, { recursive: true });
    await mkdir(spec.configRoot, { recursive: true });
    const runtime = createSbxRuntimeFactory({
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      ownershipRoot: ownershipRoot(root),
    })(spec);
    await runtime.setup(setupCommand(spec, null));

    let present = true;
    const commands: string[][] = [];
    const runner = createSbxRunner(
      runnerOptions(root, async (args) => {
        commands.push([...args]);
        if (args[0] === 'inspect') {
          if (!present) return notFound(spec.name);
          return {
            ...ok,
            stdout: JSON.stringify(
              await inspectView(spec.name, spec.checkoutRoot, spec.configRoot),
            ),
          };
        }
        if (args[0] === 'policy' && args[1] === 'ls')
          return { ...ok, stdout: JSON.stringify({ rules: [] }) };
        if (args[0] === 'rm') present = false;
        if (args[0] === 'secret' && args[1] === 'ls')
          return {
            ...ok,
            stdout: JSON.stringify({
              secrets: [{ scope: spec.name, type: 'service', name: 'github' }],
              custom_secrets: [{ scope: spec.name, placeholder: `cr-${spec.id}` }],
            }),
          };
        return ok;
      }),
    );

    try {
      await vi.waitFor(() =>
        expect(commands).toContainEqual(['secret', 'ls', '--json', '--sandbox', spec.name]),
      );
      await vi.waitFor(async () => {
        expect(await (await maintenance(runner, 'drain')).json()).toMatchObject({
          drained: false,
          claimPollingHalted: false,
        });
      });
      await claimGateOpen(runner);
    } finally {
      await runner.close();
    }
  });

  it('does not reconcile ownership records belonging to a co-located Runner instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-restart-'));
    roots.push(root);
    vi.stubEnv('TMPDIR', root);
    vi.stubEnv('XDG_STATE_HOME', root);
    vi.stubEnv('PORT', '9101');
    const defaultEvidenceRoot = join(root, 'compte-rendu', 'reviews');
    const spec = jobSpec(root, 'job-colocated');
    await mkdir(spec.checkoutRoot, { recursive: true });
    await mkdir(spec.configRoot, { recursive: true });
    const runtime = createSbxRuntimeFactory({
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      ownershipRoot: ownershipRoot(defaultEvidenceRoot, 'port-9101'),
    })(spec);
    await runtime.setup(setupCommand(spec, null));

    vi.stubEnv('PORT', '9102');
    const siblingCommands: string[][] = [];
    const sibling = createSbxRunner({
      ...runnerOptions(
        root,
        async (args) => {
          siblingCommands.push([...args]);
          return ok;
        },
        'runner-b',
      ),
      evidenceRoot: undefined,
      instanceId: undefined,
    });
    try {
      await claimGateOpen(sibling);
      expect(siblingCommands).toEqual([]);
    } finally {
      await sibling.close();
    }

    let present = true;
    const secrets = secretState();
    vi.stubEnv('PORT', '9101');
    const ownCommands: string[][] = [];
    const own = createSbxRunner({
      ...runnerOptions(
        root,
        async (args) => {
          ownCommands.push([...args]);
          const secret = secretCommand(args, secrets, spec);
          if (secret !== undefined) return secret;
          if (args[0] === 'inspect') {
            if (!present) return notFound(spec.name);
            return {
              ...ok,
              stdout: JSON.stringify(
                await inspectView(spec.name, spec.checkoutRoot, spec.configRoot),
              ),
            };
          }
          if (args[0] === 'policy' && args[1] === 'ls')
            return { ...ok, stdout: JSON.stringify({ rules: [] }) };
          if (args[0] === 'rm') present = false;
          return ok;
        },
        'runner-a',
      ),
      evidenceRoot: undefined,
      instanceId: undefined,
    });
    try {
      await vi.waitFor(() => expect(ownCommands.some((args) => args[0] === 'rm')).toBe(true));
      await claimGateOpen(own);
    } finally {
      await own.close();
    }
  });

  it('attributes a failed startup scan and retries it automatically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-sbx-restart-'));
    roots.push(root);
    vi.stubEnv('TMPDIR', root);
    const spec = jobSpec(root, 'job-resume-retry');
    await mkdir(spec.checkoutRoot, { recursive: true });
    await mkdir(spec.configRoot, { recursive: true });
    const runtime = createSbxRuntimeFactory({
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      ownershipRoot: ownershipRoot(root),
    })(spec);
    await runtime.setup(setupCommand(spec, null));

    let mode: 'failed' | 'owned' = 'failed';
    let present = true;
    const secrets = secretState();
    const events: unknown[] = [];
    const canary = 'ghp_CANARY_SECRET_MUST_NOT_APPEAR_IN_LOGS';
    const canaryUrl = 'https://user:canary@example.test/path?token=ghp_CANARY';
    const runner = createSbxRunner({
      ...runnerOptions(root, async (args) => {
        const secret = secretCommand(args, secrets, spec);
        if (secret !== undefined) return secret;
        if (args[0] === 'inspect') {
          if (mode === 'failed')
            return {
              ...ok,
              exitCode: 1,
              stderr: `not signed in to Docker; token=${canary}; ${canaryUrl}`,
            };
          if (!present) return notFound(spec.name);
          return {
            ...ok,
            stdout: JSON.stringify(
              await inspectView(spec.name, spec.checkoutRoot, spec.configRoot),
            ),
          };
        }
        if (args[0] === 'policy' && args[1] === 'ls')
          return { ...ok, stdout: JSON.stringify({ rules: [] }) };
        if (args[0] === 'rm') present = false;
        return ok;
      }),
      log: { record: (event) => void events.push(event) },
    });

    try {
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            phase: 'runner',
            outcome: 'sandbox-recovery',
            recovered: 0,
            blocked: 1,
            failures: [
              expect.objectContaining({
                jobId: spec.id,
                sandboxName: spec.name,
                step: 'inspect',
                command: 'inspect',
                exitCode: 1,
                timedOut: false,
                truncated: false,
                stderrTruncated: false,
                streamError: false,
                processError: false,
              }),
            ],
          }),
        ),
      );
      const recoveryEvent = events.find((event) =>
        JSON.stringify(event).includes('"outcome":"sandbox-recovery"'),
      );
      expect(recoveryEvent).toBeDefined();
      expect(JSON.stringify(recoveryEvent)).not.toContain(canary);
      expect(JSON.stringify(recoveryEvent)).not.toContain('canary@example.test');
      expect(
        (recoveryEvent as { failures?: Array<Record<string, unknown>> }).failures?.[0],
      ).not.toHaveProperty('stderr');
      expect(await (await maintenance(runner, 'drain')).json()).toMatchObject({
        drained: false,
        claimPollingHalted: false,
      });
      mode = 'owned';
      await expectDrained(runner);
    } finally {
      await runner.close();
    }
  });
});

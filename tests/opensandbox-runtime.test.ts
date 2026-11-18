import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionHandlers } from '@alibaba-group/opensandbox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenSandboxRuntimeFactory } from '../apps/runner/src/sandbox-runtime-opensandbox.js';
import {
  SandboxCreateError,
  type SandboxCommand,
  type SandboxJobSpec,
  type SandboxOperation,
  type RunnerProcessOptions,
} from '../apps/runner/src/sandbox-runtime.js';

const backend = vi.hoisted(() => ({
  managerClosed: false,
  directory: false,
  unsafeEntry: null as string | null,
  unsafeType: 'file',
  created: false,
  owner: '',
  vault: false,
  vaultRequest: null as unknown,
  failCreate: null as Error | null,
  provisionOnFailedCreate: false,
  listError: null as Error | null,
  listErrorStatus: null as number | null,
  infoError: null as Error | null,
  infoErrorStatus: null as number | null,
  downloadFactory: null as
    | null
    | (() => { [Symbol.asyncIterator](): AsyncIterator<Uint8Array>; close(): Promise<void> }),
  downloadHeaders: null as
    | null
    | (() => Promise<{
        body: { [Symbol.asyncIterator](): AsyncIterator<Uint8Array>; close(): Promise<void> };
      }>),
  create: vi.fn(),
  kill: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@alibaba-group/opensandbox', () => {
  class SandboxApiException extends Error {
    readonly statusCode: number | undefined;
    constructor(options: { message?: string; statusCode?: number } = {}) {
      super(options.message);
      this.name = 'SandboxApiException';
      this.statusCode = options.statusCode;
    }
  }
  return {
    SandboxApiException,
    ConnectionConfig: class {
      async closeTransport() {}
    },
    Sandbox: {
      create: async (request: { metadata: Record<string, string> }) => {
        backend.create(request);
        if (backend.provisionOnFailedCreate) {
          backend.created = true;
          backend.owner = request.metadata['cr-job-owner'];
        }
        if (backend.failCreate !== null) throw backend.failCreate;
        backend.created = true;
        backend.owner = request.metadata['cr-job-owner'];
        return {
          id: 'sandbox-identity',
          commands: {
            run: async (_argv: string[], _options: unknown, handlers: ExecutionHandlers) => {
              await handlers.onStdout?.({ text: 'done', timestamp: 1 });
              return { exitCode: 7, logs: { stdout: [], stderr: [] } };
            },
          },
          waitUntilReady: async () => {},
          credentialVault: {
            create: async (request: unknown) => {
              backend.vault = true;
              backend.vaultRequest = request;
            },
          },
          files: {
            getFileInfo: async (paths: string[]) =>
              Object.fromEntries(
                paths.map((path) => [
                  path,
                  {
                    path,
                    type:
                      backend.directory && (path.endsWith('/data') || path.endsWith('/logs'))
                        ? 'directory'
                        : 'file',
                  },
                ]),
              ),
            listDirectory: async ({ path }: { path: string }) =>
              backend.unsafeEntry
                ? [{ path: backend.unsafeEntry, type: backend.unsafeType }]
                : path.endsWith('/data')
                  ? [
                      { path: `${path}/opencode.db`, type: 'file' },
                      { path: `${path}/logs`, type: 'directory' },
                    ]
                  : [{ path: `${path}/review.log`, type: 'file' }],
            readBytesStreamDetailed: async () =>
              backend.downloadHeaders !== null
                ? backend.downloadHeaders()
                : {
                    body:
                      backend.downloadFactory !== null
                        ? backend.downloadFactory()
                        : (async function* () {
                            yield new TextEncoder().encode('evidence');
                          })(),
                  },
          },
          close: backend.close,
        };
      },
    },
    SandboxManager: {
      create: () => ({
        getSandboxInfo: async () => {
          if (backend.infoErrorStatus !== null) {
            throw new SandboxApiException({ statusCode: backend.infoErrorStatus });
          }
          if (backend.infoError !== null) throw backend.infoError;
          return {
            id: 'sandbox-identity',
            metadata: { 'cr-job-owner': backend.owner },
          };
        },
        listSandboxInfos: async (filter: { metadata: Record<string, string> }) => {
          if (backend.listErrorStatus !== null) {
            throw new SandboxApiException({ statusCode: backend.listErrorStatus });
          }
          if (backend.listError !== null) throw backend.listError;
          return {
            items:
              backend.created && filter.metadata['cr-job-owner'] === backend.owner
                ? [{ id: 'sandbox-identity', metadata: { 'cr-job-owner': backend.owner } }]
                : [],
            pagination: { hasNextPage: false },
          };
        },
        killSandbox: async () => {
          backend.kill();
          backend.created = false;
        },
        close: async () => {
          backend.managerClosed = true;
        },
      }),
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
  vi.clearAllMocks();
  backend.created = false;
  backend.directory = false;
  backend.managerClosed = false;
  backend.unsafeEntry = null;
  backend.unsafeType = 'file';
  backend.vault = false;
  backend.vaultRequest = null;
  backend.failCreate = null;
  backend.provisionOnFailedCreate = false;
  backend.listError = null;
  backend.listErrorStatus = null;
  backend.infoError = null;
  backend.infoErrorStatus = null;
  backend.downloadFactory = null;
  backend.downloadHeaders = null;
});

const jobSpec = (root: string): SandboxJobSpec => ({
  id: 'job-id',
  name: 'job-name',
  imageRef: 'unused-sbx-template',
  cpu: '1',
  memoryGib: 2,
  env: [],
  checkoutRoot: join(root, 'checkout'),
  configRoot: join(root, 'config'),
  modelResource: 'llm.example.test:443',
  modelTokenFile: join(root, 'grant'),
  githubResource: 'api.github.com:443',
  githubReadToken: 'host-only-github',
});

const sandboxCommand = (): SandboxCommand =>
  Object.assign(async () => ({ exitCode: 0, stdout: '', timedOut: false, truncated: false }), {
    execute: async (operation: SandboxOperation, _diagnostic: unknown, options: {} = {}) =>
      operation(options),
  });

describe('OpenSandbox runtime inference endpoint', () => {
  it.each([
    ['llm.example.test:443', true],
    ['llm.example.test:80', false],
    ['llm.example.test:8443', false],
    ['127.0.0.1:443', false],
    ['localhost:443', false],
    ['llm.example.test', false],
  ] as const)('requires the exact HTTPS relay host on port 443: %s', async (resource, valid) => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-endpoint-'));
    roots.push(root);
    const spec = { ...jobSpec(root), modelResource: resource };
    await writeFile(spec.modelTokenFile!, 'host-only-grant', { mode: 0o600 });
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'test',
      image: 'test',
      lifetimeSeconds: 3600,
    })(spec);
    if (valid) {
      await runtime.setup(sandboxCommand());
      await runtime.destroy(sandboxCommand());
      expect(backend.vaultRequest).toMatchObject({
        bindings: expect.arrayContaining([
          expect.objectContaining({
            name: 'model',
            match: {
              schemes: ['https'],
              hosts: ['llm.example.test'],
              methods: ['GET', 'POST'],
              paths: ['/v1/*'],
            },
            auth: { type: 'bearer', credential: 'model' },
          }),
        ]),
      });
    } else {
      await expect(runtime.setup(sandboxCommand())).rejects.toThrow(/HTTPS FQDN on port 443/);
      expect(backend.create).not.toHaveBeenCalled();
    }
  });
});

describe('OpenSandbox runtime lifecycle', () => {
  it('exports nested evidence directories with database and logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-directory-'));
    roots.push(root);
    const spec = jobSpec(root);
    await writeFile(spec.modelTokenFile!, 'host-only-grant');
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'test',
      image: 'test',
      lifetimeSeconds: 3600,
    })(spec);
    const command = sandboxCommand();
    await runtime.setup(command);
    backend.directory = true;
    const destination = join(root, 'archive');
    expect((await runtime.copyOut('/tmp/evidence/data', destination, command)).exitCode).toBe(0);
    expect(await readFile(join(destination, 'opencode.db'), 'utf8')).toBe('evidence');
    expect(await readFile(join(destination, 'logs/review.log'), 'utf8')).toBe('evidence');
    await runtime.destroy(command);
  });

  it.each([
    ['/tmp/evidence/data/../outside', 'file'],
    ['/tmp/evidence/data/link', 'symlink'],
    ['/tmp/evidence/data/device', 'other'],
  ])('refuses unsafe evidence entries: %s', async (path, type) => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-directory-'));
    roots.push(root);
    const spec = jobSpec(root);
    await writeFile(spec.modelTokenFile!, 'host-only-grant');
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'test',
      image: 'test',
      lifetimeSeconds: 3600,
    })(spec);
    const command = sandboxCommand();
    await runtime.setup(command);
    backend.directory = true;
    backend.unsafeEntry = path;
    backend.unsafeType = type;
    const destination = join(root, 'archive');
    expect((await runtime.copyOut('/tmp/evidence/data', destination, command)).exitCode).not.toBe(
      0,
    );
    await expect(readFile(join(root, 'outside'))).rejects.toThrow();
    await expect(readFile(destination)).rejects.toThrow();
    await runtime.destroy(command);
  });
  it('destroys successfully when setup failed before creating a sandbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
    roots.push(root);
    const { modelTokenFile: _omitted, ...spec } = jobSpec(root);
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'control-key',
      image: 'review-image',
      lifetimeSeconds: 3600,
    })(spec);
    const command = sandboxCommand();

    await expect(runtime.setup(command)).rejects.toThrow();
    expect(backend.create).not.toHaveBeenCalled();
    backend.listError = new Error('control plane unavailable');
    await expect(runtime.destroy(command)).resolves.toBeUndefined();

    expect(backend.listError.message).toBe('control plane unavailable');
    expect(runtime.metadata.hostCleanupConfirmed).toBe(true);
  });
  it('does not treat an arbitrary lookup error as absence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
    roots.push(root);
    const spec = jobSpec(root);
    await writeFile(spec.modelTokenFile!, 'host-only-grant', { mode: 0o600 });
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'control-key',
      image: 'review-image',
      lifetimeSeconds: 3600,
    })(spec);
    const command = sandboxCommand();

    await runtime.setup(command);
    backend.infoError = new Error('lookup failed');
    await expect(runtime.destroy(command)).rejects.toThrow();

    expect(backend.kill).not.toHaveBeenCalled();
    expect(runtime.metadata.hostCleanupConfirmed).toBe(false);
  });

  it('cancels a blocked copyOut when its signal aborts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
    roots.push(root);
    const spec = jobSpec(root);
    await writeFile(spec.modelTokenFile!, 'host-only-grant', { mode: 0o600 });
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'control-key',
      image: 'review-image',
      lifetimeSeconds: 3600,
    })(spec);
    const controller = new AbortController();
    const command = Object.assign(
      async () => ({ exitCode: 0, stdout: '', timedOut: false, truncated: false }),
      {
        execute: async (operation: SandboxOperation, _diagnostic: unknown, options: {} = {}) =>
          operation({ ...options, signal: controller.signal }),
      },
    );
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const downloadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    backend.downloadFactory = () => ({
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode('first-chunk');
        started?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async close() {
        release?.();
      },
    });

    await runtime.setup(command);
    const destination = join(root, 'export.json');
    const pending = runtime.copyOut('/tmp/evidence/export.json', destination, command);
    await downloadStarted;
    controller.abort();
    const result = await pending;

    expect(result.exitCode).not.toBe(0);
    await expect(readFile(destination, 'utf8')).rejects.toThrow();
  }, 1000);

  it('cancels copyOut when abort arrives while waiting for download headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
    roots.push(root);
    const spec = jobSpec(root);
    await writeFile(spec.modelTokenFile!, 'host-only-grant', { mode: 0o600 });
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'control-key',
      image: 'review-image',
      lifetimeSeconds: 3600,
    })(spec);
    const controller = new AbortController();
    const command = Object.assign(
      async () => ({ exitCode: 0, stdout: '', timedOut: false, truncated: false }),
      {
        execute: async (operation: SandboxOperation, _diagnostic: unknown, options: {} = {}) =>
          operation({ ...options, signal: controller.signal }),
      },
    );
    let releaseHeaders: (() => void) | undefined;
    let headersRequested: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      headersRequested = resolve;
    });
    let closed = false;
    backend.downloadHeaders = async () => {
      headersRequested?.();
      await new Promise<void>((resolve) => {
        releaseHeaders = resolve;
      });
      return {
        body: {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode('late-chunk');
          },
          async close() {
            closed = true;
          },
        },
      };
    };

    await runtime.setup(command);
    const destination = join(root, 'export.json');
    const pending = runtime.copyOut('/tmp/evidence/export.json', destination, command);
    await requested;
    controller.abort();
    releaseHeaders?.();
    const result = await pending;

    expect(result.exitCode).not.toBe(0);
    expect(closed).toBe(true);
    await expect(readFile(destination, 'utf8')).rejects.toThrow();
  }, 1000);

  it('does not leak text from a rejected create', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
    roots.push(root);
    const spec = jobSpec(root);
    await writeFile(spec.modelTokenFile!, 'host-only-grant', { mode: 0o600 });
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'control-key',
      image: 'review-image',
      lifetimeSeconds: 3600,
    })(spec);
    backend.failCreate = new Error('sensitive create failure details');

    let error: unknown;
    try {
      await runtime.setup(sandboxCommand());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SandboxCreateError);
    expect(error).toMatchObject({ timedOut: false });
    expect(String(error)).not.toContain('sensitive create failure details');
  });

  it('preserves the timed out create cause', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
    roots.push(root);
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'control-key',
      image: 'review-image',
      lifetimeSeconds: 3600,
    })(jobSpec(root));
    const command = Object.assign(
      async () => ({ exitCode: 0, stdout: '', timedOut: false, truncated: false }),
      {
        execute: async () => ({ exitCode: 1, stdout: '', timedOut: true, truncated: false }),
      },
    );

    await expect(runtime.setup(command)).rejects.toMatchObject({
      name: 'SandboxCreateError',
      timedOut: true,
    });
    await expect(runtime.setup(command)).rejects.toBeInstanceOf(SandboxCreateError);
  });

  it('reconciles and deletes a sandbox from a failed create', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
    roots.push(root);
    const spec = jobSpec(root);
    await writeFile(spec.modelTokenFile!, 'host-only-grant', { mode: 0o600 });
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'control-key',
      image: 'review-image',
      lifetimeSeconds: 3600,
    })(spec);
    const command = sandboxCommand();

    backend.failCreate = new Error('ambiguous create');
    backend.provisionOnFailedCreate = true;
    await expect(runtime.setup(command)).rejects.toThrow();
    expect(backend.created).toBe(true);

    await expect(runtime.destroy(command)).resolves.toBeUndefined();

    expect(backend.kill).toHaveBeenCalledTimes(1);
    expect(backend.created).toBe(false);
    expect(runtime.metadata.hostCleanupConfirmed).toBe(true);
  });

  it('fails closed when a failed create leaves no discovered sandbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
    roots.push(root);
    const spec = jobSpec(root);
    await writeFile(spec.modelTokenFile!, 'host-only-grant', { mode: 0o600 });
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'control-key',
      image: 'review-image',
      lifetimeSeconds: 3600,
    })(spec);
    const command = sandboxCommand();

    backend.failCreate = new Error('ambiguous create');
    await expect(runtime.setup(command)).rejects.toThrow();
    await expect(runtime.destroy(command)).rejects.toThrow();

    expect(backend.kill).not.toHaveBeenCalled();
    expect(runtime.metadata.hostCleanupConfirmed).toBe(false);
  });

  it('fails closed when the sandbox listing endpoint is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
    roots.push(root);
    const spec = jobSpec(root);
    await writeFile(spec.modelTokenFile!, 'host-only-grant', { mode: 0o600 });
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'control-key',
      image: 'review-image',
      lifetimeSeconds: 3600,
    })(spec);
    const command = sandboxCommand();

    await runtime.setup(command);
    backend.listErrorStatus = 404;
    await expect(runtime.destroy(command)).rejects.toThrow();

    expect(backend.kill).not.toHaveBeenCalled();
    expect(runtime.metadata.hostCleanupConfirmed).toBe(false);
  });

  it('succeeds when a created sandbox is already missing with a 404', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
    roots.push(root);
    const spec = jobSpec(root);
    await writeFile(spec.modelTokenFile!, 'host-only-grant', { mode: 0o600 });
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'control-key',
      image: 'review-image',
      lifetimeSeconds: 3600,
    })(spec);
    const command = sandboxCommand();

    await runtime.setup(command);
    backend.infoErrorStatus = 404;
    await expect(runtime.destroy(command)).resolves.toBeUndefined();

    expect(backend.kill).not.toHaveBeenCalled();
    expect(runtime.metadata.hostCleanupConfirmed).toBe(true);
  });

  it.each(['normal', 'foreign-owner', 'remaining-sidecar'] as const)(
    'stages and exports work, then handles %s cleanup safely',
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
      roots.push(root);
      const tokenPath = join(root, 'grant');
      await writeFile(tokenPath, 'host-only-grant', { mode: 0o600 });
      const spec: SandboxJobSpec = {
        id: 'job-id',
        name: 'job-name',
        imageRef: 'unused-sbx-template',
        cpu: '1',
        memoryGib: 2,
        env: [],
        checkoutRoot: join(root, 'checkout'),
        configRoot: join(root, 'config'),
        modelResource: 'llm.example.test:443',
        modelTokenFile: tokenPath,
        githubResource: 'api.github.com:443',
        githubReadToken: 'host-only-github',
      };
      const command: SandboxCommand = Object.assign(
        async () => ({
          exitCode: 0,
          stdout: scenario === 'remaining-sidecar' ? 'remaining-sidecar' : '',
          timedOut: false,
          truncated: false,
        }),
        {
          execute: async (operation: SandboxOperation, _diagnostic: unknown, options: {} = {}) =>
            operation(options),
        },
      );
      const runtime = createOpenSandboxRuntimeFactory({
        endpoint: 'http://127.0.0.1:8080',
        apiKey: 'control-key',
        image: 'review-image',
        lifetimeSeconds: 3600,
      })(spec);
      await runtime.setup(command);
      expect(runtime.metadata.created).toBe(true);
      expect(runtime.metadata.id).toBe('sandbox-identity');
      expect(backend.vault).toBe(true);
      const request = backend.create.mock.calls[0]?.[0];
      expect(request.env.OPENCODE_API_KEY).toBe('cr-job-id');
      expect(request.volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            host: { path: spec.checkoutRoot },
            mountPath: spec.checkoutRoot,
            readOnly: true,
          }),
          expect.objectContaining({
            host: { path: spec.configRoot },
            mountPath: spec.configRoot,
            readOnly: true,
          }),
        ]),
      );
      expect(JSON.stringify(request)).not.toContain('host-only-grant');
      expect(JSON.stringify(request)).not.toContain('host-only-github');
      const execution = await runtime.exec(['sh', '-c', 'exit 7'], command, {
        captureStdout: true,
      });
      expect(execution.exitCode).toBe(7);
      expect(execution.stdout).toBe('done');
      const destination = join(root, 'export.json');
      expect(
        (await runtime.copyOut('/tmp/evidence/export.json', destination, command)).exitCode,
      ).toBe(0);
      expect(await readFile(destination, 'utf8')).toBe('evidence');
      if (scenario === 'foreign-owner') {
        backend.owner = 'somebody-else';
        await expect(runtime.destroy(command)).rejects.toThrow();
        expect(backend.created).toBe(true);
        expect(runtime.metadata.hostCleanupConfirmed).toBe(false);
        return;
      }
      if (scenario === 'remaining-sidecar') {
        await expect(runtime.destroy(command)).rejects.toThrow();
        expect(runtime.metadata.hostCleanupConfirmed).toBe(false);
        return;
      }
      await runtime.destroy(command);
      expect(backend.managerClosed).toBe(true);
      expect(backend.created).toBe(false);
      expect(runtime.metadata.hostCleanupConfirmed).toBe(true);
    },
  );
});

describe('OpenSandbox copyOut diagnostics', () => {
  const prepare = async () => {
    const root = await mkdtemp(join(tmpdir(), 'cr-os-runtime-'));
    roots.push(root);
    const spec = jobSpec(root);
    await writeFile(spec.modelTokenFile!, 'host-only-grant', { mode: 0o600 });
    const calls: Array<{ diagnostic: unknown; options: unknown }> = [];
    const command = Object.assign(
      async () => ({ exitCode: 0, stdout: '', timedOut: false, truncated: false }),
      {
        execute: async (
          operation: SandboxOperation,
          diagnostic: unknown,
          options?: RunnerProcessOptions,
        ) => {
          calls.push({ diagnostic, options });
          return operation(options ?? {});
        },
      },
    );
    const runtime = createOpenSandboxRuntimeFactory({
      endpoint: 'http://127.0.0.1:8080',
      apiKey: 'control-key',
      image: 'review-image',
      lifetimeSeconds: 3600,
    })(spec);
    await runtime.setup(command);
    calls.length = 0;
    return { root, runtime, command, calls };
  };

  it('uses the default copy-evidence diagnostic', async () => {
    const { root, runtime, command, calls } = await prepare();

    const result = await runtime.copyOut(
      '/tmp/evidence/export.json',
      join(root, 'default.json'),
      command,
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      { diagnostic: { stage: 'sandbox', command: 'copy-evidence' }, options: undefined },
    ]);
  });

  it('forwards the caller diagnostic and options', async () => {
    const { root, runtime, command, calls } = await prepare();
    const diagnostic = {
      stage: 'sandbox' as const,
      command: 'archive-opencode-data',
      includeStderr: true,
    };
    const options = { captureStdout: true, maxBytes: 4096 };

    const result = await runtime.copyOut(
      '/tmp/evidence/export.json',
      join(root, 'archive.json'),
      command,
      diagnostic,
      options,
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([{ diagnostic, options }]);
  });
});

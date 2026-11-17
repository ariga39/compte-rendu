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
} from '../apps/runner/src/sandbox-runtime.js';

const backend = vi.hoisted(() => ({
  created: false,
  owner: '',
  vault: false,
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
            create: async () => {
              backend.vault = true;
            },
          },
          files: {
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
        close: async () => {},
      }),
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
  vi.clearAllMocks();
  backend.created = false;
  backend.vault = false;
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
  modelResource: 'llm.example.test:80',
  modelTokenFile: join(root, 'grant'),
  githubResource: 'api.github.com:443',
  githubReadToken: 'host-only-github',
});

const sandboxCommand = (): SandboxCommand =>
  Object.assign(async () => ({ exitCode: 0, stdout: '', timedOut: false, truncated: false }), {
    execute: async (operation: SandboxOperation, _diagnostic: unknown, options: {} = {}) =>
      operation(options),
  });

describe('OpenSandbox runtime lifecycle', () => {
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
        modelResource: 'llm.example.test:80',
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
      expect(backend.created).toBe(false);
      expect(runtime.metadata.hostCleanupConfirmed).toBe(true);
    },
  );
});

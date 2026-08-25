import { describe, expect, it } from 'vitest';
import {
  createReviewSandbox,
  resolveOpenCodeProcessId,
  type OpenCodeIntegration,
} from '../apps/core/src/cloudflare-review-adapter';
import type { OperationalLogEvent } from '../packages/contracts/src';

describe('Cloudflare review Sandbox adapter', () => {
  it('resolves the uniquely matching OpenCode process despite added and reordered flags', () => {
    expect(
      resolveOpenCodeProcessId(
        [
          {
            id: 'matching-process',
            command: [
              'opencode',
              'serve',
              '--hostname',
              '0.0.0.0',
              '--extra',
              'preview',
              '--port',
              '4096',
            ],
            cwd: '/workspace/compte-rendu-review',
            state: 'running',
          },
        ],
        '/workspace/compte-rendu-review',
      ),
    ).toBe('matching-process');
  });

  it('fails closed for wrong identity or ambiguous OpenCode processes', () => {
    const processes = [
      {
        id: 'wrong-cwd',
        command: ['opencode', 'serve', '--port', '4096'],
        cwd: '/workspace/other-review',
        state: 'running' as const,
      },
      {
        id: 'wrong-port',
        command: ['opencode', 'serve', '--port', '4097'],
        cwd: '/workspace/compte-rendu-review',
        state: 'running' as const,
      },
      {
        id: 'not-running',
        command: ['opencode', 'serve', '--port', '4096'],
        cwd: '/workspace/compte-rendu-review',
        state: 'exited' as const,
      },
    ];

    expect(resolveOpenCodeProcessId(processes, '/workspace/compte-rendu-review')).toBeUndefined();
    expect(
      resolveOpenCodeProcessId(
        [
          ...processes,
          {
            id: 'matching-process-a',
            command: ['opencode', 'serve', '--port=4096'],
            cwd: '/workspace/compte-rendu-review',
            state: 'running',
          },
          {
            id: 'matching-process-b',
            command: ['opencode', 'serve', '--port', '4096'],
            cwd: '/workspace/compte-rendu-review',
            state: 'running',
          },
        ],
        '/workspace/compte-rendu-review',
      ),
    ).toBeUndefined();
  });

  it('runs one review through the managed OpenCode server and closes it', async () => {
    let serverClosed = false;
    const writes: Array<{ path: string; content: string }> = [];
    let openCodeOptions:
      | {
          readonly directory?: string;
          readonly config?: unknown;
          readonly env?: Readonly<Record<string, string | undefined>>;
        }
      | undefined;
    let promptInput:
      | {
          readonly directory: string;
          readonly model: { readonly providerID: string; readonly modelID: string };
          readonly agent: string;
          readonly parts: ReadonlyArray<{ readonly text: string }>;
        }
      | undefined;
    const events: OperationalLogEvent[] = [];
    const rawSandbox = {
      writeFile: async (path: string, content: string) => {
        writes.push({ path, content });
      },
      exec: async () => {
        throw new Error('raw CLI must not be used');
      },
      destroy: async () => undefined,
    };
    const openCodeIntegration: OpenCodeIntegration = {
      createClient: async (_sandbox, options) => {
        openCodeOptions = options;
        return {
          client: {
            session: {
              create: async (_parameters) => ({ id: 'review-session' }),
              prompt: async (input) => {
                promptInput = input;
                return {
                  info: {},
                  parts: [
                    {
                      type: 'text',
                      text: JSON.stringify({ findings: [], summary: 'No findings' }),
                    },
                  ],
                };
              },
              abort: async () => true,
            },
          },
          process: {
            id: 'review-process',
            kill: async () => {
              serverClosed = true;
            },
            waitForExit: async () => undefined,
          },
        };
      },
    };

    const sandbox = createReviewSandbox(rawSandbox, openCodeIntegration, undefined, {
      sandboxId: 'sandbox/secret?token=do-not-log',
      log: {
        record: (event) => {
          events.push(event);
        },
      },
    });
    const result = await sandbox.runAgent({ modelCredential: 'test-model-key' });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'text',
        part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
      }),
      stderr: '',
    });
    expect(writes).toContainEqual({
      path: '/tmp/compte-rendu-opencode-data/opencode/auth.json',
      content: JSON.stringify({
        'opencode-go': { type: 'api', key: 'test-model-key' },
      }),
    });
    expect(openCodeOptions).toMatchObject({
      directory: '/workspace/compte-rendu-review',
      config: {
        agent: {
          review: {
            permission: {
              bash: 'deny',
              edit: 'deny',
              external_directory: 'deny',
              webfetch: 'deny',
            },
          },
        },
      },
      env: {
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        XDG_DATA_HOME: '/tmp/compte-rendu-opencode-data',
      },
    });
    expect(openCodeOptions?.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(promptInput).toMatchObject({
      directory: '/workspace/compte-rendu-review',
      model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
      agent: 'review',
    });
    expect(promptInput?.parts[0]?.text).toContain('Return exactly one JSON object');
    expect(serverClosed).toBe(true);
    expect(events).toEqual([
      { phase: 'agent', outcome: 'progress', stage: 'server', sandboxId: 'redacted' },
      { phase: 'agent', outcome: 'progress', stage: 'session', sandboxId: 'redacted' },
      { phase: 'agent', outcome: 'progress', stage: 'prompt', sandboxId: 'redacted' },
      { phase: 'agent', outcome: 'completed', stage: 'response', sandboxId: 'redacted' },
    ]);
  });

  it('classifies a returned OpenCode session error separately from transport failure', async () => {
    const events: OperationalLogEvent[] = [];
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => {
        throw new Error('raw CLI must not be used');
      },
      destroy: async () => undefined,
    };
    const log = {
      record: (event: OperationalLogEvent) => {
        events.push(event);
      },
    };
    const integration: OpenCodeIntegration = {
      createClient: async () => ({
        client: {
          session: {
            create: async () => ({ id: 'review-session' }),
            prompt: async () => ({ info: { error: { name: 'ProviderError' } }, parts: [] }),
            abort: async () => true,
          },
        },
        process: {
          id: 'review-process',
          kill: async () => undefined,
          waitForExit: async () => undefined,
        },
      }),
    };

    const result = await createReviewSandbox(rawSandbox, integration, undefined, {
      sandboxId: 'sandbox-safe-1',
      log,
    }).runAgent({ modelCredential: 'test-model-key' });

    expect(result).toMatchObject({ exitCode: 1, stderr: 'OpenCode failed' });
    expect(events).toContainEqual({
      phase: 'agent',
      outcome: 'failed',
      stage: 'prompt',
      reason: 'session_error',
      sandboxId: 'sandbox-safe-1',
    });
    expect(events).not.toContainEqual(expect.objectContaining({ reason: 'transport_failure' }));
  });

  it('classifies a thrown managed OpenCode failure as transport failure', async () => {
    const events: OperationalLogEvent[] = [];
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => {
        throw new Error('raw CLI must not be used');
      },
      destroy: async () => undefined,
    };
    const integration: OpenCodeIntegration = {
      createClient: async () => {
        throw new Error('Sandbox transport exposed secret response');
      },
    };

    const result = await createReviewSandbox(rawSandbox, integration, undefined, {
      sandboxId: 'sandbox-safe-2',
      log: {
        record: (event) => {
          events.push(event);
        },
      },
    }).runAgent({ modelCredential: 'test-model-key' });

    expect(result).toMatchObject({ exitCode: 1, stderr: 'OpenCode failed' });
    expect(events).toContainEqual({
      phase: 'agent',
      outcome: 'failed',
      stage: 'server',
      reason: 'transport_failure',
      sandboxId: 'sandbox-safe-2',
    });
    expect(JSON.stringify(events)).not.toContain('secret response');
  });

  it('reports the active server stage while managed OpenCode startup is pending', async () => {
    const events: OperationalLogEvent[] = [];
    let signalStartupEntered: (() => void) | undefined;
    let releaseStartup: (() => void) | undefined;
    const startupEntered = new Promise<void>((resolve) => {
      signalStartupEntered = resolve;
    });
    const startupRelease = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => {
        throw new Error('raw CLI must not be used');
      },
      destroy: async () => undefined,
    };
    const integration: OpenCodeIntegration = {
      createClient: async () => {
        signalStartupEntered?.();
        await startupRelease;
        return {
          client: {
            session: {
              create: async () => ({ id: 'review-session' }),
              prompt: async () => ({
                info: {},
                parts: [{ type: 'text', text: JSON.stringify({ findings: [], summary: 'Done' }) }],
              }),
              abort: async () => true,
            },
          },
          process: {
            id: 'review-process',
            kill: async () => undefined,
            waitForExit: async () => undefined,
          },
        };
      },
    };

    const runPromise = createReviewSandbox(rawSandbox, integration, undefined, {
      sandboxId: 'sandbox-startup-pending',
      log: {
        record: (event) => {
          events.push(event);
        },
      },
    }).runAgent({ modelCredential: 'test-model-key' });

    await startupEntered;
    expect(events).toContainEqual({
      phase: 'agent',
      outcome: 'progress',
      stage: 'server',
      sandboxId: 'sandbox-startup-pending',
    });
    releaseStartup?.();
    await runPromise;
  });

  it('exports only bounded process and session activity categories', async () => {
    const events: OperationalLogEvent[] = [];
    const log = {
      record: (event: OperationalLogEvent) => {
        events.push(event);
      },
    };
    const logEvents: unknown[] = [
      { type: 'stdout', data: new TextEncoder().encode('repository contents and prompt secret') },
      {
        type: 'terminal',
        state: 'error',
        error: { message: 'transport response with credential' },
      },
    ];
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => {
        throw new Error('raw CLI must not be used');
      },
      destroy: async () => undefined,
    };
    const integration: OpenCodeIntegration = {
      createClient: async () => ({
        client: {
          session: {
            create: async () => ({ id: 'review-session' }),
            prompt: async () => ({
              info: {},
              parts: [{ type: 'text', text: JSON.stringify({ findings: [], summary: 'Done' }) }],
            }),
            abort: async () => true,
          },
          event: {
            subscribe: async () =>
              (async function* () {
                yield {
                  type: 'session.status',
                  properties: { sessionID: 'session/secret', status: { type: 'busy' } },
                };
                yield {
                  type: 'session.status',
                  properties: {
                    sessionID: 'session/secret',
                    status: {
                      type: 'retry',
                      attempt: 999,
                      message: 'model output secret',
                      next: 1,
                    },
                  },
                };
                yield { type: 'session.idle', properties: { sessionID: 'session/secret' } };
              })(),
          },
        },
        process: {
          id: 'review-process',
          kill: async () => undefined,
          waitForExit: async () => undefined,
          status: async () => ({ state: 'running' }),
          logs: async function (
            this: { readonly id: string },
            _options?: { readonly replay?: boolean; readonly follow?: boolean },
          ) {
            if (this.id !== 'review-process') throw new Error('unexpected process receiver');
            return {
              getReader: () => {
                let index = 0;
                return {
                  read: async () =>
                    index < logEvents.length
                      ? { done: false, value: logEvents[index++] }
                      : { done: true },
                  cancel: async () => undefined,
                };
              },
            };
          },
        },
      }),
    };

    const result = await createReviewSandbox(rawSandbox, integration, undefined, {
      sandboxId: 'sandbox-activity-1',
      log,
    }).runAgent({ modelCredential: 'test-model-key' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(result.exitCode).toBe(0);
    expect(events).toContainEqual({
      phase: 'agent',
      outcome: 'status',
      stage: 'process',
      state: 'running',
      sandboxId: 'sandbox-activity-1',
    });
    expect(events).toContainEqual({
      phase: 'agent',
      outcome: 'status',
      stage: 'session',
      state: 'busy',
      sandboxId: 'sandbox-activity-1',
    });
    expect(events).toContainEqual({
      phase: 'agent',
      outcome: 'activity',
      stage: 'process',
      sandboxId: 'sandbox-activity-1',
    });
    expect(events).toContainEqual({
      phase: 'agent',
      outcome: 'status',
      stage: 'process',
      state: 'error',
      sandboxId: 'sandbox-activity-1',
    });
    expect(events).toContainEqual({
      phase: 'agent',
      outcome: 'status',
      stage: 'session',
      state: 'retry',
      sandboxId: 'sandbox-activity-1',
    });
    expect(events).toContainEqual({
      phase: 'agent',
      outcome: 'status',
      stage: 'session',
      state: 'idle',
      sandboxId: 'sandbox-activity-1',
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('repository contents');
    expect(serialized).not.toContain('prompt secret');
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('model output secret');
  });
});

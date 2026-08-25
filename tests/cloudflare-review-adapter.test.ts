import { describe, expect, it } from 'vitest';
import {
  createReviewSandbox,
  type OpenCodeIntegration,
} from '../apps/core/src/cloudflare-review-adapter';
import type { OperationalLogEvent } from '../packages/contracts/src';

describe('Cloudflare review Sandbox adapter', () => {
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
      createOpencode: async (_sandbox, options) => {
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
          server: {
            close: async () => {
              serverClosed = true;
            },
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
      createOpencode: async () => ({
        client: {
          session: {
            create: async () => ({ id: 'review-session' }),
            prompt: async () => ({ info: { error: { name: 'ProviderError' } }, parts: [] }),
            abort: async () => true,
          },
        },
        server: { close: async () => undefined },
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
      createOpencode: async () => {
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
      createOpencode: async () => {
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
          server: { close: async () => undefined },
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
});

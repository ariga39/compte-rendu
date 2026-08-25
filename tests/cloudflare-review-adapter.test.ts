import { describe, expect, it } from 'vitest';
import {
  createReviewSandbox,
  type OpenCodeIntegration,
} from '../apps/core/src/cloudflare-review-adapter';

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

    const sandbox = createReviewSandbox(rawSandbox, openCodeIntegration);
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
  });
});

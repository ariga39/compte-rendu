import { describe, expect, it } from 'vitest';
import { createReviewSandbox } from '../apps/core/src/cloudflare-review-adapter';

describe('Cloudflare review Sandbox adapter', () => {
  it('runs OpenCode with an isolated ephemeral opencode-go auth entry', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    let execution:
      | {
          command: string;
          options?: {
            readonly env?: Readonly<Record<string, string | undefined>>;
          };
        }
      | undefined;
    const sandbox = createReviewSandbox({
      writeFile: async (path, content) => {
        writes.push({ path, content });
      },
      exec: async (command, options) => {
        execution = { command, options };
        return { success: true, exitCode: 0, stdout: '', stderr: '' };
      },
      destroy: async () => {},
    });

    await sandbox.runAgent({ modelCredential: 'test-model-key' });

    expect(writes).toContainEqual({
      path: '/tmp/compte-rendu-opencode-data/opencode/auth.json',
      content: JSON.stringify({
        'opencode-go': { type: 'api', key: 'test-model-key' },
      }),
    });
    expect(execution?.command).toContain('--model opencode-go/deepseek-v4-flash');
    expect(execution?.options?.env).toMatchObject({
      XDG_DATA_HOME: '/tmp/compte-rendu-opencode-data',
    });
    expect(execution?.options?.env).not.toHaveProperty('OPENAI_API_KEY');
  });
});

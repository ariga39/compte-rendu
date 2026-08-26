import { describe, expect, it } from 'vitest';
import { createReviewSandbox } from '../apps/core/src/cloudflare-review-adapter';

describe('Cloudflare review Sandbox adapter', () => {
  it('runs one review through the direct OpenCode CLI and preserves JSONL output', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    let command: ReadonlyArray<string> | undefined;
    let execOptions:
      | {
          readonly cwd?: string;
          readonly env?: Readonly<Record<string, string | undefined>>;
          readonly timeout?: number;
        }
      | undefined;
    const observedOpenCodeEvent = {
      type: 'text',
      part: {
        type: 'text',
        text: JSON.stringify({ findings: [], summary: 'No findings' }),
      },
    };
    const directCliJsonl = `${JSON.stringify(observedOpenCodeEvent)}\n`;
    const rawSandbox = {
      writeFile: async (path: string, content: string) => {
        writes.push({ path, content });
      },
      exec: async (
        argv: ReadonlyArray<string>,
        options?: {
          readonly cwd?: string;
          readonly env?: Readonly<Record<string, string | undefined>>;
          readonly timeout?: number;
        },
      ) => {
        command = argv;
        execOptions = options;
        return {
          output: async () => ({
            stdout: directCliJsonl,
            stderr: '',
            exitCode: 0,
            timedOut: false,
            truncated: false,
          }),
        };
      },
      destroy: async () => undefined,
    };

    const result = await createReviewSandbox(rawSandbox).runAgent({
      modelCredential: 'test-model-key',
    });

    expect(JSON.parse(directCliJsonl)).toEqual(observedOpenCodeEvent);
    expect(result).toMatchObject({
      exitCode: 0,
      stderr: '',
    });
    expect(result.stdout).toBe(directCliJsonl);
    expect(writes).toContainEqual({
      path: '/tmp/compte-rendu-opencode-data/opencode/auth.json',
      content: JSON.stringify({
        'opencode-go': { type: 'api', key: 'test-model-key' },
      }),
    });
    expect(command).toEqual([
      'opencode',
      'run',
      '--pure',
      '--format',
      'json',
      '--model',
      'opencode-go/deepseek-v4-flash',
      '--agent',
      'review',
      expect.stringContaining('Return exactly one JSON object'),
    ]);
    expect(execOptions).toMatchObject({
      cwd: '/workspace/compte-rendu-review',
      timeout: 10 * 60 * 1000,
      env: {
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        XDG_DATA_HOME: '/tmp/compte-rendu-opencode-data',
      },
    });
    const config = JSON.parse(execOptions?.env?.OPENCODE_CONFIG_CONTENT ?? 'null') as {
      agent: {
        review: {
          permission: Record<string, string>;
        };
      };
    };
    expect(config).toMatchObject({
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
    });
    expect(execOptions?.env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('bounds direct CLI output and fails closed when the Sandbox truncates it', async () => {
    let outputOptions: { readonly encoding: 'utf8'; readonly maxBytes?: number } | undefined;
    const events: unknown[] = [];
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => ({
        output: async (options: { readonly encoding: 'utf8'; readonly maxBytes?: number }) => {
          outputOptions = options;
          return {
            stdout: 'raw repository contents and credential',
            stderr: 'raw provider response',
            exitCode: 0,
            timedOut: false,
            truncated: true,
          };
        },
      }),
      destroy: async () => undefined,
    };

    const result = await createReviewSandbox(rawSandbox, {
      sandboxId: 'sandbox-truncated',
      log: {
        record: (event) => {
          events.push(event);
        },
      },
    }).runAgent({ modelCredential: 'test-model-key' });

    expect(outputOptions).toEqual({ encoding: 'utf8', maxBytes: 256 * 1024 });
    expect(result).toEqual({ exitCode: 1, stdout: '', stderr: 'OpenCode failed' });
    expect(JSON.stringify(events)).not.toContain('raw repository contents');
    expect(JSON.stringify(events)).not.toContain('raw provider response');
  });

  it('maps a timed-out direct CLI process to a generic timeout failure', async () => {
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => ({
        output: async () => ({
          stdout: 'raw repository contents',
          stderr: 'raw provider response',
          exitCode: 1,
          timedOut: true,
          truncated: false,
        }),
      }),
      destroy: async () => undefined,
    };

    const result = await createReviewSandbox(rawSandbox).runAgent({
      modelCredential: 'test-model-key',
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'OpenCode timed out',
      timedOut: true,
    });
  });

  it('maps a nonzero direct CLI exit to the same generic failure', async () => {
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => ({
        output: async () => ({
          stdout: 'raw repository contents',
          stderr: 'raw provider response',
          exitCode: 7,
          timedOut: false,
          truncated: false,
        }),
      }),
      destroy: async () => undefined,
    };

    const result = await createReviewSandbox(rawSandbox).runAgent({
      modelCredential: 'test-model-key',
    });

    expect(result).toEqual({ exitCode: 1, stdout: '', stderr: 'OpenCode failed' });
  });
});

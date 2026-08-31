import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunner, type RunnerProcessResult } from '../apps/runner/src/runner';

const runnerJobFields = {
  repositoryName: 'acme/reviewed',
  pullRequestNumber: 42,
  repositoryReadToken: 'github-read-token',
};

const waitForTerminal = async (runner: ReturnType<typeof createRunner>, jobId: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await runner.handle(
      new Request(`http://runner/jobs/${jobId}`, {
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );
    const state = (await response.json()) as { status: string };
    if (state.status === 'succeeded' || state.status === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Runner Job did not reach a terminal state');
};

describe('Runner Job HTTP interface', () => {
  it('keeps sanitized setup diagnostics when cleanup is also unconfirmed', async () => {
    const events: unknown[] = [];
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const repositoryReadToken = 'checkout-token-must-not-appear';
    const resolverCommand = 'secret-resolver --token resolver-secret';
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: resolverCommand,
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
      process: async (_command, args) => {
        if (args[0] === 'create') {
          return {
            exitCode: 1,
            stderr: `mkfs.ext4: command not found ${repositoryReadToken} ${resolverCommand}`,
            stdout: '',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'rm') {
          return {
            exitCode: 1,
            stderr: 'sandbox not found',
            stdout: '',
            timedOut: false,
            truncated: false,
          };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-72-setup-diagnostics',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
    expect(events).toContainEqual({
      phase: 'runner',
      outcome: 'command',
      runId: 'run-72-setup-diagnostics',
      stage: 'sandbox',
      command: 'create',
      exitCode: 1,
      timedOut: false,
      stderr: 'mkfs.ext4: command not found [redacted] [redacted]',
    });
    expect(events).toContainEqual({
      phase: 'runner',
      outcome: 'command',
      runId: 'run-72-setup-diagnostics',
      stage: 'cleanup',
      command: 'remove-sandbox',
      exitCode: 1,
      timedOut: false,
      stderr: 'sandbox not found',
    });
    expect(JSON.stringify(events)).not.toContain(repositoryReadToken);
    expect(JSON.stringify(events)).not.toContain(resolverCommand);
  });

  it('redacts sensitive stderr before applying the diagnostic byte bound', async () => {
    const events: Array<Record<string, unknown>> = [];
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const repositoryReadToken = 'secret-checkout-token';
    const overflowingStderr = `${'x'.repeat(4080)}${repositoryReadToken}${'y'.repeat(100)}`;
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      log: {
        record: async (event) => {
          events.push(event as unknown as Record<string, unknown>);
        },
      },
      process: async (_command, args) => {
        if (args[0] === 'create') {
          return {
            exitCode: 1,
            stderr: overflowingStderr,
            stderrTruncated: true,
            stdout: '',
            timedOut: false,
            truncated: false,
          };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-72-redaction-bound',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'agent' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'runner',
        outcome: 'command',
        runId: 'run-72-redaction-bound',
        stage: 'sandbox',
        command: 'create',
        exitCode: 1,
        timedOut: false,
        stderr: `${'x'.repeat(4080)}[redacted]${'y'.repeat(6)}`,
      }),
    );
    expect(JSON.stringify(events)).not.toContain(repositoryReadToken);
  });

  it('loads the packaged review skill and exact revision through the OpenCode sandbox boundary', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    let createArgs: readonly string[] | undefined;
    let fetchArgs: readonly string[] | undefined;
    let agentArgs: readonly string[] | undefined;
    let configRootAtSandboxBoundary: string | undefined;
    let skillAtSandboxBoundary: string | undefined;
    let sandboxEnvironment: NodeJS.ProcessEnv | undefined;
    const process = async (
      _command: string,
      args: readonly string[],
      options: { readonly captureStdout?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
    ): Promise<RunnerProcessResult> => {
      if (args[0] === 'create') sandboxEnvironment = options.env;
      if (args[0] === 'create') {
        createArgs = args;
        const config = args.find((value) => value.startsWith('XDG_CONFIG_HOME='));
        if (config !== undefined) {
          const configRoot = config.slice('XDG_CONFIG_HOME='.length);
          configRootAtSandboxBoundary = configRoot;
          skillAtSandboxBoundary = await readFile(
            join(configRoot, 'opencode/skills/pr-review/SKILL.md'),
            'utf8',
          );
        }
      }
      if (args.includes('fetch')) fetchArgs = args;
      if (args[0] === 'exec') agentArgs = args;
      return {
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : options.captureStdout === true
            ? `${resultLine}\n`
            : '',
        timedOut: false,
        truncated: false,
      };
    };
    const runner = createRunner({
      process,
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
    });

    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-67-skill',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'succeeded',
      result: { findings: [], summary: 'No findings' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(createArgs).toEqual(expect.arrayContaining(['--clone', '--no-share-skills']));
    expect(fetchArgs).toEqual(
      expect.arrayContaining([
        `+${baseSha}:refs/remotes/origin/review-base`,
        `+refs/pull/42/head:refs/remotes/origin/review-head`,
      ]),
    );
    expect(createArgs).toContain(configRootAtSandboxBoundary);
    expect(createArgs).not.toContain(`${configRootAtSandboxBoundary}:ro`);
    expect(createArgs?.some((value) => value.startsWith('XDG_CONFIG_HOME='))).toBe(true);
    expect(skillAtSandboxBoundary).toContain('name: pr-review');
    expect(skillAtSandboxBoundary).toContain('description:');
    expect(skillAtSandboxBoundary).toContain('official GitHub CLI');
    expect(skillAtSandboxBoundary).toContain('current title, body, all commits, issue comments');
    const overviewCommand = skillAtSandboxBoundary?.match(/`gh pr view[^`]+`/)?.[0];
    expect(overviewCommand).toBe(
      '`gh pr view PR_NUMBER --repo REPOSITORY --json title,body,author,commits,comments,reviews`',
    );
    expect(overviewCommand).not.toContain('baseRefOid');
    expect(overviewCommand).not.toContain('headRefOid');
    expect(skillAtSandboxBoundary).toContain(
      'every review thread plus independently paginated reply',
    );
    expect(skillAtSandboxBoundary).toContain('resolved');
    expect(skillAtSandboxBoundary).toContain('outdated');
    expect(skillAtSandboxBoundary).toContain('older related issues');
    expect(skillAtSandboxBoundary).toContain(
      'Independently cursor-paginate the commits connection',
    );
    expect(skillAtSandboxBoundary).toContain('issue comments connection');
    expect(skillAtSandboxBoundary).toContain('submitted reviews connection');
    expect(skillAtSandboxBoundary).toContain('review threads connection');
    expect(skillAtSandboxBoundary).toContain("every thread's");
    expect(skillAtSandboxBoundary).toContain('replies connection');
    expect(skillAtSandboxBoundary).toContain(
      'Count the nodes and require every connection to report',
    );
    expect(skillAtSandboxBoundary).toContain('completion (`pageInfo.hasNextPage` false)');
    expect(skillAtSandboxBoundary).toContain('Re-read the pull request base and');
    expect(skillAtSandboxBoundary).toContain('head OIDs after pagination');
    expect(skillAtSandboxBoundary).not.toContain('```');
    const configContent = createArgs?.find((value) => value.startsWith('OPENCODE_CONFIG_CONTENT='));
    expect(configContent).toBeDefined();
    const config = JSON.parse(configContent!.slice('OPENCODE_CONFIG_CONTENT='.length)) as {
      agent: { review: { permission: Record<string, unknown> } };
    };
    expect(config).toMatchObject({
      agent: {
        review: {
          description: 'Pull request reviewer',
          permission: {
            '*': 'allow',
            bash: 'allow',
            edit: 'allow',
            external_directory: 'allow',
            skill: 'allow',
            webfetch: 'allow',
          },
        },
      },
    });
    expect(sandboxEnvironment?.SSH_AUTH_SOCK).toBeUndefined();
    expect(sandboxEnvironment?.SSH_AGENT_PID).toBeUndefined();
    expect(sandboxEnvironment?.GH_TOKEN).toBeUndefined();
    expect(sandboxEnvironment?.GITHUB_TOKEN).toBeUndefined();
    expect(agentArgs?.join(' ')).toContain('acme/reviewed');
    expect(agentArgs?.join(' ')).toContain('pull request #42');
    expect(agentArgs?.join(' ')).toContain('GH_TOKEN');
    expect(agentArgs?.join(' ')).toContain('independently cursor-paginate');
    expect(agentArgs?.join(' ')).toContain('after pagination');
    expect(agentArgs?.join(' ')).toContain(baseSha);
    expect(agentArgs?.join(' ')).toContain(headSha);
    await expect(
      readFile(join(configRootAtSandboxBoundary!, 'opencode/skills/pr-review/SKILL.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('exposes the per-run GitHub read token only through a scoped Sandbox secret', async () => {
    const repositoryReadToken = 'github-read-token-must-not-be-an-argument';
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    const commands: string[][] = [];
    const events: unknown[] = [];
    let resolvedGithubToken: string | undefined;
    let createArgs: readonly string[] | undefined;
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'model-secret-resolver',
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
      process: async (_command, args, options = {}) => {
        commands.push([...args]);
        if (args[0] === 'create') createArgs = args;
        if (args[0] === 'secret' && args[1] === 'set-custom' && args.includes('api.github.com')) {
          const command = args[args.indexOf('--command') + 1];
          if (command?.startsWith('cat '))
            resolvedGithubToken = await readFile(command.slice(4), 'utf8');
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : options.captureStdout === true
              ? `${resultLine}\n`
              : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryName: 'acme/reviewed',
          pullRequestNumber: 42,
          runId: 'run-github-read-secret',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken,
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'succeeded',
      sandbox: { cleanup: 'destroyed' },
    });
    const secret = commands.find(
      (args) => args[0] === 'secret' && args[1] === 'set-custom' && args.includes('api.github.com'),
    );
    expect(secret).toEqual(
      expect.arrayContaining(['--host', 'api.github.com', '--env', 'GH_TOKEN', '--placeholder']),
    );
    expect(
      commands.some((args) => args[0] === 'policy' && args.includes('api.github.com:443')),
    ).toBe(true);
    const githubSecret = commands.find(
      (args) => args[0] === 'secret' && args[1] === 'set-custom' && args.includes('api.github.com'),
    );
    const githubSecretCommand = githubSecret?.[githubSecret.indexOf('--command') + 1] ?? '';
    expect(githubSecretCommand).not.toBe('');
    expect(githubSecretCommand).toContain('github-read-token');
    expect(resolvedGithubToken).toBe(repositoryReadToken);
    expect(createArgs).toBeDefined();
    const configRootMount = createArgs
      ?.find((value) => value.startsWith('XDG_CONFIG_HOME='))
      ?.slice('XDG_CONFIG_HOME='.length);
    expect(configRootMount).toBeDefined();
    expect(githubSecretCommand.replace(/^cat /, '').startsWith(`${configRootMount}/`)).toBe(false);
    expect(commands.flat().join(' ')).not.toContain(repositoryReadToken);
    expect(JSON.stringify(events)).not.toContain(repositoryReadToken);
  });

  it('runs one authenticated immutable review attempt to a cleaned terminal result', async () => {
    const root = await mkdtemp(`${tmpdir()}/compte-rendu-runner-`);
    try {
      const baseSha = '1111111111111111111111111111111111111111';
      const headSha = '2222222222222222222222222222222222222222';
      const resultLine = JSON.stringify({
        type: 'text',
        part: {
          type: 'text',
          text: JSON.stringify({ findings: [], summary: 'No findings' }),
        },
      });
      const successfulProcess = async (
        _command: string,
        args: readonly string[],
        options: { readonly captureStdout?: boolean } = {},
      ): Promise<RunnerProcessResult> => ({
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : options.captureStdout === true
            ? `${resultLine}\n`
            : '',
        timedOut: false,
        truncated: false,
      });
      const runner = createRunner({
        process: successfulProcess,
        authToken: 'runner-test-token',
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      });
      const submitted = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...runnerJobFields,
            runId: 'run-64-test',
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha,
            headSha,
            repositoryReadToken: 'checkout-token-for-test',
          }),
        }),
      );
      expect(submitted.status).toBe(202);
      const { id } = (await submitted.json()) as { id: string };

      const terminal = await waitForTerminal(runner, id);
      expect(terminal).toMatchObject({
        status: 'succeeded',
        attempt: 1,
        result: { findings: [], summary: 'No findings' },
        sandbox: { cleanup: 'destroyed' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unauthenticated job requests without starting work', async () => {
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async () => ({
        exitCode: 0,
        stdout: '',
        timedOut: false,
        truncated: false,
      }),
    });

    const response = await runner.handle(
      new Request('http://runner/jobs', { method: 'POST', body: '{}' }),
    );

    expect(response.status).toBe(401);
  });

  it('fails closed on malformed agent output and still destroys the Sandbox', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => ({
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : options.captureStdout === true
            ? '{not-json}\n'
            : '',
        timedOut: false,
        truncated: false,
      }),
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-invalid-output',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    const terminal = await waitForTerminal(runner, id);

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output' },
      sandbox: { cleanup: 'destroyed' },
    });
  });

  it('maps an agent deadline to a failed terminal job after cleanup', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args) => ({
        exitCode: 0,
        stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
        timedOut: args[0] === 'exec',
        truncated: false,
      }),
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-timeout',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    const terminal = await waitForTerminal(runner, id);

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'timeout' },
      sandbox: { cleanup: 'destroyed' },
    });
  });

  it('fails closed when custom secret cleanup returns exit 1', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => ({
        exitCode: args[0] === 'secret' && args[1] === 'rm' ? 1 : 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : options.captureStdout === true
            ? `${resultLine}\n`
            : '',
        timedOut: false,
        truncated: false,
      }),
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-secret-cleanup-failure',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    const terminal = await waitForTerminal(runner, id);

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
  });

  it('is idempotent for the same run and attempt but creates a fresh job for a new attempt', async () => {
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async () => ({
        exitCode: 0,
        stdout: '',
        timedOut: false,
        truncated: false,
      }),
    });
    const request = (attempt: number) =>
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-idempotency',
          attempt,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
          repositoryReadToken: 'checkout-token-for-test',
        }),
      });

    const first = await runner.handle(request(1));
    const duplicate = await runner.handle(request(1));
    const retry = await runner.handle(request(2));
    const firstState = (await first.json()) as { id: string; attempt: number };
    const duplicateState = (await duplicate.json()) as { id: string; attempt: number };
    const retryState = (await retry.json()) as { id: string; attempt: number };

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(duplicateState).toEqual(firstState);
    expect(retryState.attempt).toBe(2);
    expect(retryState.id).not.toBe(firstState.id);
  });

  it('fails before the agent when checkout reports the wrong immutable head SHA', async () => {
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => ({
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? '1111111111111111111111111111111111111111\n9999999999999999999999999999999999999999\n'
          : options.captureStdout === true
            ? ''
            : '',
        timedOut: false,
        truncated: false,
      }),
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-sha-mismatch',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'checkout' },
      sandbox: { cleanup: 'destroyed' },
    });
  });

  it('fails closed when checkout credential cleanup fails', async () => {
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => ({
        exitCode: args.includes('credential.helper') ? 1 : 0,
        stdout: args.includes('rev-parse')
          ? '1111111111111111111111111111111111111111\n2222222222222222222222222222222222222222\n'
          : options.captureStdout === true
            ? ''
            : '',
        timedOut: false,
        truncated: false,
      }),
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-credential-cleanup',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'checkout' },
      sandbox: { cleanup: 'destroyed' },
    });
  });

  it('waits for cleanup on DELETE and reports cleanup failure instead of aborted', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    let releaseAgent: (() => void) | undefined;
    let agentStarted!: () => void;
    const agentReady = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args) => {
        if (args[0] === 'exec') {
          agentStarted();
          return new Promise<RunnerProcessResult>((resolve) => {
            releaseAgent = () =>
              resolve({ exitCode: 1, stdout: '', timedOut: false, truncated: false });
          });
        }
        if (args[0] === 'secret' && args[1] === 'rm') {
          return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-delete-cleanup',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    await agentReady;

    let deleteFinished = false;
    const deleting = runner
      .handle(
        new Request(`http://runner/jobs/${id}`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      )
      .then((response) => {
        deleteFinished = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deleteFinished).toBe(false);
    releaseAgent?.();

    const deleted = await deleting;
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
  });

  it('returns aborted after DELETE stops the agent when all cleanup succeeds', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    let releaseAgent: (() => void) | undefined;
    let agentStarted!: () => void;
    const agentReady = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    const runner = createRunner({
      authToken: 'runner-test-token',
      modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec') {
          agentStarted();
          return new Promise<RunnerProcessResult>((resolve) => {
            releaseAgent = () =>
              resolve({ exitCode: 1, stdout: '', timedOut: false, truncated: false });
            options.onChild?.({
              stdout: null,
              kill: () => {
                releaseAgent?.();
                return true;
              },
              once: () => {},
            } as never);
          });
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submitted = await runner.handle(
      new Request('http://runner/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...runnerJobFields,
          runId: 'run-64-delete-aborted',
          attempt: 1,
          repositoryUrl: 'https://github.com/acme/reviewed.git',
          baseSha,
          headSha,
          repositoryReadToken: 'checkout-token-for-test',
        }),
      }),
    );
    const { id } = (await submitted.json()) as { id: string };
    await agentReady;

    const deleted = await runner.handle(
      new Request(`http://runner/jobs/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );

    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      status: 'aborted',
      sandbox: { cleanup: 'destroyed' },
    });
  });

  it('rejects error events, multiple valid candidates, and oversized output', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const validLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    const outputs = [
      JSON.stringify({ type: 'error' }),
      `${validLine}\n${validLine}\n`,
      'x'.repeat(8 * 1024 * 1024 + 1),
    ];

    for (const [index, agentOutput] of outputs.entries()) {
      const runner = createRunner({
        authToken: 'runner-test-token',
        modelSecretCommand: 'secret-resolver get MODEL_API_KEY',
        process: async (_command, args, options = {}) => ({
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args[0] === 'exec' && options.captureStdout === true
              ? agentOutput
              : '',
          timedOut: false,
          truncated: false,
        }),
      });
      const submitted = await runner.handle(
        new Request('http://runner/jobs', {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...runnerJobFields,
            runId: `run-64-invalid-agent-${index}`,
            attempt: 1,
            repositoryUrl: 'https://github.com/acme/reviewed.git',
            baseSha,
            headSha,
            repositoryReadToken: 'checkout-token-for-test',
          }),
        }),
      );
      const { id } = (await submitted.json()) as { id: string };

      await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
        status: 'failed',
        failure: { reason: 'invalid-output' },
        sandbox: { cleanup: 'destroyed' },
      });
    }
  });
});

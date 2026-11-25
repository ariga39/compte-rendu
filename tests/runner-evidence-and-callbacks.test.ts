import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createRunner,
  finalMarkdownJsonl,
  runAgentScenario,
  runnerJobFields,
  sessionExportJson,
  sharedEvidenceRoot,
  waitForTerminal,
  writeEvidenceFixture,
} from './support/runner-harness';

describe('Runner Job HTTP interface', () => {
  it('expires the archive budget and still destroys the sandbox and delivers the callback', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const callbacks: Request[] = [];
    let advanced = false;
    try {
      const run = await runAgentScenario({
        runId: 'archive-budget-exhausted',
        output: finalMarkdownJsonl(),
        callbackRequests: callbacks,
        onProcess: (args) => {
          if (!advanced && args[0] === 'cp') {
            advanced = true;
            now += 2 * 60 * 1000 + 1;
          }
        },
      });
      expect(advanced).toBe(true);
      expect(run.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'evidence' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(callbacks).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
  it('sends one slim terminal callback and one private diagnostic upload after a successful Job', async () => {
    const callbackRequests: Request[] = [];
    const evidenceRequests: Request[] = [];
    const result = await runAgentScenario({
      runId: 'run-callback-success',
      output: finalMarkdownJsonl(),
      callbackRequests,
      evidenceRequests,
    });

    expect(result.terminal.status).toBe('succeeded');
    expect(callbackRequests).toHaveLength(1);
    expect(evidenceRequests).toHaveLength(1);
    expect(callbackRequests[0]?.url).toBe('https://ingress.test/runner-callback');
    expect(callbackRequests[0]?.headers.get('authorization')).toBe('Bearer callback-token');
    expect(evidenceRequests[0]?.url).toBe('https://ingress.test/runner-evidence');
    expect(evidenceRequests[0]?.headers.get('authorization')).toBe('Bearer callback-token');
    const callback = (await callbackRequests[0]?.clone().json()) as {
      version: number;
      evidence: Record<string, unknown>;
    };
    expect(callback).toMatchObject({
      version: 2,
      evidence: { id: result.terminal.evidenceId, status: 'complete' },
    });
    expect(callback.evidence).not.toHaveProperty('manifest');
    expect(callback.evidence).not.toHaveProperty('opencodeJsonl');
    const upload = (await evidenceRequests[0]?.clone().json()) as {
      version: number;
      evidence: Record<string, unknown>;
    };
    expect(upload).toMatchObject({
      version: 2,
      evidence: {
        id: result.terminal.evidenceId,
        status: 'complete',
        manifest: {
          content: expect.any(String),
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        opencodeJsonl: {
          content: expect.any(String),
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        opencodeStderr: {
          content: expect.any(String),
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        validatedReview: {
          content: expect.any(String),
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        opencodeSessionList: {
          content: expect.any(String),
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        opencodeExport: {
          sessionId: 'scenario-session',
          content: {
            content: expect.any(String),
            size: expect.any(Number),
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        },
      },
    });
    expect(upload.evidence).not.toHaveProperty('files');
  });
  it('retries a transient callback failure with bounded backoff while retaining local evidence', async () => {
    const callbackRequests: Request[] = [];
    const result = await runAgentScenario({
      runId: 'run-callback-loss',
      output: finalMarkdownJsonl(),
      callbackRequests,
      callbackStatuses: [503, 429, 202],
      callbackRetryDelaysMs: [0, 0, 0],
    });

    expect(result.terminal.status).toBe('succeeded');
    expect(callbackRequests).toHaveLength(3);
    expect(await callbackRequests[1]!.clone().text()).toBe(
      await callbackRequests[0]!.clone().text(),
    );
    await expect(
      readFile(
        join(sharedEvidenceRoot, result.terminal.evidenceId as string, 'manifest.json'),
        'utf8',
      ),
    ).resolves.toContain('run-callback-loss');
  });
  it('bounds each callback attempt when callback transport hangs', async () => {
    const callbackRequests: Request[] = [];
    const startedAt = performance.now();
    const result = await runAgentScenario({
      runId: 'run-callback-timeout',
      output: finalMarkdownJsonl(),
      callbackRequests,
      callbackHangs: true,
      callbackTimeoutMs: 5,
      callbackRetryDelaysMs: [0, 0, 0, 0, 0],
    });
    for (let attempt = 0; attempt < 50 && callbackRequests.length < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(result.terminal.status).toBe('succeeded');
    expect(callbackRequests).toHaveLength(5);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
  it('keeps an oversized diagnostic artifact replayable without failing the verified result', async () => {
    const evidenceRoot = await mkdtemp(`${tmpdir()}/compte-rendu-oversized-callback-`);
    const callbackRequests: Request[] = [];
    const evidenceRequests: Request[] = [];
    const sessionExport = (() => {
      const exported = JSON.parse(sessionExportJson('scenario-session')) as {
        messages: unknown[];
      };
      exported.messages.unshift({
        type: 'assistant',
        id: 'preamble',
        finish: 'stop',
        content: [{ type: 'text', text: 'x'.repeat(25 * 1024 * 1024) }],
      });
      return JSON.stringify(exported);
    })();
    let restarted: ReturnType<typeof createRunner> | undefined;
    try {
      const result = await runAgentScenario({
        runId: 'run-114-oversized-callback',
        output: finalMarkdownJsonl(),
        evidenceRoot,
        callbackRequests,
        evidenceRequests,
        sessionExport,
        callbackStatuses: [503, 503, 503, 503, 503],
        callbackRetryDelaysMs: [0, 0, 0, 0, 0],
      });
      const evidenceId = result.terminal.evidenceId as string;
      expect(result.terminal).toMatchObject({
        status: 'succeeded',
        sandbox: { cleanup: 'destroyed' },
      });
      expect(callbackRequests).toHaveLength(5);
      expect(evidenceRequests).toHaveLength(1);
      const callbackBody = await callbackRequests[0]!.clone().text();
      const callback = JSON.parse(callbackBody) as {
        version: number;
        status: string;
        evidence: Record<string, unknown>;
        lifecycle?: unknown;
      };
      expect(callback).toMatchObject({
        version: 2,
        status: 'succeeded',
        evidence: { id: evidenceId, status: 'complete' },
        lifecycle: { stage: 'cleanup', sequence: 5 },
      });
      expect(callback.evidence).not.toHaveProperty('manifest');
      expect(new TextEncoder().encode(callbackBody).byteLength).toBeLessThan(2048);
      await expect(
        readFile(join(evidenceRoot, evidenceId, 'opencode-export-scenario-session.json'), 'utf8'),
      ).resolves.toBe(sessionExport);

      const upload = (await evidenceRequests[0]!.clone().json()) as {
        evidence: {
          opencodeExport: { content: { truncated?: boolean; size: number } };
        };
      };
      expect(upload.evidence.opencodeExport.content.truncated).toBe(true);
      expect(upload.evidence.opencodeExport.content.size).toBeLessThan(
        Buffer.byteLength(sessionExport),
      );

      const replayRequests: Request[] = [];
      restarted = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        claimUrl: '',
        callbackUrl: 'https://ingress.test/runner-callback',
        callbackToken: 'callback-token',
        callbackFetch: async (input, init) => {
          replayRequests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
      });
      const replay = () =>
        restarted!.handle(
          new Request('http://runner/maintenance/replay-callback', {
            method: 'POST',
            headers: {
              authorization: 'Bearer runner-test-token',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              evidenceId,
              jobId: runnerJobFields.id,
              runId: 'run-114-oversized-callback',
              attempt: 1,
              baseSha: result.manifest.baseSha,
              headSha: result.manifest.headSha,
            }),
          }),
        );
      const recovered = await replay();
      expect(recovered.status).toBe(202);
      expect(await recovered.json()).toEqual({ accepted: true });
      expect(replayRequests).toHaveLength(1);
      expect(await replayRequests[0]!.clone().text()).toBe(callbackBody);
      await writeFile(join(evidenceRoot, evidenceId, 'manifest.json'), '{}');
      expect((await replay()).status).toBe(409);
      expect(replayRequests).toHaveLength(1);
    } finally {
      await restarted?.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
  it('returns a durable evidence archive before destroying a successful Sandbox', async () => {
    const evidenceRoot = await mkdtemp(`${tmpdir()}/compte-rendu-evidence-`);
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const finalMarkdown = '## Review:\n\nNo findings.';
    const agentJsonl = finalMarkdownJsonl(finalMarkdown, 'session-89');
    let runner: ReturnType<typeof createRunner> | undefined;
    try {
      runner = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        process: async (command, args, options = {}) => {
          if (args[0] === 'exec' && args.includes('--agent')) {
            await writeFile(options.stdoutFilePath!, `${agentJsonl}\n`, { mode: 0o600 });
            await writeFile(options.stderrFilePath!, '', { mode: 0o600 });
          }
          if (args[0] === 'exec' && args.includes('export')) {
            await writeFile(
              options.stdoutFilePath!,
              `{"session":"${args[args.indexOf('export') + 1]}","full":true}\n`,
              { mode: 0o600 },
            );
          }
          if (command === 'sbx' && args[0] === 'cp') {
            const destination = args[2];
            const sessionId = args[1].match(/opencode-export-([A-Za-z0-9._:-]+)\.json$/)?.[1];
            if (sessionId !== undefined) {
              await writeFile(destination, sessionExportJson(sessionId), { mode: 0o600 });
            } else {
              await mkdir(destination, { recursive: true, mode: 0o700 });
              await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
              await writeFile(join(destination, 'opencode.db-wal'), 'wal', { mode: 0o600 });
              await writeFile(join(destination, 'opencode.db-shm'), 'shm', { mode: 0o600 });
              await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
            }
          }
          return {
            exitCode: 0,
            stdout: args.includes('rev-parse')
              ? `${baseSha}\n${headSha}\n`
              : args.includes('session')
                ? '[{"id":"session-89"},{"id":"session-child"}]\n'
                : args.includes('export')
                  ? `{"session":"${args[args.indexOf('export') + 1]}","full":true}\n`
                  : options.captureStdout === true
                    ? `${agentJsonl}\n`
                    : '',
            stderr: args[0] === 'exec' && args.includes('--format') ? 'agent stderr\n' : '',
            timedOut: false,
            truncated: false,
          };
        },
      });
      const submittedJob = {
        ...runnerJobFields,
        runId: 'run-89-evidence',
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      };
      runner.enqueue(submittedJob);
      const id = submittedJob.id;
      const terminal = await waitForTerminal(runner, id);

      expect(terminal.status).toBe('succeeded');
      expect(terminal.evidenceId).toEqual(expect.any(String));
      expect(terminal.evidence).toEqual({ id: terminal.evidenceId, status: 'complete' });
      const archive = join(evidenceRoot, terminal.evidenceId as string);
      expect(await readFile(join(archive, 'opencode.jsonl'), 'utf8')).toBe(`${agentJsonl}\n`);
      expect(await readFile(join(archive, 'opencode.stderr'), 'utf8')).toBe('');
      expect(await readFile(join(archive, 'manifest.json'), 'utf8')).toContain('run-89-evidence');
      await expect(
        readFile(join(archive, 'opencode-export-session-89.json'), 'utf8'),
      ).resolves.toContain('session-89');
      await expect(
        readFile(join(archive, 'opencode-export-session-child.json'), 'utf8'),
      ).resolves.toContain('session-child');
      await expect(readFile(join(archive, 'opencode-data', 'opencode.db'), 'utf8')).resolves.toBe(
        'db',
      );
      await expect(
        readFile(join(archive, 'opencode-data', 'opencode.db-wal'), 'utf8'),
      ).resolves.toBe('wal');
      await expect(
        readFile(join(archive, 'opencode-data', 'opencode.db-shm'), 'utf8'),
      ).resolves.toBe('shm');
      await expect(readFile(join(archive, 'opencode-data', 'review.log'), 'utf8')).resolves.toBe(
        'log',
      );
      await expect(readFile(join(archive, 'validated-review.md'), 'utf8')).resolves.toBe(
        finalMarkdown,
      );
      expect(JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))).toMatchObject({
        jobId: expect.any(String),
        sandboxName: expect.any(String),
        sandboxId: expect.any(String),
        sessionIds: ['session-89', 'session-child'],
        model: 'opencode-go/deepseek-flash',
        image: 'ghcr.io/ariga39/petit-chiba-opencode:2.4.1-gh2.98.0',
        openCodeVersion: '2.4.1',
        agent: {
          exitCode: 0,
          timedOut: false,
          truncated: false,
          stderrTruncated: false,
          streamError: false,
        },
        validation: { status: 'valid' },
        terminal: { status: 'succeeded' },
        complete: true,
        cleanup: { status: 'destroyed' },
      });
      expect((await stat(archive)).mode & 0o777).toBe(0o700);
      const archiveFiles = await readdir(archive, { withFileTypes: true });
      for (const entry of archiveFiles) {
        expect((await stat(join(archive, entry.name))).mode & 0o777).toBe(
          entry.isDirectory() ? 0o700 : 0o600,
        );
      }
    } finally {
      await runner?.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
  it('retains a complete valid JSON export larger than the Sandbox exec stdout limit', async () => {
    const evidenceRoot = await mkdtemp(`${tmpdir()}/compte-rendu-large-export-`);
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const sessionExport = JSON.stringify({
      info: {
        id: 'large-session',
        outcome: 'succeeded',
        agent: 'review',
        model: { providerID: 'opencode-go', id: 'deepseek-flash' },
      },
      messages: [
        {
          type: 'assistant',
          id: 'msg-large',
          agent: 'review',
          model: { providerID: 'opencode-go', id: 'deepseek-flash' },
          finish: 'stop',
          content: [
            {
              type: 'text',
              text:
                JSON.stringify({
                  decision: 'comment',
                  markdown: '## Review:\n\nNo findings.',
                }) + ' '.repeat(70 * 1024),
            },
          ],
        },
        { type: 'idle', outcome: 'succeeded' },
      ],
    });
    const sessionExportBytes = new TextEncoder().encode(sessionExport);
    expect(sessionExportBytes.byteLength).toBeGreaterThan(64 * 1024);
    const truncatedBySandbox = new TextDecoder().decode(sessionExportBytes.slice(0, 64 * 1024));
    let runner: ReturnType<typeof createRunner> | undefined;
    try {
      runner = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        process: async (command, args, options = {}) => {
          if (args[0] === 'exec' && args.includes('--agent')) {
            await writeFile(
              options.stdoutFilePath!,
              `${finalMarkdownJsonl(undefined, 'large-session')}\n`,
              { mode: 0o600 },
            );
            await writeFile(options.stderrFilePath!, '', { mode: 0o600 });
          }
          if (args[0] === 'exec' && args.includes('export')) {
            if (options.stdoutFilePath !== undefined) {
              await writeFile(options.stdoutFilePath, truncatedBySandbox, { mode: 0o600 });
            }
          }
          if (command === 'sbx' && args[0] === 'cp') {
            const source = args[1];
            const destination = args[2];
            if (!source.endsWith('/data') && !source.endsWith('/state')) {
              await writeFile(destination, sessionExport, { mode: 0o600 });
            } else {
              await mkdir(destination, { recursive: true, mode: 0o700 });
              await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
              await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
            }
          }
          return {
            exitCode: 0,
            stdout: args.includes('rev-parse')
              ? `${baseSha}\n${headSha}\n`
              : args.includes('session')
                ? '[{"id":"large-session"}]\n'
                : args.includes('--agent')
                  ? `${finalMarkdownJsonl(undefined, 'large-session')}\n`
                  : '',
            timedOut: false,
            truncated: false,
          };
        },
      });
      const submittedJob = {
        ...runnerJobFields,
        runId: 'run-107-large-export',
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      };
      runner.enqueue(submittedJob);
      const id = submittedJob.id;
      const terminal = await waitForTerminal(runner, id);

      expect(terminal).toMatchObject({
        status: 'succeeded',
        evidence: { status: 'complete' },
        sandbox: { cleanup: 'destroyed' },
      });
      const archive = join(evidenceRoot, terminal.evidenceId as string);
      const retainedExport = await readFile(
        join(archive, 'opencode-export-large-session.json'),
        'utf8',
      );
      expect(new TextEncoder().encode(retainedExport).byteLength).toBe(
        sessionExportBytes.byteLength,
      );
      expect(JSON.parse(retainedExport)).toEqual(JSON.parse(sessionExport));
      expect(JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))).toMatchObject({
        complete: true,
        evidence: { status: 'complete' },
      });
    } finally {
      await runner?.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
  it('does not report complete evidence for a malformed or truncated session export', async () => {
    const evidenceRoot = await mkdtemp(`${tmpdir()}/compte-rendu-malformed-export-`);
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const malformedExport =
      '{"info":{"id":"malformed-session"},"messages":[' + '"x",'.repeat(16 * 1024);
    let runner: ReturnType<typeof createRunner> | undefined;
    try {
      runner = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        process: async (_command, args, options = {}) => {
          if (args[0] === 'exec' && args.includes('--agent')) {
            await writeFile(
              options.stdoutFilePath!,
              `${finalMarkdownJsonl(undefined, 'malformed-session')}\n`,
              { mode: 0o600 },
            );
            await writeFile(options.stderrFilePath!, '', { mode: 0o600 });
          }
          if (args[0] === 'exec' && args.includes('export')) {
            if (options.stdoutFilePath !== undefined) {
              await writeFile(options.stdoutFilePath, malformedExport, { mode: 0o600 });
            }
          }
          if (args[0] === 'cp') {
            const source = args[1];
            const destination = args[2];
            if (!source.endsWith('/data') && !source.endsWith('/state')) {
              await writeFile(destination, malformedExport, { mode: 0o600 });
            } else {
              await mkdir(destination, { recursive: true, mode: 0o700 });
              await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
              await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
            }
          }
          return {
            exitCode: 0,
            stdout: args.includes('rev-parse')
              ? `${baseSha}\n${headSha}\n`
              : args.includes('session')
                ? '[{"id":"malformed-session"}]\n'
                : args.includes('--agent')
                  ? `${finalMarkdownJsonl(undefined, 'malformed-session')}\n`
                  : '',
            timedOut: false,
            truncated: false,
          };
        },
      });
      const submittedJob = {
        ...runnerJobFields,
        runId: 'run-107-malformed-export',
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      };
      runner.enqueue(submittedJob);
      const id = submittedJob.id;
      const terminal = await waitForTerminal(runner, id);
      const manifest = JSON.parse(
        await readFile(join(evidenceRoot, terminal.evidenceId as string, 'manifest.json'), 'utf8'),
      );

      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
        evidence: { status: 'incomplete' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(manifest).toMatchObject({
        complete: false,
        evidence: { status: 'incomplete' },
        terminal: { status: 'failed', reason: 'invalid-output', cause: 'missing-terminal-message' },
      });
    } finally {
      await runner?.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
  it('reports incomplete evidence as its own failure when archiving fails', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'archive-failure-session');
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: args[0] === 'cp' ? 1 : 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"archive-failure-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-89-archive-failure',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;

    const terminal = await waitForTerminal(runner, id);
    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
      evidence: { status: 'incomplete' },
      sandbox: { cleanup: 'destroyed' },
    });
  });
  it('finalizes incomplete evidence for a terminal checkout failure', async () => {
    const evidenceRoot = await mkdtemp(`${tmpdir()}/compte-rendu-evidence-failure-`);
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    let runner: ReturnType<typeof createRunner> | undefined;
    try {
      runner = createRunner({
        authToken: 'runner-test-token',
        evidenceRoot,
        process: async (_command, args) => ({
          exitCode: args.includes('clone') ? 1 : 0,
          stdout: '',
          timedOut: false,
          truncated: false,
        }),
      });
      const submittedJob = {
        ...runnerJobFields,
        runId: 'run-89-checkout-failure',
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      };
      runner.enqueue(submittedJob);
      const id = submittedJob.id;
      const terminal = await waitForTerminal(runner, id);
      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'checkout' },
        sandbox: { cleanup: 'destroyed' },
      });
      const manifest = JSON.parse(
        await readFile(join(evidenceRoot, terminal.evidenceId as string, 'manifest.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({
        complete: false,
        execution: { status: 'failed', reason: 'checkout' },
        cleanup: { status: 'destroyed' },
      });
      expect(manifest.startedAt).toEqual(expect.any(String));
      expect(manifest.finishedAt).toEqual(expect.any(String));
    } finally {
      await runner?.close();
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
  it('archives available Sandbox evidence when network setup fails before the agent', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'network-failure-session');
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: args[0] === 'policy' && args[1] === 'allow' ? 1 : 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"network-failure-session"}]\n'
              : args.includes('export')
                ? ''
                : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-89-network-setup-failure',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;

    const terminal = await waitForTerminal(runner, id);
    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'agent' },
      evidence: { status: 'incomplete' },
      sandbox: { cleanup: 'destroyed' },
    });
    const archive = join(sharedEvidenceRoot, terminal.evidenceId as string);
    await expect(readFile(join(archive, 'opencode-session-list.json'), 'utf8')).resolves.toContain(
      'network-failure-session',
    );
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db'), 'utf8')).resolves.toBe(
      'db',
    );
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db-wal'), 'utf8')).resolves.toBe(
      'wal',
    );
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db-shm'), 'utf8')).resolves.toBe(
      'shm',
    );
    await expect(readFile(join(archive, 'opencode-data', 'review.log'), 'utf8')).resolves.toBe(
      'log',
    );
  });
  it('redacts sensitive stderr before applying the diagnostic byte bound', async () => {
    const events: Array<Record<string, unknown>> = [];
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const repositoryReadToken = 'secret-checkout-token';
    const overflowingStderr = `${'x'.repeat(4080)}${repositoryReadToken}${'y'.repeat(100)}`;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
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

    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-72-redaction-bound',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
      repositoryReadToken,
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;

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
});

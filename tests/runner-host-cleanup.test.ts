import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({ failHostCleanup: true }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) => {
      // The job executor removes its three host scratch roots recursively.
      // Fail only those paths; askpass/files and evidence cleanup stay real.
      if (
        fsState.failHostCleanup &&
        typeof path === 'string' &&
        /compte-rendu-(review|opencode-config|llm-grant)-/.test(path) &&
        options?.recursive === true
      ) {
        throw Object.assign(new Error('host scratch cleanup unavailable'), { code: 'EACCES' });
      }
      return actual.rm(path, options as never);
    },
  };
});

import {
  createRunner,
  finalMarkdownJsonl,
  runnerJobFields,
  waitForTerminal,
  writeEvidenceFixture,
  type RunnerProcess,
} from './support/runner-harness';

const reviewProcess: RunnerProcess = async (_command, args, options = {}) => {
  const result = finalMarkdownJsonl(undefined, 'host-cleanup-session');
  if (args[0] === 'exec' && args.includes('--agent')) {
    await writeEvidenceFixture(args, options, result);
    return { exitCode: 0, stdout: `${result}\n`, timedOut: false, truncated: false };
  }
  await writeEvidenceFixture(args, options, result);
  return {
    exitCode: 0,
    stdout: args.includes('rev-parse')
      ? `${'1'.repeat(40)}\n${'2'.repeat(40)}\n`
      : args.includes('session')
        ? '[{"id":"host-cleanup-session"}]\n'
        : options.captureStdout === true
          ? `${result}\n`
          : '',
    timedOut: false,
    truncated: false,
  };
};

describe('Runner host cleanup finalization', () => {
  it('fails the task without claiming the destroyed Sandbox survived, so the next task is claimable', async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-host-cleanup-'));
    const evidenceRoot = join(scratchRoot, 'evidence');
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = scratchRoot;
    const callbacks: Request[] = [];
    const runner = createRunner({
      authToken: 'runner-test-token',
      evidenceRoot,
      process: reviewProcess,
      callbackFetch: async (input, init) => {
        callbacks.push(new Request(input, init));
        return new Response(null, { status: 202 });
      },
    });
    try {
      runner.enqueue({
        ...runnerJobFields,
        id: 'runner-host-cleanup-first',
        runId: 'run-host-cleanup-first',
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
      });
      const first = await waitForTerminal(runner, 'runner-host-cleanup-first');
      expect(first).toMatchObject({
        status: 'failed',
        failure: { reason: 'cleanup' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(await callbacks[0]!.json()).toMatchObject({
        version: 2,
        status: 'failed',
        sandbox: { cleanup: 'destroyed' },
        failure: { reason: 'cleanup' },
      });
      const manifest = JSON.parse(
        await readFile(join(evidenceRoot, first.evidenceId as string, 'manifest.json'), 'utf8'),
      ) as { terminal: { status: string; reason?: string }; cleanup: { status: string } };
      expect(manifest).toMatchObject({
        terminal: { status: 'failed', reason: 'cleanup' },
        cleanup: { status: 'destroyed' },
      });

      fsState.failHostCleanup = false;
      runner.enqueue({
        ...runnerJobFields,
        id: 'runner-host-cleanup-next',
        runId: 'run-host-cleanup-next',
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
      });
      expect(await waitForTerminal(runner, 'runner-host-cleanup-next')).toMatchObject({
        status: 'succeeded',
        sandbox: { cleanup: 'destroyed' },
      });
    } finally {
      fsState.failHostCleanup = false;
      await runner.close();
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });
});

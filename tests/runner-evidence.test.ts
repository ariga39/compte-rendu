import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveEvidence, redactEvidenceTextFiles } from '../apps/runner/src/evidence-store';
import type {
  JobSandbox,
  RunnerProcessResult,
  SandboxExecPort,
} from '../apps/runner/src/sandbox-runtime';

const ok: RunnerProcessResult = {
  exitCode: 0,
  stdout: '',
  timedOut: false,
  truncated: false,
};

describe('evidence archival', () => {
  it('publishes discovered session ids before a later archive failure', async () => {
    const evidencePath = await mkdtemp(join(tmpdir(), 'cr-archive-partial-'));
    const sessionIds: string[] = [];
    const sandbox = {
      metadata: { evidenceRoot: '/sandbox/evidence' },
      exec: async (args: readonly string[]) =>
        args.includes('session') && args.includes('list')
          ? { ...ok, stdout: '[{"id":"root-session"}]' }
          : ok,
      copyOut: async (source: string, destination: string) => {
        if (source.includes('opencode-export-root-session.json')) {
          await writeFile(destination, JSON.stringify({ info: { id: 'root-session' } }));
          return ok;
        }
        throw new Error('archive copy failed');
      },
    } as unknown as JobSandbox;
    const archivePort: SandboxExecPort = { run: async () => ok };
    try {
      await expect(
        archiveEvidence({
          evidencePath,
          sandbox,
          archivePort,
          agent: undefined,
          submissionSessionId: undefined,
          multiSelection: undefined,
          sessionIds,
        }),
      ).rejects.toThrow();
      expect(sessionIds).toEqual(['root-session']);
    } finally {
      await rm(evidencePath, { recursive: true, force: true });
    }
  });

  it('redacts partial child exports that never entered the successful session list', async () => {
    const evidencePath = await mkdtemp(join(tmpdir(), 'cr-archive-partial-child-'));
    const partial = join(evidencePath, 'opencode-export-child-partial.json');
    await writeFile(partial, '{"text":"read token grant-secret"}');
    try {
      expect(await redactEvidenceTextFiles(evidencePath, ['grant-secret'])).toBe(true);
      expect(await readFile(partial, 'utf8')).toBe('{"text":"read token [redacted]"}');
    } finally {
      await rm(evidencePath, { recursive: true, force: true });
    }
  });
});

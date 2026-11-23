import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../apps/runner/src/runner';
import { describeCaptureContract, type CaptureDriver } from './support/capture-contract';

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const localDriver = (): CaptureDriver => {
  let started = false;
  return {
    run: async ({ stdout = [], stderr = [] }, options) => {
      const script = [
        ...stdout.map((chunk) => `printf %s ${shellQuote(chunk)}`),
        ...stderr.map((chunk) => `printf %s ${shellQuote(chunk)} >&2`),
      ].join('; sleep 0.05; ');
      const { onChild, ...rest } = options;
      return runProcess('sh', ['-c', script], {
        ...rest,
        onChild: (child) => {
          started = true;
          onChild?.(child);
        },
      });
    },
    started: () => started,
  };
};

describeCaptureContract('local runProcess', localDriver);

describe('runProcess local capture semantics', () => {
  it('keeps the prior zero-max local capture semantics while still writing files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-runner-process-'));
    const stdoutFilePath = join(directory, 'stdout.log');
    const stderrFilePath = join(directory, 'stderr.log');
    try {
      const result = await runProcess('sh', ['-c', 'printf out; printf err >&2'], {
        captureStdout: true,
        captureStderr: true,
        stdoutFilePath,
        stderrFilePath,
      });

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(result.truncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
      await expect(readFile(stdoutFilePath, 'utf8')).resolves.toBe('out');
      await expect(readFile(stderrFilePath, 'utf8')).resolves.toBe('err');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

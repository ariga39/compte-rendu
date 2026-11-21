import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../apps/runner/src/runner';

const withDirectory = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'cr-runner-process-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('runProcess file capture', () => {
  it('bounds stdout and stderr files to maxBytes and keeps the in-limit prefix', async () => {
    await withDirectory(async (directory) => {
      const stdoutFilePath = join(directory, 'stdout.log');
      const stderrFilePath = join(directory, 'stderr.log');

      const result = await runProcess('sh', ['-c', 'printf 0123456789; printf abcdefghij >&2'], {
        captureStdout: true,
        captureStderr: true,
        maxBytes: 8,
        stdoutFilePath,
        stderrFilePath,
      });

      expect(result.stdout).toBe('01234567');
      expect(result.stderr).toBe('abcdefgh');
      expect(result.truncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
      await expect(readFile(stdoutFilePath, 'utf8')).resolves.toBe('01234567');
      await expect(readFile(stderrFilePath, 'utf8')).resolves.toBe('abcdefgh');
      expect((await stat(stdoutFilePath)).size).toBe(8);
      expect((await stat(stderrFilePath)).size).toBe(8);
      expect((await stat(stdoutFilePath)).mode & 0o777).toBe(0o600);
      expect((await stat(stderrFilePath)).mode & 0o777).toBe(0o600);
    });
  });

  it('applies maxBytes to the aggregate file across an append and reports truncation', async () => {
    await withDirectory(async (directory) => {
      const stdoutFilePath = join(directory, 'stdout.log');
      await writeFile(stdoutFilePath, '123456', { mode: 0o600 });

      const result = await runProcess('sh', ['-c', 'printf abcdef'], {
        captureStdout: true,
        maxBytes: 8,
        stdoutFilePath,
        fileAppend: true,
      });

      expect(result.stdout).toBe('ab');
      expect(result.truncated).toBe(true);
      await expect(readFile(stdoutFilePath, 'utf8')).resolves.toBe('123456ab');
      expect((await stat(stdoutFilePath)).size).toBe(8);
    });
  });

  it('drops a trailing secret prefix from a truncated stdout file across chunks', async () => {
    await withDirectory(async (directory) => {
      const stdoutFilePath = join(directory, 'stdout.log');
      const secret = 'CANARYSECRET';

      const result = await runProcess(
        'sh',
        ['-c', 'printf okokokCA; sleep 0.05; printf NARYSECRETTAIL'],
        {
          captureStdout: true,
          stderrRedactions: [secret],
          maxBytes: 8,
          stdoutFilePath,
        },
      );

      expect(result.stdout).toBe('okokokCA');
      expect(result.truncated).toBe(true);
      await expect(readFile(stdoutFilePath, 'utf8')).resolves.toBe('okokok');
    });
  });

  it('observes credentials per stream without combining stdout and stderr', async () => {
    await withDirectory(async (directory) => {
      const result = await runProcess('sh', ['-c', 'printf SEC; printf RET >&2'], {
        captureStdout: true,
        captureStderr: true,
        credentialValues: ['SECRET'],
        maxBytes: 64,
        stdoutFilePath: join(directory, 'stdout.log'),
        stderrFilePath: join(directory, 'stderr.log'),
      });

      expect(result.credentialObserved).not.toBe(true);
    });
  });

  it('keeps the prior zero-max local capture semantics while still writing files', async () => {
    await withDirectory(async (directory) => {
      const stdoutFilePath = join(directory, 'stdout.log');
      const stderrFilePath = join(directory, 'stderr.log');

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
    });
  });

  it('fails closed when append sizing fails for a non-ENOENT reason', async () => {
    await withDirectory(async (directory) => {
      const blocker = join(directory, 'blocker');
      const marker = join(directory, 'spawned');
      await writeFile(blocker, 'not a directory', { mode: 0o600 });

      const result = await runProcess('sh', ['-c', `printf ran > ${marker}`], {
        captureStdout: true,
        maxBytes: 8,
        stdoutFilePath: join(blocker, 'stdout.log'),
        fileAppend: true,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.streamError).toBe(true);
      await expect(readFile(marker, 'utf8')).rejects.toThrow();
    });
  });

  it('honors an abort observed while append sizing is pending', async () => {
    await withDirectory(async (directory) => {
      const stdoutFilePath = join(directory, 'stdout.log');
      await writeFile(stdoutFilePath, 'old', { mode: 0o600 });
      const controller = new AbortController();
      controller.abort();

      const result = await runProcess('sh', ['-c', 'printf new'], {
        captureStdout: true,
        maxBytes: 8,
        stdoutFilePath,
        fileAppend: true,
        signal: controller.signal,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      await expect(readFile(stdoutFilePath, 'utf8')).resolves.toBe('old');
    });
  });

  it('writes redacted stderr to the evidence file across chunk boundaries', async () => {
    await withDirectory(async (directory) => {
      const stderrFilePath = join(directory, 'stderr.log');

      const result = await runProcess(
        'sh',
        ['-c', "printf 'before s3c' >&2; sleep 0.05; printf 'r3t after' >&2"],
        {
          captureStderr: true,
          stderrRedactions: ['s3cr3t'],
          credentialValues: ['s3cr3t'],
          maxBytes: 64,
          stderrFilePath,
        },
      );

      expect(result.credentialObserved).toBe(true);
      expect(result.stderr).toBe('before [redacted] after');
      await expect(readFile(stderrFilePath, 'utf8')).resolves.toBe('before [redacted] after');
    });
  });

  it('does not write a partially cut credential when the file limit is reached', async () => {
    await withDirectory(async (directory) => {
      const stderrFilePath = join(directory, 'stderr.log');
      const secret = 'SECRETVALUE';

      const result = await runProcess('sh', ['-c', `printf 12345${secret} >&2`], {
        captureStderr: true,
        stderrRedactions: [secret],
        maxBytes: 9,
        stderrFilePath,
      });

      await expect(readFile(stderrFilePath, 'utf8')).resolves.toBe('12345[red');
      expect(result.stderr).toBe('12345[red');
      expect(result.stderrTruncated).toBe(true);
      expect(await readFile(stderrFilePath, 'utf8')).not.toContain('SEC');
    });
  });

  it('redacts a credential that straddles the previous rolling redaction window', async () => {
    await withDirectory(async (directory) => {
      const stderrFilePath = join(directory, 'stderr.log');
      const secret = 'SECRETVALUE';

      await runProcess('sh', ['-c', `printf abcd${secret}tail >&2`], {
        captureStderr: true,
        stderrRedactions: [secret],
        maxBytes: 64,
        stderrFilePath,
      });

      await expect(readFile(stderrFilePath, 'utf8')).resolves.toBe('abcd[redacted]tail');
    });
  });
});

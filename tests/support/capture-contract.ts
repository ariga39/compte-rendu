import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  RunnerProcessOptions,
  RunnerProcessResult,
} from '../../apps/runner/src/sandbox-runtime';

/**
 * Backend-neutral bytes for a capture scenario. Drivers turn these into a
 * local process or an SDK event stream; the tests only observe the public
 * capture result and files.
 */
export type CaptureChunks = {
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
};

export type CaptureDriver = {
  run(chunks: CaptureChunks, options: RunnerProcessOptions): Promise<RunnerProcessResult>;
  /** True once the backend actually started work. */
  started(): boolean;
};

const withDirectory = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'cr-capture-contract-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const expectFile = async (path: string, content: string): Promise<void> => {
  await expect(readFile(path, 'utf8')).resolves.toBe(content);
  expect((await stat(path)).size).toBe(Buffer.byteLength(content));
};

const expectPrivateFile = async (path: string): Promise<void> => {
  expect((await stat(path)).mode & 0o777).toBe(0o600);
};

export const describeCaptureContract = (name: string, createDriver: () => CaptureDriver): void => {
  describe(`${name} capture contract`, () => {
    it('bounds stdout and stderr files to maxBytes and keeps the in-limit prefix', async () => {
      await withDirectory(async (directory) => {
        const stdoutFilePath = join(directory, 'stdout.log');
        const stderrFilePath = join(directory, 'stderr.log');

        const result = await createDriver().run(
          { stdout: ['0123456789'], stderr: ['abcdefghij'] },
          {
            captureStdout: true,
            captureStderr: true,
            maxBytes: 8,
            stdoutFilePath,
            stderrFilePath,
          },
        );

        expect(result.stdout).toBe('01234567');
        expect(result.stderr).toBe('abcdefgh');
        expect(result.truncated).toBe(true);
        expect(result.stderrTruncated).toBe(true);
        await expectFile(stdoutFilePath, '01234567');
        await expectFile(stderrFilePath, 'abcdefgh');
        await expectPrivateFile(stdoutFilePath);
        await expectPrivateFile(stderrFilePath);
      });
    });

    it('bounds captured stdout and stderr by maxBytes without files', async () => {
      const stdout = await createDriver().run(
        { stdout: ['hello', 'world'] },
        { captureStdout: true, maxBytes: 8 },
      );
      expect(stdout.exitCode).toBe(0);
      expect(stdout.stdout).toBe('hellowor');
      expect(stdout.truncated).toBe(true);

      const stderr = await createDriver().run(
        { stderr: ['abcdef', 'ghij'] },
        { captureStderr: true, maxBytes: 8 },
      );
      expect(stderr.exitCode).toBe(0);
      expect(stderr.stderr).toBe('abcdefgh');
      expect(stderr.stderrTruncated).toBe(true);
    });

    it('omits stdout and stderr that were not requested', async () => {
      const result = await createDriver().run(
        { stdout: ['unrequested-out'], stderr: ['unrequested-err'] },
        {},
      );

      expect(result.stdout).toBe('');
      expect(result.stderr).toBeUndefined();
    });

    it('writes private files and honors fileAppend', async () => {
      await withDirectory(async (directory) => {
        const stdoutFilePath = join(directory, 'stdout.log');
        const stderrFilePath = join(directory, 'stderr.log');
        const first = await createDriver().run(
          { stdout: ['out\n'], stderr: ['err\n'] },
          {
            captureStdout: true,
            captureStderr: true,
            maxBytes: 64,
            stdoutFilePath,
            stderrFilePath,
          },
        );

        expect(first.stdout).toBe('out\n');
        expect(first.stderr).toBe('err\n');
        await expectFile(stdoutFilePath, 'out\n');
        await expectFile(stderrFilePath, 'err\n');
        await expectPrivateFile(stdoutFilePath);
        await expectPrivateFile(stderrFilePath);

        const second = await createDriver().run(
          { stdout: ['more\n'], stderr: ['warn\n'] },
          {
            captureStdout: true,
            captureStderr: true,
            maxBytes: 64,
            stdoutFilePath,
            stderrFilePath,
            fileAppend: true,
          },
        );

        expect(second.stdout).toBe('more\n');
        expect(second.stderr).toBe('warn\n');
        await expectFile(stdoutFilePath, 'out\nmore\n');
        await expectFile(stderrFilePath, 'err\nwarn\n');
      });
    });

    it('applies maxBytes to the aggregate file across an append and reports truncation', async () => {
      await withDirectory(async (directory) => {
        const stdoutFilePath = join(directory, 'stdout.log');
        await writeFile(stdoutFilePath, '123456', { mode: 0o600 });

        const result = await createDriver().run(
          { stdout: ['abcdef'] },
          {
            captureStdout: true,
            maxBytes: 8,
            stdoutFilePath,
            fileAppend: true,
          },
        );

        expect(result.stdout).toBe('ab');
        expect(result.truncated).toBe(true);
        await expectFile(stdoutFilePath, '123456ab');
      });
    });

    it('drops a trailing secret prefix from a truncated stdout file across chunks', async () => {
      await withDirectory(async (directory) => {
        const stdoutFilePath = join(directory, 'stdout.log');
        const secret = 'CANARYSECRET';

        const result = await createDriver().run(
          { stdout: ['okokokCA', 'NARYSECRETTAIL'] },
          {
            captureStdout: true,
            stderrRedactions: [secret],
            maxBytes: 8,
            stdoutFilePath,
          },
        );

        expect(result.stdout).toBe('okokokCA');
        expect(result.truncated).toBe(true);
        await expectFile(stdoutFilePath, 'okokok');
      });
    });

    it('redacts stderr across chunk boundaries before writing the evidence file', async () => {
      await withDirectory(async (directory) => {
        const stderrFilePath = join(directory, 'stderr.log');

        const result = await createDriver().run(
          { stderr: ['before s3c', 'r3t after'] },
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
        await expectFile(stderrFilePath, 'before [redacted] after');
      });
    });

    it('redacts a credential that straddles the previous rolling redaction window', async () => {
      await withDirectory(async (directory) => {
        const stderrFilePath = join(directory, 'stderr.log');
        const secret = 'SECRETVALUE';

        const result = await createDriver().run(
          { stderr: [`abcd${secret}tail`] },
          {
            captureStderr: true,
            stderrRedactions: [secret],
            maxBytes: 64,
            stderrFilePath,
          },
        );

        expect(result.stderr).toBe('abcd[redacted]tail');
        await expectFile(stderrFilePath, 'abcd[redacted]tail');
      });
    });

    it('does not write a partially cut credential when the file limit is reached', async () => {
      await withDirectory(async (directory) => {
        const stderrFilePath = join(directory, 'stderr.log');
        const secret = 'SECRETVALUE';

        const result = await createDriver().run(
          { stderr: [`12345${secret}`] },
          {
            captureStderr: true,
            stderrRedactions: [secret],
            maxBytes: 9,
            stderrFilePath,
          },
        );

        await expectFile(stderrFilePath, '12345[red');
        expect(result.stderr).toBe('12345[red');
        expect(result.stderrTruncated).toBe(true);
        await expect(readFile(stderrFilePath, 'utf8')).resolves.not.toContain('SEC');
      });
    });

    it('observes credentials per stream without combining stdout and stderr', async () => {
      const result = await createDriver().run(
        { stdout: ['SEC'], stderr: ['RET'] },
        {
          captureStdout: true,
          captureStderr: true,
          credentialValues: ['SECRET'],
          maxBytes: 64,
        },
      );

      expect(result.credentialObserved).not.toBe(true);
    });

    it('fails closed when append sizing fails for a non-ENOENT reason', async () => {
      await withDirectory(async (directory) => {
        const blocker = join(directory, 'blocker');
        await writeFile(blocker, 'not a directory', { mode: 0o600 });
        const driver = createDriver();

        const result = await driver.run(
          { stdout: ['never-started'] },
          {
            captureStdout: true,
            maxBytes: 8,
            stdoutFilePath: join(blocker, 'stdout.log'),
            fileAppend: true,
          },
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.streamError).toBe(true);
        expect(result.stdout).toBe('');
        expect(driver.started()).toBe(false);
      });
    });

    it('does not start an already-aborted append', async () => {
      await withDirectory(async (directory) => {
        const stdoutFilePath = join(directory, 'stdout.log');
        await writeFile(stdoutFilePath, 'old', { mode: 0o600 });
        const controller = new AbortController();
        controller.abort();
        const driver = createDriver();

        const result = await driver.run(
          { stdout: ['new'] },
          {
            captureStdout: true,
            maxBytes: 8,
            stdoutFilePath,
            fileAppend: true,
            signal: controller.signal,
          },
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(driver.started()).toBe(false);
        await expectFile(stdoutFilePath, 'old');
      });
    });
  });
};

import { createWriteStream, type WriteStream } from 'node:fs';
import type { Sandbox } from '@alibaba-group/opensandbox';
import type { RunnerProcessOptions, RunnerProcessResult } from './sandbox-runtime';

const INIT_ABORT_GRACE_MS = 500;

export const executeOpenSandboxCommand = async (
  sandbox: Pick<Sandbox, 'commands'>,
  argv: readonly string[],
  options: RunnerProcessOptions & { signal?: AbortSignal; workingDirectory?: string },
): Promise<RunnerProcessResult> => {
  const signal = options.signal;
  if (signal?.aborted === true) {
    return { exitCode: 1, stdout: '', stderr: '', timedOut: false, truncated: false };
  }
  const maxBytes = options.maxBytes ?? 0;
  const captureStdoutRequested =
    options.captureStdout === true || options.stdoutFilePath !== undefined;
  const captureStderrRequested =
    options.captureStderr === true || options.stderrFilePath !== undefined;
  const stderrRedactions = (options.stderrRedactions ?? [])
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let stderrTruncated = false;
  let stderrPending = '';
  let executionId: string | undefined;
  let interrupt: Promise<void> | undefined;
  let interruptFailed = false;
  const runAbort = new AbortController();
  let abortGrace: ReturnType<typeof setTimeout> | undefined;
  let streamError = false;
  let stdoutFile: WriteStream | undefined;
  let stderrFile: WriteStream | undefined;

  try {
    const flags = options.fileAppend === true ? 'a' : 'w';
    if (options.stdoutFilePath !== undefined) {
      stdoutFile = createWriteStream(options.stdoutFilePath, { flags, mode: 0o600 });
    }
    if (options.stderrFilePath !== undefined) {
      stderrFile = createWriteStream(options.stderrFilePath, { flags, mode: 0o600 });
    }
  } catch {
    streamError = true;
  }
  stdoutFile?.on('error', () => {
    streamError = true;
  });
  stderrFile?.on('error', () => {
    streamError = true;
  });

  const closeFiles = async (): Promise<void> => {
    const open = [stdoutFile, stderrFile].filter(
      (stream): stream is WriteStream => stream !== undefined,
    );
    await Promise.all(
      open.map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.on('error', () => resolve());
            stream.end(() => resolve());
          }),
      ),
    );
  };

  const captureStdout = (text: string): void => {
    if (truncated) return;
    const chunk = Buffer.from(text, 'utf8');
    if (maxBytes > 0 && stdoutBytes + chunk.length > maxBytes) {
      truncated = true;
      return;
    }
    stdoutChunks.push(chunk);
    stdoutBytes += chunk.length;
  };

  const captureStderr = (text: string): void => {
    if (stderrTruncated) return;
    const chunk = Buffer.from(text, 'utf8');
    if (maxBytes > 0 && stderrBytes + chunk.length > maxBytes) {
      const remaining = maxBytes - stderrBytes;
      if (remaining > 0) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
      }
      stderrTruncated = true;
      return;
    }
    stderrChunks.push(chunk);
    stderrBytes += chunk.length;
  };

  const redact = (text: string): string => {
    let redacted = text;
    for (const value of stderrRedactions) redacted = redacted.split(value).join('[redacted]');
    return redacted;
  };

  const flushStderr = (text: string, final: boolean): void => {
    stderrPending += text;
    let keep = 0;
    if (!final) {
      for (const value of stderrRedactions) {
        const limit = Math.min(value.length, stderrPending.length);
        for (let length = limit; length > 0; length -= 1) {
          if (!stderrPending.endsWith(value.slice(0, length))) continue;
          const extendable =
            length < value.length ||
            stderrRedactions.some((other) => other.length > length && other.startsWith(value));
          if (extendable) keep = Math.max(keep, length);
          break;
        }
      }
    }
    const cut = stderrPending.length - keep;
    const ready = stderrPending.slice(0, cut);
    stderrPending = stderrPending.slice(cut);
    const redacted = redact(ready);
    stderrFile?.write(redacted);
    captureStderr(redacted);
  };

  const stop = (id: string): Promise<void> => {
    interrupt ??= Promise.resolve()
      .then(() => sandbox.commands.interrupt(id))
      .then(
        () => undefined,
        () => {
          interruptFailed = true;
          runAbort.abort();
        },
      );
    return interrupt;
  };

  const onAbort = () => {
    if (executionId !== undefined) {
      void stop(executionId);
      return;
    }
    abortGrace ??= setTimeout(() => runAbort.abort(), INIT_ABORT_GRACE_MS);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const execution = await sandbox.commands.run(
      [...argv],
      options.workingDirectory === undefined
        ? undefined
        : { workingDirectory: options.workingDirectory },
      {
        onInit: async ({ id }) => {
          executionId = id;
          if (abortGrace !== undefined) {
            clearTimeout(abortGrace);
            abortGrace = undefined;
          }
          if (signal?.aborted === true) await stop(id);
        },
        onStdout: (message) => {
          if (!captureStdoutRequested) return;
          stdoutFile?.write(message.text);
          captureStdout(message.text);
        },
        onStderr: (message) => {
          if (!captureStderrRequested) return;
          flushStderr(message.text, false);
        },
        skipAccumulation: true,
      },
      runAbort.signal,
    );
    if (interrupt !== undefined) await interrupt;
    flushStderr('', true);
    await closeFiles();
    const incomplete = execution.exitCode === null || execution.exitCode === undefined;
    const exitCode = execution.exitCode ?? 1;
    return {
      exitCode: interruptFailed && exitCode === 0 ? 1 : exitCode,
      stdout: captureStdoutRequested ? Buffer.concat(stdoutChunks).toString('utf8') : '',
      ...(captureStderrRequested
        ? {
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            ...(stderrTruncated ? { stderrTruncated: true } : {}),
          }
        : {}),
      ...(interruptFailed || streamError || incomplete ? { streamError: true } : {}),
      timedOut: false,
      truncated,
    };
  } catch {
    if (interrupt !== undefined) await interrupt;
    flushStderr('', true);
    await closeFiles();
    return {
      exitCode: 1,
      stdout: '',
      timedOut: false,
      truncated: false,
      streamError: true,
    };
  } finally {
    if (abortGrace !== undefined) clearTimeout(abortGrace);
    signal?.removeEventListener('abort', onAbort);
  }
};

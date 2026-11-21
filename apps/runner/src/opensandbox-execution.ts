import { createWriteStream, type WriteStream } from 'node:fs';
import type { Sandbox } from '@alibaba-group/opensandbox';
import {
  appendFileBytes,
  createBoundedFileSink,
  createCredentialObserver,
} from './bounded-file-capture';
import type { RunnerProcessOptions, RunnerProcessResult } from './sandbox-runtime';

const INIT_ABORT_GRACE_MS = 500;

export const executeOpenSandboxCommand = async (
  sandbox: Pick<Sandbox, 'commands'>,
  argv: readonly string[],
  options: RunnerProcessOptions & { signal?: AbortSignal; workingDirectory?: string },
): Promise<RunnerProcessResult> => {
  const signal = options.signal;
  const isAborted = (): boolean => signal?.aborted === true;
  const aborted = (): RunnerProcessResult => ({
    exitCode: 1,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
  });
  if (isAborted()) return aborted();
  const maxBytes = options.maxBytes ?? 0;
  const captureStdoutRequested =
    options.captureStdout === true || options.stdoutFilePath !== undefined;
  const captureStderrRequested =
    options.captureStderr === true || options.stderrFilePath !== undefined;
  const stderrRedactions = (options.stderrRedactions ?? [])
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  const credentialValues = (options.credentialValues ?? []).filter((value) => value.length > 0);
  const fileRedactions = [...new Set([...stderrRedactions, ...credentialValues])].sort(
    (left, right) => right.length - left.length,
  );
  const credentialObserver = createCredentialObserver(credentialValues);
  const existingStdoutBytes =
    options.stdoutFilePath !== undefined && options.fileAppend === true && maxBytes > 0
      ? await appendFileBytes(options.stdoutFilePath)
      : 0;
  const existingStderrBytes =
    options.stderrFilePath !== undefined && options.fileAppend === true && maxBytes > 0
      ? await appendFileBytes(options.stderrFilePath)
      : 0;
  if (existingStdoutBytes === undefined || existingStderrBytes === undefined) {
    return { ...aborted(), streamError: true };
  }
  if (isAborted()) return aborted();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutRemaining =
    options.stdoutFilePath !== undefined && maxBytes > 0
      ? Math.max(0, maxBytes - existingStdoutBytes)
      : maxBytes > 0
        ? maxBytes
        : Number.POSITIVE_INFINITY;
  let stderrRemaining =
    options.stderrFilePath !== undefined && maxBytes > 0
      ? Math.max(0, maxBytes - existingStderrBytes)
      : maxBytes > 0
        ? maxBytes
        : Number.POSITIVE_INFINITY;
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
  let stdoutSink: ReturnType<typeof createBoundedFileSink> | undefined;
  let stderrSink: ReturnType<typeof createBoundedFileSink> | undefined;

  try {
    const flags = options.fileAppend === true ? 'a' : 'w';
    if (options.stdoutFilePath !== undefined) {
      stdoutFile = createWriteStream(options.stdoutFilePath, { flags, mode: 0o600 });
      stdoutSink = createBoundedFileSink({
        limit:
          options.fileAppend === true && maxBytes > 0
            ? Math.max(0, maxBytes - existingStdoutBytes)
            : maxBytes > 0
              ? maxBytes
              : Number.POSITIVE_INFINITY,
        secrets: fileRedactions,
        write: (chunk) => stdoutFile?.write(chunk),
      });
    }
    if (options.stderrFilePath !== undefined) {
      stderrFile = createWriteStream(options.stderrFilePath, { flags, mode: 0o600 });
      stderrSink = createBoundedFileSink({
        limit:
          options.fileAppend === true && maxBytes > 0
            ? Math.max(0, maxBytes - existingStderrBytes)
            : maxBytes > 0
              ? maxBytes
              : Number.POSITIVE_INFINITY,
        secrets: fileRedactions,
        write: (chunk) => stderrFile?.write(chunk),
      });
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
    const chunk = Buffer.from(text, 'utf8');
    if (!truncated) {
      if (chunk.length > stdoutRemaining) {
        const kept = chunk.subarray(0, Math.max(0, stdoutRemaining));
        if (kept.length > 0) {
          stdoutChunks.push(Buffer.from(kept));
          stdoutRemaining -= kept.length;
        }
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutRemaining -= chunk.length;
      }
    }
    stdoutSink?.write(chunk);
    if (stdoutSink?.truncated === true) truncated = true;
  };

  const captureStderr = (text: string): void => {
    const chunk = Buffer.from(text, 'utf8');
    if (!stderrTruncated) {
      if (chunk.length > stderrRemaining) {
        const kept = chunk.subarray(0, Math.max(0, stderrRemaining));
        if (kept.length > 0) {
          stderrChunks.push(Buffer.from(kept));
          stderrRemaining -= kept.length;
        }
        stderrTruncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrRemaining -= chunk.length;
      }
    }
    stderrSink?.write(chunk);
    if (stderrSink?.truncated === true) stderrTruncated = true;
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
    captureStderr(redact(ready));
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
          credentialObserver.observeStdout(Buffer.from(message.text, 'utf8'));
          if (!captureStdoutRequested) return;
          captureStdout(message.text);
        },
        onStderr: (message) => {
          credentialObserver.observeStderr(Buffer.from(message.text, 'utf8'));
          if (!captureStderrRequested) return;
          flushStderr(message.text, false);
        },
        skipAccumulation: true,
      },
      runAbort.signal,
    );
    const incomplete = execution.exitCode === null || execution.exitCode === undefined;
    if (incomplete && executionId !== undefined) await stop(executionId);
    else if (interrupt !== undefined) await interrupt;
    flushStderr('', true);
    stdoutSink?.finish();
    stderrSink?.finish();
    await closeFiles();
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
      ...(credentialObserver.observed ? { credentialObserved: true } : {}),
    };
  } catch {
    if (executionId !== undefined) await stop(executionId);
    else if (interrupt !== undefined) await interrupt;
    flushStderr('', true);
    await closeFiles();
    return {
      exitCode: 1,
      stdout: '',
      timedOut: false,
      truncated: false,
      streamError: true,
      ...(credentialObserver.observed ? { credentialObserved: true } : {}),
    };
  } finally {
    if (abortGrace !== undefined) clearTimeout(abortGrace);
    signal?.removeEventListener('abort', onAbort);
  }
};

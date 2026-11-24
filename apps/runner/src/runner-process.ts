import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { Option, Schema } from 'effect';
import { RunnerProcessErrorCode } from '@compte-rendu/contracts';
import {
  appendFileBytes,
  createBoundedFileSink,
  createCredentialObserver,
} from './bounded-file-capture.js';
import type { HostRun, RunnerProcess, RunnerProcessResult } from './sandbox-runtime.js';

const SETUP_TIMEOUT_MS = 2 * 60 * 1000;

// A spawn failure or thrown process invocation is classified with a fixed
// Schema-decoded allowlist of Node codes rather than its raw message, so
// diagnostics stay safe and comparable. An unrecognized code is omitted
// instead of guessed.
const ProcessErrorCodeShape = Schema.Struct({ code: RunnerProcessErrorCode });
const safeProcessErrorCode = (error: unknown): RunnerProcessErrorCode | undefined => {
  const decoded = Schema.decodeUnknownOption(ProcessErrorCodeShape)(error);
  return Option.isSome(decoded) ? decoded.value.code : undefined;
};

export const processFailure = (error: unknown): RunnerProcessResult => {
  const errorCode = safeProcessErrorCode(error);
  return {
    exitCode: 1,
    stdout: '',
    timedOut: false,
    truncated: false,
    processError: true,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
};

export const stop = (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') => {
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
};

/**
 * Local spawn implementation of the Runner process port. Evidence files share
 * the same byte budget as in-memory capture, including append rounds.
 */
export const runProcess: RunnerProcess = async (command, args, options = {}) => {
  const maxBytes = options.maxBytes ?? 0;
  const captureStdout = options.captureStdout === true || options.stdoutFilePath !== undefined;
  const captureStderr = options.captureStderr === true || options.stderrFilePath !== undefined;
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
  const failure = (streamError: boolean): RunnerProcessResult => ({
    exitCode: 1,
    stdout: '',
    ...(captureStderr ? { stderr: '' } : {}),
    ...(streamError ? { streamError: true } : {}),
    timedOut: false,
    truncated: false,
  });
  if (existingStdoutBytes === undefined || existingStderrBytes === undefined) {
    return failure(true);
  }
  if (options.signal?.aborted === true) return failure(false);

  const memoryLimit = maxBytes > 0 ? maxBytes : 0;
  const fileLimit = maxBytes > 0 ? maxBytes : Number.POSITIVE_INFINITY;

  return new Promise<RunnerProcessResult>((resolve) => {
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrPending = '';
    let stdoutRemaining =
      options.stdoutFilePath !== undefined && maxBytes > 0
        ? Math.max(0, memoryLimit - existingStdoutBytes)
        : memoryLimit;
    let stderrRemaining =
      options.stderrFilePath !== undefined && maxBytes > 0
        ? Math.max(0, memoryLimit - existingStderrBytes)
        : memoryLimit;
    let stderrTruncated = false;
    let streamError = false;
    let truncated = false;
    let timedOut = false;
    let processError = false;
    let errorCode: RunnerProcessErrorCode | undefined;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;
    let stdoutHandle: WriteStream | undefined;
    let stderrHandle: WriteStream | undefined;
    let stdoutSink: ReturnType<typeof createBoundedFileSink> | undefined;
    let stderrSink: ReturnType<typeof createBoundedFileSink> | undefined;

    try {
      const fileFlags = options.fileAppend === true ? 'a' : 'w';
      if (options.stdoutFilePath !== undefined) {
        stdoutHandle = createWriteStream(options.stdoutFilePath, { flags: fileFlags, mode: 0o600 });
        stdoutSink = createBoundedFileSink({
          limit:
            options.fileAppend === true && maxBytes > 0
              ? Math.max(0, fileLimit - existingStdoutBytes)
              : fileLimit,
          secrets: fileRedactions,
          write: (chunk) => stdoutHandle?.write(chunk),
        });
      }
      if (options.stderrFilePath !== undefined) {
        stderrHandle = createWriteStream(options.stderrFilePath, { flags: fileFlags, mode: 0o600 });
        stderrSink = createBoundedFileSink({
          limit:
            options.fileAppend === true && maxBytes > 0
              ? Math.max(0, fileLimit - existingStderrBytes)
              : fileLimit,
          secrets: fileRedactions,
          write: (chunk) => stderrHandle?.write(chunk),
        });
      }
    } catch {
      // Evidence finalization fails closed if a stream cannot be created.
      streamError = true;
    }
    stdoutHandle?.on('error', () => {
      streamError = true;
    });
    stderrHandle?.on('error', () => {
      streamError = true;
    });

    const appendStdout = (buffer: Buffer) => {
      if (!truncated) {
        if (buffer.length > stdoutRemaining) {
          const kept = buffer.subarray(0, Math.max(0, stdoutRemaining));
          if (kept.length > 0) {
            chunks.push(Buffer.from(kept));
            stdoutRemaining -= kept.length;
          }
          truncated = true;
        } else {
          chunks.push(buffer);
          stdoutRemaining -= buffer.length;
        }
      }
      stdoutSink?.write(buffer);
      if (stdoutSink?.truncated === true) truncated = true;
    };

    const appendStderr = (value: string) => {
      if (value.length === 0) return;
      const buffer = new TextEncoder().encode(value);
      if (!stderrTruncated) {
        if (buffer.length > stderrRemaining) {
          const kept = buffer.subarray(0, Math.max(0, stderrRemaining));
          if (kept.length > 0) {
            stderrChunks.push(Buffer.from(kept));
            stderrRemaining -= kept.length;
          }
          stderrTruncated = true;
        } else {
          stderrChunks.push(Buffer.from(buffer));
          stderrRemaining -= buffer.length;
        }
      }
      stderrSink?.write(buffer);
      if (stderrSink?.truncated === true) stderrTruncated = true;
    };

    const flushStderr = (value: string, final: boolean) => {
      stderrPending += value;
      let keep = 0;
      if (!final) {
        for (const redaction of stderrRedactions) {
          const limit = Math.min(redaction.length, stderrPending.length);
          for (let length = limit; length > 0; length -= 1) {
            if (!stderrPending.endsWith(redaction.slice(0, length))) continue;
            const extendable =
              length < redaction.length ||
              stderrRedactions.some(
                (other) => other.length > length && other.startsWith(redaction),
              );
            if (extendable) keep = Math.max(keep, length);
            break;
          }
        }
      }
      const cut = stderrPending.length - keep;
      const processable = stderrPending.slice(0, cut);
      stderrPending = stderrPending.slice(cut);
      let redacted = processable;
      for (const valueToRedact of stderrRedactions) {
        redacted = redacted.replaceAll(valueToRedact, '[redacted]');
      }
      appendStderr(redacted);
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimeout !== undefined) clearTimeout(killTimeout);
      flushStderr('', true);
      stdoutSink?.finish();
      stderrSink?.finish();
      const finishStreams = () =>
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(chunks).toString('utf8'),
          stderr: captureStderr ? Buffer.concat(stderrChunks).toString('utf8') : undefined,
          stderrTruncated: captureStderr ? stderrTruncated : undefined,
          streamError,
          timedOut,
          truncated,
          ...(credentialObserver.observed ? { credentialObserved: true } : {}),
          ...(processError ? { processError: true } : {}),
          ...(errorCode === undefined ? {} : { errorCode }),
        });
      let streams = 0;
      const streamFinished = () => {
        streams -= 1;
        if (streams === 0) finishStreams();
      };
      if (stdoutHandle !== undefined) {
        streams += 1;
        stdoutHandle.end(streamFinished);
      }
      if (stderrHandle !== undefined) {
        streams += 1;
        stderrHandle.end(streamFinished);
      }
      if (streams === 0) finishStreams();
    };

    try {
      child = spawn(command, args, {
        env: options.env ?? process.env,
        stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', captureStderr ? 'pipe' : 'ignore'],
      });
      options.onChild?.(child);
    } catch (error) {
      processError = true;
      errorCode = safeProcessErrorCode(error);
      finish(1);
      return;
    }

    if (captureStdout && child.stdout !== null) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        credentialObserver.observeStdout(buffer);
        appendStdout(buffer);
      });
    }

    if (captureStderr && child.stderr !== null) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        credentialObserver.observeStderr(buffer);
        flushStderr(new TextDecoder().decode(buffer), false);
      });
    }

    timeout = setTimeout(() => {
      timedOut = true;
      stop(child);
      killTimeout = setTimeout(() => stop(child, 'SIGKILL'), 5_000);
    }, options.timeoutMs ?? SETUP_TIMEOUT_MS);
    const handleSpawnError: (error: Error) => void = (error) => {
      processError = true;
      errorCode = safeProcessErrorCode(error);
      finish(1);
    };
    child.once('error', handleSpawnError);
    child.once('close', (exitCode) => finish(exitCode));
  });
};

export const redactProcessResult = (
  result: RunnerProcessResult,
  redactions: readonly string[] | undefined,
): RunnerProcessResult => {
  if (result.stderr === undefined || redactions === undefined) return result;
  let stderr = result.stderr;
  for (const value of redactions) {
    if (value.length > 0) stderr = stderr.replaceAll(value, '[redacted]');
  }
  return stderr === result.stderr ? result : { ...result, stderr };
};

const INSTANCE_COMMAND_TIMEOUT_MS = 30 * 1000;
const MAX_INSTANCE_COMMAND_BYTES = 256 * 1024;

export const createHostRun =
  (process: RunnerProcess): HostRun =>
  (program, args, options = {}) =>
    process(program, args, {
      captureStdout: true,
      captureStderr: true,
      maxBytes: MAX_INSTANCE_COMMAND_BYTES,
      timeoutMs: INSTANCE_COMMAND_TIMEOUT_MS,
      ...options,
    });

import type {
  RunnerDiagnostic,
  RunnerProcess,
  RunnerProcessOptions,
  RunnerProcessResult,
  SandboxExecPort,
} from './sandbox-runtime.js';
import { processFailure, redactProcessResult, stop } from './runner-process.js';
import { currentEpochMillis } from './runner-clock.js';
import {
  MAX_DIAGNOSTIC_STDERR_BYTES,
  boundedDiagnostic,
  jobCredentialValues,
  readTokenSecretValues,
  remainingExecutionMs,
  trackProcessCredentialValues,
  type ExecutionJob,
} from './execution-job.js';
import type { RecordLog } from './operational-log.js';

const SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const CLEANUP_COMMAND_TIMEOUT_MS = 30 * 1000;
const ARCHIVE_COMMAND_TIMEOUT_MS = 30 * 1000;

export interface CommandRunnerOptions {
  readonly process: RunnerProcess;
  readonly recordLog: RecordLog;
}

/**
 * Bounded host command execution shared by checkout, sandbox setup, agent
 * execution, evidence archive and cleanup. It owns byte bounds, deadline
 * clamping, abort wiring, credential redaction and command diagnostics.
 */
export const createCommandRunner = ({
  process: executeProcess,
  recordLog,
}: CommandRunnerOptions) => {
  const recordCommand = async (
    job: ExecutionJob,
    diagnostic: RunnerDiagnostic,
    result: RunnerProcessResult,
  ) => {
    const event = {
      phase: 'runner',
      outcome: 'command',
      runId: job.input.runId,
      stage: diagnostic.stage,
      command: diagnostic.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated === true,
      stderrTruncated: result.stderrTruncated === true,
      streamError: result.streamError === true,
      abortRequested: job.abortRequested,
      processError: result.processError === true,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      ...(diagnostic.includeStderr === true ||
      (diagnostic.stage === 'checkout' && (result.exitCode !== 0 || result.timedOut))
        ? (() => {
            const stderr = boundedDiagnostic(job, result.stderr);
            return stderr === undefined ? {} : { stderr };
          })()
        : {}),
    } as const;
    await recordLog(event);
  };

  const runTracked = async (
    job: ExecutionJob,
    command: string,
    args: readonly string[],
    processOptions: RunnerProcessOptions = {},
    diagnostic?: RunnerDiagnostic,
  ) => {
    const requestedTimeout = processOptions.timeoutMs ?? SETUP_TIMEOUT_MS;
    const remaining = remainingExecutionMs(job);
    trackProcessCredentialValues(job, processOptions.credentialValues);
    const credentialValues = jobCredentialValues(job);
    const redactions = [...credentialValues, ...(processOptions.stderrRedactions ?? [])].filter(
      (value): value is string => value !== undefined && value.length > 0,
    );
    let result: RunnerProcessResult;
    try {
      result = await executeProcess(command, args, {
        ...processOptions,
        captureStderr: processOptions.captureStderr ?? diagnostic !== undefined,
        stderrRedactions:
          diagnostic === undefined ? redactions : [...redactions, job.input.repositoryUrl],
        credentialValues,
        maxBytes:
          diagnostic === undefined
            ? processOptions.maxBytes
            : (processOptions.maxBytes ?? MAX_DIAGNOSTIC_STDERR_BYTES),
        timeoutMs: Math.max(1, Math.min(requestedTimeout, remaining)),
        onChild: (child) => {
          job.child = child;
          processOptions.onChild?.(child);
          if (job.abortRequested) stop(child);
        },
      });
    } catch (error) {
      result = processFailure(error);
    }
    result = redactProcessResult(result, redactions);
    job.child = undefined;
    if (diagnostic !== undefined) await recordCommand(job, diagnostic, result);
    return result;
  };

  const runArchive = async (
    job: ExecutionJob,
    command: string,
    args: readonly string[],
    deadlineAt: number,
    processOptions: RunnerProcessOptions = {},
    diagnostic?: RunnerDiagnostic,
  ) => {
    let remaining: number;
    try {
      remaining = deadlineAt - currentEpochMillis();
    } catch {
      return { exitCode: 1, stdout: '', timedOut: true, truncated: false };
    }
    if (remaining <= 0) {
      return { exitCode: 1, stdout: '', timedOut: true, truncated: false };
    }
    let result: RunnerProcessResult;
    try {
      result = await executeProcess(command, args, {
        ...processOptions,
        captureStderr: processOptions.captureStderr ?? diagnostic !== undefined,
        timeoutMs: Math.max(
          1,
          Math.min(processOptions.timeoutMs ?? ARCHIVE_COMMAND_TIMEOUT_MS, remaining),
        ),
      });
    } catch (error) {
      result = processFailure(error);
    }
    if (diagnostic !== undefined) await recordCommand(job, diagnostic, result);
    return result;
  };

  const cleanupPort = (job: ExecutionJob): SandboxExecPort => ({
    run: async (program, args, processOptions = {}, diagnostic) => {
      let result: RunnerProcessResult;
      try {
        result = await executeProcess(program, args, {
          ...processOptions,
          env: processOptions.env,
          captureStdout: processOptions.captureStdout ?? false,
          captureStderr: true,
          stderrRedactions: [
            ...readTokenSecretValues(job),
            job.grantToken,
            job.input.repositoryUrl,
            ...(processOptions.stderrRedactions ?? []),
          ].filter((value): value is string => value !== undefined && value.length > 0),
          maxBytes: processOptions.maxBytes ?? MAX_DIAGNOSTIC_STDERR_BYTES,
          timeoutMs: CLEANUP_COMMAND_TIMEOUT_MS,
        });
      } catch (error) {
        result = processFailure(error);
      }
      if (diagnostic !== undefined) await recordCommand(job, diagnostic, result);
      return result;
    },
  });

  return { recordCommand, runTracked, runArchive, cleanupPort };
};

export type CommandRunner = ReturnType<typeof createCommandRunner>;

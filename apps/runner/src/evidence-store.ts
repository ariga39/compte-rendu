import { chmod, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Option, Result, Schema } from 'effect';
import { MAX_RUNNER_CALLBACK_BYTES, RunnerResultCallback } from '@compte-rendu/contracts';
import type { JobSandbox, RunnerProcessResult, SandboxExecPort } from './sandbox-runtime.js';
import {
  MAX_AGENT_OUTPUT_BYTES,
  OpenCodeSessionExport,
  sessionIdsFrom,
} from './opencode-config.js';
import {
  parseChildSessionPage,
  sessionSucceeded,
  type ChildSession,
  type MultiReviewSelection,
} from './opencode-multi-review.js';

export const secureEvidenceTree = async (root: string): Promise<void> => {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      await rm(path, { force: true });
      continue;
    }
    if (entry.name === 'auth.json') {
      await rm(path, { force: true });
      continue;
    }
    if (entry.isDirectory()) {
      await secureEvidenceTree(path);
    } else {
      await chmod(path, 0o600);
    }
  }
};

// Redact only the known bounded text evidence surfaces this Runner writes.
// Sandbox databases remain placeholder-only and are never recursively scanned
// or rewritten. latin1 round-trips bytes so an unchanged file is left exact.
export const redactEvidenceTextFiles = async (
  evidencePath: string,
  secrets: readonly string[],
): Promise<boolean> => {
  const active = secrets.filter((value) => value.length > 0);
  if (active.length === 0) return false;
  let found = false;
  const entries = await readdir(evidencePath);
  for (const name of [
    'opencode.jsonl',
    'opencode.stderr',
    'validated-review.md',
    'opencode-session-list.json',
    'multi-review.json',
    ...entries.filter((name) => /^opencode-child-sessions-[1-9]\d*\.json$/.test(name)),
    ...entries.filter((name) => /^opencode-export-[A-Za-z0-9._:-]+\.json$/.test(name)),
  ]) {
    const path = join(evidencePath, name);
    let text: string;
    try {
      text = (await readFile(path)).toString('latin1');
    } catch (error) {
      if (Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(error)) continue;
      throw error;
    }
    let redacted = text;
    for (const secret of active) redacted = redacted.replaceAll(secret, '[redacted]');
    if (redacted !== text) {
      found = true;
      await writeFile(path, Buffer.from(redacted, 'latin1'), { mode: 0o600 });
    }
  }
  return found;
};

export const writeManifestAtomically = async (path: string, value: unknown) => {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
};

// Persist the exact final callback body before transmission. A local write
// failure must not suppress delivery; the archive is the recovery copy.
export const persistCallbackBody = async (evidencePath: string, body: string) => {
  try {
    const path = join(evidencePath, 'callback.json');
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, body, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch {
    // Delivery still owns the terminal outcome when persistence is unavailable.
  }
};

export const evidenceFiles = async (root: string, prefix = ''): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await evidenceFiles(join(root, entry.name), relative)));
    else files.push(relative);
  }
  return files.sort();
};

const MAX_CHILD_SESSION_PAGES = 100;
const EMPTY_EVIDENCE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const archiveEvidence = async (input: {
  readonly evidencePath: string;
  readonly sandbox: JobSandbox;
  readonly archivePort: SandboxExecPort;
  readonly agent: RunnerProcessResult | undefined;
  readonly submissionSessionId: string | undefined;
  readonly multiSelection: MultiReviewSelection | undefined;
  readonly sessionIds: string[];
}): Promise<{
  readonly complete: boolean;
  readonly terminal: boolean;
}> => {
  const {
    evidencePath,
    sandbox,
    archivePort,
    agent,
    submissionSessionId,
    multiSelection,
    sessionIds,
  } = input;
  let complete = agent?.streamError !== true;
  let terminal = false;
  const fileExists = async (path: string) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  };
  const nonemptyFile = async (path: string) => {
    try {
      return (await stat(path)).size > 0;
    } catch {
      return false;
    }
  };
  const sessionExportMatches = async (path: string, sessionId: string) => {
    try {
      const decoded = Schema.decodeUnknownOption(OpenCodeSessionExport)(
        JSON.parse(await readFile(path, 'utf8')),
      );
      return Option.isSome(decoded) && decoded.value.info.id === sessionId;
    } catch {
      return false;
    }
  };
  const sessionExportSucceeded = async (path: string, sessionId: string) => {
    try {
      return sessionSucceeded(JSON.parse(await readFile(path, 'utf8')), sessionId);
    } catch {
      return false;
    }
  };
  if (!(await nonemptyFile(join(evidencePath, 'opencode.jsonl')))) complete = false;
  if (!(await fileExists(join(evidencePath, 'opencode.stderr')))) complete = false;

  if (sandbox === undefined) {
    complete = false;
  } else {
    const evidenceRoot = sandbox.metadata.evidenceRoot;
    const sessions = await sandbox.exec(
      ['opencode', 'session', 'list', '--standalone', '--format', 'json'],
      archivePort,
      {
        captureStdout: true,
        maxBytes: MAX_AGENT_OUTPUT_BYTES,
      },
    );
    if (
      sessions.exitCode !== 0 ||
      sessions.timedOut ||
      sessions.truncated ||
      sessions.stdout.length === 0
    ) {
      complete = false;
    } else {
      await writeFile(join(evidencePath, 'opencode-session-list.json'), sessions.stdout, {
        mode: 0o600,
      });
      const sessionIdsValue = sessionIdsFrom(sessions.stdout);
      if (sessionIdsValue === undefined || sessionIdsValue.length === 0) {
        complete = false;
      } else {
        sessionIds.push(...sessionIdsValue);
        const exportSession = async (sessionId: string): Promise<boolean> => {
          const exportPath = join(evidencePath, `opencode-export-${sessionId}.json`);
          const sandboxExportPath = `${evidenceRoot}/opencode-export-${sessionId}.json`;
          const exported = await sandbox.exec(
            [
              'sh',
              '-c',
              `opencode session export --standalone ${sessionId} > ${sandboxExportPath}`,
            ],
            archivePort,
            {},
          );
          const copied = await sandbox.copyOut(sandboxExportPath, exportPath, archivePort);
          const exportReadable =
            exported.exitCode === 0 &&
            !exported.timedOut &&
            exported.streamError !== true &&
            copied.exitCode === 0 &&
            !copied.timedOut &&
            copied.streamError !== true;
          return exportReadable && (await sessionExportMatches(exportPath, sessionId));
        };
        for (const sessionId of sessionIdsValue) {
          if (!(await exportSession(sessionId))) {
            complete = false;
            continue;
          }
          if (sessionId === submissionSessionId) {
            terminal = await sessionExportSucceeded(
              join(evidencePath, `opencode-export-${sessionId}.json`),
              sessionId,
            );
          }
        }
        if (multiSelection !== undefined) {
          if (sessionIdsValue.length !== 1) {
            complete = false;
          } else {
            const rootSessionId = sessionIdsValue[0]!;
            // Follow native session.list pagination: request the parent
            // filter plus the previous page's next cursor, and keep going
            // until an empty page or an enumeration error. Child evidence is
            // best effort; duplicate records are skipped and repeated cursors
            // stop enumeration. Every readable raw page is retained.
            const listChildSessions = async (): Promise<readonly ChildSession[] | undefined> => {
              const collected: ChildSession[] = [];
              const seenIds = new Set<string>();
              const seenCursors = new Set<string>();
              let cursor: string | null = null;
              for (let page = 1; page <= MAX_CHILD_SESSION_PAGES; page += 1) {
                const args = [
                  'opencode',
                  'api',
                  '--standalone',
                  'session.list',
                  '--param',
                  `parentID=${rootSessionId}`,
                ];
                if (cursor !== null) args.push('--param', `cursor=${cursor}`);
                const listed = await sandbox.exec(args, archivePort, {
                  captureStdout: true,
                  maxBytes: MAX_AGENT_OUTPUT_BYTES,
                });
                if (
                  listed.exitCode !== 0 ||
                  listed.timedOut ||
                  listed.truncated ||
                  listed.stdout.length === 0
                ) {
                  return undefined;
                }
                await writeFile(
                  join(evidencePath, `opencode-child-sessions-${page}.json`),
                  listed.stdout,
                  { mode: 0o600 },
                );
                const parsed = parseChildSessionPage(listed.stdout);
                if (parsed === undefined) return undefined;
                for (const child of parsed.data) {
                  if (seenIds.has(child.id)) continue;
                  seenIds.add(child.id);
                  collected.push(child);
                }
                if (parsed.data.length === 0) return collected;
                const next = parsed.cursor.next;
                if (next === null) return collected;
                if (next === cursor || seenCursors.has(next)) return collected;
                seenCursors.add(next);
                cursor = next;
              }
              return undefined;
            };
            // Child sessions are best-effort provenance. Unavailable or
            // extra children never fail the job and never cap the roster.
            const listed = await listChildSessions();
            if (listed !== undefined) {
              for (const child of listed) {
                if (await exportSession(child.id)) sessionIds.push(child.id);
              }
            }
          }
        }
      }
    }
    for (const tree of ['data', 'state']) {
      const destination = join(evidencePath, `opencode-${tree}`);
      const copied = await sandbox.copyOut(`${evidenceRoot}/${tree}`, destination, archivePort, {
        stage: 'sandbox',
        command: `archive-opencode-${tree}`,
        includeStderr: true,
      });
      if (copied.exitCode !== 0 || copied.timedOut) complete = false;
    }
  }
  await secureEvidenceTree(evidencePath);
  const files = await evidenceFiles(evidencePath);
  const hasNonemptyFile = async (predicate: (file: string) => boolean) => {
    for (const file of files) {
      if (predicate(file) && (await nonemptyFile(join(evidencePath, file)))) return true;
    }
    return false;
  };
  if (!(await hasNonemptyFile((file) => file.endsWith('/opencode.db') || file === 'opencode.db'))) {
    complete = false;
  }
  if (!(await hasNonemptyFile((file) => file.endsWith('.log')))) complete = false;
  if (sessionIds.some((sessionId) => !files.includes(`opencode-export-${sessionId}.json`))) {
    complete = false;
  }
  return { complete, terminal };
};

const callbackEvidence = async (input: {
  readonly evidencePath: string;
  readonly evidence: {
    readonly id: string;
    readonly status: 'pending' | 'complete' | 'incomplete';
  };
  readonly sessionIds: readonly string[];
  readonly includeValidatedReview: boolean;
}) => {
  const { evidencePath, evidence, sessionIds, includeValidatedReview } = input;
  const encoded = async (name: string) => {
    try {
      const bytes = await readFile(join(evidencePath, name));
      const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return {
        content: bytes.toString('base64'),
        size: bytes.byteLength,
        sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(
          '',
        ),
      };
    } catch {
      const hash = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array());
      return {
        content: '',
        size: 0,
        sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(
          '',
        ),
      };
    }
  };
  const sessionId = sessionIds[0];
  return {
    id: evidence.id,
    status: evidence.status,
    manifest: await encoded('manifest.json'),
    opencodeJsonl: await encoded('opencode.jsonl'),
    opencodeStderr: await encoded('opencode.stderr'),
    ...(includeValidatedReview === false
      ? {}
      : { validatedReview: await encoded('validated-review.md') }),
    opencodeSessionList: await encoded('opencode-session-list.json'),
    ...(sessionId === undefined
      ? {}
      : {
          opencodeExport: {
            sessionId,
            content: await encoded(`opencode-export-${sessionId}.json`),
          },
        }),
  };
};

export interface CallbackSenderOptions {
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly recordLog: (
    event: import('@compte-rendu/contracts').OperationalLogEvent,
  ) => Promise<void>;
}

export interface CallbackDeliveryInput {
  readonly evidencePath: string;
  readonly identity: { readonly id: string; readonly runId: string; readonly attempt: number };
  readonly status: import('@compte-rendu/contracts').RunnerJobResponse['status'];
  readonly stage: import('@compte-rendu/contracts').RunnerJobResponse['stage'];
  readonly failure: import('@compte-rendu/contracts').RunnerJobResponse['failure'];
  readonly result: import('@compte-rendu/contracts').RunnerJobResponse['result'];
  readonly lifecycle?: import('@compte-rendu/contracts').RunnerProgressSnapshot | undefined;
  readonly usage?: import('@compte-rendu/contracts').ModelUsageSummary | undefined;
  readonly sandbox: import('@compte-rendu/contracts').RunnerJobResponse['sandbox'];
  readonly evidence: {
    readonly id: string;
    readonly status: 'pending' | 'complete' | 'incomplete';
  };
  readonly sessionIds: readonly string[];
  readonly timestamps: {
    readonly executionStartedAt?: string | undefined;
    readonly submissionCompletedAt?: string | undefined;
    readonly cleanupCompletedAt?: string | undefined;
  };
}

const sendCallback = async (
  options: CallbackSenderOptions,
  input: CallbackDeliveryInput,
): Promise<boolean> => {
  const {
    evidencePath,
    identity,
    status,
    stage,
    failure,
    result,
    lifecycle,
    usage,
    sandbox,
    evidence,
    sessionIds,
    timestamps,
  } = input;
  if (options.url === undefined || options.token === undefined) return false;
  if (status !== 'succeeded' && status !== 'failed' && status !== 'aborted') return false;
  const callback = {
    id: identity.id,
    runId: identity.runId,
    attempt: identity.attempt,
    status,
    stage,
    lifecycle,
    ...(usage === undefined ? {} : { usage }),
    sandbox,
    evidence: await callbackEvidence({
      evidencePath,
      evidence,
      sessionIds,
      includeValidatedReview: result !== undefined,
    }),
    timestamps,
    ...(result === undefined ? {} : { result }),
    ...(failure === undefined ? {} : { failure }),
  };
  const decoded = await Schema.decodeUnknownPromise(RunnerResultCallback)(callback);
  const completeBody = JSON.stringify(decoded);
  const callbackTooLarge =
    new TextEncoder().encode(completeBody).byteLength > MAX_RUNNER_CALLBACK_BYTES;
  if (callbackTooLarge) {
    try {
      const manifest = JSON.parse(
        await readFile(join(evidencePath, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      manifest.execution = { status: 'failed', reason: 'evidence' };
      manifest.terminal = { status: 'failed', reason: 'evidence' };
      manifest.evidence = { id: callback.evidence.id, status: 'incomplete' };
      manifest.complete = false;
      manifest.evidenceFailure = 'callback-too-large';
      // A reconciled terminal failure must not retain a validated result.
      delete manifest.result;
      await writeManifestAtomically(join(evidencePath, 'manifest.json'), manifest);
    } catch {
      // The original local evidence remains available if reconciliation fails.
    }
  }
  const body = callbackTooLarge
    ? JSON.stringify(
        await Schema.decodeUnknownPromise(RunnerResultCallback)({
          id: callback.id,
          runId: callback.runId,
          attempt: callback.attempt,
          status: 'failed',
          stage: callback.stage,
          sandbox: callback.sandbox,
          evidence: {
            id: callback.evidence.id,
            status: 'incomplete',
            manifest: { content: '', size: 0, sha256: EMPTY_EVIDENCE_SHA256 },
            opencodeJsonl: { content: '', size: 0, sha256: EMPTY_EVIDENCE_SHA256 },
            opencodeStderr: { content: '', size: 0, sha256: EMPTY_EVIDENCE_SHA256 },
          },
          timestamps: callback.timestamps,
          lifecycle: callback.lifecycle,
          failure: { reason: 'evidence' },
        }),
      )
    : completeBody;
  await persistCallbackBody(evidencePath, body);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const response = await Promise.race([
        options.fetch(options.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
          },
          body,
          signal: controller.signal,
        }),
        new Promise<Response>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('runner callback request timed out'));
          }, options.timeoutMs);
        }),
      ]);
      if (response.ok) {
        await options.recordLog({
          phase: 'runner',
          outcome: 'callback',
          runId: identity.runId,
          jobId: identity.id,
          attempt: attempt + 1,
          result: 'accepted',
          status: response.status,
        });
        return callbackTooLarge;
      }
      await options.recordLog({
        phase: 'runner',
        outcome: 'callback',
        runId: identity.runId,
        jobId: identity.id,
        attempt: attempt + 1,
        result: 'http-error',
        status: response.status,
      });
    } catch {
      // The local evidence remains the recovery copy when callback delivery is lost.
      await options.recordLog({
        phase: 'runner',
        outcome: 'callback',
        runId: identity.runId,
        jobId: identity.id,
        attempt: attempt + 1,
        result: timedOut ? 'timeout' : 'transport-error',
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    if (attempt === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  // Local terminal state is not Core delivery: make the exhausted delivery explicit.
  await options.recordLog({
    phase: 'runner',
    outcome: 'callback-delivery-failed',
    runId: identity.runId,
    jobId: identity.id,
  });
  return callbackTooLarge;
};

export const createCallbackSender =
  (options: CallbackSenderOptions) => (input: CallbackDeliveryInput) =>
    sendCallback(options, input);

export type BoundedDelivery =
  | { readonly ok: true; readonly status: 202 }
  | {
      readonly ok: false;
      readonly reason: 'http-error' | 'timeout' | 'transport-error';
      readonly status?: number;
    };

export const deliveryStatusRetryable = (status: number | undefined): boolean =>
  status === 408 || status === 429 || (status !== undefined && status >= 500);

export interface BoundedDeliveryOptions {
  readonly token?: string | undefined;
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
}

class BoundedDeliveryError extends Schema.TaggedError<BoundedDeliveryError>()(
  'BoundedDeliveryError',
  {},
) {}

export const createBoundedDelivery = (options: BoundedDeliveryOptions) => {
  const deliver = Effect.fn('BoundedDelivery.post')(function* (url: string, body: string) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await options.fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
          },
          body,
          signal,
        });
        await response.body?.cancel().catch(() => undefined);
        return response.status;
      },
      catch: () => new BoundedDeliveryError(),
    }).pipe(Effect.timeout(options.timeoutMs));
  });
  return async (url: string, body: string): Promise<BoundedDelivery> => {
    if (options.token === undefined) return { ok: false, reason: 'transport-error' };
    const result = await Effect.runPromise(Effect.result(deliver(url, body)));
    if (Result.isFailure(result)) {
      return {
        ok: false,
        reason: Schema.is(Schema.Struct({ _tag: Schema.Literal('TimeoutError') }))(result.failure)
          ? 'timeout'
          : 'transport-error',
      };
    }
    return result.success === 202
      ? { ok: true, status: 202 }
      : { ok: false, reason: 'http-error', status: result.success };
  };
};

import { chmod, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Duration, Effect, Option, Result, Schema } from 'effect';
import {
  MAX_RUNNER_EVIDENCE_BYTES,
  RunnerEvidenceUpload,
  RunnerResultCallbackV2,
} from '@compte-rendu/contracts';
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
// failure must not suppress delivery; the archive supports diagnosis and
// verified cleanup confirmation, not callback replay.
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

const EMPTY_EVIDENCE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const EVIDENCE_JSON_OVERHEAD_BYTES = 64 * 1024;

type UploadedEvidenceField = {
  readonly content: string;
  readonly size: number;
  readonly sha256: string;
  readonly truncated?: boolean;
};

type EvidenceArtifactSpec = {
  readonly key:
    | 'manifest'
    | 'opencodeSessionList'
    | 'validatedReview'
    | 'opencodeStderr'
    | 'opencodeJsonl'
    | 'opencodeExport';
  readonly name: string;
  readonly required: boolean;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const emptyEvidenceField = (): UploadedEvidenceField => ({
  content: '',
  size: 0,
  sha256: EMPTY_EVIDENCE_SHA256,
});

// Read no more than the bytes this artifact is allowed to upload. A very large
// local log must never allocate its full size just to discover it cannot fit.
const readBoundedArtifact = async (
  path: string,
  limit: number,
): Promise<{ readonly bytes: Buffer; readonly total: number } | undefined> => {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return undefined;
  const readable = Math.max(0, Math.min(info.size, limit));
  if (readable === 0) return { bytes: Buffer.alloc(0), total: info.size };
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(readable);
    const { bytesRead } = await handle.read(buffer, 0, readable, 0);
    return { bytes: buffer.subarray(0, bytesRead), total: info.size };
  } finally {
    await handle.close();
  }
};

const uploadedEvidenceField = async (
  evidencePath: string,
  spec: EvidenceArtifactSpec,
  limit: number,
): Promise<UploadedEvidenceField | undefined> => {
  const artifact = await readBoundedArtifact(join(evidencePath, spec.name), limit);
  if (artifact === undefined) return spec.required ? emptyEvidenceField() : undefined;
  return {
    content: artifact.bytes.toString('base64'),
    size: artifact.bytes.byteLength,
    sha256: await sha256Hex(artifact.bytes),
    ...(artifact.total > artifact.bytes.byteLength ? { truncated: true } : {}),
  };
};

const uploadedEvidence = async (input: {
  readonly evidencePath: string;
  readonly evidence: {
    readonly id: string;
    readonly status: 'pending' | 'complete' | 'incomplete';
  };
  readonly sessionIds: readonly string[];
}) => {
  const { evidencePath, evidence, sessionIds } = input;
  const sessionId = sessionIds[0];
  // Preserve small readable metadata first. Large logs consume what remains so
  // a single oversized export cannot make the rest of the archive unreadable.
  const specs: EvidenceArtifactSpec[] = [
    { key: 'manifest', name: 'manifest.json', required: true },
    { key: 'opencodeSessionList', name: 'opencode-session-list.json', required: false },
    { key: 'validatedReview', name: 'validated-review.md', required: false },
    { key: 'opencodeStderr', name: 'opencode.stderr', required: true },
    { key: 'opencodeJsonl', name: 'opencode.jsonl', required: true },
    ...(sessionId === undefined
      ? []
      : [
          {
            key: 'opencodeExport' as const,
            name: `opencode-export-${sessionId}.json`,
            required: false,
          },
        ]),
  ];
  let remaining = MAX_RUNNER_EVIDENCE_BYTES - EVIDENCE_JSON_OVERHEAD_BYTES;
  const fields = new Map<EvidenceArtifactSpec['key'], UploadedEvidenceField>();
  for (const spec of specs) {
    // Base64 expands three source bytes into four upload bytes.
    const rawLimit = Math.max(0, Math.floor((remaining * 3) / 4));
    const field = await uploadedEvidenceField(evidencePath, spec, rawLimit);
    if (field === undefined) continue;
    fields.set(spec.key, field);
    remaining -= field.content.length;
  }
  const required = (key: EvidenceArtifactSpec['key']) => fields.get(key) ?? emptyEvidenceField();
  const exported = fields.get('opencodeExport');
  return {
    id: evidence.id,
    status: evidence.status === 'pending' ? 'incomplete' : evidence.status,
    manifest: required('manifest'),
    opencodeJsonl: required('opencodeJsonl'),
    opencodeStderr: required('opencodeStderr'),
    ...(fields.get('validatedReview') === undefined
      ? {}
      : { validatedReview: fields.get('validatedReview') }),
    ...(fields.get('opencodeSessionList') === undefined
      ? {}
      : { opencodeSessionList: fields.get('opencodeSessionList') }),
    ...(sessionId === undefined || exported === undefined
      ? {}
      : { opencodeExport: { sessionId, content: exported } }),
  };
};

export interface CallbackSenderOptions {
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly retryDelaysMs?: readonly number[] | undefined;
  readonly recordLog: (
    event: import('@compte-rendu/contracts').OperationalLogEvent,
  ) => Promise<void>;
}

export interface CallbackDeliveryInput {
  readonly evidencePath: string;
  readonly identity: {
    readonly id: string;
    readonly runId: string;
    readonly attempt: number;
    readonly baseSha: string;
    readonly headSha: string;
  };
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

export interface EvidenceUploadSenderOptions {
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
}

export interface EvidenceUploadDeliveryInput {
  readonly evidencePath: string;
  readonly identity: { readonly id: string; readonly runId: string; readonly attempt: number };
  readonly evidence: {
    readonly id: string;
    readonly status: 'pending' | 'complete' | 'incomplete';
  };
  readonly sessionIds: readonly string[];
  readonly timestamps: CallbackDeliveryInput['timestamps'];
}

const sendCallback = async (
  options: CallbackSenderOptions,
  input: CallbackDeliveryInput,
): Promise<void> => {
  const {
    identity,
    status,
    stage,
    failure,
    result,
    lifecycle,
    usage,
    sandbox,
    evidence,
    timestamps,
  } = input;
  if (options.url === undefined || options.token === undefined) return;
  if (status !== 'succeeded' && status !== 'failed' && status !== 'aborted') return;
  const callback = {
    version: 2,
    id: identity.id,
    runId: identity.runId,
    attempt: identity.attempt,
    baseSha: identity.baseSha,
    headSha: identity.headSha,
    status,
    stage,
    lifecycle,
    ...(usage === undefined ? {} : { usage }),
    sandbox,
    evidence: {
      id: evidence.id,
      status: evidence.status === 'pending' ? 'incomplete' : evidence.status,
    },
    timestamps,
    ...(result === undefined ? {} : { result }),
    ...(failure === undefined ? {} : { failure }),
  };
  const decoded = await Schema.decodeUnknownPromise(RunnerResultCallbackV2)(callback);
  const body = JSON.stringify(decoded);
  await persistCallbackBody(input.evidencePath, body);
  const delivered = await createBoundedDelivery({
    token: options.token,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    retryDelaysMs: options.retryDelaysMs,
    onAttempt: async (attempt, delivery) => {
      await options.recordLog(
        delivery.ok
          ? {
              phase: 'runner',
              outcome: 'callback',
              runId: identity.runId,
              jobId: identity.id,
              attempt,
              result: 'accepted',
              status: delivery.status,
            }
          : delivery.reason === 'http-error'
            ? {
                phase: 'runner',
                outcome: 'callback',
                runId: identity.runId,
                jobId: identity.id,
                attempt,
                result: 'http-error',
                status: delivery.status,
              }
            : {
                phase: 'runner',
                outcome: 'callback',
                runId: identity.runId,
                jobId: identity.id,
                attempt,
                result: delivery.reason,
              },
      );
    },
  })(options.url, body);
  if (delivered.ok) return;
  // Local terminal state is not Core delivery: make the exhausted delivery explicit.
  await options.recordLog({
    phase: 'runner',
    outcome: 'callback-delivery-failed',
    runId: identity.runId,
    jobId: identity.id,
  });
};

const sendEvidence = async (
  options: EvidenceUploadSenderOptions,
  input: EvidenceUploadDeliveryInput,
): Promise<void> => {
  if (options.url === undefined || options.token === undefined) return;
  const upload = {
    version: 2,
    id: input.identity.id,
    runId: input.identity.runId,
    attempt: input.identity.attempt,
    evidenceId: input.evidence.id,
    evidence: await uploadedEvidence({
      evidencePath: input.evidencePath,
      evidence: input.evidence,
      sessionIds: input.sessionIds,
    }),
    timestamps: input.timestamps,
  };
  const decoded = await Schema.decodeUnknownPromise(RunnerEvidenceUpload)(upload);
  const body = JSON.stringify(decoded);
  const delivered = await createBoundedDelivery({
    token: options.token,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    retryDelaysMs: [0],
  })(options.url, body);
  if (!delivered.ok) {
    // The complete local evidence directory remains the recovery copy.
    await Effect.runPromise(Effect.logWarning('runner evidence upload unavailable')).catch(
      () => undefined,
    );
  }
};

export const createCallbackSender =
  (options: CallbackSenderOptions) => (input: CallbackDeliveryInput) =>
    sendCallback(options, input);

export const createEvidenceUploader =
  (options: EvidenceUploadSenderOptions) => (input: EvidenceUploadDeliveryInput) =>
    sendEvidence(options, input);

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
  /** Delay before each attempt. The first entry is normally zero. */
  readonly retryDelaysMs?: readonly number[] | undefined;
  readonly onAttempt?:
    | ((attempt: number, delivery: BoundedDelivery) => void | Promise<void>)
    | undefined;
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
  const attemptDelivery = async (url: string, body: string): Promise<BoundedDelivery> => {
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
  return async (url: string, body: string): Promise<BoundedDelivery> => {
    if (options.token === undefined) return { ok: false, reason: 'transport-error' };
    const delays =
      options.retryDelaysMs === undefined || options.retryDelaysMs.length === 0
        ? [0]
        : options.retryDelaysMs;
    let result: BoundedDelivery = { ok: false, reason: 'transport-error' };
    for (const [index, delay] of delays.entries()) {
      if (delay > 0) await Effect.runPromise(Effect.sleep(Duration.millis(delay)));
      result = await attemptDelivery(url, body);
      await options.onAttempt?.(index + 1, result);
      if (result.ok) return result;
      if (result.reason === 'http-error' && !deliveryStatusRetryable(result.status)) return result;
    }
    return result;
  };
};

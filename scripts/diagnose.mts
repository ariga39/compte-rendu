import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime, Option, Schema } from 'effect';

const STDERR_BOUND_BYTES = 4 * 1024;
const Identifier = Schema.NonEmptyString;
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/i));
const NonNegativeInt = Schema.Int.check(
  Schema.makeFilter((value) => value >= 0, { expected: 'non-negative integer' }),
);

export type DiagnosticTarget =
  | {
      readonly kind: 'pull-request';
      readonly owner: string;
      readonly repository: string;
      readonly number: number;
    }
  | { readonly kind: 'delivery'; readonly id: string }
  | { readonly kind: 'run'; readonly id: string }
  | { readonly kind: 'identifier'; readonly id: string };

export interface DiagnosticEvidenceMetadata {
  readonly key: string;
  readonly status: 'complete' | 'incomplete';
  readonly size: number;
  readonly sha256: string;
  readonly uploadedAt: string;
  readonly executionStartedAt?: string;
  readonly submissionCompletedAt?: string;
  readonly cleanupCompletedAt?: string;
}

export interface DiagnosticD1Snapshot {
  readonly delivery?: {
    readonly deliveryId: string;
    readonly repositoryId: number;
    readonly pullRequestNumber: number;
    readonly baseSha: string | null;
    readonly headSha: string | null;
    readonly trigger: string;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly run?: {
    readonly runId: string;
    readonly status: string;
    readonly runnerJobId?: string;
    readonly runnerAttempt?: number;
    readonly commentId?: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly evidence?: DiagnosticEvidenceMetadata;
  };
}

export interface DiagnosticGitHubSnapshot {
  readonly repository: { readonly owner: string; readonly name: string; readonly id: number };
  readonly pullRequest: {
    readonly state: string;
    readonly baseSha: string;
    readonly headSha: string;
  };
  readonly trigger?: { readonly kind: string; readonly commentId?: number };
  readonly reactions: ReadonlyArray<{ readonly content: string; readonly count?: number }>;
  readonly reviews: ReadonlyArray<{
    readonly id: number;
    readonly state: string;
    readonly commitSha?: string;
    readonly submittedAt?: string;
    readonly url?: string;
  }>;
}

export interface DiagnosticR2Snapshot {
  readonly key: string;
  readonly rawSize: number;
  readonly rawSha256: string;
  readonly object: unknown;
}

export interface DiagnosticCommandAdapter {
  run(
    command: string,
    args: readonly string[],
  ): Promise<{ readonly stdout: string; readonly exitCode: number }>;
}

export interface DiagnosticSources {
  readonly d1: {
    find(
      target: DiagnosticTarget,
      context?: { readonly repositoryId?: number },
    ): Promise<DiagnosticD1Snapshot | undefined>;
  };
  readonly github: {
    find(input: {
      readonly target: DiagnosticTarget;
      readonly repositoryId?: number;
      readonly pullRequestNumber?: number;
      readonly commentId?: number;
      readonly triggerKind?: string;
    }): Promise<DiagnosticGitHubSnapshot | undefined>;
  };
  readonly r2: { get(key: string): Promise<DiagnosticR2Snapshot | undefined> };
}

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S['Type'] | undefined => {
  const decoded = Schema.decodeUnknownOption(schema)(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const targetFromArgument = (argument: string): DiagnosticTarget | undefined => {
  try {
    const url = new URL(argument);
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url.pathname);
    if (url.hostname === 'github.com' && match !== null) {
      const number = Number(match[3]);
      return decode(
        Schema.Struct({
          kind: Schema.Literal('pull-request'),
          owner: Identifier,
          repository: Identifier,
          number: Schema.Int,
        }),
        { kind: 'pull-request', owner: match[1], repository: match[2], number },
      );
    }
  } catch {
    // The remaining forms are identifiers.
  }
  const prefix =
    argument.startsWith('run:') || argument.startsWith('delivery:')
      ? argument.slice(argument.indexOf(':') + 1)
      : argument;
  if (prefix.length === 0) return undefined;
  return argument.startsWith('run:') || argument.startsWith('run-')
    ? { kind: 'run', id: prefix }
    : argument.startsWith('delivery:')
      ? { kind: 'delivery', id: prefix }
      : { kind: 'identifier', id: prefix };
};

const reportField = (
  field:
    | {
        readonly content: string;
        readonly size: number;
        readonly sha256: string;
        readonly truncated?: boolean;
      }
    | undefined,
) =>
  field === undefined
    ? { present: false }
    : {
        present: true,
        size: field.size,
        sha256: field.sha256,
        ...(field.truncated === true ? { truncated: true } : {}),
      };

const EvidenceField = Schema.Struct({
  content: Schema.String,
  size: NonNegativeInt,
  sha256: Sha256,
  truncated: Schema.optionalKey(Schema.Boolean),
});
const R2Snapshot = Schema.Struct({
  key: Identifier,
  rawSize: NonNegativeInt,
  rawSha256: Sha256,
  object: Schema.Unknown,
});
const ArchiveEvidence = Schema.Struct({
  id: Identifier,
  status: Schema.Literals(['complete', 'incomplete']),
  manifest: EvidenceField,
  opencodeJsonl: EvidenceField,
  opencodeStderr: EvidenceField,
  validatedReview: Schema.optional(EvidenceField),
  opencodeSessionList: Schema.optional(EvidenceField),
  opencodeExport: Schema.optional(Schema.Struct({ sessionId: Identifier, content: EvidenceField })),
});
const R2ObjectV1 = Schema.Struct({
  version: Schema.Literal(1),
  runId: Identifier,
  jobId: Identifier,
  evidenceId: Identifier,
  evidence: ArchiveEvidence,
});
const R2ObjectV2 = Schema.Struct({
  version: Schema.Literal(2),
  runId: Identifier,
  jobId: Identifier,
  attempt: Schema.Int,
  evidenceId: Identifier,
  evidence: ArchiveEvidence,
  timestamps: Schema.optional(Schema.Unknown),
});
const R2Object = Schema.Union([R2ObjectV1, R2ObjectV2]);

const RunnerManifest = Schema.Struct({
  jobId: Identifier,
  runId: Identifier,
  attempt: Schema.Int,
  evidenceId: Identifier,
  sandboxName: Identifier,
  sandboxId: Identifier,
  sessionIds: Schema.Array(Identifier),
  terminal: Schema.Struct({
    status: Schema.Literals(['succeeded', 'failed', 'aborted']),
    reason: Schema.optional(Schema.String),
  }),
  evidence: Schema.Struct({
    id: Identifier,
    status: Schema.Literals(['complete', 'incomplete']),
  }),
  complete: Schema.Boolean,
  cleanup: Schema.Struct({ status: Schema.Literals(['destroyed', 'failed']) }),
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
});
const SessionList = Schema.Union([
  Schema.Array(Schema.Struct({ id: Identifier })),
  Schema.Struct({ sessions: Schema.Array(Schema.Struct({ id: Identifier })) }),
]);
const SessionExport = Schema.Struct({
  info: Schema.Struct({ id: Identifier }),
  messages: Schema.Array(Schema.Unknown),
});
const Timestamp = Schema.Union([Schema.String, Schema.Number]);
const TimeBounds = Schema.Union([
  Timestamp,
  Schema.Struct({
    created: Schema.optional(Timestamp),
    completed: Schema.optional(Timestamp),
    start: Schema.optional(Timestamp),
    end: Schema.optional(Timestamp),
  }),
]);
const MessageMetadata = Schema.Struct({
  info: Schema.optional(Schema.Struct({ time: Schema.optional(TimeBounds) })),
  time: Schema.optional(TimeBounds),
});

const decodeArtifact = (content: string) => decode(Schema.Uint8ArrayFromBase64, content);

const sha256Hex = async (bytes: Uint8Array) => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const decodeJsonArtifact = <S extends Schema.ConstraintDecoder<unknown>>(
  artifact: typeof EvidenceField.Type,
  schema: S,
) => {
  const bytes = decodeArtifact(artifact.content);
  return bytes === undefined
    ? undefined
    : decode(Schema.fromJsonString(schema), new TextDecoder().decode(bytes));
};

const r2Evidence = (value: unknown) => decode(R2Object, value);

const timestamp = (value: unknown): string | undefined => {
  const parsed =
    typeof value === 'number'
      ? DateTime.make(value)
      : typeof value === 'string'
        ? DateTime.make(value)
        : undefined;
  return parsed !== undefined && Option.isSome(parsed)
    ? DateTime.formatIso(parsed.value)
    : undefined;
};

const validatedEvidence = async (value: typeof R2Object.Type) => {
  // Historical and uploaded archives are read for diagnosis. Per-file hashes
  // are retained metadata, not a read gate: a truncated or unreadable artifact
  // is shown as retained metadata while every readable material stays visible.
  // Identity and D1/R2 hash correlation below remain the read gate.
  const manifest = decodeJsonArtifact(value.evidence.manifest, RunnerManifest);
  if (manifest === undefined) return undefined;
  const sessionList =
    value.evidence.opencodeSessionList === undefined
      ? undefined
      : decodeJsonArtifact(value.evidence.opencodeSessionList, SessionList);
  const sessionExport =
    value.evidence.opencodeExport === undefined
      ? undefined
      : decodeJsonArtifact(value.evidence.opencodeExport.content, SessionExport);
  const readableSessionIds =
    sessionList === undefined
      ? undefined
      : Array.isArray(sessionList)
        ? sessionList.map((session) => session.id)
        : 'sessions' in sessionList
          ? sessionList.sessions.map((session) => session.id)
          : [];
  // A readable session list must match the manifest exactly. When it is
  // truncated or unreadable, the manifest remains the authoritative list and
  // no session metrics are inferred from partial JSON.
  if (
    readableSessionIds !== undefined &&
    (manifest.sessionIds.length !== readableSessionIds.length ||
      manifest.sessionIds.some((id, index) => id !== readableSessionIds[index]))
  ) {
    return undefined;
  }
  const sessionIds = readableSessionIds ?? manifest.sessionIds;
  // If an export is readable, its session identity must agree with the
  // envelope and the manifest. An unreadable/truncated export is retained as a
  // missing diagnostic instead of invalidating the rest of the archive.
  if (
    value.evidence.opencodeExport !== undefined &&
    sessionExport === undefined &&
    !sessionIds.includes(value.evidence.opencodeExport.sessionId)
  ) {
    return undefined;
  }
  if (
    sessionExport !== undefined &&
    (sessionExport.info.id !== value.evidence.opencodeExport?.sessionId ||
      !sessionIds.includes(sessionExport.info.id))
  ) {
    return undefined;
  }
  if (
    manifest.jobId !== value.jobId ||
    manifest.runId !== value.runId ||
    manifest.evidenceId !== value.evidenceId ||
    value.evidenceId !== value.evidence.id ||
    manifest.evidence.id !== value.evidence.id ||
    manifest.evidence.status !== value.evidence.status
  ) {
    return undefined;
  }
  return {
    value,
    manifest,
    sessionIds,
    sessionExport,
    readable: {
      manifest: true,
      sessionList: sessionList !== undefined,
      sessionExport: sessionExport !== undefined,
      validatedReview: value.evidence.validatedReview !== undefined,
    },
  };
};

const correlateEvidence = async (
  run: NonNullable<DiagnosticD1Snapshot['run']>,
  get: (key: string) => Promise<DiagnosticR2Snapshot | undefined>,
) => {
  const d1Evidence = run.evidence;
  if (d1Evidence === undefined || run.runnerJobId === undefined) return undefined;
  const snapshot = await get(d1Evidence.key);
  const decodedSnapshot = snapshot === undefined ? undefined : decode(R2Snapshot, snapshot);
  if (decodedSnapshot === undefined) return undefined;
  const value = r2Evidence(decodedSnapshot.object);
  if (value === undefined) return undefined;
  if (
    d1Evidence.key !== decodedSnapshot.key ||
    d1Evidence.size !== decodedSnapshot.rawSize ||
    d1Evidence.sha256.toLowerCase() !== decodedSnapshot.rawSha256.toLowerCase() ||
    value.runId !== run.runId ||
    value.jobId !== run.runnerJobId ||
    (value.version === 2 && value.attempt !== run.runnerAttempt)
  ) {
    return undefined;
  }
  const details = await validatedEvidence(value);
  return details === undefined ? undefined : { snapshot: decodedSnapshot, details };
};

export const runDiagnostic = async (argument: string, sources: DiagnosticSources) => {
  const target = targetFromArgument(argument);
  if (target === undefined) throw new Error('Expected a GitHub PR URL, delivery ID, or run ID');
  const unavailable = new Set<'d1' | 'github' | 'r2'>();
  const findGithub = () =>
    sources.github.find({
      target,
      repositoryId: d1?.delivery?.repositoryId,
      pullRequestNumber: d1?.delivery?.pullRequestNumber,
      commentId: d1?.run?.commentId,
      triggerKind: d1?.delivery?.trigger,
    });
  let d1: DiagnosticD1Snapshot | undefined;
  let github: DiagnosticGitHubSnapshot | undefined;
  try {
    d1 = await sources.d1.find(target);
  } catch {
    d1 = undefined;
  }
  try {
    github = await findGithub();
  } catch {
    github = undefined;
  }
  if (github === undefined && d1?.delivery !== undefined) {
    try {
      github = await findGithub();
    } catch {
      github = undefined;
    }
  }
  if (d1 === undefined && target.kind === 'pull-request' && github !== undefined) {
    try {
      d1 = await sources.d1.find(target, { repositoryId: github.repository.id });
    } catch {
      d1 = undefined;
    }
    if (d1 !== undefined) {
      try {
        const enriched = await findGithub();
        if (enriched !== undefined) github = enriched;
      } catch {
        // Keep the first GitHub snapshot when enrichment is unavailable.
      }
    }
  }
  if (d1 === undefined) unavailable.add('d1');
  if (github === undefined) unavailable.add('github');

  const run = d1?.run;
  const evidenceKey = run?.evidence?.key;
  let correlated: Awaited<ReturnType<typeof correlateEvidence>>;
  if (evidenceKey === undefined || run === undefined) {
    unavailable.add('r2');
  } else {
    try {
      correlated = await correlateEvidence(run, (key) => sources.r2.get(key));
    } catch {
      correlated = undefined;
    }
    if (correlated === undefined) unavailable.add('r2');
  }

  const evidence = correlated?.details.value.evidence;
  const manifest = correlated?.details.manifest;
  const exportTimestamps =
    correlated?.details.sessionExport?.messages.flatMap((message) => {
      const metadata = decode(MessageMetadata, message);
      const messageTime = metadata?.info?.time ?? metadata?.time;
      if (messageTime === undefined) return [];
      if (typeof messageTime === 'object' && messageTime !== null) {
        return [
          timestamp(messageTime.created),
          timestamp(messageTime.completed),
          timestamp(messageTime.end),
        ].filter((at): at is string => at !== undefined);
      }
      return [timestamp(messageTime)].filter((at): at is string => at !== undefined);
    }) ?? [];
  const runner =
    run === undefined
      ? undefined
      : {
          jobId: run.runnerJobId ?? correlated?.details.value.jobId,
          attempt: run.runnerAttempt ?? manifest?.attempt,
          stage: manifest === undefined ? undefined : 'cleanup',
          sandboxName: manifest?.sandboxName,
          sandboxId: manifest?.sandboxId,
          terminal: manifest?.terminal.status,
          failure: manifest?.terminal.reason,
          evidence: manifest?.evidence.status ?? evidence?.status,
          cleanup: manifest?.cleanup.status,
        };
  const timeline = [
    run?.createdAt === undefined
      ? undefined
      : { at: run.createdAt, source: 'd1', event: 'run scheduled' },
    (run?.evidence?.executionStartedAt ?? manifest?.startedAt) === undefined
      ? undefined
      : {
          at: run?.evidence?.executionStartedAt ?? manifest!.startedAt!,
          source: 'runner',
          event: 'execution started',
        },
    run?.evidence?.submissionCompletedAt === undefined
      ? undefined
      : {
          at: run.evidence.submissionCompletedAt,
          source: 'runner',
          event: 'review submitted',
        },
    run?.evidence?.cleanupCompletedAt === undefined
      ? manifest?.finishedAt === undefined
        ? undefined
        : { at: manifest.finishedAt, source: 'runner', event: 'cleanup completed' }
      : { at: run.evidence.cleanupCompletedAt, source: 'runner', event: 'cleanup completed' },
    run?.evidence?.uploadedAt === undefined
      ? undefined
      : { at: run.evidence.uploadedAt, source: 'r2', event: 'evidence uploaded' },
    ...exportTimestamps.map((at) => ({ at, source: 'runner', event: 'session event' })),
  ]
    .filter((event): event is { at: string; source: string; event: string } => event !== undefined)
    .sort((a, b) => a.at.localeCompare(b.at));
  const firstFailureBoundary = [
    runner?.terminal !== 'failed'
      ? undefined
      : {
          source: 'runner',
          at: manifest?.finishedAt,
          reason: runner.failure ?? 'Runner Job failed',
        },
    run?.status !== 'failed'
      ? undefined
      : { source: 'd1', at: run.updatedAt, reason: 'run failed' },
    evidence?.status !== 'incomplete'
      ? undefined
      : {
          source: 'r2',
          at: run?.evidence?.uploadedAt,
          reason: 'evidence incomplete',
        },
  ]
    .filter(
      (candidate): candidate is { source: string; at: string | undefined; reason: string } =>
        candidate !== undefined,
    )
    .sort((left, right) => (left.at ?? '\uffff').localeCompare(right.at ?? '\uffff'))[0];
  return {
    target,
    github:
      github === undefined
        ? { available: false }
        : {
            available: true,
            repository: github.repository,
            ...github.pullRequest,
            trigger: github.trigger,
            reactions: github.reactions,
            reviews: github.reviews,
          },
    d1:
      d1?.delivery === undefined || run === undefined
        ? { available: false }
        : { available: true, delivery: d1.delivery, run },
    runner: runner ?? { available: false },
    evidence:
      evidence === undefined || correlated === undefined || run?.evidence === undefined
        ? { available: false }
        : {
            available: true,
            key: run.evidence.key,
            status: evidence.status,
            evidenceId: evidence.id,
            sessionId: evidence.opencodeExport?.sessionId,
            sessionIds: correlated.details.sessionIds,
            readable: correlated.details.readable,
            timestamps: {
              executionStartedAt: manifest?.startedAt,
              submissionCompletedAt: run.evidence.submissionCompletedAt,
              terminalAt: exportTimestamps.at(-1),
              cleanupCompletedAt: run.evidence.cleanupCompletedAt ?? manifest?.finishedAt,
            },
            files: {
              manifest: reportField(evidence.manifest),
              opencodeJsonl: reportField(evidence.opencodeJsonl),
              opencodeStderr: reportField(evidence.opencodeStderr),
              validatedReview: reportField(evidence.validatedReview),
              opencodeSessionList: reportField(evidence.opencodeSessionList),
              opencodeExport: reportField(evidence.opencodeExport?.content),
            },
            output: reportField(evidence.validatedReview),
            stderr: {
              ...reportField(evidence.opencodeStderr),
              bounded: evidence.opencodeStderr.size <= STDERR_BOUND_BYTES,
            },
          },
    timeline,
    firstFailureBoundary: firstFailureBoundary ?? null,
    missingSources: [...unavailable],
    fallback:
      firstFailureBoundary?.source === 'runner' || firstFailureBoundary?.source === 'r2'
        ? 'SSH only if the Runner host is lost or cleanup failure requires host recovery.'
        : null,
  };
};

const commandAdapter: DiagnosticCommandAdapter = {
  run: async (command, args) => {
    try {
      const stdout = execFileSync(command, [...args], {
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 40 * 1024 * 1024,
      });
      return { stdout, exitCode: 0 };
    } catch (error) {
      const value = error as { stdout?: string | Buffer };
      return {
        stdout: typeof value.stdout === 'string' ? value.stdout : (value.stdout?.toString() ?? ''),
        exitCode: 1,
      };
    }
  },
};

const jsonCommand = async <S extends Schema.ConstraintDecoder<unknown>>(
  command: DiagnosticCommandAdapter,
  executable: string,
  args: readonly string[],
  schema: S,
) => {
  const result = await command.run(executable, args);
  if (result.exitCode !== 0) return undefined;
  try {
    return decode(schema, JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
};

const NullableString = Schema.Union([Schema.String, Schema.Null]);
const D1Row = Schema.Struct({
  delivery_id: Schema.String,
  repository_id: Schema.Int,
  pull_request_number: Schema.Int,
  base_sha: NullableString,
  head_sha: NullableString,
  trigger: Schema.String,
  status: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  run_id: Schema.String,
  run_status: Schema.String,
  run_created_at: Schema.String,
  run_updated_at: Schema.String,
  runner_job_id: Schema.Union([Schema.String, Schema.Null]),
  runner_attempt: Schema.Union([Schema.Int, Schema.Null]),
  comment_id: Schema.Union([Schema.Int, Schema.Null]),
  evidence_key: Schema.Union([Schema.String, Schema.Null]),
  evidence_status: Schema.Union([Schema.String, Schema.Null]),
  evidence_size: Schema.Union([NonNegativeInt, Schema.Null]),
  evidence_sha256: Schema.Union([Sha256, Schema.Null]),
  evidence_uploaded_at: Schema.Union([Schema.String, Schema.Null]),
  execution_started_at: Schema.Union([Schema.String, Schema.Null]),
  submission_completed_at: Schema.Union([Schema.String, Schema.Null]),
  cleanup_completed_at: Schema.Union([Schema.String, Schema.Null]),
});
const D1Json = Schema.Array(Schema.Struct({ results: Schema.Array(D1Row) }));
const RepositoryJson = Schema.Struct({ full_name: Schema.String, id: Schema.Int });
const PullRequestJson = Schema.Struct({
  state: Schema.String,
  base: Schema.Struct({ sha: Schema.String }),
  head: Schema.Struct({ sha: Schema.String }),
});
const CommentJson = Schema.Struct({
  id: Schema.optional(Schema.Int),
  body: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  reactions: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
  ),
});
const ReviewJson = Schema.Struct({
  id: Schema.Int,
  state: Schema.String,
  commit_id: Schema.optional(Schema.String),
  submitted_at: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
});

const paginatedJsonCommand = async <S extends Schema.ConstraintDecoder<unknown>>(
  command: DiagnosticCommandAdapter,
  executable: string,
  args: readonly string[],
  schema: S,
) => {
  const pages = await jsonCommand(
    command,
    executable,
    [...args, '--paginate', '--slurp'],
    Schema.Array(schema),
  );
  return pages?.flat();
};

const workspaceWrangler = (...args: readonly string[]) => [
  'pnpm',
  '--filter',
  '@compte-rendu/dashboard',
  'exec',
  'wrangler',
  ...args,
];

export interface DiagnosticConfig {
  readonly database: string;
  readonly bucket: string;
  readonly wranglerConfig: string;
}

// `pnpm --filter ... exec` changes Wrangler's working directory to the
// dashboard workspace. Resolve the operator's path before dispatch so a path
// relative to the caller (typically the repository root) still points at the
// intended file.
const diagnosticConfigPath = (path: string) => (path.length === 0 ? '' : resolve(path));

export const createDefaultDiagnosticSources = (
  command: DiagnosticCommandAdapter = commandAdapter,
  config: DiagnosticConfig = {
    database: process.env.DIAGNOSTIC_D1_DATABASE ?? '',
    bucket: process.env.DIAGNOSTIC_R2_BUCKET ?? '',
    wranglerConfig: process.env.DIAGNOSTIC_WRANGLER_CONFIG ?? '',
  },
): DiagnosticSources => ({
  d1: {
    find: async (target, context) => {
      const wranglerConfig = diagnosticConfigPath(config.wranglerConfig);
      if (config.database.length === 0 || wranglerConfig.length === 0) return undefined;
      const value =
        target.kind === 'run'
          ? `r.run_id = '${target.id.replaceAll("'", "''")}'`
          : target.kind === 'delivery'
            ? `d.delivery_id = '${target.id.replaceAll("'", "''")}'`
            : target.kind === 'identifier'
              ? `r.run_id = '${target.id.replaceAll("'", "''")}' OR d.delivery_id = '${target.id.replaceAll("'", "''")}'`
              : context?.repositoryId === undefined
                ? '1 = 0'
                : `r.repository_id = ${context.repositoryId} AND r.pull_request_number = ${target.number}`;
      const rows = await jsonCommand(
        command,
        'corepack',
        workspaceWrangler(
          'd1',
          'execute',
          config.database,
          '--remote',
          '--config',
          wranglerConfig,
          '--json',
          '--command',
          `SELECT d.*, r.run_id, r.status AS run_status, r.created_at AS run_created_at, r.updated_at AS run_updated_at, r.runner_job_id, r.runner_attempt, r.comment_id, r.evidence_key, r.evidence_status, r.evidence_size, r.evidence_sha256, r.evidence_uploaded_at, r.execution_started_at, r.submission_completed_at, r.cleanup_completed_at FROM review_runs r JOIN deliveries d ON d.delivery_id = r.delivery_id WHERE ${value} ORDER BY r.updated_at DESC LIMIT 1`,
        ),
        D1Json,
      );
      const row = rows?.[0]?.results[0];
      if (row === undefined) return undefined;
      const text = (value: string | null) => (value === null ? undefined : value);
      const deliveryId = row.delivery_id;
      const runId = row.run_id;
      return {
        delivery: {
          deliveryId,
          repositoryId: row.repository_id,
          pullRequestNumber: row.pull_request_number,
          baseSha: row.base_sha,
          headSha: row.head_sha,
          trigger: row.trigger,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        run: {
          runId,
          status: row.run_status,
          runnerJobId: text(row.runner_job_id),
          runnerAttempt: row.runner_attempt === null ? undefined : row.runner_attempt,
          commentId: row.comment_id === null ? undefined : row.comment_id,
          createdAt: row.run_created_at,
          updatedAt: row.run_updated_at,
          evidence:
            row.evidence_key === null
              ? undefined
              : {
                  key: row.evidence_key,
                  status: row.evidence_status === 'complete' ? 'complete' : 'incomplete',
                  size: row.evidence_size ?? 0,
                  sha256: row.evidence_sha256 ?? '',
                  uploadedAt: row.evidence_uploaded_at ?? '',
                  executionStartedAt: text(row.execution_started_at),
                  submissionCompletedAt: text(row.submission_completed_at),
                  cleanupCompletedAt: text(row.cleanup_completed_at),
                },
        },
      };
    },
  },
  github: {
    find: async ({ target, repositoryId, pullRequestNumber, commentId, triggerKind }) => {
      const repo =
        target.kind === 'pull-request' ? `${target.owner}/${target.repository}` : undefined;
      const repository =
        repo === undefined
          ? await jsonCommand(
              command,
              'gh',
              ['api', `repositories/${repositoryId ?? 0}`],
              RepositoryJson,
            )
          : await jsonCommand(command, 'gh', ['api', `repos/${repo}`], RepositoryJson);
      if (repository === undefined) return undefined;
      const [owner, name] = repository.full_name.split('/');
      const number = target.kind === 'pull-request' ? target.number : pullRequestNumber;
      if (owner === undefined || name === undefined || number === undefined) return undefined;
      const pull = await jsonCommand(
        command,
        'gh',
        ['api', `repos/${owner}/${name}/pulls/${number}`],
        PullRequestJson,
      );
      const comments = await paginatedJsonCommand(
        command,
        'gh',
        ['api', `repos/${owner}/${name}/issues/${number}/comments`],
        Schema.Array(CommentJson),
      );
      const reviews = await paginatedJsonCommand(
        command,
        'gh',
        ['api', `repos/${owner}/${name}/pulls/${number}/reviews`],
        Schema.Array(ReviewJson),
      );
      if (pull === undefined) return undefined;
      const commentList = comments ?? [];
      const exactComments = commentList.filter(
        (comment) => typeof comment.body === 'string' && comment.body.trim() === '/ai-review',
      );
      const commandComment =
        commentId !== undefined
          ? commentList.find((comment) => comment.id === commentId)
          : triggerKind === 'automatic'
            ? undefined
            : [...exactComments]
                .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
                .at(-1);
      const reactions =
        commandComment?.reactions === undefined
          ? []
          : Object.entries(commandComment.reactions)
              .filter(
                (entry): entry is [string, number] =>
                  entry[0] !== 'url' &&
                  entry[0] !== 'total_count' &&
                  typeof entry[1] === 'number' &&
                  entry[1] > 0,
              )
              .map(([content, count]) => ({ content, count }));
      return {
        repository: { owner, name, id: repository.id },
        pullRequest: { state: pull.state, baseSha: pull.base.sha, headSha: pull.head.sha },
        trigger:
          commandComment === undefined && triggerKind === undefined
            ? undefined
            : {
                kind: triggerKind ?? 'manual',
                commentId: typeof commandComment?.id === 'number' ? commandComment.id : undefined,
              },
        reactions,
        reviews: (reviews ?? []).map((review) => ({
          id: review.id,
          state: review.state,
          commitSha: review.commit_id,
          submittedAt: review.submitted_at,
          url: review.html_url,
        })),
      };
    },
  },
  r2: {
    get: async (key) => {
      const wranglerConfig = diagnosticConfigPath(config.wranglerConfig);
      if (config.bucket.length === 0 || wranglerConfig.length === 0) return undefined;
      const result = await command.run(
        'corepack',
        workspaceWrangler(
          'r2',
          'object',
          'get',
          `${config.bucket}/${key}`,
          '--pipe',
          '--remote',
          '--config',
          wranglerConfig,
        ),
      );
      if (result.exitCode !== 0) return undefined;
      const bytes = new TextEncoder().encode(result.stdout);
      let object: typeof R2Object.Type | undefined;
      try {
        object = r2Evidence(JSON.parse(result.stdout));
      } catch {
        object = undefined;
      }
      return object === undefined
        ? undefined
        : { key, rawSize: bytes.byteLength, rawSha256: await sha256Hex(bytes), object };
    },
  },
});

export const runDiagnosticCommand = async (
  args: readonly string[],
  sources = createDefaultDiagnosticSources(),
) => {
  if (args.length !== 1) throw new Error('Usage: pnpm diagnose <PR URL|delivery ID|run ID>');
  return JSON.stringify(await runDiagnostic(args[0]!, sources), null, 2) + '\n';
};

const cliProcess = process as typeof process & {
  readonly stdout: { write(value: string): void };
  readonly stderr: { write(value: string): void };
  exitCode?: number;
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  runDiagnosticCommand(process.argv.slice(2))
    .then((output) => cliProcess.stdout.write(output))
    .catch((error) => {
      cliProcess.stderr.write(`${error instanceof Error ? error.message : 'diagnostics failed'}\n`);
      cliProcess.exitCode = 1;
    });
}

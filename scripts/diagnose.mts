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
  readonly object: unknown;
}

export interface DiagnosticWorkflowEvent {
  readonly at: string;
  readonly type: string;
  readonly status?: string;
  readonly reason?: string;
}

export interface DiagnosticWorkflowSnapshot {
  readonly id: string;
  readonly events: ReadonlyArray<DiagnosticWorkflowEvent>;
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
    }): Promise<DiagnosticGitHubSnapshot | undefined>;
  };
  readonly r2: { get(key: string): Promise<DiagnosticR2Snapshot | undefined> };
  readonly workflow?: {
    find(
      target: DiagnosticTarget,
      context?: { readonly runId?: string },
    ): Promise<DiagnosticWorkflowSnapshot | undefined>;
  };
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
  field: { readonly content: string; readonly size: number; readonly sha256: string } | undefined,
) =>
  field === undefined
    ? { present: false }
    : {
        present: true,
        size: field.size,
        sha256: field.sha256,
      };

const EvidenceField = Schema.Struct({
  content: Schema.String,
  size: NonNegativeInt,
  sha256: Sha256,
});
const IncompleteEvidence = Schema.Struct({
  id: Identifier,
  status: Schema.Literal('incomplete'),
  manifest: EvidenceField,
  opencodeJsonl: EvidenceField,
  opencodeStderr: EvidenceField,
  validatedReview: Schema.optional(EvidenceField),
  opencodeSessionList: Schema.optional(EvidenceField),
  opencodeExport: Schema.optional(Schema.Struct({ sessionId: Identifier, content: EvidenceField })),
});
const CompleteEvidence = Schema.Struct({
  id: Identifier,
  status: Schema.Literal('complete'),
  manifest: EvidenceField,
  opencodeJsonl: EvidenceField,
  opencodeStderr: EvidenceField,
  validatedReview: EvidenceField,
  opencodeSessionList: EvidenceField,
  opencodeExport: Schema.Struct({ sessionId: Identifier, content: EvidenceField }),
});
const R2Object = Schema.Struct({
  version: Schema.Literal(1),
  runId: Identifier,
  jobId: Identifier,
  evidenceId: Identifier,
  evidence: Schema.Union([CompleteEvidence, IncompleteEvidence]),
});

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
const WorkflowEvent = Schema.Struct({
  at: Schema.String,
  type: Schema.String,
  status: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
const WorkflowSnapshot = Schema.Struct({ id: Identifier, events: Schema.Array(WorkflowEvent) });
const WorkflowTableDate = Schema.String.check(
  Schema.isPattern(/^\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M$/),
);
const SessionList = Schema.Union([
  Schema.Array(Schema.Struct({ id: Identifier })),
  Schema.Struct({ sessions: Schema.Array(Schema.Struct({ id: Identifier })) }),
]);
const SessionExport = Schema.Struct({
  info: Schema.Struct({ id: Identifier }),
  messages: Schema.Array(Schema.Unknown),
});
const Timestamp = Schema.Union([Schema.String, Schema.Number]);
const ToolTime = Schema.Union([
  Timestamp,
  Schema.Struct({ start: Schema.optional(Timestamp), end: Schema.optional(Timestamp) }),
]);
const SubmitReviewEvent = Schema.Struct({
  type: Schema.Literal('tool_use'),
  part: Schema.Struct({
    type: Schema.Literal('tool'),
    tool: Schema.Literal('submit_review'),
    state: Schema.Struct({
      status: Schema.Literal('completed'),
      time: Schema.optional(ToolTime),
    }),
  }),
});

type EvidenceFieldValue = typeof EvidenceField.Type;
type R2Value = typeof R2Object.Type;

const decodeArtifact = (content: string) => decode(Schema.Uint8ArrayFromBase64, content);

const artifactMatchesMetadata = async (artifact: EvidenceFieldValue) => {
  const bytes = decodeArtifact(artifact.content);
  if (bytes === undefined || bytes.byteLength !== artifact.size) return false;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return sha256 === artifact.sha256.toLowerCase();
};

const decodeJsonArtifact = <S extends Schema.ConstraintDecoder<unknown>>(
  artifact: EvidenceFieldValue,
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

const timestampFromToolTime = (value: unknown) =>
  typeof value === 'object' && value !== null && 'end' in value
    ? timestamp(value.end)
    : timestamp(value);

const workflowTableTimestamp = (value: string) => {
  const valid = decode(WorkflowTableDate, value);
  if (valid === undefined) return undefined;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/.exec(valid);
  if (match === null) return undefined;
  const hour = (Number(match[4]) % 12) + (match[7] === 'PM' ? 12 : 0);
  return timestamp(
    `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}T${hour
      .toString()
      .padStart(2, '0')}:${match[5]}:${match[6]}Z`,
  );
};

const workflowText = (output: string, runId: string): DiagnosticWorkflowSnapshot | undefined => {
  const stepEnd =
    /Name\s*:\s*review-1[\s\S]*?\bEnd\s*:?\s*([0-9]{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M)/i.exec(
      output,
    );
  const failure = /WorkflowInternalError:\s*([^\r\n|│]+)/i.exec(output);
  if (stepEnd === null || failure === null) return undefined;
  const at = workflowTableTimestamp(stepEnd[1].trim());
  const reason = failure[1].trim();
  if (at === undefined || reason.length === 0) return undefined;
  return { id: runId, events: [{ at, type: 'WorkflowInternalError', status: 'failed', reason }] };
};

const validatedEvidence = async (value: R2Value) => {
  const fields: EvidenceFieldValue[] = [
    value.evidence.manifest,
    value.evidence.opencodeJsonl,
    value.evidence.opencodeStderr,
  ];
  if (value.evidence.validatedReview !== undefined) fields.push(value.evidence.validatedReview);
  if (value.evidence.opencodeSessionList !== undefined)
    fields.push(value.evidence.opencodeSessionList);
  if (value.evidence.opencodeExport !== undefined)
    fields.push(value.evidence.opencodeExport.content);
  if (
    !(await Promise.all(fields.map(artifactMatchesMetadata)).then((results) =>
      results.every(Boolean),
    ))
  )
    return undefined;
  const manifest = decodeJsonArtifact(value.evidence.manifest, RunnerManifest);
  const sessionList =
    value.evidence.opencodeSessionList === undefined
      ? undefined
      : decodeJsonArtifact(value.evidence.opencodeSessionList, SessionList);
  const sessionExport =
    value.evidence.opencodeExport === undefined
      ? undefined
      : decodeJsonArtifact(value.evidence.opencodeExport.content, SessionExport);
  const sessionIds =
    sessionList === undefined
      ? []
      : Array.isArray(sessionList)
        ? sessionList.map((session) => session.id)
        : 'sessions' in sessionList
          ? sessionList.sessions.map((session) => session.id)
          : [];
  if (
    manifest === undefined ||
    (value.evidence.status === 'complete' &&
      (sessionList === undefined ||
        sessionExport === undefined ||
        value.evidence.validatedReview === undefined))
  )
    return undefined;
  if (
    manifest.jobId !== value.jobId ||
    manifest.runId !== value.runId ||
    manifest.evidenceId !== value.evidenceId ||
    manifest.evidence.id !== value.evidence.id ||
    manifest.evidence.status !== value.evidence.status ||
    manifest.sessionIds.length !== sessionIds.length ||
    manifest.sessionIds.some((id, index) => id !== sessionIds[index]) ||
    (value.evidence.status === 'complete' &&
      (sessionIds.length === 0 ||
        value.evidence.opencodeExport === undefined ||
        sessionExport?.info.id !== value.evidence.opencodeExport.sessionId ||
        value.evidence.validatedReview.content.length === 0))
  )
    return undefined;
  const submissionCompletedAt = (() => {
    const bytes = decodeArtifact(value.evidence.opencodeJsonl.content);
    if (bytes === undefined) return undefined;
    return new TextDecoder()
      .decode(bytes)
      .split('\n')
      .flatMap((line) => {
        try {
          const event = decode(SubmitReviewEvent, JSON.parse(line));
          return event?.part.state.time === undefined
            ? []
            : [timestampFromToolTime(event.part.state.time)];
        } catch {
          return [];
        }
      })
      .find((at): at is string => at !== undefined);
  })();
  return { value, manifest, sessionIds, sessionExport, submissionCompletedAt };
};

export const runDiagnostic = async (argument: string, sources: DiagnosticSources) => {
  const target = targetFromArgument(argument);
  if (target === undefined) throw new Error('Expected a GitHub PR URL, delivery ID, or run ID');
  const missingSources: string[] = [];
  let d1: DiagnosticD1Snapshot | undefined;
  let github: DiagnosticGitHubSnapshot | undefined;
  let r2: R2Value | undefined;
  let evidenceDetails: Awaited<ReturnType<typeof validatedEvidence>>;
  let workflow: DiagnosticWorkflowSnapshot | undefined;
  try {
    d1 = await sources.d1.find(target);
  } catch {
    missingSources.push('d1');
  }
  try {
    github = await sources.github.find({
      target,
      repositoryId: d1?.delivery?.repositoryId,
      pullRequestNumber: d1?.delivery?.pullRequestNumber,
    });
  } catch {
    missingSources.push('github');
  }
  if (github === undefined && d1?.delivery !== undefined) {
    try {
      github = await sources.github.find({
        target,
        repositoryId: d1.delivery.repositoryId,
        pullRequestNumber: d1.delivery.pullRequestNumber,
      });
    } catch {
      if (!missingSources.includes('github')) missingSources.push('github');
    }
  }
  if (d1 === undefined && github !== undefined && target.kind === 'pull-request') {
    try {
      d1 = await sources.d1.find(target, { repositoryId: github.repository.id });
    } catch {
      if (!missingSources.includes('d1')) missingSources.push('d1');
    }
  }
  if (d1 !== undefined) {
    missingSources.splice(missingSources.indexOf('d1'), missingSources.includes('d1') ? 1 : 0);
  } else if (!missingSources.includes('d1')) {
    missingSources.push('d1');
  }
  if (github !== undefined) {
    missingSources.splice(
      missingSources.indexOf('github'),
      missingSources.includes('github') ? 1 : 0,
    );
  } else if (!missingSources.includes('github')) {
    missingSources.push('github');
  }
  const evidenceKey = d1?.run?.evidence?.key;
  if (evidenceKey === undefined) {
    missingSources.push('r2');
  } else {
    try {
      const stored = await sources.r2.get(evidenceKey);
      const parsed = stored === undefined ? undefined : r2Evidence(stored.object);
      r2 = parsed;
      evidenceDetails = parsed === undefined ? undefined : await validatedEvidence(parsed);
      if (evidenceDetails === undefined) missingSources.push('r2');
    } catch {
      missingSources.push('r2');
    }
  }
  if (sources.workflow !== undefined && d1?.run !== undefined) {
    try {
      const candidate = await sources.workflow.find(target, { runId: d1.run.runId });
      workflow = candidate === undefined ? undefined : decode(WorkflowSnapshot, candidate);
      if (candidate === undefined || workflow === undefined) missingSources.push('workflow');
    } catch {
      missingSources.push('workflow');
    }
  }
  const evidence = evidenceDetails?.value.evidence;
  const manifest = evidenceDetails?.manifest;
  const exportTimestamps =
    evidenceDetails?.sessionExport?.messages.flatMap((message) => {
      const metadata = decode(
        Schema.Struct({
          time: Schema.optional(
            Schema.Union([
              Timestamp,
              Schema.Struct({
                created: Schema.optional(Timestamp),
                completed: Schema.optional(Timestamp),
                start: Schema.optional(Timestamp),
                end: Schema.optional(Timestamp),
              }),
            ]),
          ),
        }),
        message,
      );
      if (metadata?.time === undefined) return [];
      if (typeof metadata.time === 'object' && metadata.time !== null) {
        return [
          timestamp(metadata.time.created),
          timestamp(metadata.time.completed),
          timestamp(metadata.time.end),
        ].filter((at): at is string => at !== undefined);
      }
      return [timestamp(metadata.time)].filter((at): at is string => at !== undefined);
    }) ?? [];
  const runner =
    d1?.run === undefined
      ? undefined
      : {
          jobId: d1.run.runnerJobId ?? evidenceDetails?.value.jobId,
          attempt: d1.run.runnerAttempt ?? manifest?.attempt,
          stage: manifest === undefined ? undefined : 'cleanup',
          sandboxName: manifest?.sandboxName,
          sandboxId: manifest?.sandboxId,
          terminal: manifest?.terminal.status,
          failure: manifest?.terminal.reason,
          evidence: manifest?.evidence.status ?? evidence?.status,
          cleanup: manifest?.cleanup.status,
        };
  const timeline = [
    d1?.run?.createdAt === undefined
      ? undefined
      : { at: d1.run.createdAt, source: 'd1', event: 'run claimed' },
    (d1?.run?.evidence?.executionStartedAt ?? manifest?.startedAt) === undefined
      ? undefined
      : {
          at: d1?.run?.evidence?.executionStartedAt ?? manifest!.startedAt!,
          source: 'runner',
          event: 'execution started',
        },
    (d1?.run?.evidence?.submissionCompletedAt ?? evidenceDetails?.submissionCompletedAt) ===
    undefined
      ? undefined
      : {
          at: d1?.run?.evidence?.submissionCompletedAt ?? evidenceDetails!.submissionCompletedAt!,
          source: 'runner',
          event: 'review submitted',
        },
    d1?.run?.evidence?.cleanupCompletedAt === undefined
      ? manifest?.finishedAt === undefined
        ? undefined
        : { at: manifest.finishedAt, source: 'runner', event: 'cleanup completed' }
      : { at: d1.run.evidence.cleanupCompletedAt, source: 'runner', event: 'cleanup completed' },
    d1?.run?.evidence?.uploadedAt === undefined
      ? undefined
      : { at: d1.run.evidence.uploadedAt, source: 'r2', event: 'evidence uploaded' },
    ...exportTimestamps.map((at) => ({ at, source: 'runner', event: 'session event' })),
    ...(workflow?.events ?? []).map((event) => ({
      at: event.at,
      source: 'workflow',
      event: event.type,
    })),
  ]
    .filter((event): event is { at: string; source: string; event: string } => event !== undefined)
    .sort((a, b) => a.at.localeCompare(b.at));
  const workflowFailure = workflow?.events.find(
    (event) => event.status === 'failed' || event.type === 'WorkflowInternalError',
  );
  const firstFailureBoundary = workflowFailure
    ? {
        source: 'workflow',
        at: workflowFailure.at,
        reason: workflowFailure.reason ?? workflowFailure.type,
      }
    : runner?.terminal === 'failed'
      ? { source: 'runner', reason: runner.failure ?? 'Runner Job failed' }
      : d1?.run?.status === 'failed'
        ? { source: 'd1', reason: 'run failed' }
        : evidence?.status === 'incomplete'
          ? { source: 'r2', reason: 'evidence incomplete' }
          : undefined;
  return {
    target,
    github:
      github === undefined
        ? { available: false }
        : {
            available: true,
            ...github.pullRequest,
            trigger: github.trigger,
            reactions: github.reactions,
            reviews: github.reviews,
          },
    d1:
      d1?.delivery === undefined || d1.run === undefined
        ? { available: false }
        : { available: true, ...d1.delivery, ...d1.run, evidence: d1.run.evidence },
    runner: runner ?? { available: false },
    evidence:
      evidence === undefined || r2 === undefined || evidenceDetails === undefined
        ? { available: false }
        : {
            available: true,
            key: d1?.run?.evidence?.key,
            status: evidence.status,
            evidenceId: evidence.id,
            sessionId: evidence.opencodeExport?.sessionId,
            sessionIds: evidenceDetails.sessionIds,
            timestamps: {
              executionStartedAt: manifest?.startedAt,
              submissionCompletedAt:
                d1?.run?.evidence?.submissionCompletedAt ?? evidenceDetails.submissionCompletedAt,
              terminalAt: exportTimestamps.at(-1),
              cleanupCompletedAt: d1?.run?.evidence?.cleanupCompletedAt ?? manifest?.finishedAt,
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
    workflow:
      workflow === undefined
        ? { available: false }
        : { available: true, id: workflow.id, events: workflow.events },
    firstFailureBoundary: firstFailureBoundary ?? null,
    missingSources: [...new Set(missingSources)],
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
  evidence_size: Schema.Union([Schema.Int, Schema.Null]),
  evidence_sha256: Schema.Union([Schema.String, Schema.Null]),
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

export interface DiagnosticConfig {
  readonly database: string;
  readonly bucket: string;
  readonly wranglerConfig: string;
  readonly workflowName?: string;
}

export const createDefaultDiagnosticSources = (
  command: DiagnosticCommandAdapter = commandAdapter,
  config: DiagnosticConfig = {
    database: process.env.DIAGNOSTIC_D1_DATABASE ?? '',
    bucket: process.env.DIAGNOSTIC_R2_BUCKET ?? '',
    wranglerConfig: process.env.DIAGNOSTIC_WRANGLER_CONFIG ?? '',
    workflowName: process.env.DIAGNOSTIC_WORKFLOW_NAME,
  },
): DiagnosticSources => ({
  d1: {
    find: async (target, context) => {
      if (config.database.length === 0 || config.wranglerConfig.length === 0) return undefined;
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
        [
          'pnpm',
          'dlx',
          'wrangler@4.124.0',
          'd1',
          'execute',
          config.database,
          '--remote',
          '--config',
          config.wranglerConfig,
          '--json',
          '--command',
          `SELECT d.*, r.run_id, r.status AS run_status, r.created_at AS run_created_at, r.updated_at AS run_updated_at, r.runner_job_id, r.runner_attempt, r.comment_id, r.evidence_key, r.evidence_status, r.evidence_size, r.evidence_sha256, r.evidence_uploaded_at, r.execution_started_at, r.submission_completed_at, r.cleanup_completed_at FROM review_runs r JOIN deliveries d ON d.delivery_id = r.delivery_id WHERE ${value} ORDER BY r.updated_at DESC LIMIT 1`,
        ],
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
    find: async ({ target, repositoryId, pullRequestNumber }) => {
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
      const comments = await jsonCommand(
        command,
        'gh',
        ['api', `repos/${owner}/${name}/issues/${number}/comments`],
        Schema.Array(CommentJson),
      );
      const reviews = await jsonCommand(
        command,
        'gh',
        ['api', `repos/${owner}/${name}/pulls/${number}/reviews`],
        Schema.Array(ReviewJson),
      );
      if (pull === undefined) return undefined;
      const commentList = comments ?? [];
      const commandComment = commentList.find(
        (comment) =>
          typeof comment === 'object' &&
          comment !== null &&
          typeof comment.body === 'string' &&
          comment.body.trim() === '/ai-review',
      );
      const reactions = commentList.flatMap((comment) =>
        typeof comment === 'object' && comment !== null && comment.reactions !== undefined
          ? Object.entries(comment.reactions)
              .filter(
                (entry): entry is [string, number] =>
                  entry[0] !== 'url' &&
                  entry[0] !== 'total_count' &&
                  typeof entry[1] === 'number' &&
                  entry[1] > 0,
              )
              .map(([content, count]) => ({ content, count }))
          : [],
      );
      return {
        repository: { owner, name, id: repository.id },
        pullRequest: { state: pull.state, baseSha: pull.base.sha, headSha: pull.head.sha },
        trigger:
          commandComment === undefined
            ? undefined
            : {
                kind: 'manual',
                commentId: typeof commandComment.id === 'number' ? commandComment.id : undefined,
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
      if (config.bucket.length === 0 || config.wranglerConfig.length === 0) return undefined;
      const object = await jsonCommand(
        command,
        'corepack',
        [
          'pnpm',
          'dlx',
          'wrangler@4.124.0',
          'r2',
          'object',
          'get',
          `${config.bucket}/${key}`,
          '--pipe',
          '--remote',
          '--config',
          config.wranglerConfig,
        ],
        R2Object,
      );
      return object === undefined ? undefined : { key, object };
    },
  },
  ...(config.workflowName === undefined
    ? {}
    : {
        workflow: {
          find: async (_target: DiagnosticTarget, context?: { readonly runId?: string }) => {
            if (context?.runId === undefined || config.wranglerConfig.length === 0)
              return undefined;
            const result = await command.run('corepack', [
              'pnpm',
              'dlx',
              'wrangler@4.124.0',
              'workflows',
              'instances',
              'describe',
              config.workflowName!,
              context.runId,
              '--config',
              config.wranglerConfig,
            ]);
            return workflowText(result.stdout, context.runId);
          },
        },
      }),
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

import { Option, Schema } from 'effect';
import { RunnerFailureCause } from '@compte-rendu/contracts';
import { ReviewSubmissionSchema } from './review-submission-contract.js';
import type { ReviewSubmission } from './review-submission-contract.js';

export type { ReviewSubmission };

export type FailureCause = typeof RunnerFailureCause.Type;

export type MultiReviewSelection = {
  readonly reviewers: readonly string[];
  readonly synthesis: string;
};

export const MULTI_PROVIDER_ID = 'compte-rendu';
export const SUPERVISOR_AGENT_ID = 'multi-review-supervisor';

const SessionId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/));

export const SessionModelRef = Schema.Struct({
  providerID: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  variant: Schema.optional(Schema.String),
});
export type SessionModelRef = typeof SessionModelRef.Type;

export const MultiSessionInfo = Schema.Struct({
  id: SessionId,
  parentID: Schema.optional(Schema.NullOr(SessionId)),
  agent: Schema.optional(Schema.NonEmptyString),
  model: Schema.optional(SessionModelRef),
  outcome: Schema.optional(Schema.String),
});
export type MultiSessionInfo = typeof MultiSessionInfo.Type;

export const MultiSessionExport = Schema.Struct({
  info: MultiSessionInfo,
  messages: Schema.Array(Schema.Unknown),
});
export type MultiSessionExport = typeof MultiSessionExport.Type;

export const ChildSession = Schema.Struct({
  id: SessionId,
  parentID: Schema.optional(Schema.NullOr(SessionId)),
  agent: Schema.optional(Schema.NonEmptyString),
  model: Schema.optional(SessionModelRef),
  outcome: Schema.optional(Schema.String),
});
export type ChildSession = typeof ChildSession.Type;

const ChildSessionList = Schema.Union([
  Schema.Array(ChildSession),
  Schema.Struct({ data: Schema.Array(ChildSession) }),
  Schema.Struct({ sessions: Schema.Array(ChildSession) }),
]);

const AssistantMessage = Schema.Struct({
  type: Schema.Literal('assistant'),
  finish: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(SessionModelRef),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
});

// Every assistant message in a session export must carry the identity the job
// selected: the expected agent and the expected provider/model. A missing or
// mismatched identity fails closed rather than being silently accepted from the
// session-level info alone.
const AssistantMessageIdentity = Schema.Struct({
  type: Schema.Literal('assistant'),
  agent: Schema.NonEmptyString,
  model: SessionModelRef,
  content: Schema.Array(Schema.Unknown),
});

const AssistantMessageTag = Schema.Struct({ type: Schema.Literal('assistant') });

const SubmitReviewTool = Schema.Struct({
  type: Schema.Literal('tool'),
  name: Schema.Literal('submit_review'),
  state: Schema.Struct({
    status: Schema.String,
    input: Schema.optional(Schema.Unknown),
  }),
});

// A tool part that is identifiably `submit_review` but whose envelope does not
// match the known shape must fail closed instead of being skipped.
const KnownSubmitReviewTool = Schema.Struct({
  type: Schema.Literal('tool'),
  name: Schema.Literal('submit_review'),
});

const TerminalIdle = Schema.Struct({
  type: Schema.Literal('idle'),
  outcome: Schema.Literal('succeeded'),
});

export type SubmissionResult<T> =
  | { readonly value: T; readonly cause?: undefined }
  | { readonly value?: undefined; readonly cause: FailureCause };

export const decodeSessionExport = (value: unknown): MultiSessionExport | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(MultiSessionExport)(value));

export const parseChildSessions = (stdout: string): readonly ChildSession[] | undefined => {
  try {
    const decoded = Option.getOrUndefined(
      Schema.decodeUnknownOption(ChildSessionList)(JSON.parse(stdout)),
    );
    if (decoded === undefined) return undefined;
    if (Array.isArray(decoded)) return decoded;
    if ('data' in decoded) return (decoded as { readonly data: readonly ChildSession[] }).data;
    return (decoded as { readonly sessions: readonly ChildSession[] }).sessions;
  } catch {
    return undefined;
  }
};

// Native `session.list` returns `{ data, cursor }`, and the final non-empty
// page still advertises a `next` cursor, so enumeration must follow pagination
// until an empty page. `cursor.next` is required so a page that cannot establish
// completion fails closed instead of being treated as terminal.
export const ChildSessionPage = Schema.Struct({
  data: Schema.Array(ChildSession),
  cursor: Schema.Struct({
    previous: Schema.optional(Schema.NullOr(Schema.String)),
    next: Schema.NullOr(Schema.String),
  }),
});
export type ChildSessionPage = typeof ChildSessionPage.Type;

export const parseChildSessionPage = (stdout: string): ChildSessionPage | undefined => {
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(ChildSessionPage)(JSON.parse(stdout)));
  } catch {
    return undefined;
  }
};

export const sessionSucceeded = (value: unknown, sessionId: string): boolean => {
  const decoded = Schema.decodeUnknownOption(MultiSessionExport)(value);
  if (Option.isNone(decoded)) return false;
  const exported = decoded.value;
  if (exported.info.id !== sessionId || exported.info.outcome !== 'succeeded') return false;
  if (exported.messages.length === 0) return false;
  if (
    Option.isNone(
      Schema.decodeUnknownOption(TerminalIdle)(exported.messages[exported.messages.length - 1]),
    )
  ) {
    return false;
  }
  let lastAssistantFinish: unknown;
  for (let index = exported.messages.length - 1; index >= 0; index -= 1) {
    const assistant = Schema.decodeUnknownOption(AssistantMessage)(exported.messages[index]);
    if (Option.isSome(assistant)) {
      lastAssistantFinish = assistant.value.finish;
      break;
    }
  }
  return lastAssistantFinish === 'stop';
};

export type SessionIdentity = {
  readonly agent: string;
  readonly model: {
    readonly providerID: string;
    readonly id: string;
  };
};

const identityMatches = (value: SessionModelRef, expected: SessionIdentity['model']): boolean =>
  value.providerID === expected.providerID && value.id === expected.id;

const collectSubmitInputs = (
  value: unknown,
  identity: SessionIdentity,
): { readonly inputs: readonly unknown[] } | { readonly cause: FailureCause } => {
  const exported = decodeSessionExport(value);
  if (exported === undefined) return { cause: 'result-schema-failure' };
  const inputs: unknown[] = [];
  for (const message of exported.messages) {
    if (Option.isNone(Schema.decodeUnknownOption(AssistantMessageTag)(message))) continue;
    const assistant = Option.getOrUndefined(
      Schema.decodeUnknownOption(AssistantMessageIdentity)(message),
    );
    if (
      assistant === undefined ||
      assistant.agent !== identity.agent ||
      !identityMatches(assistant.model, identity.model)
    ) {
      return { cause: 'result-schema-failure' };
    }
    for (const part of assistant.content) {
      if (Option.isNone(Schema.decodeUnknownOption(KnownSubmitReviewTool)(part))) continue;
      const tool = Option.getOrUndefined(Schema.decodeUnknownOption(SubmitReviewTool)(part));
      if (tool === undefined) return { cause: 'result-schema-failure' };
      const status = tool.state.status;
      if (status === 'error') continue;
      if (status !== 'completed') return { cause: 'result-schema-failure' };
      inputs.push(tool.state.input);
    }
  }
  return { inputs };
};

export const extractReviewSubmission = (
  value: unknown,
  identity: SessionIdentity,
): SubmissionResult<ReviewSubmission> => {
  const collected = collectSubmitInputs(value, identity);
  if ('cause' in collected) return { cause: collected.cause };
  if (collected.inputs.length === 0) return { cause: 'zero-results' };
  if (collected.inputs.length > 1) return { cause: 'multiple-results' };
  // Excess keys are ignored on both sides: OpenCode's tool boundary normalizes
  // them away while the exported session keeps the raw call, so unrelated extra
  // fields must never turn a valid decision and Markdown into a failure.
  const decoded = Schema.decodeUnknownOption(ReviewSubmissionSchema)(collected.inputs[0]);
  if (Option.isNone(decoded)) return { cause: 'result-schema-failure' };
  return { value: decoded.value };
};

export const participantId = (index: number) => `reviewer-${index}`;

export const modelReference = (route: string) => `${MULTI_PROVIDER_ID}/${route}`;

export const dedupedRoutes = (selection: MultiReviewSelection): readonly string[] => [
  ...new Set([...selection.reviewers, selection.synthesis]),
];

export const participants = (
  selection: MultiReviewSelection,
): readonly { readonly participant: string; readonly route: string }[] =>
  selection.reviewers.map((route, index) => ({ participant: participantId(index), route }));

type Permission = {
  readonly action: string;
  readonly resource: string;
  readonly effect: 'allow' | 'deny';
};

const reviewerPermissions = (
  shellPermissionRules: ReadonlyArray<readonly [string, 'allow' | 'deny']>,
): readonly Permission[] => [
  { action: '*', resource: '*', effect: 'deny' },
  { action: 'submit_review', resource: '*', effect: 'allow' },
  { action: 'subagent', resource: '*', effect: 'deny' },
  ...shellPermissionRules.map(([resource, effect]) => ({
    action: 'shell',
    resource,
    effect,
  })),
  { action: 'edit', resource: '*', effect: 'deny' },
  { action: 'external_directory', resource: '*', effect: 'allow' },
  { action: 'glob', resource: '*', effect: 'allow' },
  { action: 'grep', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'skill', resource: '*', effect: 'allow' },
  { action: 'webfetch', resource: '*', effect: 'deny' },
];

const supervisorPermissions = (
  roster: readonly { readonly participant: string }[],
): readonly Permission[] => [
  { action: '*', resource: '*', effect: 'deny' },
  ...roster.map(({ participant }) => ({
    action: 'subagent',
    resource: participant,
    effect: 'allow' as const,
  })),
  { action: 'submit_review', resource: '*', effect: 'allow' },
];

export const multiReviewConfig = (options: {
  readonly selection: MultiReviewSelection;
  readonly serviceBaseUrl: string;
  readonly shellPermissionRules: ReadonlyArray<readonly [string, 'allow' | 'deny']>;
}): string => {
  const roster = participants(options.selection);
  const reviewerPermissionsValue = reviewerPermissions(options.shellPermissionRules);
  const models = Object.fromEntries(
    dedupedRoutes(options.selection).map((route) => [
      route,
      { settings: { baseURL: options.serviceBaseUrl } },
    ]),
  );
  return JSON.stringify({
    model: modelReference(options.selection.synthesis),
    providers: {
      [MULTI_PROVIDER_ID]: {
        name: 'Compte-rendu service',
        canonical: 'opencode-go',
        package: '@opencode/ai/providers/openai-compatible',
        settings: {
          baseURL: options.serviceBaseUrl,
          apiKey: '{env:OPENCODE_API_KEY}',
        },
        models,
      },
    },
    agents: {
      [SUPERVISOR_AGENT_ID]: {
        description: 'Multi-model review supervisor',
        mode: 'primary',
        model: modelReference(options.selection.synthesis),
        permissions: supervisorPermissions(roster),
      },
      ...Object.fromEntries(
        roster.map(({ participant, route }) => [
          participant,
          {
            description: `Multi-model reviewer ${participant}`,
            mode: 'subagent',
            model: modelReference(route),
            permissions: reviewerPermissionsValue,
          },
        ]),
      ),
    },
  });
};

export const multiReviewSupervisorPrompt = (options: {
  readonly roster: readonly { readonly participant: string; readonly route: string }[];
  readonly baseBrief: string;
}): string => {
  const roster =
    options.roster.length === 0
      ? '- none'
      : options.roster
          .map(({ participant, route }) => `- ${participant} (${modelReference(route)})`)
          .join('\n');
  return (
    'You are the multi-model review supervisor. Run independent reviews with the configured models and then ' +
    'synthesize their reports into one final review. Do not inspect the repository, read files, or run shell commands ' +
    'yourself; use the subagent and submit_review tools. Participants:\n' +
    `${roster}\n\nFrozen review brief:\n${options.baseBrief}\n\n` +
    'Give each reviewer this same brief and let it review independently; use whatever orchestration you judge best. ' +
    'Reviewers return their own reports. Then synthesize those reports into one review, preserving substantive ' +
    'disagreements rather than forcing consensus. Submit your final decision and publishable Markdown with ' +
    'submit_review; the Markdown must begin with "## Review:". If a submission is rejected, correct it in the same session.'
  );
};

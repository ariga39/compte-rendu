import { Option, Schema } from 'effect';
import { RunnerFailureCause } from '@compte-rendu/contracts';
import { parseReviewSubmission, type ReviewSubmission } from './review-submission-contract.js';

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

const AssistantMessage = Schema.Struct({
  type: Schema.Literal('assistant'),
  id: Schema.optional(Schema.NonEmptyString),
  finish: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.NonEmptyString),
  model: Schema.optional(SessionModelRef),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
});

const AssistantTag = Schema.Struct({ type: Schema.Literal('assistant') });

const TextTag = Schema.Struct({ type: Schema.Literal('text') });

const TextPart = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
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
  const finalAssistant = finalAssistantMessage(exported.messages);
  return finalAssistant !== undefined && finalAssistant.finish === 'stop';
};

const finalAssistantMessage = (
  messages: readonly unknown[],
): typeof AssistantMessage.Type | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (Option.isNone(Schema.decodeUnknownOption(AssistantTag)(messages[index]))) continue;
    return Option.getOrUndefined(Schema.decodeUnknownOption(AssistantMessage)(messages[index]));
  }
  return undefined;
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

export type FinalAssistant =
  | {
      readonly text: string;
      readonly messageId?: string;
      readonly cause?: undefined;
    }
  | {
      readonly text?: undefined;
      readonly messageId?: undefined;
      readonly cause: FailureCause;
    };

export const finalAssistantText = (value: unknown, identity?: SessionIdentity): FinalAssistant => {
  const exported = decodeSessionExport(value);
  if (exported === undefined) return { cause: 'result-schema-failure' };
  let finalAssistant: typeof AssistantMessage.Type | undefined;
  for (let index = exported.messages.length - 1; index >= 0; index -= 1) {
    if (Option.isNone(Schema.decodeUnknownOption(AssistantTag)(exported.messages[index]))) continue;
    finalAssistant = Option.getOrUndefined(
      Schema.decodeUnknownOption(AssistantMessage)(exported.messages[index]),
    );
    break;
  }
  if (finalAssistant === undefined) return { cause: 'zero-results' };
  if (finalAssistant.finish !== 'stop') return { cause: 'missing-terminal-message' };
  if (identity !== undefined) {
    if (
      finalAssistant.agent !== identity.agent ||
      finalAssistant.model === undefined ||
      !identityMatches(finalAssistant.model, identity.model)
    )
      return { cause: 'result-schema-failure' };
  }
  const texts: string[] = [];
  for (const part of finalAssistant.content ?? []) {
    if (Option.isNone(Schema.decodeUnknownOption(TextTag)(part))) continue;
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(TextPart)(part));
    if (decoded === undefined) return { cause: 'result-schema-failure' };
    texts.push(decoded.text);
  }
  const text = texts.join('');
  return {
    text,
    ...(finalAssistant.id === undefined ? {} : { messageId: finalAssistant.id }),
  };
};

export const extractReviewSubmission = (
  value: unknown,
  identity?: SessionIdentity,
): SubmissionResult<ReviewSubmission> => {
  const assistant = finalAssistantText(value, identity);
  if (assistant.cause !== undefined) return { cause: assistant.cause };
  if (assistant.text.trim().length === 0) return { cause: 'empty-final-text' };
  const decoded = parseReviewSubmission(assistant.text);
  if (decoded === undefined) return { cause: 'result-schema-failure' };
  return {
    value: decoded,
    ...(assistant.messageId === undefined ? {} : { messageId: assistant.messageId }),
  };
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
  if (roster.length === 1) {
    const route = roster[0]!.route;
    return JSON.stringify({
      model: modelReference(route),
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
        review: {
          description: 'Pull request reviewer',
          mode: 'primary',
          model: modelReference(route),
          permissions: reviewerPermissionsValue,
        },
      },
    });
  }
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

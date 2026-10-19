import { Option, Schema } from 'effect';
import { ReviewDecision, ReviewResult, RunnerFailureCause } from '@compte-rendu/contracts';

export type FailureCause = typeof RunnerFailureCause.Type;

export type MultiReviewSelection = {
  readonly reviewers: readonly string[];
  readonly synthesis: string;
};

export const MULTI_PROVIDER_ID = 'compte-rendu';
export const SUPERVISOR_AGENT_ID = 'multi-review-supervisor';

const SessionId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/));
const FindingId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/));

export const MultiFinding = Schema.Struct({
  id: FindingId,
  location: Schema.NonEmptyString,
  claim: Schema.NonEmptyString,
  impact: Schema.NonEmptyString,
  evidence: Schema.NonEmptyString,
});
export type MultiFinding = typeof MultiFinding.Type;

export const ReviewerSubmission = Schema.Struct({
  decision: ReviewDecision,
  markdown: ReviewResult,
  findings: Schema.Array(MultiFinding),
});
export type ReviewerSubmission = typeof ReviewerSubmission.Type;

export const CoverageOutcome = Schema.Literals(['retained', 'merged', 'disagreement']);
export type CoverageOutcome = typeof CoverageOutcome.Type;

export const SynthesisCoverage = Schema.Struct({
  findingId: FindingId,
  outcome: CoverageOutcome,
  finalId: Schema.optional(FindingId),
});
export type SynthesisCoverage = typeof SynthesisCoverage.Type;

export const SynthesisSubmission = Schema.Struct({
  decision: ReviewDecision,
  markdown: ReviewResult,
  coverage: Schema.Array(SynthesisCoverage),
});
export type SynthesisSubmission = typeof SynthesisSubmission.Type;

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

const decodeStrict = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): Option.Option<S['Type']> =>
  Schema.decodeUnknownOption(schema, { onExcessProperty: 'error' })(value);

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

export const extractReviewerSubmission = (
  value: unknown,
  identity: SessionIdentity,
): SubmissionResult<ReviewerSubmission> => {
  const collected = collectSubmitInputs(value, identity);
  if ('cause' in collected) return { cause: collected.cause };
  if (collected.inputs.length === 0) return { cause: 'zero-results' };
  if (collected.inputs.length > 1) return { cause: 'multiple-results' };
  const decoded = decodeStrict(ReviewerSubmission, collected.inputs[0]);
  if (Option.isNone(decoded)) return { cause: 'result-schema-failure' };
  return { value: decoded.value };
};

export const extractSynthesisSubmission = (
  value: unknown,
  identity: SessionIdentity,
): SubmissionResult<SynthesisSubmission> => {
  const collected = collectSubmitInputs(value, identity);
  if ('cause' in collected) return { cause: collected.cause };
  if (collected.inputs.length === 0) return { cause: 'zero-results' };
  if (collected.inputs.length > 1) return { cause: 'multiple-results' };
  const decoded = decodeStrict(SynthesisSubmission, collected.inputs[0]);
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

export const multiReviewerBrief = (baseBrief: string, participant: string): string =>
  `${baseBrief}\n\nParticipant: ${participant}. This is the same frozen review brief given to every reviewer. ` +
  `In addition to decision and markdown, call submit_review exactly once with a findings array. Each finding must have ` +
  `id, location, claim, impact, and evidence; prefix every finding id with "${participant}-". If there are no findings, ` +
  `use an empty array. Do not call subagent and do not spawn reviewers. After the submit_review call, reply with only a ` +
  `compact JSON object {"participant":"${participant}","decision":...,"findings":[...],"conclusion":"..."} using the exact ` +
  `finding ids from the tool call, so the supervisor can synthesize. Do not include planning or chain-of-thought.`;

export const multiReviewSupervisorPrompt = (options: {
  readonly roster: readonly { readonly participant: string; readonly route: string }[];
}): string => {
  const roster =
    options.roster.length === 0
      ? '- none'
      : options.roster
          .map(({ participant, route }) => `- ${participant} (${modelReference(route)})`)
          .join('\n');
  return (
    'You are the multi-model review supervisor. Do not inspect the repository, read files, run shell commands, ' +
    'or use any tool other than subagent and submit_review. Your only job is to dispatch the configured reviewers and ' +
    'then synthesize their submitted findings editorially. ' +
    'Dispatch all reviewers now, in the same assistant turn, foreground, exactly one subagent call per participant. ' +
    'Set background:false. Use the exact participant id as the subagent agent and a short description. The runtime ' +
    'injects the frozen review brief for that participant; do not add your own review instructions, do not include ' +
    "another reviewer's findings, and do not dispatch extra reviewers. Participants:\n" +
    `${roster}\n\n` +
    'When every subagent result has returned, use only the submitted findings and their exact finding ids to produce one ' +
    'synthesis. Call submit_review exactly once with decision, markdown, and coverage. coverage must contain exactly one ' +
    'entry for every reviewer finding id, with outcome "retained", "merged", or "disagreement"; use finalId for ' +
    'retained or merged and preserve disagreements explicitly. Do not invent, drop, or rename findings. Do not start ' +
    'another review round. The final markdown must begin with "## Review:" and the decision must follow the supplied ' +
    'results.'
  );
};

// The delivered guard binds one supervisor session, dispatches each configured
// participant once with that participant's frozen brief, captures each child's
// completed submit_review through the execute.after transport, and replaces the
// parent-visible subagent result with the frozen report. It withholds the
// supervisor's own submit_review until every formal reviewer submission exists.
// The plugin is read-only with respect to repo contents; Runner still performs
// all final schema validation over the exported sessions.
export const multiReviewGuardPlugin = (briefs: Readonly<Record<string, string>>): string =>
  `const BRIEFS = ${JSON.stringify(briefs)};\n` +
  `const SUPERVISOR = ${JSON.stringify(SUPERVISOR_AGENT_ID)};\n` +
  `const ROSTER = ${Object.keys(briefs).length};\n` +
  `export default { id: 'multi-review-guard', async setup(ctx) {\n` +
  `  const dispatched = new Set();\n` +
  `  const reports = new Map();\n` +
  `  let root;\n` +
  `  await ctx.tool.hook('execute.before', (event) => {\n` +
  `    if (event.tool === 'submit_review' && event.agent === SUPERVISOR) {\n` +
  `      if (event.sessionID !== root || reports.size !== ROSTER) throw new Error('all reviewers must submit first');\n` +
  `    }\n` +
  `    if (event.tool !== 'subagent') return;\n` +
  `    if (event.agent !== SUPERVISOR) throw new Error('only the supervisor may dispatch reviewers');\n` +
  `    if (root !== undefined && root !== event.sessionID) throw new Error('unexpected supervisor session');\n` +
  `    root = event.sessionID;\n` +
  `    const input = event.input ?? {};\n` +
  `    const participant = String(input.agent ?? '');\n` +
  `    if (BRIEFS[participant] === undefined || dispatched.has(participant)) throw new Error('invalid or repeated reviewer');\n` +
  `    dispatched.add(participant);\n` +
  `    input.agent = participant;\n` +
  `    input.background = false;\n` +
  `    input.prompt = BRIEFS[participant];\n` +
  `  });\n` +
  `  await ctx.tool.hook('execute.after', (event) => {\n` +
  `    if (event.status !== 'completed') return;\n` +
  `    if (event.tool === 'submit_review' && BRIEFS[event.agent] !== undefined) {\n` +
  `      reports.set(event.agent, { participant: event.agent, sessionId: event.sessionID, submission: event.input === undefined ? {} : JSON.parse(JSON.stringify(event.input)) });\n` +
  `    }\n` +
  `    if (event.tool === 'subagent' && event.agent === SUPERVISOR) {\n` +
  `      const report = reports.get(event.input === undefined ? undefined : event.input.agent);\n` +
  `      event.result.content = JSON.stringify(report ?? { error: 'reviewer did not submit' });\n` +
  `    }\n` +
  `  });\n` +
  `} };\n`;

export const coverageProblem = (
  findings: readonly MultiFinding[],
  coverage: readonly SynthesisCoverage[],
  markdown: string,
): string | undefined => {
  const ids = findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) return 'duplicate-finding-id';
  const byFinding = new Map<string, SynthesisCoverage>();
  for (const entry of coverage) {
    if (byFinding.has(entry.findingId)) return 'duplicate-coverage';
    byFinding.set(entry.findingId, entry);
  }
  for (const id of ids) if (!byFinding.has(id)) return 'uncovered-finding';
  for (const entry of coverage) if (!ids.includes(entry.findingId)) return 'unknown-coverage';
  const retained = new Set(
    coverage
      .filter((entry) => entry.outcome === 'retained')
      .map((entry) => entry.finalId ?? entry.findingId),
  );
  for (const entry of coverage) {
    if (entry.outcome === 'retained') {
      if (entry.finalId === undefined) return 'missing-final-id';
      // A retained finding's final id must be visible in the published review,
      // so an omission is observable rather than silently claimed.
      if (!markdown.includes(entry.finalId)) return 'missing-final-in-markdown';
    }
    if (entry.outcome === 'merged') {
      if (entry.finalId === undefined || !retained.has(entry.finalId))
        return 'invalid-merge-target';
      if (!markdown.includes(entry.finalId)) return 'missing-final-in-markdown';
    }
    if (entry.outcome === 'disagreement' && !markdown.includes(entry.findingId)) {
      return 'missing-disagreement-in-markdown';
    }
  }
  return undefined;
};

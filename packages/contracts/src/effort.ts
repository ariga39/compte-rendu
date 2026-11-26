import { Schema } from 'effect';

export const ModelRouteId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:/-]{1,128}$/));

// Effort names are operator-facing labels only. Controls are a narrow,
// protocol-validated Chat allowlist; browsers never submit them.
export const EffortName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/));
export type EffortName = typeof EffortName.Type;

export const ChatEffortControls = Schema.Struct({
  reasoning_effort: Schema.optionalKey(
    Schema.Literals(['minimal', 'low', 'medium', 'high', 'max']),
  ),
  thinking: Schema.optionalKey(
    Schema.Struct({
      type: Schema.Literal('disabled'),
    }),
  ),
}).check(
  Schema.makeFilter(
    (controls) => (controls.reasoning_effort !== undefined) !== (controls.thinking !== undefined),
    { expected: 'exactly one non-conflicting Chat effort control' },
  ),
);
export type ChatEffortControls = typeof ChatEffortControls.Type;

export const ResponsesEffortValue = Schema.Literals([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);
export type ResponsesEffortValue = typeof ResponsesEffortValue.Type;

export const ResponsesEffortControls = Schema.Struct({
  reasoning: Schema.Struct({
    effort: ResponsesEffortValue,
  }),
});
export type ResponsesEffortControls = typeof ResponsesEffortControls.Type;

// The two control shapes use disjoint top-level keys, so a configured option
// can be validated against the route's protocol without a wrapper tag.
export const RouteEffortControls = Schema.Union([ChatEffortControls, ResponsesEffortControls]);
export type RouteEffortControls = typeof RouteEffortControls.Type;

// Decoded controls use the disjoint wire keys, not a second schema decode.
export const isResponsesEffortControls = (
  controls: RouteEffortControls,
): controls is ResponsesEffortControls => 'reasoning' in controls;
export const isChatEffortControls = (
  controls: RouteEffortControls,
): controls is ChatEffortControls => !isResponsesEffortControls(controls);
export const effortControlsProfile = (controls: RouteEffortControls): 'chat' | 'responses' =>
  'reasoning' in controls ? 'responses' : 'chat';

export const RouteEffortOption = Schema.Struct({
  name: EffortName,
  controls: RouteEffortControls,
});
export type RouteEffortOption = typeof RouteEffortOption.Type;

export const RouteEfforts = Schema.Record(ModelRouteId, Schema.Array(RouteEffortOption));
export type RouteEfforts = typeof RouteEfforts.Type;

export const FrozenRouteEffort = Schema.Struct({
  routeId: ModelRouteId,
  generation: Schema.Natural,
  name: Schema.optionalKey(EffortName),
  controls: Schema.optionalKey(RouteEffortControls),
}).check(
  Schema.makeFilter((effort) => (effort.name !== undefined) === (effort.controls !== undefined), {
    expected: 'effort name and controls together, or neither',
  }),
);
export type FrozenRouteEffort = typeof FrozenRouteEffort.Type;

export const AppliedRouteEffort = Schema.Struct({
  name: EffortName,
  controls: RouteEffortControls,
});
export type AppliedRouteEffort = typeof AppliedRouteEffort.Type;

export const EffortOutcomeKind = Schema.Literals(['switched', 'shared', 'failed']);
export type EffortOutcomeKind = typeof EffortOutcomeKind.Type;

export const EffortRouteSummary = Schema.Struct({
  route: ModelRouteId,
  selected: Schema.NullOr(EffortName),
  generation: Schema.NullOr(Schema.Natural),
  outcomes: Schema.Array(
    Schema.Struct({
      kind: Schema.NullOr(EffortOutcomeKind),
      reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
      requests: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ).check(Schema.isMaxLength(4)),
});
export type EffortRouteSummary = typeof EffortRouteSummary.Type;

export const EffortRouteState = Schema.Struct({
  routeId: ModelRouteId,
  generation: Schema.Natural,
  fallbackAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/)),
  reason: Schema.String.check(Schema.isMaxLength(128)),
});
export type EffortRouteState = typeof EffortRouteState.Type;

export const EffortAttemptDetail = Schema.Struct({
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
  sent: Schema.NullOr(ChatEffortControls),
  reported: Schema.NullOr(ChatEffortControls),
  result: Schema.Literals(['complete', 'rejected', 'incomplete']),
});
export type EffortAttemptDetail = typeof EffortAttemptDetail.Type;

export const EffortRequestDetail = Schema.Struct({
  requestId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  route: ModelRouteId,
  selected: Schema.NullOr(EffortName),
  generation: Schema.NullOr(Schema.Natural),
  fallback: Schema.NullOr(EffortOutcomeKind),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  attempts: Schema.Array(EffortAttemptDetail).check(Schema.isMaxLength(2)),
});
export type EffortRequestDetail = typeof EffortRequestDetail.Type;

export const EffortJobDetail = Schema.Struct({
  jobId: Schema.NonEmptyString,
  requests: Schema.Array(EffortRequestDetail).check(Schema.isMaxLength(32)),
  nextCursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
});
export type EffortJobDetail = typeof EffortJobDetail.Type;

import { Schema } from 'effect';
import { EffortRouteSummary } from './effort.ts';

const SafeIdentity = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:/-]+$/),
);
const NonNegativeSafeInteger = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export const TokenCount = Schema.Struct({
  total: NonNegativeSafeInteger,
  reportedRequests: NonNegativeSafeInteger,
});
export type TokenCount = typeof TokenCount.Type;

export const ModelUsageRow = Schema.Struct({
  route: SafeIdentity,
  model: Schema.NullOr(SafeIdentity),
  requests: NonNegativeSafeInteger,
  incompleteRequests: NonNegativeSafeInteger,
  inputTokens: Schema.NullOr(TokenCount),
  uncachedInputTokens: Schema.NullOr(TokenCount),
  cacheReadTokens: Schema.NullOr(TokenCount),
  cacheWriteTokens: Schema.NullOr(TokenCount),
  outputTokens: Schema.NullOr(TokenCount),
  reasoningTokens: Schema.NullOr(TokenCount),
});
export type ModelUsageRow = typeof ModelUsageRow.Type;

export const MODEL_USAGE_ROW_LIMIT = 32;

export const ModelUsageSummary = Schema.Struct({
  version: Schema.Literal(1),
  models: Schema.Array(ModelUsageRow).check(Schema.isMaxLength(MODEL_USAGE_ROW_LIMIT)),
  efforts: Schema.optionalKey(
    Schema.Array(EffortRouteSummary).check(Schema.isMaxLength(MODEL_USAGE_ROW_LIMIT)),
  ),
  truncated: Schema.optionalKey(Schema.Boolean),
});
export type ModelUsageSummary = typeof ModelUsageSummary.Type;

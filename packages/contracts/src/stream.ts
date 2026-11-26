import { Option, Schema } from 'effect';
import { ChatEffortControls } from './effort.ts';

const ChatChoice = Schema.Struct({
  finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const TokenNumber = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const ChatUsageDetails = Schema.StructWithRest(
  Schema.Struct({
    cached_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
    cache_write_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
    cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ChatCompletionDetails = Schema.StructWithRest(
  Schema.Struct({ reasoning_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ChatUsage = Schema.Struct({
  prompt_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  completion_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  total_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  prompt_tokens_details: Schema.optionalKey(Schema.NullOr(ChatUsageDetails)),
  completion_tokens_details: Schema.optionalKey(Schema.NullOr(ChatCompletionDetails)),
});
const StreamFrame = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.Unknown),
  choices: Schema.optionalKey(Schema.Array(ChatChoice)),
  usage: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
  reasoning_effort: Schema.optionalKey(Schema.Unknown),
  thinking: Schema.optionalKey(Schema.Struct({ type: Schema.optionalKey(Schema.Unknown) })),
  response: Schema.optionalKey(
    Schema.Struct({
      status: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.Unknown),
      usage: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});
export type StreamFrame = typeof StreamFrame.Type;
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(StreamFrame));
export const SafeModel = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:/-]+$/),
);
export const modelIdentity = (value: unknown): string | null =>
  Option.getOrUndefined(Schema.decodeUnknownOption(SafeModel)(value)) ?? null;

export type ObservedTokenFields = {
  -readonly [K in Exclude<keyof import('./usage.ts').UpstreamUsage, 'model' | 'complete'>]?: number;
};

const put = (
  target: ObservedTokenFields,
  key: Exclude<keyof import('./usage.ts').UpstreamUsage, 'model' | 'complete'>,
  value: number | null | undefined,
): void => {
  if (value !== null && value !== undefined) target[key] = value;
};

const chatUsage = (value: unknown): ObservedTokenFields => {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ChatUsage)(value));
  const observed: ObservedTokenFields = {};
  if (decoded === undefined) return observed;
  put(observed, 'inputTokens', decoded.prompt_tokens);
  put(observed, 'cacheReadTokens', decoded.prompt_tokens_details?.cached_tokens);
  put(
    observed,
    'cacheWriteTokens',
    decoded.prompt_tokens_details?.cache_write_tokens ??
      decoded.prompt_tokens_details?.cache_creation_input_tokens,
  );
  put(observed, 'outputTokens', decoded.completion_tokens);
  put(observed, 'reasoningTokens', decoded.completion_tokens_details?.reasoning_tokens);
  return observed;
};

export const decodeStreamFrame = (data: string): Option.Option<StreamFrame> => decodeFrame(data);

export const streamFrameModel = (frame: StreamFrame): string | null => modelIdentity(frame.model);

export const streamFrameUsage = (frame: StreamFrame): ObservedTokenFields => chatUsage(frame.usage);

export const streamFrameTerminal = (frame: StreamFrame): boolean =>
  frame.choices?.some((choice) => choice.finish_reason != null) === true;

export const streamEventIsError = (event: string | undefined): boolean =>
  event === 'error' || event === 'response.failed';

export const streamFrameIsError = (frame: StreamFrame): boolean =>
  frame.error != null ||
  frame.type === 'error' ||
  frame.type === 'response.failed' ||
  frame.response?.status === 'failed';

// Only explicit, bounded Chat control fields reported by the upstream are
// accepted. Values that do not form one valid control are not retained as a
// recognised report.
const decodeChatEffortControls = Schema.decodeUnknownOption(ChatEffortControls);

export const streamFrameEffortReport = (frame: StreamFrame): ChatEffortControls | null => {
  // Ordinary token frames carry neither field. Keep this path allocation-free
  // and never run schema validation for them.
  if (frame.reasoning_effort === undefined && frame.thinking === undefined) return null;
  const decoded = decodeChatEffortControls({
    ...(frame.reasoning_effort === undefined ? {} : { reasoning_effort: frame.reasoning_effort }),
    ...(frame.thinking === undefined ? {} : { thinking: frame.thinking }),
  });
  return Option.isNone(decoded) ? null : decoded.value;
};

import { Option, Schema } from 'effect';

const optional = Schema.optionalKey(Schema.Unknown);
const ChatFunction = Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
const ChatTool = Schema.StructWithRest(
  Schema.Struct({ type: Schema.Literal('function'), function: ChatFunction }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ResponsesTool = Schema.StructWithRest(
  Schema.Struct({ type: Schema.Literals(['function', 'custom']), name: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Unknown),
  stream: optional,
  store: optional,
  tools: Schema.optionalKey(Schema.Array(ChatTool)),
  tool_choice: optional,
  parallel_tool_calls: optional,
  temperature: optional,
  top_p: optional,
  n: optional,
  max_tokens: optional,
  max_completion_tokens: optional,
  stop: optional,
  frequency_penalty: optional,
  presence_penalty: optional,
  seed: optional,
  stream_options: optional,
  response_format: optional,
  reasoning_effort: optional,
  reasoning: optional,
  verbosity: optional,
  logprobs: optional,
  top_logprobs: optional,
  logit_bias: optional,
  user: optional,
  service_tier: optional,
  prompt_cache_key: optional,
  modalities: optional,
  audio: optional,
  prediction: optional,
});
export type ChatRequest = typeof ChatRequest.Type;

export const ResponsesRequest = Schema.Struct({
  model: Schema.String,
  input: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  instructions: optional,
  stream: optional,
  store: optional,
  tools: Schema.optionalKey(Schema.Array(ResponsesTool)),
  tool_choice: optional,
  parallel_tool_calls: optional,
  temperature: optional,
  top_p: optional,
  max_output_tokens: optional,
  reasoning: optional,
  text: optional,
  include: optional,
  prompt_cache_key: optional,
  service_tier: optional,
  client_metadata: optional,
  previous_response_id: optional,
  conversation: optional,
  truncation: optional,
  user: optional,
  background: optional,
  safety_identifier: optional,
  max_tool_calls: optional,
});
export type ResponsesRequest = typeof ResponsesRequest.Type;

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
const ResponsesUsageDetails = Schema.StructWithRest(
  Schema.Struct({
    cached_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
    cache_write_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
    cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ResponsesOutputDetails = Schema.StructWithRest(
  Schema.Struct({ reasoning_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ResponsesUsage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  output_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  total_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  input_tokens_details: Schema.optionalKey(Schema.NullOr(ResponsesUsageDetails)),
  output_tokens_details: Schema.optionalKey(Schema.NullOr(ResponsesOutputDetails)),
});
const StreamFrame = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.Unknown),
  choices: Schema.optionalKey(Schema.Array(ChatChoice)),
  usage: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
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

export type StreamProtocol = 'chat-completions' | 'responses';

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

const responsesUsage = (value: unknown): ObservedTokenFields => {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ResponsesUsage)(value));
  const observed: ObservedTokenFields = {};
  if (decoded === undefined) return observed;
  put(observed, 'inputTokens', decoded.input_tokens);
  put(observed, 'cacheReadTokens', decoded.input_tokens_details?.cached_tokens);
  put(
    observed,
    'cacheWriteTokens',
    decoded.input_tokens_details?.cache_write_tokens ??
      decoded.input_tokens_details?.cache_creation_input_tokens,
  );
  put(observed, 'outputTokens', decoded.output_tokens);
  put(observed, 'reasoningTokens', decoded.output_tokens_details?.reasoning_tokens);
  return observed;
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

export const streamFrameModel = (frame: StreamFrame, protocol: StreamProtocol): string | null =>
  modelIdentity(protocol === 'chat-completions' ? frame.model : frame.response?.model);

export const streamFrameUsage = (
  frame: StreamFrame,
  protocol: StreamProtocol,
): ObservedTokenFields =>
  protocol === 'chat-completions' ? chatUsage(frame.usage) : responsesUsage(frame.response?.usage);

export const streamFrameTerminal = (frame: StreamFrame, protocol: StreamProtocol): boolean =>
  protocol === 'chat-completions'
    ? frame.choices?.some((choice) => choice.finish_reason != null) === true
    : frame.type === 'response.completed' || frame.type === 'response.incomplete';

export const streamEventIsError = (event: string | undefined): boolean =>
  event === 'error' || event === 'response.failed';

export const streamFrameIsError = (frame: StreamFrame): boolean =>
  frame.error != null ||
  frame.type === 'error' ||
  frame.type === 'response.failed' ||
  frame.response?.status === 'failed';

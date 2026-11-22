import { Option, Schema } from 'effect';
import { modelIdentity, type ObservedTokenFields } from '@compte-rendu/contracts';
import type { FrozenRoute } from './routes.ts';
import type {
  ProtocolStreamAdapter,
  ProtocolStreamOptions,
  SseFrame,
  StreamObservationDetails,
} from './protocol-stream.ts';
import { encodeSseFrame, relayProtocolStream } from './protocol-stream.ts';

// Responses subset for the first release. The profiles branch owns the shared
// profile/request schemas; this module should import them when integrated.
export const MAX_RESPONSES_OUTPUT_TOKENS = 256_000;
// One terminal event repeats the full output. This is a policy ceiling, not a
// measured provider maximum. Workerd tests cover a successful terminal above
// 64 KiB, exactly this value, and one byte above (which fails closed). A
// realistic plain-text 256k-token turn is expected below 4 MiB, but larger
// provider output remains unmeasured until a pinned capture demonstrates it.
export const MAX_RESPONSES_TERMINAL_BYTES = 4 * 1024 * 1024;

const MAX_INSTRUCTIONS_BYTES = 1024 * 1024;
const MAX_PROMPT_CACHE_KEY = 128;
const MAX_TOOLS = 128;
const MAX_INPUT_ITEMS = 1024;
const MAX_ITEM_ID = 256;
const MAX_ENCRYPTED_REASONING = 2 * 1024 * 1024;

const BoundedString = (bytes: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => new TextEncoder().encode(value).byteLength <= bytes, {
      expected: `string no larger than ${bytes} bytes`,
    }),
  );

const ItemId = Schema.String.check(
  Schema.isMaxLength(MAX_ITEM_ID),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
);
const CallId = Schema.String.check(
  Schema.isMaxLength(MAX_ITEM_ID),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
);
const ToolName = Schema.String.check(Schema.isMaxLength(128));

const EmptyArray = Schema.Array(Schema.Unknown).check(Schema.isMaxLength(0));
const InputTextPart = Schema.Struct({ type: Schema.Literal('input_text'), text: Schema.String });
const OutputTextPart = Schema.Struct({
  type: Schema.Literal('output_text'),
  text: Schema.String,
  annotations: Schema.optionalKey(EmptyArray),
});
const ContentPart = Schema.Union([InputTextPart, OutputTextPart]);
const MessageContent = Schema.Union([Schema.String, Schema.Array(ContentPart)]);

const MessageFields = {
  type: Schema.optionalKey(Schema.Literal('message')),
  content: MessageContent,
  id: Schema.optionalKey(ItemId),
  status: Schema.optionalKey(Schema.Literal('completed')),
};
const AssistantMessageItem = Schema.Struct({
  ...MessageFields,
  role: Schema.Literal('assistant'),
  phase: Schema.optionalKey(Schema.Literals(['commentary', 'final_answer'])),
});
const OtherMessageItem = Schema.Struct({
  ...MessageFields,
  role: Schema.Literals(['user', 'system', 'developer']),
});
const MessageItem = Schema.Union([AssistantMessageItem, OtherMessageItem]);

const FunctionCallItem = Schema.Struct({
  type: Schema.Literal('function_call'),
  call_id: CallId,
  name: ToolName,
  arguments: Schema.String,
  id: Schema.optionalKey(ItemId),
  status: Schema.optionalKey(Schema.Literal('completed')),
});

const FunctionCallOutputItem = Schema.Struct({
  type: Schema.Literal('function_call_output'),
  call_id: CallId,
  output: Schema.Union([Schema.String, Schema.Array(InputTextPart)]),
});

const ReasoningSummaryPart = Schema.Struct({
  type: Schema.Literal('summary_text'),
  text: Schema.String,
});
const ReasoningItem = Schema.Struct({
  type: Schema.Literal('reasoning'),
  id: ItemId,
  encrypted_content: BoundedString(MAX_ENCRYPTED_REASONING),
  summary: Schema.optionalKey(Schema.Array(ReasoningSummaryPart)),
  status: Schema.optionalKey(Schema.Literal('completed')),
});

const InputItem = Schema.Union([
  MessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ReasoningItem,
]);
const ResponsesInput = Schema.Union([
  Schema.String,
  Schema.Array(InputItem).check(Schema.isMaxLength(MAX_INPUT_ITEMS)),
]);

const FunctionTool = Schema.Struct({
  type: Schema.Literal('function'),
  name: ToolName,
  description: Schema.optionalKey(Schema.String),
  parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  strict: Schema.optionalKey(Schema.Boolean),
});
const ResponsesTools = Schema.Array(FunctionTool).check(Schema.isMaxLength(MAX_TOOLS));

const ResponsesInclude = Schema.Array(Schema.Literal('reasoning.encrypted_content')).check(
  Schema.isMaxLength(1),
);
const ResponsesText = Schema.Struct({
  format: Schema.optionalKey(Schema.Struct({ type: Schema.Literal('text') })),
  verbosity: Schema.optionalKey(Schema.Literals(['low', 'medium', 'high'])),
});
const ResponsesReasoning = Schema.Struct({
  effort: Schema.Literals(['minimal', 'low', 'medium', 'high']),
});
const MaxOutputTokens = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MAX_RESPONSES_OUTPUT_TOKENS),
);

const ResponsesRequest = Schema.Struct({
  model: Schema.NonEmptyString,
  input: ResponsesInput,
  instructions: Schema.optionalKey(BoundedString(MAX_INSTRUCTIONS_BYTES)),
  tools: Schema.optionalKey(ResponsesTools),
  include: Schema.optionalKey(ResponsesInclude),
  text: Schema.optionalKey(ResponsesText),
  prompt_cache_key: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(MAX_PROMPT_CACHE_KEY)),
  ),
  reasoning: Schema.optionalKey(ResponsesReasoning),
  max_output_tokens: Schema.optionalKey(MaxOutputTokens),
  stream: Schema.Literal(true),
  store: Schema.optionalKey(Schema.Literal(false)),
});

const decodeResponsesRequest = Schema.decodeUnknownOption(ResponsesRequest, {
  onExcessProperty: 'error',
});

export const validateResponsesBody = (raw: unknown): Record<string, unknown> | null => {
  const decoded = decodeResponsesRequest(raw);
  if (Option.isNone(decoded)) return null;
  return raw as Record<string, unknown>;
};

export const responsesUpstreamBody = (
  raw: Record<string, unknown>,
  route: FrozenRoute,
): Record<string, unknown> => ({
  ...raw,
  model: route.upstreamModel,
  store: false,
  stream: true,
});

const TokenNumber = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const ResponsesUsage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  input_tokens_details: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        cached_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
      }),
    ),
  ),
  output_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  output_tokens_details: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        reasoning_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
      }),
    ),
  ),
});
const ResponsesEvent = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
  response: Schema.optionalKey(
    Schema.Struct({
      status: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.Unknown),
      usage: Schema.optionalKey(Schema.Unknown),
      error: Schema.optionalKey(Schema.Unknown),
    }),
  ),
  usage: Schema.optionalKey(Schema.Unknown),
});
const decodeEventData = Schema.decodeUnknownOption(Schema.fromJsonString(ResponsesEvent), {
  onExcessProperty: 'ignore',
});
const decodeUsage = Schema.decodeUnknownOption(ResponsesUsage);

const observedTokens = (value: unknown): ObservedTokenFields => {
  const decoded = decodeUsage(value);
  if (Option.isNone(decoded)) return {};
  const usage = decoded.value;
  const observed: ObservedTokenFields = {};
  const put = (key: keyof ObservedTokenFields, count: number | null | undefined): void => {
    if (count !== null && count !== undefined) observed[key] = count;
  };
  put('inputTokens', usage.input_tokens);
  put('cacheReadTokens', usage.input_tokens_details?.cached_tokens);
  put('outputTokens', usage.output_tokens);
  put('reasoningTokens', usage.output_tokens_details?.reasoning_tokens);
  return observed;
};

export const observeResponsesFrame = (frame: SseFrame): StreamObservationDetails => {
  if (frame.data === '[DONE]') return { observation: 'ignore' };
  const decoded = decodeEventData(frame.data);
  if (Option.isNone(decoded)) return { observation: 'failure' };
  const value = decoded.value;
  const eventType = frame.event;
  const jsonType = value.type;
  const observed = observedTokens(value.response?.usage ?? value.usage);
  const model = modelIdentity(value.response?.model ?? value.model);
  const details = model === null ? { usage: observed } : { usage: observed, model };

  // A completed outcome requires agreement between the SSE event name and the
  // JSON type when both are present, plus response.status "completed".
  if (eventType !== undefined && jsonType !== undefined && eventType !== jsonType) {
    return { observation: 'failure', ...details };
  }
  const type = jsonType ?? eventType ?? '';
  const status = value.response?.status;
  const failed =
    type === 'error' ||
    type === 'response.failed' ||
    type === 'response.incomplete' ||
    value.error != null ||
    value.response?.error != null ||
    status === 'failed' ||
    status === 'incomplete';
  if (failed) return { observation: 'failure', ...details };

  const completed = type === 'response.completed';
  if (completed) {
    return status === 'completed'
      ? { observation: 'terminal', ...details }
      : { observation: 'failure', ...details };
  }
  // A nonterminal frame that claims a completed response is inconsistent.
  if (status === 'completed') return { observation: 'failure', ...details };
  return { observation: 'event', ...details };
};

export const ResponsesStreamAdapter: ProtocolStreamAdapter = {
  name: 'responses',
  maxTerminalBytes: MAX_RESPONSES_TERMINAL_BYTES,
  upstreamPath: () => '/responses',
  observe: observeResponsesFrame,
  encode: encodeSseFrame,
};

export const relayResponses = (options: Omit<ProtocolStreamOptions, 'adapter'>) =>
  relayProtocolStream({ ...options, adapter: ResponsesStreamAdapter });

export type ResponsesStreamOptions = Omit<ProtocolStreamOptions, 'adapter'>;

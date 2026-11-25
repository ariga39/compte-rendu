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
import {
  COMMON_FORBIDDEN_KEYS,
  hasAnyKey,
  isFunctionRef,
  isFunctionTool,
  isLocalInputTextPart,
  isLocalResponsesContentPart,
  isLocalToolChoice,
  isNonEmptyString,
  isRecord,
} from './request-boundary.ts';

export const MAX_RESPONSES_OUTPUT_TOKENS = 256_000;
// One terminal event repeats the full output. This is a policy ceiling, not a
// measured provider maximum. Workerd tests cover a successful terminal above
// 64 KiB, exactly this value, and one byte above (which fails closed). A
// realistic plain-text 256k-token turn is expected below 4 MiB, but larger
// provider output remains unmeasured until a pinned capture demonstrates it.
export const MAX_RESPONSES_TERMINAL_BYTES = 4 * 1024 * 1024;

const MAX_INSTRUCTIONS_BYTES = 1024 * 1024;
const MAX_TOOLS = 128;
const MAX_INPUT_ITEMS = 1024;
const MAX_ENCRYPTED_REASONING = 2 * 1024 * 1024;
const FORBIDDEN_RESPONSES_KEYS = [...COMMON_FORBIDDEN_KEYS, 'prompt'] as const;
const withinBytes = (value: string, bytes: number) =>
  new TextEncoder().encode(value).byteLength <= bytes;

const isMessageContent = (content: unknown): boolean =>
  typeof content === 'string' ||
  (Array.isArray(content) && content.every(isLocalResponsesContentPart));

const isInputItem = (item: unknown): boolean => {
  if (!isRecord(item)) return false;
  switch (item.type) {
    case undefined:
    case 'message':
      return (
        ['user', 'assistant', 'system', 'developer'].includes(item.role as string) &&
        isMessageContent(item.content)
      );
    case 'function_call':
      return (
        isNonEmptyString(item.call_id) && isFunctionRef(item) && typeof item.arguments === 'string'
      );
    case 'function_call_output':
      return (
        isNonEmptyString(item.call_id) &&
        (typeof item.output === 'string' ||
          (Array.isArray(item.output) && item.output.every(isLocalInputTextPart)))
      );
    case 'reasoning':
      return (
        isNonEmptyString(item.id) &&
        typeof item.encrypted_content === 'string' &&
        withinBytes(item.encrypted_content, MAX_ENCRYPTED_REASONING)
      );
    default:
      return false;
  }
};

export const validateResponsesBody = (raw: unknown): Record<string, unknown> | null => {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.model) || raw.stream !== true) return null;
  if (raw.store !== undefined && raw.store !== false) return null;
  if (hasAnyKey(raw, FORBIDDEN_RESPONSES_KEYS)) return null;
  if (
    raw.instructions !== undefined &&
    (typeof raw.instructions !== 'string' || !withinBytes(raw.instructions, MAX_INSTRUCTIONS_BYTES))
  )
    return null;
  if (
    raw.max_output_tokens !== undefined &&
    (!Number.isInteger(raw.max_output_tokens) ||
      (raw.max_output_tokens as number) < 1 ||
      (raw.max_output_tokens as number) > MAX_RESPONSES_OUTPUT_TOKENS)
  )
    return null;
  if (
    raw.include !== undefined &&
    (!Array.isArray(raw.include) ||
      raw.include.length > 1 ||
      !raw.include.every((item) => item === 'reasoning.encrypted_content'))
  )
    return null;
  if (
    raw.tools !== undefined &&
    (!Array.isArray(raw.tools) ||
      raw.tools.length > MAX_TOOLS ||
      !raw.tools.every((tool) => isFunctionTool(tool, false)))
  )
    return null;
  if (!isLocalToolChoice(raw.tool_choice, false)) return null;
  const input = raw.input;
  if (
    typeof input !== 'string' &&
    !(Array.isArray(input) && input.length <= MAX_INPUT_ITEMS && input.every(isInputItem))
  )
    return null;
  return raw;
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
  maxTerminalBytes: MAX_RESPONSES_TERMINAL_BYTES,
  upstreamPath: () => '/responses',
  observe: observeResponsesFrame,
  encode: encodeSseFrame,
};

export const relayResponses = (options: Omit<ProtocolStreamOptions, 'adapter'>) =>
  relayProtocolStream({ ...options, adapter: ResponsesStreamAdapter });

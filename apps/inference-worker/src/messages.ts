import { Option, Schema } from 'effect';
import { modelIdentity, type ObservedTokenFields } from '@compte-rendu/contracts';
import type { GatewayPath } from './gateway.ts';
import {
  encodeSseFrame,
  relayProtocolStream,
  type ProtocolStreamAdapter,
  type ProtocolStreamOptions,
} from './protocol-stream.ts';
import type { FrozenRoute } from './routes.ts';

// The terminal message_stop frame is tiny; usage arrives earlier. Keep Chat's
// conservative trailing-frame bound.
const MAX_MESSAGES_TERMINAL_BYTES = 64 * 1024;
const MAX_TOOLS = 128;
const MAX_MESSAGES = 1024;
const MAX_TOKENS = 1_000_000;

const TokenNumber = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const MaxTokens = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MAX_TOKENS),
);

const CacheControl = Schema.Struct({
  type: Schema.Literal('ephemeral'),
  ttl: Schema.optionalKey(Schema.Literals(['5m', '1h'])),
});
const TextBlock = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
  cache_control: Schema.optionalKey(CacheControl),
});
const ThinkingBlock = Schema.Struct({
  type: Schema.Literal('thinking'),
  thinking: Schema.String,
  signature: Schema.NonEmptyString,
});
const RedactedThinkingBlock = Schema.Struct({
  type: Schema.Literal('redacted_thinking'),
  data: Schema.NonEmptyString,
});
const ToolUseBlock = Schema.Struct({
  type: Schema.Literal('tool_use'),
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  input: Schema.Record(Schema.String, Schema.Unknown),
  cache_control: Schema.optionalKey(CacheControl),
});
const ToolResultBlock = Schema.Struct({
  type: Schema.Literal('tool_result'),
  tool_use_id: Schema.NonEmptyString,
  content: Schema.Union([Schema.String, Schema.Array(TextBlock)]),
  is_error: Schema.optionalKey(Schema.Boolean),
  cache_control: Schema.optionalKey(CacheControl),
});
const UserBlock = Schema.Union([TextBlock, ToolResultBlock]);
const AssistantBlock = Schema.Union([
  TextBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  ToolUseBlock,
]);
const UserMessage = Schema.Struct({
  role: Schema.Literal('user'),
  content: Schema.Union([Schema.String, Schema.Array(UserBlock)]),
});
const AssistantMessage = Schema.Struct({
  role: Schema.Literal('assistant'),
  content: Schema.Union([Schema.String, Schema.Array(AssistantBlock)]),
});
const MessagesSystem = Schema.Union([Schema.String, Schema.Array(TextBlock)]);
const MessagesTool = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  input_schema: Schema.Record(Schema.String, Schema.Unknown),
  cache_control: Schema.optionalKey(CacheControl),
});
const ToolChoice = Schema.Struct({
  type: Schema.Literals(['auto', 'any', 'none', 'tool']),
  name: Schema.optionalKey(Schema.NonEmptyString),
  disable_parallel_tool_use: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter((choice) => (choice.type === 'tool') === (choice.name !== undefined), {
    expected: 'tool_choice name required only for type tool',
  }),
);
const Thinking = Schema.Struct({
  type: Schema.Literals(['enabled', 'disabled', 'adaptive']),
  budget_tokens: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1024), Schema.isLessThanOrEqualTo(MAX_TOKENS)),
  ),
  display: Schema.optionalKey(Schema.Literals(['summarized', 'omitted'])),
});
const Metadata = Schema.Struct({ user_id: Schema.optionalKey(Schema.String) });

const MessagesRequest = Schema.Struct({
  model: Schema.NonEmptyString,
  system: Schema.optionalKey(MessagesSystem),
  messages: Schema.Array(Schema.Union([UserMessage, AssistantMessage])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_MESSAGES),
  ),
  tools: Schema.optionalKey(Schema.Array(MessagesTool).check(Schema.isMaxLength(MAX_TOOLS))),
  tool_choice: Schema.optionalKey(ToolChoice),
  stream: Schema.Literal(true),
  max_tokens: Schema.optionalKey(MaxTokens),
  temperature: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2)),
  ),
  top_p: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  ),
  top_k: Schema.optionalKey(TokenNumber),
  stop_sequences: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(16))),
  metadata: Schema.optionalKey(Metadata),
  thinking: Schema.optionalKey(Thinking),
  service_tier: Schema.optionalKey(Schema.Literals(['auto', 'standard_only'])),
});
const decodeMessagesRequest = Schema.decodeUnknownOption(MessagesRequest, {
  onExcessProperty: 'error',
});

export const validateMessagesBody = (raw: unknown): Record<string, unknown> | null =>
  Option.isNone(decodeMessagesRequest(raw)) ? null : (raw as Record<string, unknown>);

export const selectMessagesRoute = <Route extends FrozenRoute>(
  routes: readonly Route[],
  body: Record<string, unknown>,
): Route | null => {
  const model = body.model;
  if (typeof model !== 'string') return null;
  return routes.find((route) => route.routeId === model && route.profile === 'messages') ?? null;
};

export const buildMessagesUpstreamBody = (
  route: FrozenRoute,
  body: Record<string, unknown>,
): Record<string, unknown> => ({ ...body, model: route.upstreamModel, stream: true });

const messagesUpstreamHeaders: Record<string, string> = {
  'anthropic-version': '2023-06-01',
};

const Usage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  output_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  cache_read_input_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
});
const decodeUsage = Schema.decodeUnknownOption(Usage);
const MessageStart = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(
    Schema.Struct({
      model: Schema.optionalKey(Schema.Unknown),
      usage: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});
const MessageDelta = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  delta: Schema.optionalKey(
    Schema.Struct({ stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
  usage: Schema.optionalKey(Schema.Unknown),
});
const MessageStop = Schema.Struct({ type: Schema.Literal('message_stop') });
const decodeMessageStart = Schema.decodeUnknownOption(Schema.fromJsonString(MessageStart), {
  onExcessProperty: 'ignore',
});
const decodeMessageDelta = Schema.decodeUnknownOption(Schema.fromJsonString(MessageDelta), {
  onExcessProperty: 'ignore',
});
const decodeMessageStop = Schema.decodeUnknownOption(Schema.fromJsonString(MessageStop), {
  onExcessProperty: 'ignore',
});

// Anthropic defines total input as input_tokens + cache creation + cache read:
// https://platform.claude.com/docs/en/api/messages (Usage).
const observedTokens = (value: unknown): ObservedTokenFields => {
  const decoded = decodeUsage(value);
  if (Option.isNone(decoded)) return {};
  const usage = decoded.value;
  const observed: ObservedTokenFields = {};
  const input = usage.input_tokens;
  const read = usage.cache_read_input_tokens;
  const write = usage.cache_creation_input_tokens;
  if (input !== null && input !== undefined)
    observed.inputTokens = input + (read ?? 0) + (write ?? 0);
  if (read !== null && read !== undefined) observed.cacheReadTokens = read;
  if (write !== null && write !== undefined) observed.cacheWriteTokens = write;
  if (usage.output_tokens !== null && usage.output_tokens !== undefined)
    observed.outputTokens = usage.output_tokens;
  return observed;
};

const completeStops = new Set(['end_turn', 'stop_sequence', 'tool_use', 'refusal']);

const createMessagesAdapter = (): ProtocolStreamAdapter => {
  let stopReason: string | null | undefined;
  return {
    maxTerminalBytes: MAX_MESSAGES_TERMINAL_BYTES,
    upstreamPath: (): GatewayPath => '/messages',
    headers: () => messagesUpstreamHeaders,
    create: createMessagesAdapter,
    encode: encodeSseFrame,
    observe(frame) {
      if (frame.event === 'ping') return { observation: 'ignore' };
      if (frame.event === 'error') return { observation: 'failure' };
      if (frame.event === 'message_start') {
        const decoded = decodeMessageStart(frame.data);
        if (Option.isNone(decoded)) return { observation: 'failure' };
        const usage = observedTokens(decoded.value.message?.usage);
        const model = modelIdentity(decoded.value.message?.model);
        return {
          observation: 'event',
          ...(Object.keys(usage).length === 0 ? {} : { usage }),
          ...(model === null ? {} : { model }),
        };
      }
      if (frame.event === 'message_delta') {
        const decoded = decodeMessageDelta(frame.data);
        if (Option.isNone(decoded)) return { observation: 'failure' };
        const usage = observedTokens(decoded.value.usage);
        stopReason = decoded.value.delta?.stop_reason ?? null;
        const failure = stopReason !== null && !completeStops.has(stopReason);
        return {
          observation: failure ? 'failure' : 'event',
          ...(Object.keys(usage).length === 0 ? {} : { usage }),
        };
      }
      if (
        frame.event === 'content_block_start' ||
        frame.event === 'content_block_delta' ||
        frame.event === 'content_block_stop'
      )
        return { observation: 'event' };
      if (frame.event === 'message_stop') {
        if (Option.isNone(decodeMessageStop(frame.data))) return { observation: 'failure' };
        if (stopReason === undefined || stopReason === null || !completeStops.has(stopReason))
          return { observation: 'failure' };
        return { observation: 'terminal' };
      }
      return { observation: 'failure' };
    },
  };
};

export const messagesAdapter = createMessagesAdapter();

export type MessagesStreamOptions = Omit<ProtocolStreamOptions, 'adapter'>;

export const relayMessages = (options: MessagesStreamOptions) =>
  relayProtocolStream({ ...options, adapter: messagesAdapter });

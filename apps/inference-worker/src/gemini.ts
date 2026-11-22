import { Option, Schema } from 'effect';
import { modelIdentity, type ObservedTokenFields } from '@compte-rendu/contracts';
import type { GatewayPath } from './gateway.ts';
import {
  encodeSseFrame,
  relayProtocolStream,
  type ProtocolStreamAdapter,
  type ProtocolStreamOptions,
  type SseFrame,
  type StreamObservationDetails,
} from './protocol-stream.ts';
import { isGeminiUpstreamModel, type FrozenRoute } from './routes.ts';

const GEMINI_HANDLE_PREFIX = 'r-';
const GEMINI_STREAM_SUFFIX = ':streamGenerateContent';
const GEMINI_PATH_PREFIX = '/v1beta/models/';
const GEMINI_GATEWAY_PATH = '/models';
// One Gemini terminal frame can carry the final text for the whole turn. Keep
// an independent hold ceiling above the supported output instead of inheriting
// Chat's small trailing-frame limit.
const MAX_GEMINI_TERMINAL_BYTES = 2 * 1024 * 1024;
const MAX_TOOLS = 128;
const MAX_TOKENS = 1_000_000;

const TokenNumber = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const MaxOutputTokens = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MAX_TOKENS),
);
const Signature = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isPattern(/^[A-Za-z0-9+/=_-]+$/),
);

const UserTextPart = Schema.Struct({ text: Schema.String });
const ModelTextPart = Schema.Struct({
  text: Schema.String,
  thought: Schema.optionalKey(Schema.Boolean),
  thoughtSignature: Schema.optionalKey(Signature),
});
const FunctionCallPart = Schema.Struct({
  functionCall: Schema.Struct({
    id: Schema.optionalKey(Schema.NonEmptyString),
    name: Schema.NonEmptyString,
    args: Schema.Record(Schema.String, Schema.Unknown),
  }),
  thoughtSignature: Schema.optionalKey(Signature),
});
const FunctionResponsePart = Schema.Struct({
  functionResponse: Schema.Struct({
    id: Schema.optionalKey(Schema.NonEmptyString),
    name: Schema.NonEmptyString,
    response: Schema.Record(Schema.String, Schema.Unknown),
  }),
});
const UserPart = Schema.Union([UserTextPart, FunctionResponsePart]);
const ModelPart = Schema.Union([ModelTextPart, FunctionCallPart]);

const UserContent = Schema.Struct({
  role: Schema.Literal('user'),
  parts: Schema.Array(UserPart).check(Schema.isMinLength(1)),
});
const ModelContent = Schema.Struct({
  role: Schema.Literal('model'),
  parts: Schema.Array(ModelPart).check(Schema.isMinLength(1)),
});
const GeminiContent = Schema.Union([UserContent, ModelContent]);
const SystemInstruction = Schema.Struct({
  parts: Schema.Array(Schema.Struct({ text: Schema.String })).check(Schema.isMinLength(1)),
});
const FunctionDeclaration = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  parametersJsonSchema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const GeminiTool = Schema.Struct({
  functionDeclarations: Schema.Array(FunctionDeclaration).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_TOOLS),
  ),
});
const ToolConfig = Schema.Struct({
  functionCallingConfig: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(Schema.Literals(['AUTO', 'ANY', 'NONE'])),
      allowedFunctionNames: Schema.optionalKey(
        Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(MAX_TOOLS)),
      ),
    }),
  ),
});
const GenerationConfig = Schema.Struct({
  maxOutputTokens: Schema.optionalKey(MaxOutputTokens),
  temperature: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2)),
  ),
  topP: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  ),
  topK: Schema.optionalKey(TokenNumber),
  stopSequences: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(16))),
  seed: Schema.optionalKey(TokenNumber),
  presencePenalty: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(-2), Schema.isLessThanOrEqualTo(2)),
  ),
  frequencyPenalty: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(-2), Schema.isLessThanOrEqualTo(2)),
  ),
  thinkingConfig: Schema.optionalKey(
    Schema.Struct({
      includeThoughts: Schema.optionalKey(Schema.Boolean),
      thinkingBudget: Schema.optionalKey(TokenNumber),
    }),
  ),
});

const GeminiRequest = Schema.Struct({
  contents: Schema.Array(GeminiContent).check(Schema.isMinLength(1)),
  systemInstruction: Schema.optionalKey(SystemInstruction),
  tools: Schema.optionalKey(Schema.Array(GeminiTool).check(Schema.isMaxLength(MAX_TOOLS))),
  toolConfig: Schema.optionalKey(ToolConfig),
  generationConfig: Schema.optionalKey(GenerationConfig),
});
const decodeGeminiRequest = Schema.decodeUnknownOption(GeminiRequest, {
  onExcessProperty: 'error',
});

export const validateGeminiBody = (raw: unknown): Record<string, unknown> | null =>
  Option.isNone(decodeGeminiRequest(raw)) ? null : (raw as Record<string, unknown>);

const base64urlUtf8 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

// The pinned Gemini SDK places the model identity in the URL path. Runner writes
// this opaque handle as the wire modelID while the local OpenCode key stays the
// route ID, so the relay never decodes a path or interprets it as a URL.
export const geminiRouteHandle = (routeId: string): string =>
  `${GEMINI_HANDLE_PREFIX}${base64urlUtf8(routeId)}`;

const HANDLE = /^r-[A-Za-z0-9_-]{1,256}$/;

export const parseGeminiPath = (pathname: string): string | null => {
  if (!pathname.startsWith(GEMINI_PATH_PREFIX) || !pathname.endsWith(GEMINI_STREAM_SUFFIX))
    return null;
  const handle = pathname.slice(GEMINI_PATH_PREFIX.length, -GEMINI_STREAM_SUFFIX.length);
  return HANDLE.test(handle) ? handle : null;
};

export const isGeminiStreamQuery = (search: string): boolean =>
  search === '' || search === '?alt=sse';

export const selectGeminiRoute = <Route extends FrozenRoute>(
  routes: readonly Route[],
  handle: string,
): Route | null =>
  routes.find(
    (route) =>
      route.profile === 'gemini' &&
      isGeminiUpstreamModel(route.upstreamModel) &&
      geminiRouteHandle(route.routeId) === handle,
  ) ?? null;

const geminiUpstreamPath = (route: FrozenRoute): GatewayPath => {
  if (!isGeminiUpstreamModel(route.upstreamModel)) throw new Error('invalid Gemini upstream model');
  return `${GEMINI_GATEWAY_PATH}/${route.upstreamModel}${GEMINI_STREAM_SUFFIX}?alt=sse`;
};

const GeminiUsage = Schema.Struct({
  promptTokenCount: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  cachedContentTokenCount: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  candidatesTokenCount: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  thoughtsTokenCount: Schema.optionalKey(Schema.NullOr(TokenNumber)),
});
const decodeUsage = Schema.decodeUnknownOption(GeminiUsage);
const GeminiFrame = Schema.Struct({
  error: Schema.optionalKey(Schema.Unknown),
  candidates: Schema.optionalKey(
    Schema.Array(Schema.Struct({ finishReason: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
  usageMetadata: Schema.optionalKey(Schema.Unknown),
  modelVersion: Schema.optionalKey(Schema.Unknown),
  promptFeedback: Schema.optionalKey(
    Schema.Struct({ blockReason: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
});
const decodeGeminiFrame = Schema.decodeUnknownOption(Schema.fromJsonString(GeminiFrame), {
  onExcessProperty: 'ignore',
});

// Gemini reports thoughts separately from candidates, while total output includes
// both: https://ai.google.dev/api/generate-content#UsageMetadata.
const observedTokens = (value: unknown): ObservedTokenFields => {
  const decoded = decodeUsage(value);
  if (Option.isNone(decoded)) return {};
  const usage = decoded.value;
  const observed: ObservedTokenFields = {};
  if (usage.promptTokenCount !== null && usage.promptTokenCount !== undefined)
    observed.inputTokens = usage.promptTokenCount;
  if (usage.cachedContentTokenCount !== null && usage.cachedContentTokenCount !== undefined)
    observed.cacheReadTokens = usage.cachedContentTokenCount;
  const candidates = usage.candidatesTokenCount;
  const thoughts = usage.thoughtsTokenCount;
  if (candidates !== null && candidates !== undefined)
    observed.outputTokens = candidates + (thoughts ?? 0);
  else if (thoughts !== null && thoughts !== undefined) observed.outputTokens = thoughts;
  if (thoughts !== null && thoughts !== undefined) observed.reasoningTokens = thoughts;
  return observed;
};

const observeGeminiFrame = (frame: SseFrame): StreamObservationDetails => {
  if (frame.event === 'error') return { observation: 'failure' };
  const decoded = decodeGeminiFrame(frame.data);
  if (Option.isNone(decoded)) return { observation: 'failure' };
  const value = decoded.value;
  const usage = observedTokens(value.usageMetadata);
  const model = modelIdentity(value.modelVersion);
  const details = {
    ...(Object.keys(usage).length === 0 ? {} : { usage }),
    ...(model === null ? {} : { model }),
  };
  if (value.error !== undefined || value.promptFeedback?.blockReason != null)
    return { observation: 'failure', ...details };
  const candidates = value.candidates ?? [];
  if (candidates.length > 1) return { observation: 'failure', ...details };
  const finish = candidates[0]?.finishReason;
  if (finish === null || finish === undefined || finish === '')
    return { observation: 'event', ...details };
  if (finish === 'STOP') return { observation: 'terminal', ...details };
  return { observation: 'failure', ...details };
};

export const geminiAdapter: ProtocolStreamAdapter = {
  name: 'gemini',
  maxTerminalBytes: MAX_GEMINI_TERMINAL_BYTES,
  upstreamPath: (route) => geminiUpstreamPath(route),
  observe: observeGeminiFrame,
  encode: encodeSseFrame,
};

export type GeminiStreamOptions = Omit<ProtocolStreamOptions, 'adapter'>;

export const relayGemini = (options: GeminiStreamOptions) =>
  relayProtocolStream({ ...options, adapter: geminiAdapter });

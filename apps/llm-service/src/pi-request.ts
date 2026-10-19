import { Option, Predicate, Schema } from 'effect';
import {
  normalizeContext,
  type AssistantMessage,
  type Context,
  type ImageContent,
  type Message,
  type TextContent,
  type Tool,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from '@earendil-works/pi-ai';

export class UnsupportedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedRequestError';
  }
}

export interface PiTarget {
  readonly provider: string;
  readonly api: string;
  readonly model: string;
}

export interface PreparedPiRequest {
  readonly context: TranscriptContext;
  readonly options: Record<string, unknown>;
  readonly patch?: (payload: Record<string, unknown>) => Record<string, unknown>;
}

function unsupported(message: string): never {
  throw new UnsupportedRequestError(message);
}

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const textContent = (value: unknown, what: string): TextContent[] => {
  if (typeof value === 'string') return value.length > 0 ? [{ type: 'text', text: value }] : [];
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (
        !Predicate.isObject(part) ||
        (part.type !== 'text' && part.type !== 'input_text' && part.type !== 'output_text') ||
        typeof part.text !== 'string'
      )
        return unsupported(`${what} content must be text`);
      return { type: 'text' as const, text: part.text };
    });
  }
  return unsupported(`${what} content must be a string or text parts`);
};

const textOf = (value: unknown, what: string): string =>
  textContent(value, what)
    .map((part) => part.text)
    .join('');

const assistantContent = (value: unknown): TextContent[] =>
  value === null || value === undefined ? [] : textContent(value, 'assistant');

const userContent = (value: unknown): string | (TextContent | ImageContent)[] => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return unsupported('user content must be a string or parts');
  const parts = value.map((part): TextContent | ImageContent => {
    if (!Predicate.isObject(part)) return unsupported('user content part must be an object');
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string')
      return { type: 'text', text: part.text };
    if (
      part.type === 'image_url' &&
      Predicate.isObject(part.image_url) &&
      typeof part.image_url.url === 'string'
    ) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url);
      if (match === null) return unsupported('user image_url must be a base64 data URL');
      return {
        type: 'image',
        data: match[2] ?? '',
        mimeType: match[1] ?? 'application/octet-stream',
      };
    }
    return unsupported('unsupported user content part');
  });
  return parts;
};

const parseJsonObject = (raw: unknown, what: string): Record<string, unknown> => {
  if (typeof raw !== 'string') return unsupported(`${what} must be a JSON string`);
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unsupported(`${what} must be valid JSON`);
  }
  if (!Predicate.isObject(parsed)) return unsupported(`${what} must be a JSON object`);
  return parsed;
};

const chatReasoningDetailFields = {
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  format: Schema.optionalKey(Schema.String),
  index: Schema.optionalKey(Schema.Number),
};

const ChatReasoningDetail = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      ...chatReasoningDetailFields,
      type: Schema.Literal('reasoning.summary'),
      summary: Schema.String,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      ...chatReasoningDetailFields,
      type: Schema.Literal('reasoning.encrypted'),
      data: Schema.String,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      ...chatReasoningDetailFields,
      type: Schema.Literal('reasoning.text'),
      text: Schema.String,
      signature: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
]);

const chatReasoningDetails = (value: unknown): readonly unknown[] | undefined =>
  Schema.decodeUnknownOption(Schema.Array(ChatReasoningDetail))(value).pipe(
    Option.filter((details) => details.length > 0),
    Option.getOrUndefined,
  );

const parseToolCalls = (value: unknown): ToolCall[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return unsupported('assistant tool_calls must be an array');
  return value.map((call) => {
    if (
      !Predicate.isObject(call) ||
      call.type !== 'function' ||
      typeof call.id !== 'string' ||
      call.id.length === 0 ||
      !Predicate.isObject(call.function) ||
      typeof call.function.name !== 'string' ||
      call.function.name.length === 0
    )
      return unsupported('assistant tool_calls must contain function calls');
    return {
      type: 'toolCall',
      id: call.id,
      name: call.function.name,
      arguments: parseJsonObject(
        call.function.arguments,
        'tool call arguments',
      ) as ToolCall['arguments'],
    };
  });
};

const maxTokens = (body: Record<string, unknown>): number | undefined => {
  const first = body.max_tokens;
  const second = body.max_completion_tokens;
  if (first !== undefined && second !== undefined && first !== second)
    unsupported('max_tokens and max_completion_tokens cannot both be set');
  const value = first ?? second;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    unsupported('max tokens must be a positive number');
  return value;
};

const strictPatch = (strictByName: ReadonlyMap<string, boolean>) =>
  strictByName.size === 0
    ? undefined
    : (payload: Record<string, unknown>): Record<string, unknown> => {
        if (!Array.isArray(payload.tools)) return payload;
        return {
          ...payload,
          tools: payload.tools.map((tool) => {
            if (!Predicate.isObject(tool)) return tool;
            if (Predicate.isObject(tool.function) && typeof tool.function.name === 'string') {
              const strict = strictByName.get(tool.function.name);
              if (strict === undefined) return tool;
              return { ...tool, function: { ...tool.function, strict } };
            }
            if (typeof tool.name === 'string') {
              const strict = strictByName.get(tool.name);
              if (strict === undefined) return tool;
              return { ...tool, strict };
            }
            return tool;
          }),
        };
      };

const chatTools = (value: unknown): { tools: Tool[]; strictByName: Map<string, boolean> } => {
  const tools: Tool[] = [];
  const strictByName = new Map<string, boolean>();
  if (value === undefined) return { tools, strictByName };
  if (!Array.isArray(value)) unsupported('tools must be an array');
  for (const tool of value) {
    if (!Predicate.isObject(tool) || tool.type !== 'function' || !Predicate.isObject(tool.function))
      unsupported('only client function tools are supported');
    const fn = tool.function;
    if (typeof fn.name !== 'string' || fn.name.length === 0) unsupported('tool name required');
    const parameters =
      fn.parameters === undefined ? { type: 'object', properties: {} } : fn.parameters;
    if (!Predicate.isObject(parameters)) unsupported('tool parameters must be an object');
    tools.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: parameters as Tool['parameters'],
    });
    if (typeof fn.strict === 'boolean') strictByName.set(fn.name, fn.strict);
  }
  return { tools, strictByName };
};

export const prepareChatCompletions = (
  target: PiTarget,
  body: Record<string, unknown>,
): PreparedPiRequest => {
  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages)) unsupported('messages must be an array');
  const { tools, strictByName } = chatTools(body.tools);
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();
  for (const raw of rawMessages) {
    if (!Predicate.isObject(raw)) unsupported('message must be an object');
    if (raw.role === 'system' || raw.role === 'developer') {
      messages.push({
        role: 'system',
        content: textOf(raw.content, 'system'),
        timestamp: Date.now(),
      });
      continue;
    }
    if (raw.role === 'user') {
      const content = userContent(raw.content);
      if (Array.isArray(content) && content.length === 0) continue;
      messages.push({ role: 'user', content, timestamp: Date.now() });
      continue;
    }
    if (raw.role === 'assistant') {
      const reasoning = Schema.decodeUnknownSync(Schema.optional(Schema.NullOr(Schema.String)))(
        raw.reasoning_content,
      );
      const details = chatReasoningDetails(raw.reasoning_details);
      const thinking =
        details !== undefined
          ? [
              {
                type: 'thinking' as const,
                thinking: reasoning ?? '',
                thinkingSignature: JSON.stringify(details),
              },
            ]
          : reasoning === undefined || reasoning === null
            ? []
            : [
                {
                  type: 'thinking' as const,
                  thinking: reasoning,
                  thinkingSignature: 'reasoning_content',
                },
              ];
      const calls = parseToolCalls(raw.tool_calls);
      for (const call of calls) toolNames.set(call.id, call.name);
      messages.push({
        role: 'assistant',
        content: [...thinking, ...assistantContent(raw.content), ...calls],
        api: target.api,
        provider: target.provider,
        model: target.model,
        usage: emptyUsage(),
        stopReason: calls.length > 0 ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      });
      continue;
    }
    if (raw.role === 'tool') {
      if (typeof raw.tool_call_id !== 'string' || raw.tool_call_id.length === 0)
        unsupported('tool result requires tool_call_id');
      const name =
        typeof raw.name === 'string' && raw.name.length > 0
          ? raw.name
          : toolNames.get(raw.tool_call_id);
      if (name === undefined) unsupported('tool result references an unknown tool call');
      messages.push({
        role: 'toolResult',
        toolCallId: raw.tool_call_id,
        toolName: name,
        content: textContent(raw.content, 'tool'),
        isError: false,
        timestamp: Date.now(),
      });
      continue;
    }
    unsupported('unsupported message role');
  }

  const contextInput: Context = tools.length > 0 ? { messages, tools } : { messages };
  const options: Record<string, unknown> = {};
  if (body.temperature !== undefined) options.temperature = body.temperature;
  const max = maxTokens(body);
  if (max !== undefined) options.maxTokens = max;
  const sampling: Record<string, unknown> = {};
  for (const key of [
    'top_p',
    'stop',
    'frequency_penalty',
    'presence_penalty',
    'seed',
    'response_format',
    'parallel_tool_calls',
    'reasoning_effort',
    'tool_choice',
  ] as const) {
    if (body[key] !== undefined) sampling[key] = body[key];
  }
  if (body.stream_options !== undefined) {
    if (!Predicate.isObject(body.stream_options)) unsupported('stream_options must be an object');
    sampling.stream_options = { include_usage: true };
  }
  if (Object.keys(sampling).length > 0) options.samplingParams = sampling;

  const strict = strictPatch(strictByName);
  const explicitMaxField =
    body.max_tokens !== undefined
      ? 'max_tokens'
      : body.max_completion_tokens !== undefined
        ? 'max_completion_tokens'
        : undefined;
  const patch =
    strict === undefined && explicitMaxField === undefined
      ? undefined
      : (payload: Record<string, unknown>): Record<string, unknown> => {
          const next = strict === undefined ? { ...payload } : strict(payload);
          if (explicitMaxField !== undefined) {
            next[explicitMaxField] = max;
            delete next[explicitMaxField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'];
          }
          return next;
        };

  return { context: normalizeContext(contextInput), options, patch };
};

interface ResponsesToolSet {
  readonly tools: Tool[];
  readonly strictByName: Map<string, boolean>;
  readonly grammar: boolean;
}

const responsesTools = (value: unknown): ResponsesToolSet => {
  const tools: Tool[] = [];
  const strictByName = new Map<string, boolean>();
  let grammar = false;
  if (value === undefined) return { tools, strictByName, grammar };
  if (!Array.isArray(value)) unsupported('tools must be an array');
  for (const tool of value) {
    if (!Predicate.isObject(tool) || typeof tool.name !== 'string' || tool.name.length === 0)
      unsupported('tool name required');
    const description = typeof tool.description === 'string' ? tool.description : '';
    if (tool.type === 'function') {
      const parameters =
        tool.parameters === undefined ? { type: 'object', properties: {} } : tool.parameters;
      if (!Predicate.isObject(parameters)) unsupported('tool parameters must be an object');
      tools.push({ name: tool.name, description, parameters: parameters as Tool['parameters'] });
      if (typeof tool.strict === 'boolean') strictByName.set(tool.name, tool.strict);
      continue;
    }
    if (tool.type === 'custom') {
      if (tool.format === undefined) {
        tools.push({
          name: tool.name,
          description,
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
          } as Tool['parameters'],
        });
        continue;
      }
      if (
        !Predicate.isObject(tool.format) ||
        tool.format.type !== 'grammar' ||
        typeof tool.format.syntax !== 'string' ||
        typeof tool.format.definition !== 'string'
      )
        unsupported('custom tools require a grammar format');
      if (tool.format.syntax !== 'lark' && tool.format.syntax !== 'regex')
        unsupported('unsupported custom tool grammar syntax');
      grammar = true;
      tools.push({
        name: tool.name,
        description,
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        } as Tool['parameters'],
        constrainedSampling: {
          type: 'grammar',
          variants:
            tool.format.syntax === 'lark'
              ? { openai_lark: tool.format.definition }
              : { openai_regex: tool.format.definition },
        },
      });
      continue;
    }
    unsupported('unsupported tool type');
  }
  return { tools, strictByName, grammar };
};

const ResponsesReasoningItem = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literal('reasoning'),
    id: Schema.optionalKey(Schema.String),
    encrypted_content: Schema.optionalKey(Schema.String),
    summary: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const reasoningText = (parts: readonly unknown[] | undefined): string =>
  (parts ?? [])
    .flatMap((part) =>
      Predicate.isObject(part) && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('\n\n');

const ResponsesAssistantMessage = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  phase: Schema.optionalKey(Schema.String),
});

const textSignature = (item: Record<string, unknown>): string | undefined => {
  const decoded = Schema.decodeUnknownOption(ResponsesAssistantMessage)(item);
  if (Option.isNone(decoded) || decoded.value.id === undefined) return undefined;
  const { id, phase } = decoded.value;
  const knownPhase = phase === 'commentary' || phase === 'final_answer' ? phase : undefined;
  return JSON.stringify({ v: 1, id, ...(knownPhase === undefined ? {} : { phase: knownPhase }) });
};

const signedAssistantContent = (content: unknown, signature: string | undefined): TextContent[] => {
  const parts = assistantContent(content);
  if (signature === undefined) return parts;
  const first = parts.findIndex((part) => part.type === 'text');
  if (first === -1) return parts;
  return parts.map((part, index) =>
    index === first ? { ...part, textSignature: signature } : part,
  );
};

const reasoningThinking = (value: unknown) => {
  const item = Schema.decodeUnknownSync(ResponsesReasoningItem)(value);
  const summary = reasoningText(item.summary);
  return {
    type: 'thinking' as const,
    thinking: summary.length > 0 ? summary : reasoningText(item.content),
    thinkingSignature: JSON.stringify(item),
  };
};

const responsesMessages = (target: PiTarget, input: unknown): Message[] => {
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();
  const callIds = new Map<string, string>();
  const appendAssistant = (): AssistantMessage => {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: target.api,
      provider: target.provider,
      model: target.model,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    messages.push(message);
    return message;
  };
  let pending: AssistantMessage | undefined;

  if (typeof input === 'string') {
    if (input.length > 0) messages.push({ role: 'user', content: input, timestamp: Date.now() });
    return messages;
  }
  if (!Array.isArray(input)) unsupported('input must be a string or an array');
  for (const item of input) {
    if (!Predicate.isObject(item)) unsupported('input item must be an object');
    if (item.type === undefined || item.type === 'message') {
      const content = item.content;
      if (item.role === 'system' || item.role === 'developer') {
        pending = undefined;
        messages.push({
          role: 'system',
          content: textOf(content, 'system'),
          timestamp: Date.now(),
        });
        continue;
      }
      if (item.role === 'user') {
        pending = undefined;
        const value = userContent(content);
        if (Array.isArray(value) && value.length === 0) continue;
        messages.push({ role: 'user', content: value, timestamp: Date.now() });
        continue;
      }
      if (item.role === 'assistant') {
        pending ??= appendAssistant();
        pending.content.push(...signedAssistantContent(content, textSignature(item)));
        continue;
      }
      unsupported('unsupported message role');
    }
    if (item.type === 'reasoning') {
      pending ??= appendAssistant();
      pending.content.push(reasoningThinking(item));
      continue;
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (typeof item.call_id !== 'string' || item.call_id.length === 0)
        unsupported('tool call requires call_id');
      if (typeof item.name !== 'string' || item.name.length === 0)
        unsupported('tool call requires a name');
      const itemId = typeof item.id === 'string' && item.id.length > 0 ? item.id : undefined;
      const id = itemId === undefined ? item.call_id : `${item.call_id}|${itemId}`;
      let call: ToolCall;
      if (item.type === 'function_call') {
        call = {
          type: 'toolCall',
          id,
          name: item.name,
          arguments: parseJsonObject(
            item.arguments,
            'tool call arguments',
          ) as ToolCall['arguments'],
        };
      } else {
        if (typeof item.input !== 'string') unsupported('custom tool call input must be a string');
        call = {
          type: 'toolCall',
          id,
          name: item.name,
          arguments: { input: item.input },
        };
      }
      toolNames.set(item.call_id, call.name);
      callIds.set(item.call_id, call.id);
      if (pending === undefined) pending = appendAssistant();
      pending.content.push(call);
      pending.stopReason = 'toolUse';
      continue;
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      pending = undefined;
      if (typeof item.call_id !== 'string' || item.call_id.length === 0)
        unsupported('tool output requires call_id');
      const name =
        toolNames.get(item.call_id) ?? (typeof item.name === 'string' ? item.name : undefined);
      if (name === undefined) unsupported('tool output references an unknown tool call');
      messages.push({
        role: 'toolResult',
        toolCallId: callIds.get(item.call_id) ?? item.call_id,
        toolName: name,
        content: textContent(item.output, 'tool output'),
        isError: false,
        timestamp: Date.now(),
      });
      continue;
    }
    unsupported('unsupported input item type');
  }
  return messages;
};

const responsesReasoning = (value: unknown, options: Record<string, unknown>): void => {
  if (value === undefined) return;
  if (!Predicate.isObject(value)) unsupported('reasoning must be an object');
  if (value.effort !== undefined) options.reasoningEffort = value.effort;
  if (value.summary !== undefined) options.reasoningSummary = value.summary;
};

const responsesText = (
  value: unknown,
  options: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (!Predicate.isObject(value)) unsupported('text must be an object');
  if (value.verbosity !== undefined) options.textVerbosity = value.verbosity;
  return value.format === undefined ? undefined : (value.format as Record<string, unknown>);
};

export const prepareResponses = (
  target: PiTarget,
  body: Record<string, unknown>,
): PreparedPiRequest => {
  const { tools, strictByName } = responsesTools(body.tools);
  const messages = responsesMessages(target, body.input);
  const systemPrompt =
    typeof body.instructions === 'string' && body.instructions.length > 0
      ? body.instructions
      : undefined;

  const options: Record<string, unknown> = {};
  if (body.temperature !== undefined) options.temperature = body.temperature;
  if (body.service_tier !== undefined) options.serviceTier = body.service_tier;
  const passthroughToolChoice =
    body.tool_choice !== undefined &&
    Predicate.isObject(body.tool_choice) &&
    !Array.isArray(body.tool_choice);
  if (body.tool_choice !== undefined && !passthroughToolChoice) {
    if (
      typeof body.tool_choice !== 'string' ||
      !['auto', 'none', 'required'].includes(body.tool_choice)
    )
      unsupported('unsupported tool_choice');
    options.toolChoice = body.tool_choice;
  }
  responsesReasoning(body.reasoning, options);
  const textFormat = responsesText(body.text, options);
  const maxOutput = body.max_output_tokens;
  if (maxOutput !== undefined) {
    if (typeof maxOutput !== 'number' || !Number.isFinite(maxOutput) || maxOutput <= 0)
      unsupported('max_output_tokens must be a positive number');
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean')
    unsupported('parallel_tool_calls must be a boolean');
  if (body.include !== undefined && !Array.isArray(body.include))
    unsupported('include must be an array');
  if (body.client_metadata !== undefined && !Predicate.isObject(body.client_metadata))
    unsupported('client_metadata must be an object');

  const contextInput: Context = {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages,
    ...(tools.length === 0 ? {} : { tools }),
  };
  const patch = (payload: Record<string, unknown>): Record<string, unknown> => {
    const next = { ...payload };
    if (maxOutput !== undefined) next.max_output_tokens = maxOutput;
    if (body.top_p !== undefined) next.top_p = body.top_p;
    if (body.parallel_tool_calls !== undefined) next.parallel_tool_calls = body.parallel_tool_calls;
    if (body.client_metadata !== undefined) next.client_metadata = body.client_metadata;
    if (passthroughToolChoice) next.tool_choice = body.tool_choice;
    if (body.prompt_cache_key !== undefined) next.prompt_cache_key = body.prompt_cache_key;
    if (Array.isArray(body.include)) {
      const existing = Array.isArray(next.include) ? (next.include as unknown[]) : [];
      next.include = [...new Set([...existing, ...body.include])];
    }
    if (textFormat !== undefined)
      next.text = { ...(Predicate.isObject(next.text) ? next.text : {}), format: textFormat };
    const strict = strictPatch(strictByName);
    return strict === undefined ? next : strict(next);
  };

  return { context: normalizeContext(contextInput), options, patch };
};

export const usesGrammarTools = (body: Record<string, unknown>): boolean =>
  Array.isArray(body.tools) &&
  body.tools.some(
    (tool) => Predicate.isObject(tool) && tool.type === 'custom' && Predicate.isObject(tool.format),
  );

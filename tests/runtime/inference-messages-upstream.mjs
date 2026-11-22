// Credential-free Messages upstream SSE fixtures for workerd coverage.
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

const messagesStart = (model, usage) =>
  event('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });

const messagesText = (text) =>
  event('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }) +
  event('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  }) +
  event('content_block_stop', { type: 'content_block_stop', index: 0 });

const messagesTool = () =>
  event('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  }) +
  event('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'Inspect the example file.' },
  }) +
  event('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'synthetic-signature-messages' },
  }) +
  event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  event('content_block_start', {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_synthetic', name: 'read', input: {} },
  }) +
  event('content_block_delta', {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"path":"src/example.ts"}' },
  }) +
  event('content_block_stop', { type: 'content_block_stop', index: 1 });

const messagesStop = (stopReason) =>
  event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 11 },
  }) + event('message_stop', { type: 'message_stop' });

export const messagesSuccessWire = (model = 'claude-native') =>
  messagesStart(model, {
    input_tokens: 17,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 2,
    output_tokens: 1,
  }) +
  messagesText('Reviewed by Messages') +
  messagesStop('end_turn');

export const messagesToolWire = (model = 'claude-native') =>
  messagesStart(model, {
    input_tokens: 31,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 1,
    output_tokens: 1,
  }) +
  messagesTool() +
  messagesStop('tool_use');

export const messagesWrongStopTypeWire = (model = 'claude-native') =>
  messagesStart(model, {
    input_tokens: 17,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 0,
    output_tokens: 1,
  }) +
  messagesText('Wrong terminal type') +
  event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 2 },
  }) +
  event('message_stop', { type: 'message_delta' });

export const messagesMissingStopWire = (model = 'claude-native') =>
  messagesStart(model, {
    input_tokens: 17,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 0,
    output_tokens: 1,
  }) +
  messagesText('No successful stop reason') +
  event('message_stop', { type: 'message_stop' });

export const messagesMaxTokensWire = (model = 'claude-native') =>
  messagesStart(model, {
    input_tokens: 17,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 0,
    output_tokens: 1,
  }) +
  messagesText('Truncated') +
  messagesStop('max_tokens');

export const messagesErrorWire = () =>
  event('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });

const hasToolResult = (body) => body.includes('"tool_result"');

export const messagesProtocolStream = (scenario, body) => {
  switch (scenario) {
    case 'messages-success':
      return messagesSuccessWire();
    case 'messages-tool':
      return hasToolResult(body) ? messagesSuccessWire() : messagesToolWire();
    case 'messages-wrong-stop-type':
      return messagesWrongStopTypeWire();
    case 'messages-missing-stop':
      return messagesMissingStopWire();
    case 'messages-max-tokens':
      return messagesMaxTokensWire();
    case 'messages-error':
      return messagesErrorWire();
    default:
      return null;
  }
};

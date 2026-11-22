import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messagesAdapter, validateMessagesBody } from '../apps/inference-worker/src/messages';

const captures = JSON.parse(
  readFileSync(
    new URL('./fixtures/protocols/messages-cli-captures.json', import.meta.url).pathname,
    'utf8',
  ),
) as {
  readonly requests: Record<'title' | 'main' | 'continuation', Record<string, unknown>>;
};

const main = captures.requests.main;

describe('Messages request admission', () => {
  it('accepts the captured envelope and its signed tool continuation', () => {
    for (const request of Object.values(captures.requests))
      expect(validateMessagesBody(request)).not.toBeNull();

    const continued = captures.requests.continuation.messages as readonly {
      readonly role: string;
      readonly content: readonly Record<string, unknown>[];
    }[];
    expect(continued.find((message) => message.role === 'assistant')?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          signature: 'synthetic-signature-messages',
        }),
        expect.objectContaining({
          type: 'redacted_thinking',
          data: 'opaque-redacted-thinking',
        }),
        expect.objectContaining({ type: 'tool_use', id: 'toolu_synthetic' }),
      ]),
    );
    expect(continued.at(-1)?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_synthetic' }),
      ]),
    );
  });

  it('requires stream and a matching tool_choice name', () => {
    expect(validateMessagesBody(main)).not.toBeNull();
    expect(
      validateMessagesBody({ ...main, tool_choice: { type: 'tool', name: 'read' } }),
    ).not.toBeNull();
    expect(validateMessagesBody({ ...main, tool_choice: { type: 'auto' } })).not.toBeNull();
    expect(validateMessagesBody({ ...main, stream: false })).toBeNull();
    expect(validateMessagesBody({ ...main, stream: undefined })).toBeNull();
    expect(validateMessagesBody({ ...main, tool_choice: { type: 'tool' } })).toBeNull();
    expect(
      validateMessagesBody({ ...main, tool_choice: { type: 'auto', name: 'read' } }),
    ).toBeNull();
  });

  it('rejects hosted tools, remote media, file ids, state references and unsigned thinking', () => {
    const invalid = [
      { ...main, tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      {
        ...main,
        messages: [
          ...(main.messages as readonly unknown[]),
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'url', url: 'https://remote.invalid/image.png' },
              },
            ],
          },
        ],
      },
      {
        ...main,
        messages: [
          ...(main.messages as readonly unknown[]),
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_synthetic',
                content: [{ type: 'image', source: { type: 'file', file_id: 'file_1' } }],
              },
            ],
          },
        ],
      },
      {
        ...main,
        messages: [
          ...(main.messages as readonly unknown[]),
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'unsigned' }],
          },
        ],
      },
      {
        ...main,
        messages: [
          ...(main.messages as readonly unknown[]),
          {
            role: 'assistant',
            content: [{ type: 'redacted_thinking' }],
          },
        ],
      },
      { ...main, stream: false },
      { ...main, stream: undefined },
      { ...main, tool_choice: { type: 'tool' } },
      { ...main, tool_choice: { type: 'auto', name: 'read' } },
      {
        ...main,
        messages: [
          ...(main.messages as readonly unknown[]),
          {
            role: 'assistant',
            content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search' }],
          },
        ],
      },
      { ...main, previous_response_id: 'resp_1' },
      { ...main, container: 'container_1' },
      { ...main, mcp_servers: [] },
    ];
    for (const request of invalid) expect(validateMessagesBody(request)).toBeNull();
  });
});

describe('Messages SSE observation', () => {
  it('normalizes total input and preserves zero versus missing usage', () => {
    const adapter = messagesAdapter.create!();
    expect(
      adapter.observe({
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: {
            model: 'claude-fixture',
            usage: {
              input_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      }),
    ).toEqual({
      observation: 'event',
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'claude-fixture',
    });
    expect(
      adapter.observe({
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: {
            model: 'claude-fixture',
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 2,
            },
          },
        }),
      }),
    ).toEqual({
      observation: 'event',
      usage: { inputTokens: 17, cacheReadTokens: 5, cacheWriteTokens: 2 },
      model: 'claude-fixture',
    });
    expect(adapter.observe({ event: 'message_start', data: '{}' })).toEqual({
      observation: 'event',
    });
  });

  it('requires a successful stop reason and isolates state per request', () => {
    expect(
      messagesAdapter.create!().observe({
        event: 'message_stop',
        data: JSON.stringify({ type: 'message_stop' }),
      }),
    ).toEqual({ observation: 'failure' });
    const completed = messagesAdapter.create!();
    expect(
      completed.observe({
        event: 'message_delta',
        data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      }),
    ).toEqual({ observation: 'event' });
    expect(
      completed.observe({
        event: 'message_stop',
        data: JSON.stringify({ type: 'message_stop' }),
      }),
    ).toEqual({ observation: 'terminal' });
    expect(
      messagesAdapter.create!().observe({
        event: 'message_stop',
        data: JSON.stringify({ type: 'message_stop' }),
      }),
    ).toEqual({ observation: 'failure' });
    const refused = messagesAdapter.create!();
    expect(
      refused.observe({
        event: 'message_delta',
        data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'refusal' } }),
      }),
    ).toEqual({ observation: 'event' });
    expect(
      refused.observe({
        event: 'message_stop',
        data: JSON.stringify({ type: 'message_stop' }),
      }),
    ).toEqual({ observation: 'terminal' });
    const truncated = messagesAdapter.create!();
    expect(
      truncated.observe({
        event: 'message_delta',
        data: JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens' },
          usage: { output_tokens: 3 },
        }),
      }),
    ).toEqual({ observation: 'failure', usage: { outputTokens: 3 } });
    expect(
      truncated.observe({
        event: 'message_stop',
        data: JSON.stringify({ type: 'message_stop' }),
      }),
    ).toEqual({ observation: 'failure' });
    for (const frame of [
      { event: 'error', data: '{}' },
      { event: 'unknown_future_event', data: '{}' },
      { event: 'message_start', data: 'not-json' },
    ])
      expect(messagesAdapter.create!().observe(frame)).toEqual({ observation: 'failure' });
  });
});

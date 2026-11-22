import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  geminiAdapter,
  geminiRouteHandle,
  validateGeminiBody,
} from '../apps/inference-worker/src/gemini';

const captures = JSON.parse(
  readFileSync(
    new URL('./fixtures/protocols/gemini-cli-captures.json', import.meta.url).pathname,
    'utf8',
  ),
) as {
  readonly handle: string;
  readonly requests: Record<'title' | 'main' | 'continuation', Record<string, unknown>>;
};

const main = captures.requests.main;

describe('Gemini request admission', () => {
  it('accepts the captured envelope and its signed tool continuation', () => {
    for (const request of Object.values(captures.requests))
      expect(validateGeminiBody(request)).not.toBeNull();

    const continued = captures.requests.continuation.contents as readonly {
      readonly role: string;
      readonly parts: readonly Record<string, unknown>[];
    }[];
    expect(continued.find((content) => content.role === 'model')?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          functionCall: expect.objectContaining({ name: 'read' }),
          thoughtSignature: 'c3ludGhldGljLXNpZ25hdHVyZQ==',
        }),
        expect.objectContaining({ thought: true }),
      ]),
    );
    expect(continued.at(-1)?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          functionResponse: expect.objectContaining({ name: 'read' }),
        }),
      ]),
    );
  });

  it('rejects hosted tools, media, executable code, cached state and body model overrides', () => {
    const withPart = (part: Record<string, unknown>, role = 'user') => ({
      ...main,
      contents: [...(main.contents as readonly unknown[]), { role, parts: [part] }],
    });
    const invalid = [
      { ...main, tools: [{ googleSearch: {} }] },
      { ...main, tools: [{ googleSearchRetrieval: {} }] },
      { ...main, tools: [{ codeExecution: {} }] },
      { ...main, tools: [{ urlContext: {} }] },
      withPart({ fileData: { fileUri: 'https://remote.invalid/file' } }),
      withPart({ inlineData: { mimeType: 'image/png', data: 'AAAA' } }),
      withPart({ executableCode: { language: 'PYTHON', code: 'x' } }, 'model'),
      { ...main, cachedContent: 'cachedContents/1' },
      { ...main, generationConfig: { responseModalities: ['IMAGE'] } },
      { ...main, model: 'gemini-native' },
      withPart(
        {
          functionCall: { name: 'read', args: {} },
          thoughtSignature: '',
        },
        'model',
      ),
    ];
    for (const request of invalid) expect(validateGeminiBody(request)).toBeNull();
  });
});

describe('Gemini handle and SSE observation', () => {
  it('encodes the route id as an unpadded opaque wire handle', () => {
    expect(geminiRouteHandle('review-provider/gemini-x')).toBe(captures.handle);
    expect(geminiRouteHandle('review-provider/gemini-x')).not.toContain('=');
  });

  it('preserves zero versus missing usage and fails malformed or ambiguous frames', () => {
    expect(
      geminiAdapter.observe({
        data: JSON.stringify({
          candidates: [{ content: { parts: [] }, index: 0 }],
          usageMetadata: {
            promptTokenCount: 0,
            cachedContentTokenCount: 0,
            candidatesTokenCount: 0,
          },
          modelVersion: 'gemini-fixture',
        }),
      }),
    ).toEqual({
      observation: 'event',
      usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      model: 'gemini-fixture',
    });
    expect(
      geminiAdapter.observe({
        data: JSON.stringify({
          candidates: [{ content: { parts: [] }, index: 0 }],
          usageMetadata: {
            promptTokenCount: 19,
            candidatesTokenCount: 8,
            thoughtsTokenCount: 2,
          },
          modelVersion: 'gemini-fixture',
        }),
      }),
    ).toMatchObject({
      usage: { inputTokens: 19, outputTokens: 10, reasoningTokens: 2 },
    });
    const ambiguous = [
      {
        candidates: [
          { content: { parts: [] }, finishReason: 'STOP' },
          { content: { parts: [] }, finishReason: 'STOP' },
        ],
      },
      { candidates: [{ content: { parts: [] }, finishReason: 'FUTURE_REASON' }] },
      { promptFeedback: { blockReason: 'SAFETY' } },
    ];
    for (const value of ambiguous)
      expect(geminiAdapter.observe({ data: JSON.stringify(value) })).toMatchObject({
        observation: 'failure',
      });
    for (const frame of [{ data: 'not-json' }, { event: 'error', data: '{}' }])
      expect(geminiAdapter.observe(frame)).toEqual({ observation: 'failure' });
  });
});

// Credential-free Gemini upstream SSE fixtures for workerd coverage.
const geminiFrame = (value) => `data: ${JSON.stringify(value)}\n\n`;

export const geminiSuccessWire = (model = 'gemini-native') =>
  geminiFrame({
    candidates: [{ content: { parts: [{ text: 'Reviewed by ' }], role: 'model' }, index: 0 }],
    usageMetadata: { promptTokenCount: 19, cachedContentTokenCount: 7 },
    modelVersion: model,
  }) +
  geminiFrame({
    candidates: [
      {
        content: { parts: [{ text: 'Gemini' }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 19,
      cachedContentTokenCount: 7,
      candidatesTokenCount: 8,
      thoughtsTokenCount: 2,
      totalTokenCount: 29,
    },
    modelVersion: model,
  });

export const geminiToolWire = (model = 'gemini-native') =>
  geminiFrame({
    candidates: [
      {
        content: {
          parts: [
            { text: 'Inspect the example file.', thought: true },
            {
              functionCall: { name: 'read', args: { path: 'src/example.ts' } },
              thoughtSignature: 'c3ludGhldGljLXNpZ25hdHVyZQ==',
            },
          ],
          role: 'model',
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 33,
      cachedContentTokenCount: 4,
      candidatesTokenCount: 9,
      thoughtsTokenCount: 3,
      totalTokenCount: 45,
    },
    modelVersion: model,
  });

export const geminiMaxTokensWire = (model = 'gemini-native') =>
  geminiFrame({
    candidates: [
      {
        content: { parts: [{ text: 'Truncated' }], role: 'model' },
        finishReason: 'MAX_TOKENS',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 19,
      cachedContentTokenCount: 2,
      candidatesTokenCount: 3,
      totalTokenCount: 24,
    },
    modelVersion: model,
  });

export const geminiBlockedWire = (model = 'gemini-native') =>
  geminiFrame({
    candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'SAFETY', index: 0 }],
    usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 0, totalTokenCount: 19 },
    modelVersion: model,
  });

const hasFunctionResponse = (body) => body.includes('functionResponse');

export const geminiProtocolStream = (scenario, body) => {
  switch (scenario) {
    case 'gemini-success':
      return geminiSuccessWire();
    case 'gemini-tool':
      return hasFunctionResponse(body) ? geminiSuccessWire() : geminiToolWire();
    case 'gemini-max-tokens':
      return geminiMaxTokensWire();
    case 'gemini-error-before-stop':
      return (
        geminiFrame({
          error: { message: 'upstream diagnostic' },
          usageMetadata: { promptTokenCount: 12 },
        }) + geminiSuccessWire()
      );
    case 'gemini-blocked':
      return geminiBlockedWire();
    default:
      return null;
  }
};

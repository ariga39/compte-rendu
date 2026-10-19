import { expect, it } from 'vitest';
import { createLlmService } from '../apps/llm-service/src/service';
import { createPiUpstream } from '../apps/llm-service/src/upstream';

it('uses the configured provider with a custom endpoint and a trusted per-job session', async () => {
  const upstream = createPiUpstream({
    routes: [
      {
        id: 'go',
        provider: 'opencode-go',
        protocol: 'chat-completions',
        model: 'deepseek-flash',
        baseUrl: 'https://gateway.invalid/v1',
      },
      {
        id: 'generic',
        provider: 'openai-compatible',
        protocol: 'chat-completions',
        model: 'custom-model',
        baseUrl: 'https://gateway.invalid/v1',
      },
    ],
    credential: async () => 'upstream-key',
    fetch: async (url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body');
      const body = JSON.parse(init.body);
      const session = new Headers(init?.headers).get('x-opencode-session');
      const expected = body.model === 'custom-model' ? null : body.messages[0].content;
      if (
        (url instanceof Request ? url.url : url.toString()) !==
          'https://gateway.invalid/v1/chat/completions' ||
        session !== expected
      ) {
        return Response.json({ error: 'invalid upstream route or session' }, { status: 400 });
      }
      return new Response(
        'data: {"id":"test","choices":[{"index":0,"delta":{"content":"Review accepted"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const service = createLlmService({
    routes: [
      { id: 'go', path: '/v1/chat/completions' },
      { id: 'generic', path: '/v1/chat/completions' },
    ],
    upstream,
  });
  try {
    for (const jobId of ['job-one', 'job-two']) {
      const issued = await service.control(
        new Request('http://control/grants', {
          method: 'POST',
          body: JSON.stringify({ jobId, routes: ['go', 'generic'] }),
        }),
      );
      expect(issued.status).toBe(201);
      const { token } = await issued.json();
      for (const model of ['go', 'go', 'generic']) {
        const response = await service.inference(
          new Request('http://service/v1/chat/completions', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'x-opencode-session': 'client-spoof' },
            body: JSON.stringify({
              model,
              stream: true,
              messages: [{ role: 'user', content: jobId }],
            }),
          }),
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('Review accepted');
      }
    }
  } finally {
    service.close();
  }
});

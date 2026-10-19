import { expect, it } from 'vitest';
import { createLlmService } from '../apps/llm-service/src/service';
import { createLiteLlmUpstream } from '../apps/llm-service/src/upstream';

it('uses the configured LiteLLM model alias and trusted per-job session headers', async () => {
  const seen: {
    url: string;
    authorization: string | null;
    session: string | null;
    sessionId: string | null;
    body: Record<string, unknown>;
  }[] = [];
  const upstream = createLiteLlmUpstream({
    baseUrl: 'http://127.0.0.1:4000',
    routes: [
      { id: 'go', model: 'deepseek-flash', protocol: 'chat-completions' },
      { id: 'generic', model: 'custom-model', protocol: 'chat-completions' },
    ],
    credential: async () => 'backend-key',
    fetch: async (url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body');
      const headers = new Headers(init.headers);
      seen.push({
        url: url instanceof Request ? url.url : url.toString(),
        authorization: headers.get('authorization'),
        session: headers.get('x-opencode-session'),
        sessionId: headers.get('session_id'),
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
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
      const { token } = (await issued.json()) as { token: string };
      for (const model of ['go', 'go', 'generic']) {
        const response = await service.inference(
          new Request('http://service/v1/chat/completions', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'x-opencode-session': 'client-spoof' },
            body: JSON.stringify({
              model,
              stream: true,
              messages: [{ role: 'user', content: jobId }],
              prompt_cache_key: 'client-cache-key',
            }),
          }),
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('Review accepted');
        const request = seen.at(-1)!;
        expect(request.url).toBe('http://127.0.0.1:4000/v1/chat/completions');
        expect(request.authorization).toBe('Bearer backend-key');
        expect(request.session).toBe(jobId);
        expect(request.sessionId).toBe(jobId);
        expect(request.body.model).toBe(model === 'generic' ? 'custom-model' : 'deepseek-flash');
        expect(request.body.store).toBe(false);
        expect(request.body.stream).toBe(true);
        expect(request.body.prompt_cache_key).toBe('client-cache-key');
        expect(request.body.messages).toEqual([{ role: 'user', content: jobId }]);
      }
    }
  } finally {
    service.close();
  }
});

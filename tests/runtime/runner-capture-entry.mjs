const captures = [];

export default {
  fetch: async (request) => {
    const url = new URL(request.url);

    if (request.method === 'DELETE' && url.pathname === '/__test/capture') {
      captures.length = 0;
      return new Response(null, { status: 204 });
    }

    if (request.method === 'GET' && url.pathname === '/__test/capture') {
      return Response.json(captures);
    }

    if (request.method === 'POST' && url.pathname === '/jobs') {
      const input = await request.json();
      captures.push(input);
      return Response.json(
        {
          id: input.id,
          runId: input.runId,
          attempt: input.attempt,
          evidence: { id: 'evidence-1', status: 'pending' },
          status: 'queued',
          stage: 'admission',
          sandbox: { cleanup: 'pending' },
        },
        { status: 202 },
      );
    }

    return new Response(null, { status: 404 });
  },
};

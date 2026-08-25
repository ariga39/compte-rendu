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

    if (request.method === 'POST' && url.pathname === '/create') {
      captures.push(await request.json());
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 404 });
  },
};

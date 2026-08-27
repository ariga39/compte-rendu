import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRunner } from './runner';

const MAX_REQUEST_BYTES = 64 * 1024;
const runner = createRunner({
  log: {
    record: (event) => {
      console.log(JSON.stringify(event));
    },
  },
});

const requestFor = async (request: IncomingMessage): Promise<Request | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) return undefined;
    chunks.push(buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  const host = typeof request.headers.host === 'string' ? request.headers.host : 'runner.internal';
  return new Request(`http://${host}${request.url ?? '/'}`, {
    method: request.method,
    headers,
    body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
  });
};

createServer(async (request: IncomingMessage, response: ServerResponse) => {
  try {
    const converted = await requestFor(request);
    if (converted === undefined) {
      response.statusCode = 413;
      response.end();
      return;
    }
    const result = await runner.handle(converted);
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.statusCode = 500;
    response.end();
  }
}).listen({ port: Number(process.env.PORT ?? 8080), host: '127.0.0.1' });

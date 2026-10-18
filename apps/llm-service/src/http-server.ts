import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Effect } from 'effect';

interface Service {
  readonly control: (request: Request) => Promise<Response>;
  readonly inference: (request: Request) => Promise<Response>;
  close(): void;
}

const listener =
  (handle: (request: Request) => Promise<Response>, maxBytes: number) =>
  async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const abort = new AbortController();
    outgoing.on('close', () => {
      if (!outgoing.writableEnded) abort.abort();
    });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > maxBytes) {
          outgoing.writeHead(413).end();
          return;
        }
        chunks.push(bytes);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      const request = new Request(`http://llm.internal${incoming.url ?? '/'}`, {
        method: incoming.method,
        headers,
        signal: abort.signal,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const response = await handle(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (!outgoing.write(next.value))
              await new Promise<void>((resolve, reject) => {
                const ready = () => {
                  abort.signal.removeEventListener('abort', cancelled);
                  resolve();
                };
                const cancelled = () => {
                  outgoing.removeListener('drain', ready);
                  reject(new Error('client disconnected'));
                };
                outgoing.once('drain', ready);
                abort.signal.addEventListener('abort', cancelled, { once: true });
                if (abort.signal.aborted) cancelled();
              });
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      outgoing.end();
    } catch {
      abort.abort();
      if (!outgoing.headersSent) outgoing.writeHead(500).end();
      else outgoing.destroy();
    }
  };

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

export const startLlmServer = (options: {
  service: Service;
  controlSocket: string;
  port: number;
}) =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      const directory = dirname(options.controlSocket);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (((await stat(directory)).mode & 0o077) !== 0)
        throw new Error('control socket directory must be private');
      const control = createServer(listener(options.service.control, 16 * 1024));
      const inference = createServer(listener(options.service.inference, 16 * 1024 * 1024));
      try {
        await new Promise<void>((resolve, reject) => {
          control.once('error', reject);
          control.listen(options.controlSocket, resolve);
        });
        await chmod(options.controlSocket, 0o600);
        await new Promise<void>((resolve, reject) => {
          inference.once('error', reject);
          inference.listen(options.port, '127.0.0.1', resolve);
        });
        const address = inference.address();
        if (!address || typeof address === 'string')
          throw new Error('inference listener unavailable');
        return {
          port: address.port,
          close: async () => {
            options.service.close();
            await Promise.all([closeServer(control), closeServer(inference)]);
          },
        };
      } catch {
        options.service.close();
        await Promise.all([closeServer(control), closeServer(inference)]);
        throw new Error('LLM listeners could not start');
      }
    }),
  );

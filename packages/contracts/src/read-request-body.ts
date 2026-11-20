type BodyResult = { readonly kind: 'ok'; readonly text: string } | { readonly kind: 'too-large' };

export const readBoundedRequestBody = async (
  request: Request,
  limit: number,
): Promise<BodyResult> => {
  return decodeBody(await readBoundedRequestBytes(request, limit));
};

export const readBoundedRequestBytes = async (request: Request, limit: number) => {
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > limit) {
    await request.body?.cancel().catch(() => undefined);
    return undefined;
  }
  return readBytes(request.body, limit);
};

const decodeBody = (bytes: Uint8Array | undefined): BodyResult =>
  bytes === undefined
    ? { kind: 'too-large' }
    : { kind: 'ok', text: new TextDecoder().decode(bytes) };

export const readBoundedBody = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<BodyResult> => decodeBody(await readBytes(body, limit));

const readBytes = async (body: ReadableStream<Uint8Array> | null, limit: number) => {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

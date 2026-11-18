import { Option, Schema } from 'effect';
const MAX_CATALOG_BYTES = 256 * 1024;
export const MAX_CATALOG_MODELS = 1000;
export const CATALOG_TIMEOUT_MS = 5000;
export const PUBLIC_USER_AGENT = 'litellm/1.106.0';

export const CatalogModelId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:/-]+$/),
);

const CatalogEnvelope = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
});
const CatalogEntry = Schema.Struct({ id: Schema.String });

const readBounded = async (response: Response): Promise<string> => {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('catalog too large');
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
  return new TextDecoder().decode(bytes);
};

const decodeCatalog = (
  text: string,
): { readonly ids: readonly string[]; readonly rejected: number } => {
  const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(CatalogEnvelope))(text);
  const ids: string[] = [];
  let rejected = 0;
  for (const entry of decoded.data) {
    const model = Option.getOrUndefined(Schema.decodeUnknownOption(CatalogEntry)(entry));
    if (model === undefined) {
      rejected += 1;
      continue;
    }
    ids.push(model.id);
  }
  return { ids, rejected };
};

export const readModelCatalog = async (response: Response) => {
  if (!response.ok) throw new Error('catalog unavailable');
  return decodeCatalog(await readBounded(response));
};

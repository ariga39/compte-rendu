import { readBoundedBody } from '@compte-rendu/contracts';
import { Option, Schema } from 'effect';
const MAX_CATALOG_BYTES = 256 * 1024;
export const MAX_CATALOG_MODELS = 1000;
export const CATALOG_TIMEOUT_MS = 5000;
export const PUBLIC_USER_AGENT = 'compte-rendu/1.0';

export const CatalogModelId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:/-]+$/),
);

const CatalogEnvelope = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
});
const CatalogEntry = Schema.Struct({ id: Schema.String });

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
  const body = await readBoundedBody(response.body, MAX_CATALOG_BYTES);
  if (body.kind !== 'ok') throw new Error('catalog too large');
  return decodeCatalog(body.text);
};

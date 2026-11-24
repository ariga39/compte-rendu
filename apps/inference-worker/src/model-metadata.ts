import {
  type ModelRouteMetadata,
  ModelRouteMetadata as ModelRouteMetadataSchema,
} from '@compte-rendu/contracts';
import { Option, Schema } from 'effect';

const StringList = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
).check(Schema.isMaxLength(64));
const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Reasoning = Schema.Struct({
  supported: Schema.optionalKey(Schema.Boolean),
  toggle: Schema.optionalKey(Schema.Boolean),
  effort: Schema.optionalKey(StringList),
  budget: Schema.optionalKey(
    Schema.Struct({
      min: Schema.optionalKey(NonNegative),
      max: Schema.optionalKey(NonNegative),
    }),
  ),
});
const Capabilities = Schema.Struct({
  tools: Schema.optionalKey(
    Schema.Union([
      Schema.Boolean,
      Schema.Struct({ supported: Schema.optionalKey(Schema.Boolean) }),
    ]),
  ),
  freeform: Schema.optionalKey(StringList),
  input: Schema.optionalKey(StringList),
  output: Schema.optionalKey(StringList),
  reasoning: Schema.optionalKey(Reasoning),
  temperature: Schema.optionalKey(Schema.Boolean),
});
const Modalities = Schema.Struct({
  input: Schema.optionalKey(StringList),
  output: Schema.optionalKey(StringList),
});
const Price = Schema.Struct({
  price: Schema.optionalKey(NonNegative),
  cache: Schema.optionalKey(
    Schema.Struct({
      read: Schema.optionalKey(NonNegative),
      write: Schema.optionalKey(NonNegative),
    }),
  ),
});
const CostEntry = Schema.Union([NonNegative, Price]);
const TextCost = Schema.Struct({
  input: Schema.optionalKey(CostEntry),
  output: Schema.optionalKey(CostEntry),
});
const Cost = Schema.Struct({
  text: Schema.optionalKey(TextCost),
  input: Schema.optionalKey(CostEntry),
  output: Schema.optionalKey(CostEntry),
  cache_read: Schema.optionalKey(NonNegative),
  cache_write: Schema.optionalKey(NonNegative),
});
const { name, family, releaseDate } = ModelRouteMetadataSchema.fields;
const RawModel = Schema.Struct({
  name,
  display_name: name,
  displayName: name,
  family,
  type: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  release_date: releaseDate,
  modalities: Schema.optionalKey(Modalities),
  capabilities: Schema.optionalKey(Capabilities),
  cost: Schema.optionalKey(Cost),
});
type RawModel = typeof RawModel.Type;

const withoutUndefined = <T extends object>(value: T): T => {
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return value;
};

const price = (entry: typeof CostEntry.Type | undefined): number | undefined =>
  typeof entry === 'number' ? entry : entry?.price;

const mapCapabilities = (raw: RawModel): Readonly<Record<string, unknown>> | undefined => {
  const capabilities = raw.capabilities;
  const modalities = raw.modalities;
  if (capabilities === undefined && modalities === undefined) return undefined;
  const mapped = withoutUndefined({
    ...capabilities,
    tools:
      typeof capabilities?.tools === 'boolean'
        ? capabilities.tools
        : capabilities?.tools?.supported,
    input: capabilities?.input ?? modalities?.input,
    output: capabilities?.output ?? modalities?.output,
  });
  return Object.keys(mapped).length === 0 ? undefined : mapped;
};

const mapCost = (raw: RawModel): Readonly<Record<string, unknown>> | undefined => {
  if (raw.cost === undefined) return undefined;
  const text = raw.cost.text;
  const input = text?.input === undefined ? price(raw.cost.input) : price(text.input);
  const output = text?.output === undefined ? price(raw.cost.output) : price(text.output);
  const cacheRead =
    (typeof text?.input === 'object' ? text.input.cache?.read : undefined) ?? raw.cost.cache_read;
  const cacheWrite =
    (typeof text?.input === 'object' ? text.input.cache?.write : undefined) ?? raw.cost.cache_write;
  const mapped = withoutUndefined({
    input,
    output,
    cache:
      cacheRead === undefined && cacheWrite === undefined
        ? undefined
        : withoutUndefined({ read: cacheRead, write: cacheWrite }),
  });
  return Object.keys(mapped).length === 0 ? undefined : mapped;
};

/**
 * Map one retained upstream model entry into the OpenCode-supported model
 * fields. Transport settings, credentials, adapters and route identity are
 * deliberately not part of this boundary.
 */
export const modelRouteMetadata = (raw: unknown): ModelRouteMetadata | undefined => {
  const decoded = Schema.decodeUnknownOption(RawModel)(raw);
  if (Option.isNone(decoded)) return undefined;
  const model = decoded.value;
  const metadata = withoutUndefined({
    name: model.display_name ?? model.displayName ?? model.name,
    family: model.family,
    type: model.type === 'chat' ? ('chat' as const) : undefined,
    releaseDate: model.release_date,
    capabilities: mapCapabilities(model),
    cost: mapCost(model),
  });
  if (Object.keys(metadata).length === 0) return undefined;
  const checked = Schema.decodeUnknownOption(ModelRouteMetadataSchema)(metadata);
  return Option.isNone(checked) ? undefined : checked.value;
};

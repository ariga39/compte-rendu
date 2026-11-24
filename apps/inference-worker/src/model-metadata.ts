import {
  type ModelRouteMetadata,
  ModelRouteMetadata as ModelRouteMetadataSchema,
} from '@compte-rendu/contracts';
import { Option, Schema } from 'effect';

const BoundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const StringList = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
).check(Schema.isMaxLength(64));
const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const ReleaseDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}(-\d{2})?$/));
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
const RawModel = Schema.Struct({
  name: Schema.optionalKey(BoundedText),
  display_name: Schema.optionalKey(BoundedText),
  displayName: Schema.optionalKey(BoundedText),
  family: Schema.optionalKey(BoundedText),
  type: Schema.optionalKey(BoundedText),
  release_date: Schema.optionalKey(ReleaseDate),
  modalities: Schema.optionalKey(Modalities),
  capabilities: Schema.optionalKey(Capabilities),
  cost: Schema.optionalKey(Cost),
});
type RawModel = typeof RawModel.Type;
type MetadataCapabilities = NonNullable<ModelRouteMetadata['capabilities']>;
type MetadataReasoning = NonNullable<MetadataCapabilities['reasoning']>;

const compact = <T extends Record<string, unknown>>(value: T): T | undefined =>
  Object.values(value).some((entry) => entry !== undefined) ? value : undefined;

const price = (entry: typeof CostEntry.Type | undefined): number | undefined =>
  typeof entry === 'number' ? entry : entry?.price;

const mapReasoning = (
  reasoning: NonNullable<RawModel['capabilities']>['reasoning'] | undefined,
): MetadataReasoning | undefined => {
  if (reasoning === undefined) return undefined;
  return compact({
    ...(reasoning.supported === undefined ? {} : { supported: reasoning.supported }),
    ...(reasoning.toggle === undefined ? {} : { toggle: reasoning.toggle }),
    ...(reasoning.effort === undefined ? {} : { effort: reasoning.effort }),
    ...(reasoning.budget === undefined
      ? {}
      : {
          budget: compact({
            ...(reasoning.budget.min === undefined ? {} : { min: reasoning.budget.min }),
            ...(reasoning.budget.max === undefined ? {} : { max: reasoning.budget.max }),
          }),
        }),
  });
};

const mapCapabilities = (raw: RawModel): MetadataCapabilities | undefined => {
  const capabilities = raw.capabilities;
  const modalities = raw.modalities;
  if (capabilities === undefined && modalities === undefined) return undefined;
  const tools =
    typeof capabilities?.tools === 'boolean' ? capabilities.tools : capabilities?.tools?.supported;
  const input = capabilities?.input ?? modalities?.input;
  const output = capabilities?.output ?? modalities?.output;
  return compact({
    ...(tools === undefined ? {} : { tools }),
    ...(capabilities?.freeform === undefined ? {} : { freeform: capabilities.freeform }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(capabilities?.reasoning === undefined
      ? {}
      : { reasoning: mapReasoning(capabilities.reasoning) }),
    ...(capabilities?.temperature === undefined ? {} : { temperature: capabilities.temperature }),
  });
};

const mapCost = (raw: RawModel): ModelRouteMetadata['cost'] | undefined => {
  if (raw.cost === undefined) return undefined;
  const text = raw.cost.text;
  const input = text?.input === undefined ? price(raw.cost.input) : price(text.input);
  const output = text?.output === undefined ? price(raw.cost.output) : price(text.output);
  const cacheRead =
    (typeof text?.input === 'object' ? text.input.cache?.read : undefined) ?? raw.cost.cache_read;
  const cacheWrite =
    (typeof text?.input === 'object' ? text.input.cache?.write : undefined) ?? raw.cost.cache_write;
  return compact({
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined && cacheWrite === undefined
      ? {}
      : {
          cache: compact({
            ...(cacheRead === undefined ? {} : { read: cacheRead }),
            ...(cacheWrite === undefined ? {} : { write: cacheWrite }),
          }),
        }),
  });
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
  const name = model.display_name ?? model.displayName ?? model.name;
  const capabilities = mapCapabilities(model);
  const cost = mapCost(model);
  const metadata = compact({
    ...(name === undefined ? {} : { name }),
    ...(model.family === undefined ? {} : { family: model.family }),
    ...(model.type === 'chat' ? { type: 'chat' as const } : {}),
    ...(model.release_date === undefined ? {} : { releaseDate: model.release_date }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(cost === undefined ? {} : { cost }),
  });
  if (metadata === undefined) return undefined;
  const checked = Schema.decodeUnknownOption(ModelRouteMetadataSchema)(metadata);
  return Option.isNone(checked) ? undefined : checked.value;
};

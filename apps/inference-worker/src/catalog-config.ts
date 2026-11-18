import { Schema } from 'effect';
import { CredentialAlias, ProviderSlug, RouteId } from './route-schema.ts';

export { RouteId } from './route-schema.ts';

const DiscoveryPrefix = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:/-]{0,127}$/));
const providerFields = {
  providerSlug: ProviderSlug,
  credentialAlias: CredentialAlias,
};
const aliases = Schema.Record(RouteId, RouteId);
export const RelayCatalogSource = Schema.Union([
  Schema.Struct({
    ...providerFields,
    discovery: Schema.Literal('gateway'),
    prefix: DiscoveryPrefix,
    aliases: Schema.optionalKey(aliases),
  }),
  Schema.Struct({
    ...providerFields,
    url: Schema.String.check(Schema.isPattern(/^https:\/\//)),
    prefix: DiscoveryPrefix,
    aliases: Schema.optionalKey(aliases),
  }),
  Schema.Struct({
    ...providerFields,
    aliases: aliases.check(
      Schema.makeFilter((value) => Object.keys(value).length > 0, {
        expected: 'at least one explicit alias',
      }),
    ),
  }),
]);
export const RelayCatalogSources = Schema.Array(RelayCatalogSource).check(Schema.isMinLength(1));
export type RelayCatalogSource = typeof RelayCatalogSource.Type;

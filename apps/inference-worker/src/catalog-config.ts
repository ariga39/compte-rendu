import { Schema } from 'effect';
import { ModelProfile, ModelRouteLimit, RouteEffortOption } from '@compte-rendu/contracts';
import { CredentialAlias, ProviderSlug, RouteId } from './route-schema.ts';

export { RouteId } from './route-schema.ts';

const DiscoveryPrefix = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:/-]{0,127}$/));
const providerFields = {
  providerSlug: ProviderSlug,
  credentialAlias: CredentialAlias,
};
const profileFields = {
  profile: Schema.optionalKey(ModelProfile),
  profiles: Schema.optionalKey(
    Schema.Array(ModelProfile).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4),
      Schema.makeFilter((profiles) => new Set(profiles).size === profiles.length, {
        expected: 'distinct profiles',
      }),
    ),
  ),
};
const aliases = Schema.Record(RouteId, RouteId);
export const RouteEffortOptions = Schema.Array(RouteEffortOption).check(
  Schema.makeFilter(
    (options) => new Set(options.map((option) => option.name)).size === options.length,
    { expected: 'distinct effort names' },
  ),
);
export const ModelRouteOverride = Schema.Struct({
  profile: ModelProfile,
  limit: Schema.optionalKey(ModelRouteLimit),
  efforts: Schema.optionalKey(RouteEffortOptions),
});
export type ModelRouteOverride = typeof ModelRouteOverride.Type;
const routeOverrides = Schema.Record(RouteId, ModelRouteOverride);
function nativeProfile(slug: string): ModelProfile | undefined {
  if (slug === 'native:anthropic') return 'messages';
  if (slug === 'native:google-ai-studio') return 'gemini';
  return undefined;
}
export const RelayCatalogSource = Schema.Union([
  Schema.Struct({
    ...providerFields,
    ...profileFields,
    discovery: Schema.Literal('gateway'),
    prefix: DiscoveryPrefix,
    aliases: Schema.optionalKey(aliases),
    models: Schema.optionalKey(routeOverrides),
  }),
  Schema.Struct({
    ...providerFields,
    ...profileFields,
    url: Schema.String.check(Schema.isPattern(/^https:\/\//)),
    prefix: DiscoveryPrefix,
    aliases: Schema.optionalKey(aliases),
    models: Schema.optionalKey(routeOverrides),
  }),
  Schema.Struct({
    ...providerFields,
    ...profileFields,
    aliases: aliases.check(
      Schema.makeFilter((value) => Object.keys(value).length > 0, {
        expected: 'at least one explicit alias',
      }),
    ),
    models: Schema.optionalKey(routeOverrides),
  }),
]).check(
  Schema.makeFilter(
    (source) => {
      const required = nativeProfile(source.providerSlug);
      const profiles = [
        ...(source.profile ? [source.profile] : []),
        ...(source.profiles ?? []),
        ...Object.values(source.models ?? {}).map((m) => m.profile),
      ];
      if (required && !profiles.every((profile) => profile === required)) return false;
      // Reasoning effort injection is implemented for Chat only in this release.
      return Object.values(source.models ?? {}).every(
        (model) => model.efforts === undefined || model.profile === 'chat',
      );
    },
    { expected: 'profile supported by the native Gateway destination' },
  ),
);
export const RelayCatalogSources = Schema.Array(RelayCatalogSource).check(Schema.isMinLength(1));
export type RelayCatalogSource = typeof RelayCatalogSource.Type;

export const sourceProfiles = (source: RelayCatalogSource): readonly ModelProfile[] =>
  source.profiles ?? [source.profile ?? nativeProfile(source.providerSlug) ?? 'chat'];

export const sourceDefaultProfile = (source: RelayCatalogSource): ModelProfile =>
  source.profile ?? sourceProfiles(source)[0] ?? 'chat';

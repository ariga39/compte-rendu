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
export const SourceEfforts = Schema.Record(RouteId, RouteEffortOptions);
export const ModelRouteOverride = Schema.Struct({
  profile: ModelProfile,
  limit: Schema.optionalKey(ModelRouteLimit),
});
export type ModelRouteOverride = typeof ModelRouteOverride.Type;
const routeOverrides = Schema.Record(RouteId, ModelRouteOverride);
const sourceEfforts = { efforts: Schema.optionalKey(SourceEfforts) };
function nativeProfile(slug: string): ModelProfile | undefined {
  if (slug === 'native:anthropic') return 'messages';
  if (slug === 'native:google-ai-studio') return 'gemini';
  return undefined;
}
export const RelayCatalogSource = Schema.Union([
  Schema.Struct({
    ...providerFields,
    ...profileFields,
    ...sourceEfforts,
    discovery: Schema.Literal('gateway'),
    prefix: DiscoveryPrefix,
    aliases: Schema.optionalKey(aliases),
    models: Schema.optionalKey(routeOverrides),
  }),
  Schema.Struct({
    ...providerFields,
    ...profileFields,
    ...sourceEfforts,
    url: Schema.String.check(Schema.isPattern(/^https:\/\//)),
    prefix: DiscoveryPrefix,
    aliases: Schema.optionalKey(aliases),
    models: Schema.optionalKey(routeOverrides),
  }),
  Schema.Struct({
    ...providerFields,
    ...profileFields,
    ...sourceEfforts,
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
      const configuredProfiles = [
        ...(source.profile ? [source.profile] : []),
        ...(source.profiles ?? []),
      ];
      const profiles = [
        ...configuredProfiles,
        ...Object.values(source.models ?? {}).map((m) => m.profile),
      ];
      if (required && !profiles.every((profile) => profile === required)) return false;
      // Reasoning effort injection is implemented for Chat only in this release.
      // An explicit alias/model profile is already knowable. Discovery routes are
      // revalidated against their effective profile during refresh.
      const choices =
        configuredProfiles.length > 0
          ? configuredProfiles
          : [required ?? sourceDefaultProfile(source)];
      for (const routeId of Object.keys(source.efforts ?? {})) {
        const override = source.models?.[routeId];
        if (override !== undefined) {
          if (override.profile !== 'chat') return false;
          continue;
        }
        if (Object.hasOwn(source.aliases ?? {}, routeId)) {
          if (sourceDefaultProfile(source) !== 'chat') return false;
          continue;
        }
        // An alias-only source has no other selectable route IDs.
        if (!('prefix' in source)) return false;
        if (!choices.includes('chat')) return false;
      }
      return true;
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

import { Schema } from 'effect';
import {
  effortControlsProfile,
  ModelProfile,
  ModelRouteLimit,
  RouteEffortOption,
} from '@compte-rendu/contracts';
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
      Schema.isMaxLength(2),
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
      const configuredProfiles = [
        ...(source.profile ? [source.profile] : []),
        ...(source.profiles ?? []),
      ];
      // Each route's controls must match the protocol its explicit or discovered
      // profile will use. Discovery routes are revalidated against their
      // effective profile during refresh.
      const choices =
        configuredProfiles.length > 0 ? configuredProfiles : [sourceDefaultProfile(source)];
      for (const [routeId, options] of Object.entries(source.efforts ?? {})) {
        // An empty menu declares no protocol. Do not infer Chat from absence.
        const [first] = options;
        if (first === undefined) continue;
        const requiredProfile = effortControlsProfile(first.controls);
        if (options.some((option) => effortControlsProfile(option.controls) !== requiredProfile))
          return false;
        const override = source.models?.[routeId];
        if (override !== undefined) {
          if (override.profile !== requiredProfile) return false;
          continue;
        }
        if (Object.hasOwn(source.aliases ?? {}, routeId)) {
          if (sourceDefaultProfile(source) !== requiredProfile) return false;
          continue;
        }
        // An alias-only source has no other selectable route IDs.
        if (!('prefix' in source)) return false;
        if (!choices.includes(requiredProfile)) return false;
      }
      return true;
    },
    { expected: 'profile supported by configured routes' },
  ),
);
export const RelayCatalogSources = Schema.Array(RelayCatalogSource).check(Schema.isMinLength(1));
export type RelayCatalogSource = typeof RelayCatalogSource.Type;

export const sourceProfiles = (source: RelayCatalogSource): readonly ModelProfile[] =>
  source.profiles ?? [source.profile ?? 'chat'];

export const sourceDefaultProfile = (source: RelayCatalogSource): ModelProfile =>
  source.profile ?? sourceProfiles(source)[0] ?? 'chat';

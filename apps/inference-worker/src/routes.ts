import { Option, Schema } from 'effect';
import {
  AppliedRouteEffort,
  effortControlsProfile,
  ModelProfile,
  ModelRouteLimit,
  SafeModel,
} from '@compte-rendu/contracts';
import { CredentialAlias, ProviderSlug, RouteId } from './route-schema.ts';

export { RouteId } from './route-schema.ts';
export { ModelProfile } from '@compte-rendu/contracts';

export const FrozenRoute = Schema.Struct({
  routeId: RouteId,
  upstreamModel: SafeModel,
  providerSlug: ProviderSlug,
  credentialAlias: CredentialAlias,
  profile: ModelProfile,
  limit: Schema.optionalKey(ModelRouteLimit),
  effortGeneration: Schema.optionalKey(Schema.Natural),
  effort: Schema.optionalKey(AppliedRouteEffort),
}).check(
  Schema.makeFilter(
    (route) =>
      route.effort === undefined || effortControlsProfile(route.effort.controls) === route.profile,
    { expected: 'frozen effort controls match the route protocol' },
  ),
);
export type FrozenRoute = typeof FrozenRoute.Type;

export const FrozenRouteMapping = Schema.Array(FrozenRoute).check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (routes) => new Set(routes.map((route) => route.routeId)).size === routes.length,
    {
      expected: 'distinct frozen routes',
    },
  ),
);
export type FrozenRouteMapping = typeof FrozenRouteMapping.Type;

const decodeFrozenMapping = Schema.decodeUnknownOption(Schema.fromJsonString(FrozenRouteMapping), {
  onExcessProperty: 'error',
});

export const parseFrozenMapping = (value: string | null): FrozenRouteMapping | null => {
  if (value === null) return null;
  const decoded = decodeFrozenMapping(value);
  return Option.isNone(decoded) ? null : decoded.value;
};

export const gatewayProviderPath = (providerSlug: string): string => {
  if (providerSlug === 'native:openai') return 'openai';
  return providerSlug.startsWith('custom-') ? providerSlug : `custom-${providerSlug}`;
};

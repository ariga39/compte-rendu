import { Effect, Option, Schema } from 'effect';
import { ModelProfile, ModelRouteLimit, SafeModel } from '@compte-rendu/contracts';
import { CredentialAlias, ProviderSlug, RouteId } from './route-schema.ts';

export { RouteId } from './route-schema.ts';
export { ModelProfile } from '@compte-rendu/contracts';

// Gemini places the model identity in the URL path. A frozen upstream model is
// therefore one plain model-name segment: no slash, dot segment or encoding.
export const GeminiUpstreamModel = SafeModel.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
);
export const isGeminiUpstreamModel = (value: unknown): value is string =>
  Schema.is(GeminiUpstreamModel)(value);

export const FrozenRoute = Schema.Struct({
  routeId: RouteId,
  upstreamModel: SafeModel,
  providerSlug: ProviderSlug,
  credentialAlias: CredentialAlias,
  profile: ModelProfile.pipe(Schema.withDecodingDefaultKey(Effect.succeed('chat'))),
  limit: Schema.optionalKey(ModelRouteLimit),
});
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

// v1 predates profiles. Keep its persisted mapping byte-for-byte compatible so
// an older relay can still authenticate a grant issued during a rollout.
export const legacyFrozenMapping = (
  routes: FrozenRouteMapping,
): ReadonlyArray<Omit<FrozenRoute, 'profile' | 'limit'>> =>
  routes.map(({ profile: _profile, limit: _limit, ...route }) => route);

export const gatewayProviderPath = (providerSlug: string): string => {
  if (providerSlug === 'native:openai') return 'openai';
  return providerSlug.startsWith('custom-') ? providerSlug : `custom-${providerSlug}`;
};

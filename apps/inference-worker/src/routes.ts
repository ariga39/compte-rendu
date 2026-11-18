import { Option, Schema } from 'effect';
import { SafeModel } from '@compte-rendu/contracts';
import { CredentialAlias, ProviderSlug, RouteId } from './route-schema.ts';

export { RouteId } from './route-schema.ts';

export const CatalogRoute = Schema.Struct({
  route_id: RouteId,
  upstream_model: SafeModel,
  provider_slug: ProviderSlug,
  credential_alias: CredentialAlias,
});
export type CatalogRoute = typeof CatalogRoute.Type;

export const FrozenRoute = Schema.Struct({
  routeId: RouteId,
  upstreamModel: SafeModel,
  providerSlug: ProviderSlug,
  credentialAlias: CredentialAlias,
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

const decodeCatalogRoute = Schema.decodeUnknownOption(CatalogRoute, {
  onExcessProperty: 'ignore',
});

export const freezeRoute = (row: CatalogRoute): FrozenRoute | null => {
  const decoded = decodeCatalogRoute(row);
  if (Option.isNone(decoded)) return null;
  return {
    routeId: decoded.value.route_id,
    upstreamModel: decoded.value.upstream_model,
    providerSlug: decoded.value.provider_slug,
    credentialAlias: decoded.value.credential_alias,
  };
};

const decodeFrozenMapping = Schema.decodeUnknownOption(Schema.fromJsonString(FrozenRouteMapping), {
  onExcessProperty: 'error',
});

export const parseFrozenMapping = (value: string | null): FrozenRouteMapping | null => {
  if (value === null) return null;
  const decoded = decodeFrozenMapping(value);
  return Option.isNone(decoded) ? null : decoded.value;
};

export const gatewayProviderPath = (providerSlug: string): string =>
  providerSlug.startsWith('custom-') ? providerSlug : `custom-${providerSlug}`;

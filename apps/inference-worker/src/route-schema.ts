import { Schema } from 'effect';
import { ModelRouteId } from '@compte-rendu/contracts';

export const RouteId = ModelRouteId;

export const ProviderSlug = Schema.Union([
  Schema.Literals(['native:openai']),
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
]);

export const CredentialAlias = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
);

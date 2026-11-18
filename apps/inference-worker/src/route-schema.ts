import { Schema } from 'effect';

export const RouteId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:/-]{1,128}$/));

export const ProviderSlug = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
);

export const CredentialAlias = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
);

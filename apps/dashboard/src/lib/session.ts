import { Schema } from 'effect';

export const DashboardSession = Schema.Union([
  Schema.Struct({
    signedIn: Schema.Literal(false),
    account: Schema.Null,
    operator: Schema.Literal(false),
  }),
  Schema.Struct({
    signedIn: Schema.Literal(true),
    account: Schema.Struct({ login: Schema.NonEmptyString }),
    operator: Schema.Boolean,
  }),
]);
export type DashboardSession = typeof DashboardSession.Type;

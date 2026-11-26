/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { expect } from 'vitest';
import { env } from 'cloudflare:test';
import type {
  D1DatabaseLike,
  IssueGrantInput,
  IssueGrantV2Result,
  RevokeGrantInput,
  RevokeGrantResult,
} from '../../apps/inference-worker/src/grants';
import type {
  ModelProfile,
  ModelUsageSummary,
  RouteEffortControls,
} from '../../packages/contracts/src';

interface InferenceBinding {
  fetch(request: Request): Promise<Response>;
  issueV2(input: IssueGrantInput): Promise<IssueGrantV2Result>;
  revoke(input: RevokeGrantInput): Promise<RevokeGrantResult>;
  usage(input: { jobId: string }): Promise<ModelUsageSummary | null>;
}

interface UpstreamState {
  readonly requests: readonly {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  }[];
  readonly cancellations: number;
}

interface RuntimeEnv {
  readonly RELAY_DB: D1DatabaseLike;
  readonly INFERENCE: InferenceBinding;
  readonly UPSTREAM: {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  };
}

export const runtime = env as unknown as RuntimeEnv;

export const d1Now = async () => {
  const row = await runtime.RELAY_DB.prepare(
    "SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS now",
  ).first<{ readonly now: number }>();
  if (row === null) throw new Error('missing D1 clock');
  return row.now;
};

export const control = async (scenario: string, extra: Record<string, unknown> = {}) => {
  const response = await runtime.UPSTREAM.fetch(
    new Request('https://upstream.internal/__control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario, ...extra }),
    }),
  );
  expect(response.status).toBe(200);
};

export const upstreamState = async (): Promise<UpstreamState> => {
  const response = await runtime.UPSTREAM.fetch(new Request('https://upstream.internal/__state'));
  return (await response.json()) as UpstreamState;
};

type TestRoute = {
  readonly routeId: string;
  readonly upstreamModel: string;
  readonly providerSlug: string;
  readonly credentialAlias: string;
  readonly profile?: ModelProfile;
  readonly effort?: { readonly name: string; readonly controls: RouteEffortControls };
};

export const issueGrant = async (jobId: string, routes: readonly TestRoute[]) => {
  for (const route of routes) {
    await runtime.RELAY_DB.prepare(
      `INSERT OR IGNORE INTO catalog_routes
      (route_id, upstream_model, provider_slug, credential_alias, profile)
      VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        route.routeId,
        route.upstreamModel,
        route.providerSlug,
        route.credentialAlias,
        route.profile ?? 'chat',
      )
      .run();
  }
  const efforts = routes.flatMap((route) =>
    route.effort === undefined ? [] : [{ routeId: route.routeId, generation: 0, ...route.effort }],
  );
  const result = await runtime.INFERENCE.issueV2({
    jobId,
    snapshot: {
      routes: routes.map((route) => route.routeId),
      ...(efforts.length === 0 ? {} : { efforts }),
    },
    latestIssueDeadline: (await d1Now()) + 60_000,
  });
  if (result.kind !== 'issued') throw new Error('expected profiled grant');
  return result.token;
};

export const post = (
  token: string,
  path: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) =>
  runtime.INFERENCE.fetch(
    new Request(`https://inference.internal${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...extraHeaders },
      body: JSON.stringify(body),
    }),
  );

import { createRelayCatalog } from './catalog';
import { RelayCatalogSources } from './catalog-config';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Effect, Option, Schema } from 'effect';
import {
  ModelRouteId,
  readBoundedRequestBody,
  type EffortJobDetail,
  type ModelProfile,
  type ModelUsageSummary,
} from '@compte-rendu/contracts';
import {
  createGrantControl,
  type D1DatabaseLike,
  type IssueGrantInput,
  type IssueGrantV2Result,
  type RevokeGrantInput,
  type RevokeGrantResult,
} from './grants.ts';
import {
  admitRequest,
  authenticateGrant,
  readEffortDetails,
  readRouteEffortStates,
  readUsage,
  sweep,
  type AuthenticatedGrant,
} from './ledger.ts';
import { relayInference, validateChatBody, type GatewayConfig } from './relay.ts';
import { protocolForRequest } from './protocols.ts';
import { relayResponses, responsesUpstreamBody, validateResponsesBody } from './responses.ts';
import type { FrozenRoute } from './routes.ts';

const INFERENCE_MAX_BYTES = 16 * 1024 * 1024;
const GatewayIdentity = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UsageInput = Schema.Struct({ jobId: Schema.NonEmptyString });
const CatalogInput = Schema.Struct({
  includeModels: Schema.optionalKey(Schema.Boolean),
  models: Schema.optionalKey(Schema.Boolean),
});
const DetailInput = Schema.Struct({
  jobId: Schema.NonEmptyString,
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  route: Schema.optionalKey(ModelRouteId),
});

export interface InferenceWorkerEnv {
  readonly RELAY_CATALOG_SOURCES: string;
  readonly RELAY_DB: D1DatabaseLike;
  readonly AI_GATEWAY_ACCOUNT_ID?: string;
  readonly AI_GATEWAY_ID?: string;
  readonly AI_GATEWAY_RUN_TOKEN?: string;
}

const json = (body: unknown, status: number): Response =>
  Response.json(body, {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const error = (status: number, message: string): Response => json({ error: { message } }, status);

const gatewayConfig = (env: InferenceWorkerEnv): GatewayConfig | null => {
  const accountId = env.AI_GATEWAY_ACCOUNT_ID;
  const gatewayId = env.AI_GATEWAY_ID;
  const runToken = env.AI_GATEWAY_RUN_TOKEN;
  if (
    accountId === undefined ||
    gatewayId === undefined ||
    runToken === undefined ||
    !GatewayIdentity.test(accountId) ||
    !GatewayIdentity.test(gatewayId) ||
    runToken.trim().length === 0
  )
    return null;
  return { accountId, gatewayId, runToken: runToken.trim() };
};

const selectedRoute = (
  grant: AuthenticatedGrant,
  body: Record<string, unknown>,
): FrozenRoute | null => {
  const model = body.model;
  if (typeof model !== 'string') return null;
  return grant.routes.find((route) => route.routeId === model) ?? null;
};

const validateForProfile = (
  profile: ModelProfile,
  raw: unknown,
): Record<string, unknown> | null => {
  if (profile === 'responses') return validateResponsesBody(raw);
  return validateChatBody(raw);
};

export class InferenceWorker extends WorkerEntrypoint<InferenceWorkerEnv> {
  private async handleInference(request: Request, profile: ModelProfile): Promise<Response> {
    const grant = await authenticateGrant(this.env.RELAY_DB, request.headers.get('authorization'));
    if (grant === null) return error(401, 'unauthorized');
    const gateway = gatewayConfig(this.env);
    if (gateway === null) return error(503, 'service unavailable');

    const bounded = await readBoundedRequestBody(request, INFERENCE_MAX_BYTES);
    if (bounded.kind === 'too-large') return error(413, 'request too large');
    let raw: unknown;
    try {
      raw = JSON.parse(bounded.text) as unknown;
    } catch {
      return error(400, 'invalid request');
    }
    const body = validateForProfile(profile, raw);
    if (body === null) return error(400, 'invalid request');
    const route = selectedRoute(grant, body);
    if (route?.profile !== profile) return error(403, 'route forbidden');

    const requestId = crypto.randomUUID();
    const admitted = await admitRequest(this.env.RELAY_DB, requestId, grant, route);
    if (!admitted.admitted) return error(401, 'unauthorized');

    if (profile === 'responses') {
      return Effect.runPromise(
        relayResponses({
          database: this.env.RELAY_DB,
          requestId,
          gateway,
          grant,
          route,
          body: responsesUpstreamBody(body, route),
          request,
          waitUntil: (task) => this.ctx.waitUntil(task),
        }),
      );
    }

    return Effect.runPromise(
      relayInference({
        database: this.env.RELAY_DB,
        requestId,
        gateway,
        grant,
        route,
        body,
        fallbackAt: admitted.fallbackAt,
        fallbackReason: admitted.fallbackReason,
        request,
        waitUntil: (task) => this.ctx.waitUntil(task),
      }),
    );
  }

  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    const profile = protocolForRequest(url);
    if (profile === null) {
      return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { 'cache-control': 'no-store' } });
    }
    return this.handleInference(request, profile);
  }

  #modelCatalog() {
    const sources = Schema.decodeUnknownSync(Schema.fromJsonString(RelayCatalogSources), {
      onExcessProperty: 'error',
    })(this.env.RELAY_CATALOG_SOURCES);
    return createRelayCatalog(this.env.RELAY_DB, sources, gatewayConfig(this.env));
  }

  catalog(input: unknown = {}) {
    const decoded = Schema.decodeUnknownOption(CatalogInput, { onExcessProperty: 'error' })(input);
    if (Option.isNone(decoded)) return this.#modelCatalog().get();
    const { includeModels, models } = decoded.value;
    return this.#modelCatalog().get(
      includeModels === true || models === true ? { includeModels: true } : {},
    );
  }

  refreshCatalog(scheduledTime: number) {
    return this.#modelCatalog().refresh(scheduledTime);
  }

  issueV2(input: IssueGrantInput): Promise<IssueGrantV2Result> {
    return createGrantControl(this.env.RELAY_DB).issueV2(input);
  }

  revoke(input: RevokeGrantInput): Promise<RevokeGrantResult> {
    return createGrantControl(this.env.RELAY_DB).revoke(input);
  }

  usage(input: { readonly jobId: string }): Promise<ModelUsageSummary | null> {
    const decoded = Schema.decodeUnknownOption(UsageInput, { onExcessProperty: 'error' })(input);
    if (Option.isNone(decoded)) return Promise.resolve(null);
    return readUsage(this.env.RELAY_DB, decoded.value.jobId);
  }

  effortStates(): Promise<{ readonly routes: Awaited<ReturnType<typeof readRouteEffortStates>> }> {
    return readRouteEffortStates(this.env.RELAY_DB).then((routes) => ({ routes }));
  }

  effortDetails(input: {
    readonly jobId: string;
    readonly cursor?: string;
    readonly route?: string;
  }): Promise<EffortJobDetail | null> {
    const decoded = Schema.decodeUnknownOption(DetailInput, { onExcessProperty: 'error' })(input);
    if (Option.isNone(decoded)) return Promise.resolve(null);
    return readEffortDetails(
      this.env.RELAY_DB,
      decoded.value.jobId,
      decoded.value.cursor,
      decoded.value.route,
    );
  }

  sweep(): Promise<number> {
    return sweep(this.env.RELAY_DB);
  }

  async scheduled(): Promise<void> {
    await sweep(this.env.RELAY_DB);
  }
}

export default InferenceWorker;

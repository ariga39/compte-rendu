import { DateTime, Effect, Option, Schema } from 'effect';
import {
  type EffortJobDetail,
  type EffortRouteState,
  type FrozenRouteEffort,
  type ModelRouteDescriptor,
  type ModelUsageSummary,
  RUNNER_LLM_CONTROL_TIMEOUT_MS,
  readBoundedRequestBody,
  ReviewConfiguration,
  ReviewModelSelection,
} from '@compte-rendu/contracts';
import type { CoreWorkerEnv } from './core-worker';

const JobId = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const RequestGrant = Schema.Struct({
  runId: JobId,
  jobId: JobId,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  routes: ReviewModelSelection.fields.reviewers,
});

export interface RelayControl {
  revoke(input: { jobId: string }): Promise<{ kind: 'revoked' | 'invalid' }>;
  usage(input: { jobId: string }): Promise<ModelUsageSummary | null>;
  issue(input: {
    jobId: string;
    snapshot: { routes: readonly string[]; efforts?: readonly FrozenRouteEffort[] };
    latestIssueDeadline: number;
  }): Promise<
    | { kind: 'issued'; token: string; expiresAt: string }
    | { kind: 'duplicate' | 'deadline-exceeded' | 'invalid' }
  >;
  issueV2?(input: {
    jobId: string;
    snapshot: { routes: readonly string[]; efforts?: readonly FrozenRouteEffort[] };
    latestIssueDeadline: number;
  }): Promise<
    | {
        kind: 'issued';
        token: string;
        expiresAt: string;
        descriptors: readonly ModelRouteDescriptor[];
      }
    | { kind: 'duplicate' | 'deadline-exceeded' | 'invalid' }
  >;
  effortStates?(): Promise<{ routes: readonly EffortRouteState[] }>;
  effortDetails?(input: { jobId: string; cursor?: string }): Promise<EffortJobDetail | null>;
}

export async function handleRunnerLlmControl(
  request: Request,
  env: CoreWorkerEnv,
  callbackToken?: string,
) {
  const path = new URL(request.url).pathname;
  const issuePath = path === '/runner-llm/issue-v2' ? 2 : path === '/runner-llm/issue' ? 1 : null;
  if (issuePath === null && !['/runner-llm/usage', '/runner-llm/revoke'].includes(path))
    return new Response(null, { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (!callbackToken || request.headers.get('authorization') !== 'Bearer ' + callbackToken)
    return new Response(null, { status: 401 });
  if (!env.INFERENCE_RELAY) return new Response(null, { status: 503 });
  if (issuePath === 2 && env.INFERENCE_RELAY.issueV2 === undefined)
    return new Response(null, { status: 503 });
  try {
    const payload = await readBoundedRequestBody(request, 16 * 1024);
    if (payload.kind !== 'ok') return new Response(null, { status: 413 });
    const body = payload.text;
    if (issuePath === null) {
      const job = Schema.decodeUnknownOption(
        Schema.fromJsonString(Schema.Struct({ jobId: JobId })),
        { onExcessProperty: 'error' },
      )(body);
      if (Option.isNone(job)) return new Response(null, { status: 400 });
      if (path === '/runner-llm/revoke') {
        const result = await env.INFERENCE_RELAY.revoke(job.value);
        return new Response(null, { status: result.kind === 'revoked' ? 204 : 503 });
      }
      const summary = await env.INFERENCE_RELAY.usage(job.value);
      return summary === null
        ? new Response(null, { status: 404 })
        : Response.json(summary, { headers: { 'cache-control': 'no-store' } });
    }
    const input = Schema.decodeUnknownOption(Schema.fromJsonString(RequestGrant), {
      onExcessProperty: 'error',
    })(body);
    if (Option.isNone(input)) return new Response(null, { status: 400 });
    const { runId, jobId, attempt, routes } = input.value;
    const now = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)));
    const row = await env.REVIEW_DB.prepare(
      "SELECT review_configuration FROM review_runs WHERE run_id = ? AND runner_job_id = ? AND runner_attempt = ? AND status = 'scheduled'",
    )
      .bind(runId, jobId, attempt)
      .first<{ review_configuration: string | null }>();
    if (!row?.review_configuration) return new Response(null, { status: 409 });
    const configuration = Schema.decodeUnknownSync(Schema.fromJsonString(ReviewConfiguration))(
      row.review_configuration,
    );
    const selection = configuration.selection;
    if (!selection) return new Response(null, { status: 409 });
    const allowed = new Set(selection.reviewers);
    if (selection.reviewers.length > 1) allowed.add(selection.synthesis);
    if (routes.length !== allowed.size || routes.some((route) => !allowed.has(route)))
      return new Response(null, { status: 409 });
    // The admission snapshot is authoritative, but a snapshot frozen by an
    // older build may contain entries for routes this job does not call. Send
    // only granted routes, and never forward an ungranted control. A
    // generation-only default entry carries no instruction, so omit it;
    // nonzero generations stay so reset state remains ordered.
    const efforts = (configuration.efforts ?? []).filter(
      (effort) =>
        allowed.has(effort.routeId) && (effort.name !== undefined || effort.generation > 0),
    );
    // v1 cannot carry explicit controls. Refuse the grant rather than silently
    // dropping the operator's selection.
    if (
      issuePath === 1 &&
      efforts.some((effort) => effort.name !== undefined || effort.controls !== undefined)
    )
      return new Response(null, { status: 409 });
    const snapshot =
      issuePath === 2 && efforts.length > 0
        ? { routes: [...allowed], efforts }
        : { routes: [...allowed] };
    const latestIssueDeadline = now + RUNNER_LLM_CONTROL_TIMEOUT_MS;
    if (issuePath === 2) {
      const reply = await env.INFERENCE_RELAY.issueV2!({
        jobId,
        snapshot,
        latestIssueDeadline,
      });
      if (reply.kind !== 'issued')
        return new Response(null, { status: reply.kind === 'duplicate' ? 409 : 503 });
      return Response.json(
        {
          token: reply.token,
          expiresAt: reply.expiresAt,
          descriptors: reply.descriptors,
        },
        { status: 201, headers: { 'cache-control': 'no-store' } },
      );
    }
    const reply = await env.INFERENCE_RELAY.issue({
      jobId,
      snapshot,
      latestIssueDeadline,
    });
    if (reply.kind !== 'issued')
      return new Response(null, { status: reply.kind === 'duplicate' ? 409 : 503 });
    return Response.json(
      { token: reply.token, expiresAt: reply.expiresAt },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return new Response(null, { status: 503 });
  }
}

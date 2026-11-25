import { Option, Schema } from 'effect';
import { MetadataInvalidationEvent, ReviewEvent } from '../../packages/contracts/src';
import {
  createCoreWorker as createTypedCoreWorker,
  type CoreWorkerDependencies,
  type CoreWorkerEnv,
} from '../../apps/core/src/core-worker';

type WaitUntil = { waitUntil(task: Promise<unknown>): void };

/**
 * PR 1 keeps the former internal Core HTTP call shape available to the existing
 * Core behavior suites. Production no longer serves these internal paths; PR 2
 * migrates these call sites to the typed Core methods removed below.
 */
export const createCoreWorker = (env: CoreWorkerEnv, dependencies: CoreWorkerDependencies = {}) => {
  const core = createTypedCoreWorker(env, dependencies);
  return {
    ...core,
    fetch: async (request: Request, _env?: unknown, context?: WaitUntil): Promise<Response> => {
      const url = new URL(request.url);
      if (
        url.pathname === '/review-configuration' ||
        url.pathname === '/review-configuration/efforts/reset'
      )
        return core.handleReviewConfiguration(request);
      if (request.method === 'POST' && url.pathname === '/runner-claims') {
        try {
          return await core.claimRunnerJob(request, context);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && url.pathname === '/runner-read-token') {
        try {
          return await core.renewRunnerReadToken(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && url.pathname === '/runner-results') {
        try {
          return await core.handleRunnerCallback(request, context);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && url.pathname === '/runner-evidence') {
        try {
          return await core.handleRunnerEvidence(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && url.pathname === '/runner-progress') {
        try {
          return await core.handleRunnerProgress(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && url.pathname === '/metadata-events') {
        const body = await request.json().catch(() => undefined);
        const event = Option.getOrUndefined(
          Schema.decodeUnknownOption(MetadataInvalidationEvent, { onExcessProperty: 'error' })(
            body,
          ),
        );
        if (event === undefined) return new Response(null, { status: 400 });
        try {
          await core.invalidateMetadata(event);
          return new Response(null, { status: 202 });
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/dashboard-config')
        return core.getDashboardConfig();
      if (request.method === 'GET') {
        try {
          if (url.pathname === '/api/dashboard') return await core.getDashboardOverview();
          if (url.pathname === '/api/jobs') return await core.listPublicJobs(url.searchParams);
          if (url.pathname.startsWith('/api/jobs/'))
            return await core.getPublicJobDetail(url.pathname.slice('/api/jobs/'.length));
        } catch {
          return new Response(null, {
            status: 503,
            headers: { 'cache-control': 'no-store' },
          });
        }
      }
      if (request.method === 'POST' && url.pathname === '/review-events') {
        const body = await request.json().catch(() => undefined);
        if (body === undefined) return new Response(null, { status: 400 });
        const event = Option.getOrUndefined(Schema.decodeUnknownOption(ReviewEvent)(body));
        if (event === undefined) return new Response(null, { status: 400 });
        return (await core.submitReviewEvent(event, context)) === 'failed'
          ? new Response(null, { status: 503 })
          : new Response(null, { status: 202 });
      }
      return new Response(null, { status: 404 });
    },
  };
};

export { type CoreWorkerDependencies, type CoreWorkerEnv } from '../../apps/core/src/core-worker';

import { createCoreWorker, type CoreWorkerEnv } from '../../apps/core/src/core-worker';
import { createD1ReviewStateStore } from '../../apps/core/src/index';

interface RunnerCaptureBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

interface RuntimeCoreEnv extends CoreWorkerEnv {
  readonly RUNNER: RunnerCaptureBinding;
}

export default {
  fetch: async (request: Request, env: RuntimeCoreEnv) => {
    const url = new URL(request.url);

    if (url.pathname === '/__test/capture') {
      return env.RUNNER.fetch(request);
    }

    if (url.pathname === '/__test/outcome') {
      const deliveryId = url.searchParams.get('deliveryId');
      if (deliveryId === null) return new Response(null, { status: 400 });
      const outcome = await createD1ReviewStateStore(env.REVIEW_DB).getDeliveryOutcome(deliveryId);
      if (outcome === undefined) return new Response(null, { status: 404 });
      const run = await env.REVIEW_DB.prepare(
        'SELECT run_id FROM review_runs WHERE delivery_id = ?',
      )
        .bind(deliveryId)
        .first<{ run_id: string }>();
      return Response.json({ ...outcome, runId: run?.run_id });
    }

    if (url.pathname === '/__test/failed-review' && request.method === 'POST') {
      const stateStore = createD1ReviewStateStore(env.REVIEW_DB);
      const claim = await stateStore.claimReview({
        deliveryId: 'runtime-failed-review',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 43,
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
          trigger: 'automatic',
        },
        occurredAt: '2026-09-12T00:00:00.000Z',
      });
      if (claim.kind !== 'claimed') return new Response(null, { status: 409 });
      await stateStore.recordCheckRun?.({ runId: claim.runId, checkRunId: 321 });
      await stateStore.markSchedulingFailed({
        runId: claim.runId,
        occurredAt: '2026-09-12T00:01:00.000Z',
      });
      return Response.json({ runId: claim.runId, checkRunId: 321 });
    }

    const worker = createCoreWorker(
      { ...env },
      {
        github: {
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          getPullRequest: async () => ({
            repositoryVisibility: 'public',
            baseRepositoryId: 11,
            headRepositoryId: 99,
            draft: false,
            baseSha: '1111111111111111111111111111111111111111',
            headSha: '3333333333333333333333333333333333333333',
          }),
          getCommenterPermission: async () => 'write',
        },
        getReadInstallationToken: async () => ({
          token: 'test-read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );
    return worker.fetch(request, env);
  },
};

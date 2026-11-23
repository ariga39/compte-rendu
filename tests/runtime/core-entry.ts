import {
  createApplication,
  type ApplicationEnv,
} from '../../apps/dashboard/src/lib/server/application';
import { createD1ReviewStateStore } from '../../apps/core/src/index';

interface RunnerCaptureBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

interface RuntimeCoreEnv extends ApplicationEnv {
  readonly RUNNER: RunnerCaptureBinding;
}

let currentHead = '2222222222222222222222222222222222222222';

export default {
  fetch: async (request: Request, env: RuntimeCoreEnv) => {
    const url = new URL(request.url);
    if (url.pathname === '/webhooks/github') {
      if (request.headers.get('x-github-event') === 'pull_request') {
        const payload = (await request.clone().json()) as {
          pull_request: { head: { sha: string } };
        };
        currentHead = payload.pull_request.head.sha;
      } else {
        currentHead = '3333333333333333333333333333333333333333';
      }
    }

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

    if (
      ['/__test/failed-review', '/__test/cancelled-review'].includes(url.pathname) &&
      request.method === 'POST'
    ) {
      const stateStore = createD1ReviewStateStore(env.REVIEW_DB);
      const pr = Number(url.searchParams.get('pr'));
      const claim = await stateStore.claimReview({
        deliveryId: `runtime-original-${pr}`,
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: pr,
          baseSha: '1111111111111111111111111111111111111111',
          headSha: url.pathname.endsWith('/failed-review') ? '2'.repeat(40) : '3'.repeat(40),
          trigger: 'automatic',
        },
        occurredAt: '2026-09-12T00:00:00.000Z',
      });
      if (claim.kind !== 'claimed') return new Response(null, { status: 409 });
      await stateStore.recordCheckRun?.({ runId: claim.runId, checkRunId: 321 });
      if (url.pathname.endsWith('/cancelled-review')) {
        await stateStore.cancelRun({
          runId: claim.runId,
          requestedByUid: 42,
          occurredAt: '2026-09-12T00:01:00.000Z',
        });
      } else
        await stateStore.markSchedulingFailed({
          runId: claim.runId,
          occurredAt: '2026-09-12T00:01:00.000Z',
        });
      return Response.json({ runId: claim.runId, checkRunId: 321 });
    }

    const worker = createApplication(
      { ...env },
      {
        github: {
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          loadReviewTarget: async () => ({ headSha: currentHead }),
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
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      },
    );
    return worker.fetch(request);
  },
};

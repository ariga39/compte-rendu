import { createCoreWorker, type CoreWorkerEnv } from '../../apps/core/src/core-worker';
import { createD1ReviewStateStore } from '../../apps/core/src/index';

interface WorkflowCaptureBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

interface RuntimeCoreEnv extends CoreWorkerEnv {
  readonly WORKFLOW_CAPTURE: WorkflowCaptureBinding;
}

export default {
  fetch: async (request: Request, env: RuntimeCoreEnv) => {
    const url = new URL(request.url);

    if (url.pathname === '/__test/capture') {
      return env.WORKFLOW_CAPTURE.fetch(request);
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

    const worker = createCoreWorker({
      ...env,
      REVIEW_WORKFLOW: {
        create: async (input) => {
          const response = await env.WORKFLOW_CAPTURE.fetch(
            new Request('https://workflow-capture.internal/create', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(input),
            }),
          );
          if (!response.ok) throw new Error('workflow capture failed');
        },
      },
    });
    return worker.fetch(request, env);
  },
};

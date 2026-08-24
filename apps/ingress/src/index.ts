import { Effect } from 'effect';
import type { WorkerEntrypoint } from '@compte-rendu/contracts';

const ingress: WorkerEntrypoint = {
  fetch: () => Effect.runPromise(Effect.succeed(new Response(null, { status: 501 }))),
};

export default ingress;

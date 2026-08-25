import { Schema } from 'effect';

export interface WorkerEntrypoint<Env = unknown> {
  fetch(request: Request, env?: Env): Response | Promise<Response>;
}

export interface CoreServiceBinding {
  fetch(request: Request): Response | Promise<Response>;
}

export const ReviewEvent = Schema.Struct({
  deliveryId: Schema.String,
  event: Schema.Literal('pull_request'),
  action: Schema.Literals(['opened', 'reopened', 'synchronize', 'ready_for_review']),
  repositoryId: Schema.Int,
  pullRequestNumber: Schema.Int,
  installationId: Schema.Int,
  baseSha: Schema.String,
  headSha: Schema.String,
});

export type ReviewEvent = typeof ReviewEvent.Type;

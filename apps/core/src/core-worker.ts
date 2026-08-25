import { Effect, Schema } from 'effect';
import { ReviewEvent } from '@compte-rendu/contracts';
import {
  createD1ReviewStateStore,
  createGitHubPublicationAdapter,
  createGitHubAppTokenProvider,
  createReviewCoordinator,
  type CoreEnv,
  type GitHubAdapter,
  type ReviewPublicationStateStore,
  type ReviewScheduler,
} from './index';
import type { D1DatabaseLike } from './review-state-store';
import type { WorkerEntrypoint } from '@compte-rendu/contracts';
import { ReviewWorkflowInput } from './review-workflow';
export { ReviewWorkflowInput } from './review-workflow';

export interface ReviewWorkflowBinding {
  readonly create: (input: {
    readonly id: string;
    readonly params: ReviewWorkflowInput;
  }) => Promise<unknown>;
}

export interface CoreWorkerEnv extends CoreEnv {
  readonly REVIEW_DB: D1DatabaseLike;
  readonly REVIEW_WORKFLOW: ReviewWorkflowBinding;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly MODEL_API_KEY: string;
}

export interface CoreWorkerDependencies {
  readonly github?: GitHubAdapter;
  readonly stateStore?: ReviewPublicationStateStore;
}

const reviewEventsPath = '/review-events';

const createWorkflowScheduler = (workflow: ReviewWorkflowBinding): ReviewScheduler => ({
  schedule: async (job, runId) => {
    const params = await Schema.decodeUnknownPromise(ReviewWorkflowInput)({ runId, job });
    await workflow.create({ id: runId, params });
  },
});

const responseForDisposition = (
  disposition: Awaited<ReturnType<ReturnType<typeof createReviewCoordinator>['handleReviewEvent']>>,
) => new Response(null, { status: disposition === 'failed' ? 503 : 202 });

export const createCoreWorker = (
  env: CoreWorkerEnv,
  dependencies: CoreWorkerDependencies = {},
): WorkerEntrypoint<CoreWorkerEnv> => {
  const tokenProvider = createGitHubAppTokenProvider({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    crypto: globalThis.crypto,
  });
  const github =
    dependencies.github ??
    createGitHubPublicationAdapter({
      token: tokenProvider.getInstallationToken,
    });
  const stateStore = dependencies.stateStore ?? createD1ReviewStateStore(env.REVIEW_DB);
  const coordinator = createReviewCoordinator({
    github,
    stateStore,
    scheduler: createWorkflowScheduler(env.REVIEW_WORKFLOW),
  });

  return {
    fetch: async (request) => {
      if (request.method !== 'POST' || new URL(request.url).pathname !== reviewEventsPath) {
        return new Response(null, { status: 404 });
      }

      const body = await Effect.runPromise(
        Effect.tryPromise({
          try: () => request.json(),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined))),
      );
      if (body === undefined) return new Response(null, { status: 400 });

      const event = await Effect.runPromise(
        Schema.decodeUnknownEffect(ReviewEvent)(body).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      );
      if (event === undefined) return new Response(null, { status: 400 });

      try {
        const disposition = await coordinator.handleReviewEvent(event);
        return responseForDisposition(disposition);
      } catch {
        return new Response(null, { status: 503 });
      }
    },
  };
};

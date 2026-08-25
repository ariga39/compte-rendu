import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  createCloudflareReviewRunner,
  createD1ReviewStateStore,
  createGitHubAppTokenProvider,
  createGitHubPublicationAdapter,
  createReviewCoordinator,
  type ReviewDisposition,
} from './index';
import {
  runReviewWorkflow,
  ReviewWorkflowInput,
  type ReviewWorkflowEnvironment,
  type ReviewWorkflowStep,
} from './review-workflow';
import { createCloudflareOperationalLog } from './operational-log';

export { ReviewSandboxContainer as Sandbox } from './sandbox-container';
export {
  createCoreWorker,
  ReviewWorkflowInput,
  type CoreWorkerDependencies,
  type CoreWorkerEnv,
  type ReviewWorkflowBinding,
} from './core-worker';
export {
  runReviewWorkflow,
  type ReviewWorkflowDependencies,
  type ReviewWorkflowEnvironment,
  type ReviewWorkflowStep,
} from './review-workflow';
export { ReviewLeaseDurableObject } from './cloudflare-review-adapter';
export * from './index';

import { createCoreWorker, type CoreWorkerEnv } from './core-worker';

export class ReviewWorkflow extends WorkflowEntrypoint<
  ReviewWorkflowEnvironment,
  typeof ReviewWorkflowInput.Type
> {
  async run(
    event: WorkflowEvent<typeof ReviewWorkflowInput.Type>,
    step: WorkflowStep,
  ): Promise<ReviewDisposition> {
    const tokenProvider = createGitHubAppTokenProvider({
      appId: this.env.GITHUB_APP_ID,
      privateKey: this.env.GITHUB_APP_PRIVATE_KEY,
      crypto: globalThis.crypto,
    });
    const github = createGitHubPublicationAdapter({
      token: tokenProvider.getInstallationToken,
    });
    const stateStore = createD1ReviewStateStore(this.env.REVIEW_DB);
    const coordinator = createReviewCoordinator({
      github,
      stateStore,
      scheduler: { schedule: async () => {} },
      log: createCloudflareOperationalLog(),
    });
    const runner = createCloudflareReviewRunner(this.env);
    const workflowStep: ReviewWorkflowStep = {
      do: (name, options, operation) =>
        step.do(
          name,
          {
            retries: { limit: options.retries.limit, delay: options.retries.delay },
            timeout: options.timeout,
          },
          operation,
        ),
    };

    return runReviewWorkflow(event.payload, workflowStep, {
      getRepositoryUrl: async (input) => {
        if (github.getRepositoryUrl === undefined) throw new Error('Repository lookup unavailable');
        return github.getRepositoryUrl(input);
      },
      getInstallationToken: tokenProvider.getInstallationToken,
      modelCredential: this.env.MODEL_API_KEY,
      runWithLease: (spec) => runner.runWithLease(spec),
      completeReview: (input) => coordinator.completeReview(input),
      markRunFailed: (input) => stateStore.markSchedulingFailed(input),
      getRunOutcome: (runId) => stateStore.getRunOutcome(runId),
      addReaction: github.addReaction ? (input) => github.addReaction!(input) : undefined,
      log: createCloudflareOperationalLog(),
    });
  }
}

const core = {
  fetch: (request: Request, env?: CoreWorkerEnv) =>
    env === undefined
      ? new Response(null, { status: 501 })
      : createCoreWorker(env).fetch(request, env),
};

export default core;

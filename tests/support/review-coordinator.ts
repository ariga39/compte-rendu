import { Effect } from 'effect';
import {
  createReviewAdmission,
  type ReviewAdmissionStore,
} from '../../apps/core/src/review-admission';
import type { GitHubAdapter } from '../../apps/core/src/github-adapter-contract';
import type { OperationalLog } from '../../packages/contracts/src';
import type { CoreLifecycleLog } from '../../apps/core/src/core-observability';
import type {
  CancelRunnerJob,
  ReviewCheckSetupDefer,
  ReviewDisposition,
} from '../../apps/core/src/review-records';

/**
 * Test-edge execution of the actual typed admission and publication Effects.
 * Production runs the same operations from the application and Worker entry
 * points; this helper adds no disposition or error mapping.
 */
export const createReviewCoordinator = (dependencies: {
  readonly github: GitHubAdapter;
  readonly stateStore: ReviewAdmissionStore;
  readonly cancelRunnerJob?: CancelRunnerJob;
  readonly deferCheckSetup?: ReviewCheckSetupDefer;
  readonly log?: OperationalLog;
  readonly lifecycleLog?: CoreLifecycleLog;
}) => {
  const admission = createReviewAdmission(dependencies);
  return {
    handleReviewEvent: (event: unknown): Promise<ReviewDisposition> =>
      Effect.runPromise(admission.handleReviewEvent(event)),
    completeReview: (input: {
      runId: string;
      output: unknown;
      reconcileClaimedAt?: string;
    }): Promise<ReviewDisposition> => Effect.runPromise(admission.completeReview(input)),
  };
};

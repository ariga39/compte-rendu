import { describe, expect, it } from 'vitest';
import {
  runReviewWorkflow,
  type ReviewWorkflowDependencies,
  type ReviewWorkflowStep,
} from '../apps/core/src/review-workflow';
import type { ReviewJob } from '../apps/core/src/index';
import type { ReviewRunSpec } from '../apps/core/src/review-run';

const job: ReviewJob = {
  repositoryId: 11,
  pullRequestNumber: 42,
  installationId: 7,
  baseSha: '1111111111111111111111111111111111111111',
  headSha: '2222222222222222222222222222222222222222',
  trigger: 'automatic',
};

describe('Review workflow', () => {
  it('runs immutable review identity and completes the published result', async () => {
    let leaseSpec: ReviewRunSpec | undefined;
    let completedOutput: unknown;
    const step: ReviewWorkflowStep = {
      do: async (_name, _options, operation) => operation(),
    };
    const dependencies: ReviewWorkflowDependencies = {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      getInstallationToken: async () => 'installation-token',
      modelCredential: 'model-token',
      runWithLease: async (spec) => {
        leaseSpec = spec;
        return {
          status: 'succeeded',
          attempt: 1,
          sandboxId: 'run-workflow-1-attempt-1',
          output: { findings: [], summary: 'No findings' },
        };
      },
      completeReview: async ({ output }) => {
        completedOutput = output;
        return 'completed';
      },
      markRunFailed: async () => {},
    };

    const disposition = await runReviewWorkflow(
      { runId: 'run-workflow-1', job },
      step,
      dependencies,
    );

    expect(disposition).toBe('completed');
    expect(leaseSpec).toMatchObject({
      runId: 'run-workflow-1',
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha: job.baseSha,
      headSha: job.headSha,
      checkoutToken: 'installation-token',
      modelCredential: 'model-token',
      maxAttempts: 2,
    });
    expect(completedOutput).toEqual({ findings: [], summary: 'No findings' });
  });

  it('records a terminal failure when the leased runner fails', async () => {
    let failedRunId = '';
    let publicationAttempted = false;
    const dependencies: ReviewWorkflowDependencies = {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      getInstallationToken: async () => 'installation-token',
      modelCredential: 'model-token',
      runWithLease: async () => ({
        status: 'failed',
        reason: 'agent',
        attempt: 1,
        retryable: false,
        leaseRetained: false,
      }),
      completeReview: async () => {
        publicationAttempted = true;
        return 'completed';
      },
      markRunFailed: async ({ runId }) => {
        failedRunId = runId;
      },
    };

    const disposition = await runReviewWorkflow(
      { runId: 'run-workflow-failed', job },
      { do: async (_name, _options, operation) => operation() },
      dependencies,
    );

    expect(disposition).toBe('failed');
    expect(failedRunId).toBe('run-workflow-failed');
    expect(publicationAttempted).toBe(false);
  });
});

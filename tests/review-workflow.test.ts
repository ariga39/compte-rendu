import { describe, expect, it } from 'vitest';
import {
  runReviewWorkflow,
  type ReviewWorkflowDependencies,
  type ReviewWorkflowStep,
} from '../apps/core/src/review-workflow';
import type { ReviewJob } from '../apps/core/src/index';
import type { ReviewRunSpec } from '../apps/core/src/review-run';
import type { OperationalLogEvent } from '../packages/contracts/src';

const job: ReviewJob = {
  repositoryId: 11,
  pullRequestNumber: 42,
  installationId: 7,
  baseSha: '1111111111111111111111111111111111111111',
  headSha: '2222222222222222222222222222222222222222',
  trigger: 'automatic',
};

const readTokenServices = {
  getReadInstallationToken: async () => ({
    token: 'read-token',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
  revokeInstallationToken: async (_token: string) => {},
};

describe('Review workflow', () => {
  it('passes a separately minted read token to the Runner and revokes it after terminal cleanup', async () => {
    let jobSpec: ReviewRunSpec | undefined;
    const revoked: string[] = [];
    let fullAuthorityTokenCalls = 0;
    const legacyTokenDependency = {
      getInstallationToken: async () => {
        fullAuthorityTokenCalls += 1;
        return 'publication-token';
      },
    };
    const dependencies: ReviewWorkflowDependencies = {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      ...legacyTokenDependency,
      getReadInstallationToken: async () => ({
        token: 'read-token',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      revokeInstallationToken: async (token) => {
        revoked.push(token);
      },
      runJob: async (spec) => {
        jobSpec = spec;
        return {
          status: 'succeeded',
          attempt: 1,
          sandboxId: 'read-token-run',
          output: '## Review:\n\nNo findings.',
        };
      },
      completeReview: async () => 'completed',
      markRunFailed: async () => {},
    };

    await expect(
      runReviewWorkflow(
        { runId: 'run-read-token', job },
        { do: async (_name, _options, operation) => operation() },
        dependencies,
      ),
    ).resolves.toBe('completed');
    expect(jobSpec).toMatchObject({
      repositoryName: 'acme/reviewed',
      pullRequestNumber: 42,
      baseSha: job.baseSha,
      headSha: job.headSha,
      repositoryReadToken: 'read-token',
    });
    expect(fullAuthorityTokenCalls).toBe(0);
    expect(revoked).toEqual(['read-token']);
  });

  it('does not publish when read-token revocation fails after Runner success', async () => {
    let publicationAttempted = false;
    let revokeAttempts = 0;
    const dependencies: ReviewWorkflowDependencies = {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      ...readTokenServices,
      revokeInstallationToken: async () => {
        revokeAttempts += 1;
        throw new Error('revocation unavailable');
      },
      runJob: async () => ({
        status: 'succeeded',
        attempt: 1,
        sandboxId: 'run-revocation-failure',
        output: '## Review:\n\nNo findings.',
      }),
      completeReview: async () => {
        publicationAttempted = true;
        return 'completed';
      },
      markRunFailed: async () => {},
    };

    await expect(
      runReviewWorkflow(
        { runId: 'run-revocation-failure', job },
        { do: async (_name, _options, operation) => operation() },
        dependencies,
      ),
    ).resolves.toBe('failed');
    expect(publicationAttempted).toBe(false);
    expect(revokeAttempts).toBeGreaterThan(0);
  });

  it('runs immutable review identity and completes the published result', async () => {
    let jobSpec: ReviewRunSpec | undefined;
    let completedOutput: unknown;
    let workflowTimeout: string | undefined;
    const finalMarkdown = '## Review:\n\nNo findings.';
    const reactions: unknown[] = [];
    const events: OperationalLogEvent[] = [];
    const step: ReviewWorkflowStep = {
      do: async (_name, options, operation) => {
        workflowTimeout = options.timeout;
        return operation();
      },
    };
    const dependencies: ReviewWorkflowDependencies = {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      ...readTokenServices,
      runJob: async (spec) => {
        jobSpec = spec;
        await expect(spec.shouldAbort?.()).resolves.toBe(false);
        return {
          status: 'succeeded',
          attempt: 1,
          sandboxId: 'run-workflow-1-attempt-1',
          output: finalMarkdown,
        };
      },
      completeReview: async ({ output }) => {
        completedOutput = output;
        return 'completed';
      },
      markRunFailed: async () => {},
      getRunOutcome: async () => ({ status: 'scheduled' }),
      addReaction: async (input) => {
        reactions.push(input);
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    };

    const disposition = await runReviewWorkflow(
      { runId: 'run-workflow-1', job: { ...job, trigger: 'manual', commentId: 987656 } },
      step,
      dependencies,
    );

    expect(disposition).toBe('completed');
    expect(workflowTimeout).toBe('40 minutes');
    expect(jobSpec).toMatchObject({
      runId: 'run-workflow-1',
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha: job.baseSha,
      headSha: job.headSha,
      repositoryReadToken: 'read-token',
      maxAttempts: 1,
    });
    expect(completedOutput).toBe(finalMarkdown);
    expect(reactions).toEqual([]);
    expect(events).toEqual([
      {
        phase: 'workflow',
        outcome: 'completed',
        runId: 'run-workflow-1',
      },
    ]);
  });

  it('records a terminal failure when the Runner Job fails', async () => {
    let failedRunId = '';
    let publicationAttempted = false;
    const reactions: unknown[] = [];
    const events: OperationalLogEvent[] = [];
    const dependencies: ReviewWorkflowDependencies = {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      ...readTokenServices,
      runJob: async () => ({
        status: 'failed',
        reason: 'agent',
        attempt: 1,
        retryable: false,
      }),
      completeReview: async () => {
        publicationAttempted = true;
        return 'completed';
      },
      addReaction: async (input) => {
        reactions.push(input);
      },
      getRunOutcome: async () => {
        throw new Error('Run status unavailable');
      },
      markRunFailed: async ({ runId }) => {
        failedRunId = runId;
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    };

    const disposition = await runReviewWorkflow(
      {
        runId: 'run-workflow-failed',
        job: { ...job, trigger: 'manual', commentId: 987654 },
      },
      { do: async (_name, _options, operation) => operation() },
      dependencies,
    );

    expect(disposition).toBe('failed');
    expect(failedRunId).toBe('run-workflow-failed');
    expect(publicationAttempted).toBe(false);
    expect(reactions).toEqual([
      {
        repositoryId: 11,
        installationId: 7,
        commentId: 987654,
        content: '-1',
      },
    ]);
    expect(events).toEqual([
      {
        phase: 'workflow',
        outcome: 'failed',
        runId: 'run-workflow-failed',
        reason: 'runner_failed',
      },
    ]);
  });

  it('does not emit a reaction when an automatic Workflow job fails', async () => {
    let failedRunId = '';
    const reactions: unknown[] = [];
    const dependencies: ReviewWorkflowDependencies = {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      ...readTokenServices,
      runJob: async () => ({
        status: 'failed',
        reason: 'agent',
        attempt: 1,
        retryable: false,
      }),
      completeReview: async () => 'completed',
      markRunFailed: async ({ runId }) => {
        failedRunId = runId;
      },
      addReaction: async (input) => {
        reactions.push(input);
      },
    };

    const disposition = await runReviewWorkflow(
      { runId: 'run-workflow-automatic-failed', job },
      { do: async (_name, _options, operation) => operation() },
      dependencies,
    );

    expect(disposition).toBe('failed');
    expect(failedRunId).toBe('run-workflow-automatic-failed');
    expect(reactions).toEqual([]);
  });

  it('records publication failure with a bounded workflow reason', async () => {
    const events: OperationalLogEvent[] = [];
    const dependencies: ReviewWorkflowDependencies = {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      ...readTokenServices,
      runJob: async () => ({
        status: 'succeeded',
        attempt: 1,
        sandboxId: 'run-workflow-publication-failed-attempt-1',
        output: '## Review:\n\nNo findings.',
      }),
      completeReview: async () => 'failed',
      markRunFailed: async () => {},
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    };

    const disposition = await runReviewWorkflow(
      { runId: 'run-workflow-publication-failed', job },
      { do: async (_name, _options, operation) => operation() },
      dependencies,
    );

    expect(disposition).toBe('failed');
    expect(events).toEqual([
      {
        phase: 'workflow',
        outcome: 'failed',
        runId: 'run-workflow-publication-failed',
        reason: 'publication_failed',
      },
    ]);
  });

  it('marks an accepted manual run superseded with a confused reaction', async () => {
    const reactions: unknown[] = [];
    const dependencies: ReviewWorkflowDependencies = {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      ...readTokenServices,
      runJob: async () => ({
        status: 'succeeded',
        attempt: 1,
        sandboxId: 'run-workflow-superseded-attempt-1',
        output: '## Review:\n\nNo findings.',
      }),
      completeReview: async () => 'ignored',
      markRunFailed: async () => {},
      addReaction: async (input) => {
        reactions.push(input);
      },
    };

    const disposition = await runReviewWorkflow(
      {
        runId: 'run-workflow-superseded',
        job: { ...job, trigger: 'manual', commentId: 987655 },
      },
      { do: async (_name, _options, operation) => operation() },
      dependencies,
    );

    expect(disposition).toBe('ignored');
    expect(reactions).toEqual([
      {
        repositoryId: 11,
        installationId: 7,
        commentId: 987655,
        content: 'confused',
      },
    ]);
  });

  it('uses confused feedback when failed work is already superseded', async () => {
    const reactions: unknown[] = [];
    const dependencies: ReviewWorkflowDependencies = {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      ...readTokenServices,
      runJob: async () => ({
        status: 'failed',
        reason: 'agent',
        attempt: 1,
        retryable: false,
      }),
      completeReview: async () => 'failed',
      markRunFailed: async () => {},
      getRunOutcome: async () => ({ status: 'superseded' }),
      addReaction: async (input) => {
        reactions.push(input);
      },
    };

    const disposition = await runReviewWorkflow(
      {
        runId: 'run-workflow-failed-superseded',
        job: { ...job, trigger: 'manual', commentId: 987657 },
      },
      { do: async (_name, _options, operation) => operation() },
      dependencies,
    );

    expect(disposition).toBe('failed');
    expect(reactions).toEqual([
      {
        repositoryId: 11,
        installationId: 7,
        commentId: 987657,
        content: 'confused',
      },
    ]);
  });

  it('records failure when the Workflow step rejects before its callback completes', async () => {
    let failedRunId = '';
    let publicationAttempted = false;
    const events: OperationalLogEvent[] = [];
    const dependencies: ReviewWorkflowDependencies = {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      ...readTokenServices,
      runJob: async () => ({
        status: 'succeeded',
        attempt: 1,
        sandboxId: 'run-workflow-step-1-attempt-1',
        output: '## Review:\n\nNo findings.',
      }),
      completeReview: async () => {
        publicationAttempted = true;
        return 'completed';
      },
      markRunFailed: async ({ runId }) => {
        failedRunId = runId;
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    };

    const disposition = await runReviewWorkflow(
      { runId: 'run-workflow-step-failed', job },
      {
        do: async () => {
          throw new Error('Workflow step timed out');
        },
      },
      dependencies,
    );

    expect(disposition).toBe('failed');
    expect(failedRunId).toBe('run-workflow-step-failed');
    expect(publicationAttempted).toBe(false);
    expect(events).toEqual([
      {
        phase: 'workflow',
        outcome: 'failed',
        runId: 'run-workflow-step-failed',
        reason: 'step_failed',
      },
    ]);
  });
});

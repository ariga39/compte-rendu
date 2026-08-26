import { describe, expect, it } from 'vitest';
import { createRunnerJobClient } from '../apps/core/src/runner-job-client';
import { runReviewWorkflow, type ReviewWorkflowStep } from '../apps/core/src/review-workflow';
import { createRunner } from '../apps/runner/src/runner';

const baseSha = '1111111111111111111111111111111111111111';
const headSha = '2222222222222222222222222222222222222222';

describe('review Workflow runner tracer', () => {
  it('completes through the real client and Runner HTTP handler before publication', async () => {
    const agentOutput = JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: JSON.stringify({ findings: [], summary: 'No findings' }),
      },
    });
    const runner = createRunner({
      authToken: 'runner-tracer-token',
      modelSecretCommand: 'test-secret-resolver',
      process: async (_command, args, options = {}) => ({
        exitCode: 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : options.captureStdout === true
            ? `${agentOutput}\n`
            : '',
        timedOut: false,
        truncated: false,
      }),
    });
    const client = createRunnerJobClient({
      authToken: 'runner-tracer-token',
      pollIntervalMs: 0,
      binding: { fetch: (request) => runner.handle(request) },
    });
    let published: unknown;
    const step: ReviewWorkflowStep = {
      do: async (_name, _options, operation) => operation(),
    };

    const disposition = await runReviewWorkflow(
      {
        runId: 'run-workflow-runner-tracer',
        job: {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          baseSha,
          headSha,
          trigger: 'automatic',
        },
      },
      step,
      {
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
        getInstallationToken: async () => 'checkout-token',
        runJob: client.runJob,
        completeReview: async ({ output }) => {
          published = output;
          return 'completed';
        },
        markRunFailed: async () => {},
      },
    );

    expect(disposition).toBe('completed');
    expect(published).toEqual({ findings: [], summary: 'No findings' });
  });
});

import { DateTime, Effect, Schema } from 'effect';
import {
  ReviewJob,
  type ReviewCoordinator,
  type ReviewDisposition,
  type ReviewOutcome,
} from './index';
import type { ReviewRunResult, ReviewRunner } from './review-run';
import {
  REVIEW_MAX_ATTEMPTS,
  REVIEW_WORKFLOW_TIMEOUT,
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';

type WorkflowFailureReason = Extract<
  OperationalLogEvent,
  { readonly phase: 'workflow'; readonly outcome: 'failed' }
>['reason'];

export const ReviewWorkflowInput = Schema.Struct({
  runId: Schema.NonEmptyString,
  job: ReviewJob,
});

export type ReviewWorkflowInput = typeof ReviewWorkflowInput.Type;

export interface ReviewWorkflowStep {
  readonly do: <A extends string>(
    name: string,
    options: {
      readonly retries: { readonly limit: 0; readonly delay: 0 };
      readonly timeout: typeof REVIEW_WORKFLOW_TIMEOUT;
    },
    operation: () => Promise<A>,
  ) => Promise<A>;
}

export interface ReviewWorkflowDependencies {
  readonly getRepositoryUrl: (input: {
    repositoryId: number;
    installationId: number;
  }) => Promise<unknown>;
  readonly getReadInstallationToken: (input: {
    installationId: number;
    repositoryId: number;
  }) => Promise<{ readonly token: string; readonly expiresAt: string }>;
  readonly revokeInstallationToken: (token: string) => Promise<void>;
  readonly runJob: ReviewRunner['runJob'];
  readonly completeReview: ReviewCoordinator['completeReview'];
  readonly markRunFailed: (input: { runId: string; occurredAt: string }) => Promise<void>;
  readonly getRunOutcome?: (runId: string) => Promise<Pick<ReviewOutcome, 'status'> | undefined>;
  readonly addReaction?: (input: {
    repositoryId: number;
    installationId: number;
    commentId: number;
    content: 'eyes' | 'confused' | '-1';
  }) => Promise<void>;
  readonly log?: OperationalLog;
}

export interface ReviewWorkflowEnvironment {
  readonly REVIEW_DB: import('./review-state-store').D1DatabaseLike;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly RUNNER: import('./runner-job-client').RunnerJobBinding;
  readonly RUNNER_AUTH_TOKEN: string;
}

const currentIso = () => Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));

const markFailed = async (runId: string, dependencies: ReviewWorkflowDependencies) => {
  try {
    await dependencies.markRunFailed({ runId, occurredAt: await currentIso() });
  } catch {
    // The workflow result remains failed when durable failure recording is unavailable.
  }
};

const recordOperationalLog = async (
  log: OperationalLog | undefined,
  event: OperationalLogEvent,
) => {
  await Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        await log?.record(sanitizeOperationalLogEvent(event));
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined))),
  );
};

const recordManualReaction = async (
  job: ReviewWorkflowInput['job'],
  content: 'confused' | '-1',
  dependencies: ReviewWorkflowDependencies,
) => {
  if (
    job.trigger !== 'manual' ||
    job.commentId === undefined ||
    dependencies.addReaction === undefined
  ) {
    return;
  }

  try {
    await dependencies.addReaction({
      repositoryId: job.repositoryId,
      installationId: job.installationId,
      commentId: job.commentId,
      content,
    });
  } catch {
    // Feedback is replay-safe and must not change the run's terminal state.
  }
};

const recordFailureReaction = async (
  job: ReviewWorkflowInput['job'],
  runId: string,
  dependencies: ReviewWorkflowDependencies,
) => {
  let content: 'confused' | '-1' = '-1';
  if (dependencies.getRunOutcome !== undefined) {
    try {
      if ((await dependencies.getRunOutcome(runId))?.status === 'superseded') {
        content = 'confused';
      }
    } catch {
      // The default failure feedback remains -1 when status is unavailable.
    }
  }
  await recordManualReaction(job, content, dependencies);
};

export const runReviewWorkflow = async (
  input: unknown,
  step: ReviewWorkflowStep,
  dependencies: ReviewWorkflowDependencies,
): Promise<ReviewDisposition> => {
  const decoded = await Schema.decodeUnknownPromise(ReviewWorkflowInput)(input).catch(
    () => undefined,
  );
  if (decoded === undefined) return 'failed';

  let failureReason: WorkflowFailureReason = 'execution_failed';
  let readToken: string | undefined;
  try {
    const disposition = await step.do(
      'review',
      { retries: { limit: 0, delay: 0 }, timeout: REVIEW_WORKFLOW_TIMEOUT },
      async () => {
        try {
          const repositoryUrl = await Schema.decodeUnknownPromise(Schema.NonEmptyString)(
            await dependencies.getRepositoryUrl({
              repositoryId: decoded.job.repositoryId,
              installationId: decoded.job.installationId,
            }),
          );
          const repositoryName = new URL(repositoryUrl).pathname
            .replace(/^\//, '')
            .replace(/\.git$/, '');
          if (!/^[^/]+\/[^/]+$/.test(repositoryName)) {
            throw new Error('Repository identity is invalid');
          }
          const readGrant = await dependencies.getReadInstallationToken({
            installationId: decoded.job.installationId,
            repositoryId: decoded.job.repositoryId,
          });
          readToken = readGrant?.token;
          const result: ReviewRunResult = await dependencies.runJob({
            runId: decoded.runId,
            repositoryUrl,
            repositoryName,
            pullRequestNumber: decoded.job.pullRequestNumber,
            baseSha: decoded.job.baseSha,
            headSha: decoded.job.headSha,
            repositoryReadToken: readGrant.token,
            maxAttempts: REVIEW_MAX_ATTEMPTS,
            shouldAbort:
              dependencies.getRunOutcome === undefined
                ? undefined
                : async () =>
                    (await dependencies.getRunOutcome!(decoded.runId))?.status === 'superseded',
          });

          if (result.status !== 'succeeded') {
            failureReason = 'runner_failed';
            await markFailed(decoded.runId, dependencies);
            await recordFailureReaction(decoded.job, decoded.runId, dependencies);
            return 'failed';
          }

          if (readToken !== undefined) {
            await dependencies.revokeInstallationToken(readToken);
            readToken = undefined;
          }

          const publication = await dependencies.completeReview({
            runId: decoded.runId,
            output: result.output,
          });
          if (publication === 'failed') {
            failureReason = 'publication_failed';
            await recordFailureReaction(decoded.job, decoded.runId, dependencies);
          } else if (publication === 'ignored') {
            await recordManualReaction(decoded.job, 'confused', dependencies);
          }
          return publication;
        } catch {
          await markFailed(decoded.runId, dependencies);
          await recordFailureReaction(decoded.job, decoded.runId, dependencies);
          return 'failed';
        } finally {
          if (readToken !== undefined) {
            try {
              await dependencies.revokeInstallationToken(readToken);
            } catch {
              // GitHub's one-hour token expiry remains the final fallback.
            }
            readToken = undefined;
          }
        }
      },
    );
    if (disposition === 'completed') {
      await recordOperationalLog(dependencies.log, {
        phase: 'workflow',
        outcome: disposition,
        runId: decoded.runId,
      });
    } else if (disposition === 'failed') {
      await recordOperationalLog(dependencies.log, {
        phase: 'workflow',
        outcome: 'failed',
        runId: decoded.runId,
        reason: failureReason,
      });
    }
    return disposition;
  } catch {
    await markFailed(decoded.runId, dependencies);
    await recordFailureReaction(decoded.job, decoded.runId, dependencies);
    await recordOperationalLog(dependencies.log, {
      phase: 'workflow',
      outcome: 'failed',
      runId: decoded.runId,
      reason: 'step_failed',
    });
    return 'failed';
  }
};

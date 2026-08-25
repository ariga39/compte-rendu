import { Effect, Schema } from 'effect';
import {
  PullRequestFacts,
  ReviewEvent,
  GitHubSha,
  type PullRequestFacts as PullRequestFactsType,
  type WorkerEntrypoint,
} from '@compte-rendu/contracts';

export const ReviewJob = Schema.Struct({
  repositoryId: Schema.Int,
  pullRequestNumber: Schema.Int,
  installationId: Schema.Int,
  baseSha: GitHubSha,
  headSha: GitHubSha,
  trigger: Schema.Literals(['automatic', 'manual']),
});

export type ReviewJob = typeof ReviewJob.Type;
export type ReviewDisposition =
  | 'rejected'
  | 'ignored'
  | 'awaiting approval'
  | 'scheduled'
  | 'completed'
  | 'failed';

export interface ReviewScheduler {
  schedule(job: ReviewJob): Promise<void>;
}

export interface GitHubAdapter {
  getPullRequest?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
  }): Promise<unknown>;
  getCommenterPermission?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    commenterLogin: string;
  }): Promise<unknown>;
}

export interface ReviewCoordinator {
  handleReviewEvent(event: unknown): Promise<ReviewDisposition>;
}

class InvalidReviewEvent extends Schema.TaggedError<InvalidReviewEvent>()('InvalidReviewEvent', {
  message: Schema.String,
}) {}

class SchedulingFailed extends Schema.TaggedError<SchedulingFailed>()('SchedulingFailed', {
  message: Schema.String,
}) {}

const MaintainerPermission = Schema.Literals(['write', 'maintain', 'admin']);

const isAutomaticEligible = (event: Extract<ReviewEvent, { event: 'pull_request' }>) =>
  !event.draft &&
  (event.repositoryVisibility === 'private' ||
    (event.repositoryVisibility === 'public' && event.baseRepositoryId === event.headRepositoryId));

const jobForEvent = (
  event: Extract<ReviewEvent, { event: 'pull_request' }>,
  trigger: ReviewJob['trigger'],
): ReviewJob => ({
  repositoryId: event.repositoryId,
  pullRequestNumber: event.pullRequestNumber,
  installationId: event.installationId,
  baseSha: event.baseSha,
  headSha: event.headSha,
  trigger,
});

const jobForFacts = (
  event: Extract<ReviewEvent, { event: 'issue_comment' }>,
  facts: PullRequestFactsType,
): ReviewJob => ({
  repositoryId: event.repositoryId,
  pullRequestNumber: event.pullRequestNumber,
  installationId: event.installationId,
  baseSha: facts.baseSha,
  headSha: facts.headSha,
  trigger: 'manual',
});

const schedule = (scheduler: ReviewScheduler, job: ReviewJob) =>
  Schema.decodeUnknownEffect(ReviewJob)(job).pipe(
    Effect.mapError(() => new SchedulingFailed({ message: 'Scheduled review job is invalid' })),
    Effect.flatMap((decodedJob) =>
      Effect.tryPromise({
        try: () => scheduler.schedule(decodedJob),
        catch: () => new SchedulingFailed({ message: 'Review scheduler failed' }),
      }),
    ),
  );

const createAutomaticCoordinator = (scheduler: ReviewScheduler) =>
  Effect.fn('handleAutomaticReviewEvent')(function* (
    event: Extract<ReviewEvent, { event: 'pull_request' }>,
  ) {
    if (event.draft) {
      return 'ignored' as const;
    }

    if (!isAutomaticEligible(event)) {
      return 'awaiting approval' as const;
    }

    yield* schedule(scheduler, jobForEvent(event, 'automatic'));
    return 'scheduled' as const;
  });

const loadPullRequest = (
  github: GitHubAdapter,
  event: Extract<ReviewEvent, { event: 'issue_comment' }>,
) =>
  Effect.tryPromise({
    try: async () =>
      github.getPullRequest
        ? github.getPullRequest({
            repositoryId: event.repositoryId,
            pullRequestNumber: event.pullRequestNumber,
            installationId: event.installationId,
          })
        : undefined,
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(PullRequestFacts)(value),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );

const loadPermission = (
  github: GitHubAdapter,
  event: Extract<ReviewEvent, { event: 'issue_comment' }>,
) =>
  Effect.tryPromise({
    try: async () =>
      github.getCommenterPermission
        ? github.getCommenterPermission({
            repositoryId: event.repositoryId,
            pullRequestNumber: event.pullRequestNumber,
            installationId: event.installationId,
            commenterLogin: event.commenterLogin,
          })
        : undefined,
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(MaintainerPermission)(value),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );

const createManualCoordinator = (github: GitHubAdapter, scheduler: ReviewScheduler) =>
  Effect.fn('handleManualReviewEvent')(function* (
    event: Extract<ReviewEvent, { event: 'issue_comment' }>,
  ) {
    const facts = yield* loadPullRequest(github, event);
    const permission = yield* loadPermission(github, event);

    if (facts === undefined || permission === undefined || facts.draft) {
      return 'awaiting approval' as const;
    }

    yield* schedule(scheduler, jobForFacts(event, facts));
    return 'scheduled' as const;
  });

const reviewEventEffect = (event: unknown, github: GitHubAdapter, scheduler: ReviewScheduler) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(ReviewEvent)(event).pipe(
      Effect.mapError(() => new InvalidReviewEvent({ message: 'Review event is invalid' })),
    );

    if (decoded.event === 'pull_request') {
      return yield* createAutomaticCoordinator(scheduler)(decoded);
    }

    return yield* createManualCoordinator(github, scheduler)(decoded);
  });

export function createReviewCoordinator(dependencies: {
  github: GitHubAdapter;
  scheduler: ReviewScheduler;
}): ReviewCoordinator {
  return {
    handleReviewEvent: async (event) =>
      Effect.runPromise(
        reviewEventEffect(event, dependencies.github, dependencies.scheduler),
      ).catch((error) => {
        if (error instanceof InvalidReviewEvent) {
          return 'ignored' as const;
        }

        return 'failed' as const;
      }),
  };
}

const core: WorkerEntrypoint = {
  fetch: () => Effect.runPromise(Effect.succeed(new Response(null, { status: 501 }))),
};

export default core;

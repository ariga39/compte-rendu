import { DateTime, Effect, Schema } from 'effect';
import {
  PullRequestFacts,
  ReviewEvent,
  GitHubSha,
  type PullRequestFacts as PullRequestFactsType,
  type WorkerEntrypoint,
} from '@compte-rendu/contracts';
import {
  createCloudflareSandboxAdapter,
  createDurableLeaseAdapter,
  type CloudflareSandboxBindings,
  type LeaseNamespaceLike,
} from './cloudflare-review-adapter';
import { createReviewRunner } from './review-run';

export { ReviewLeaseDurableObject } from './cloudflare-review-adapter';
export {
  createCloudflareSandboxAdapter,
  createDurableLeaseAdapter,
  OPENCODE_MODEL,
  OPENCODE_VERSION,
  REVIEW_DIRECTORY,
} from './cloudflare-review-adapter';
export * from './review-run';

type GitHubShaValue = typeof GitHubSha.Type;

export {
  createD1ReviewStateStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
  type D1ReviewStateStore,
} from './review-state-store';

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

export type ReviewRunStatus = 'scheduled' | 'failed' | 'completed' | 'superseded';
export type ReviewStoredStatus = ReviewDisposition | ReviewRunStatus | 'claiming';

export interface ReviewOutcome {
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  pullRequestNumber: number;
  baseSha: GitHubShaValue | null;
  headSha: GitHubShaValue | null;
  trigger: ReviewJob['trigger'];
  status: ReviewStoredStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewDeliveryRecord {
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  pullRequestNumber: number;
  baseSha: GitHubShaValue | null;
  headSha: GitHubShaValue | null;
  trigger: ReviewJob['trigger'];
  status: ReviewDisposition;
  occurredAt: string;
}

export interface ReviewApproval {
  installationId: number;
  repositoryId: number;
  pullRequestNumber: number;
  baseSha: GitHubShaValue;
  headSha: GitHubShaValue;
}

export interface ReviewStateStore {
  claimReview(input: {
    deliveryId: string;
    job: ReviewJob;
    occurredAt: string;
    approval?: ReviewApproval;
  }): Promise<
    | { kind: 'claimed'; runId: string }
    | { kind: 'replay'; disposition: ReviewDisposition }
    | { kind: 'existing'; disposition: ReviewDisposition }
  >;
  markSchedulingFailed(input: { runId: string; occurredAt: string }): Promise<void>;
  recordDelivery: (input: ReviewDeliveryRecord) => Promise<void>;
}

export interface ReviewStateQueries {
  markRunCompleted(input: { runId: string; occurredAt: string }): Promise<void>;
  getDeliveryOutcome(deliveryId: string): Promise<ReviewOutcome | undefined>;
  getRunOutcome(runId: string): Promise<ReviewOutcome | undefined>;
}

export interface ReviewScheduler {
  schedule(job: ReviewJob, runId: string): Promise<void>;
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

export interface CoreEnv extends CloudflareSandboxBindings {
  readonly REVIEW_LEASE: LeaseNamespaceLike;
}

export const createCloudflareReviewRunner = (env: CoreEnv) =>
  createReviewRunner({
    lease: createDurableLeaseAdapter(env.REVIEW_LEASE),
    sandbox: createCloudflareSandboxAdapter(env),
  });

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

const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const schedule = (scheduler: ReviewScheduler, job: ReviewJob, runId: string) =>
  Schema.decodeUnknownEffect(ReviewJob)(job).pipe(
    Effect.mapError(() => new SchedulingFailed({ message: 'Scheduled review job is invalid' })),
    Effect.flatMap((decodedJob) =>
      Effect.tryPromise({
        try: () => scheduler.schedule(decodedJob, runId),
        catch: () => new SchedulingFailed({ message: 'Review scheduler failed' }),
      }),
    ),
  );

const claimAndSchedule = (
  stateStore: ReviewStateStore,
  scheduler: ReviewScheduler,
  deliveryId: string,
  job: ReviewJob,
  approval?: ReviewApproval,
) =>
  Effect.gen(function* () {
    const occurredAt = yield* currentIso;
    const claim = yield* Effect.tryPromise({
      try: () =>
        stateStore.claimReview({
          deliveryId,
          job,
          occurredAt,
          approval,
        }),
      catch: () => new SchedulingFailed({ message: 'Review state could not be claimed' }),
    });

    if (claim.kind !== 'claimed') {
      return claim.disposition;
    }

    yield* schedule(scheduler, job, claim.runId).pipe(
      Effect.catchTag('SchedulingFailed', (error) =>
        Effect.tryPromise({
          try: () =>
            stateStore.markSchedulingFailed({
              runId: claim.runId,
              occurredAt,
            }),
          catch: () => error,
        }).pipe(Effect.flatMap(() => Effect.fail(error))),
      ),
    );
    return 'scheduled' as const;
  });

const recordDelivery = (stateStore: ReviewStateStore, input: ReviewDeliveryRecord) => {
  return Effect.tryPromise({
    try: () => stateStore.recordDelivery(input),
    catch: () => new SchedulingFailed({ message: 'Review outcome could not be recorded' }),
  });
};

const createAutomaticCoordinator = (stateStore: ReviewStateStore, scheduler: ReviewScheduler) =>
  Effect.fn('handleAutomaticReviewEvent')(function* (
    event: Extract<ReviewEvent, { event: 'pull_request' }>,
  ) {
    if (event.draft) {
      const occurredAt = yield* currentIso;
      yield* recordDelivery(stateStore, {
        deliveryId: event.deliveryId,
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        pullRequestNumber: event.pullRequestNumber,
        baseSha: event.baseSha,
        headSha: event.headSha,
        trigger: 'automatic',
        status: 'ignored',
        occurredAt,
      });
      return 'ignored' as const;
    }

    if (!isAutomaticEligible(event)) {
      const occurredAt = yield* currentIso;
      yield* recordDelivery(stateStore, {
        deliveryId: event.deliveryId,
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        pullRequestNumber: event.pullRequestNumber,
        baseSha: event.baseSha,
        headSha: event.headSha,
        trigger: 'automatic',
        status: 'awaiting approval',
        occurredAt,
      });
      return 'awaiting approval' as const;
    }

    return yield* claimAndSchedule(
      stateStore,
      scheduler,
      event.deliveryId,
      jobForEvent(event, 'automatic'),
    );
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

const createManualCoordinator = (
  github: GitHubAdapter,
  stateStore: ReviewStateStore,
  scheduler: ReviewScheduler,
) =>
  Effect.fn('handleManualReviewEvent')(function* (
    event: Extract<ReviewEvent, { event: 'issue_comment' }>,
  ) {
    const facts = yield* loadPullRequest(github, event);
    const permission = yield* loadPermission(github, event);

    if (facts === undefined || permission === undefined || facts.draft) {
      const occurredAt = yield* currentIso;
      yield* recordDelivery(stateStore, {
        deliveryId: event.deliveryId,
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        pullRequestNumber: event.pullRequestNumber,
        baseSha: facts?.baseSha ?? null,
        headSha: facts?.headSha ?? null,
        trigger: 'manual',
        status: 'awaiting approval',
        occurredAt,
      });
      return 'awaiting approval' as const;
    }

    return yield* claimAndSchedule(
      stateStore,
      scheduler,
      event.deliveryId,
      jobForFacts(event, facts),
      {
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        pullRequestNumber: event.pullRequestNumber,
        baseSha: facts.baseSha,
        headSha: facts.headSha,
      },
    );
  });

const reviewEventEffect = (
  event: unknown,
  github: GitHubAdapter,
  stateStore: ReviewStateStore,
  scheduler: ReviewScheduler,
) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(ReviewEvent)(event).pipe(
      Effect.mapError(() => new InvalidReviewEvent({ message: 'Review event is invalid' })),
    );

    if (decoded.event === 'pull_request') {
      return yield* createAutomaticCoordinator(stateStore, scheduler)(decoded);
    }

    return yield* createManualCoordinator(github, stateStore, scheduler)(decoded);
  });

export const createInMemoryReviewStateStore = (): ReviewStateStore => {
  const deliveries = new Map<string, ReviewDisposition>();
  const runs = new Map<string, { job: ReviewJob; status: ReviewRunStatus; deliveryId: string }>();
  let nextRunId = 1;

  return {
    recordDelivery: async ({ deliveryId, status }) => {
      if (!deliveries.has(deliveryId)) {
        deliveries.set(deliveryId, status);
      }
    },
    claimReview: async ({ deliveryId, job }) => {
      const previous = deliveries.get(deliveryId);
      if (previous !== undefined) {
        return { kind: 'replay', disposition: previous };
      }

      const existing = [...runs.values()].find(
        (run) =>
          run.job.repositoryId === job.repositoryId &&
          run.job.pullRequestNumber === job.pullRequestNumber &&
          run.job.headSha === job.headSha,
      );
      if (existing !== undefined) {
        const disposition =
          existing.status === 'failed'
            ? 'failed'
            : existing.status === 'completed'
              ? 'completed'
              : existing.status === 'superseded'
                ? 'ignored'
                : 'scheduled';
        deliveries.set(deliveryId, disposition);
        return { kind: 'existing', disposition };
      }

      for (const run of runs.values()) {
        if (
          run.job.repositoryId === job.repositoryId &&
          run.job.pullRequestNumber === job.pullRequestNumber &&
          run.status === 'scheduled' &&
          run.job.headSha !== job.headSha
        ) {
          run.status = 'superseded';
          deliveries.set(run.deliveryId, 'ignored');
        }
      }

      const runId = `run-${nextRunId++}`;
      runs.set(runId, { deliveryId, job, status: 'scheduled' });
      deliveries.set(deliveryId, 'scheduled');
      return { kind: 'claimed', runId };
    },
    markSchedulingFailed: async ({ runId }) => {
      const run = runs.get(runId);
      if (run !== undefined) {
        run.status = 'failed';
        deliveries.set(run.deliveryId, 'failed');
      }
    },
  };
};

export function createReviewCoordinator(dependencies: {
  github: GitHubAdapter;
  stateStore: ReviewStateStore;
  scheduler: ReviewScheduler;
}): ReviewCoordinator {
  return {
    handleReviewEvent: async (event) =>
      Effect.runPromise(
        reviewEventEffect(
          event,
          dependencies.github,
          dependencies.stateStore,
          dependencies.scheduler,
        ),
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

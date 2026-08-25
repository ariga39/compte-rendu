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
import { createReviewRunner, ReviewRunOutput } from './review-run';

export { ReviewLeaseDurableObject } from './cloudflare-review-adapter';
export {
  createCloudflareSandboxAdapter,
  createDurableLeaseAdapter,
  OPENCODE_MODEL,
  OPENCODE_VERSION,
  REVIEW_DIRECTORY,
} from './cloudflare-review-adapter';
export { createGitHubPublicationAdapter } from './github-review-adapter';
export type { GitHubPublicationAdapterOptions } from './github-review-adapter';
export { createGitHubAppTokenProvider } from './github-app-token';
export type { GitHubAppTokenProvider, GitHubAppTokenProviderOptions } from './github-app-token';
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
  markRunCompleted(input: { runId: string; occurredAt: string }): Promise<boolean>;
  markRunSuperseded(input: { runId: string; occurredAt: string }): Promise<boolean>;
  completeRunPublication(input: {
    runId: string;
    occurredAt: string;
    fingerprints: readonly string[];
  }): Promise<boolean>;
  getDeliveryOutcome(deliveryId: string): Promise<ReviewOutcome | undefined>;
  getRunOutcome(runId: string): Promise<ReviewOutcome | undefined>;
}

export type ReviewPublicationStateStore = ReviewStateStore & ReviewStateQueries;

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
  getRepositoryUrl?(input: { repositoryId: number; installationId: number }): Promise<unknown>;
  loadReviewTarget?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
  }): Promise<unknown>;
  findReviewByMarker?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    marker: string;
  }): Promise<unknown>;
  createReview?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    payload: ReviewPublicationPayload;
  }): Promise<ReviewPublicationCreateResult>;
}

export interface ReviewPublicationPayload {
  readonly event: 'COMMENT';
  readonly commit_id: GitHubShaValue;
  readonly body: string;
  readonly comments: readonly ReviewPublicationComment[];
}

export interface ReviewPublicationComment {
  readonly path: string;
  readonly line: number;
  readonly side: 'RIGHT';
  readonly body: string;
}

export type ReviewPublicationCreateResult =
  | { readonly kind: 'created'; readonly review: unknown }
  | { readonly kind: 'stale'; readonly currentHeadSha: GitHubShaValue };

export interface ReviewCoordinator {
  handleReviewEvent(event: unknown): Promise<ReviewDisposition>;
  completeReview(input: { runId: string; output: unknown }): Promise<ReviewDisposition>;
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

const CommenterPermission = Schema.Literals([
  'none',
  'read',
  'triage',
  'write',
  'maintain',
  'admin',
]);

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

const ReviewPublicationTarget = Schema.Struct({
  headSha: GitHubSha,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.NonEmptyString,
      patch: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const ReviewPublicationCreateResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('created'), review: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal('stale'), currentHeadSha: GitHubSha }),
]);

type ReviewPublicationTarget = typeof ReviewPublicationTarget.Type;

const rightLinesForPatch = (patch: string): ReadonlySet<number> => {
  const rightLines = new Set<number>();
  let rightLine: number | undefined;

  for (const line of patch.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      rightLine = Number(hunk[1]);
      continue;
    }

    if (line.startsWith('+++') && rightLine === undefined) continue;
    if (rightLine === undefined || line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      rightLines.add(rightLine);
      rightLine += 1;
    } else if (line.startsWith(' ')) {
      rightLines.add(rightLine);
      rightLine += 1;
    } else if (line.startsWith('-')) {
      continue;
    }
  }

  return rightLines;
};

const publicationComments = (
  output: typeof ReviewRunOutput.Type,
  target: ReviewPublicationTarget,
): readonly ReviewPublicationComment[] => {
  const comments: ReviewPublicationComment[] = [];
  const seen = new Set<string>();

  for (const finding of output.findings) {
    const file = target.files.find((candidate) => candidate.path === finding.path);
    if (file === undefined || file.patch === undefined || file.patch === null) continue;
    if (!rightLinesForPatch(file.patch).has(finding.line)) continue;

    const fingerprint = `${finding.path}\u0000${finding.line}\u0000${finding.message}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    comments.push({ path: finding.path, line: finding.line, side: 'RIGHT', body: finding.message });
    if (comments.length === 5) break;
  }

  return comments;
};

type ReviewCompletionStateStore = ReviewStateStore & Partial<ReviewStateQueries>;

const completeReviewEffect = Effect.fn('completeReview')(function* (
  input: { runId: string; output: unknown },
  github: GitHubAdapter,
  stateStore: ReviewCompletionStateStore,
) {
  if (stateStore.getRunOutcome === undefined || stateStore.markRunCompleted === undefined) {
    return 'failed' as const;
  }

  const occurredAt = yield* currentIso;
  const getRunOutcome = stateStore.getRunOutcome;
  const markRunCompleted = stateStore.markRunCompleted;
  if (getRunOutcome === undefined || markRunCompleted === undefined) {
    return 'failed' as const;
  }
  const completeRun = (fingerprints: readonly string[]) =>
    Effect.tryPromise({
      try: () =>
        stateStore.completeRunPublication === undefined
          ? markRunCompleted({ runId: input.runId, occurredAt })
          : stateStore.completeRunPublication({
              runId: input.runId,
              occurredAt,
              fingerprints,
            }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
  const outcome = yield* Effect.tryPromise({
    try: () => getRunOutcome(input.runId),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

  if (outcome === undefined) return 'failed' as const;
  if (outcome.status === 'completed') return 'completed' as const;
  if (outcome.status === 'superseded') return 'ignored' as const;
  if (outcome.status === 'failed') return 'failed' as const;
  if (outcome.status !== 'scheduled') return 'failed' as const;

  const decodedOutput = yield* Schema.decodeUnknownEffect(ReviewRunOutput)(input.output).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (decodedOutput === undefined) {
    yield* Effect.tryPromise({
      try: () => stateStore.markSchedulingFailed?.({ runId: input.runId, occurredAt }),
      catch: () => undefined,
    });
    return 'failed' as const;
  }

  if (
    github.loadReviewTarget === undefined ||
    github.createReview === undefined ||
    outcome.baseSha === null ||
    outcome.headSha === null
  ) {
    yield* Effect.tryPromise({
      try: () => stateStore.markSchedulingFailed?.({ runId: input.runId, occurredAt }),
      catch: () => undefined,
    });
    return 'failed' as const;
  }

  const target = yield* Effect.tryPromise({
    try: () =>
      github.loadReviewTarget!({
        repositoryId: outcome.repositoryId,
        pullRequestNumber: outcome.pullRequestNumber,
        installationId: outcome.installationId,
      }),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(ReviewPublicationTarget)(value).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          ),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );

  if (target !== undefined && target.headSha !== outcome.headSha) {
    if (stateStore.markRunSuperseded === undefined) return 'failed' as const;
    const superseded = yield* Effect.tryPromise({
      try: () => stateStore.markRunSuperseded!({ runId: input.runId, occurredAt }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    return superseded ? ('ignored' as const) : ('failed' as const);
  }

  if (target === undefined) {
    yield* Effect.tryPromise({
      try: () => stateStore.markSchedulingFailed?.({ runId: input.runId, occurredAt }),
      catch: () => undefined,
    });
    return 'failed' as const;
  }

  const marker = `<!-- compte-rendu:run:${input.runId} -->`;
  const comments = publicationComments(decodedOutput, target);
  const lookupMarker = () =>
    github.findReviewByMarker === undefined
      ? Effect.succeed({ ok: true as const, review: undefined })
      : Effect.tryPromise({
          try: () =>
            github.findReviewByMarker!({
              repositoryId: outcome.repositoryId,
              pullRequestNumber: outcome.pullRequestNumber,
              installationId: outcome.installationId,
              marker,
            }),
          catch: () => undefined,
        }).pipe(
          Effect.map((review) => ({ ok: true as const, review })),
          Effect.catch(() => Effect.succeed({ ok: false as const })),
        );

  const markerLookup = yield* lookupMarker();
  if (!markerLookup.ok) {
    yield* Effect.tryPromise({
      try: () => stateStore.markSchedulingFailed?.({ runId: input.runId, occurredAt }),
      catch: () => undefined,
    });
    return 'failed' as const;
  }

  if (markerLookup.review !== undefined) {
    const completed = yield* completeRun(
      comments.map((comment) => `${comment.path}\u0000${comment.line}\u0000${comment.body}`),
    );
    return completed ? ('completed' as const) : ('failed' as const);
  }

  const payload: ReviewPublicationPayload = {
    event: 'COMMENT',
    commit_id: outcome.headSha,
    body: `${marker}\n${decodedOutput.summary}`,
    comments,
  };

  const publication = yield* Effect.tryPromise({
    try: () =>
      github.createReview!({
        repositoryId: outcome.repositoryId,
        pullRequestNumber: outcome.pullRequestNumber,
        installationId: outcome.installationId,
        payload,
      }),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ReviewPublicationCreateResult)(value).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    ),
    Effect.catch(() => Effect.succeed(false)),
  );
  if (typeof publication === 'object' && publication !== null && publication.kind === 'stale') {
    if (stateStore.markRunSuperseded === undefined) return 'failed' as const;
    const superseded = yield* Effect.tryPromise({
      try: () => stateStore.markRunSuperseded!({ runId: input.runId, occurredAt }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    return superseded ? ('ignored' as const) : ('failed' as const);
  }
  if (publication === false || publication === undefined) {
    const recoveredLookup = yield* lookupMarker();
    if (recoveredLookup.ok && recoveredLookup.review !== undefined) {
      const completed = yield* completeRun(
        comments.map((comment) => `${comment.path}\u0000${comment.line}\u0000${comment.body}`),
      );
      return completed ? ('completed' as const) : ('failed' as const);
    }
    yield* Effect.tryPromise({
      try: () => stateStore.markSchedulingFailed?.({ runId: input.runId, occurredAt }),
      catch: () => undefined,
    });
    return 'failed' as const;
  }
  const completed = yield* completeRun(
    comments.map((comment) => `${comment.path}\u0000${comment.line}\u0000${comment.body}`),
  );
  return completed ? ('completed' as const) : ('failed' as const);
});

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

type ManualRead<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'uncertain' };

const readManualPolicyWithRetry = async <T>(
  read: () => Promise<unknown>,
  schema: Schema.ConstraintDecoder<T>,
): Promise<ManualRead<T>> => {
  const readOnce = async (): Promise<ManualRead<T>> => {
    let value: unknown;
    try {
      value = await read();
    } catch {
      return { kind: 'uncertain' };
    }

    if (value === undefined) return { kind: 'missing' };

    try {
      return { kind: 'value', value: await Schema.decodeUnknownPromise(schema)(value) };
    } catch {
      return { kind: 'uncertain' };
    }
  };

  const first = await readOnce();
  return first.kind === 'uncertain' ? readOnce() : first;
};

const loadPullRequestWithRetry = (
  github: GitHubAdapter,
  event: Extract<ReviewEvent, { event: 'issue_comment' }>,
) =>
  readManualPolicyWithRetry(async () => {
    if (github.getPullRequest === undefined) {
      throw new Error('Pull request facts adapter is unavailable');
    }
    return github.getPullRequest({
      repositoryId: event.repositoryId,
      pullRequestNumber: event.pullRequestNumber,
      installationId: event.installationId,
    });
  }, PullRequestFacts);

const loadPermissionWithRetry = (
  github: GitHubAdapter,
  event: Extract<ReviewEvent, { event: 'issue_comment' }>,
) =>
  readManualPolicyWithRetry(async () => {
    if (github.getCommenterPermission === undefined) {
      throw new Error('Commenter permission adapter is unavailable');
    }
    return github.getCommenterPermission({
      repositoryId: event.repositoryId,
      pullRequestNumber: event.pullRequestNumber,
      installationId: event.installationId,
      commenterLogin: event.commenterLogin,
    });
  }, CommenterPermission);

const createManualCoordinator = (
  github: GitHubAdapter,
  stateStore: ReviewStateStore,
  scheduler: ReviewScheduler,
) =>
  Effect.fn('handleManualReviewEvent')(function* (
    event: Extract<ReviewEvent, { event: 'issue_comment' }>,
  ) {
    const factsRead = yield* Effect.tryPromise({
      try: () => loadPullRequestWithRetry(github, event),
      catch: () => new SchedulingFailed({ message: 'Pull request facts are uncertain' }),
    });
    if (factsRead.kind === 'uncertain') {
      return yield* new SchedulingFailed({ message: 'Pull request facts are uncertain' });
    }

    const facts = factsRead.kind === 'value' ? factsRead.value : undefined;
    let permission: typeof CommenterPermission.Type | undefined;
    if (facts !== undefined && !facts.draft) {
      const permissionRead = yield* Effect.tryPromise({
        try: () => loadPermissionWithRetry(github, event),
        catch: () => new SchedulingFailed({ message: 'Commenter permission is uncertain' }),
      });
      if (permissionRead.kind === 'uncertain') {
        return yield* new SchedulingFailed({ message: 'Commenter permission is uncertain' });
      }
      permission = permissionRead.kind === 'value' ? permissionRead.value : undefined;
    }

    if (
      facts === undefined ||
      permission === undefined ||
      permission === 'none' ||
      permission === 'read' ||
      permission === 'triage' ||
      facts.draft
    ) {
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

export const createInMemoryReviewStateStore = (): ReviewPublicationStateStore => {
  const deliveries = new Map<string, ReviewOutcome>();
  const runs = new Map<
    string,
    {
      job: ReviewJob;
      status: ReviewRunStatus;
      deliveryId: string;
      createdAt: string;
      updatedAt: string;
    }
  >();
  let nextRunId = 1;

  const dispositionForStatus = (status: ReviewStoredStatus): ReviewDisposition => {
    switch (status) {
      case 'failed':
        return 'failed';
      case 'completed':
        return 'completed';
      case 'scheduled':
        return 'scheduled';
      case 'awaiting approval':
        return 'awaiting approval';
      case 'superseded':
      case 'claiming':
      case 'ignored':
      case 'rejected':
        return 'ignored';
    }
  };

  const setDeliveryStatus = (deliveryId: string, status: ReviewStoredStatus, updatedAt: string) => {
    const delivery = deliveries.get(deliveryId);
    if (delivery !== undefined) deliveries.set(deliveryId, { ...delivery, status, updatedAt });
  };

  return {
    recordDelivery: async (input) => {
      if (!deliveries.has(input.deliveryId)) {
        deliveries.set(input.deliveryId, {
          deliveryId: input.deliveryId,
          installationId: input.installationId,
          repositoryId: input.repositoryId,
          pullRequestNumber: input.pullRequestNumber,
          baseSha: input.baseSha,
          headSha: input.headSha,
          trigger: input.trigger,
          status: input.status,
          createdAt: input.occurredAt,
          updatedAt: input.occurredAt,
        });
      }
    },
    claimReview: async ({ deliveryId, job, occurredAt }) => {
      const previous = deliveries.get(deliveryId);
      if (previous !== undefined) {
        return { kind: 'replay', disposition: dispositionForStatus(previous.status) };
      }

      const existing = [...runs.values()].find(
        (run) =>
          run.job.repositoryId === job.repositoryId &&
          run.job.pullRequestNumber === job.pullRequestNumber &&
          run.job.headSha === job.headSha,
      );
      if (existing !== undefined) {
        const disposition = dispositionForStatus(existing.status);
        deliveries.set(deliveryId, {
          deliveryId,
          installationId: job.installationId,
          repositoryId: job.repositoryId,
          pullRequestNumber: job.pullRequestNumber,
          baseSha: job.baseSha,
          headSha: job.headSha,
          trigger: job.trigger,
          status: existing.status,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
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
          run.updatedAt = occurredAt;
          setDeliveryStatus(run.deliveryId, 'superseded', occurredAt);
        }
      }

      const runId = `run-${nextRunId++}`;
      runs.set(runId, {
        deliveryId,
        job,
        status: 'scheduled',
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });
      deliveries.set(deliveryId, {
        deliveryId,
        installationId: job.installationId,
        repositoryId: job.repositoryId,
        pullRequestNumber: job.pullRequestNumber,
        baseSha: job.baseSha,
        headSha: job.headSha,
        trigger: job.trigger,
        status: 'scheduled',
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });
      return { kind: 'claimed', runId };
    },
    markSchedulingFailed: async ({ runId, occurredAt }) => {
      const run = runs.get(runId);
      if (run !== undefined && run.status === 'scheduled') {
        run.status = 'failed';
        run.updatedAt = occurredAt;
        setDeliveryStatus(run.deliveryId, 'failed', occurredAt);
      }
    },
    markRunCompleted: async ({ runId, occurredAt }) => {
      const run = runs.get(runId);
      if (run !== undefined && run.status === 'scheduled') {
        run.status = 'completed';
        run.updatedAt = occurredAt;
        setDeliveryStatus(run.deliveryId, 'completed', occurredAt);
        return true;
      }
      return false;
    },
    markRunSuperseded: async ({ runId, occurredAt }) => {
      const run = runs.get(runId);
      if (run !== undefined && run.status === 'scheduled') {
        run.status = 'superseded';
        run.updatedAt = occurredAt;
        setDeliveryStatus(run.deliveryId, 'superseded', occurredAt);
        return true;
      }
      return false;
    },
    completeRunPublication: async ({ runId, occurredAt }) => {
      const run = runs.get(runId);
      if (run !== undefined && run.status === 'scheduled') {
        run.status = 'completed';
        run.updatedAt = occurredAt;
        setDeliveryStatus(run.deliveryId, 'completed', occurredAt);
        return true;
      }
      return false;
    },
    getDeliveryOutcome: async (deliveryId) => deliveries.get(deliveryId),
    getRunOutcome: async (runId) => {
      const run = runs.get(runId);
      if (run === undefined) return undefined;
      const delivery = deliveries.get(run.deliveryId);
      return delivery === undefined
        ? undefined
        : { ...delivery, status: run.status, updatedAt: run.updatedAt };
    },
  };
};

export function createReviewCoordinator(dependencies: {
  github: GitHubAdapter;
  stateStore: ReviewCompletionStateStore;
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
    completeReview: async (input) =>
      Effect.runPromise(
        completeReviewEffect(input, dependencies.github, dependencies.stateStore),
      ).catch(() => 'failed' as const),
  };
}

const core: WorkerEntrypoint = {
  fetch: () => Effect.runPromise(Effect.succeed(new Response(null, { status: 501 }))),
};

export default core;

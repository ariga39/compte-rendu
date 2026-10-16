import { Effect, Option, Schema } from 'effect';
import {
  MetadataInvalidationEvent,
  ReviewEvent,
  GitHubSha,
  MAX_RUNNER_CALLBACK_BYTES,
  type CoreServiceBinding,
  type OperationalLog,
  type OperationalLogEvent,
  type ReviewEvent as NormalizedReviewEvent,
  type WorkerEntrypoint,
  sanitizeOperationalLogIdentifier,
  sanitizeOperationalLogEvent,
} from '@compte-rendu/contracts';
import { createCloudflareOperationalLog } from './operational-log';

export const MAX_WEBHOOK_BYTES = 256 * 1024;

export { createCloudflareOperationalLog } from './operational-log';

const supportedEvents = [
  'pull_request',
  'issue_comment',
  'check_run',
  'check_suite',
  'repository',
  'installation',
  'installation_repositories',
] as const;
const runnerCallbackPath = '/runner-callback';
const runnerClaimPath = '/runner-claim';
const runnerProgressPath = '/runner-progress';
const MAX_RUNNER_PROGRESS_BYTES = 16 * 1024;
const supportedPullRequestActions = [
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
] as const;
const PullRequestAction = Schema.Literals(supportedPullRequestActions);
const RerequestedAction = Schema.Literal('rerequested');
const WebhookAction = Schema.Struct({ action: Schema.String });
const InstallationId = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
const InstallationIds = Schema.Array(InstallationId).pipe(Schema.check(Schema.isMinLength(1)));
const InstallationIdsConfig = Schema.fromJsonString(InstallationIds);
const BotAuthorId = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
const BotAuthorIdsConfig = Schema.fromJsonString(Schema.Array(BotAuthorId));

const PullRequestWebhook = Schema.Struct({
  action: PullRequestAction,
  number: Schema.Int,
  installation: Schema.Struct({ id: Schema.Int }),
  repository: Schema.Struct({
    id: Schema.Int,
    visibility: Schema.Literals(['private', 'public']),
  }),
  pull_request: Schema.Struct({
    draft: Schema.Boolean,
    user: Schema.Struct({ type: Schema.String, id: Schema.optional(Schema.NullOr(Schema.Int)) }),
    base: Schema.Struct({
      sha: GitHubSha,
      repo: Schema.Struct({ id: Schema.Int }),
    }),
    head: Schema.Struct({
      sha: GitHubSha,
      repo: Schema.Struct({ id: Schema.Int }),
    }),
  }),
});

const IssueCommentWebhook = Schema.Struct({
  action: Schema.Literal('created'),
  installation: Schema.Struct({ id: Schema.Int }),
  repository: Schema.Struct({ id: Schema.Int }),
  issue: Schema.Struct({
    number: Schema.Int,
    pull_request: Schema.optional(Schema.Struct({})),
  }),
  comment: Schema.Struct({
    id: Schema.Int,
    body: Schema.String,
    user: Schema.Struct({ login: Schema.NonEmptyString }),
  }),
});

const CheckRunRerequestWebhook = Schema.Struct({
  action: RerequestedAction,
  installation: Schema.Struct({ id: Schema.Int }),
  repository: Schema.Struct({ id: Schema.Int }),
  check_run: Schema.Struct({
    id: Schema.Int,
    external_id: Schema.NullOr(Schema.NonEmptyString),
  }),
  sender: Schema.Struct({ login: Schema.NonEmptyString }),
});

const CheckSuiteRerequestWebhook = Schema.Struct({
  action: RerequestedAction,
  installation: Schema.Struct({ id: Schema.Int }),
  repository: Schema.Struct({ id: Schema.Int }),
  check_suite: Schema.Struct({ id: Schema.Int }),
  sender: Schema.Struct({ login: Schema.NonEmptyString }),
});

const PullRequestObservationWebhook = Schema.Struct({
  action: Schema.String,
  installation: Schema.Struct({ id: Schema.Int }),
  repository: Schema.Struct({
    id: Schema.Int,
    visibility: Schema.Literals(['private', 'public']),
  }),
});

const RepositoryVisibilityWebhook = Schema.Struct({
  action: Schema.String,
  installation: Schema.Struct({ id: Schema.Int }),
  repository: Schema.Struct({ id: Schema.Int }),
});

const InstallationRepositoriesWebhook = Schema.Struct({
  action: Schema.String,
  installation: Schema.Struct({ id: Schema.Int }),
  repositories_removed: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.Int }))),
});

const InstallationWebhook = Schema.Struct({
  action: Schema.String,
  installation: Schema.Struct({ id: Schema.Int }),
});

const Signature = Schema.String.check(Schema.isPattern(new RegExp('^sha256=[0-9a-f]{64}$', 'i')));

export interface IngressDependencies {
  readonly secret: string;
  readonly crypto: Pick<Crypto, 'subtle'>;
  readonly allowedInstallationIds: unknown;
  readonly allowedBotAuthorIds?: unknown;
  readonly core: CoreServiceBinding;
  readonly assets?: CoreServiceBinding;
  readonly runnerCallbackToken?: string;
  readonly log?: OperationalLog;
}

export interface IngressEnv {
  readonly WEBHOOK_SECRET: string;
  readonly ALLOWED_INSTALLATION_IDS: string;
  readonly ALLOWED_BOT_AUTHOR_IDS?: string;
  readonly CORE: CoreServiceBinding;
  readonly ASSETS?: CoreServiceBinding;
  readonly RUNNER_CALLBACK_TOKEN?: string;
}

const InvalidWebhookReason = Schema.Literals(['invalid_signature', 'invalid_webhook']);

class InvalidWebhook extends Schema.TaggedError<InvalidWebhook>()('InvalidWebhook', {
  message: Schema.String,
  reason: InvalidWebhookReason,
}) {}

class CoreUnavailable extends Schema.TaggedError<CoreUnavailable>()('CoreUnavailable', {
  message: Schema.String,
  deliveryId: Schema.NonEmptyString,
  event: Schema.Literals(['pull_request', 'issue_comment', 'check_run', 'check_suite', 'metadata']),
}) {}

class InvalidAdmissionConfiguration extends Schema.TaggedError<InvalidAdmissionConfiguration>()(
  'InvalidAdmissionConfiguration',
  { message: Schema.String },
) {}

const invalidWebhook = (
  message: string,
  reason: typeof InvalidWebhookReason.Type = 'invalid_webhook',
) => new InvalidWebhook({ message, reason });

const invalidAdmissionConfiguration = (message: string) =>
  new InvalidAdmissionConfiguration({ message });

const recordOperationalLog = (log: OperationalLog, event: OperationalLogEvent) =>
  Effect.tryPromise({
    try: async () => {
      await log.record(sanitizeOperationalLogEvent(event));
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

const readJson = (body: string) =>
  Effect.tryPromise({
    try: async () => JSON.parse(body),
    catch: () => invalidWebhook('Webhook body is not valid JSON'),
  });

const signatureBytes = (signature: string) => {
  const hex = signature.slice('sha256='.length);
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
};

const verifySignature = (body: string, signature: string, dependencies: IngressDependencies) =>
  Effect.gen(function* () {
    const validSignature = yield* Effect.tryPromise({
      try: async () => {
        const key = await dependencies.crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(dependencies.secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['verify'],
        );

        return dependencies.crypto.subtle.verify(
          'HMAC',
          key,
          signatureBytes(signature),
          new TextEncoder().encode(body),
        );
      },
      catch: () => invalidWebhook('Webhook signature could not be verified', 'invalid_signature'),
    });

    if (!validSignature) {
      return yield* invalidWebhook('Webhook signature is invalid', 'invalid_signature');
    }
  });

const normalizePullRequest = (
  deliveryId: string,
  payload: Schema.Schema.Type<typeof PullRequestWebhook>,
): NormalizedReviewEvent => ({
  deliveryId,
  event: 'pull_request',
  action: payload.action,
  repositoryId: payload.repository.id,
  pullRequestNumber: payload.number,
  installationId: payload.installation.id,
  repositoryVisibility: payload.repository.visibility,
  baseRepositoryId: payload.pull_request.base.repo.id,
  headRepositoryId: payload.pull_request.head.repo.id,
  draft: payload.pull_request.draft,
  baseSha: payload.pull_request.base.sha,
  headSha: payload.pull_request.head.sha,
});

const normalizeIssueComment = (
  deliveryId: string,
  payload: Schema.Schema.Type<typeof IssueCommentWebhook>,
): NormalizedReviewEvent => ({
  deliveryId,
  event: 'issue_comment',
  action: 'created',
  repositoryId: payload.repository.id,
  pullRequestNumber: payload.issue.number,
  installationId: payload.installation.id,
  commentId: payload.comment.id,
  commenterLogin: payload.comment.user.login,
  command: '/ai-review',
});

const normalizeCheckRunRerequest = (
  deliveryId: string,
  payload: Schema.Schema.Type<typeof CheckRunRerequestWebhook>,
): NormalizedReviewEvent => ({
  deliveryId,
  event: 'check_run',
  action: 'rerequested',
  repositoryId: payload.repository.id,
  installationId: payload.installation.id,
  checkRunId: payload.check_run.id,
  externalRunId: payload.check_run.external_id,
  senderLogin: payload.sender.login,
});

const normalizeCheckSuiteRerequest = (
  deliveryId: string,
  payload: Schema.Schema.Type<typeof CheckSuiteRerequestWebhook>,
): NormalizedReviewEvent => ({
  deliveryId,
  event: 'check_suite',
  action: 'rerequested',
  repositoryId: payload.repository.id,
  installationId: payload.installation.id,
  checkSuiteId: payload.check_suite.id,
  senderLogin: payload.sender.login,
});

const checkInstallation = (
  deliveryId: string,
  event: NormalizedReviewEvent['event'] | 'metadata',
  installationId: number,
  dependencies: IngressDependencies,
) =>
  Effect.gen(function* () {
    const allowedInstallationIds = yield* Schema.decodeUnknownEffect(InstallationIdsConfig)(
      dependencies.allowedInstallationIds,
    ).pipe(
      Effect.mapError(() =>
        invalidAdmissionConfiguration('Installation allowlist is missing or malformed'),
      ),
    );
    if (allowedInstallationIds.includes(installationId)) return true;

    yield* recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
      phase: 'ingress',
      outcome: 'ignored',
      deliveryId: sanitizeOperationalLogIdentifier(deliveryId),
      event,
      reason: 'unapproved_installation',
    });
    return false;
  });

const isAllowedBotAuthor = Effect.fn('isAllowedBotAuthor')(function* (
  authorId: number | null | undefined,
  dependencies: IngressDependencies,
) {
  return yield* Schema.decodeUnknownEffect(BotAuthorIdsConfig)(
    dependencies.allowedBotAuthorIds,
  ).pipe(
    Effect.orElseSucceed(() => [] as readonly number[]),
    Effect.map(
      (allowedBotAuthorIds) =>
        authorId !== null && authorId !== undefined && allowedBotAuthorIds.includes(authorId),
    ),
  );
});

const processWebhook = (request: Request, dependencies: IngressDependencies) =>
  Effect.gen(function* () {
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null && Number.parseInt(contentLength, 10) > MAX_WEBHOOK_BYTES) {
      return yield* invalidWebhook('Webhook body exceeds the accepted limit');
    }

    const body = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: () => invalidWebhook('Webhook body could not be read'),
    });
    const bodyBytes = new TextEncoder().encode(body);

    if (bodyBytes.byteLength > MAX_WEBHOOK_BYTES) {
      return yield* invalidWebhook('Webhook body exceeds the accepted limit');
    }

    const signature = yield* Schema.decodeUnknownEffect(Signature)(
      request.headers.get('x-hub-signature-256'),
    ).pipe(
      Effect.mapError(() =>
        invalidWebhook('Webhook signature is missing or malformed', 'invalid_signature'),
      ),
    );
    yield* verifySignature(body, signature, dependencies);

    const decodedJson = yield* readJson(body);
    const action = yield* Schema.decodeUnknownEffect(WebhookAction)(decodedJson).pipe(
      Effect.mapError(() => invalidWebhook('Webhook action is missing')),
    );
    if (request.headers.get('x-github-event') === 'pull_request') {
      const observation = yield* Schema.decodeUnknownEffect(PullRequestObservationWebhook)(
        decodedJson,
      ).pipe(Effect.mapError(() => invalidWebhook('Pull request webhook is malformed')));
      const optionalDeliveryId = Schema.decodeUnknownOption(Schema.NonEmptyString)(
        request.headers.get('x-github-delivery'),
      );
      const deliveryIdForObservation = Option.getOrUndefined(optionalDeliveryId);
      const observePrivate = (deliveryId: string) =>
        Effect.gen(function* () {
          if (observation.repository.visibility !== 'private') return;
          yield* forwardMetadataInvalidation(
            {
              deliveryId,
              reason: 'repository_private',
              installationId: observation.installation.id,
              repositoryIds: [observation.repository.id],
              visibility: 'private',
            },
            dependencies,
          );
        });

      if (
        deliveryIdForObservation !== undefined &&
        !(yield* checkInstallation(
          deliveryIdForObservation,
          'pull_request',
          observation.installation.id,
          dependencies,
        ))
      ) {
        return 'ignored' as const;
      }
      if (deliveryIdForObservation !== undefined) {
        yield* observePrivate(deliveryIdForObservation);
      }

      if (
        !supportedPullRequestActions.includes(
          action.action as (typeof supportedPullRequestActions)[number],
        )
      ) {
        yield* recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
          phase: 'ingress',
          outcome: 'ignored',
          deliveryId:
            deliveryIdForObservation === undefined
              ? undefined
              : sanitizeOperationalLogIdentifier(deliveryIdForObservation),
          event: 'pull_request',
          reason: 'unsupported_action',
        });
        return 'ignored' as const;
      }

      const deliveryId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
        request.headers.get('x-github-delivery'),
      ).pipe(Effect.mapError(() => invalidWebhook('Webhook delivery id is missing')));
      const payload = yield* Schema.decodeUnknownEffect(PullRequestWebhook)(decodedJson).pipe(
        Effect.mapError(() => invalidWebhook('Pull request webhook is malformed')),
      );
      if (
        payload.pull_request.user.type === 'Bot' &&
        !(yield* isAllowedBotAuthor(payload.pull_request.user.id, dependencies))
      ) {
        yield* recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
          phase: 'ingress',
          outcome: 'ignored',
          deliveryId: sanitizeOperationalLogIdentifier(deliveryId),
          event: 'pull_request',
          reason: 'bot_pull_request',
        });
        return 'ignored' as const;
      }
      return yield* forwardEvent(normalizePullRequest(deliveryId, payload), dependencies);
    }

    if (request.headers.get('x-github-event') === 'issue_comment') {
      if (action.action !== 'created') {
        yield* recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
          phase: 'ingress',
          outcome: 'ignored',
          deliveryId: sanitizeOperationalLogIdentifier(
            request.headers.get('x-github-delivery') ?? '',
          ),
          event: 'issue_comment',
          reason: 'unsupported_action',
        });
        return 'ignored' as const;
      }

      const deliveryId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
        request.headers.get('x-github-delivery'),
      ).pipe(Effect.mapError(() => invalidWebhook('Webhook delivery id is missing')));
      const payload = yield* Schema.decodeUnknownEffect(IssueCommentWebhook)(decodedJson).pipe(
        Effect.mapError(() => invalidWebhook('Issue comment webhook is malformed')),
      );
      if (
        !(yield* checkInstallation(
          deliveryId,
          'issue_comment',
          payload.installation.id,
          dependencies,
        ))
      ) {
        return 'ignored' as const;
      }
      if (payload.issue.pull_request === undefined) {
        yield* recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
          phase: 'ingress',
          outcome: 'ignored',
          deliveryId: sanitizeOperationalLogIdentifier(deliveryId),
          event: 'issue_comment',
          reason: 'non_pull_request_issue',
        });
        return 'ignored' as const;
      }
      if (payload.comment.body !== '/ai-review') {
        yield* recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
          phase: 'ingress',
          outcome: 'ignored',
          deliveryId: sanitizeOperationalLogIdentifier(deliveryId),
          event: 'issue_comment',
          reason: 'unsupported_action',
        });
        return 'ignored' as const;
      }

      return yield* forwardEvent(normalizeIssueComment(deliveryId, payload), dependencies);
    }

    const githubEvent = request.headers.get('x-github-event');
    if (githubEvent === 'check_run' || githubEvent === 'check_suite') {
      if (action.action !== 'rerequested') {
        yield* recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
          phase: 'ingress',
          outcome: 'ignored',
          deliveryId: sanitizeOperationalLogIdentifier(
            request.headers.get('x-github-delivery') ?? '',
          ),
          event: githubEvent,
          reason: 'unsupported_action',
        });
        return 'ignored' as const;
      }

      const deliveryId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
        request.headers.get('x-github-delivery'),
      ).pipe(Effect.mapError(() => invalidWebhook('Webhook delivery id is missing')));

      const normalized =
        githubEvent === 'check_run'
          ? normalizeCheckRunRerequest(
              deliveryId,
              yield* Schema.decodeUnknownEffect(CheckRunRerequestWebhook)(decodedJson).pipe(
                Effect.mapError(() => invalidWebhook('Check run webhook is malformed')),
              ),
            )
          : normalizeCheckSuiteRerequest(
              deliveryId,
              yield* Schema.decodeUnknownEffect(CheckSuiteRerequestWebhook)(decodedJson).pipe(
                Effect.mapError(() => invalidWebhook('Check suite webhook is malformed')),
              ),
            );

      if (
        !(yield* checkInstallation(
          deliveryId,
          githubEvent,
          normalized.installationId,
          dependencies,
        ))
      ) {
        return 'ignored' as const;
      }
      return yield* forwardEvent(normalized, dependencies);
    }

    const deliveryIdForMetadata = () =>
      Schema.decodeUnknownEffect(Schema.NonEmptyString)(
        request.headers.get('x-github-delivery'),
      ).pipe(Effect.mapError(() => invalidWebhook('Webhook delivery id is missing')));

    const ignoreMetadataAction = (deliveryId: string) =>
      recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
        phase: 'ingress',
        outcome: 'ignored',
        deliveryId: sanitizeOperationalLogIdentifier(deliveryId),
        event: 'metadata',
        reason: 'unsupported_action',
      });

    if (githubEvent === 'repository') {
      const deliveryId = yield* deliveryIdForMetadata();
      const payload = yield* Schema.decodeUnknownEffect(RepositoryVisibilityWebhook)(
        decodedJson,
      ).pipe(Effect.mapError(() => invalidWebhook('Repository webhook is malformed')));
      if (
        !(yield* checkInstallation(deliveryId, 'metadata', payload.installation.id, dependencies))
      ) {
        return 'ignored' as const;
      }
      if (!['privatized', 'deleted', 'transferred'].includes(payload.action)) {
        yield* ignoreMetadataAction(deliveryId);
        return 'ignored' as const;
      }
      const isPrivate = payload.action === 'privatized';
      return yield* forwardMetadataInvalidation(
        {
          deliveryId,
          reason: isPrivate ? 'repository_private' : 'repository_removed',
          installationId: payload.installation.id,
          repositoryIds: [payload.repository.id],
          visibility: isPrivate ? 'private' : 'unknown',
        },
        dependencies,
      );
    }

    if (githubEvent === 'installation_repositories') {
      const deliveryId = yield* deliveryIdForMetadata();
      const payload = yield* Schema.decodeUnknownEffect(InstallationRepositoriesWebhook)(
        decodedJson,
      ).pipe(
        Effect.mapError(() => invalidWebhook('Installation repositories webhook is malformed')),
      );
      if (
        !(yield* checkInstallation(deliveryId, 'metadata', payload.installation.id, dependencies))
      ) {
        return 'ignored' as const;
      }
      if (payload.action !== 'removed') {
        yield* ignoreMetadataAction(deliveryId);
        return 'ignored' as const;
      }
      return yield* forwardMetadataInvalidation(
        {
          deliveryId,
          reason: 'repository_removed',
          installationId: payload.installation.id,
          repositoryIds: (payload.repositories_removed ?? []).map((repository) => repository.id),
          visibility: 'unknown',
        },
        dependencies,
      );
    }

    if (githubEvent === 'installation') {
      const deliveryId = yield* deliveryIdForMetadata();
      const payload = yield* Schema.decodeUnknownEffect(InstallationWebhook)(decodedJson).pipe(
        Effect.mapError(() => invalidWebhook('Installation webhook is malformed')),
      );
      if (
        !(yield* checkInstallation(deliveryId, 'metadata', payload.installation.id, dependencies))
      ) {
        return 'ignored' as const;
      }
      if (!['deleted', 'suspend'].includes(payload.action)) {
        yield* ignoreMetadataAction(deliveryId);
        return 'ignored' as const;
      }
      return yield* forwardMetadataInvalidation(
        {
          deliveryId,
          reason: 'installation_removed',
          installationId: payload.installation.id,
          repositoryIds: [],
          visibility: 'unknown',
        },
        dependencies,
      );
    }

    return 'ignored' as const;
  });

type MetadataInvalidationInput = Omit<typeof MetadataInvalidationEvent.Type, 'event'>;

const forwardMetadataInvalidation = (
  event: MetadataInvalidationInput,
  dependencies: IngressDependencies,
) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(MetadataInvalidationEvent)({
      ...event,
      event: 'metadata',
    }).pipe(Effect.mapError(() => invalidWebhook('Metadata invalidation is invalid')));
    const coreResponse = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          dependencies.core.fetch(
            new Request('https://core.internal/metadata-events', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-compte-rendu-delivery': decoded.deliveryId,
              },
              body: JSON.stringify(decoded),
            }),
          ),
        ),
      catch: () =>
        new CoreUnavailable({
          message: 'Core service failed',
          deliveryId: event.deliveryId,
          event: 'metadata',
        }),
    });

    if (!coreResponse.ok) {
      return yield* new CoreUnavailable({
        message: `Core service returned ${coreResponse.status}`,
        deliveryId: event.deliveryId,
        event: 'metadata',
      });
    }

    yield* recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
      phase: 'ingress',
      outcome: 'accepted',
      deliveryId: sanitizeOperationalLogIdentifier(event.deliveryId) ?? 'redacted',
      event: 'metadata',
    });

    return 'accepted' as const;
  });

const forwardEvent = (event: NormalizedReviewEvent, dependencies: IngressDependencies) =>
  Effect.gen(function* () {
    const decodedEvent = yield* Schema.decodeUnknownEffect(ReviewEvent)(event).pipe(
      Effect.mapError(() => invalidWebhook('Normalized webhook is invalid')),
    );
    const coreResponse = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          dependencies.core.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-compte-rendu-delivery': decodedEvent.deliveryId,
              },
              body: JSON.stringify(decodedEvent),
            }),
          ),
        ),
      catch: () =>
        new CoreUnavailable({
          message: 'Core service failed',
          deliveryId: event.deliveryId,
          event: event.event,
        }),
    });

    if (!coreResponse.ok) {
      return yield* new CoreUnavailable({
        message: `Core service returned ${coreResponse.status}`,
        deliveryId: event.deliveryId,
        event: event.event,
      });
    }

    yield* recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
      phase: 'ingress',
      outcome: 'accepted',
      deliveryId: sanitizeOperationalLogIdentifier(event.deliveryId) ?? 'redacted',
      event: event.event,
    });

    return 'accepted' as const;
  });

const forwardRunnerCallback = async (request: Request, dependencies: IngressDependencies) => {
  if (
    dependencies.runnerCallbackToken === undefined ||
    request.headers.get('authorization') !== `Bearer ${dependencies.runnerCallbackToken}`
  ) {
    return new Response(null, { status: 401 });
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_RUNNER_CALLBACK_BYTES) {
    return new Response(null, { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_RUNNER_CALLBACK_BYTES) {
    return new Response(null, { status: 413 });
  }
  const forwarded = await dependencies.core.fetch(
    new Request('https://core.internal/runner-results', {
      method: 'POST',
      headers: {
        'content-type': request.headers.get('content-type') ?? 'application/json',
        'x-compte-rendu-runner-callback': 'verified',
      },
      body,
    }),
  );
  return new Response(null, { status: forwarded.ok ? 202 : 503 });
};

const forwardRunnerClaim = async (request: Request, dependencies: IngressDependencies) => {
  if (
    dependencies.runnerCallbackToken === undefined ||
    request.headers.get('authorization') !== `Bearer ${dependencies.runnerCallbackToken}`
  ) {
    return new Response(null, { status: 401 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > 64 * 1024) return new Response(null, { status: 413 });
  const forwarded = await dependencies.core.fetch(
    new Request('https://core.internal/runner-claims', {
      method: 'POST',
      headers: {
        'content-type': request.headers.get('content-type') ?? 'application/json',
        'x-compte-rendu-runner-claim': 'verified',
      },
      body,
    }),
  );
  const responseBody = await forwarded.arrayBuffer();
  return new Response(responseBody, {
    status: forwarded.status,
    headers: forwarded.headers,
  });
};

const isPublicReadPath = (path: string) =>
  path === '/api/dashboard' || path === '/api/jobs' || path.startsWith('/api/jobs/');

const forwardPublicRead = async (request: Request, dependencies: IngressDependencies) => {
  const url = new URL(request.url);
  const forwarded = await dependencies.core.fetch(
    new Request(`https://core.internal${url.pathname}${url.search}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    }),
  );
  return new Response(await forwarded.arrayBuffer(), {
    status: forwarded.status,
    headers: forwarded.headers,
  });
};

const forwardRunnerProgress = async (request: Request, dependencies: IngressDependencies) => {
  if (
    dependencies.runnerCallbackToken === undefined ||
    request.headers.get('authorization') !== `Bearer ${dependencies.runnerCallbackToken}`
  ) {
    return new Response(null, { status: 401 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_RUNNER_PROGRESS_BYTES) return new Response(null, { status: 413 });
  const forwarded = await dependencies.core.fetch(
    new Request('https://core.internal/runner-progress', {
      method: 'POST',
      headers: {
        'content-type': request.headers.get('content-type') ?? 'application/json',
        'x-compte-rendu-runner-progress': 'verified',
      },
      body,
    }),
  );
  return new Response(null, { status: forwarded.status });
};

export function createIngressWorker(dependencies: IngressDependencies): WorkerEntrypoint {
  return {
    fetch: async (request) => {
      if (request.method === 'GET') {
        const path = new URL(request.url).pathname;
        const isPage = path === '/' || path === '/history' || path.startsWith('/jobs/');
        if (isPage || path.startsWith('/_app/')) {
          try {
            if (dependencies.assets === undefined) return new Response(null, { status: 503 });
            const assetUrl = new URL(request.url);
            if (isPage) {
              assetUrl.pathname = '/index.html';
              assetUrl.search = '';
            }
            const asset = await dependencies.assets.fetch(new Request(assetUrl, request));
            if (!isPage) return asset;
            const headers = new Headers(asset.headers);
            headers.set('cache-control', 'no-store');
            return new Response(asset.body, { status: asset.status, headers });
          } catch {
            return new Response(null, { status: 503 });
          }
        }
        if (isPublicReadPath(path)) {
          try {
            return await forwardPublicRead(request, dependencies);
          } catch {
            return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
          }
        }
      }

      if (request.method !== 'POST') {
        return new Response(null, { status: 405 });
      }

      if (new URL(request.url).pathname === runnerCallbackPath) {
        try {
          return await forwardRunnerCallback(request, dependencies);
        } catch {
          return new Response(null, { status: 503 });
        }
      }

      if (new URL(request.url).pathname === runnerClaimPath) {
        try {
          return await forwardRunnerClaim(request, dependencies);
        } catch {
          return new Response(null, { status: 503 });
        }
      }

      if (new URL(request.url).pathname === runnerProgressPath) {
        try {
          return await forwardRunnerProgress(request, dependencies);
        } catch {
          return new Response(null, { status: 503 });
        }
      }

      const eventName = request.headers.get('x-github-event');
      if (!supportedEvents.includes(eventName as (typeof supportedEvents)[number])) {
        await Effect.runPromise(
          recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
            phase: 'ingress',
            outcome: 'ignored',
            deliveryId: sanitizeOperationalLogIdentifier(
              request.headers.get('x-github-delivery') ?? '',
            ),
            reason: 'unsupported_event',
          }),
        );
        return new Response(null, { status: 204 });
      }

      try {
        const result = await Effect.runPromise(processWebhook(request, dependencies));
        return new Response(null, { status: result === 'ignored' ? 204 : 202 });
      } catch (error) {
        if (error instanceof InvalidWebhook) {
          await Effect.runPromise(
            recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
              phase: 'ingress',
              outcome: 'rejected',
              reason: error.reason,
            }),
          );
          return new Response(null, { status: 400 });
        }

        if (error instanceof CoreUnavailable) {
          await Effect.runPromise(
            recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
              phase: 'ingress',
              outcome: 'retryable',
              deliveryId: sanitizeOperationalLogIdentifier(error.deliveryId),
              event: error.event,
              reason: 'core_unavailable',
            }),
          );
        }

        if (error instanceof InvalidAdmissionConfiguration) {
          return new Response(null, { status: 503 });
        }

        return new Response(null, { status: 503 });
      }
    },
  };
}

const ingress: WorkerEntrypoint<IngressEnv> = {
  fetch: (request, env) => {
    if (env === undefined) {
      return new Response(null, { status: 501 });
    }

    return createIngressWorker({
      secret: env.WEBHOOK_SECRET,
      crypto: globalThis.crypto,
      allowedInstallationIds: env.ALLOWED_INSTALLATION_IDS,
      allowedBotAuthorIds: env.ALLOWED_BOT_AUTHOR_IDS,
      core: env.CORE,
      assets: env.ASSETS,
      runnerCallbackToken: env.RUNNER_CALLBACK_TOKEN,
    }).fetch(request);
  },
};

export default ingress;

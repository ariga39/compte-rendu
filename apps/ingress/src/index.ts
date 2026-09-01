import { Effect, Schema } from 'effect';
import {
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

const supportedEvents = ['pull_request', 'issue_comment'] as const;
const runnerCallbackPath = '/runner-callback';
const supportedPullRequestActions = [
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
] as const;
const PullRequestAction = Schema.Literals(supportedPullRequestActions);
const WebhookAction = Schema.Struct({ action: Schema.String });
const InstallationId = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
const InstallationIds = Schema.Array(InstallationId).pipe(Schema.check(Schema.isMinLength(1)));
const InstallationIdsConfig = Schema.fromJsonString(InstallationIds);

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

const Signature = Schema.String.check(Schema.isPattern(new RegExp('^sha256=[0-9a-f]{64}$', 'i')));

export interface IngressDependencies {
  readonly secret: string;
  readonly crypto: Pick<Crypto, 'subtle'>;
  readonly allowedInstallationIds: unknown;
  readonly core: CoreServiceBinding;
  readonly runnerCallbackToken?: string;
  readonly log?: OperationalLog;
}

export interface IngressEnv {
  readonly WEBHOOK_SECRET: string;
  readonly ALLOWED_INSTALLATION_IDS: string;
  readonly CORE: CoreServiceBinding;
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
  event: Schema.Literals(['pull_request', 'issue_comment']),
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

const checkInstallation = (
  deliveryId: string,
  event: 'pull_request' | 'issue_comment',
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
      if (
        !supportedPullRequestActions.includes(
          action.action as (typeof supportedPullRequestActions)[number],
        )
      ) {
        yield* recordOperationalLog(dependencies.log ?? createCloudflareOperationalLog(), {
          phase: 'ingress',
          outcome: 'ignored',
          deliveryId: sanitizeOperationalLogIdentifier(
            request.headers.get('x-github-delivery') ?? '',
          ),
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
        !(yield* checkInstallation(
          deliveryId,
          'pull_request',
          payload.installation.id,
          dependencies,
        ))
      ) {
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

    return 'ignored' as const;
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

export function createIngressWorker(dependencies: IngressDependencies): WorkerEntrypoint {
  return {
    fetch: async (request) => {
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
      core: env.CORE,
      runnerCallbackToken: env.RUNNER_CALLBACK_TOKEN,
    }).fetch(request);
  },
};

export default ingress;

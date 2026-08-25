import { Effect, Schema } from 'effect';
import {
  ReviewEvent,
  GitHubSha,
  type CoreServiceBinding,
  type ReviewEvent as NormalizedReviewEvent,
  type WorkerEntrypoint,
} from '@compte-rendu/contracts';

export const MAX_WEBHOOK_BYTES = 256 * 1024;

const supportedEvents = ['pull_request', 'issue_comment'] as const;
const supportedPullRequestActions = [
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
] as const;
const PullRequestAction = Schema.Literals(supportedPullRequestActions);
const WebhookAction = Schema.Struct({ action: Schema.String });

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
    body: Schema.String,
    user: Schema.Struct({ login: Schema.NonEmptyString }),
  }),
});

const Signature = Schema.String.check(Schema.isPattern(new RegExp('^sha256=[0-9a-f]{64}$', 'i')));

export interface IngressDependencies {
  readonly secret: string;
  readonly crypto: Pick<Crypto, 'subtle'>;
  readonly core: CoreServiceBinding;
}

export interface IngressEnv {
  readonly WEBHOOK_SECRET: string;
  readonly CORE: CoreServiceBinding;
}

class InvalidWebhook extends Schema.TaggedError<InvalidWebhook>()('InvalidWebhook', {
  message: Schema.String,
}) {}

class CoreUnavailable extends Schema.TaggedError<CoreUnavailable>()('CoreUnavailable', {
  message: Schema.String,
}) {}

const invalidWebhook = (message: string) => new InvalidWebhook({ message });

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
      catch: () => invalidWebhook('Webhook signature could not be verified'),
    });

    if (!validSignature) {
      return yield* invalidWebhook('Webhook signature is invalid');
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
  commenterLogin: payload.comment.user.login,
  command: '/ai-review',
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
    ).pipe(Effect.mapError(() => invalidWebhook('Webhook signature is missing or malformed')));
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
        return 'ignored' as const;
      }

      const deliveryId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
        request.headers.get('x-github-delivery'),
      ).pipe(Effect.mapError(() => invalidWebhook('Webhook delivery id is missing')));
      const payload = yield* Schema.decodeUnknownEffect(PullRequestWebhook)(decodedJson).pipe(
        Effect.mapError(() => invalidWebhook('Pull request webhook is malformed')),
      );
      return yield* forwardEvent(normalizePullRequest(deliveryId, payload), dependencies);
    }

    if (request.headers.get('x-github-event') === 'issue_comment') {
      if (action.action !== 'created') {
        return 'ignored' as const;
      }

      const deliveryId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
        request.headers.get('x-github-delivery'),
      ).pipe(Effect.mapError(() => invalidWebhook('Webhook delivery id is missing')));
      const payload = yield* Schema.decodeUnknownEffect(IssueCommentWebhook)(decodedJson).pipe(
        Effect.mapError(() => invalidWebhook('Issue comment webhook is malformed')),
      );
      if (payload.issue.pull_request === undefined) {
        return 'ignored' as const;
      }
      if (payload.comment.body !== '/ai-review') {
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
      catch: () => new CoreUnavailable({ message: 'Core service failed' }),
    });

    if (!coreResponse.ok) {
      return yield* new CoreUnavailable({
        message: `Core service returned ${coreResponse.status}`,
      });
    }

    return 'accepted' as const;
  });

export function createIngressWorker(dependencies: IngressDependencies): WorkerEntrypoint {
  return {
    fetch: async (request) => {
      if (request.method !== 'POST') {
        return new Response(null, { status: 405 });
      }

      const eventName = request.headers.get('x-github-event');
      if (!supportedEvents.includes(eventName as (typeof supportedEvents)[number])) {
        return new Response(null, { status: 204 });
      }

      try {
        const result = await Effect.runPromise(processWebhook(request, dependencies));
        return new Response(null, { status: result === 'ignored' ? 204 : 202 });
      } catch (error) {
        if (error instanceof InvalidWebhook) {
          return new Response(null, { status: 400 });
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
      core: env.CORE,
    }).fetch(request);
  },
};

export default ingress;

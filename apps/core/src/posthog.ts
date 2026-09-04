import { Option, Schema } from 'effect';
import { PostHog } from 'posthog-node';
import { CoreLifecycleEvent, type CoreLifecycleLog } from './index';

interface PostHogEnvironment {
  readonly POSTHOG_ENABLED?: string;
  readonly POSTHOG_PROJECT_API_KEY?: string;
  readonly POSTHOG_HOST?: string;
  readonly POSTHOG_DEPLOYMENT?: string;
  readonly POSTHOG_ENVIRONMENT?: string;
}

interface WaitUntilContext {
  readonly waitUntil: (task: Promise<unknown>) => void;
}

const BoundedIdentifier = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)),
);
const ProjectApiKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^phc_[A-Za-z0-9._:-]{1,124}$/)),
);
const HttpsUrl = Schema.URLFromString.pipe(
  Schema.check(Schema.makeFilter((url) => url.protocol === 'https:', { expected: 'an HTTPS URL' })),
);
const PostHogConfiguration = Schema.Struct({
  projectApiKey: ProjectApiKey,
  host: HttpsUrl,
  environment: Schema.Literals(['production', 'staging']),
  deployment: BoundedIdentifier,
});

const propertiesFor = (
  event: CoreLifecycleEvent,
  environment: typeof PostHogConfiguration.Type.environment,
  deployment: string,
) => {
  const common = {
    schema_version: 1,
    environment,
    deployment,
    run_id: event.runId,
    trigger: event.trigger,
    $process_person_profile: false,
  };
  if (event.event === 'review scheduled') return common;
  if (event.event === 'review claimed') {
    return { ...common, queue_wait_ms: event.queueWaitMs };
  }
  const finished = {
    ...common,
    outcome: event.outcome,
    published: event.published,
    total_duration_ms: event.totalDurationMs,
    ...(event.queueWaitMs === undefined ? {} : { queue_wait_ms: event.queueWaitMs }),
    cleanup_status: event.cleanupStatus,
    evidence_status: event.evidenceStatus,
  };
  return event.outcome === 'failed'
    ? {
        ...finished,
        failure_phase: event.failurePhase,
        failure_reason: event.failureReason,
      }
    : finished;
};

const reportLocalFailure = (message: string) => {
  console.warn(`PostHog telemetry unavailable: ${message}`);
};

export const createPostHogLifecycleLog = (
  environment: PostHogEnvironment,
  context: WaitUntilContext | undefined,
): CoreLifecycleLog => {
  if (environment.POSTHOG_ENABLED !== 'true') return { record: () => undefined };

  const configuration = Option.getOrUndefined(
    Schema.decodeUnknownOption(PostHogConfiguration, { onExcessProperty: 'error' })({
      projectApiKey: environment.POSTHOG_PROJECT_API_KEY,
      host: environment.POSTHOG_HOST,
      environment: environment.POSTHOG_ENVIRONMENT,
      deployment: environment.POSTHOG_DEPLOYMENT,
    }),
  );
  if (configuration === undefined) {
    reportLocalFailure('configuration');
    return { record: () => undefined };
  }

  let client: PostHog;
  try {
    client = new PostHog(configuration.projectApiKey, {
      host: configuration.host.href,
      flushAt: 1,
      flushInterval: 0,
      fetchRetryCount: 0,
      requestTimeout: 3000,
      enableExceptionAutocapture: false,
      persistence: 'memory',
      fetch: async (url, options) => {
        try {
          const response = await fetch(url, options);
          if (response.status < 200 || response.status >= 300) {
            reportLocalFailure('capture');
          }
          return response;
        } catch {
          reportLocalFailure('capture');
          throw new Error('PostHog capture failed');
        }
      },
    });
  } catch {
    reportLocalFailure('initialization');
    return { record: () => undefined };
  }

  return {
    record: (event) => {
      const decoded = Option.getOrUndefined(
        Schema.decodeUnknownOption(CoreLifecycleEvent, { onExcessProperty: 'error' })(event),
      );
      if (decoded === undefined) {
        reportLocalFailure('event validation');
        return;
      }
      const task = client
        .captureImmediate({
          distinctId: decoded.runId,
          event: decoded.event,
          properties: propertiesFor(decoded, configuration.environment, configuration.deployment),
        })
        .catch(() => reportLocalFailure('capture'));
      if (context === undefined) {
        void task;
      } else {
        context.waitUntil(task);
      }
    },
  };
};

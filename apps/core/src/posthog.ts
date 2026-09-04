import { Option, Schema } from 'effect';
import { PostHog } from 'posthog-node';
import {
  CoreLifecycleFailureReason,
  type CoreLifecycleEvent,
  type CoreLifecycleLog,
} from './index';

type LifecycleEnvironment = 'production' | 'staging';

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

const boundedIdentifier = /^[A-Za-z0-9._:-]{1,128}$/;
const postHogProjectApiKey = /^phc_[A-Za-z0-9._:-]{1,124}$/;
const isHttpsHost = (value: string | undefined) => {
  if (value === undefined) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};
const isLifecycleEvent = (event: CoreLifecycleEvent): boolean => {
  if (!boundedIdentifier.test(event.runId)) return false;
  if (event.event === 'review scheduled') return true;
  if (event.event === 'review claimed') {
    return Number.isSafeInteger(event.queueWaitMs) && event.queueWaitMs >= 0;
  }
  if (
    !Number.isSafeInteger(event.totalDurationMs) ||
    event.totalDurationMs < 0 ||
    (event.queueWaitMs !== undefined &&
      (!Number.isSafeInteger(event.queueWaitMs) || event.queueWaitMs < 0))
  ) {
    return false;
  }
  return (
    event.failureReason === undefined ||
    Option.isSome(Schema.decodeUnknownOption(CoreLifecycleFailureReason)(event.failureReason))
  );
};

const propertiesFor = (
  event: CoreLifecycleEvent,
  environment: LifecycleEnvironment,
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
  return {
    ...common,
    outcome: event.outcome,
    published: event.published,
    total_duration_ms: event.totalDurationMs,
    ...(event.queueWaitMs === undefined ? {} : { queue_wait_ms: event.queueWaitMs }),
    cleanup_status: event.cleanupStatus,
    evidence_status: event.evidenceStatus,
    ...(event.failurePhase === undefined ? {} : { failure_phase: event.failurePhase }),
    ...(event.failureReason === undefined ? {} : { failure_reason: event.failureReason }),
  };
};

const reportLocalFailure = (message: string) => {
  console.warn(`PostHog telemetry unavailable: ${message}`);
};

const environmentFrom = (value: string | undefined): LifecycleEnvironment | undefined =>
  value === 'production' || value === 'staging' ? value : undefined;

export const createPostHogLifecycleLog = (
  environment: PostHogEnvironment,
  context: WaitUntilContext | undefined,
): CoreLifecycleLog => {
  if (environment.POSTHOG_ENABLED !== 'true') return { record: () => undefined };

  const projectApiKey = environment.POSTHOG_PROJECT_API_KEY;
  const host = environment.POSTHOG_HOST;
  const posthogEnvironment = environmentFrom(environment.POSTHOG_ENVIRONMENT);
  const deployment = environment.POSTHOG_DEPLOYMENT;
  if (
    projectApiKey === undefined ||
    !postHogProjectApiKey.test(projectApiKey) ||
    host === undefined ||
    !isHttpsHost(host) ||
    posthogEnvironment === undefined ||
    deployment === undefined ||
    !boundedIdentifier.test(deployment)
  ) {
    reportLocalFailure('configuration');
    return { record: () => undefined };
  }

  let client: PostHog;
  try {
    client = new PostHog(projectApiKey, {
      host,
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
      if (!isLifecycleEvent(event)) {
        reportLocalFailure('event validation');
        return;
      }
      const task = client
        .captureImmediate({
          distinctId: event.runId,
          event: event.event,
          properties: propertiesFor(event, posthogEnvironment, deployment),
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

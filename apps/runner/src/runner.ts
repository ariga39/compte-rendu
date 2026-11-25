import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Effect, Option, Schema } from 'effect';
import {
  REVIEW_ATTEMPT_BUDGET_MS,
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';
import {
  createSandboxBackend,
  type HostRun,
  type RunnerProcess,
  type SandboxBackend,
} from './sandbox-runtime.js';
import { createHostRun, runProcess } from './runner-process.js';
import { createRelayLlmServiceClient } from './llm-service-client.js';
import { createJobRegistry, createJobHandle, type JobHandle } from './job-registry.js';
import { createCleanupReconciler } from './cleanup-reconciler.js';
import { createClaimScheduler, type ClaimScheduler } from './claim-scheduler.js';
import { createJobExecutor, type JobExecutionInput } from './job-executor.js';
import { createReadTokenClient, type ReadTokenClient } from './read-token-client.js';
import { createGrantRevoker } from './grant-revoker.js';
import { createBoundedDelivery } from './evidence-store.js';
import { recoverCallback, ReplayCallbackRequest } from './callback-recovery.js';
import { decodeReviewModelConfig, trustedOpenCodeConfig } from './opencode-config.js';
import {
  readRunnerSettingsSync,
  watchRunnerSettings,
  type RunnerSettingsWatcher,
} from './runner-settings.js';

export type {
  RunnerDiagnostic,
  RunnerProcess,
  RunnerProcessOptions,
  RunnerProcessResult,
  SandboxRuntimeKind,
} from './sandbox-runtime.js';
export { runProcess };

const MODEL_HOST = 'opencode.ai';
const MODEL_PORT = '443';
const GRANT_REVOKE_ATTEMPTS = 2;
const GRANT_REVOKE_BUDGET_MS = 15 * 1000;
const MAX_REQUEST_BYTES = 64 * 1024;
const CALLBACK_REQUEST_TIMEOUT_MS = 30 * 1000;
const CLAIM_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CONCURRENCY = 1;
const RUNNER_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const isEnabled = (value: string | boolean | undefined): boolean =>
  value === true ||
  (typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

const RunnerConcurrency = Schema.Union([
  Schema.Int.check(Schema.isGreaterThan(0)),
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
]);

const resolveConcurrency = (option: number | undefined, env: string | undefined): number => {
  const decoded = Schema.decodeUnknownOption(RunnerConcurrency)(
    option ?? env ?? DEFAULT_CONCURRENCY,
  );
  if (Option.isNone(decoded)) {
    throw new Error('RUNNER_CONCURRENCY must be a positive integer');
  }
  return decoded.value;
};

type MaintenanceStatus = {
  readonly draining: boolean;
  readonly drained: boolean;
  readonly activeJobs: number;
  readonly claimInFlight: boolean;
  readonly claimPollingHalted: boolean;
  readonly cleanupBlockedJobs: number;
};

export interface RunnerOptions {
  readonly sandboxBackend?: SandboxBackend;
  /** Opt in to the remote relay control plane over the callback origin. */
  readonly llmRelay?: boolean;
  readonly llmGrantVersion?: 1 | 2;
  readonly authToken?: string;
  readonly modelConfig?: string;
  readonly evidenceRoot?: string;
  /** Stable deployment identity for per-instance Sandbox ownership records. */
  readonly instanceId?: string;
  readonly process?: RunnerProcess;
  readonly log?: OperationalLog;
  readonly callbackUrl?: string;
  readonly callbackToken?: string;
  readonly callbackFetch?: typeof fetch;
  readonly progressFetch?: typeof fetch;
  /** Fetch for the authenticated read-token refresh; defaults to callbackFetch. */
  readonly readTokenFetch?: typeof fetch;
  readonly callbackTimeoutMs?: number;
  readonly claimUrl?: string;
  readonly claimFetch?: typeof fetch;
  readonly claimTimeoutMs?: number;
  readonly claimIntervalMs?: number;
  readonly concurrency?: number;
  readonly settingsFile?: string;
}

const authorized = (request: Request, token: string | undefined) => {
  if (token === undefined) return false;
  return request.headers.get('authorization') === `Bearer ${token}`;
};

const jsonResponse = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const readJson = async (request: Request) => {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
};

export const createRunner = (options: RunnerOptions = {}) => {
  const settingsFileRaw = options.settingsFile ?? process.env.RUNNER_SETTINGS_FILE;
  const settingsFile =
    settingsFileRaw === undefined || settingsFileRaw.trim().length === 0
      ? undefined
      : settingsFileRaw.trim();
  let effectiveConcurrency =
    settingsFile === undefined
      ? resolveConcurrency(options.concurrency, process.env.RUNNER_CONCURRENCY)
      : readRunnerSettingsSync(settingsFile).concurrency;
  const llmServiceSocketRaw = process.env.RUNNER_LLM_SERVICE_SOCKET;
  if (llmServiceSocketRaw !== undefined && llmServiceSocketRaw.trim().length > 0) {
    throw new Error(
      'RUNNER_LLM_SERVICE_SOCKET is no longer supported; use RUNNER_LLM_RELAY with an HTTPS inference origin',
    );
  }
  const relayFlag = options.llmRelay ?? process.env.RUNNER_LLM_RELAY;
  const relayEnabled = isEnabled(relayFlag);
  const relayCallbackUrl = nonEmpty(options.callbackUrl ?? process.env.RUNNER_CALLBACK_URL);
  const relayCallbackToken = nonEmpty(options.callbackToken ?? process.env.RUNNER_CALLBACK_TOKEN);
  // RUNNER_LLM_RELAY_GENERATION from an existing deployment is intentionally
  // ignored: grants are revoked by job identity and expire on their own.
  let relayOrigin: string | undefined;
  let relayToken: string | undefined;
  if (relayEnabled) {
    if (relayCallbackUrl === undefined || relayCallbackToken === undefined) {
      throw new Error('RUNNER_LLM_RELAY requires RUNNER_CALLBACK_URL and RUNNER_CALLBACK_TOKEN');
    }
    const controlUrl = new URL(relayCallbackUrl);
    if (
      controlUrl.protocol !== 'https:' ||
      controlUrl.username !== '' ||
      controlUrl.password !== '' ||
      controlUrl.search !== '' ||
      controlUrl.hash !== ''
    ) {
      throw new Error('RUNNER_LLM_RELAY requires an HTTPS callback origin');
    }
    relayOrigin = controlUrl.origin;
    relayToken = relayCallbackToken;
  }
  const relayFetch = options.callbackFetch ?? globalThis.fetch;
  const authToken = options.authToken ?? process.env.RUNNER_AUTH_TOKEN;
  const evidenceRoot =
    options.evidenceRoot ??
    process.env.RUNNER_EVIDENCE_ROOT ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
      'compte-rendu',
      'reviews',
    );
  const instanceId =
    options.instanceId ?? process.env.RUNNER_INSTANCE_ID ?? `port-${process.env.PORT ?? 8080}`;
  if (!RUNNER_INSTANCE_ID.test(instanceId)) throw new Error('invalid Runner instance identity');
  const sandboxOwnershipRoot = join(evidenceRoot, 'sandbox-owners', instanceId);
  const executeProcess = options.process ?? runProcess;
  const hostRun: HostRun = createHostRun(executeProcess);
  const sandboxBackend =
    options.sandboxBackend ??
    createSandboxBackend(
      { kind: process.env.RUNNER_SANDBOX_RUNTIME },
      {
        hostRun,
        ownershipRoot: sandboxOwnershipRoot,
        relayEnabled,
      },
    );
  const modelConfig = decodeReviewModelConfig(
    options.modelConfig ?? process.env.REVIEW_MODEL_CONFIG,
    relayEnabled ? 'relay' : 'direct',
  );
  if (
    relayEnabled &&
    (modelConfig === undefined ||
      modelConfig.baseUrl === undefined ||
      modelConfig.definition === undefined)
  ) {
    throw new Error(
      'LLM service mode requires REVIEW_MODEL_CONFIG with an explicit baseUrl and model definition',
    );
  }
  if (
    relayEnabled &&
    relayOrigin !== undefined &&
    modelConfig?.baseUrl !== undefined &&
    new URL(relayOrigin).hostname.toLowerCase() === modelConfig.baseUrl.hostname.toLowerCase()
  ) {
    throw new Error('Remote LLM relay requires a dedicated inference hostname');
  }
  const grantVersion = String(options.llmGrantVersion ?? process.env.RUNNER_LLM_GRANT_VERSION ?? 1);
  if (relayEnabled && grantVersion !== '1' && grantVersion !== '2')
    throw new Error('Invalid RUNNER_LLM_GRANT_VERSION');
  const llmServiceClient =
    relayEnabled && relayOrigin !== undefined && relayToken !== undefined
      ? createRelayLlmServiceClient({
          grantVersion: grantVersion === '2' ? 2 : 1,
          origin: relayOrigin,
          token: relayToken,
          fetch: relayFetch,
        })
      : undefined;
  const modelId = modelConfig?.id;
  const serviceBaseUrl = modelConfig?.baseUrl;
  const modelResource = `${serviceBaseUrl?.hostname ?? MODEL_HOST}:${serviceBaseUrl?.port || MODEL_PORT}`;
  const openCodeConfig = modelConfig === undefined ? undefined : trustedOpenCodeConfig(modelConfig);
  const grantRevoker = createGrantRevoker({
    client: llmServiceClient,
    attempts: GRANT_REVOKE_ATTEMPTS,
    budgetMs: GRANT_REVOKE_BUDGET_MS,
  });
  const log = options.log;
  const recordLog = async (event: OperationalLogEvent) => {
    if (log === undefined) return;
    try {
      await log.record(sanitizeOperationalLogEvent(event));
    } catch {
      // Diagnostics must not change the product outcome.
    }
  };
  const callbackUrl = options.callbackUrl ?? process.env.RUNNER_CALLBACK_URL;
  const callbackToken = options.callbackToken ?? process.env.RUNNER_CALLBACK_TOKEN;
  const callbackFetch = options.callbackFetch ?? globalThis.fetch;
  const progressFetch = options.progressFetch ?? globalThis.fetch;
  const callbackTimeoutMs = options.callbackTimeoutMs ?? CALLBACK_REQUEST_TIMEOUT_MS;
  const postBounded = createBoundedDelivery({
    token: callbackToken,
    fetch: callbackFetch,
    timeoutMs: callbackTimeoutMs,
  });
  const claimUrl =
    options.claimUrl ??
    (callbackUrl === undefined
      ? undefined
      : (() => {
          try {
            return new URL('/runner-claim', callbackUrl).toString();
          } catch {
            return undefined;
          }
        })());
  const claimFetch = options.claimFetch ?? globalThis.fetch;
  const claimTimeoutMs = options.claimTimeoutMs ?? CLAIM_REQUEST_TIMEOUT_MS;
  const claimIntervalMs = options.claimIntervalMs ?? 1000;
  const readTokenUrl =
    callbackUrl === undefined
      ? undefined
      : (() => {
          try {
            return new URL('/runner-read-token', callbackUrl).toString();
          } catch {
            return undefined;
          }
        })();
  const readTokenClient: ReadTokenClient | undefined =
    readTokenUrl === undefined || callbackToken === undefined
      ? undefined
      : createReadTokenClient({
          url: readTokenUrl,
          token: callbackToken,
          fetch: options.readTokenFetch ?? callbackFetch,
        });
  const jobRegistry = createJobRegistry();
  let scheduler: ClaimScheduler;
  let closed = false;
  // Shared by the operator endpoint and automatic post-outage reconciliation.
  // Retained callback/manifest identity and exact backend absence must both be
  // confirmed before Core receives a recovery report.
  const maintenanceStatus = (): MaintenanceStatus => {
    const activeJobs = jobRegistry.activeCount();
    const cleanupBlockedJobs = jobRegistry.cleanupBlockedCount();
    const outage = sandboxBackend.health() === 'outage';
    const claim = scheduler.status();
    return {
      draining: claim.draining,
      drained:
        claim.draining &&
        cleanupReconciler.recovered() === true &&
        activeJobs === 0 &&
        !claim.claiming &&
        claim.claimRequestId === undefined &&
        !claim.claimPollingHalted &&
        !outage &&
        cleanupBlockedJobs === 0 &&
        cleanupReconciler.recoveringCount() === 0,
      activeJobs,
      claimInFlight:
        claim.claiming ||
        (!claim.claimPollingHalted && !outage && claim.claimRequestId !== undefined),
      claimPollingHalted: claim.claimPollingHalted || outage,
      cleanupBlockedJobs,
    };
  };
  const cleanupReconciler = createCleanupReconciler({
    backend: sandboxBackend,
    registry: jobRegistry,
    grants: grantRevoker,
    llmServiceClient,
    evidenceRoot,
    callbackUrl,
    callbackToken,
    postBounded,
    log,
    requestNext: () => scheduler.request(),
    isClosed: () => closed,
    claimIntervalMs,
    onBackendRecovered: () => scheduler?.noteBackendRecovered(),
    onRetry: () => scheduler?.resetClaimGateFailure(),
  });
  const jobExecutor = createJobExecutor({
    backend: sandboxBackend,
    process: executeProcess,
    evidenceRoot,
    callbackUrl,
    callbackToken,
    callbackFetch,
    callbackTimeoutMs,
    progressFetch,
    grants: grantRevoker,
    llmServiceClient,
    readTokenClient,
    relayEnabled,
    grantVersion,
    modelId,
    openCodeConfig,
    serviceBaseUrl,
    modelResource,
    log,
    retire: (handle) => jobRegistry.retireDestroyed(handle),
    scheduleCleanupRecovery: cleanupReconciler.scheduleDeferred,
    requestNextJob: () => scheduler.request(),
  });
  const publicState = (job: JobHandle) => ({ ...job.state });

  const admitJob = async (input: JobExecutionInput, claimed: boolean): Promise<Response> => {
    const admissionKey = createHash('sha256')
      .update(
        JSON.stringify([
          input.id,
          input.runId,
          input.attempt,
          input.repositoryUrl,
          input.repositoryName,
          input.pullRequestNumber,
          input.baseSha,
          input.headSha,
          input.repositoryReadToken,
        ]),
      )
      .digest('hex');
    const existingById = jobRegistry.get(input.id);
    if (existingById !== undefined)
      return jsonResponse(
        existingById.admissionKey === admissionKey ? 202 : 409,
        publicState(existingById),
      );
    const existing = jobRegistry.getByRun(input.runId, input.attempt);
    if (existing !== undefined) return jsonResponse(409, publicState(existing));
    if (!claimed && scheduler.status().draining) {
      return jsonResponse(503, { error: 'runner draining' });
    }
    if (!claimed && !scheduler.hasCapacity()) {
      return jsonResponse(409, { error: 'runner is busy' });
    }
    const contradictsSamePullRequest = jobRegistry.hasUnclearedSamePullRequest(input);
    if (contradictsSamePullRequest && !claimed) {
      return jsonResponse(409, { error: 'runner is busy' });
    }
    const id = input.id;
    const stop = claimed ? scheduler.takeStop(id) : undefined;
    const evidenceId = randomUUID();
    const admittedAt = Date.now();
    const claimDeadlineAt = input.claimDeadlineAt ?? admittedAt + REVIEW_ATTEMPT_BUDGET_MS;
    const handle = createJobHandle({
      id,
      runId: input.runId,
      attempt: input.attempt,
      repositoryName: input.repositoryName,
      pullRequestNumber: input.pullRequestNumber,
      baseSha: input.baseSha,
      headSha: input.headSha,
      admissionKey,
      claimDeadlineAt,
      state: {
        id,
        runId: input.runId,
        attempt: input.attempt,
        evidenceId,
        evidence: { id: evidenceId, status: 'pending' },
        status: 'queued',
        stage: 'admission',
        sandbox: { cleanup: 'pending' },
      },
      abortRequested:
        contradictsSamePullRequest || (stop !== undefined && stop.deadline > Date.now()),
    });
    jobRegistry.add(handle);
    void jobExecutor.execute(input, handle);
    return jsonResponse(202, publicState(handle));
  };

  scheduler = createClaimScheduler({
    backend: sandboxBackend,
    registry: jobRegistry,
    cleanup: cleanupReconciler,
    claimUrl,
    claimFetch,
    claimTimeoutMs,
    claimIntervalMs,
    authToken,
    callbackUrl,
    callbackToken,
    modelConfig,
    concurrency: () => effectiveConcurrency,
    admit: (input, claimed) => admitJob(input, claimed),
    log,
    isClosed: () => closed,
  });

  const handle = async (request: Request): Promise<Response> => {
    if (!authorized(request, authToken)) return jsonResponse(401, { error: 'unauthorized' });
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/maintenance') {
      return jsonResponse(200, maintenanceStatus());
    }
    if (request.method === 'POST' && path === '/maintenance/drain') {
      scheduler.drain();
      return jsonResponse(200, maintenanceStatus());
    }
    if (request.method === 'POST' && path === '/maintenance/resume') {
      scheduler.resume();
      cleanupReconciler.retry();
      return jsonResponse(200, maintenanceStatus());
    }
    if (request.method === 'POST' && path === '/maintenance/recover-cleanup') {
      if (!callbackUrl || !callbackToken)
        return jsonResponse(503, { error: 'callback unavailable' });
      const input = await Schema.decodeUnknownPromise(ReplayCallbackRequest)(
        await readJson(request),
      ).catch(() => undefined);
      if (input === undefined) return jsonResponse(400, { error: 'invalid recovery request' });
      const recovered = await cleanupReconciler.recover(input);
      if (!recovered.accepted) return jsonResponse(recovered.status, { error: recovered.error });
      scheduler.request();
      cleanupReconciler.retry();
      return jsonResponse(202, { accepted: true });
    }
    if (request.method === 'POST' && path === '/maintenance/replay-callback') {
      if (
        callbackUrl === undefined ||
        callbackUrl.length === 0 ||
        callbackToken === undefined ||
        callbackToken.length === 0
      ) {
        return jsonResponse(503, {
          accepted: false,
          error: 'callback unavailable',
          reason: 'callback-unavailable',
        });
      }
      const input = await Schema.decodeUnknownPromise(ReplayCallbackRequest)(
        await readJson(request),
      ).catch(() => undefined);
      if (input === undefined) {
        return jsonResponse(400, {
          accepted: false,
          error: 'invalid replay request',
          reason: 'invalid-request',
        });
      }
      const active = jobRegistry.findActiveMatch(input);
      if (active) {
        return jsonResponse(409, {
          accepted: false,
          error: 'job is active',
          reason: 'active-job',
        });
      }

      const recovered = await Effect.runPromise(
        recoverCallback(evidenceRoot, input).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, reason: error.reason }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        ),
      );
      if (!recovered.ok) {
        const status =
          recovered.reason === 'missing-evidence'
            ? 404
            : recovered.reason === 'oversized-callback'
              ? 413
              : 409;
        return jsonResponse(status, {
          accepted: false,
          error: 'callback recovery rejected',
          reason: recovered.reason,
        });
      }

      const delivered = await postBounded(callbackUrl, recovered.value.body);
      if (delivered.ok) {
        await recordLog({
          phase: 'runner',
          outcome: 'callback',
          runId: input.runId,
          jobId: input.jobId,
          attempt: 1,
          result: 'accepted',
          status: delivered.status,
        });
        return jsonResponse(202, { accepted: true });
      }
      if (delivered.reason === 'http-error') {
        await recordLog({
          phase: 'runner',
          outcome: 'callback',
          runId: input.runId,
          jobId: input.jobId,
          attempt: 1,
          result: 'http-error',
          status: delivered.status,
        });
        return jsonResponse(502, {
          accepted: false,
          error: 'callback delivery rejected',
          reason: 'http-error',
        });
      }
      await recordLog({
        phase: 'runner',
        outcome: 'callback',
        runId: input.runId,
        jobId: input.jobId,
        attempt: 1,
        result: delivered.reason,
      });
      return jsonResponse(delivered.reason === 'timeout' ? 504 : 502, {
        accepted: false,
        error:
          delivered.reason === 'timeout'
            ? 'callback delivery timed out'
            : 'callback delivery failed',
        reason: delivered.reason,
      });
    }
    const match = /^\/jobs\/([^/]+)$/.exec(path);
    if (match === null) return jsonResponse(404, { error: 'not found' });
    const job = jobRegistry.get(match[1]);
    if (job === undefined) {
      const deadline = Number(request.headers.get('x-compte-rendu-claim-deadline'));
      if (
        request.method === 'DELETE' &&
        scheduler.status().claiming &&
        Number.isSafeInteger(deadline) &&
        deadline > Date.now()
      ) {
        scheduler.stageStop(match[1], deadline);
        return jsonResponse(202, { status: 'stop requested' });
      }
      return jsonResponse(404, { error: 'not found' });
    }
    if (request.method === 'GET') return jsonResponse(200, publicState(job));
    if (request.method === 'DELETE') {
      if (job.state.status === 'queued' || job.state.status === 'running') {
        job.abort();
        await job.done;
      }
      return jsonResponse(200, publicState(job));
    }
    return jsonResponse(404, { error: 'not found' });
  };

  let settingsWatcher: RunnerSettingsWatcher | undefined;
  if (settingsFile !== undefined) {
    settingsWatcher = watchRunnerSettings(settingsFile, {
      onSettings: (next) => {
        const previous = effectiveConcurrency;
        effectiveConcurrency = next.concurrency;
        console.log(`runner settings reloaded concurrency=${next.concurrency}`);
        if (next.concurrency > previous && scheduler.hasCapacity()) scheduler.request();
      },
      onError: () => {
        console.log('runner settings update ignored; keeping last valid settings');
      },
    });
  }
  if (claimUrl !== undefined && claimUrl.length > 0) scheduler.start();

  return {
    handle,
    close: async () => {
      closed = true;
      scheduler.close();
      await cleanupReconciler.close();
      await settingsWatcher?.close();
    },
  };
};

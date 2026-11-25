import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Option, Schema } from 'effect';
import { REVIEW_ATTEMPT_BUDGET_MS, type OperationalLog } from '@compte-rendu/contracts';
import {
  createSandboxBackend,
  sandboxBackendHealth,
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
import { CleanupRecoveryRequest } from './callback-recovery.js';
import { decodeReviewModelConfig } from './opencode-config.js';

export type {
  RunnerDiagnostic,
  RunnerProcess,
  RunnerProcessOptions,
  RunnerProcessResult,
  SandboxRuntimeKind,
} from './sandbox-runtime.js';
export { runProcess };

const MODEL_PORT = '443';
const GRANT_REVOKE_ATTEMPTS = 2;
const GRANT_REVOKE_BUDGET_MS = 15 * 1000;
const MAX_REQUEST_BYTES = 64 * 1024;
const CALLBACK_REQUEST_TIMEOUT_MS = 30 * 1000;
const EVIDENCE_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CALLBACK_RETRY_DELAYS_MS = [0, 2_000, 5_000, 15_000, 30_000] as const;
const CLAIM_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CONCURRENCY = 1;

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
  readonly llmGrantVersion?: 1 | 2;
  readonly authToken?: string;
  readonly modelConfig?: string;
  readonly evidenceRoot?: string;
  readonly process?: RunnerProcess;
  readonly log?: OperationalLog;
  readonly callbackUrl?: string;
  readonly callbackToken?: string;
  readonly callbackFetch?: typeof fetch;
  /** Transport for the independent private diagnostic upload; defaults to callbackFetch. */
  readonly evidenceFetch?: typeof fetch;
  readonly evidenceTimeoutMs?: number;
  readonly callbackRetryDelaysMs?: readonly number[];
  /** Short settle delays before retrying one owned Sandbox destroy. */
  readonly destroyRetryDelaysMs?: readonly number[];
  readonly progressFetch?: typeof fetch;
  /** Fetch for the authenticated read-token refresh; defaults to callbackFetch. */
  readonly readTokenFetch?: typeof fetch;
  readonly callbackTimeoutMs?: number;
  readonly claimUrl?: string;
  readonly claimFetch?: typeof fetch;
  readonly claimTimeoutMs?: number;
  readonly claimIntervalMs?: number;
  /** Programmatic test tuning for the non-claiming capacity probe. */
  readonly claimProbeIntervalMs?: number;
  readonly concurrency?: number;
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
  const legacySettingsFile = process.env.RUNNER_SETTINGS_FILE?.trim();
  if (legacySettingsFile !== undefined && legacySettingsFile.length > 0) {
    throw new Error(
      'RUNNER_SETTINGS_FILE is no longer supported; set the desired concurrency in Dashboard Settings and keep RUNNER_CONCURRENCY as the startup fallback',
    );
  }
  const startupConcurrency = resolveConcurrency(
    options.concurrency,
    process.env.RUNNER_CONCURRENCY,
  );
  let effectiveConcurrency = startupConcurrency;
  const llmServiceSocketRaw = process.env.RUNNER_LLM_SERVICE_SOCKET;
  if (llmServiceSocketRaw !== undefined && llmServiceSocketRaw.trim().length > 0) {
    throw new Error(
      'RUNNER_LLM_SERVICE_SOCKET is no longer supported; use RUNNER_LLM_RELAY with an HTTPS inference origin',
    );
  }
  if (nonEmpty(process.env.MODEL_SECRET_COMMAND) !== undefined) {
    throw new Error(
      'MODEL_SECRET_COMMAND is no longer supported: direct-provider model credentials were removed. Configure managed inference with REVIEW_MODEL_CONFIG and the callback credentials instead.',
    );
  }
  const relayFlag = nonEmpty(process.env.RUNNER_LLM_RELAY);
  if (relayFlag !== undefined && !isEnabled(relayFlag)) {
    throw new Error(
      `RUNNER_LLM_RELAY=${relayFlag} is no longer supported: managed inference is the only model credential path. Remove RUNNER_LLM_RELAY or set it to 1.`,
    );
  }
  const callbackUrl = nonEmpty(options.callbackUrl ?? process.env.RUNNER_CALLBACK_URL);
  const callbackToken = nonEmpty(options.callbackToken ?? process.env.RUNNER_CALLBACK_TOKEN);
  if (callbackUrl === undefined || callbackToken === undefined) {
    throw new Error('Managed inference requires RUNNER_CALLBACK_URL and RUNNER_CALLBACK_TOKEN');
  }
  let controlUrl: URL;
  try {
    controlUrl = new URL(callbackUrl);
  } catch {
    throw new Error('RUNNER_CALLBACK_URL must be an HTTPS origin');
  }
  if (
    controlUrl.protocol !== 'https:' ||
    controlUrl.username !== '' ||
    controlUrl.password !== '' ||
    controlUrl.search !== '' ||
    controlUrl.hash !== ''
  ) {
    throw new Error(
      'RUNNER_CALLBACK_URL must be an HTTPS origin without credentials, query or fragment',
    );
  }
  // RUNNER_LLM_RELAY_GENERATION from an existing deployment is intentionally
  // ignored: grants are revoked by job identity and expire on their own.
  const relayOrigin = controlUrl.origin;
  const relayToken = callbackToken;
  const modelConfig = decodeReviewModelConfig(
    options.modelConfig ?? process.env.REVIEW_MODEL_CONFIG,
  );
  if (modelConfig === undefined) {
    throw new Error(
      'Managed inference requires REVIEW_MODEL_CONFIG with baseUrl "https://<INFERENCE_FQDN>/v1" on port 443; direct-provider configuration was removed.',
    );
  }
  if (controlUrl.hostname.toLowerCase() === modelConfig.baseUrl.hostname.toLowerCase()) {
    throw new Error(
      'Managed inference requires a dedicated inference hostname distinct from the callback host',
    );
  }
  const grantVersion = String(options.llmGrantVersion ?? process.env.RUNNER_LLM_GRANT_VERSION ?? 1);
  if (grantVersion !== '1' && grantVersion !== '2')
    throw new Error('Invalid RUNNER_LLM_GRANT_VERSION');
  const relayFetch = options.callbackFetch ?? globalThis.fetch;
  const llmServiceClient = createRelayLlmServiceClient({
    grantVersion: grantVersion === '2' ? 2 : 1,
    origin: relayOrigin,
    token: relayToken,
    fetch: relayFetch,
  });
  const serviceBaseUrl = modelConfig.baseUrl;
  const modelResource = `${serviceBaseUrl.hostname}:${serviceBaseUrl.port || MODEL_PORT}`;
  const grantRevoker = createGrantRevoker({
    client: llmServiceClient,
    attempts: GRANT_REVOKE_ATTEMPTS,
    budgetMs: GRANT_REVOKE_BUDGET_MS,
  });
  const log = options.log;
  const authToken = options.authToken ?? process.env.RUNNER_AUTH_TOKEN;
  const evidenceRoot =
    options.evidenceRoot ??
    process.env.RUNNER_EVIDENCE_ROOT ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
      'compte-rendu',
      'reviews',
    );
  const executeProcess = options.process ?? runProcess;
  const hostRun: HostRun = createHostRun(executeProcess);
  const sandboxBackend =
    options.sandboxBackend ??
    createSandboxBackend({ kind: process.env.RUNNER_SANDBOX_RUNTIME }, { hostRun });
  const callbackFetch = options.callbackFetch ?? globalThis.fetch;
  const evidenceFetch = options.evidenceFetch ?? callbackFetch;
  const progressFetch = options.progressFetch ?? globalThis.fetch;
  const callbackTimeoutMs = options.callbackTimeoutMs ?? CALLBACK_REQUEST_TIMEOUT_MS;
  const evidenceTimeoutMs = options.evidenceTimeoutMs ?? EVIDENCE_REQUEST_TIMEOUT_MS;
  const callbackRetryDelaysMs = options.callbackRetryDelaysMs ?? DEFAULT_CALLBACK_RETRY_DELAYS_MS;
  const evidenceUrl = new URL('/runner-evidence', callbackUrl).toString();
  const postBounded = createBoundedDelivery({
    token: callbackToken,
    fetch: callbackFetch,
    timeoutMs: callbackTimeoutMs,
  });
  const claimUrl = options.claimUrl ?? new URL('/runner-claim', callbackUrl).toString();
  const claimFetch = options.claimFetch ?? globalThis.fetch;
  const claimTimeoutMs = options.claimTimeoutMs ?? CLAIM_REQUEST_TIMEOUT_MS;
  const claimIntervalMs = options.claimIntervalMs ?? 1000;
  // A full Runner still discovers D1 increases. Keep this gentle so an idle
  // full host does not poll D1 at the claim cadence.
  const claimProbeIntervalMs = options.claimProbeIntervalMs ?? Math.max(claimIntervalMs, 5_000);
  const readTokenClient: ReadTokenClient = createReadTokenClient({
    url: new URL('/runner-read-token', callbackUrl).toString(),
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
    const outage = sandboxBackendHealth(sandboxBackend) === 'outage';
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
    callbackRetryDelaysMs,
    destroyRetryDelaysMs: options.destroyRetryDelaysMs,
    evidenceUrl,
    evidenceFetch,
    evidenceTimeoutMs,
    progressFetch,
    grants: grantRevoker,
    llmServiceClient,
    readTokenClient,
    grantVersion,
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
    probeIntervalMs: claimProbeIntervalMs,
    authToken,
    callbackUrl,
    callbackToken,
    modelConfig,
    concurrency: () => effectiveConcurrency,
    applyConcurrency: (value) => {
      const next = value ?? startupConcurrency;
      if (next === effectiveConcurrency) return;
      effectiveConcurrency = next;
      console.log(`runner desired concurrency=${next}`);
    },
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
      const input = await Schema.decodeUnknownPromise(CleanupRecoveryRequest)(
        await readJson(request),
      ).catch(() => undefined);
      if (input === undefined) return jsonResponse(400, { error: 'invalid recovery request' });
      const recovered = await cleanupReconciler.recover(input);
      if (!recovered.accepted) return jsonResponse(recovered.status, { error: recovered.error });
      scheduler.request();
      cleanupReconciler.retry();
      return jsonResponse(202, { accepted: true });
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

  if (claimUrl !== undefined && claimUrl.length > 0) scheduler.start();

  return {
    handle,
    close: async () => {
      closed = true;
      scheduler.close();
      await cleanupReconciler.close();
    },
  };
};

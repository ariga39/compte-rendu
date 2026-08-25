import { DateTime, Effect, Option, Schema } from 'effect';
import type { OpencodeOptions, OpencodeServer } from '@cloudflare/sandbox/opencode';
import type { Config } from '@opencode-ai/sdk/v2';
import {
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';
import type {
  ReviewAgentResult,
  ReviewCheckoutResult,
  ReviewLeaseAdapter,
  ReviewLeaseHandle,
  ReviewSandbox,
  ReviewSandboxAdapter,
} from './review-run';
import { createCloudflareOperationalLog } from './operational-log';

export const OPENCODE_VERSION = '1.18.22';
const OPENCODE_PROVIDER = 'opencode-go';
const OPENCODE_MODEL_ID = 'deepseek-v4-flash';
export const OPENCODE_MODEL = `${OPENCODE_PROVIDER}/${OPENCODE_MODEL_ID}`;
export const REVIEW_DIRECTORY = '/workspace/compte-rendu-review';

const ASKPASS_PATH = '/tmp/compte-rendu-git-askpass';
const OPENCODE_DATA_HOME = '/tmp/compte-rendu-opencode-data';
const OPENCODE_AUTH_PATH = `${OPENCODE_DATA_HOME}/opencode/auth.json`;
const CHECKOUT_TIMEOUT_MS = 60_000;
const REVIEW_DEADLINE_MILLIS = 10 * 60 * 1000;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const askpassScript =
  '#!/bin/sh\ncase "$1" in *[Uu]sername*) printf \'%s\\n\' x-access-token ;; *) printf \'%s\\n\' "$CHECKOUT_TOKEN" ;; esac\n';

export interface ReviewSandboxExecResult {
  readonly success: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReviewSandboxRaw {
  readonly writeFile: (path: string, content: string) => Promise<unknown>;
  readonly exec: (
    command: string,
    options?: {
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly timeout?: number;
    },
  ) => Promise<ReviewSandboxExecResult>;
  readonly destroy: () => Promise<void>;
}

type OpenCodePromptInput = {
  readonly sessionID: string;
  readonly directory: string;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly agent: string;
  readonly parts: Array<{ readonly type: 'text'; readonly text: string }>;
};

type OpenCodeClient = {
  readonly session: {
    readonly create: (parameters: {
      readonly directory?: string;
    }) => Promise<{ readonly id: string }>;
    readonly prompt: (parameters: OpenCodePromptInput) => Promise<{
      readonly info: { readonly error?: unknown };
      readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: unknown }>;
    }>;
    readonly abort: (parameters: {
      readonly sessionID: string;
      readonly directory: string;
    }) => Promise<boolean>;
  };
};

export interface ReviewDeadline {
  readonly schedule: (durationMillis: number, onElapsed: () => Promise<void>) => () => void;
}

const defaultReviewDeadline: ReviewDeadline = {
  schedule: (durationMillis, onElapsed) => {
    const handle = setTimeout(() => void onElapsed(), durationMillis);
    return () => clearTimeout(handle);
  },
};

export interface OpenCodeIntegration {
  readonly createOpencode: (
    sandbox: ReviewSandboxRaw,
    options: OpencodeOptions,
  ) => Promise<{
    readonly client: OpenCodeClient;
    readonly server: Pick<OpencodeServer, 'close'>;
  }>;
}

export interface ReviewAgentDiagnostics {
  readonly sandboxId: string;
  readonly log?: OperationalLog;
}

type AgentStage = 'server' | 'session' | 'prompt';

type AgentEventWithoutSandbox =
  | {
      readonly phase: 'agent';
      readonly outcome: 'progress';
      readonly stage: AgentStage;
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'completed';
      readonly stage: 'response';
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'failed';
      readonly stage: AgentStage;
      readonly reason: 'session_error' | 'transport_failure';
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'aborted';
      readonly stage: 'deadline';
      readonly reason: 'deadline';
    };

const recordAgentEvent = (
  diagnostics: ReviewAgentDiagnostics | undefined,
  event: AgentEventWithoutSandbox,
) => {
  const log = diagnostics?.log;
  const sandboxId = diagnostics?.sandboxId;
  if (log === undefined || sandboxId === undefined) return;
  const record = (eventWithSandbox: OperationalLogEvent) => {
    void Promise.resolve(log.record(sanitizeOperationalLogEvent(eventWithSandbox))).catch(
      () => undefined,
    );
  };
  try {
    switch (event.outcome) {
      case 'progress':
        record({ ...event, sandboxId });
        return;
      case 'completed':
        record({ ...event, sandboxId });
        return;
      case 'failed':
        record({ ...event, sandboxId });
        return;
      case 'aborted':
        record({ ...event, sandboxId });
        return;
    }
  } catch {
    // Operational logging cannot alter review or cleanup semantics.
  }
};

const defaultOpenCodeIntegration: OpenCodeIntegration = {
  createOpencode: async (sandbox, options) => {
    const { createOpencode } = await import('@cloudflare/sandbox/opencode');
    const result = await createOpencode(sandbox as Parameters<typeof createOpencode>[0], options);
    const client: OpenCodeClient = {
      session: {
        create: async (parameters) =>
          (await result.client.session.create(parameters, { throwOnError: true })).data,
        prompt: async (parameters) =>
          (await result.client.session.prompt(parameters, { throwOnError: true })).data,
        abort: async (parameters) =>
          (await result.client.session.abort(parameters, { throwOnError: true })).data,
      },
    };
    const server: Pick<OpencodeServer, 'close'> = result.server;
    return { client, server };
  },
};

const checkoutCommand = (input: {
  readonly repositoryUrl: string;
  readonly baseSha: string;
  readonly headSha: string;
}) =>
  [
    'set -eu',
    `chmod 700 ${ASKPASS_PATH}`,
    `git -c core.hooksPath=/dev/null -c submodule.recurse=false -c filter.lfs.smudge=: clone --quiet --no-checkout --no-recurse-submodules ${shellQuote(input.repositoryUrl)} ${REVIEW_DIRECTORY}`,
    `git -C ${REVIEW_DIRECTORY} config --local core.hooksPath /dev/null`,
    `GIT_LFS_SKIP_SMUDGE=1 git -C ${REVIEW_DIRECTORY} -c core.hooksPath=/dev/null -c submodule.recurse=false fetch --quiet --no-tags origin ${shellQuote(input.baseSha)} ${shellQuote(input.headSha)}`,
    `git -C ${REVIEW_DIRECTORY} -c core.hooksPath=/dev/null -c submodule.recurse=false checkout --quiet --detach ${shellQuote(input.headSha)}`,
    `git -C ${REVIEW_DIRECTORY} rev-parse ${shellQuote(`${input.baseSha}^{commit}`)} ${shellQuote('HEAD^{commit}')}`,
  ].join(' && ');

const credentialCleanupCommand = [
  'set -eu',
  `git -C ${REVIEW_DIRECTORY} remote remove origin`,
  `git -C ${REVIEW_DIRECTORY} config --local --unset-all credential.helper || true`,
  `git -C ${REVIEW_DIRECTORY} config --local --unset-all core.askPass || true`,
  `rm -f ${ASKPASS_PATH}`,
].join(' && ');

const trustedAgentConfig: Config = {
  agent: {
    review: {
      description: 'Read-only pull request reviewer',
      mode: 'primary',
      permission: {
        bash: 'deny',
        edit: 'deny',
        external_directory: 'deny',
        webfetch: 'deny',
      },
    },
  },
};

const reviewPrompt =
  'Review the checked-out pull request. Return exactly one JSON object with this shape: ' +
  '{"findings":[{"path":"string","line":0,"message":"string"}],"summary":"string"}. ' +
  'Do not run repository build, test, hooks, plugins, MCP, or project configuration.';

const checkoutEnvironment = (checkoutToken: string): Readonly<Record<string, string>> => ({
  CHECKOUT_TOKEN: checkoutToken,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: ASKPASS_PATH,
  GIT_LFS_SKIP_SMUDGE: '1',
  GIT_CONFIG_NOSYSTEM: '1',
});

const agentEnvironment = (): Record<string, string> => ({
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  HOME: '/tmp/compte-rendu-opencode-home',
  XDG_CONFIG_HOME: '/tmp/compte-rendu-opencode-xdg',
  XDG_DATA_HOME: OPENCODE_DATA_HOME,
});

const parseCheckoutResult = (stdout: string): ReviewCheckoutResult => {
  const commits = stdout.trim().split(/\s+/);
  if (commits.length !== 2 || commits.some((commit) => !/^[0-9a-f]{40}$/i.test(commit))) {
    throw new Error('checkout did not report exactly two commit SHAs');
  }
  return { baseSha: commits[0], headSha: commits[1] };
};

export const createReviewSandbox = (
  sandbox: ReviewSandboxRaw,
  openCodeIntegration: OpenCodeIntegration = defaultOpenCodeIntegration,
  deadline: ReviewDeadline = defaultReviewDeadline,
  diagnostics?: ReviewAgentDiagnostics,
): ReviewSandbox => ({
  checkout: async (input): Promise<ReviewCheckoutResult> => {
    await sandbox.writeFile(ASKPASS_PATH, askpassScript);
    const result = await sandbox.exec(checkoutCommand(input), {
      cwd: REVIEW_DIRECTORY,
      env: checkoutEnvironment(input.checkoutToken),
      timeout: CHECKOUT_TIMEOUT_MS,
    });
    if (!result.success || result.exitCode !== 0) {
      throw new Error('fixed checkout failed');
    }
    return parseCheckoutResult(result.stdout);
  },
  removeCheckoutCredentials: async () => {
    const result = await sandbox.exec(credentialCleanupCommand, {
      cwd: REVIEW_DIRECTORY,
      timeout: 30_000,
    });
    if (!result.success || result.exitCode !== 0) {
      throw new Error('checkout credentials could not be removed');
    }
  },
  runAgent: async (input): Promise<ReviewAgentResult> => {
    let server: { readonly close: () => Promise<void> } | undefined;
    let serverClosed = false;
    let cancelDeadline: (() => void) | undefined;
    let deadlineElapsed = false;
    let deadlineCleanup = Promise.resolve();
    let stage: AgentStage = 'server';
    const closeServer = async () => {
      if (server === undefined || serverClosed) return;
      serverClosed = true;
      await server.close().catch(() => undefined);
    };
    try {
      await sandbox.writeFile(
        OPENCODE_AUTH_PATH,
        JSON.stringify({
          'opencode-go': { type: 'api', key: input.modelCredential },
        }),
      );
      recordAgentEvent(diagnostics, { phase: 'agent', outcome: 'progress', stage: 'server' });
      const opencode = await openCodeIntegration.createOpencode(sandbox, {
        directory: REVIEW_DIRECTORY,
        config: trustedAgentConfig,
        env: agentEnvironment(),
      });
      server = opencode.server;
      stage = 'session';
      recordAgentEvent(diagnostics, { phase: 'agent', outcome: 'progress', stage: 'session' });
      const session = await opencode.client.session.create({ directory: REVIEW_DIRECTORY });
      const timeoutResult: ReviewAgentResult = {
        exitCode: 1,
        stdout: '',
        stderr: 'OpenCode timed out',
        timedOut: true,
      };
      const deadlineResult = new Promise<ReviewAgentResult>((resolve) => {
        cancelDeadline = deadline.schedule(REVIEW_DEADLINE_MILLIS, async () => {
          deadlineElapsed = true;
          recordAgentEvent(diagnostics, {
            phase: 'agent',
            outcome: 'aborted',
            stage: 'deadline',
            reason: 'deadline',
          });
          deadlineCleanup = (async () => {
            await opencode.client.session
              .abort({ sessionID: session.id, directory: REVIEW_DIRECTORY })
              .catch(() => undefined);
            await closeServer();
          })();
          await deadlineCleanup;
          resolve(timeoutResult);
        });
      });
      const reviewResult = (async (): Promise<ReviewAgentResult> => {
        try {
          stage = 'prompt';
          recordAgentEvent(diagnostics, { phase: 'agent', outcome: 'progress', stage: 'prompt' });
          const response = await opencode.client.session.prompt({
            sessionID: session.id,
            directory: REVIEW_DIRECTORY,
            model: { providerID: OPENCODE_PROVIDER, modelID: OPENCODE_MODEL_ID },
            agent: 'review',
            parts: [{ type: 'text', text: reviewPrompt }],
          });
          if (deadlineElapsed) {
            await deadlineCleanup;
            return timeoutResult;
          }
          if (response.info.error !== undefined) {
            recordAgentEvent(diagnostics, {
              phase: 'agent',
              outcome: 'failed',
              stage: 'prompt',
              reason: 'session_error',
            });
            return { exitCode: 1, stdout: '', stderr: 'OpenCode failed' };
          }
          recordAgentEvent(diagnostics, {
            phase: 'agent',
            outcome: 'completed',
            stage: 'response',
          });
          const textParts = response.parts.filter(
            (part) => part.type === 'text' && typeof part.text === 'string',
          );
          return {
            exitCode: 0,
            stdout: textParts.map((part) => JSON.stringify({ type: 'text', part })).join('\n'),
            stderr: '',
          };
        } catch (error) {
          if (deadlineElapsed) {
            await deadlineCleanup;
            return timeoutResult;
          }
          throw error;
        }
      })();
      return await Promise.race([reviewResult, deadlineResult]);
    } catch {
      if (deadlineElapsed) {
        await deadlineCleanup;
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'OpenCode timed out',
          timedOut: true,
        };
      }
      recordAgentEvent(diagnostics, {
        phase: 'agent',
        outcome: 'failed',
        stage,
        reason: 'transport_failure',
      });
      return { exitCode: 1, stdout: '', stderr: 'OpenCode failed' };
    } finally {
      cancelDeadline?.();
      await closeServer();
    }
  },
  destroy: () => sandbox.destroy(),
});

export interface CloudflareSandboxBindings {
  readonly Sandbox: Parameters<typeof import('@cloudflare/sandbox').getSandbox>[0];
}

export const createCloudflareSandboxAdapter = (
  bindings: CloudflareSandboxBindings,
  log?: OperationalLog,
): ReviewSandboxAdapter => ({
  getSandbox: async (sandboxId) => {
    const { getSandbox } = await import('@cloudflare/sandbox');
    const cloudflareSandbox = getSandbox(bindings.Sandbox, sandboxId, {
      enableDefaultSession: false,
    });
    return createReviewSandbox(cloudflareSandbox, undefined, undefined, { sandboxId, log });
  },
});

const LeaseRegistration = Schema.Struct({
  runId: Schema.NonEmptyString,
  attempt: Schema.Int,
  generation: Schema.Int,
  sandboxId: Schema.NonEmptyString,
  expiresAt: Schema.String,
});

export interface LeaseDurableObjectState {
  readonly storage: {
    readonly get: <A>(key: string) => Promise<A | undefined>;
    readonly put: (key: string, value: unknown) => Promise<void>;
    readonly delete: (key: string) => Promise<boolean>;
    readonly setAlarm: (time: number | Date) => Promise<void>;
    readonly deleteAlarm: () => Promise<void>;
  };
}

export interface LeaseDurableObjectEnv extends CloudflareSandboxBindings {}

export interface ReviewLeaseSandbox {
  readonly destroy: () => Promise<void>;
}

export interface ReviewLeaseDependencies {
  readonly log?: OperationalLog;
  readonly getSandbox?: (sandboxId: string) => Promise<ReviewLeaseSandbox>;
}

const leaseKey = 'review-lease';
const clearedLeaseKey = 'review-lease-cleared';
const retryDelayMillis = 30_000;

const currentEpochMillis = () =>
  Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)));

const recordOperationalLog = async (log: OperationalLog, event: OperationalLogEvent) => {
  try {
    await log.record(sanitizeOperationalLogEvent(event));
  } catch {
    // Operational logging cannot alter lease cleanup semantics.
  }
};

const sameLease = (
  left: Schema.Schema.Type<typeof LeaseRegistration>,
  right: Schema.Schema.Type<typeof LeaseRegistration>,
) =>
  left.runId === right.runId &&
  left.attempt === right.attempt &&
  left.generation === right.generation &&
  left.sandboxId === right.sandboxId &&
  left.expiresAt === right.expiresAt;

const sameLeaseIdentity = (
  left: Schema.Schema.Type<typeof LeaseRegistration>,
  right: Schema.Schema.Type<typeof LeaseRegistration>,
) =>
  left.runId === right.runId &&
  left.attempt === right.attempt &&
  left.generation === right.generation &&
  left.sandboxId === right.sandboxId;

export class ReviewLeaseDurableObject {
  private readonly log: OperationalLog;

  constructor(
    private readonly state: LeaseDurableObjectState,
    private readonly env: LeaseDurableObjectEnv,
    private readonly dependencies: ReviewLeaseDependencies = {},
  ) {
    this.log = dependencies.log ?? createCloudflareOperationalLog();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method === 'POST' && new URL(request.url).pathname === '/register') {
        const registration = await Schema.decodeUnknownPromise(LeaseRegistration)(
          await request.json(),
        );
        const expiresAt = DateTime.make(registration.expiresAt);
        if (Option.isNone(expiresAt)) {
          return new Response(null, { status: 400 });
        }
        const current =
          await this.state.storage.get<Schema.Schema.Type<typeof LeaseRegistration>>(leaseKey);
        if (current !== undefined) {
          if (!sameLeaseIdentity(current, registration)) {
            return new Response(null, { status: 409 });
          }
          const currentExpiry = DateTime.make(current.expiresAt);
          if (
            Option.isNone(currentExpiry) ||
            (await currentEpochMillis()) >= DateTime.toEpochMillis(currentExpiry.value)
          ) {
            return new Response(null, { status: 409 });
          }
          await this.state.storage.setAlarm(DateTime.toEpochMillis(currentExpiry.value));
          return new Response(null, { status: 204 });
        }
        try {
          await this.state.storage.delete(clearedLeaseKey);
          await this.state.storage.put(leaseKey, registration);
          await this.state.storage.setAlarm(DateTime.toEpochMillis(expiresAt.value));
        } catch (error) {
          await this.state.storage.delete(leaseKey);
          throw error;
        }
        return new Response(null, { status: 204 });
      }

      if (request.method === 'DELETE' && new URL(request.url).pathname === '/clear') {
        const requested = await Schema.decodeUnknownPromise(LeaseRegistration)(
          await request.json(),
        );
        const current =
          await this.state.storage.get<Schema.Schema.Type<typeof LeaseRegistration>>(leaseKey);
        if (current === undefined) {
          const cleared =
            await this.state.storage.get<Schema.Schema.Type<typeof LeaseRegistration>>(
              clearedLeaseKey,
            );
          if (cleared === undefined || !sameLeaseIdentity(cleared, requested)) {
            return new Response(null, { status: 409 });
          }
          await this.state.storage.deleteAlarm();
          return new Response(null, { status: 204 });
        }
        if (!sameLeaseIdentity(current, requested)) {
          return new Response(null, { status: 409 });
        }
        await this.state.storage.delete(leaseKey);
        await this.state.storage.deleteAlarm();
        return new Response(null, { status: 204 });
      }

      if (request.method === 'POST' && new URL(request.url).pathname === '/rearm') {
        const requested = await Schema.decodeUnknownPromise(LeaseRegistration)(
          await request.json(),
        );
        const current =
          await this.state.storage.get<Schema.Schema.Type<typeof LeaseRegistration>>(leaseKey);
        if (current === undefined || !sameLeaseIdentity(current, requested)) {
          return new Response(null, { status: 409 });
        }
        const cleanupDeadline = (await currentEpochMillis()) + retryDelayMillis;
        const updated = {
          ...current,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(cleanupDeadline)),
        };
        await this.state.storage.put(leaseKey, updated);
        await this.state.storage.setAlarm(cleanupDeadline);
        return new Response(null, { status: 204 });
      }

      return new Response(null, { status: 404 });
    } catch {
      return new Response(null, { status: 400 });
    }
  }

  async alarm(): Promise<void> {
    const registration =
      await this.state.storage.get<Schema.Schema.Type<typeof LeaseRegistration>>(leaseKey);
    if (registration === undefined) return;

    const generation = registration.generation;
    const expiresAt = DateTime.make(registration.expiresAt);
    if (Option.isNone(expiresAt) || generation < 1) {
      await this.state.storage.setAlarm((await currentEpochMillis()) + retryDelayMillis);
      await recordOperationalLog(this.log, {
        phase: 'lease',
        outcome: 'deferred',
        runId: registration.runId,
        attempt: registration.attempt,
        sandboxId: registration.sandboxId,
        reason: 'invalid',
      });
      return;
    }
    if ((await currentEpochMillis()) < DateTime.toEpochMillis(expiresAt.value)) {
      await this.state.storage.setAlarm(DateTime.toEpochMillis(expiresAt.value));
      await recordOperationalLog(this.log, {
        phase: 'lease',
        outcome: 'deferred',
        runId: registration.runId,
        attempt: registration.attempt,
        sandboxId: registration.sandboxId,
        reason: 'not_due',
      });
      return;
    }

    const current =
      await this.state.storage.get<Schema.Schema.Type<typeof LeaseRegistration>>(leaseKey);
    if (
      current === undefined ||
      current.generation !== generation ||
      !sameLease(current, registration)
    ) {
      return;
    }

    try {
      const sandbox =
        this.dependencies.getSandbox === undefined
          ? await (async () => {
              const { getSandbox } = await import('@cloudflare/sandbox');
              return getSandbox(this.env.Sandbox, registration.sandboxId, {
                enableDefaultSession: false,
              });
            })()
          : await this.dependencies.getSandbox(registration.sandboxId);
      await sandbox.destroy();
      await this.state.storage.put(clearedLeaseKey, registration);
      await this.state.storage.delete(leaseKey);
      await this.state.storage.deleteAlarm();
      await recordOperationalLog(this.log, {
        phase: 'lease',
        outcome: 'destroyed',
        runId: registration.runId,
        attempt: registration.attempt,
        sandboxId: registration.sandboxId,
      });
    } catch (error) {
      await this.state.storage.setAlarm((await currentEpochMillis()) + retryDelayMillis);
      await recordOperationalLog(this.log, {
        phase: 'lease',
        outcome: 'failed',
        runId: registration.runId,
        attempt: registration.attempt,
        sandboxId: registration.sandboxId,
        reason: 'cleanup_failed',
      });
      throw error;
    }
  }
}

export interface LeaseNamespaceLike {
  readonly idFromName: (name: string) => unknown;
  readonly get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
}

const leaseRequest = (
  namespace: LeaseNamespaceLike,
  runId: string,
  path: string,
  init?: RequestInit,
) =>
  namespace
    .get(namespace.idFromName(runId))
    .fetch(new Request(`https://lease.internal${path}`, init));

export const createDurableLeaseAdapter = (namespace: LeaseNamespaceLike): ReviewLeaseAdapter => ({
  register: async (input): Promise<ReviewLeaseHandle> => {
    const response = await leaseRequest(namespace, input.runId, '/register', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
    });
    if (!response.ok) throw new Error('lease registration failed');

    return {
      clear: async () => {
        const clearResponse = await leaseRequest(namespace, input.runId, '/clear', {
          method: 'DELETE',
          body: JSON.stringify(input),
          headers: { 'content-type': 'application/json' },
        });
        if (!clearResponse.ok) throw new Error('lease clear failed');
      },
      rearm: async () => {
        const rearmResponse = await leaseRequest(namespace, input.runId, '/rearm', {
          method: 'POST',
          body: JSON.stringify(input),
          headers: { 'content-type': 'application/json' },
        });
        if (!rearmResponse.ok) throw new Error('lease rearm failed');
      },
    };
  },
});

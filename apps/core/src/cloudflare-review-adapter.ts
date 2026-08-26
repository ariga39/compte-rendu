import { DateTime, Effect, Option, Schema } from 'effect';
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
import type { ReviewSandboxContainer } from './sandbox-container';
import type { getSandbox } from '@cloudflare/sandbox';

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
const MAX_AGENT_OUTPUT_BYTES = 256 * 1024;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const askpassScript =
  '#!/bin/sh\ncase "$1" in *[Uu]sername*) printf \'%s\\n\' x-access-token ;; *) printf \'%s\\n\' "$CHECKOUT_TOKEN" ;; esac\n';

export interface ReviewSandboxProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface ReviewSandboxProcess {
  readonly output: (options: {
    readonly encoding: 'utf8';
    readonly maxBytes?: number;
  }) => Promise<ReviewSandboxProcessOutput>;
}

export interface ReviewSandboxRaw {
  readonly writeFile: (path: string, content: string) => Promise<unknown>;
  readonly exec: (
    command: readonly [executable: string, ...args: string[]],
    options?: {
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly timeout?: number;
    },
  ) => Promise<ReviewSandboxProcess>;
  readonly destroy: () => Promise<void>;
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
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'status';
      readonly stage: 'process';
      readonly state: 'running' | 'exited' | 'error';
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'status';
      readonly stage: 'session';
      readonly state: 'busy' | 'idle' | 'retry' | 'error';
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'activity';
      readonly stage: 'process' | 'session';
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
      case 'status':
        record({ ...event, sandboxId });
        return;
      case 'activity':
        record({ ...event, sandboxId });
        return;
    }
  } catch {
    // Operational logging cannot alter review or cleanup semantics.
  }
};

const checkoutCommand = (input: {
  readonly repositoryUrl: string;
  readonly baseSha: string;
  readonly headSha: string;
}): readonly [string, string, string] => [
  '/bin/sh',
  '-c',
  [
    'set -eu',
    `chmod 700 ${ASKPASS_PATH}`,
    `git -c core.hooksPath=/dev/null -c submodule.recurse=false -c filter.lfs.smudge=: clone --quiet --no-checkout --no-recurse-submodules ${shellQuote(input.repositoryUrl)} ${REVIEW_DIRECTORY}`,
    `git -C ${REVIEW_DIRECTORY} config --local core.hooksPath /dev/null`,
    `GIT_LFS_SKIP_SMUDGE=1 git -C ${REVIEW_DIRECTORY} -c core.hooksPath=/dev/null -c submodule.recurse=false fetch --quiet --no-tags origin ${shellQuote(input.baseSha)} ${shellQuote(input.headSha)}`,
    `git -C ${REVIEW_DIRECTORY} -c core.hooksPath=/dev/null -c submodule.recurse=false checkout --quiet --detach ${shellQuote(input.headSha)}`,
    `git -C ${REVIEW_DIRECTORY} rev-parse ${shellQuote(`${input.baseSha}^{commit}`)} ${shellQuote('HEAD^{commit}')}`,
  ].join(' && '),
];

const credentialCleanupCommand: readonly [string, string, string] = [
  '/bin/sh',
  '-c',
  [
    'set -eu',
    `git -C ${REVIEW_DIRECTORY} remote remove origin`,
    `git -C ${REVIEW_DIRECTORY} config --local --unset-all credential.helper || true`,
    `git -C ${REVIEW_DIRECTORY} config --local --unset-all core.askPass || true`,
    `rm -f ${ASKPASS_PATH}`,
  ].join(' && '),
];

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

const reviewCommand: readonly [string, ...string[]] = [
  'opencode',
  'run',
  '--pure',
  '--format',
  'json',
  '--model',
  OPENCODE_MODEL,
  '--agent',
  'review',
  reviewPrompt,
];

const checkoutEnvironment = (checkoutToken: string): Readonly<Record<string, string>> => ({
  CHECKOUT_TOKEN: checkoutToken,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: ASKPASS_PATH,
  GIT_LFS_SKIP_SMUDGE: '1',
  GIT_CONFIG_NOSYSTEM: '1',
});

const agentEnvironment = (): Record<string, string> => ({
  OPENCODE_CONFIG_CONTENT: JSON.stringify(trustedAgentConfig),
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
  diagnostics?: ReviewAgentDiagnostics,
): ReviewSandbox => ({
  checkout: async (input): Promise<ReviewCheckoutResult> => {
    await sandbox.writeFile(ASKPASS_PATH, askpassScript);
    const process = await sandbox.exec(checkoutCommand(input), {
      cwd: REVIEW_DIRECTORY,
      env: checkoutEnvironment(input.checkoutToken),
      timeout: CHECKOUT_TIMEOUT_MS,
    });
    const result = await process.output({ encoding: 'utf8' });
    if (result.timedOut || result.truncated || result.exitCode !== 0) {
      throw new Error('fixed checkout failed');
    }
    return parseCheckoutResult(result.stdout);
  },
  removeCheckoutCredentials: async () => {
    const process = await sandbox.exec(credentialCleanupCommand, {
      cwd: REVIEW_DIRECTORY,
      timeout: 30_000,
    });
    const result = await process.output({ encoding: 'utf8' });
    if (result.timedOut || result.truncated || result.exitCode !== 0) {
      throw new Error('checkout credentials could not be removed');
    }
  },
  runAgent: async (input): Promise<ReviewAgentResult> => {
    try {
      await sandbox.writeFile(
        OPENCODE_AUTH_PATH,
        JSON.stringify({
          'opencode-go': { type: 'api', key: input.modelCredential },
        }),
      );
      recordAgentEvent(diagnostics, { phase: 'agent', outcome: 'progress', stage: 'server' });
      recordAgentEvent(diagnostics, { phase: 'agent', outcome: 'progress', stage: 'prompt' });
      const process = await sandbox.exec(reviewCommand, {
        cwd: REVIEW_DIRECTORY,
        env: agentEnvironment(),
        timeout: REVIEW_DEADLINE_MILLIS,
      });
      const result = await process.output({ encoding: 'utf8', maxBytes: MAX_AGENT_OUTPUT_BYTES });
      if (result.timedOut) {
        recordAgentEvent(diagnostics, {
          phase: 'agent',
          outcome: 'aborted',
          stage: 'deadline',
          reason: 'deadline',
        });
        return { exitCode: 1, stdout: '', stderr: 'OpenCode timed out', timedOut: true };
      }
      if (result.truncated || result.exitCode !== 0) {
        recordAgentEvent(diagnostics, {
          phase: 'agent',
          outcome: 'failed',
          stage: 'prompt',
          reason: 'transport_failure',
        });
        return { exitCode: 1, stdout: '', stderr: 'OpenCode failed' };
      }
      recordAgentEvent(diagnostics, {
        phase: 'agent',
        outcome: 'completed',
        stage: 'response',
      });
      return { exitCode: 0, stdout: result.stdout, stderr: '' };
    } catch {
      recordAgentEvent(diagnostics, {
        phase: 'agent',
        outcome: 'failed',
        stage: 'prompt',
        reason: 'transport_failure',
      });
      return { exitCode: 1, stdout: '', stderr: 'OpenCode failed' };
    }
  },
  destroy: () => sandbox.destroy(),
});

export interface CloudflareSandboxBindings {
  readonly Sandbox: Parameters<typeof getSandbox<ReviewSandboxContainer>>[0];
}

export const createCloudflareSandboxAdapter = (
  bindings: CloudflareSandboxBindings,
  log?: OperationalLog,
): ReviewSandboxAdapter => ({
  getSandbox: async (sandboxId) => {
    const { getSandbox } = await import('@cloudflare/sandbox');
    const cloudflareSandbox = getSandbox<ReviewSandboxContainer>(bindings.Sandbox, sandboxId);
    const rawSandbox: ReviewSandboxRaw = {
      writeFile: (path, content) => cloudflareSandbox.writeFile(path, content),
      exec: async (command, options) =>
        cloudflareSandbox.exec(command, {
          cwd: options?.cwd,
          env:
            options?.env === undefined
              ? undefined
              : Object.fromEntries(
                  Object.entries(options.env).filter(
                    (entry): entry is [string, string] => entry[1] !== undefined,
                  ),
                ),
          timeout: options?.timeout,
        }),
      destroy: () => cloudflareSandbox.destroy(),
    };
    return createReviewSandbox(rawSandbox, { sandboxId, log });
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
              return getSandbox(this.env.Sandbox, registration.sandboxId);
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

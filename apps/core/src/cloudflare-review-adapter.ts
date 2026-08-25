import { DateTime, Effect, Option, Schema } from 'effect';
import type { OpenCodeOptions } from '@cloudflare/sandbox/opencode';
import type { OpenCodeHandle } from '@cloudflare/sandbox/opencode';
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
const OPENCODE_PORT = 4096;

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

export interface ReviewSandboxProcessStatus {
  readonly id: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly state: 'running' | 'exited' | 'error';
}

export interface ReviewOpenCodeProcess {
  readonly id: string;
  readonly kill: (signal?: number) => Promise<void>;
  readonly waitForExit: () => Promise<unknown>;
  readonly status?: () => Promise<unknown>;
  readonly logs?: (options?: {
    readonly replay?: boolean;
    readonly follow?: boolean;
  }) => Promise<ReviewProcessLogStream>;
}

interface ReviewProcessLogStream {
  readonly getReader: () => {
    readonly read: () => Promise<{ readonly done: boolean; readonly value?: unknown }>;
    readonly cancel: () => Promise<void>;
  };
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
  readonly getProcess?: (id: string) => Promise<ReviewOpenCodeProcess | null>;
  readonly listProcesses?: () => Promise<ReadonlyArray<ReviewSandboxProcessStatus>>;
  readonly openCode?: OpenCodeHandle;
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
  readonly event?: {
    readonly subscribe: (parameters: {
      readonly directory: string;
    }) => Promise<AsyncIterable<unknown>>;
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
  readonly createClient: (
    sandbox: ReviewSandboxRaw,
    options: OpenCodeOptions,
  ) => Promise<{
    readonly client: OpenCodeClient;
    readonly process: ReviewOpenCodeProcess;
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const processState = (value: unknown): 'running' | 'exited' | 'error' | undefined => {
  if (!isRecord(value)) return undefined;
  const state = value.state;
  return state === 'running' || state === 'exited' || state === 'error' ? state : undefined;
};

const sessionState = (value: unknown): 'busy' | 'idle' | 'retry' | 'error' | undefined => {
  if (!isRecord(value)) return undefined;
  const state = value.type;
  return state === 'busy' || state === 'idle' || state === 'retry' || state === 'error'
    ? state
    : undefined;
};

const observeAgentActivity = (
  diagnostics: ReviewAgentDiagnostics | undefined,
  process: ReviewOpenCodeProcess,
  client: OpenCodeClient,
) => {
  const recordProcessStatus = (state: 'running' | 'exited' | 'error') =>
    recordAgentEvent(diagnostics, {
      phase: 'agent',
      outcome: 'status',
      stage: 'process',
      state,
    });
  const recordSessionStatus = (state: 'busy' | 'idle' | 'retry' | 'error') =>
    recordAgentEvent(diagnostics, {
      phase: 'agent',
      outcome: 'status',
      stage: 'session',
      state,
    });

  const statusPromise = process.status?.();
  if (statusPromise !== undefined) {
    void statusPromise
      .then((status) => {
        const state = processState(status);
        if (state !== undefined) recordProcessStatus(state);
      })
      .catch(() => undefined);
  }

  const processLogs = process.logs;
  if (processLogs !== undefined) {
    void (async () => {
      const stream = await processLogs.call(process, { replay: true, follow: true });
      const reader = stream.getReader();
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          if (!isRecord(item.value)) continue;
          if (item.value.type === 'stdout' || item.value.type === 'stderr') {
            recordAgentEvent(diagnostics, {
              phase: 'agent',
              outcome: 'activity',
              stage: 'process',
            });
            continue;
          }
          if (item.value.type === 'terminal') {
            const state = processState(item.value);
            if (state !== undefined) recordProcessStatus(state);
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    })().catch(() => undefined);
  }

  if (client.event !== undefined) {
    void (async () => {
      const stream = await client.event?.subscribe({ directory: REVIEW_DIRECTORY });
      if (stream === undefined) return;
      for await (const event of stream) {
        if (!isRecord(event)) continue;
        if (event.type === 'session.status' && isRecord(event.properties)) {
          const status = sessionState(event.properties.status);
          if (status !== undefined) {
            recordSessionStatus(status);
            recordAgentEvent(diagnostics, {
              phase: 'agent',
              outcome: 'activity',
              stage: 'session',
            });
          }
        } else if (event.type === 'session.idle' || event.type === 'session.error') {
          recordSessionStatus(event.type === 'session.idle' ? 'idle' : 'error');
        }
      }
    })().catch(() => undefined);
  }
};

const isOpenCodeCommand = (command: ReadonlyArray<string>) => {
  if (command[0] !== 'opencode' || command[1] !== 'serve') return false;
  const ports: string[] = [];
  for (let index = 2; index < command.length; index += 1) {
    const argument = command[index];
    if (argument === '--port') {
      const port = command[index + 1];
      if (port === undefined) return false;
      ports.push(port);
      index += 1;
    } else if (argument.startsWith('--port=')) {
      ports.push(argument.slice('--port='.length));
    }
  }
  return ports.length === 1 && ports[0] === String(OPENCODE_PORT);
};

export const resolveOpenCodeProcessId = (
  processes: ReadonlyArray<ReviewSandboxProcessStatus>,
  directory: string,
): string | undefined => {
  const matches = processes.filter(
    (candidate) =>
      candidate.state === 'running' &&
      candidate.cwd === directory &&
      isOpenCodeCommand(candidate.command),
  );
  return matches.length === 1 ? matches[0]?.id : undefined;
};

const defaultOpenCodeIntegration: OpenCodeIntegration = {
  createClient: async (sandbox, options) => {
    if (sandbox.openCode === undefined || sandbox.listProcesses === undefined) {
      throw new Error('OpenCode extension is unavailable');
    }
    const { createOpenCodeClient } = await import('@cloudflare/sandbox/opencode');
    const client = await createOpenCodeClient(sandbox.openCode, options);
    const directory = options.directory ?? REVIEW_DIRECTORY;
    const runningProcessId = resolveOpenCodeProcessId(await sandbox.listProcesses(), directory);
    if (runningProcessId === undefined || sandbox.getProcess === undefined) {
      throw new Error('OpenCode server process is unavailable');
    }
    const process = await sandbox.getProcess(runningProcessId);
    if (process === null) throw new Error('OpenCode server process is unavailable');

    return {
      client: {
        session: {
          create: async (parameters) =>
            (await client.session.create(parameters, { throwOnError: true })).data,
          prompt: async (parameters) => {
            const response = await client.session.prompt(parameters, { throwOnError: true });
            return { info: { error: response.data.info.error }, parts: response.data.parts };
          },
          abort: async (parameters) =>
            (await client.session.abort(parameters, { throwOnError: true })).data,
        },
        event: {
          subscribe: async (parameters) => (await client.event.subscribe(parameters)).stream,
        },
      },
      process,
    };
  },
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
    let process: ReviewOpenCodeProcess | undefined;
    let processClosed = false;
    let cancelDeadline: (() => void) | undefined;
    let deadlineElapsed = false;
    let deadlineCleanup = Promise.resolve();
    let stage: AgentStage = 'server';
    const closeProcess = async () => {
      if (process === undefined || processClosed) return;
      processClosed = true;
      await process.kill(15).catch(() => undefined);
      await process.waitForExit().catch(() => undefined);
    };
    try {
      await sandbox.writeFile(
        OPENCODE_AUTH_PATH,
        JSON.stringify({
          'opencode-go': { type: 'api', key: input.modelCredential },
        }),
      );
      recordAgentEvent(diagnostics, { phase: 'agent', outcome: 'progress', stage: 'server' });
      const opencode = await openCodeIntegration.createClient(sandbox, {
        directory: REVIEW_DIRECTORY,
        config: trustedAgentConfig,
        env: agentEnvironment(),
      });
      process = opencode.process;
      observeAgentActivity(diagnostics, process, opencode.client);
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
          deadlineCleanup = Promise.resolve();
          void Promise.resolve()
            .then(() =>
              opencode.client.session.abort({
                sessionID: session.id,
                directory: REVIEW_DIRECTORY,
              }),
            )
            .catch(() => undefined);
          void closeProcess().catch(() => undefined);
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
      await closeProcess();
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
    const { createExtensionProcessSandbox } = await import('@cloudflare/sandbox/extensions');
    const cloudflareSandbox = getSandbox<ReviewSandboxContainer>(bindings.Sandbox, sandboxId);
    const processes = createExtensionProcessSandbox(cloudflareSandbox);
    const rawSandbox: ReviewSandboxRaw = {
      writeFile: (path, content) => cloudflareSandbox.writeFile(path, content),
      exec: async (command, options) =>
        processes.exec(command, {
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
      getProcess: (id) => processes.getProcess(id),
      listProcesses: () => processes.listProcesses(),
      openCode: cloudflareSandbox.opencode,
      destroy: () => cloudflareSandbox.destroy(),
    };
    return createReviewSandbox(rawSandbox, undefined, undefined, { sandboxId, log });
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

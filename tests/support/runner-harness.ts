import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, onTestFinished, vi } from 'vitest';
import {
  createRunner as createProductionRunnerRaw,
  runProcess,
  type RunnerProcess,
  type RunnerProcessOptions,
  type RunnerProcessResult,
} from '../../apps/runner/src/runner';
import { multiReviewConfig } from '../../apps/runner/src/opencode-multi-review';
import { createCoreWorker } from '../../apps/core/src/core-worker';
import type { SandboxBackend, SandboxHealth } from '../../apps/runner/src/sandbox-runtime';
import { createD1ReviewStateStore } from '../../apps/core/src/index';
import { SqliteD1Database } from './d1-database';
import { claimRunnerJob } from './runner-claim';
import { createClaimExecution } from './runner-execution';

delete process.env.REVIEW_MODEL_CONFIG;

export const defaultReviewMarkdown = '## Review:\n\nNo findings.';

export const sessionExportJson = (
  id: string,
  options: {
    readonly outcome?: string;
    readonly finish?: string;
    readonly terminalIdle?: boolean;
    readonly decision?: string;
    readonly markdown?: string;
    readonly text?: string | null;
    readonly messageId?: string;
    readonly agent?: string;
    readonly model?: { readonly providerID: string; readonly id: string };
  } = {},
) => {
  const agent = options.agent ?? 'review';
  const model = options.model ?? { providerID: 'opencode-go', id: 'deepseek-flash' };
  const text =
    options.text === null
      ? undefined
      : (options.text ??
        JSON.stringify({
          decision: options.decision ?? 'comment',
          markdown: options.markdown ?? defaultReviewMarkdown,
        }));
  return JSON.stringify({
    info: { id, outcome: options.outcome ?? 'succeeded', agent, model },
    messages: [
      {
        type: 'assistant',
        id: options.messageId ?? 'msg-final',
        agent,
        model,
        finish: options.finish ?? 'stop',
        ...(text === undefined ? {} : { content: [{ type: 'text', text }] }),
      },
      ...(options.terminalIdle === false ? [] : [{ type: 'idle', outcome: 'succeeded' }]),
    ],
  });
};

export const structuredResult = (markdown: string, decision = 'comment') => ({
  version: 2,
  decision,
  markdown,
});

export const runnerJobFields = {
  id: 'runner-job-test',
  repositoryName: 'acme/reviewed',
  pullRequestNumber: 42,
  repositoryReadToken: 'github-read-token',
};
export const sharedEvidenceRoot = join(
  tmpdir(),
  `compte-rendu-runner-evidence-${process.pid}-${randomUUID()}`,
);

export const standardModelConfig = JSON.stringify({
  id: 'opencode-go/deepseek-flash',
  definition: {
    name: 'DeepSeek V4.1 Flash',
    reasoning: true,
    interleaved: { field: 'reasoning_content' },
    limit: { context: 1000000, output: 384000 },
    cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
  },
});

export const finalMarkdownJsonl = (
  markdown = defaultReviewMarkdown,
  sessionID = 'scenario-session',
) =>
  JSON.stringify({
    type: 'text',
    sessionID,
    part: {
      type: 'text',
      messageID: 'msg-final',
      text: JSON.stringify({ decision: 'comment', markdown }),
    },
  });

export const decisionText = (decision: string, markdown: string) =>
  `DECISION: ${decision}\n\n${markdown}`;

export const finalDecisionTextJsonl = (
  decision: string,
  markdown: string,
  sessionID = 'scenario-session',
) =>
  JSON.stringify({
    type: 'text',
    sessionID,
    part: {
      type: 'text',
      messageID: 'msg-final',
      text: decisionText(decision, markdown),
    },
  });

export const writeEvidenceFixture = async (
  args: readonly string[],
  options: {
    readonly stdoutFilePath?: string;
    readonly stderrFilePath?: string;
    readonly fileAppend?: boolean;
  },
  resultLine: string,
) => {
  const flag = options.fileAppend === true ? 'a' : 'w';
  if (args[0] === 'exec' && args.includes('--agent')) {
    await writeFile(options.stdoutFilePath!, `${resultLine}\n`, { mode: 0o600, flag });
    await writeFile(options.stderrFilePath!, 'agent stderr\n', { mode: 0o600, flag });
  }
  if (args[0] === 'exec' && args.includes('export') && options.stdoutFilePath !== undefined) {
    await writeFile(
      options.stdoutFilePath,
      `{"session":"${args[args.indexOf('export') + 1]}","full":true}\n`,
      { mode: 0o600, flag },
    );
  }
  if (args[0] === 'cp') {
    const source = args[1];
    const destination = args[2];
    const sessionId = source.match(/opencode-export-([A-Za-z0-9._:-]+)\.json$/)?.[1];
    if (sessionId !== undefined) {
      await writeFile(destination, sessionExportJson(sessionId), {
        mode: 0o600,
      });
    } else {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
      await writeFile(join(destination, 'opencode.db-wal'), 'wal', { mode: 0o600 });
      await writeFile(join(destination, 'opencode.db-shm'), 'shm', { mode: 0o600 });
      await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
    }
  }
};

export const readTextTree = async (root: string): Promise<string> => {
  const parts: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) parts.push(await readTextTree(path));
    else if (!entry.isSymbolicLink()) parts.push(await readFile(path, 'utf8'));
  }
  return parts.join('\n');
};

export type MergeBaseOverride = Partial<
  Pick<RunnerProcessResult, 'exitCode' | 'stdout' | 'timedOut' | 'truncated'>
>;
const withTestDestroyDefaults = <T extends { readonly destroyRetryDelaysMs?: readonly number[] }>(
  options: T,
): T & { readonly destroyRetryDelaysMs: readonly number[] } => ({
  ...options,
  destroyRetryDelaysMs: options.destroyRetryDelaysMs ?? [0],
});

export const createProductionRunner = (
  options: NonNullable<Parameters<typeof createProductionRunnerRaw>[0]> = {},
) => createProductionRunnerRaw(withTestDestroyDefaults(options));

export type TestRunnerOptions = Parameters<typeof createProductionRunner>[0] & {
  readonly mergeBase?: MergeBaseOverride;
};

export const withMergeBaseFixture = (
  originalProcess: RunnerProcess,
  mergeBaseOverride?: MergeBaseOverride,
): RunnerProcess => {
  let verifiedBaseSha: string | undefined;
  return async (command, args, processOptions) => {
    const result = await originalProcess(command, args, processOptions);
    if (command === 'git' && args.includes('rev-parse') && result.exitCode === 0) {
      const reported = result.stdout.trim().split(/\s+/);
      if (reported.length === 2 && /^[0-9a-f]{40}$/i.test(reported[0])) {
        verifiedBaseSha = reported[0];
      }
    }
    if (command === 'git' && args.includes('merge-base')) {
      if (mergeBaseOverride !== undefined) return { ...result, ...mergeBaseOverride };
      if (verifiedBaseSha !== undefined && result.exitCode === 0) {
        return { ...result, stdout: `${verifiedBaseSha}\n` };
      }
    }
    return result;
  };
};

/**
 * Test-process convenience: most Runner behavior tests do not model the native
 * cleanup inventory. Supply an empty secret inventory, and make a successful
 * `rm --force` followed by inspect report the exact not-found shape.
 */
export const withCleanupTestDefaults = (original: RunnerProcess): RunnerProcess => {
  const removed = new Set<string>();
  return async (command, args, options) => {
    const result = await original(command, args, options);
    if (args[0] === 'secret' && args[1] === 'ls' && result.exitCode === 0) {
      try {
        const parsed = JSON.parse(result.stdout) as {
          secrets?: unknown;
          custom_secrets?: unknown;
        };
        if (!Array.isArray(parsed.secrets) || !Array.isArray(parsed.custom_secrets)) {
          return { ...result, stdout: '{"secrets":[],"custom_secrets":[]}' };
        }
      } catch {
        return { ...result, stdout: '{"secrets":[],"custom_secrets":[]}' };
      }
    }
    if (args[0] === 'rm' && result.exitCode === 0 && !result.timedOut) {
      if (args[2] !== undefined) removed.add(args[2]);
    }
    if (args[0] === 'inspect' && removed.has(args[1] ?? '')) {
      return {
        ...result,
        exitCode: 1,
        stdout: '',
        stderr: `error: sandbox '${args[1]}' not found`,
      };
    }
    return result;
  };
};

export type ClaimExecution = ReturnType<typeof createClaimExecution>;
export type RunnerOptions = NonNullable<Parameters<typeof createProductionRunner>[0]>;

export const withAutoClaim = (
  options: RunnerOptions,
): {
  readonly options: RunnerOptions;
  readonly execution: ClaimExecution | undefined;
  readonly cleanupRoot: string | undefined;
} => {
  const autoClaim = options.claimUrl === undefined && options.claimFetch === undefined;
  const execution = createClaimExecution({
    callbackStatus: () => 202,
    longPoll: false,
  });
  const cleanupRoot =
    options.evidenceRoot === undefined
      ? mkdtempSync(join(tmpdir(), 'compte-rendu-runner-evidence-'))
      : undefined;
  return {
    execution,
    cleanupRoot,
    options: {
      ...options,
      evidenceRoot: options.evidenceRoot ?? cleanupRoot,
      claimUrl: autoClaim ? 'https://ingress.test/runner-claim' : options.claimUrl,
      ...(autoClaim ? { claimFetch: execution.claimFetch } : {}),
      claimIntervalMs: options.claimIntervalMs ?? (autoClaim ? 1 : undefined),
      modelConfig: options.modelConfig ?? standardModelConfig,
      callbackUrl: options.callbackUrl ?? 'https://ingress.test/runner-callback',
      callbackToken: options.callbackToken ?? 'callback-token',
      progressFetch: options.progressFetch ?? (async () => new Response(null, { status: 202 })),
      evidenceFetch: options.evidenceFetch ?? (async () => new Response(null, { status: 202 })),
      callbackFetch:
        options.callbackFetch === undefined
          ? execution.callbackFetch
          : async (input, init) => {
              execution.callbackRequests.push(new Request(input, init));
              return options.callbackFetch!(input, init);
            },
    },
  };
};

export const createProductionRunnerWithMergeBase = (options: RunnerOptions = {}) => {
  const {
    options: optionsWithCallback,
    execution,
    cleanupRoot,
  } = withAutoClaim({
    // Existing behavior tests fail teardown deterministically; a zero settle
    // delay keeps them fast. Retry behavior gets its own explicit delays.
    destroyRetryDelaysMs: [0],
    ...options,
  });
  const runner =
    options.process === undefined
      ? createProductionRunner(optionsWithCallback)
      : createProductionRunner({
          ...optionsWithCallback,
          process: withCleanupTestDefaults(withMergeBaseFixture(options.process)),
        });
  return withClaimSubmission(runner, execution, cleanupRoot);
};

export type ClaimRunner = ReturnType<typeof createProductionRunner> & {
  readonly enqueue: ClaimExecution['enqueue'];
  readonly waitForTerminal: ClaimExecution['waitForTerminal'];
  readonly claimExecution: ClaimExecution | undefined;
};

export const withClaimSubmission = (
  runner: ReturnType<typeof createProductionRunner>,
  execution: ClaimExecution | undefined,
  cleanupRoot?: string,
): ClaimRunner => {
  let closed = false;
  const closeRunner = runner.close.bind(runner);
  const close = async () => {
    if (closed) return;
    closed = true;
    execution?.stopClaims();
    await closeRunner();
    if (cleanupRoot !== undefined) await rm(cleanupRoot, { recursive: true, force: true });
  };
  onTestFinished(close);
  return Object.assign(runner, {
    claimExecution: execution,
    enqueue:
      execution === undefined
        ? () => {
            throw new Error('this Runner was configured with an explicit claim transport');
          }
        : (job: Parameters<ClaimExecution['enqueue']>[0]) => execution.enqueue(job),
    waitForTerminal:
      execution === undefined
        ? async () => {
            throw new Error('this Runner was configured with an explicit claim transport');
          }
        : (id?: string) => execution.waitForTerminal(id),
    close,
  });
};

export const createRunner = (options: TestRunnerOptions = {}) => {
  const { mergeBase: mergeBaseOverride, ...productionOptions } = withTestDestroyDefaults(options);
  const { options: optionsWithCallback, execution, cleanupRoot } = withAutoClaim(productionOptions);
  const originalProcess =
    productionOptions.process ??
    (async (command, args, options) =>
      args[0] === 'ls'
        ? { exitCode: 0, stdout: '', timedOut: false, truncated: false }
        : runProcess(command, args, options));
  const mergeBaseProcess = withMergeBaseFixture(originalProcess, mergeBaseOverride);
  const removedSandboxes = new Set<string>();
  const rules: Array<Record<string, unknown>> = [
    {
      id: 'default-deny-all',
      resources: ['**'],
      editable: false,
      origin: 'local',
      layer: 'local',
    },
  ];
  const runner = createProductionRunner({
    ...optionsWithCallback,
    process: async (command, args, processOptions) => {
      if (args[0] === 'ls' && args[1] === '-q') {
        return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
      }
      if (args[0] === 'secret' && args[1] === 'ls') {
        return {
          exitCode: 0,
          stdout:
            processOptions?.captureStdout === true ? '{"secrets":[],"custom_secrets":[]}' : '',
          timedOut: false,
          truncated: false,
        };
      }
      if (args[0] === 'policy' && args[1] === 'ls') {
        return {
          exitCode: 0,
          stdout: processOptions?.captureStdout === true ? JSON.stringify({ rules }) + '\n' : '',
          timedOut: false,
          truncated: false,
        };
      }
      const result = await mergeBaseProcess(command, args, processOptions);
      if (args[0] === 'rm' && result.exitCode === 0 && !result.timedOut) {
        const sandboxName = args[2];
        if (sandboxName !== undefined) {
          removedSandboxes.add(sandboxName);
          for (let index = rules.length - 1; index >= 0; index -= 1) {
            if (rules[index]!.sandbox_id === sandboxName) rules.splice(index, 1);
          }
        }
      }
      if (args[0] === 'inspect' && removedSandboxes.has(args[1]!)) {
        return {
          ...result,
          exitCode: 1,
          stdout: '',
          stderr: `error: sandbox '${args[1]}' not found`,
        };
      }
      if (
        args[0] === 'secret' &&
        args[1] === 'ls' &&
        result.exitCode === 0 &&
        result.stdout.trim() === ''
      ) {
        return { ...result, stdout: '{"secrets":[],"custom_secrets":[]}' };
      }
      if (
        args[0] === 'cp' &&
        result.exitCode === 0 &&
        !args[1].endsWith('/data') &&
        !args[1].endsWith('/state')
      ) {
        const destination = args[2];
        let destinationIsDirectory = false;
        try {
          const mode = (await stat(destination)).mode;
          destinationIsDirectory = (mode & 0o170000) === 0o040000;
        } catch {
          // The external Sandbox copy may not create the destination in a test double.
        }
        if (destinationIsDirectory) await rm(destination, { recursive: true, force: true });
        try {
          await stat(destination);
        } catch {
          const sessionId = args[1].match(/opencode-export-([A-Za-z0-9._:-]+)\.json$/)?.[1];
          if (sessionId !== undefined) {
            await writeFile(destination, sessionExportJson(sessionId), { mode: 0o600 });
          }
        }
      }
      if (args[0] === 'policy' && args[1] === 'allow' && result.exitCode === 0) {
        const sandbox = args[args.indexOf('--sandbox') + 1];
        const resource = args[args.length - 1];
        rules.push({
          id: `${sandbox}-${resource}`,
          resources: [resource],
          sandbox_id: sandbox,
          editable: true,
          origin: 'local',
          layer: 'local',
        });
      }
      if (args[0] === 'policy' && args[1] === 'rm' && result.exitCode === 0) {
        const ruleId = args[args.indexOf('--id') + 1];
        const index = rules.findIndex((rule) => rule.id === ruleId);
        if (index >= 0) rules.splice(index, 1);
      }
      return result;
    },
  });
  return withClaimSubmission(runner, execution, cleanupRoot);
};

beforeEach(async () => {
  vi.stubEnv('MODEL_SECRET_COMMAND', 'secret-resolver get MODEL_API_KEY');
  await rm(sharedEvidenceRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 20,
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(sharedEvidenceRoot, { recursive: true, force: true });
});

export const relayInferenceModelConfig = (route = 'deepseek-review') =>
  JSON.stringify({
    id: `opencode-go/${route}`,
    baseUrl: 'https://inference.example/v1',
    definition: { name: 'Review' },
  });

export const createRelayControl = (
  options: {
    readonly issuance?: 'normal' | 'malformed' | 'short' | 'http' | 'transport';
    readonly token?: string;
    readonly usage?: unknown;
    readonly rejectRevoke?: boolean;
    readonly descriptors?: readonly unknown[];
  } = {},
) => {
  const issued: Array<{ jobId: string; routes: string[]; token: string }> = [];
  const revoked: string[] = [];
  const requests: Array<{
    path: string;
    authorization?: string;
    body: Record<string, unknown>;
  }> = [];
  const active = new Map<string, string>();
  let counter = 0;
  let rejectRevoke = options.rejectRevoke ?? false;
  const controlFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const inputUrl =
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const path = new URL(inputUrl).pathname;
    const authorization = new Headers(init?.headers).get('authorization') ?? undefined;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    requests.push({
      path,
      ...(authorization === undefined ? {} : { authorization }),
      body,
    });
    if (path === '/runner-llm/issue' || path === '/runner-llm/issue-v2') {
      if (options.issuance === 'http')
        return new Response('http-response-body-canary', { status: 503 });
      if (options.issuance === 'transport') throw new Error('transport-response-canary');
      if (options.issuance === 'malformed')
        return new Response('{', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      const jobId = String(body.jobId);
      const token = options.token ?? `relay-grant-token-${(counter += 1)}`;
      active.set(token, jobId);
      issued.push({ jobId, routes: body.routes as string[], token });
      return Response.json(
        {
          token,
          ...(path.endsWith('issue-v2') ? { descriptors: options.descriptors } : {}),
          expiresAt: new Date(
            Date.now() + (options.issuance === 'short' ? 1000 : 2 * 60 * 60 * 1000),
          ).toISOString(),
        },
        { status: 201 },
      );
    }
    if (path === '/runner-llm/revoke') {
      const jobId = String(body.jobId);
      if (rejectRevoke) return new Response(null, { status: 503 });
      revoked.push(jobId);
      for (const [token, owner] of active) if (owner === jobId) active.delete(token);
      return new Response(null, { status: 204 });
    }
    if (path === '/runner-llm/usage') {
      const available = revoked.includes(String(body.jobId));
      if (options.usage === undefined) return new Response(null, { status: 200 });
      return available
        ? Response.json(options.usage)
        : Response.json({ error: 'grant still active' }, { status: 409 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return {
    fetch: controlFetch,
    issued,
    revoked,
    requests,
    activeTokens: active,
    setRejectRevoke: (value: boolean) => {
      rejectRevoke = value;
    },
  };
};

export type RelayControl = ReturnType<typeof createRelayControl>;

export const routeRelayControl = (
  control: RelayControl,
  callback: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) => {
  const routed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const inputUrl =
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    if (new URL(inputUrl).pathname.startsWith('/runner-llm/')) return control.fetch(input, init);
    return callback(input, init);
  }) as typeof fetch;
  return routed;
};

export const waitForTerminal = async (runner: ReturnType<typeof createRunner>, jobId: string) => {
  if (runner.claimExecution !== undefined) {
    return (await runner.waitForTerminal(jobId)).terminal;
  }
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const response = await runner.handle(
      new Request(`http://runner/jobs/${jobId}`, {
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );
    const state = (await response.json()) as {
      status: string;
      evidenceId?: string;
      evidence?: { id: string; status: string };
    };
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'aborted')
      return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Runner Job did not reach a terminal state');
};

// Trigger the refresh halfway through the 700ms fixture credential's life
// while the agent is running. Filesystem completion and terminal polling use real time.
export const triggerAgentRefresh = async () => {
  await vi.advanceTimersByTimeAsync(400);
  vi.useRealTimers();
};

export const runAgentScenario = async (scenario: {
  reviewConfiguration?: { revision: number; selection: { reviewers: string[]; synthesis: string } };
  runId: string;
  jobId?: string;
  attempt?: number;
  output: string;
  exitCode?: number;
  timedOut?: boolean;
  truncated?: boolean;
  stderrTruncated?: boolean;
  cleanupFailure?: boolean;
  cleanupRemovalFailures?: number;
  create?: { readonly exitCode?: number; readonly timedOut?: boolean };
  sandboxRemovalFailure?: boolean;
  callbackRequests?: Request[];
  evidenceRequests?: Request[];
  progressFetch?: typeof fetch;
  agentGate?: Promise<void>;
  onAgentStart?: () => void | Promise<void>;
  microsandbox?: boolean;
  onModelSecret?: (args: readonly string[]) => Promise<void>;
  callbackStatuses?: readonly number[];
  callbackRetryDelaysMs?: readonly number[];
  destroyRetryDelaysMs?: readonly number[];
  evidenceStatuses?: readonly number[];
  callbackHangs?: boolean;
  callbackThrows?: string;
  callbackTimeoutMs?: number;
  modelConfig?: string;
  relayControl?: RelayControl;
  sessionExport?: string;
  evidenceRoot?: string;
  repositoryReadToken?: string;
  agentProcess?: (options: RunnerProcessOptions) => Promise<RunnerProcessResult>;
  onProcess?: (args: readonly string[], options: RunnerProcessOptions) => void | Promise<void>;
  claimIntervalMs?: number;
  sandboxBackend?: SandboxBackend;
  logEvents?: unknown[];
  onRunner?: (runner: ReturnType<typeof createRunner>) => void;
}) => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  let agentInvoked = false;
  let createArgs: readonly string[] | undefined;
  let agentArgs: readonly string[] | undefined;
  let secretArgs: readonly string[] | undefined;
  const allowedResources: string[] = [];
  const removedRuleIds: string[] = [];
  let msbPresent = false;
  let msbName: string | undefined;
  let cleanupRemovalFailures = scenario.cleanupRemovalFailures ?? 0;
  const reviewConfiguration =
    scenario.reviewConfiguration ??
    (scenario.relayControl === undefined
      ? undefined
      : {
          revision: 1,
          selection: { reviewers: ['deepseek-review'], synthesis: 'deepseek-review' },
        });
  const jobInput = {
    ...runnerJobFields,
    id: scenario.jobId ?? runnerJobFields.id,
    ...(reviewConfiguration === undefined ? {} : { reviewConfiguration }),
    ...(scenario.repositoryReadToken === undefined
      ? {}
      : { repositoryReadToken: scenario.repositoryReadToken }),
    runId: scenario.runId,
    attempt: scenario.attempt ?? 1,
    repositoryUrl: 'https://github.com/acme/reviewed.git',
    baseSha,
    headSha,
  };
  const execution = createClaimExecution({
    callbackRequests: scenario.callbackRequests,
    callbackStatus: (attempt) => scenario.callbackStatuses?.[attempt - 1] ?? 202,
  });
  execution.enqueue(jobInput);
  const previousKind = process.env.RUNNER_SANDBOX_RUNTIME;
  const previousImage = process.env.MICROSANDBOX_IMAGE;
  if (scenario.microsandbox) {
    process.env.RUNNER_SANDBOX_RUNTIME = 'microsandbox';
    process.env.MICROSANDBOX_IMAGE = 'review:fixture';
  }
  let runner!: ReturnType<typeof createRunner>;
  try {
    runner = createRunner({
      sandboxBackend: scenario.sandboxBackend,
      evidenceRoot: scenario.evidenceRoot ?? sharedEvidenceRoot,
      authToken: 'runner-test-token',
      modelConfig: scenario.modelConfig,
      progressFetch: scenario.progressFetch,
      llmRelay: scenario.relayControl === undefined ? undefined : true,
      claimUrl: 'https://ingress.test/runner-claim',
      claimFetch: execution.claimFetch,
      claimIntervalMs: scenario.claimIntervalMs,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      callbackTimeoutMs: scenario.callbackTimeoutMs,
      callbackRetryDelaysMs: scenario.callbackRetryDelaysMs,
      destroyRetryDelaysMs: scenario.destroyRetryDelaysMs,
      callbackFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const inputUrl =
          input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
        if (
          scenario.relayControl !== undefined &&
          new URL(inputUrl).pathname.startsWith('/runner-llm/')
        ) {
          return scenario.relayControl.fetch(input, init);
        }
        const request = new Request(input, init);
        execution.callbackRequests.push(request);
        if (scenario.callbackThrows !== undefined) {
          throw new Error(scenario.callbackThrows);
        }
        if (scenario.callbackHangs === true) {
          return new Promise<Response>(() => undefined);
        }
        const status = scenario.callbackStatuses?.[execution.callbackRequests.length - 1] ?? 202;
        return new Response(null, { status });
      },
      evidenceFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        scenario.evidenceRequests?.push(request);
        const status =
          scenario.evidenceStatuses?.[(scenario.evidenceRequests?.length ?? 1) - 1] ?? 202;
        return new Response(null, { status });
      },
      log:
        scenario.logEvents === undefined
          ? undefined
          : {
              record: async (event) => {
                scenario.logEvents!.push(event);
              },
            },
      process: async (_command, args, options = {}) => {
        await scenario.onProcess?.(args, options);
        if (_command === 'msb') {
          const ok = { exitCode: 0, stdout: '', truncated: false, timedOut: false };
          if (args[0] === 'create') {
            msbPresent = true;
            msbName = args[args.indexOf('--name') + 1];
          }
          if (args[0] === 'ls')
            return {
              ...ok,
              stdout: JSON.stringify(
                msbPresent ? [{ name: msbName, created_at: new Date().toISOString() }] : [],
              ),
            };
          if (args[0] === 'rm') {
            if (scenario.cleanupFailure) return { ...ok, exitCode: 1 };
            if (cleanupRemovalFailures > 0) {
              cleanupRemovalFailures -= 1;
              return { ...ok, exitCode: 1 };
            }
            msbPresent = false;
            return ok;
          }
          if (args[0] === 'inspect') {
            const name = args.at(-1)!;
            return !msbPresent || name !== msbName
              ? { ...ok, exitCode: 1, stderr: 'error: sandbox not found: ' + name }
              : {
                  ...ok,
                  stdout: JSON.stringify({ name, created_at: new Date().toISOString() }),
                };
          }
        }
        const isAgent = args[0] === 'exec' && args.includes('--agent');
        if (isAgent && scenario.agentProcess !== undefined) {
          await scenario.onAgentStart?.();
          await scenario.agentGate;
          agentInvoked = true;
          agentArgs = args;
          return scenario.agentProcess(options);
        }
        await writeEvidenceFixture(args, options, scenario.output);
        if (args[0] === 'cp' && /opencode-export-[A-Za-z0-9._:-]+\.json$/.test(args[1])) {
          const sessionExport =
            scenario.sessionExport ??
            (scenario.relayControl === undefined
              ? undefined
              : sessionExportJson('scenario-session', {
                  model: { providerID: 'compte-rendu', id: 'deepseek-review' },
                }));
          if (sessionExport !== undefined) await writeFile(args[2], sessionExport, { mode: 0o600 });
        }
        if (args[0] === 'create') {
          createArgs = args;
        }
        if (args[0] === 'secret' && args[1] === 'set-custom') {
          secretArgs = args;
          await scenario.onModelSecret?.(args);
        }
        if (args[0] === 'policy' && args[1] === 'allow') {
          allowedResources.push(args[args.length - 1]);
        }
        if (args[0] === 'policy' && args[1] === 'rm') {
          removedRuleIds.push(args[args.indexOf('--id') + 1]);
        }
        if (isAgent) {
          await scenario.onAgentStart?.();
          await scenario.agentGate;
          agentInvoked = true;
          agentArgs = args;
        }
        const isCreate = args[0] === 'create';
        const isSandboxRemoval = args[0] === 'rm' && args[1] === '--force';
        return {
          exitCode: isAgent
            ? (scenario.exitCode ?? 0)
            : isCreate && scenario.create !== undefined
              ? (scenario.create.exitCode ?? 1)
              : (scenario.cleanupFailure && isSandboxRemoval) ||
                  (scenario.sandboxRemovalFailure === true && isSandboxRemoval)
                ? 1
                : 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('export')
              ? sessionExportJson('scenario-session')
              : args.includes('session')
                ? '[{"id":"scenario-session"}]\n'
                : options.captureStdout === true
                  ? `${scenario.output}\n`
                  : '',
          stderrTruncated: isAgent ? scenario.stderrTruncated : undefined,
          timedOut: isAgent
            ? (scenario.timedOut ?? false)
            : isCreate && scenario.create !== undefined
              ? (scenario.create.timedOut ?? false)
              : false,
          truncated: isAgent ? (scenario.truncated ?? false) : false,
        };
      },
    });
  } finally {
    if (previousKind === undefined) delete process.env.RUNNER_SANDBOX_RUNTIME;
    else process.env.RUNNER_SANDBOX_RUNTIME = previousKind;
    if (previousImage === undefined) delete process.env.MICROSANDBOX_IMAGE;
    else process.env.MICROSANDBOX_IMAGE = previousImage;
  }
  scenario.onRunner?.(runner);
  const terminalStartedAt = performance.now();
  const terminal = await execution.waitForTerminal(jobInput.id);
  const terminalDurationMs = performance.now() - terminalStartedAt;
  await vi.waitFor(async () => {
    const status = await runner.handle(
      new Request('http://runner/maintenance', {
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );
    expect(await status.json()).toMatchObject({ activeJobs: 0 });
  });
  if (scenario.evidenceRequests !== undefined) {
    await vi.waitFor(() => expect(scenario.evidenceRequests!.length).toBeGreaterThan(0));
  }
  if (scenario.onRunner === undefined) {
    await runner.close();
  }
  const terminalState = terminal.terminal;
  const manifest = JSON.parse(
    await readFile(
      join(
        scenario.evidenceRoot ?? sharedEvidenceRoot,
        terminalState.evidenceId as string,
        'manifest.json',
      ),
      'utf8',
    ),
  );
  return {
    terminal: terminalState,
    callback: terminal.callback,
    manifest,
    agentInvoked,
    terminalDurationMs,
    createArgs,
    agentArgs,
    secretArgs,
    allowedResources,
    removedRuleIds,
  };
};

export type ReminderRound = {
  readonly output: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly truncated?: boolean;
  readonly credentialObserved?: boolean;
  readonly advanceMs?: number;
  readonly exportFinish?: string;
  readonly finalText?: string | null;
};

export const runReminderScenario = async (scenario: {
  runId: string;
  rounds: readonly ReminderRound[];
  sessionId?: string;
  claimDeadlineAt?: number;
  repositoryReadTokenExpiresAt?: number;
  advanceOnCheckoutMs?: number;
  checkoutTimedOut?: boolean;
  advanceOnCreateMs?: number;
  createTimedOut?: boolean;
  advanceOnSessionExportMs?: number;
  duringAgent?: () => Promise<void>;
  expectedRotatedToken?: string;
  readTokenFetch?: typeof fetch;
  cleanupStderr?: string;
  logEvents?: unknown[];
}) => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  const sessionId = scenario.sessionId ?? 'session-reminder';
  const sandboxName = `compte-rendu-${runnerJobFields.id}`;
  const agentCommands: string[][] = [];
  const exportTimeouts: Array<number | undefined> = [];
  const agentTimeouts: Array<number | undefined> = [];
  const createCommands: string[][] = [];
  const githubTokenSnapshots: string[] = [];
  const readTokenRequests: Array<{
    readonly url: string;
    readonly authorization: string | null;
    readonly body: Record<string, unknown>;
  }> = [];
  let resumeTerminalPolling!: () => void;
  const agentClockRestored = new Promise<void>((resolve) => {
    resumeTerminalPolling = resolve;
  });
  let githubTokenPath: string | undefined;
  let githubSecretArgs: readonly string[] | undefined;
  let agentRuns = 0;
  const runner = createRunner({
    evidenceRoot: sharedEvidenceRoot,
    authToken: 'runner-test-token',
    ...(scenario.logEvents === undefined
      ? {}
      : {
          log: {
            record: async (event) => {
              scenario.logEvents!.push(event);
            },
          },
        }),
    ...(scenario.readTokenFetch === undefined
      ? {}
      : {
          readTokenFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const inputUrl =
              input instanceof Request
                ? input.url
                : input instanceof URL
                  ? input.href
                  : String(input);
            readTokenRequests.push({
              url: inputUrl,
              authorization: new Headers(init?.headers).get('authorization'),
              body:
                typeof init?.body === 'string'
                  ? (JSON.parse(init.body) as Record<string, unknown>)
                  : {},
            });
            return scenario.readTokenFetch!(input, init);
          },
        }),
    process: async (_command, args, options = {}) => {
      const isCreate = args[0] === 'create';
      if (isCreate) {
        createCommands.push([...args]);
        if (scenario.advanceOnCreateMs !== undefined) {
          vi.setSystemTime(Date.now() + scenario.advanceOnCreateMs);
        }
      }
      if (args[0] === 'secret' && args[1] === 'set' && args[2] === 'github') {
        githubSecretArgs = [...args];
        const command = args[args.indexOf('--command') + 1] ?? '';
        // Fixtures accept the controlled POSIX single-quoted host path emitted
        // for TMPDIR values that may contain spaces.
        githubTokenPath = /^cat '(.+)'$/.exec(command)?.[1] ?? /^cat (.+)$/.exec(command)?.[1];
      }
      if (args.includes('merge-base') && scenario.advanceOnCheckoutMs !== undefined) {
        vi.setSystemTime(Date.now() + scenario.advanceOnCheckoutMs);
        if (scenario.checkoutTimedOut)
          return { exitCode: 1, stdout: '', timedOut: true, truncated: false };
      }
      if (args.includes('export')) {
        exportTimeouts.push(options.timeoutMs);
        if (scenario.advanceOnSessionExportMs !== undefined)
          vi.setSystemTime(Date.now() + scenario.advanceOnSessionExportMs);
      }
      const readGithubToken = async () => {
        if (githubTokenPath === undefined) return '';
        try {
          return await readFile(githubTokenPath, 'utf8');
        } catch {
          return '';
        }
      };
      const isAgent = args[0] === 'exec' && args.includes('--agent');
      if (isAgent) {
        const round = scenario.rounds[Math.min(agentRuns, scenario.rounds.length - 1)]!;
        agentRuns += 1;
        agentCommands.push([...args]);
        agentTimeouts.push(options.timeoutMs);
        githubTokenSnapshots.push(await readGithubToken());
        await writeEvidenceFixture(args, options, round.output);
        await scenario.duringAgent?.();
        resumeTerminalPolling();
        if (scenario.expectedRotatedToken !== undefined) {
          // The on-demand secret command reads a real file. A response from
          // Core can precede the atomic rename that makes it visible here.
          await expect.poll(readGithubToken).toBe(scenario.expectedRotatedToken);
        }
        githubTokenSnapshots.push(await readGithubToken());
        if (round.advanceMs !== undefined) {
          vi.setSystemTime(Date.now() + round.advanceMs);
        }
        return {
          exitCode: round.exitCode ?? 0,
          stdout: `${round.output}\n`,
          timedOut: round.timedOut ?? false,
          truncated: round.truncated ?? false,
          ...(round.credentialObserved === true ? { credentialObserved: true } : {}),
        };
      }
      await writeEvidenceFixture(args, options, '');
      if (args[0] === 'cp' && args[1].includes('opencode-export-')) {
        await writeFile(
          args[2],
          sessionExportJson(sessionId, {
            finish: scenario.rounds[Math.max(agentRuns - 1, 0)]?.exportFinish,
            ...(scenario.rounds[Math.max(agentRuns - 1, 0)]?.finalText === undefined
              ? {}
              : { text: scenario.rounds[Math.max(agentRuns - 1, 0)]!.finalText }),
          }),
          { mode: 0o600 },
        );
      }
      return {
        exitCode: isCreate && scenario.createTimedOut === true ? 1 : 0,
        stdout: args.includes('rev-parse')
          ? `${baseSha}\n${headSha}\n`
          : args.includes('export')
            ? sessionExportJson(sessionId, {
                finish: scenario.rounds[Math.max(agentRuns - 1, 0)]?.exportFinish,
                ...(scenario.rounds[Math.max(agentRuns - 1, 0)]?.finalText === undefined
                  ? {}
                  : { text: scenario.rounds[Math.max(agentRuns - 1, 0)]!.finalText }),
              })
            : args.includes('session')
              ? `[{"id":"${sessionId}"}]\n`
              : '',
        ...(scenario.cleanupStderr === undefined ||
        !((args[0] === 'rm' && args[1] === '--force') || (args[0] === 'policy' && args[1] === 'rm'))
          ? {}
          : { stderr: scenario.cleanupStderr }),
        timedOut: isCreate && scenario.createTimedOut === true,
        truncated: false,
      };
    },
  });
  const submittedJob = {
    ...runnerJobFields,
    ...(scenario.claimDeadlineAt === undefined
      ? {}
      : { claimDeadlineAt: scenario.claimDeadlineAt }),
    ...(scenario.repositoryReadTokenExpiresAt === undefined
      ? {}
      : { repositoryReadTokenExpiresAt: scenario.repositoryReadTokenExpiresAt }),
    runId: scenario.runId,
    attempt: 1,
    repositoryUrl: 'https://github.com/acme/reviewed.git',
    baseSha,
    headSha,
  };
  runner.enqueue(submittedJob);
  const id = submittedJob.id;
  if (scenario.duringAgent) await agentClockRestored;
  const terminal = await waitForTerminal(runner, id);
  const manifest = JSON.parse(
    await readFile(
      join(sharedEvidenceRoot, terminal.evidenceId as string, 'manifest.json'),
      'utf8',
    ),
  );
  return {
    runner,
    terminal,
    manifest,
    agentCommands,
    agentTimeouts,
    exportTimeouts,
    agentRuns,
    createCommands,
    sessionId,
    sandboxName: (manifest.sandboxName as string | undefined) ?? sandboxName,
    githubSecretArgs,
    githubTokenPath,
    githubTokenSnapshots,
    readTokenRequests,
  };
};

export const completedWithoutSubmitJsonl = (sessionId: string) =>
  JSON.stringify({
    type: 'text',
    sessionID: sessionId,
    part: {
      type: 'text',
      messageID: 'msg-final',
      text: 'I completed the review without submitting.',
    },
  });

export {
  createClaimExecution,
  claimRunnerJob,
  createCoreWorker,
  createD1ReviewStateStore,
  multiReviewConfig,
  runProcess,
  SqliteD1Database,
  type RunnerProcess,
  type RunnerProcessOptions,
  type RunnerProcessResult,
  type SandboxBackend,
  type SandboxHealth,
};

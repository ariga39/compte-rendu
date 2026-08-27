import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Option, Schema } from 'effect';
import {
  REVIEW_ATTEMPT_BUDGET_MS,
  ReviewResult,
  RunnerJobInput,
  type RunnerJobResponse as RunnerJobResponseValue,
} from '@compte-rendu/contracts';
import prReviewSkill from '../skills/pr-review/SKILL.md?raw';

const MODEL = 'opencode-go/deepseek-v4-flash';
const MODEL_ENV = 'OPENCODE_API_KEY';
const MODEL_HOST = 'opencode.ai';
const MODEL_RESOURCE = `${MODEL_HOST}:443`;
const SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const CLEANUP_RESERVE_MS = 60 * 1000;
const CLEANUP_COMMAND_TIMEOUT_MS = 30 * 1000;
const MAX_AGENT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;

const trustedOpenCodeConfig = JSON.stringify({
  share: 'disabled',
  autoupdate: false,
  model: MODEL,
  agent: {
    review: {
      description: 'Read-only pull request reviewer',
      mode: 'primary',
      permission: {
        bash: {
          '*': 'deny',
          'git diff': 'allow',
          'git diff *': 'allow',
          'git show': 'allow',
          'git show *': 'allow',
          'git grep': 'allow',
          'git grep *': 'allow',
          'git diff *--output*': 'deny',
          'git show *--output*': 'deny',
          'git diff *--no-index*': 'deny',
          'git diff *>*': 'deny',
          'git show *>*': 'deny',
          'git grep *>*': 'deny',
          'git grep *--open-files-in-pager*': 'deny',
          'git grep *-O*': 'deny',
        },
        edit: 'deny',
        external_directory: 'deny',
        skill: { '*': 'deny', 'pr-review': 'allow' },
        webfetch: 'deny',
      },
    },
  },
});

const reviewPrompt = (baseSha: string, headSha: string) =>
  `First load the pr-review skill with the skill tool. Review only the exact caller-supplied ` +
  `pull request diff from base ${baseSha} to head ${headSha}; use ` +
  `git diff --find-renames ${baseSha} ${headSha} as the starting point. ` +
  'Return exactly one bare JSON object with this shape: ' +
  '{"findings":[{"path":"string","line":0,"message":"string"}],"summary":"string"}.';

const OpenCodeTextEvent = Schema.Struct({
  type: Schema.Literal('text'),
  part: Schema.Struct({
    type: Schema.Literal('text'),
    text: Schema.String,
  }),
});

const OpenCodeErrorEvent = Schema.Struct({ type: Schema.Literal('error') });

export type RunnerProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
};

export type RunnerProcessOptions = {
  readonly captureStdout?: boolean;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly onChild?: (child: ChildProcess) => void;
};

export type RunnerProcess = (
  command: string,
  args: readonly string[],
  options?: RunnerProcessOptions,
) => Promise<RunnerProcessResult>;

const stop = (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') => {
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
};

const runProcess: RunnerProcess = (command, args, options = {}) =>
  new Promise<RunnerProcessResult>((resolve) => {
    const chunks: Buffer[] = [];
    const captureStdout = options.captureStdout === true;
    const maxBytes = options.maxBytes ?? 0;
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimeout !== undefined) clearTimeout(killTimeout);
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(chunks).toString('utf8'),
        timedOut,
        truncated,
      });
    };

    try {
      child = spawn(command, args, {
        env: options.env ?? process.env,
        stdio: captureStdout ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'ignore', 'ignore'],
      });
      options.onChild?.(child);
    } catch {
      finish(1);
      return;
    }

    if (captureStdout && child.stdout !== null) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        if (truncated) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes + buffer.length > maxBytes) {
          truncated = true;
          return;
        }
        chunks.push(buffer);
        bytes += buffer.length;
      });
    }

    timeout = setTimeout(() => {
      timedOut = true;
      stop(child);
      killTimeout = setTimeout(() => stop(child, 'SIGKILL'), 5_000);
    }, options.timeoutMs ?? SETUP_TIMEOUT_MS);
    child.once('error', () => finish(1));
    child.once('close', (exitCode) => finish(exitCode));
  });

type RunnerJobState = RunnerJobResponseValue;

type RunnerJobInputState = {
  runId: string;
  attempt: number;
  repositoryUrl: string;
  baseSha: string;
  headSha: string;
  checkoutToken: string;
};

type RunnerJob = {
  readonly state: RunnerJobState;
  readonly id: string;
  readonly sandboxName: string;
  readonly input: RunnerJobInputState;
  readonly done: Promise<void>;
  resolveDone: () => void;
  child?: ChildProcess;
  abortRequested: boolean;
  sandboxAttempted: boolean;
  secretPlaceholder?: string;
  checkoutRoot?: string;
  configRoot?: string;
  deadlineAt: number;
};

export interface RunnerOptions {
  readonly sbxPath?: string;
  readonly authToken?: string;
  readonly modelSecretCommand?: string;
  readonly process?: RunnerProcess;
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

const parseResult = (stdout: string): Schema.Schema.Type<typeof ReviewResult> | undefined => {
  if (new TextEncoder().encode(stdout).byteLength > MAX_AGENT_OUTPUT_BYTES) return undefined;
  let candidate: Schema.Schema.Type<typeof ReviewResult> | undefined;
  let count = 0;
  for (const line of stdout.split(/\r?\n/).filter((value) => value.length > 0)) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (Option.isSome(Schema.decodeUnknownOption(OpenCodeErrorEvent)(event))) return undefined;
    const textEvent = Schema.decodeUnknownOption(OpenCodeTextEvent)(event);
    if (Option.isNone(textEvent)) continue;
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ReviewResult))(
      textEvent.value.part.text,
    );
    if (Option.isSome(decoded)) {
      candidate = decoded.value;
      count += 1;
    }
  }
  return count === 1 ? candidate : undefined;
};

const askpassScript =
  '#!/bin/sh\ncase "$1" in *[Uu]sername*) printf %s x-access-token ;; *) printf %s "$CHECKOUT_TOKEN" ;; esac\n';

export const createRunner = (options: RunnerOptions = {}) => {
  const sbxPath = options.sbxPath ?? process.env.SBX_BIN ?? 'sbx';
  const authToken = options.authToken ?? process.env.RUNNER_AUTH_TOKEN;
  const modelSecretCommand = options.modelSecretCommand ?? process.env.MODEL_SECRET_COMMAND;
  const executeProcess = options.process ?? runProcess;
  const jobs = new Map<string, RunnerJob>();
  const jobsByRun = new Map<string, RunnerJob>();

  const update = (job: RunnerJob, state: Partial<RunnerJobState>) => {
    Object.assign(job.state, state);
  };

  const runTracked = async (
    job: RunnerJob,
    command: string,
    args: readonly string[],
    processOptions: RunnerProcessOptions = {},
  ) => {
    const requestedTimeout = processOptions.timeoutMs ?? SETUP_TIMEOUT_MS;
    const remaining = job.deadlineAt - Date.now() - CLEANUP_RESERVE_MS;
    const result = await executeProcess(command, args, {
      ...processOptions,
      timeoutMs: Math.max(1, Math.min(requestedTimeout, remaining)),
      onChild: (child) => {
        job.child = child;
        processOptions.onChild?.(child);
        if (job.abortRequested) stop(child);
      },
    });
    job.child = undefined;
    return result;
  };

  const prepareCheckout = async (job: RunnerJob, root: string) => {
    const checkoutPath = join(root, 'checkout');
    const askpassPath = join(root, 'askpass');
    await writeFile(askpassPath, askpassScript, { mode: 0o700 });
    const env = {
      ...process.env,
      CHECKOUT_TOKEN: job.input.checkoutToken,
      GIT_ASKPASS: askpassPath,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    const clone = await runTracked(
      job,
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'submodule.recurse=false',
        '-c',
        'filter.lfs.smudge=:',
        'clone',
        '--quiet',
        '--no-checkout',
        '--no-recurse-submodules',
        job.input.repositoryUrl,
        checkoutPath,
      ],
      { env },
    );
    if (clone.exitCode !== 0 || clone.timedOut) return false;
    const fetch = await runTracked(
      job,
      'git',
      [
        '-C',
        checkoutPath,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'submodule.recurse=false',
        'fetch',
        '--quiet',
        '--no-tags',
        'origin',
        job.input.baseSha,
        job.input.headSha,
      ],
      { env },
    );
    if (fetch.exitCode !== 0 || fetch.timedOut) return false;
    const checkout = await runTracked(
      job,
      'git',
      [
        '-C',
        checkoutPath,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'submodule.recurse=false',
        'checkout',
        '--quiet',
        '--detach',
        job.input.headSha,
      ],
      { env },
    );
    if (checkout.exitCode !== 0 || checkout.timedOut) return false;
    const commits = await runTracked(
      job,
      'git',
      ['-C', checkoutPath, 'rev-parse', `${job.input.baseSha}^{commit}`, 'HEAD^{commit}'],
      { captureStdout: true, maxBytes: 4 * 1024, env },
    );
    if (commits.exitCode !== 0 || commits.timedOut) return false;
    const reported = commits.stdout.trim().split(/\s+/);
    if (
      reported.length !== 2 ||
      reported[0] !== job.input.baseSha ||
      reported[1] !== job.input.headSha
    ) {
      return false;
    }
    const removeRemote = await runTracked(
      job,
      'git',
      ['-C', checkoutPath, 'remote', 'remove', 'origin'],
      { env },
    );
    if (removeRemote.exitCode !== 0) return false;
    const removeAskpass = await runTracked(
      job,
      'git',
      ['-C', checkoutPath, 'config', '--local', '--unset-all', 'credential.helper'],
      { env },
    );
    if (removeAskpass.exitCode !== 0 && removeAskpass.exitCode !== 5) return false;
    const removeHook = await runTracked(
      job,
      'git',
      ['-C', checkoutPath, 'config', '--local', '--unset-all', 'core.askPass'],
      { env },
    );
    if (removeHook.exitCode !== 0 && removeHook.exitCode !== 5) return false;
    job.input.checkoutToken = '';
    await rm(askpassPath, { force: true });
    return true;
  };

  const cleanup = async (job: RunnerJob) => {
    let clean = true;
    if (!job.sandboxAttempted) {
      if (job.checkoutRoot !== undefined) {
        try {
          await rm(job.checkoutRoot, { recursive: true, force: true });
        } catch {
          clean = false;
        }
      }
      if (job.configRoot !== undefined) {
        try {
          await rm(job.configRoot, { recursive: true, force: true });
        } catch {
          clean = false;
        }
      }
      update(job, { sandbox: { cleanup: clean ? 'destroyed' : 'failed' } });
      return clean;
    }
    update(job, { stage: 'cleanup' });
    const cleanupProcess = async (args: readonly string[]) => {
      try {
        return await executeProcess(sbxPath, args, { timeoutMs: CLEANUP_COMMAND_TIMEOUT_MS });
      } catch {
        return undefined;
      }
    };
    const removed = await cleanupProcess(['rm', '--force', job.sandboxName]);
    if (removed === undefined || removed.exitCode !== 0 || removed.timedOut) clean = false;
    if (job.secretPlaceholder !== undefined) {
      const secret = await cleanupProcess([
        'secret',
        'rm',
        '--placeholder',
        job.secretPlaceholder,
        '--sandbox',
        job.sandboxName,
        '--force',
      ]);
      if (secret === undefined || secret.exitCode !== 0 || secret.timedOut) clean = false;
    }
    const policy = await cleanupProcess([
      'policy',
      'rm',
      'network',
      '--sandbox',
      job.sandboxName,
      '--resource',
      MODEL_RESOURCE,
    ]);
    if (policy === undefined || (policy.exitCode !== 0 && policy.exitCode !== 1)) clean = false;
    if (policy?.timedOut) clean = false;
    if (job.checkoutRoot !== undefined) {
      try {
        await rm(job.checkoutRoot, { recursive: true, force: true });
      } catch {
        clean = false;
      }
    }
    if (job.configRoot !== undefined) {
      try {
        await rm(job.configRoot, { recursive: true, force: true });
      } catch {
        clean = false;
      }
    }
    update(job, { sandbox: { cleanup: clean ? 'destroyed' : 'failed' } });
    return clean;
  };

  const execute = async (job: RunnerJob) => {
    let failure: RunnerJobState['failure'];
    let result: RunnerJobState['result'];
    try {
      if (modelSecretCommand === undefined || modelSecretCommand.length === 0) {
        failure = { reason: 'agent' };
        return;
      }
      update(job, { status: 'running', stage: 'checkout' });
      const checkoutRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-review-'));
      job.checkoutRoot = checkoutRoot;
      if (!(await prepareCheckout(job, checkoutRoot))) {
        failure = { reason: 'checkout' };
        return;
      }
      job.input.checkoutToken = '';
      if (job.abortRequested) return;

      const configRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-opencode-config-'));
      job.configRoot = configRoot;
      await mkdir(join(configRoot, 'opencode', 'skills', 'pr-review'), { recursive: true });
      await writeFile(
        join(configRoot, 'opencode', 'skills', 'pr-review', 'SKILL.md'),
        prReviewSkill,
        'utf8',
      );

      const placeholder = `cr-${job.id}`;
      job.secretPlaceholder = placeholder;
      job.sandboxAttempted = true;
      const secret = await runTracked(job, sbxPath, [
        'secret',
        'set-custom',
        '--sandbox',
        job.sandboxName,
        '--host',
        MODEL_HOST,
        '--env',
        MODEL_ENV,
        '--placeholder',
        placeholder,
        '--command',
        modelSecretCommand,
      ]);
      if (secret.exitCode !== 0 || secret.timedOut) {
        failure = { reason: 'agent' };
        return;
      }
      const create = await runTracked(job, sbxPath, [
        'create',
        '--clone',
        '--no-share-skills',
        '--name',
        job.sandboxName,
        '--cpus',
        '4',
        '--memory',
        '8g',
        '--env',
        `OPENCODE_CONFIG_CONTENT=${trustedOpenCodeConfig}`,
        '--env',
        'OPENCODE_DISABLE_PROJECT_CONFIG=1',
        '--env',
        `XDG_CONFIG_HOME=${configRoot}`,
        'opencode',
        join(checkoutRoot, 'checkout'),
        configRoot,
      ]);
      if (create.exitCode !== 0 || create.timedOut) {
        failure = { reason: 'agent' };
        return;
      }
      if (job.abortRequested) return;
      const network = await runTracked(job, sbxPath, [
        'policy',
        'allow',
        'network',
        '--sandbox',
        job.sandboxName,
        MODEL_RESOURCE,
      ]);
      if (network.exitCode !== 0 || network.timedOut) {
        failure = { reason: 'agent' };
        return;
      }
      update(job, { stage: 'agent' });
      const agent = await runTracked(
        job,
        sbxPath,
        [
          'exec',
          job.sandboxName,
          'opencode',
          'run',
          '--format',
          'json',
          '--model',
          MODEL,
          '--agent',
          'review',
          reviewPrompt(job.input.baseSha, job.input.headSha),
        ],
        {
          captureStdout: true,
          maxBytes: MAX_AGENT_OUTPUT_BYTES,
          timeoutMs: REVIEW_ATTEMPT_BUDGET_MS,
        },
      );
      if (agent.timedOut) {
        failure = { reason: 'timeout' };
        return;
      }
      if (agent.exitCode !== 0 || agent.truncated) {
        failure = { reason: 'invalid-output' };
        return;
      }
      result = parseResult(agent.stdout);
      if (result === undefined) failure = { reason: 'invalid-output' };
    } catch {
      failure = { reason: 'agent' };
    } finally {
      job.input.checkoutToken = '';
      let cleaned = false;
      try {
        cleaned = await cleanup(job);
      } catch {
        cleaned = false;
      }
      if (!cleaned) failure = { reason: 'cleanup' };
      if (job.abortRequested && cleaned) {
        update(job, { status: 'aborted' });
      } else if (failure !== undefined) {
        update(job, { status: 'failed', failure });
      } else {
        update(job, { status: 'succeeded', result });
      }
      job.resolveDone();
    }
  };

  const publicState = (job: RunnerJob) => ({ ...job.state });

  const handle = async (request: Request): Promise<Response> => {
    if (!authorized(request, authToken)) return jsonResponse(401, { error: 'unauthorized' });
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/jobs') {
      if (modelSecretCommand === undefined || modelSecretCommand.length === 0) {
        return jsonResponse(503, { error: 'runner unavailable' });
      }
      const input = await Schema.decodeUnknownPromise(RunnerJobInput)(
        await readJson(request),
      ).catch(() => undefined);
      if (input === undefined) return jsonResponse(400, { error: 'invalid job' });
      const existing = jobsByRun.get(`${input.runId}:${input.attempt}`);
      if (existing !== undefined) return jsonResponse(202, publicState(existing));
      let resolveDone = () => {};
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const id = randomUUID();
      const job: RunnerJob = {
        state: {
          id,
          runId: input.runId,
          attempt: input.attempt,
          status: 'queued',
          stage: 'admission',
          sandbox: { cleanup: 'pending' },
        },
        input: { ...input },
        id,
        sandboxName: `compte-rendu-${id}`,
        done,
        resolveDone,
        abortRequested: false,
        sandboxAttempted: false,
        deadlineAt: Date.now() + REVIEW_ATTEMPT_BUDGET_MS,
      };
      jobs.set(id, job);
      jobsByRun.set(`${input.runId}:${input.attempt}`, job);
      void execute(job);
      return jsonResponse(202, publicState(job));
    }
    const match = /^\/jobs\/([^/]+)$/.exec(path);
    if (match === null) return jsonResponse(404, { error: 'not found' });
    const job = jobs.get(match[1]);
    if (job === undefined) return jsonResponse(404, { error: 'not found' });
    if (request.method === 'GET') return jsonResponse(200, publicState(job));
    if (request.method === 'DELETE') {
      if (job.state.status === 'queued' || job.state.status === 'running') {
        job.abortRequested = true;
        const child = job.child;
        if (child !== undefined) {
          stop(child);
          setTimeout(() => stop(child, 'SIGKILL'), 5_000);
        }
        await job.done;
      }
      return jsonResponse(200, publicState(job));
    }
    return jsonResponse(404, { error: 'not found' });
  };

  return { handle };
};

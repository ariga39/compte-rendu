import type { RunnerJobResponse, StructuredReviewResult } from '@compte-rendu/contracts';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from './execution-commands.js';
import {
  deadlineFailure,
  remainingExecutionMs,
  updateJobState,
  type ExecutionJob,
} from './execution-job.js';
import { currentEpochMillis, currentIso } from './runner-clock.js';
import type { SandboxBackend, SandboxExecPort } from './sandbox-runtime.js';
import { SandboxCreateError } from './sandbox-runtime.js';
import {
  MAX_AGENT_OUTPUT_BYTES,
  mergedAgentResult,
  parseResult,
  shellPermissionRules,
  uniqueSessionIdFrom,
  type RunnerFailureCauseValue,
} from './opencode-config.js';
import {
  SUPERVISOR_AGENT_ID,
  decodeSessionExport,
  extractReviewSubmission,
  multiReviewConfig,
  participants,
  routeModelIdentity,
  sessionSucceeded,
  type SessionIdentity,
} from './opencode-multi-review.js';
import { reviewCorrectionPrompt, reviewPrompt, reviewerSystemPrompt } from './review-prompt.js';
import { reviewSkills } from './review-skill.js';

const SUBMIT_REMINDER_BUDGET_MS = 2 * 60 * 1000;

type JobFailure = NonNullable<RunnerJobResponse['failure']>;

export interface AgentRunDependencies {
  readonly backend: SandboxBackend;
  readonly commands: CommandRunner;
  readonly evidencePath: string;
  readonly mergeBaseSha: string;
  readonly modelId?: string | undefined;
  readonly openCodeConfig?: string | undefined;
  readonly serviceBaseUrl?: URL | undefined;
  readonly modelResource: string;
}

export interface AgentStageResult {
  readonly failure?: JobFailure;
  readonly executionCause?: RunnerFailureCauseValue;
}

/**
 * Stages the isolated OpenCode configuration and sandbox, runs the GitHub
 * preflight, then executes the review agent and its one bounded same-session
 * correction. Observations are written to the execution record as they happen
 * so a throw still leaves partial context for archival and attribution.
 */
export const runAgentStage = async (
  job: ExecutionJob,
  {
    backend: sandboxBackend,
    commands,
    evidencePath,
    mergeBaseSha,
    modelId,
    openCodeConfig,
    serviceBaseUrl,
    modelResource,
  }: AgentRunDependencies,
): Promise<AgentStageResult> => {
  const descriptors = job.descriptors;
  const multiConfiguration = job.input.reviewConfiguration;
  const multiSelection = multiConfiguration?.selection ?? undefined;
  const multi = multiSelection !== undefined;
  const directExecution = multiSelection !== undefined && multiSelection.reviewers.length === 1;
  let executionCause: RunnerFailureCauseValue | undefined;

  const promptReviewers = multi
    ? participants(multiSelection).map(({ participant, route }) => ({
        participant,
        model: routeModelIdentity(route, descriptors).reference,
      }))
    : modelId === undefined
      ? []
      : [{ participant: 'reviewer-0', model: modelId }];
  const promptInput = {
    repositoryName: job.input.repositoryName,
    pullRequestNumber: job.input.pullRequestNumber,
    baseSha: job.input.baseSha,
    mergeBaseSha,
    headSha: job.input.headSha,
    reviewers: promptReviewers,
  };
  const agentPrompt = reviewPrompt(promptInput);
  const configRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-opencode-config-'));
  job.configRoot = configRoot;
  for (const skill of reviewSkills) {
    const directory = join(configRoot, 'opencode', 'skills', skill.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), skill.body);
    await writeFile(join(directory, 'LICENSE.md'), skill.license);
    await writeFile(join(directory, 'NOTICE.md'), skill.notice);
  }
  const activeOpenCodeConfig = multi
    ? multiReviewConfig({
        selection: multiSelection,
        descriptors,
        serviceBaseUrl: serviceBaseUrl!.toString(),
        shellPermissionRules,
        reviewerTask: reviewerSystemPrompt(promptInput),
      })
    : openCodeConfig;

  const sandbox = sandboxBackend.createJob({
    id: job.id,
    name: job.sandboxName,
    cpu: '4',
    memoryGib: 8,
    env: [`OPENCODE_CONFIG_CONTENT=${activeOpenCodeConfig!}`, 'OPENCODE_DISABLE_PROJECT_CONFIG=1'],
    hostScratchRoot: job.checkoutRoot!,
    checkoutRoot: join(job.checkoutRoot!, 'checkout'),
    configRoot,
    modelResource,
    ...(job.grantTokenPath === undefined ? {} : { modelTokenFile: job.grantTokenPath }),
    githubResource: 'api.github.com:443',
    githubReadToken: job.input.repositoryReadToken,
  });
  job.sandbox = sandbox;
  job.sandboxAttempted = true;
  job.progress?.stage('sandbox');
  const setupPort: SandboxExecPort = {
    run: (program, args, processOptions, diagnostic) =>
      commands.runTracked(job, program, args, processOptions, diagnostic),
  };
  try {
    await sandbox.setup(setupPort);
  } catch (error) {
    job.sandboxCreated = sandbox.metadata.created;
    if (error instanceof SandboxCreateError && error.timedOut && remainingExecutionMs(job) <= 0) {
      // The create consumed the job's limiting clock rather than only its
      // ordinary per-command timeout. Report the actual exhausted deadline.
      return { failure: deadlineFailure(job) };
    }
    executionCause =
      error instanceof SandboxCreateError
        ? error.timedOut
          ? 'timeout'
          : 'process-exit'
        : undefined;
    return {
      failure: {
        reason: 'agent',
        ...(executionCause === undefined ? {} : { cause: executionCause }),
      },
      executionCause,
    };
  }
  job.sandboxCreated = sandbox.metadata.created;
  if (job.abortRequested) {
    return { executionCause };
  }
  const githubPreflight = await sandbox.exec(
    ['gh', 'api', '--silent', 'installation/repositories'],
    setupPort,
    {},
    { stage: 'sandbox', command: 'github-preflight' },
  );
  await job.readToken?.ensureFresh();
  if (job.deadlineAt <= Date.now()) {
    return { failure: deadlineFailure(job) };
  }
  if (githubPreflight.exitCode !== 0 || githubPreflight.timedOut) {
    return { failure: { reason: 'agent' } };
  }
  const agentRemaining = remainingExecutionMs(job);
  if (agentRemaining <= 0) {
    return { failure: deadlineFailure(job) };
  }

  updateJobState(job, { stage: 'agent' });
  job.progress?.stage('agent');
  const agentRoute = multi
    ? directExecution
      ? multiSelection.reviewers[0]!
      : multiSelection.synthesis
    : undefined;
  const agentIdentity =
    agentRoute === undefined ? undefined : routeModelIdentity(agentRoute, descriptors);
  const agentModel = agentIdentity?.reference ?? modelId;
  const agentName = multi && !directExecution ? SUPERVISOR_AGENT_ID : 'review';
  const submissionIdentity: SessionIdentity =
    agentIdentity === undefined
      ? {
          agent: 'review',
          model: (() => {
            const reference = modelId!;
            const slash = reference.indexOf('/');
            return slash === -1
              ? { providerID: 'opencode-go', id: reference }
              : {
                  providerID: reference.slice(0, slash),
                  id: reference.slice(slash + 1),
                };
          })(),
        }
      : {
          agent: agentName,
          model: { providerID: agentIdentity.providerID, id: agentIdentity.id },
        };
  job.submissionIdentity = submissionIdentity;
  job.executionModel = agentModel;
  const agent = await sandbox.exec(
    [
      'opencode',
      'run',
      '--standalone',
      '--format',
      'json',
      '--model',
      agentModel!,
      '--agent',
      agentName,
      agentPrompt,
    ],
    setupPort,
    {
      captureStdout: true,
      captureStderr: true,
      maxBytes: MAX_AGENT_OUTPUT_BYTES,
      timeoutMs: agentRemaining,
      stdoutFilePath: join(evidencePath, 'opencode.jsonl'),
      stderrFilePath: join(evidencePath, 'opencode.stderr'),
    },
  );
  job.agent = agent;
  job.agentEndedAt = Date.now();
  const sessionId = uniqueSessionIdFrom(agent.stdout);
  const initialStdout = parseResult(agent.stdout, sessionId);
  const recoveredProvider = agent.exitCode === 1 && (initialStdout.recoveredErrors ?? 0) > 0;
  if (
    !job.abortRequested &&
    (agent.exitCode === 0 || recoveredProvider) &&
    !agent.timedOut &&
    !agent.truncated &&
    agent.streamError !== true &&
    initialStdout.cause === undefined &&
    initialStdout.upstream === undefined
  ) {
    // A normal exit with no valid final result is only eligible for the one
    // correction when the exact session reached an authoritative normal
    // completion. A length/content-filter/error finish, a non-succeeded
    // outcome, or an ambiguous session identity must not resume a truncated
    // session.
    let normalCompletion = false;
    let needsCorrection = false;
    const precheckRemaining = job.deadlineAt - currentEpochMillis();
    if (sessionId !== undefined && precheckRemaining > 0) {
      const exported = await sandbox.exec(
        ['opencode', 'session', 'export', '--standalone', sessionId],
        setupPort,
        {
          captureStdout: true,
          maxBytes: MAX_AGENT_OUTPUT_BYTES,
          timeoutMs: Math.min(precheckRemaining, SUBMIT_REMINDER_BUDGET_MS),
        },
      );
      if (exported.exitCode === 0 && !exported.timedOut && exported.truncated !== true) {
        try {
          const value: unknown = JSON.parse(exported.stdout);
          normalCompletion = sessionSucceeded(value, sessionId);
          if (normalCompletion)
            needsCorrection =
              extractReviewSubmission(value, submissionIdentity).value === undefined;
        } catch {
          normalCompletion = false;
          needsCorrection = false;
        }
      }
    }
    // Recompute after the export: it consumes shared deadline time.
    const remaining = job.deadlineAt - currentEpochMillis();
    if (
      !job.abortRequested &&
      sessionId !== undefined &&
      remaining > 0 &&
      normalCompletion &&
      needsCorrection
    ) {
      job.agentEndedAt = undefined;
      const reminder = await sandbox.exec(
        [
          'opencode',
          'run',
          '--standalone',
          '--session',
          sessionId,
          '--format',
          'json',
          '--model',
          agentModel!,
          '--agent',
          agentName,
          reviewCorrectionPrompt,
        ],
        setupPort,
        {
          captureStdout: true,
          captureStderr: true,
          maxBytes: MAX_AGENT_OUTPUT_BYTES,
          timeoutMs: Math.min(SUBMIT_REMINDER_BUDGET_MS, remaining),
          stdoutFilePath: join(evidencePath, 'opencode.jsonl'),
          stderrFilePath: join(evidencePath, 'opencode.stderr'),
          fileAppend: true,
        },
      );
      job.agentEndedAt = Date.now();
      const reminderParsed = parseResult(reminder.stdout, sessionId);
      const reminderRecovered = (reminderParsed.recoveredErrors ?? 0) > 0;
      const recoveredErrors =
        (initialStdout.recoveredErrors ?? 0) + (reminderParsed.recoveredErrors ?? 0);
      job.agentParsed =
        reminderParsed.cause !== undefined || reminderParsed.upstream !== undefined
          ? reminderParsed
          : reminder.exitCode !== 0 && !reminderRecovered
            ? { cause: 'process-exit' }
            : uniqueSessionIdFrom(reminder.stdout) === sessionId
              ? recoveredErrors === 0
                ? reminderParsed
                : { ...reminderParsed, recoveredErrors }
              : { cause: 'zero-results' };
      job.correctionTimeout = reminder.timedOut && remaining > SUBMIT_REMINDER_BUDGET_MS;
      job.agent = mergedAgentResult(agent, reminder);
    }
  }
  return { executionCause };
};

export interface ReviewResolutionInput {
  readonly evidencePath: string;
  readonly evidenceReady: boolean;
  readonly evidenceComplete: boolean;
  readonly evidenceFailure: string | undefined;
  readonly sessionTerminal: boolean;
  readonly failure: JobFailure | undefined;
  readonly executionCause: RunnerFailureCauseValue | undefined;
}

export interface ReviewResolution {
  readonly failure: JobFailure | undefined;
  readonly executionCause: RunnerFailureCauseValue | undefined;
  readonly result: StructuredReviewResult | undefined;
  readonly evidenceComplete: boolean;
  readonly evidenceFailure: string | undefined;
}

/**
 * Extracts a validated review from the archived session evidence, including
 * the single-model and multi-model completion paths and their failure causes.
 */
export const resolveReviewResult = async (
  job: ExecutionJob,
  input: ReviewResolutionInput,
): Promise<ReviewResolution> => {
  const { evidencePath, evidenceReady, sessionTerminal } = input;
  const agent = job.agent;
  const agentParsed = job.agentParsed;
  const correctionTimeout = job.correctionTimeout;
  const submissionIdentity = job.submissionIdentity;
  const descriptors = job.descriptors;
  let failure = input.failure;
  let executionCause = input.executionCause;
  let evidenceComplete = input.evidenceComplete;
  let evidenceFailure = input.evidenceFailure;
  let result: StructuredReviewResult | undefined;
  const multiConfiguration = job.input.reviewConfiguration;
  const multiSelection = multiConfiguration?.selection ?? undefined;
  const multi = multiSelection !== undefined;
  const submissionSessionId = agent === undefined ? undefined : uniqueSessionIdFrom(agent.stdout);

  const validateMultiReview = async (): Promise<
    { readonly result: StructuredReviewResult } | { readonly cause: RunnerFailureCauseValue }
  > => {
    if (multiSelection === undefined) return { cause: 'result-schema-failure' };
    const rootSessionId = job.sessionIds[0];
    if (rootSessionId === undefined) return { cause: 'result-schema-failure' };
    const readExport = async (sessionId: string): Promise<unknown> => {
      try {
        return JSON.parse(
          await readFile(join(evidencePath, `opencode-export-${sessionId}.json`), 'utf8'),
        ) as unknown;
      } catch {
        return undefined;
      }
    };
    const root = await readExport(rootSessionId);
    if (root === undefined || !sessionSucceeded(root, rootSessionId)) {
      return { cause: 'missing-terminal-message' };
    }
    const rootIdentity = submissionIdentity;
    if (rootIdentity === undefined) return { cause: 'result-schema-failure' };
    const rootInfo = decodeSessionExport(root)?.info;
    if (
      rootInfo === undefined ||
      rootInfo.agent !== rootIdentity.agent ||
      rootInfo.model?.providerID !== rootIdentity.model.providerID ||
      rootInfo.model.id !== rootIdentity.model.id
    ) {
      return { cause: 'result-schema-failure' };
    }
    const synthesis = extractReviewSubmission(root, rootIdentity);
    if (synthesis.cause !== undefined) return { cause: synthesis.cause };
    const synthesisValue = synthesis.value;
    if (synthesisValue === undefined) return { cause: 'result-schema-failure' };

    // Child sessions are kept as provenance only. A reviewer that did not
    // submit, used a different completion path, or was retried never turns a
    // valid supervisor result into a failure.
    const reviewers: Array<{
      participant: string;
      route: string;
      sessionId: string;
      model: string;
    }> = [];
    for (const sessionId of job.sessionIds.slice(1)) {
      const info = decodeSessionExport(await readExport(sessionId))?.info;
      if (info === undefined || info.parentID !== rootSessionId) continue;
      const model = info.model;
      const route =
        model === undefined
          ? ''
          : (multiSelection.reviewers.find((candidate) => {
              const identity = routeModelIdentity(candidate, descriptors);
              return identity.providerID === model.providerID && identity.id === model.id;
            }) ?? model.id);
      reviewers.push({
        participant: info.agent ?? '',
        route,
        sessionId,
        model: model === undefined ? '' : `${model.providerID}/${model.id}`,
      });
    }
    job.multiReview = {
      revision: multiConfiguration!.revision,
      selection: multiSelection,
      rootSessionId,
      reviewers,
      synthesis: synthesisValue,
    };
    return {
      result: {
        version: 2,
        decision: synthesisValue.decision,
        markdown: synthesisValue.markdown,
      },
    };
  };

  if (agent !== undefined && failure === undefined) {
    job.submissionCompletedAt = currentIso();
    const parsed = agentParsed ?? parseResult(agent.stdout, submissionSessionId);
    const recoveredProvider =
      agent.exitCode === 1 &&
      parsed.cause === undefined &&
      (parsed.recoveredErrors ?? 0) > 0 &&
      !agent.timedOut &&
      !agent.truncated &&
      agent.streamError !== true &&
      evidenceComplete &&
      sessionTerminal &&
      submissionSessionId !== undefined;
    if (agent.timedOut) {
      executionCause = 'timeout';
      failure = {
        reason: 'timeout',
        cause: executionCause,
        ...(correctionTimeout ? {} : { deadline: job.deadlineLimit }),
      };
    } else if (parsed.cause !== undefined) {
      executionCause = parsed.cause;
      failure = { reason: 'invalid-output', cause: executionCause };
    } else if (parsed.upstream !== undefined) {
      executionCause = 'upstream-error';
      failure = {
        reason: 'upstream',
        cause: executionCause,
        ...(parsed.upstream.httpStatus === undefined
          ? {}
          : { httpStatus: parsed.upstream.httpStatus }),
      };
    } else if (agent.exitCode !== 0 && !recoveredProvider) {
      executionCause = 'process-exit';
      failure = { reason: 'invalid-output', cause: executionCause };
    } else if (agent.truncated) {
      executionCause = 'output-truncated';
      failure = { reason: 'invalid-output', cause: executionCause };
    } else if (multi) {
      const validated = await validateMultiReview();
      if ('cause' in validated) {
        executionCause = validated.cause;
        failure = { reason: 'invalid-output', cause: executionCause };
      } else {
        result = validated.result;
      }
    } else if (submissionSessionId === undefined) {
      failure = { reason: 'invalid-output' };
    } else if (!sessionTerminal) {
      executionCause = 'missing-terminal-message';
      failure = { reason: 'invalid-output', cause: executionCause };
    } else {
      let exported: unknown;
      try {
        exported = JSON.parse(
          await readFile(join(evidencePath, `opencode-export-${submissionSessionId}.json`), 'utf8'),
        ) as unknown;
      } catch {
        exported = undefined;
      }
      const submission =
        exported === undefined ? undefined : extractReviewSubmission(exported, submissionIdentity);
      if (submission?.value === undefined) {
        executionCause = submission?.cause ?? 'missing-terminal-message';
        failure = { reason: 'invalid-output', cause: executionCause };
      } else {
        result = {
          version: 2,
          decision: submission.value.decision,
          markdown: submission.value.markdown,
        };
      }
    }
    if (result !== undefined && evidenceReady) {
      try {
        await writeFile(join(evidencePath, 'validated-review.md'), result.markdown, {
          mode: 0o600,
        });
      } catch {
        evidenceComplete = false;
        evidenceFailure = 'archive-incomplete';
      }
    }
  }
  return { failure, executionCause, result, evidenceComplete, evidenceFailure };
};

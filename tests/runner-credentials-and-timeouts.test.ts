import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  RunnerProcessResult,
  completedWithoutSubmitJsonl,
  createRunner,
  finalMarkdownJsonl,
  readTextTree,
  runAgentScenario,
  runProcess,
  runReminderScenario,
  runnerJobFields,
  sharedEvidenceRoot,
  structuredResult,
  triggerAgentRefresh,
  waitForTerminal,
  writeEvidenceFixture,
} from './support/runner-harness';

describe('Runner Job HTTP interface', () => {
  it('rejects a valid result when a job credential appears only on stderr', async () => {
    const credential = 'stderr-only-job-credential';
    const resultLine = finalMarkdownJsonl();
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-282-stderr-credential',
      output: resultLine,
      repositoryReadToken: credential,
      agentProcess: (options) =>
        runProcess(
          'sh',
          ['-c', `printf '%s\\n' '${resultLine}'; printf 'warning ${credential}\\n' >&2`],
          {
            ...options,
            stderrRedactions: [...(options.stderrRedactions ?? []), credential],
          },
        ),
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'evidence' },
      evidence: { status: 'incomplete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(terminal).not.toHaveProperty('result');
    expect(manifest).toMatchObject({
      evidence: { status: 'incomplete' },
      evidenceFailure: 'credential-in-output',
      terminal: { status: 'failed', reason: 'evidence' },
    });
    const archive = join(sharedEvidenceRoot, terminal.evidenceId as string);
    const stderrEvidence = await readFile(join(archive, 'opencode.stderr'), 'utf8');
    expect(stderrEvidence).toBe('warning [redacted]\n');
    expect(stderrEvidence).not.toContain(credential);
  });
  it('scrubs an additional process credential from the final archived output', async () => {
    const credential = 'synthetic-additional-process-credential';
    const leak = JSON.stringify({
      type: 'text',
      sessionID: 'scenario-session',
      part: { type: 'text', messageID: 'msg-leak', text: `leak ${credential}` },
    });
    const resultLine = finalMarkdownJsonl();
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-312-additional-credential',
      output: `${leak}\n${resultLine}`,
      agentProcess: (options) =>
        runProcess('sh', ['-c', `printf '%s\\n' '${leak}' '${resultLine}'`], options),
      sandboxBackend: {
        kind: 'sbx',
        health: () => 'ready',
        checkReady: async () => 'ready',
        reconcileOrphans: async () => ({
          ok: true,
          recovered: 0,
          recoveredJobIds: [],
          failures: [],
        }),
        createJob: (spec) => ({
          metadata: {
            created: true,
            hostCleanupConfirmed: true,
            id: spec.name,
            name: spec.name,
            runtime: 'sbx',
            imageRef: 'review-image',
            evidenceRoot: '/tmp/evidence',
          },
          setup: async () => {},
          exec: (args, exec, processOptions, diagnostic) =>
            exec.run(
              'sbx',
              ['exec', spec.name, ...args],
              {
                ...processOptions,
                credentialValues: [...(processOptions?.credentialValues ?? []), credential],
              },
              diagnostic,
            ),
          copyOut: (source, destination, exec, diagnostic, processOptions) =>
            exec.run(
              'sbx',
              ['cp', `${spec.name}:${source}`, destination],
              processOptions,
              diagnostic,
            ),
          destroy: async () => {},
        }),
      },
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'evidence' },
      evidence: { status: 'incomplete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(terminal).not.toHaveProperty('result');
    expect(manifest).toMatchObject({
      evidenceFailure: 'credential-in-output',
      terminal: { status: 'failed', reason: 'evidence' },
    });
    const archived = await readTextTree(join(sharedEvidenceRoot, terminal.evidenceId as string));
    expect(archived).not.toContain(credential);
    expect(archived).toContain('[redacted]');
  });
  it('rejects a correction that observed a job credential on its scrubbed stream', async () => {
    const reminderMarkdown = '## Review:\n\nCorrection with credential.';
    const result = await runReminderScenario({
      runId: 'run-282-correction-credential',
      rounds: [
        { output: completedWithoutSubmitJsonl('session-reminder'), finalText: null },
        {
          output: finalMarkdownJsonl(reminderMarkdown, 'session-reminder'),
          finalText: JSON.stringify({ decision: 'comment', markdown: reminderMarkdown }),
          credentialObserved: true,
        },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'evidence' },
      evidence: { status: 'incomplete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(result.terminal).not.toHaveProperty('result');
    expect(result.manifest).toMatchObject({
      evidence: { status: 'incomplete' },
      evidenceFailure: 'credential-in-output',
      terminal: { status: 'failed', reason: 'evidence' },
    });
  });
  it('does not remind when the Job is aborted after a zero-results run', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    let agentStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    let releaseAgent!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    let agentRuns = 0;
    const zeroResults = completedWithoutSubmitJsonl('session-reminder');
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      process: async (_command, args, options = {}) => {
        const isAgent = args[0] === 'exec' && args.includes('--agent');
        if (isAgent) {
          agentRuns += 1;
          agentStarted();
          await gate;
          await writeEvidenceFixture(args, options, zeroResults);
          return {
            exitCode: 0,
            stdout: `${zeroResults}\n`,
            timedOut: false,
            truncated: false,
          };
        }
        await writeEvidenceFixture(args, options, '');
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"session-reminder"}]\n'
              : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-reminder-abort',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;
    await started;
    const aborted = runner.handle(
      new Request(`http://runner/jobs/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );
    releaseAgent();
    expect((await aborted).status).toBe(200);
    expect(agentRuns).toBe(1);
    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({ status: 'aborted' });
  });
  it('does not attribute the shorter correction timeout to the review deadline', async () => {
    const result = await runReminderScenario({
      runId: 'short-correction-timeout',
      rounds: [
        { output: completedWithoutSubmitJsonl('session-reminder'), finalText: null },
        { output: '', timedOut: true },
      ],
    });
    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({ failure: { reason: 'timeout' } });
    expect(result.terminal).not.toHaveProperty('failure.deadline');
    expect(result.manifest.execution).not.toHaveProperty('deadline');
  });
  it('keeps reviewing past 60 minutes and times out at the 90-minute claim deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-09-12T00:00:00.000Z');
    const claimDeadlineAt = start + 90 * 60 * 1000;
    const markdown = '## Review:\n\nLong review.';
    try {
      vi.setSystemTime(start);
      const continued = await runReminderScenario({
        runId: 'run-review-past-sixty-minutes',
        claimDeadlineAt,
        rounds: [
          {
            output: finalMarkdownJsonl(markdown, 'session-reminder'),
            finalText: JSON.stringify({ decision: 'comment', markdown }),
            advanceMs: 61 * 60 * 1000,
          },
        ],
      });
      expect(continued.agentTimeouts[0]).toBe(90 * 60 * 1000);
      expect(continued.terminal).toMatchObject({
        status: 'succeeded',
        result: structuredResult(markdown),
      });

      vi.setSystemTime(start);
      const timedOut = await runReminderScenario({
        runId: 'run-review-ninety-minute-timeout',
        claimDeadlineAt,
        rounds: [
          {
            output: finalMarkdownJsonl(markdown, 'session-reminder'),
            finalText: JSON.stringify({ decision: 'comment', markdown }),
            timedOut: true,
            advanceMs: 90 * 60 * 1000 + 1,
          },
        ],
      });
      expect(timedOut.agentTimeouts[0]).toBe(90 * 60 * 1000);
      expect(timedOut.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'timeout', deadline: 'claim' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(timedOut.manifest.execution).toMatchObject({
        status: 'failed',
        reason: 'timeout',
        deadline: 'claim',
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('counts setup against the claim deadline instead of resetting the agent clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-09-12T00:00:00.000Z');
    const markdown = '## Review:\n\nSetup counted.';
    try {
      vi.setSystemTime(start);
      const result = await runReminderScenario({
        runId: 'run-setup-consumes-claim-budget',
        claimDeadlineAt: start + 60 * 60 * 1000,
        advanceOnCheckoutMs: 31 * 60 * 1000,
        rounds: [
          {
            output: finalMarkdownJsonl(markdown, 'session-reminder'),
            finalText: JSON.stringify({ decision: 'comment', markdown }),
          },
        ],
      });

      expect(result.agentTimeouts[0]).toBe(29 * 60 * 1000);
      expect(result.terminal).toMatchObject({
        status: 'succeeded',
        result: structuredResult(markdown),
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('attributes checkout timeout to the exhausted claim deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const result = await runReminderScenario({
        runId: 'run-checkout-reaches-deadline',
        claimDeadlineAt: Date.now() + 5000,
        advanceOnCheckoutMs: 5000,
        checkoutTimedOut: true,
        rounds: [],
      });
      expect(result.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'timeout', deadline: 'claim' },
        sandbox: { cleanup: 'destroyed' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('attributes a create timeout at the exhausted claim clock to the claim deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-09-12T00:00:00.000Z');
    try {
      vi.setSystemTime(start);
      const result = await runReminderScenario({
        runId: 'run-create-reaches-claim-deadline',
        claimDeadlineAt: start + 5 * 60 * 1000,
        advanceOnCreateMs: 5 * 60 * 1000,
        createTimedOut: true,
        rounds: [],
      });

      expect(result.createCommands).toHaveLength(1);
      expect(result.agentRuns).toBe(0);
      expect(result.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'timeout', deadline: 'claim' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(result.manifest.terminal).toMatchObject({
        reason: 'timeout',
        deadline: 'claim',
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('attributes a create timeout at the fallback credential margin to the credential clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-09-12T00:00:00.000Z');
    try {
      vi.setSystemTime(start);
      const result = await runReminderScenario({
        runId: 'run-create-reaches-credential-deadline',
        claimDeadlineAt: start + 90 * 60 * 1000,
        repositoryReadTokenExpiresAt: start + 20 * 60 * 1000,
        advanceOnCheckoutMs: 18 * 60 * 1000,
        advanceOnCreateMs: 60 * 1000,
        createTimedOut: true,
        readTokenFetch: async () => new Response(null, { status: 503 }),
        rounds: [],
      });

      expect(result.createCommands).toHaveLength(1);
      expect(result.agentRuns).toBe(0);
      expect(result.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'timeout', deadline: 'credential' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(result.manifest.terminal).toMatchObject({
        reason: 'timeout',
        deadline: 'credential',
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('caps execution at the GitHub read-token expiry minus the safety margin', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-09-12T00:00:00.000Z');
    const markdown = '## Review:\n\nCredential bounded.';
    try {
      vi.setSystemTime(start);
      const result = await runReminderScenario({
        runId: 'run-read-token-deadline',
        claimDeadlineAt: start + 60 * 60 * 1000,
        repositoryReadTokenExpiresAt: start + 20 * 60 * 1000,
        advanceOnCheckoutMs: 18 * 60 * 1000,
        rounds: [
          {
            output: finalMarkdownJsonl(markdown, 'session-reminder'),
            finalText: JSON.stringify({ decision: 'comment', markdown }),
          },
        ],
      });

      expect(result.agentTimeouts[0]).toBe(60 * 1000);
      expect(result.terminal).toMatchObject({
        status: 'succeeded',
        result: structuredResult(markdown),
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('reports an expired GitHub read credential and still confirms cleanup', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-09-12T00:00:00.000Z');
    try {
      vi.setSystemTime(start);
      const result = await runReminderScenario({
        runId: 'run-read-token-expired-before-agent',
        claimDeadlineAt: start + 60 * 60 * 1000,
        repositoryReadTokenExpiresAt: start + 20 * 60 * 1000,
        advanceOnCheckoutMs: 20 * 60 * 1000,
        rounds: [
          {
            output: finalMarkdownJsonl('## Review:\n\nMust not run.', 'session-reminder'),
            finalText: JSON.stringify({
              decision: 'comment',
              markdown: '## Review:\n\nMust not run.',
            }),
          },
        ],
      });

      expect(result.createCommands).toHaveLength(0);
      expect(result.agentRuns).toBe(0);
      expect(result.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'timeout', deadline: 'credential' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(result.manifest.terminal).toMatchObject({
        reason: 'timeout',
        deadline: 'credential',
      });
      expect(JSON.stringify(result.terminal)).not.toContain('github-read-token');
    } finally {
      vi.useRealTimers();
    }
  });
  it('rotates the same sandbox credential before its first expiry during a long run', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const start = Date.now();
    const markdown = '## Review:\n\nRotated credential.';
    const requestBodies: Array<Record<string, unknown>> = [];
    try {
      const result = await runReminderScenario({
        runId: 'run-read-token-rotated',
        claimDeadlineAt: start + 90 * 60 * 1000,
        repositoryReadTokenExpiresAt: start + 700,
        expectedRotatedToken: 'rotated-github-read-token',
        duringAgent: triggerAgentRefresh,
        readTokenFetch: async (_input, init) => {
          requestBodies.push(
            typeof init?.body === 'string'
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : {},
          );
          return Response.json({
            token: 'rotated-github-read-token',
            expiresAt: new Date(Date.now() + 100 * 60 * 1000).toISOString(),
          });
        },
        rounds: [
          {
            output: finalMarkdownJsonl(markdown, 'session-reminder'),
            finalText: JSON.stringify({ decision: 'comment', markdown }),
          },
        ],
      });

      expect(result.readTokenRequests).toHaveLength(1);
      expect(result.readTokenRequests[0]).toMatchObject({
        authorization: 'Bearer callback-token',
        body: {
          runId: 'run-read-token-rotated',
          jobId: runnerJobFields.id,
          attempt: 1,
        },
      });
      expect(new URL(result.readTokenRequests[0]!.url).pathname).toBe('/runner-read-token');
      expect(requestBodies).toHaveLength(1);
      expect(result.githubSecretArgs).toContain('--refresh');
      expect(result.githubSecretArgs).toContain('on-demand');
      const githubSecretArgs = result.githubSecretArgs!;
      expect(githubSecretArgs[githubSecretArgs.indexOf('--command') + 1]).toBe(
        `cat ${result.githubTokenPath}`,
      );
      expect(result.githubTokenSnapshots.at(-1)).toBe('rotated-github-read-token');
      expect(result.terminal).toMatchObject({
        status: 'succeeded',
        result: structuredResult(markdown),
      });
      expect(JSON.stringify(result.terminal)).not.toContain('rotated-github-read-token');
      expect(JSON.stringify(result.manifest)).not.toContain('rotated-github-read-token');
    } finally {
      vi.useRealTimers();
    }
  });
  it('retains the rotated read token for cleanup diagnostic redaction', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const start = Date.now();
    const markdown = '## Review:\n\nRotated canary.';
    const canary = 'synthetic-rotated-canary';
    const logEvents: unknown[] = [];
    try {
      const result = await runReminderScenario({
        runId: 'run-read-token-cleanup-redaction',
        claimDeadlineAt: start + 90 * 60 * 1000,
        repositoryReadTokenExpiresAt: start + 700,
        expectedRotatedToken: canary,
        cleanupStderr: `cleanup failed: ${canary}`,
        logEvents,
        duringAgent: triggerAgentRefresh,
        readTokenFetch: async () => {
          return Response.json({
            token: canary,
            expiresAt: new Date(Date.now() + 100 * 60 * 1000).toISOString(),
          });
        },
        rounds: [
          {
            output: finalMarkdownJsonl(markdown, 'session-reminder'),
            finalText: JSON.stringify({ decision: 'comment', markdown }),
          },
        ],
      });

      expect(result.githubTokenSnapshots.at(-1)).toBe(canary);
      expect(result.terminal).toMatchObject({ status: 'succeeded' });
      const cleanupDiagnostics = (logEvents as Array<{ stderr?: string }>).filter(
        (event) => event.stderr !== undefined,
      );
      expect(cleanupDiagnostics.length).toBeGreaterThan(0);
      expect(cleanupDiagnostics.every((event) => event.stderr?.includes('[redacted]'))).toBe(true);
      expect(JSON.stringify(logEvents)).not.toContain(canary);
      expect(JSON.stringify(result.terminal)).not.toContain(canary);
      expect(JSON.stringify(result.manifest)).not.toContain(canary);
    } finally {
      vi.useRealTimers();
    }
  });
  it('falls back to the old credential expiry margin on refresh outage without leaking secrets', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-09-12T00:00:00.000Z');
    const logEvents: unknown[] = [];
    try {
      vi.setSystemTime(start);
      const result = await runReminderScenario({
        runId: 'run-read-token-refresh-outage',
        claimDeadlineAt: start + 90 * 60 * 1000,
        repositoryReadTokenExpiresAt: start + 20 * 60 * 1000,
        advanceOnCheckoutMs: 19 * 60 * 1000,
        readTokenFetch: async () => {
          throw new Error('refresh transport exposed github-read-token');
        },
        logEvents,
        rounds: [],
      });

      expect(result.readTokenRequests).toHaveLength(1);
      expect(result.createCommands).toHaveLength(0);
      expect(result.agentRuns).toBe(0);
      expect(result.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'timeout', deadline: 'credential' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(JSON.stringify(result.terminal)).not.toContain('github-read-token');
      expect(JSON.stringify(result.manifest)).not.toContain('github-read-token');
      expect(JSON.stringify(logEvents)).not.toContain('github-read-token');
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['agent', 'inspection', 'correction'] as const)(
    'applies the credential deadline to agent work when %s crosses the margin',
    async (crossing) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.parse('2026-09-12T00:00:00.000Z');
      const markdown = '## Review:\n\nReview result.';
      try {
        vi.setSystemTime(start);
        const result = await runReminderScenario({
          runId: 'run-read-token-fallback-crossed',
          advanceOnSessionExportMs: crossing === 'inspection' ? 2 * 60 * 1000 : undefined,
          claimDeadlineAt: start + 90 * 60 * 1000,
          repositoryReadTokenExpiresAt: start + 20 * 60 * 1000,
          advanceOnCheckoutMs: 18 * 60 * 1000,
          readTokenFetch: async () => new Response(null, { status: 503 }),
          rounds: [
            ...(crossing === 'correction'
              ? [{ output: completedWithoutSubmitJsonl('session-reminder'), finalText: null }]
              : []),
            {
              output: finalMarkdownJsonl(markdown, 'session-reminder'),
              finalText: JSON.stringify({ decision: 'comment', markdown }),
              advanceMs: crossing === 'inspection' ? 0 : 2 * 60 * 1000,
            },
          ],
        });

        expect(result.agentRuns).toBe(crossing === 'correction' ? 2 : 1);
        if (crossing === 'inspection') {
          expect(result.terminal).toMatchObject({
            status: 'succeeded',
            result: structuredResult(markdown),
          });
          return;
        }
        expect(result.terminal).toMatchObject({
          status: 'failed',
          failure: { reason: 'timeout', deadline: 'credential' },
          sandbox: { cleanup: 'destroyed' },
        });
        expect(result.terminal).not.toHaveProperty('result');
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('ignores a read-token refresh response that arrives after cleanup', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const start = Date.now();
    const markdown = '## Review:\n\nLate refresh ignored.';
    let releaseRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshStarted = false;
    try {
      const result = await runReminderScenario({
        runId: 'run-read-token-cleanup-race',
        claimDeadlineAt: start + 90 * 60 * 1000,
        repositoryReadTokenExpiresAt: start + 700,
        duringAgent: triggerAgentRefresh,
        readTokenFetch: async () => {
          refreshStarted = true;
          return refreshResponse;
        },
        rounds: [
          {
            output: finalMarkdownJsonl(markdown, 'session-reminder'),
            finalText: JSON.stringify({ decision: 'comment', markdown }),
          },
        ],
      });

      expect(refreshStarted).toBe(true);
      expect(result.githubTokenPath).toBeDefined();
      expect(result.terminal).toMatchObject({ status: 'succeeded' });
      releaseRefresh(
        Response.json({
          token: 'github-token-that-must-not-be-written',
          expiresAt: new Date(Date.now() + 100 * 60 * 1000).toISOString(),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(stat(result.githubTokenPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('accepts a legacy claim without a read-token expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-09-12T00:00:00.000Z');
    const markdown = '## Review:\n\nLegacy claim.';
    try {
      vi.setSystemTime(start);
      const withDeadline = await runReminderScenario({
        runId: 'run-legacy-claim-deadline',
        claimDeadlineAt: start + 45 * 60 * 1000,
        rounds: [
          {
            output: finalMarkdownJsonl(markdown, 'session-reminder'),
            finalText: JSON.stringify({ decision: 'comment', markdown }),
          },
        ],
      });
      expect(withDeadline.agentTimeouts[0]).toBe(45 * 60 * 1000);
      expect(withDeadline.terminal).toMatchObject({ status: 'succeeded' });

      vi.setSystemTime(start);
      const withoutDeadline = await runReminderScenario({
        runId: 'run-legacy-claim-without-deadline',
        rounds: [
          {
            output: finalMarkdownJsonl(markdown, 'session-reminder'),
            finalText: JSON.stringify({ decision: 'comment', markdown }),
          },
        ],
      });
      expect(withoutDeadline.agentTimeouts[0]).toBe(90 * 60 * 1000);
      expect(withoutDeadline.terminal).toMatchObject({ status: 'succeeded' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('exposes the per-run GitHub read token only through a scoped GitHub service', async () => {
    const repositoryReadToken = 'github-read-token-must-not-be-an-argument';
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'fixture-session');
    const commands: string[][] = [];
    const events: unknown[] = [];
    let resolvedGithubToken: string | undefined;
    let githubTokenPath: string | undefined;
    let checkoutRoot: string | undefined;
    let cleanupEnvironment: NodeJS.ProcessEnv | undefined;
    let checkoutEnvironment: NodeJS.ProcessEnv | undefined;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
      process: async (_command, args, options = {}) => {
        commands.push([...args]);
        await writeEvidenceFixture(args, options, resultLine);
        if (_command === 'git' && args.includes('clone')) {
          checkoutRoot = args[args.length - 1];
          await mkdir(checkoutRoot, { recursive: true, mode: 0o700 });
        }
        if (args[0] === 'rm' && args[1] === '--force') cleanupEnvironment = options.env;
        if (_command === 'git' && args.includes('clone')) checkoutEnvironment = options.env;
        if (args[0] === 'secret' && args[1] === 'set' && args[2] === 'github') {
          const command = args[args.indexOf('--command') + 1];
          if (command?.startsWith('cat ')) {
            githubTokenPath = command.slice(4);
            resolvedGithubToken = await readFile(command.slice(4), 'utf8');
          }
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"fixture-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const submittedJob = {
      id: 'runner-job-github-read-secret',
      repositoryName: 'acme/reviewed',
      pullRequestNumber: 42,
      runId: 'run-github-read-secret',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
      repositoryReadToken,
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;

    const terminal = await waitForTerminal(runner, id);
    expect(terminal).toMatchObject({
      status: 'succeeded',
      sandbox: { cleanup: 'destroyed' },
    });
    expect(
      commands.some((args) => args[0] === 'policy' && args.includes('api.github.com:443')),
    ).toBe(true);
    expect(resolvedGithubToken).toBe(repositoryReadToken);
    expect(cleanupEnvironment).toBeDefined();
    expect(cleanupEnvironment?.SSH_AUTH_SOCK).toBeUndefined();
    expect(cleanupEnvironment?.SSH_AGENT_PID).toBeUndefined();
    expect(cleanupEnvironment?.GH_TOKEN).toBeUndefined();
    expect(cleanupEnvironment?.GITHUB_TOKEN).toBeUndefined();
    expect(checkoutEnvironment?.CHECKOUT_TOKEN).toBe(repositoryReadToken);
    expect(checkoutEnvironment?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(githubTokenPath).toBeDefined();
    await expect(stat(githubTokenPath!)).rejects.toThrow();
    expect(checkoutRoot).toBeDefined();
    await expect(stat(checkoutRoot!)).rejects.toThrow();
    expect(commands.flat().join(' ')).not.toContain(repositoryReadToken);
    expect(JSON.stringify(events)).not.toContain(repositoryReadToken);
    expect(
      await readTextTree(join(sharedEvidenceRoot, terminal.evidenceId as string)),
    ).not.toContain(repositoryReadToken);
  });
  it('fails closed when GitHub authentication preflight fails before OpenCode invocation', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'No findings' }) },
    });
    let agentInvoked = false;
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        if (args[0] === 'exec' && args.includes('gh')) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'GitHub authentication failed',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'exec' && args.includes('--agent')) agentInvoked = true;
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"fixture-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-github-preflight-failure',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;

    await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'agent' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(agentInvoked).toBe(false);
  });
  it('maps an agent deadline to a failed terminal job after cleanup', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(
          args,
          options,
          '{"type":"text","part":{"type":"text","text":"{\\"findings\\":[],\\"summary\\":\\"timeout\\"}"}}',
        );
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"fixture-session"}]\n'
              : args.includes('export')
                ? ''
                : '',
          timedOut: args[0] === 'exec' && args.includes('--agent'),
          truncated: false,
        };
      },
    });
    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-64-timeout',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
      repositoryReadToken: 'checkout-token-for-test',
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;

    const terminal = await waitForTerminal(runner, id);

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'timeout' },
      sandbox: { cleanup: 'destroyed' },
    });
  });
  it('fails closed when custom secret cleanup returns exit 1', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'fixture-session');
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: args[0] === 'secret' && args[1] === 'rm' ? 1 : 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"fixture-session"}]\n'
              : args.includes('export')
                ? ''
                : options.captureStdout === true
                  ? `${resultLine}\n`
                  : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-64-secret-cleanup-failure',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
      repositoryReadToken: 'checkout-token-for-test',
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;

    const terminal = await waitForTerminal(runner, id);

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
  });
  it('waits for cleanup on DELETE and reports cleanup failure instead of aborted', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const agentJsonl = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'aborted' }) },
    });
    let releaseAgent: (() => void) | undefined;
    let agentStarted!: () => void;
    const agentReady = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec' && args.includes('--agent')) {
          agentStarted();
          await writeEvidenceFixture(args, options, agentJsonl);
          return new Promise<RunnerProcessResult>((resolve) => {
            releaseAgent = () =>
              resolve({ exitCode: 1, stdout: '', timedOut: false, truncated: false });
          });
        }
        if (args[0] === 'exec' && args.includes('session')) {
          if (options.onChild !== undefined) return new Promise<RunnerProcessResult>(() => {});
          return {
            exitCode: 0,
            stdout: '[{"id":"delete-session"}]\n',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'exec' && args.includes('export')) {
          await writeEvidenceFixture(args, options, 'unused');
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'cp') {
          await writeEvidenceFixture(args, options, 'unused');
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'secret' && args[1] === 'rm') {
          return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-64-delete-cleanup',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
      repositoryReadToken: 'checkout-token-for-test',
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;
    await agentReady;

    let deleteFinished = false;
    const deleting = runner
      .handle(
        new Request(`http://runner/jobs/${id}`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer runner-test-token' },
        }),
      )
      .then((response) => {
        deleteFinished = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deleteFinished).toBe(false);
    releaseAgent?.();

    const deleted = await deleting;
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup' },
      sandbox: { cleanup: 'failed' },
    });
  });
  it('returns aborted after DELETE stops the agent when all cleanup succeeds', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const agentJsonl = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'aborted' }) },
    });
    let releaseAgent: (() => void) | undefined;
    let agentStarted!: () => void;
    const agentReady = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      process: async (_command, args, options = {}) => {
        if (args[0] === 'exec' && args.includes('--agent')) {
          agentStarted();
          await writeEvidenceFixture(args, options, agentJsonl);
          return new Promise<RunnerProcessResult>((resolve) => {
            releaseAgent = () =>
              resolve({ exitCode: 1, stdout: '', timedOut: false, truncated: false });
            options.onChild?.({
              stdout: null,
              kill: () => {
                releaseAgent?.();
                return true;
              },
              once: () => {},
            } as never);
          });
        }
        if (args[0] === 'exec' && args.includes('session')) {
          if (options.onChild !== undefined) return new Promise<RunnerProcessResult>(() => {});
          return {
            exitCode: 0,
            stdout: '[{"id":"delete-session"}]\n',
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'exec' && args.includes('export')) {
          await writeEvidenceFixture(args, options, 'unused');
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        if (args[0] === 'cp') {
          await writeEvidenceFixture(args, options, 'unused');
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-64-delete-aborted',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
      repositoryReadToken: 'checkout-token-for-test',
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;
    await agentReady;

    const deleted = await runner.handle(
      new Request(`http://runner/jobs/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer runner-test-token' },
      }),
    );

    expect(deleted.status).toBe(200);
    const deletedState = (await deleted.json()) as { status: string; evidenceId?: string };
    expect(deletedState).toMatchObject({
      status: 'aborted',
      sandbox: { cleanup: 'destroyed' },
    });
    const archive = join(sharedEvidenceRoot, deletedState.evidenceId as string);
    await expect(readFile(join(archive, 'opencode-session-list.json'), 'utf8')).resolves.toContain(
      'delete-session',
    );
    await expect(
      readFile(join(archive, 'opencode-export-delete-session.json'), 'utf8'),
    ).resolves.toContain('delete-session');
    const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      complete: true,
      execution: { status: 'aborted' },
      cleanup: { status: 'destroyed' },
    });
    expect(manifest.terminal).not.toHaveProperty('cause');
  });
});

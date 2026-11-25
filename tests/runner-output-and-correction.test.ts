import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  completedWithoutSubmitJsonl,
  createRunner,
  decisionText,
  defaultReviewMarkdown,
  finalDecisionTextJsonl,
  finalMarkdownJsonl,
  runAgentScenario,
  runReminderScenario,
  runnerJobFields,
  sessionExportJson,
  sharedEvidenceRoot,
  structuredResult,
  waitForTerminal,
  writeEvidenceFixture,
} from './support/runner-harness';

describe('Runner Job HTTP interface', () => {
  type RecoveryScenario = {
    readonly errorSession?: string;
    readonly exportOutcome?: string;
    readonly exportId?: string;
    readonly text?: string | null;
    readonly malformedJsonl?: boolean;
    readonly exitCode?: number;
    readonly timedOut?: boolean;
    readonly truncated?: boolean;
  };
  const recoveryScenarios: readonly (readonly [string, RecoveryScenario])[] = [
    ['a foreign error session', { errorSession: 'another-session' }],
    ['a failed export', { exportOutcome: 'failed' }],
    ['a foreign export session', { exportId: 'foreign-session' }],
    ['a missing final result', { text: null }],
    ['an invalid final result', { text: 'not json' }],
    ['malformed JSONL', { malformedJsonl: true }],
    ['a fatal exit', { exitCode: 137 }],
    ['a timeout', { timedOut: true }],
    ['truncated output', { truncated: true }],
  ];
  it('reports a process-exit cause without exposing agent content', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const resultLine = finalMarkdownJsonl(undefined, 'process-exit-session');
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, resultLine);
        return {
          exitCode: args[0] === 'exec' && args.includes('--agent') ? 7 : 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"process-exit-session"}]\n'
              : args.includes('export')
                ? '{"session":"process-exit-session","full":true}\n'
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
      runId: 'run-90-process-exit',
      attempt: 1,
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha,
      headSha,
    };
    runner.enqueue(submittedJob);
    const id = submittedJob.id;
    const terminal = await waitForTerminal(runner, id);

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'process-exit' },
      evidence: { status: 'complete' },
    });
    const manifest = JSON.parse(
      await readFile(
        join(sharedEvidenceRoot, terminal.evidenceId as string, 'manifest.json'),
        'utf8',
      ),
    );
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'process-exit' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'process-exit' },
    });
    expect(JSON.stringify(terminal)).not.toContain(resultLine);
  });
  it('reports a timeout cause while preserving the timeout reason', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-timeout',
      output: JSON.stringify({
        type: 'text',
        part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'unused' }) },
      }),
      exitCode: 1,
      timedOut: true,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'timeout', cause: 'timeout' },
      evidence: { status: 'complete' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'timeout', cause: 'timeout' },
      terminal: { status: 'failed', reason: 'timeout', cause: 'timeout' },
    });
  });
  it('reports an output-truncated cause for capture overflow', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-output-truncated',
      output: JSON.stringify({
        type: 'text',
        part: { type: 'text', text: JSON.stringify({ findings: [], summary: 'unused' }) },
      }),
      truncated: true,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'output-truncated' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'output-truncated' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'output-truncated' },
    });
  });
  it('reports output-truncated when the parser rejects oversized stdout', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-oversized-stdout',
      output: 'x'.repeat(8 * 1024 * 1024 + 1),
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'output-truncated' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'output-truncated' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'output-truncated' },
    });
  });
  it('does not treat stderr capture truncation alone as invalid output', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-stderr-truncated-only',
      output: finalMarkdownJsonl(),
      stderrTruncated: true,
    });

    expect(terminal).toMatchObject({
      status: 'succeeded',
      evidence: { status: 'complete' },
    });
    expect(terminal).not.toHaveProperty('failure');
    expect(manifest).toMatchObject({
      execution: { status: 'succeeded', validation: 'valid-review-result' },
      terminal: { status: 'succeeded' },
    });
    expect(manifest.terminal).not.toHaveProperty('cause');
  });
  it('publishes the final assistant JSON Markdown instead of terminal narration', async () => {
    const finalMarkdown = '\n  ## Review:\n\nNo findings.  \n';
    const output = finalMarkdownJsonl(finalMarkdown);
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-109-final-text',
      output,
      sessionExport: sessionExportJson('scenario-session', { markdown: finalMarkdown }),
    });

    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(finalMarkdown),
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({
      complete: true,
      terminal: { status: 'succeeded' },
      evidence: { status: 'complete' },
      cleanup: { status: 'destroyed' },
    });
    await expect(
      readFile(
        join(sharedEvidenceRoot, terminal.evidenceId as string, 'validated-review.md'),
        'utf8',
      ),
    ).resolves.toBe(finalMarkdown);
    await expect(
      readFile(join(sharedEvidenceRoot, terminal.evidenceId as string, 'opencode.jsonl'), 'utf8'),
    ).resolves.toBe(`${output}\n`);
  });
  it.each([
    [
      'missing final result',
      sessionExportJson('scenario-session', { text: null }),
      'empty-final-text',
    ],
    ['empty final result', sessionExportJson('scenario-session', { text: '' }), 'empty-final-text'],
    [
      'invalid final JSON',
      sessionExportJson('scenario-session', { text: 'not json' }),
      'result-schema-failure',
    ],
    [
      'a retired JSON submission',
      sessionExportJson('scenario-session', {
        text: JSON.stringify({ decision: 'comment', markdown: '## Review:\n\nNo findings.' }),
      }),
      'result-schema-failure',
    ],
    [
      'invalid final decision',
      sessionExportJson('scenario-session', {
        text: decisionText('maybe', '## Review:\n\nNo findings.'),
      }),
      'result-schema-failure',
    ],
    [
      'an unknown decision header',
      sessionExportJson('scenario-session', {
        text: decisionText('maybe', '## Review:\n\nNo findings.'),
      }),
      'result-schema-failure',
    ],
    [
      'a decision header without the blank separator',
      sessionExportJson('scenario-session', {
        text: 'DECISION: approve\n## Review:\n\nNo findings.',
      }),
      'result-schema-failure',
    ],
    [
      'an empty decision-header body',
      sessionExportJson('scenario-session', { text: 'DECISION: approve\n\n' }),
      'result-schema-failure',
    ],
    [
      'missing terminal idle',
      sessionExportJson('scenario-session', { terminalIdle: false }),
      'missing-terminal-message',
    ],
    [
      'a length finish',
      sessionExportJson('scenario-session', { finish: 'length' }),
      'missing-terminal-message',
    ],
  ])('rejects %s as invalid output', async (_name, sessionExport, cause) => {
    const { terminal } = await runAgentScenario({
      runId: `run-109-${String(_name).replace(/\W+/g, '-')}`,
      output: finalMarkdownJsonl(),
      sessionExport,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause },
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(terminal).not.toHaveProperty('result');
  });
  it('rejects a malformed final assistant instead of using earlier text', async () => {
    const validText = decisionText('comment', defaultReviewMarkdown);
    const sessionExport = JSON.stringify({
      info: {
        id: 'scenario-session',
        outcome: 'succeeded',
        agent: 'review',
        model: { providerID: 'compte-rendu', id: 'deepseek-review' },
      },
      messages: [
        {
          type: 'assistant',
          id: 'msg-earlier',
          agent: 'review',
          model: { providerID: 'compte-rendu', id: 'deepseek-review' },
          finish: 'stop',
          content: [{ type: 'text', text: validText }],
        },
        { type: 'idle', outcome: 'succeeded' },
        {
          type: 'assistant',
          id: 'msg-final',
          agent: 'review',
          model: { providerID: 'compte-rendu', id: 'deepseek-review' },
          finish: 'stop',
          content: 'not-an-array',
        },
        { type: 'idle', outcome: 'succeeded' },
      ],
    });
    const { terminal } = await runAgentScenario({
      runId: 'run-malformed-final-assistant',
      output: finalMarkdownJsonl(),
      sessionExport,
    });
    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
    });
    expect(terminal).not.toHaveProperty('result');
  });
  it('rejects a malformed known text part in the final assistant', async () => {
    const sessionExport = JSON.stringify({
      info: {
        id: 'scenario-session',
        outcome: 'succeeded',
        agent: 'review',
        model: { providerID: 'compte-rendu', id: 'deepseek-review' },
      },
      messages: [
        {
          type: 'assistant',
          id: 'msg-final',
          agent: 'review',
          model: { providerID: 'compte-rendu', id: 'deepseek-review' },
          finish: 'stop',
          content: [
            {
              type: 'text',
              text: decisionText('comment', defaultReviewMarkdown),
            },
            { type: 'text', text: 123 },
          ],
        },
        { type: 'idle', outcome: 'succeeded' },
      ],
    });
    const { terminal } = await runAgentScenario({
      runId: 'run-malformed-text-part',
      output: finalMarkdownJsonl(),
      sessionExport,
    });
    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'result-schema-failure' },
    });
    expect(terminal).not.toHaveProperty('result');
  });
  it('reminds the same review session once when a completed run omitted the final review JSON', async () => {
    const reminderMarkdown = '## Review:\n\nReminder submission.';
    const result = await runReminderScenario({
      runId: 'run-reminder-success',
      rounds: [
        { output: completedWithoutSubmitJsonl('session-reminder'), finalText: null },
        {
          output: finalMarkdownJsonl(reminderMarkdown, 'session-reminder'),
          finalText: decisionText('comment', reminderMarkdown),
        },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(reminderMarkdown),
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(result.createCommands).toHaveLength(1);
    expect(result.agentCommands[1]).toEqual(
      expect.arrayContaining([
        'exec',
        result.sandboxName,
        'opencode',
        'run',
        '--session',
        'session-reminder',
        '--agent',
        'review',
      ]),
    );
    expect(result.manifest).toMatchObject({
      sessionIds: ['session-reminder'],
      terminal: { status: 'succeeded' },
    });
    const evidencePath = join(sharedEvidenceRoot, result.terminal.evidenceId as string);
    const combined = await readFile(join(evidencePath, 'opencode.jsonl'), 'utf8');
    expect(combined).toContain('I completed the review without submitting.');
    expect(combined).toContain('Reminder submission.');
    await expect(readFile(join(evidencePath, 'validated-review.md'), 'utf8')).resolves.toBe(
      reminderMarkdown,
    );
  });
  it('accepts a V2 final-text session with one correction turn', async () => {
    const sessionId = 'ses_synthetic_final_text';
    const markdown = '## Review:\nNo blocking defects.';
    const finalText = decisionText('approve', markdown);
    const firstTurn = JSON.stringify({
      type: 'text',
      sessionID: sessionId,
      part: {
        type: 'text',
        messageID: 'msg_synthetic_first',
        text: 'Review complete.',
      },
    });
    const secondTurn = JSON.stringify({
      type: 'text',
      sessionID: sessionId,
      part: {
        type: 'text',
        messageID: 'msg_synthetic_final',
        text: finalText,
      },
    });
    const result = await runReminderScenario({
      runId: 'run-captured-v2-final-text',
      sessionId,
      rounds: [
        { output: firstTurn, finalText: null },
        { output: secondTurn, finalText },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.agentCommands[1]).toEqual(
      expect.arrayContaining(['--session', sessionId, '--agent', 'review']),
    );
    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(markdown, 'approve'),
      evidence: { status: 'complete' },
    });
  });
  it('accepts the decision header with raw Markdown instead of JSON', async () => {
    const markdown =
      'TLDR: Request changes — a "quoted" value, an unescaped apostrophe, and a literal \\ backslash.\n\n' +
      '## Finding\n\n' +
      'The payload `"decision": "approve"` is text, not JSON metadata.\n' +
      '```ts\nconst value = "line\\nnot-a-separator";\n```\n\n' +
      'A second paragraph stays intact.';
    const result = await runAgentScenario({
      runId: 'run-decision-header',
      output: finalDecisionTextJsonl('request_changes', markdown),
      sessionExport: sessionExportJson('scenario-session', {
        text: decisionText('request_changes', markdown),
      }),
    });

    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(markdown, 'request_changes'),
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(result.manifest.result).toEqual(structuredResult(markdown, 'request_changes'));
  });
  it('corrects malformed JSON with a multiline request_changes decision header', async () => {
    const sessionId = 'session-decision-header-correction';
    const markdown =
      'TLDR: Request changes — the quoted "failure" needs a newline.\n\n' +
      '## Finding\n\nA raw Markdown body avoids escaping the quotes and newlines.';
    const malformedJson =
      '{"decision":"request_changes","markdown":"TLDR: Request changes — the "quoted" failure\nneeds a literal newline."}';
    const malformedOutput = JSON.stringify({
      type: 'text',
      sessionID: sessionId,
      part: {
        type: 'text',
        messageID: 'msg-malformed',
        text: malformedJson,
      },
    });
    const finalText = decisionText('request_changes', markdown);
    const result = await runReminderScenario({
      runId: 'run-decision-header-correction',
      sessionId,
      rounds: [
        { output: malformedOutput, finalText: malformedJson },
        {
          output: finalDecisionTextJsonl('request_changes', markdown, sessionId),
          finalText,
        },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.agentCommands[1]?.join(' ')).toContain(
      'Your final response did not contain a valid review submission',
    );
    expect(result.agentCommands[1]?.join(' ')).toContain('DECISION:');
    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(markdown, 'request_changes'),
      evidence: { status: 'complete' },
    });
  });
  it('publishes after a known recovered provider error and a same-session correction', async () => {
    const markdown = '## Review:\n\nRecovered and corrected.';
    const session = 'session-reminder';
    const error = JSON.stringify({
      type: 'error',
      sessionID: session,
      error: { type: 'provider.invalid-output', status: 200 },
    });
    const result = await runReminderScenario({
      runId: 'run-recovered-correction',
      rounds: [
        {
          output: `${error}\n${completedWithoutSubmitJsonl(session)}`,
          exitCode: 1,
          finalText: null,
        },
        {
          output: finalMarkdownJsonl(markdown, session),
          exitCode: 0,
          finalText: decisionText('comment', markdown),
        },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.agentCommands[1]).toEqual(
      expect.arrayContaining(['--session', session, '--agent', 'review']),
    );
    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(markdown),
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
  });
  it('rejects a generic exit-one correction after an initial known provider error', async () => {
    const session = 'session-reminder';
    const markdown = '## Review:\n\nCorrection process failed.';
    const error = JSON.stringify({
      type: 'error',
      sessionID: session,
      error: { type: 'provider.invalid-output', status: 200 },
    });
    const result = await runReminderScenario({
      runId: 'run-recovered-then-generic-correction',
      rounds: [
        {
          output: `${error}\n${completedWithoutSubmitJsonl(session)}`,
          exitCode: 1,
          finalText: null,
        },
        {
          output: finalMarkdownJsonl(markdown, session),
          exitCode: 1,
          finalText: decisionText('comment', markdown),
        },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'process-exit' },
    });
    expect(result.terminal).not.toHaveProperty('result');
  });
  it('does not correct or recover a generic exit-one run', async () => {
    const result = await runReminderScenario({
      runId: 'run-generic-exit-one',
      rounds: [
        {
          output: completedWithoutSubmitJsonl('session-reminder'),
          exitCode: 1,
          finalText: null,
        },
      ],
    });

    expect(result.agentRuns).toBe(1);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'process-exit' },
    });
    expect(result.terminal).not.toHaveProperty('result');
  });
  it('fails after one correction when the final result is still missing', async () => {
    const result = await runReminderScenario({
      runId: 'run-reminder-still-missing',
      rounds: [
        { output: completedWithoutSubmitJsonl('session-reminder'), finalText: null },
        { output: completedWithoutSubmitJsonl('session-reminder'), finalText: null },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'empty-final-text' },
    });
    expect(result.terminal).not.toHaveProperty('result');
  });
  it('does not remind when the completed run timed out', async () => {
    const result = await runReminderScenario({
      runId: 'run-reminder-timeout',
      rounds: [
        {
          output: completedWithoutSubmitJsonl('session-reminder'),
          finalText: null,
          timedOut: true,
        },
      ],
    });

    expect(result.agentRuns).toBe(1);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'timeout', cause: 'timeout' },
    });
  });
  it('does not remind when the shared agent budget is exhausted', async () => {
    const agentBudgetMs = 90 * 60 * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'));
      const result = await runReminderScenario({
        runId: 'run-reminder-budget-exhausted',
        rounds: [
          {
            output: completedWithoutSubmitJsonl('session-reminder'),
            finalText: null,
            advanceMs: agentBudgetMs + 1,
          },
        ],
      });

      expect(result.agentRuns).toBe(1);
      expect(result.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'invalid-output', cause: 'empty-final-text' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('caps the reminder at the remaining shared agent budget', async () => {
    const agentBudgetMs = 90 * 60 * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'));
      const reminderMarkdown = '## Review:\n\nBudget-capped reminder.';
      const result = await runReminderScenario({
        runId: 'run-reminder-budget-remaining',
        rounds: [
          {
            output: completedWithoutSubmitJsonl('session-reminder'),
            finalText: null,
            advanceMs: agentBudgetMs - 30_000,
          },
          {
            output: finalMarkdownJsonl(reminderMarkdown, 'session-reminder'),
            finalText: decisionText('comment', reminderMarkdown),
          },
        ],
      });

      expect(result.agentRuns).toBe(2);
      expect(result.agentTimeouts[0]).toBe(agentBudgetMs);
      expect(result.agentTimeouts[1]).toBe(30_000);
      expect(result.exportTimeouts[0]).toBe(30_000);
      expect(result.terminal).toMatchObject({
        status: 'succeeded',
        result: structuredResult(reminderMarkdown),
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not remind a session whose exported final turn was truncated', async () => {
    const result = await runReminderScenario({
      runId: 'run-v2-no-reminder-after-length',
      rounds: [
        {
          output: completedWithoutSubmitJsonl('session-reminder'),
          finalText: null,
          exportFinish: 'length',
        },
      ],
    });
    expect(result.agentRuns).toBe(1);
    expect(result.terminal).toMatchObject({ status: 'failed', sandbox: { cleanup: 'destroyed' } });
    expect(result.terminal).not.toHaveProperty('result');
    expect(result.manifest).not.toHaveProperty('result');
  });
  it('rejects a reminder round that submits without its own terminal stop', async () => {
    const session = 'session-reminder';
    const reminderWithoutStop = [
      JSON.stringify({
        type: 'text',
        sessionID: session,
        part: { type: 'text', messageID: 'msg-reminder', text: 'Submitting the review.' },
      }),
      JSON.stringify({
        type: 'text',
        sessionID: session,
        part: {
          type: 'text',
          messageID: 'msg-reminder',
          text: decisionText('comment', '## Review:\n\nReminder without a stop.'),
        },
      }),
    ].join('\n');
    const result = await runReminderScenario({
      runId: 'run-reminder-no-stop',
      rounds: [
        { output: completedWithoutSubmitJsonl(session), finalText: null },
        {
          output: reminderWithoutStop,
          finalText: JSON.stringify({
            decision: 'comment',
            markdown: '## Review:\n\nReminder without a stop.',
          }),
          exportFinish: 'length',
        },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
    });
    expect(result.terminal).not.toHaveProperty('result');
  });
  it('does not accept a reminder submission from a different session', async () => {
    const result = await runReminderScenario({
      runId: 'run-reminder-session-mismatch',
      rounds: [
        { output: completedWithoutSubmitJsonl('session-reminder'), finalText: null },
        {
          output: finalMarkdownJsonl('## Review:\n\nOther session.', 'session-other'),
          finalText: JSON.stringify({
            decision: 'comment',
            markdown: '## Review:\n\nOther session.',
          }),
        },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'zero-results' },
    });
    expect(result.terminal).not.toHaveProperty('result');
  });
  it('preserves a malformed reminder round cause', async () => {
    const result = await runReminderScenario({
      runId: 'run-reminder-malformed',
      rounds: [
        { output: completedWithoutSubmitJsonl('session-reminder'), finalText: null },
        { output: 'not-jsonl' },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'malformed-jsonl' },
    });
  });
  it('preserves an explicit reminder agent error without a session ID', async () => {
    const result = await runReminderScenario({
      runId: 'run-reminder-agent-error',
      rounds: [
        { output: completedWithoutSubmitJsonl('session-reminder'), finalText: null },
        { output: JSON.stringify({ type: 'error' }) },
      ],
    });

    expect(result.agentRuns).toBe(2);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'agent-error' },
    });
  });
  it('reports a malformed-jsonl cause for invalid agent event lines', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-malformed-jsonl',
      output: 'not-jsonl',
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'malformed-jsonl' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'malformed-jsonl' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'malformed-jsonl' },
    });
  });
  it('publishes a recovered OpenCode review despite its sticky exit code', async () => {
    const markdown = '## Review:\n\nNo findings after recovery.';
    const callbacks: Request[] = [];
    const output = [
      JSON.stringify({
        type: 'error',
        sessionID: 'scenario-session',
        error: {
          type: 'provider.invalid-output',
          message: 'OpenAI Chat stream ended without finish_reason',
          status: 200,
        },
      }),
      finalMarkdownJsonl(markdown),
    ].join('\n');
    const exported = sessionExportJson('scenario-session', { markdown });
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-recovered-cli',
      output,
      exitCode: 1,
      sessionExport: exported,
      callbackRequests: callbacks,
    });
    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(markdown),
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({
      terminal: { status: 'succeeded' },
      result: structuredResult(markdown),
    });
    const callback = await callbacks[0]!.json();
    expect(callback).toMatchObject({ status: 'succeeded', result: structuredResult(markdown) });
    await expect(
      readFile(
        join(sharedEvidenceRoot, terminal.evidenceId as string, 'validated-review.md'),
        'utf8',
      ),
    ).resolves.toBe(markdown);
  });
  it('reports an unrecovered provider request failure as upstream with its HTTP status', async () => {
    const callbacks: Request[] = [];
    const output = JSON.stringify({
      type: 'error',
      sessionID: 'scenario-session',
      error: {
        type: 'provider.invalid-request',
        message: 'model request failed',
        status: 400,
      },
    });
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-226-upstream-400',
      output,
      exitCode: 1,
      callbackRequests: callbacks,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'upstream', cause: 'upstream-error', httpStatus: 400 },
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(terminal).not.toHaveProperty('result');
    expect(manifest).toMatchObject({
      execution: {
        status: 'failed',
        reason: 'upstream',
        cause: 'upstream-error',
        httpStatus: 400,
      },
      terminal: {
        status: 'failed',
        reason: 'upstream',
        cause: 'upstream-error',
        httpStatus: 400,
      },
    });
    expect(await callbacks[0]!.json()).toMatchObject({
      status: 'failed',
      failure: { reason: 'upstream', cause: 'upstream-error', httpStatus: 400 },
    });
  });
  it.each([
    ['without a status', {}],
    ['with an out-of-range status', { status: 999 }],
  ])(
    'reports an unrecovered provider failure %s as upstream without an HTTP status',
    async (_name, errorFields) => {
      const output = JSON.stringify({
        type: 'error',
        sessionID: 'scenario-session',
        error: { type: 'provider.server-error', message: 'model request failed', ...errorFields },
      });
      const { terminal, manifest } = await runAgentScenario({
        runId: `run-226-upstream-${String(_name).replace(/\W+/g, '-')}`,
        output,
        exitCode: 1,
      });

      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'upstream', cause: 'upstream-error' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(terminal).not.toHaveProperty('failure.httpStatus');
      expect(manifest).toMatchObject({
        execution: { status: 'failed', reason: 'upstream', cause: 'upstream-error' },
        terminal: { status: 'failed', reason: 'upstream', cause: 'upstream-error' },
      });
      expect(manifest.execution).not.toHaveProperty('httpStatus');
      expect(manifest.terminal).not.toHaveProperty('httpStatus');
    },
  );
  it('reports a provider invalid-output error from another session as upstream', async () => {
    const output = JSON.stringify({
      type: 'error',
      sessionID: 'another-session',
      error: { type: 'provider.invalid-output', status: 200 },
    });
    const { terminal } = await runAgentScenario({
      runId: 'run-226-upstream-foreign-session',
      output: `${output}\n${finalMarkdownJsonl()}`,
      exitCode: 1,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'upstream', cause: 'upstream-error' },
    });
    expect(terminal).not.toHaveProperty('failure.httpStatus');
    expect(terminal).not.toHaveProperty('result');
  });
  it('keeps an unproven same-session status-200 provider recovery as invalid output', async () => {
    const error = JSON.stringify({
      type: 'error',
      sessionID: 'scenario-session',
      error: { type: 'provider.invalid-output', status: 200 },
    });
    const { terminal } = await runAgentScenario({
      runId: 'run-226-unproven-status-200-recovery',
      output: `${error}\n${finalMarkdownJsonl()}`,
      exitCode: 1,
      sessionExport: sessionExportJson('scenario-session', { outcome: 'failed' }),
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'process-exit' },
    });
    expect(terminal).not.toHaveProperty('failure.httpStatus');
    expect(terminal).not.toHaveProperty('result');
  });
  it('keeps cleanup as the failure reason without attributing an upstream status to it', async () => {
    const output = JSON.stringify({
      type: 'error',
      sessionID: 'scenario-session',
      error: { type: 'provider.invalid-request', message: 'model request failed', status: 400 },
    });
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-226-upstream-cleanup-failure',
      output,
      exitCode: 1,
      cleanupFailure: true,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup', cause: 'upstream-error' },
      sandbox: { cleanup: 'failed' },
    });
    expect(terminal).not.toHaveProperty('failure.httpStatus');
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'cleanup', cause: 'upstream-error' },
      terminal: { status: 'failed', reason: 'cleanup', cause: 'upstream-error' },
    });
    expect(manifest.execution).not.toHaveProperty('httpStatus');
    expect(manifest.terminal).not.toHaveProperty('httpStatus');
  });
  it.each(recoveryScenarios)(
    'does not accept apparent OpenCode recovery with %s',
    async (_name, scenario) => {
      const markdown = '## Review:\n\nRecovered review.';
      const callbacks: Request[] = [];
      const error = JSON.stringify({
        type: 'error',
        sessionID: scenario.errorSession ?? 'scenario-session',
        error: { type: 'provider.invalid-output', status: 200 },
      });
      const output = [
        error,
        finalMarkdownJsonl(markdown),
        ...('malformedJsonl' in scenario ? ['not-json'] : []),
      ].join('\n');
      const exported = sessionExportJson(scenario.exportId ?? 'scenario-session', {
        outcome: scenario.exportOutcome,
        ...(scenario.text === undefined ? { markdown } : { text: scenario.text }),
      });
      const { terminal, manifest } = await runAgentScenario({
        runId: `run-recovery-${String(_name).replace(/\W+/g, '-')}`,
        output,
        exitCode: scenario.exitCode ?? 1,
        timedOut: scenario.timedOut,
        truncated: scenario.truncated,
        sessionExport: exported,
        callbackRequests: callbacks,
      });
      expect(terminal).toMatchObject({ status: 'failed', sandbox: { cleanup: 'destroyed' } });
      expect(terminal).not.toHaveProperty('result');
      expect(manifest).not.toHaveProperty('result');
      expect(await callbacks[0]!.json()).not.toHaveProperty('result');
    },
  );
  it('reports an agent-error cause for an explicit agent error event', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-agent-error',
      output: JSON.stringify({ type: 'error' }),
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'agent-error' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'agent-error' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'agent-error' },
    });
  });
  it('reports missing-terminal-message when OpenCode emits no terminal assistant message', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-missing-terminal-message',
      output: JSON.stringify({
        type: 'text',
        sessionID: 'scenario-session',
        part: { type: 'text', messageID: 'msg-final', text: 'No terminal result.' },
      }),
      sessionExport: JSON.stringify({
        info: { id: 'scenario-session', outcome: 'succeeded' },
        messages: [{ type: 'idle', outcome: 'succeeded' }],
      }),
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'invalid-output', cause: 'missing-terminal-message' },
      terminal: { status: 'failed', reason: 'invalid-output', cause: 'missing-terminal-message' },
    });
  });
  it.each(['length', 'error'] as const)(
    'does not publish final text when the terminal step finishes with %s',
    async (reason) => {
      const output = [
        JSON.stringify({
          type: 'text',
          sessionID: 'scenario-session',
          part: { type: 'text', messageID: 'msg-final', text: '# Partial review' },
        }),
        JSON.stringify({
          type: 'step_finish',
          sessionID: 'scenario-session',
          part: { type: 'step-finish', messageID: 'msg-final', reason },
        }),
      ].join('\n');
      const { terminal, manifest } = await runAgentScenario({
        runId: `run-105-${reason}-terminal`,
        output,
        sessionExport: sessionExportJson('scenario-session', { finish: reason }),
      });

      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
        evidence: { status: 'complete' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(terminal).not.toHaveProperty('result');
      expect(manifest).toMatchObject({
        execution: {
          status: 'failed',
          reason: 'invalid-output',
          cause: 'missing-terminal-message',
        },
        terminal: { status: 'failed', reason: 'invalid-output', cause: 'missing-terminal-message' },
      });
    },
  );
  it.each(['length', null, { malformed: true }])(
    'rejects a submission whose final assistant finish is %j',
    async (finish) => {
      const markdown = '## Review:\n\nNo findings.';
      const { terminal, manifest } = await runAgentScenario({
        runId: 'run-v2-last-assistant-length',
        output: finalMarkdownJsonl(markdown),
        sessionExport: JSON.stringify({
          info: { id: 'scenario-session', outcome: 'succeeded' },
          messages: [
            { type: 'assistant', finish: 'stop' },
            { type: 'assistant', finish },
            { type: 'idle', outcome: 'succeeded' },
          ],
        }),
      });

      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'invalid-output', cause: 'missing-terminal-message' },
        sandbox: { cleanup: 'destroyed' },
      });
      expect(terminal).not.toHaveProperty('result');
      expect(manifest).not.toHaveProperty('result');
    },
  );
  it('preserves the execution cause when cleanup also fails', async () => {
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-90-cause-through-cleanup',
      output: 'not-jsonl',
      cleanupFailure: true,
    });

    expect(terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'cleanup', cause: 'malformed-jsonl' },
      sandbox: { cleanup: 'failed' },
    });
    expect(manifest).toMatchObject({
      execution: { status: 'failed', reason: 'cleanup', cause: 'malformed-jsonl' },
      terminal: { status: 'failed', reason: 'cleanup', cause: 'malformed-jsonl' },
    });
  });
  it('returns final assistant JSON after terminal progress output', async () => {
    const finalReview = '## Review:\n\nThe change is sound; `{example}` is prose.';
    const progressEvent = JSON.stringify({
      type: 'text',
      sessionID: 'scenario-session',
      part: {
        type: 'text',
        messageID: 'msg-progress',
        text: 'Inspecting the pull request...',
      },
    });
    const finalEvent = finalMarkdownJsonl(finalReview, 'scenario-session');
    const { terminal, manifest } = await runAgentScenario({
      runId: 'run-109-final-text-after-progress',
      output: `${progressEvent}\n${finalEvent}`,
      sessionExport: sessionExportJson('scenario-session', { markdown: finalReview }),
    });

    expect(terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(finalReview),
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(manifest).toMatchObject({ complete: true, terminal: { status: 'succeeded' } });
  });
  it('fails closed on malformed agent output and still destroys the Sandbox', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const runner = createRunner({
      evidenceRoot: sharedEvidenceRoot,
      authToken: 'runner-test-token',
      process: async (_command, args, options = {}) => {
        await writeEvidenceFixture(args, options, '{not-json}');
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse')
            ? `${baseSha}\n${headSha}\n`
            : args.includes('session')
              ? '[{"id":"fixture-session"}]\n'
              : options.captureStdout === true
                ? '{not-json}\n'
                : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const submittedJob = {
      ...runnerJobFields,
      runId: 'run-64-invalid-output',
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
      failure: { reason: 'invalid-output' },
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    const archive = join(sharedEvidenceRoot, terminal.evidenceId as string);
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db'), 'utf8')).resolves.toBe(
      'db',
    );
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db-wal'), 'utf8')).resolves.toBe(
      'wal',
    );
    await expect(readFile(join(archive, 'opencode-data', 'opencode.db-shm'), 'utf8')).resolves.toBe(
      'shm',
    );
    await expect(readFile(join(archive, 'opencode-data', 'review.log'), 'utf8')).resolves.toBe(
      'log',
    );
  });
  it('rejects error events and oversized output', async () => {
    const baseSha = '1111111111111111111111111111111111111111';
    const headSha = '2222222222222222222222222222222222222222';
    const outputs = [JSON.stringify({ type: 'error' }), 'x'.repeat(8 * 1024 * 1024 + 1)];

    for (const [index, agentOutput] of outputs.entries()) {
      const runner = createRunner({
        evidenceRoot: sharedEvidenceRoot,
        authToken: 'runner-test-token',
        process: async (_command, args, options = {}) => {
          await writeEvidenceFixture(args, options, agentOutput);
          return {
            exitCode: 0,
            stdout: args.includes('rev-parse')
              ? `${baseSha}\n${headSha}\n`
              : args.includes('session')
                ? '[{"id":"fixture-session"}]\n'
                : args.includes('export')
                  ? ''
                  : args[0] === 'exec' && options.captureStdout === true
                    ? agentOutput
                    : '',
            timedOut: false,
            truncated: false,
          };
        },
      });
      const submittedJob = {
        ...runnerJobFields,
        runId: `run-64-invalid-agent-${index}`,
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
        repositoryReadToken: 'checkout-token-for-test',
      };
      runner.enqueue(submittedJob);
      const id = submittedJob.id;

      await expect(waitForTerminal(runner, id)).resolves.toMatchObject({
        status: 'failed',
        failure: { reason: 'invalid-output' },
        sandbox: { cleanup: 'destroyed' },
      });
    }
  });
});

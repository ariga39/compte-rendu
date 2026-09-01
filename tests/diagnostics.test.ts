import { describe, expect, it } from 'vitest';
import {
  createDefaultDiagnosticSources,
  runDiagnosticCommand,
  type DiagnosticSources,
} from '../scripts/diagnose.mts';

const artifact = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    content: Buffer.from(bytes).toString('base64'),
    size: bytes.byteLength,
    sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    ),
  };
};

describe('diagnostics command', () => {
  it('emits one sanitized correlated report for a pull request URL', async () => {
    const sources: DiagnosticSources = {
      d1: {
        find: async () => ({
          delivery: {
            deliveryId: 'delivery-115',
            repositoryId: 42,
            pullRequestNumber: 7,
            baseSha: '1111111111111111111111111111111111111111',
            headSha: '2222222222222222222222222222222222222222',
            trigger: 'manual',
            status: 'completed',
            createdAt: '2026-09-01T13:44:02.000Z',
            updatedAt: '2026-09-01T13:44:14.000Z',
          },
          run: {
            runId: 'run-115',
            status: 'completed',
            runnerJobId: 'job-115',
            runnerAttempt: 1,
            commentId: 99,
            createdAt: '2026-09-01T13:44:02.000Z',
            updatedAt: '2026-09-01T13:44:14.000Z',
            evidence: {
              key: 'reviews/run-115',
              status: 'complete',
              size: 1234,
              sha256: 'a'.repeat(64),
              uploadedAt: '2026-09-01T13:44:14.000Z',
              executionStartedAt: '2026-09-01T13:44:03.000Z',
              submissionCompletedAt: '2026-09-01T13:44:12.000Z',
              cleanupCompletedAt: '2026-09-01T13:44:13.000Z',
            },
          },
        }),
      },
      github: {
        find: async () => ({
          repository: { owner: 'poooi', name: 'plugin-hensei-nikki', id: 42 },
          pullRequest: {
            state: 'open',
            baseSha: '1111111111111111111111111111111111111111',
            headSha: '2222222222222222222222222222222222222222',
          },
          trigger: { kind: 'manual', commentId: 99 },
          reactions: [{ content: 'eyes' }, { content: '-1' }],
          reviews: [
            { id: 17, state: 'commented', commitSha: '2222222222222222222222222222222222222222' },
          ],
        }),
      },
      r2: {
        get: async () => ({
          key: 'reviews/run-115',
          object: {
            version: 1,
            runId: 'run-115',
            jobId: 'job-115',
            evidenceId: 'evidence-115',
            evidence: {
              id: 'evidence-115',
              status: 'complete',
              manifest: await artifact(
                JSON.stringify({
                  jobId: 'job-115',
                  runId: 'run-115',
                  attempt: 1,
                  evidenceId: 'evidence-115',
                  sandboxName: 'compte-rendu-job-115',
                  sandboxId: 'compte-rendu-job-115',
                  sessionIds: ['ses-115'],
                  terminal: { status: 'succeeded' },
                  evidence: { id: 'evidence-115', status: 'complete' },
                  complete: true,
                  cleanup: { status: 'destroyed' },
                  startedAt: '2026-09-01T13:44:03.000Z',
                  finishedAt: '2026-09-01T13:44:13.000Z',
                }),
              ),
              opencodeJsonl: await artifact(
                JSON.stringify({
                  type: 'tool_use',
                  part: {
                    type: 'tool',
                    tool: 'submit_review',
                    state: {
                      status: 'completed',
                      time: { start: '2026-09-01T13:44:11.000Z', end: '2026-09-01T13:44:12.000Z' },
                    },
                  },
                }),
              ),
              opencodeStderr: await artifact(''),
              validatedReview: await artifact('## Review:\n\nNo findings.'),
              opencodeSessionList: await artifact(JSON.stringify([{ id: 'ses-115' }])),
              opencodeExport: {
                sessionId: 'ses-115',
                content: await artifact(
                  JSON.stringify({
                    info: { id: 'ses-115' },
                    messages: [
                      {
                        time: {
                          created: '2026-09-01T13:44:03.000Z',
                          completed: '2026-09-01T13:44:13.000Z',
                        },
                      },
                    ],
                  }),
                ),
              },
            },
          },
        }),
      },
    };

    const report = JSON.parse(
      await runDiagnosticCommand(['https://github.com/poooi/plugin-hensei-nikki/pull/7'], sources),
    ) as Record<string, unknown>;

    expect(report).toMatchObject({
      target: {
        kind: 'pull-request',
        owner: 'poooi',
        repository: 'plugin-hensei-nikki',
        number: 7,
      },
      github: {
        state: 'open',
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '2222222222222222222222222222222222222222',
        trigger: { kind: 'manual', commentId: 99 },
        reactions: [{ content: 'eyes' }, { content: '-1' }],
        reviews: [
          { id: 17, state: 'commented', commitSha: '2222222222222222222222222222222222222222' },
        ],
      },
      d1: {
        deliveryId: 'delivery-115',
        runId: 'run-115',
        status: 'completed',
        runnerJobId: 'job-115',
        runnerAttempt: 1,
        commentId: 99,
      },
      runner: {
        jobId: 'job-115',
        stage: 'cleanup',
        sandboxName: 'compte-rendu-job-115',
        sandboxId: 'compte-rendu-job-115',
        terminal: 'succeeded',
        cleanup: 'destroyed',
      },
      evidence: {
        key: 'reviews/run-115',
        status: 'complete',
        sessionId: 'ses-115',
        output: {
          present: true,
          size: 24,
          sha256: 'c4a6c00619598368b43d814cdd62e94ae79df383584771192d050e8a30ec1a6c',
        },
        stderr: {
          present: true,
          size: 0,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          bounded: true,
        },
      },
      missingSources: [],
    });
    expect(report).toHaveProperty('timeline');
    expect(report).toHaveProperty('firstFailureBoundary', null);
    expect(JSON.stringify(report)).not.toContain('No findings.');
  });

  it('reports missing D1 and R2 while retaining an available GitHub source', async () => {
    const report = JSON.parse(
      await runDiagnosticCommand(['https://github.com/poooi/plugin-hensei-nikki/pull/7'], {
        d1: {
          find: async () => {
            throw new Error('D1 unavailable');
          },
        },
        github: {
          find: async () => ({
            repository: { owner: 'poooi', name: 'plugin-hensei-nikki', id: 42 },
            pullRequest: {
              state: 'open',
              baseSha: '1111111111111111111111111111111111111111',
              headSha: '2222222222222222222222222222222222222222',
            },
            reactions: [],
            reviews: [],
          }),
        },
        r2: {
          get: async () => {
            throw new Error('R2 unavailable');
          },
        },
      }),
    ) as Record<string, unknown>;

    expect(report).toMatchObject({
      github: { available: true, state: 'open' },
      d1: { available: false },
      evidence: { available: false },
      missingSources: ['d1', 'r2'],
    });
  });

  it('correlates historical Workflow failure with the real R2 envelope and sanitized times', async () => {
    const runId = 'f963a9fa-de77-4481-b482-0ba671e02468';
    const jobId = '5a7149b6-b99c-4cee-b47b-ff4ca39ecb49';
    const evidenceId = 'b8125c62-3282-4616-aad9-f1fa1054bf29';
    const sessionId = 'ses_fa2cd7fe7ffeJciwD0ny7qhdS0';
    const sources: DiagnosticSources = {
      d1: {
        find: async () => ({
          delivery: {
            deliveryId: 'delivery-42',
            repositoryId: 42,
            pullRequestNumber: 7,
            baseSha: '1111111111111111111111111111111111111111',
            headSha: '2222222222222222222222222222222222222222',
            trigger: 'automatic',
            status: 'failed',
            createdAt: '2026-09-01T13:44:01.000Z',
            updatedAt: '2026-09-01T13:44:14.000Z',
          },
          run: {
            runId,
            status: 'failed',
            runnerJobId: jobId,
            runnerAttempt: 1,
            createdAt: '2026-09-01T13:44:01.000Z',
            updatedAt: '2026-09-01T13:44:14.000Z',
            evidence: {
              key: `reviews/${runId}`,
              status: 'complete',
              size: 42,
              sha256: 'a'.repeat(64),
              uploadedAt: '2026-09-01T13:44:14.000Z',
            },
          },
        }),
      },
      github: {
        find: async () => ({
          repository: { owner: 'poooi', name: 'plugin-hensei-nikki', id: 42 },
          pullRequest: {
            state: 'open',
            baseSha: '1111111111111111111111111111111111111111',
            headSha: '2222222222222222222222222222222222222222',
          },
          reactions: [],
          reviews: [],
        }),
      },
      r2: {
        get: async () => ({
          key: `reviews/${runId}`,
          object: {
            version: 1,
            runId,
            jobId,
            evidenceId,
            evidence: {
              id: evidenceId,
              status: 'complete',
              manifest: await artifact(
                JSON.stringify({
                  jobId,
                  runId,
                  attempt: 1,
                  evidenceId,
                  sandboxName: 'compte-rendu-5a7149b6-b99c-4cee-b47b-ff4ca39ecb49',
                  sandboxId: 'compte-rendu-5a7149b6-b99c-4cee-b47b-ff4ca39ecb49',
                  sessionIds: [sessionId],
                  terminal: { status: 'failed' },
                  evidence: { id: evidenceId, status: 'complete' },
                  complete: true,
                  cleanup: { status: 'destroyed' },
                  startedAt: '2026-09-01T13:44:03.000Z',
                  finishedAt: '2026-09-01T13:44:14.000Z',
                }),
              ),
              opencodeJsonl: await artifact(
                JSON.stringify({
                  type: 'tool_use',
                  part: {
                    type: 'tool',
                    tool: 'submit_review',
                    state: {
                      status: 'completed',
                      time: { end: '2026-09-01T13:44:14.000Z' },
                    },
                  },
                }),
              ),
              opencodeStderr: await artifact(''),
              validatedReview: await artifact('## Review:\n\nNo findings.'),
              opencodeSessionList: await artifact(JSON.stringify([{ id: sessionId }])),
              opencodeExport: {
                sessionId,
                content: await artifact(
                  JSON.stringify({
                    info: { id: sessionId },
                    messages: [{ time: { completed: '2026-09-01T13:44:14.000Z' } }],
                  }),
                ),
              },
            },
          },
        }),
      },
      workflow: {
        find: async () => ({
          id: 'historical-workflow-42',
          events: [
            {
              at: '2026-09-01T13:44:02.000Z',
              type: 'WorkflowInternalError',
              status: 'failed',
              reason: 'Attempt failed due to internal workflows error',
            },
          ],
        }),
      },
    };

    const report = JSON.parse(await runDiagnosticCommand([runId], sources)) as Record<
      string,
      unknown
    >;
    expect(report).toMatchObject({
      target: { kind: 'identifier', id: runId },
      runner: {
        jobId,
        stage: 'cleanup',
        sandboxName: 'compte-rendu-5a7149b6-b99c-4cee-b47b-ff4ca39ecb49',
        sandboxId: 'compte-rendu-5a7149b6-b99c-4cee-b47b-ff4ca39ecb49',
        terminal: 'failed',
        evidence: 'complete',
        cleanup: 'destroyed',
      },
      evidence: {
        available: true,
        sessionId,
        timestamps: {
          submissionCompletedAt: '2026-09-01T13:44:14.000Z',
          terminalAt: '2026-09-01T13:44:14.000Z',
        },
      },
      workflow: {
        available: true,
        events: [
          {
            at: '2026-09-01T13:44:02.000Z',
            type: 'WorkflowInternalError',
            status: 'failed',
            reason: 'Attempt failed due to internal workflows error',
          },
        ],
      },
      firstFailureBoundary: {
        source: 'workflow',
        at: '2026-09-01T13:44:02.000Z',
        reason: 'Attempt failed due to internal workflows error',
      },
    });
    expect(JSON.stringify(report)).not.toContain('No findings.');
  });

  it('retrieves configured historical Workflow details through the production CLI adapter', async () => {
    const command = {
      run: async (_executable: string, args: readonly string[]) => {
        if (args.includes('workflows')) {
          return {
            exitCode: 0,
            stdout: [
              'Name: review-1',
              'Type: step',
              'Start: 9/1/2026, 1:43:58 PM',
              'End: 9/1/2026, 1:44:02 PM',
              'Status: errored',
              '┌─────────┬─────────┐',
              '│ Step    │ Status  │',
              '└─────────┴─────────┘',
              'WorkflowInternalError: Attempt failed due to internal workflows error',
            ].join('\n'),
          };
        }
        if (args.includes('d1')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                results: [
                  {
                    delivery_id: 'delivery-42',
                    repository_id: 42,
                    pull_request_number: 7,
                    base_sha: null,
                    head_sha: null,
                    trigger: 'automatic',
                    status: 'failed',
                    created_at: '2026-09-01T13:44:01.000Z',
                    updated_at: '2026-09-01T13:44:14.000Z',
                    run_id: 'f963a9fa-de77-4481-b482-0ba671e02468',
                    run_status: 'failed',
                    run_created_at: '2026-09-01T13:44:01.000Z',
                    run_updated_at: '2026-09-01T13:44:14.000Z',
                    runner_job_id: '5a7149b6-b99c-4cee-b47b-ff4ca39ecb49',
                    runner_attempt: 1,
                    comment_id: null,
                    evidence_key: null,
                    evidence_status: null,
                    evidence_size: null,
                    evidence_sha256: null,
                    evidence_uploaded_at: null,
                    execution_started_at: null,
                    submission_completed_at: null,
                    cleanup_completed_at: null,
                  },
                ],
              },
            ]),
          };
        }
        return { exitCode: 1, stdout: '' };
      },
    };
    const sources = createDefaultDiagnosticSources(command, {
      database: 'actual-review-state',
      bucket: 'actual-review-evidence',
      wranglerConfig: 'apps/core/wrangler.actual.jsonc',
      workflowName: 'petit-chiba-review',
    });

    const report = JSON.parse(
      await runDiagnosticCommand(['f963a9fa-de77-4481-b482-0ba671e02468'], sources),
    ) as Record<string, unknown>;
    expect(report).toMatchObject({
      workflow: {
        available: true,
        id: 'f963a9fa-de77-4481-b482-0ba671e02468',
        events: [
          {
            at: '2026-09-01T13:44:02.000Z',
            type: 'WorkflowInternalError',
            status: 'failed',
            reason: 'Attempt failed due to internal workflows error',
          },
        ],
      },
      firstFailureBoundary: {
        source: 'workflow',
        at: '2026-09-01T13:44:02.000Z',
        reason: 'Attempt failed due to internal workflows error',
      },
    });
  });
});

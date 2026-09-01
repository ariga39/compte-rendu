import { describe, expect, it } from 'vitest';
import {
  createDefaultDiagnosticSources,
  runDiagnosticCommand,
  type DiagnosticCommandOptions,
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
              size: 2003,
              sha256: '6e8546d0a49666a4073772917ae103786d9312b6087bf1f55f5e4dbb91d17fb7',
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
        get: async () => {
          const object = {
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
                        info: {
                          time: {
                            created: '2026-09-01T13:44:03.000Z',
                            completed: '2026-09-01T13:44:13.000Z',
                          },
                        },
                        parts: [],
                      },
                    ],
                  }),
                ),
              },
            },
          };
          return {
            key: 'reviews/run-115',
            rawSize: 2003,
            rawSha256: '6e8546d0a49666a4073772917ae103786d9312b6087bf1f55f5e4dbb91d17fb7',
            object,
          };
        },
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
        repository: { owner: 'poooi', name: 'plugin-hensei-nikki', id: 42 },
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
        delivery: { deliveryId: 'delivery-115', status: 'completed' },
        run: {
          runId: 'run-115',
          status: 'completed',
          runnerJobId: 'job-115',
          runnerAttempt: 1,
          commentId: 99,
        },
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
        timestamps: { terminalAt: '2026-09-01T13:44:13.000Z' },
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

  it('reports the earliest concrete failure boundary across available systems', async () => {
    const report = JSON.parse(
      await runDiagnosticCommand(['run:run-boundary'], {
        d1: {
          find: async () => ({
            delivery: {
              deliveryId: 'delivery-boundary',
              repositoryId: 42,
              pullRequestNumber: 7,
              baseSha: null,
              headSha: null,
              trigger: 'automatic',
              status: 'failed',
              createdAt: '2026-09-01T13:42:00.000Z',
              updatedAt: '2026-09-01T13:43:00.000Z',
            },
            run: {
              runId: 'run-boundary',
              status: 'failed',
              createdAt: '2026-09-01T13:42:00.000Z',
              updatedAt: '2026-09-01T13:43:00.000Z',
            },
          }),
        },
        github: { find: async () => undefined },
        r2: { get: async () => undefined },
        workflow: {
          find: async () => ({
            id: 'run-boundary',
            events: [
              {
                at: '2026-09-01T13:44:00.000Z',
                type: 'WorkflowInternalError',
                status: 'failed',
                reason: 'later workflow failure',
              },
            ],
          }),
        },
      }),
    ) as Record<string, unknown>;

    expect(report).toMatchObject({
      firstFailureBoundary: {
        source: 'd1',
        at: '2026-09-01T13:43:00.000Z',
        reason: 'run failed',
      },
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
            deliveryId: '78b779d0-a60a-11f1-98e0-24c70cb57033',
            repositoryId: 40348075,
            pullRequestNumber: 42,
            baseSha: 'b25ed2f03dfa66413e2c0ad602dd12996b193801',
            headSha: 'de0a8ff88634306bd05570e79bf12e5ce978f0ae',
            trigger: 'manual',
            status: 'failed',
            createdAt: '2026-09-01T13:38:55.390Z',
            updatedAt: '2026-09-01T13:44:02.799Z',
          },
          run: {
            runId,
            status: 'failed',
            runnerJobId: jobId,
            runnerAttempt: 1,
            createdAt: '2026-09-01T13:38:55.390Z',
            updatedAt: '2026-09-01T13:44:02.799Z',
            evidence: {
              key: `reviews/${runId}`,
              status: 'complete',
              size: 2389,
              sha256: '1a41ca811bcb1f50acff5ba8c036c2c7cb16d9199abf901be284dd839a0006f7',
              uploadedAt: '2026-09-01T16:48:52.000Z',
              executionStartedAt: '2026-09-01T13:39:02.004Z',
              submissionCompletedAt: '2026-09-01T13:44:14.615Z',
              cleanupCompletedAt: '2026-09-01T13:45:12.760Z',
            },
          },
        }),
      },
      github: {
        find: async () => ({
          repository: { owner: 'poooi', name: 'plugin-hensei-nikki', id: 40348075 },
          pullRequest: {
            state: 'open',
            baseSha: 'b25ed2f03dfa66413e2c0ad602dd12996b193801',
            headSha: 'de0a8ff88634306bd05570e79bf12e5ce978f0ae',
          },
          reactions: [],
          reviews: [],
        }),
      },
      r2: {
        get: async () => {
          const object = {
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
                  terminal: { status: 'succeeded' },
                  evidence: { id: evidenceId, status: 'complete' },
                  complete: true,
                  cleanup: { status: 'destroyed' },
                  startedAt: '2026-09-01T13:39:02.004Z',
                  finishedAt: '2026-09-01T13:45:12.760Z',
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
                      time: { end: '2026-09-01T13:44:14.615Z' },
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
                    messages: [
                      {
                        info: {
                          time: {
                            created: 1788270254639,
                            completed: 1788270257988,
                          },
                        },
                        parts: [],
                      },
                    ],
                  }),
                ),
              },
            },
          };
          return {
            key: `reviews/${runId}`,
            rawSize: 2389,
            rawSha256: '1a41ca811bcb1f50acff5ba8c036c2c7cb16d9199abf901be284dd839a0006f7',
            object,
          };
        },
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
        terminal: 'succeeded',
        evidence: 'complete',
        cleanup: 'destroyed',
      },
      evidence: {
        available: true,
        sessionId,
        timestamps: {
          submissionCompletedAt: '2026-09-01T13:44:14.615Z',
          terminalAt: '2026-09-01T13:44:17.988Z',
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
    let automatic = false;
    const command = {
      run: async (
        _executable: string,
        args: readonly string[],
        options?: DiagnosticCommandOptions,
      ) => {
        if (args.includes('workflows')) {
          const end = options?.env?.TZ === 'UTC' ? '9/1/2026, 1:44:02 PM' : '9/1/2026, 6:44:02 AM';
          return {
            exitCode: 0,
            stdout: [
              'Name: review-1',
              'Type: step',
              'Start: 9/1/2026, 1:43:58 PM',
              `End: ${end}`,
              'Status: errored',
              '┌─────────┬─────────┐',
              '│ Step    │ Status  │',
              '└─────────┴─────────┘',
              'WorkflowInternalError: Attempt failed due to internal workflows error',
            ].join('\n'),
          };
        }
        if (args.includes('repositories/42')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ full_name: 'poooi/plugin-hensei-nikki', id: 42 }),
          };
        }
        if (args.some((arg) => arg.includes('/pulls/7/reviews'))) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              [
                {
                  id: 301,
                  state: 'commented',
                  commit_id: '1111111111111111111111111111111111111111',
                },
              ],
              [
                {
                  id: 302,
                  state: 'approved',
                  commit_id: '2222222222222222222222222222222222222222',
                },
              ],
            ]),
          };
        }
        if (args.some((arg) => arg.includes('/issues/7/comments'))) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              [
                {
                  id: 101,
                  body: 'unrelated comment',
                  reactions: { url: 'https://api.github.com/reactions', total_count: 1, eyes: 1 },
                },
                {
                  id: 202,
                  body: '/ai-review',
                  created_at: '2026-09-01T13:00:00.000Z',
                  reactions: { url: 'https://api.github.com/reactions', total_count: 1, '-1': 1 },
                },
              ],
              [
                {
                  id: 303,
                  body: '/ai-review',
                  created_at: '2026-09-01T14:00:00.000Z',
                  reactions: {
                    url: 'https://api.github.com/reactions',
                    total_count: 1,
                    confused: 1,
                  },
                },
              ],
            ]),
          };
        }
        if (args.some((arg) => arg.includes('/pulls/7'))) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              state: 'open',
              base: { sha: '1111111111111111111111111111111111111111' },
              head: { sha: '2222222222222222222222222222222222222222' },
            }),
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
                    trigger: automatic ? 'automatic' : 'manual',
                    status: 'failed',
                    created_at: '2026-09-01T13:44:01.000Z',
                    updated_at: '2026-09-01T13:44:14.000Z',
                    run_id: 'f963a9fa-de77-4481-b482-0ba671e02468',
                    run_status: 'failed',
                    run_created_at: '2026-09-01T13:44:01.000Z',
                    run_updated_at: '2026-09-01T13:44:14.000Z',
                    runner_job_id: '5a7149b6-b99c-4cee-b47b-ff4ca39ecb49',
                    runner_attempt: 1,
                    comment_id: automatic ? null : 202,
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
      github: {
        available: true,
        trigger: { kind: 'manual', commentId: 202 },
        reactions: [{ content: '-1', count: 1 }],
        reviews: [
          {
            id: 301,
            state: 'commented',
            commitSha: '1111111111111111111111111111111111111111',
          },
          {
            id: 302,
            state: 'approved',
            commitSha: '2222222222222222222222222222222222222222',
          },
        ],
      },
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

    automatic = true;
    const automaticReport = JSON.parse(
      await runDiagnosticCommand(['f963a9fa-de77-4481-b482-0ba671e02468'], sources),
    ) as Record<string, unknown>;
    expect(automaticReport).toMatchObject({
      github: {
        available: true,
        trigger: { kind: 'automatic' },
        reactions: [],
      },
    });
  });

  it('reports only independently correlated evidence metadata', async () => {
    const runId = 'run-correlated';
    const jobId = 'job-correlated';
    const evidenceId = 'evidence-correlated';
    const sessionId = 'ses-correlated';
    type Override = {
      readonly key?: string;
      readonly rawSize?: number;
      readonly rawSha256?: string;
      readonly envelopeRunId?: string;
      readonly envelopeJobId?: string;
      readonly envelopeEvidenceId?: string;
      readonly exportSessionId?: string;
    };
    const makeSources = async (override: Override = {}): Promise<DiagnosticSources> => {
      const envelopeRunId = override.envelopeRunId ?? runId;
      const envelopeJobId = override.envelopeJobId ?? jobId;
      const envelopeEvidenceId = override.envelopeEvidenceId ?? evidenceId;
      const exportSessionId = override.exportSessionId ?? sessionId;
      const manifest = await artifact(
        JSON.stringify({
          jobId: envelopeJobId,
          runId: envelopeRunId,
          attempt: 1,
          evidenceId: envelopeEvidenceId,
          sandboxName: 'sandbox-correlated',
          sandboxId: 'sandbox-correlated',
          sessionIds: [sessionId],
          terminal: { status: 'succeeded' },
          evidence: { id: evidenceId, status: 'complete' },
          complete: true,
          cleanup: { status: 'destroyed' },
        }),
      );
      const opencodeJsonl = await artifact('');
      const opencodeStderr = await artifact('');
      const validatedReview = await artifact('review');
      const opencodeSessionList = await artifact(JSON.stringify([{ id: sessionId }]));
      const opencodeExport = await artifact(
        JSON.stringify({ info: { id: exportSessionId }, messages: [] }),
      );
      const object = {
        version: 1 as const,
        runId: envelopeRunId,
        jobId: envelopeJobId,
        evidenceId: envelopeEvidenceId,
        evidence: {
          id: evidenceId,
          status: 'complete' as const,
          manifest,
          opencodeJsonl,
          opencodeStderr,
          validatedReview,
          opencodeSessionList,
          opencodeExport: { sessionId: exportSessionId, content: opencodeExport },
        },
      };
      const raw = new TextEncoder().encode(JSON.stringify(object));
      const digest = await crypto.subtle.digest('SHA-256', raw);
      const rawSha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      return {
        d1: {
          find: async () => ({
            delivery: {
              deliveryId: 'delivery-correlated',
              repositoryId: 42,
              pullRequestNumber: 7,
              baseSha: null,
              headSha: null,
              trigger: 'automatic',
              status: 'completed',
              createdAt: '2026-09-01T00:00:00.000Z',
              updatedAt: '2026-09-01T00:00:00.000Z',
            },
            run: {
              runId,
              status: 'completed',
              runnerJobId: jobId,
              runnerAttempt: 1,
              createdAt: '2026-09-01T00:00:00.000Z',
              updatedAt: '2026-09-01T00:00:00.000Z',
              evidence: {
                key: 'reviews/run-correlated',
                status: 'complete',
                size: raw.byteLength,
                sha256: rawSha256,
                uploadedAt: '2026-09-01T00:00:00.000Z',
              },
            },
          }),
        },
        github: {
          find: async () => ({
            repository: { owner: 'poooi', name: 'repo', id: 42 },
            pullRequest: {
              state: 'open',
              baseSha: 'a'.repeat(40),
              headSha: 'b'.repeat(40),
            },
            reactions: [],
            reviews: [],
          }),
        },
        r2: {
          get: async () => ({
            key: override.key ?? 'reviews/run-correlated',
            rawSize: override.rawSize ?? raw.byteLength,
            rawSha256: override.rawSha256 ?? rawSha256,
            object,
          }),
        },
      };
    };
    const report = JSON.parse(
      await runDiagnosticCommand(['run:run-correlated'], await makeSources()),
    ) as Record<string, unknown>;
    expect(report).toMatchObject({ evidence: { available: true }, missingSources: [] });

    const cases: ReadonlyArray<{ readonly name: string; readonly override: Override }> = [
      { name: 'stale key', override: { key: 'reviews/old-run' } },
      { name: 'raw size mismatch', override: { rawSize: 1 } },
      { name: 'raw SHA-256 mismatch', override: { rawSha256: '0'.repeat(64) } },
      { name: 'envelope run ID mismatch', override: { envelopeRunId: 'other-run' } },
      { name: 'envelope Job ID mismatch', override: { envelopeJobId: 'other-job' } },
      { name: 'evidence identity mismatch', override: { envelopeEvidenceId: 'other-evidence' } },
      {
        name: 'exported session is absent from the session list',
        override: { exportSessionId: 'other-session' },
      },
    ];
    for (const { name, override } of cases) {
      const overridden = JSON.parse(
        await runDiagnosticCommand(['run:run-correlated'], await makeSources(override)),
      ) as Record<string, unknown>;
      expect(overridden, name).toMatchObject({ evidence: { available: false } });
      expect(overridden.missingSources, name).toContain('r2');
    }
  });
});

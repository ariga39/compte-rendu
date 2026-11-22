import type { PublicTaskState } from '@compte-rendu/contracts';

type PublicIdentity = Extract<PublicTaskState['identity'], { kind: 'public' }>;

export const publicIdentity = (overrides: Partial<PublicIdentity> = {}): PublicIdentity => ({
  kind: 'public',
  repositoryFullName: 'acme/widgets',
  pullRequestNumber: 7,
  pullRequestUrl: 'https://github.com/acme/widgets/pull/7',
  expiresAt: '2999-01-01T00:00:00.000Z',
  baseRef: 'main',
  headRef: 'feature/decision',
  baseSha: '1'.repeat(40),
  headSha: '2'.repeat(40),
  ...overrides,
});

export const publicTask = (
  runId: string,
  overrides: Partial<PublicTaskState> = {},
): PublicTaskState => ({
  runId,
  status: 'completed',
  dispatch: null,
  stage: null,
  processing: null,
  decision: null,
  identity: publicIdentity(),
  receivedAt: '2026-10-16T12:00:00.000Z',
  claimedAt: null,
  terminalAt: null,
  executionStartedAt: null,
  submissionCompletedAt: null,
  cleanupCompletedAt: null,
  resultReceivedAt: null,
  publicationStartedAt: null,
  lastProgressAt: null,
  queueWaitMs: null,
  totalDurationMs: null,
  cleanup: 'destroyed',
  failure: null,
  ...overrides,
});

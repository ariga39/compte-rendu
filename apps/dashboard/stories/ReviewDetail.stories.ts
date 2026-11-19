import type { Meta, StoryObj } from '@storybook/svelte-vite';
import type { PublicTaskDetail, PublicTaskState } from '@compte-rendu/contracts';
import { publicTask } from '../tests/sample-task.ts';
import ReviewDetail from './ReviewDetail.svelte';

const meta = {
  title: 'Reviews/Task detail',
  component: ReviewDetail,
  args: { variant: 'page', operator: false },
  argTypes: {
    variant: { control: 'radio', options: ['page', 'drawer'] },
    runId: { control: false },
    operator: { control: 'boolean' },
  },
} satisfies Meta<typeof ReviewDetail>;
export default meta;
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16, 12, 0, seconds)).toISOString();
const claimed = {
  claimedAt: at(4),
  executionStartedAt: at(6),
  lastProgressAt: at(16),
  queueWaitMs: 4000,
};
const records = [
  { stage: 'checkout', startedAt: at(6) },
  { stage: 'agent', startedAt: at(16) },
] as const;
function scenario(
  id: string,
  state: Partial<PublicTaskState>,
  extra: Partial<Pick<PublicTaskDetail, 'usage'>> = {},
): StoryObj<typeof meta> {
  const task = publicTask(id, state);
  const data: PublicTaskDetail = {
    generatedAt: at(100),
    task,
    milestones: task.executionStartedAt ? [...records] : [],
    processingMilestones: [],
    ...extra,
  };
  return {
    args: { runId: id },
    beforeEach() {
      const original = window.fetch;
      window.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input, location.href);
        if (url.origin === location.origin && url.pathname === '/api/jobs/' + id)
          return Promise.resolve(Response.json(data));
        return original.call(window, input, init);
      };
      return () => {
        window.fetch = original;
      };
    },
  };
}
export const Queued = scenario('queued', {
  status: 'scheduled',
  dispatch: 'queued',
  cleanup: 'unknown',
});
export const Reviewing = scenario('reviewing', {
  ...claimed,
  status: 'scheduled',
  dispatch: 'claimed',
  stage: 'agent',
  cleanup: 'pending',
});
export const Publishing = scenario('publishing', {
  ...claimed,
  status: 'scheduled',
  dispatch: 'claimed',
  processing: 'publishing',
  resultReceivedAt: at(70),
  publicationStartedAt: at(72),
});
export const Failed = scenario('failed', {
  ...claimed,
  status: 'failed',
  failure: { phase: 'agent', reason: 'upstream', httpStatus: 503 },
  terminalAt: at(55),
  totalDurationMs: 55000,
});
export const Superseded = scenario('superseded', {
  status: 'superseded',
  terminalAt: at(2),
  totalDurationMs: 2000,
});
export const Cancellable = {
  ...scenario('cancellable', {
    ...claimed,
    status: 'scheduled',
    dispatch: 'claimed',
    stage: 'agent',
    cleanup: 'pending',
  }),
  args: { runId: 'cancellable', variant: 'page', operator: true },
} satisfies StoryObj<typeof meta>;
export const Cancelling = scenario('cancelling', {
  ...claimed,
  status: 'cancelled',
  dispatch: null,
  terminalAt: at(50),
  totalDurationMs: 50000,
  cleanup: 'pending',
});
export const Cancelled = scenario('cancelled', {
  ...claimed,
  status: 'cancelled',
  dispatch: null,
  terminalAt: at(50),
  cleanupCompletedAt: at(52),
  totalDurationMs: 50000,
  cleanup: 'destroyed',
});
export const CancelledCleanupFailed = scenario('cancelled-cleanup-failed', {
  ...claimed,
  status: 'cancelled',
  dispatch: null,
  terminalAt: at(50),
  totalDurationMs: 50000,
  cleanup: 'failed',
});
export const Anonymous = scenario('anonymous', {
  ...claimed,
  identity: { kind: 'anonymous' },
  decision: 'request_changes',
  terminalAt: at(80),
  totalDurationMs: 80000,
});
export const Historical = scenario('historical', {});
const identity = publicTask('sample').identity;
export const Published = scenario(
  'published',
  {
    ...claimed,
    identity:
      identity.kind === 'public'
        ? { ...identity, headRef: 'feature/review-long-branch-name-in-compact-layouts' }
        : identity,
    decision: 'approve',
    resultReceivedAt: at(70),
    publicationStartedAt: at(72),
    terminalAt: at(80),
    totalDurationMs: 80000,
  },
  {
    usage: {
      version: 1,
      models: [
        {
          route: 'reviewer',
          model: 'example/long-review-model-name-for-narrow-layouts',
          requests: 1,
          incompleteRequests: 0,
          inputTokens: { total: 1200, reportedRequests: 1 },
          uncachedInputTokens: { total: 300, reportedRequests: 1 },
          cacheReadTokens: { total: 900, reportedRequests: 1 },
          cacheWriteTokens: null,
          outputTokens: { total: 80, reportedRequests: 1 },
          reasoningTokens: null,
        },
      ],
    },
  },
);

export const NarrowDrawer: StoryObj<typeof meta> = {
  ...Published,
  args: { runId: 'published', variant: 'drawer' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

import type { PublicMilestone, PublicTaskState } from '@compte-rendu/contracts';
import { startHarness } from './fixture-server.ts';
import { publicTask } from './sample-task.ts';

const now = Date.now();
const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
const claimed = {
  receivedAt: at(120),
  claimedAt: at(114),
  executionStartedAt: at(112),
  lastProgressAt: at(84),
  queueWaitMs: 6000,
};
const milestones: PublicMilestone[] = [
  { stage: 'checkout', startedAt: at(112) },
  { stage: 'sandbox', startedAt: at(100) },
  { stage: 'agent', startedAt: at(84) },
];
const tasks = [
  publicTask('queued', {
    receivedAt: at(8),
    status: 'scheduled',
    dispatch: 'queued',
    cleanup: 'unknown',
  }),
  publicTask('reviewing', {
    ...claimed,
    status: 'scheduled',
    dispatch: 'claimed',
    stage: 'agent',
    cleanup: 'pending',
  }),
  publicTask('failed', {
    ...claimed,
    status: 'failed',
    terminalAt: at(60),
    totalDurationMs: 60000,
    failure: { phase: 'agent', reason: 'upstream', httpStatus: 503 },
  }),
  publicTask('published', {
    ...claimed,
    decision: 'approve',
    terminalAt: at(24),
    publicationStartedAt: at(30),
    totalDurationMs: 96000,
  }),
  publicTask('anonymous', {
    ...claimed,
    identity: { kind: 'anonymous' },
    decision: 'request_changes',
    terminalAt: at(10),
    totalDurationMs: 110000,
  }),
];
const statusOf = (task: PublicTaskState) =>
  task.dispatch === 'claimed'
    ? 'in_progress'
    : (task.dispatch ?? (task.status === 'completed' ? 'published' : task.status));
const { harness } = await startHarness(4174, false);
harness.setHandler((url) => {
  const generatedAt = new Date().toISOString();
  if (url.pathname === '/api/dashboard')
    return {
      status: 200,
      json: {
        generatedAt,
        tasks: tasks.filter((task) => task.dispatch),
        nextCursor: null,
        counts: { queued: 1, claimed: 1, publishedLast24h: 2, failedLast24h: 1 },
        cleanupAttention: 0,
      },
    };
  if (url.pathname === '/api/jobs') {
    const status = url.searchParams.get('status');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const selected = tasks.filter(
      (task) =>
        (!status || statusOf(task) === status) &&
        (!from || task.receivedAt >= from) &&
        (!to || task.receivedAt <= to),
    );
    return { status: 200, json: { generatedAt, nextCursor: null, tasks: selected } };
  }
  const task = tasks.find((entry) => url.pathname === '/api/jobs/' + entry.runId);
  return task
    ? {
        status: 200,
        json: {
          generatedAt,
          task,
          milestones: task.claimedAt ? milestones : [],
          processingMilestones: [],
        },
      }
    : { status: 404 };
});
console.log('Dashboard fixture preview: ' + harness.base + '/history');

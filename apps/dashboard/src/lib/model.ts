import {
  EffortName,
  EffortRouteSummary,
  ModelRouteId,
  PublicHistoryPage,
  PublicDashboardSnapshot,
  PublicTaskDetail,
} from '@compte-rendu/contracts';
import { Schema } from 'effect';
import { PollError, type ApiResult } from './api';
import { isCancelling } from './format.ts';
import type {
  DatedTask,
  DetailModel,
  HistoryModel,
  OverviewModel,
  PublicIdentity,
  TaskDetail,
  TaskState,
  TimelineStage,
} from './types';

export interface Timing {
  dispatchAt: number;
  observedAt: number;
}

function decodeOverview(data: unknown) {
  try {
    return Schema.decodeUnknownSync(PublicDashboardSnapshot)(data);
  } catch {
    throw new PollError();
  }
}

function decodeHistoryPage(data: unknown) {
  try {
    return Schema.decodeUnknownSync(PublicHistoryPage)(data);
  } catch {
    throw new PollError();
  }
}

const DetailEfforts = Schema.Struct({
  selection: Schema.Array(
    Schema.Struct({
      route: ModelRouteId,
      name: Schema.NullOr(EffortName),
      generation: Schema.Natural,
    }),
  ),
  summary: Schema.NullOr(Schema.Array(EffortRouteSummary)),
});
const TaskDetailWithEfforts = Schema.Struct({
  ...PublicTaskDetail.fields,
  efforts: Schema.optionalKey(Schema.NullOr(DetailEfforts)),
});

function decodeTaskDetail(data: unknown): TaskDetail {
  try {
    return Schema.decodeUnknownSync(TaskDetailWithEfforts)(data) as TaskDetail;
  } catch {
    throw new PollError();
  }
}

export function decorateTask(task: TaskState, generatedAt: string, timing: Timing): DatedTask {
  const identity = task.identity.kind === 'public' ? task.identity : null;
  const serverNow = Date.parse(generatedAt);
  const lifetime = identity ? Date.parse(identity.expiresAt) - serverNow : Number.NaN;
  const requestElapsed = Math.max(0, timing.observedAt - timing.dispatchAt);
  return {
    ...task,
    identity_: identity,
    remainingMs: identity && !Number.isNaN(lifetime) ? Math.max(0, lifetime - requestElapsed) : 0,
    observedAt: timing.observedAt,
  };
}

export function decorateTasks(
  tasks: readonly TaskState[],
  generatedAt: string,
  timing: Timing,
): DatedTask[] {
  return tasks.map((task) => decorateTask(task, generatedAt, timing));
}

export function liveIdentity(task: DatedTask, now: number): PublicIdentity | null {
  if (!task.identity_) return null;
  return now - task.observedAt < task.remainingMs ? task.identity_ : null;
}

export function identityDeadline(task: DatedTask): number {
  return task.observedAt + task.remainingMs;
}

export function isTaskActive(task: TaskState): boolean {
  return (
    task.status === 'scheduled' ||
    task.dispatch === 'claimed' ||
    task.processing != null ||
    task.cleanup === 'pending' ||
    isCancelling(task)
  );
}

export function buildOverview(result: ApiResult, timing: Timing): OverviewModel {
  const overview = decodeOverview(result.data);
  return {
    kind: 'overview',
    overview,
    current: {
      tasks: decorateTasks(overview.tasks, overview.generatedAt, timing),
      nextCursor: overview.nextCursor,
    },
  };
}

export function overviewActive(model: OverviewModel): boolean {
  return model.current.tasks.some(isTaskActive);
}

export function buildHistory(result: ApiResult, timing: Timing): HistoryModel {
  const page = decodeHistoryPage(result.data);
  return {
    kind: 'history',
    page: {
      generatedAt: page.generatedAt,
      tasks: decorateTasks(page.tasks, page.generatedAt, timing),
      nextCursor: page.nextCursor,
    },
  };
}

export function historyActive(model: HistoryModel): boolean {
  return model.page.tasks.some(isTaskActive);
}

export function buildDetail(result: ApiResult, timing: Timing): DetailModel {
  const detail = decodeTaskDetail(result.data);
  return {
    kind: 'detail',
    detail,
    task: decorateTask(detail.task, detail.generatedAt, timing),
  };
}

export function detailActive(model: DetailModel): boolean {
  return isTaskActive(model.task);
}

export interface TimelineEntry {
  stage: TimelineStage;
  startedAt: string;
}

export function mergeMilestones(detail: TaskDetail): TimelineEntry[] {
  const recorded: TimelineEntry[] = [...detail.milestones, ...(detail.processingMilestones ?? [])];
  if (detail.task.resultReceivedAt) {
    recorded.push({ stage: 'received', startedAt: detail.task.resultReceivedAt });
  }
  if (detail.task.publicationStartedAt) {
    recorded.push({ stage: 'publishing', startedAt: detail.task.publicationStartedAt });
  }
  const task = detail.task;
  if (task.status === 'cancelled') {
    if (task.terminalAt) recorded.push({ stage: 'cancelled', startedAt: task.terminalAt });
    if (task.cleanupCompletedAt && (task.cleanup === 'destroyed' || task.cleanup === 'failed')) {
      recorded.push({
        stage: task.cleanup === 'destroyed' ? 'cleanup-confirmed' : 'cleanup-failed',
        startedAt: task.cleanupCompletedAt,
      });
    }
  }
  const seen = new Set<string>();
  return recorded
    .filter((entry) => entry.stage && entry.startedAt)
    .filter((entry) => {
      const key = `${entry.stage}@${entry.startedAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

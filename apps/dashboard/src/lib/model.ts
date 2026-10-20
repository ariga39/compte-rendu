import {
  PublicHistoryPage,
  PublicDashboardSnapshot,
  PublicTaskDetail,
} from '@compte-rendu/contracts';
import { Schema } from 'effect';
import { PollError, type ApiResult } from './api';
import type {
  DatedTask,
  DetailModel,
  HistoryModel,
  OverviewModel,
  PublicIdentity,
  TaskDetail,
  TaskState,
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

function decodeTaskDetail(data: unknown) {
  try {
    return Schema.decodeUnknownSync(PublicTaskDetail)(data);
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
    task.cleanup === 'pending'
  );
}

export function buildOverview(results: ApiResult[], timing: Timing): OverviewModel {
  const overview = decodeOverview(results[0]?.data);
  const current = overview;
  return {
    kind: 'overview',
    overview,
    current: {
      tasks: decorateTasks(current.tasks, current.generatedAt, timing),
      nextCursor: current.nextCursor,
    },
  };
}

export function overviewActive(model: OverviewModel): boolean {
  return model.current.tasks.some(isTaskActive);
}

export function buildHistory(results: ApiResult[], timing: Timing): HistoryModel {
  const page = decodeHistoryPage(results[0]?.data);
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

export function buildDetail(results: ApiResult[], timing: Timing): DetailModel {
  const detail = decodeTaskDetail(results[0]?.data);
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
  stage: string;
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

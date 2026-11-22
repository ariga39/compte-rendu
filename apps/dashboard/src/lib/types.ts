import type {
  PublicMilestone,
  PublicOverview,
  PublicTaskDetail,
  PublicTaskIdentity,
  PublicTaskState,
} from '@compte-rendu/contracts';

export type TaskState = PublicTaskState;
export type PublicIdentity = Extract<PublicTaskIdentity, { kind: 'public' }>;
export type Overview = PublicOverview;
export type TaskDetail = PublicTaskDetail;

export type TimelineStage =
  | PublicMilestone['stage']
  | 'received'
  | 'publishing'
  | 'cancelled'
  | 'cleanup-confirmed'
  | 'cleanup-failed';

export type StatusFilter =
  | 'all'
  | 'queued'
  | 'in_progress'
  | 'published'
  | 'failed'
  | 'superseded'
  | 'cancelled';

export interface Filters {
  status: StatusFilter;
  from: string | null;
  to: string | null;
  fromDate: string | null;
  toDate: string | null;
  cursor: string | null;
}

export interface DatedTask extends TaskState {
  identity_: PublicIdentity | null;
  remainingMs: number;
  observedAt: number;
}

export interface OverviewModel {
  kind: 'overview';
  overview: Overview;
  current: { tasks: DatedTask[]; nextCursor: string | null };
}

export interface HistoryModel {
  kind: 'history';
  page: { generatedAt: string; tasks: DatedTask[]; nextCursor: string | null };
}

export interface DetailModel {
  kind: 'detail';
  detail: TaskDetail;
  task: DatedTask;
}

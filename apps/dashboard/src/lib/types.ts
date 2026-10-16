import type {
  PublicCleanupStatus,
  PublicExecutionStage,
  PublicHistoryPage,
  PublicMilestone,
  PublicOverview,
  PublicProcessing,
  PublicTaskDetail,
  PublicTaskDispatch,
  PublicTaskFailure,
  PublicTaskIdentity,
  PublicTaskState,
  PublicTaskStatus,
} from '@compte-rendu/contracts';

export type TaskState = PublicTaskState;
export type TaskStatus = PublicTaskStatus;
export type TaskDispatch = PublicTaskDispatch;
export type ExecutionStage = PublicExecutionStage;
export type CleanupStatus = PublicCleanupStatus;
export type ProcessingState = PublicProcessing;
export type TaskIdentity = PublicTaskIdentity;
export type TaskFailure = PublicTaskFailure;
export type PublicIdentity = Extract<PublicTaskIdentity, { kind: 'public' }>;
export type Overview = PublicOverview;
export type HistoryPage = PublicHistoryPage;
export type Milestone = PublicMilestone;
export type ProcessingMilestone = PublicTaskDetail['processingMilestones'][number];
export type TaskDetail = PublicTaskDetail;

export type ProcessingStage = 'received' | 'publishing';

export type StatusFilter = 'all' | 'queued' | 'in_progress' | 'published' | 'failed' | 'superseded';

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

export type DashboardModel = OverviewModel | HistoryModel | DetailModel;

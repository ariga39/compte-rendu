import type {
  CleanupStatus,
  ExecutionStage,
  ProcessingStage,
  TaskFailure,
  TaskState,
} from './types';

export const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Queued',
  completed: 'Published',
  failed: 'Failed',
  superseded: 'Superseded',
};

export const STAGE_LABEL: Record<string, string> = {
  checkout: 'Checkout',
  sandbox: 'Preparing sandbox',
  agent: 'Reviewing',
  evidence: 'Archiving evidence',
  cleanup: 'Cleaning up',
};

export const PROCESSING_STAGE_LABEL: Record<string, string> = {
  received: 'Result received',
  publishing: 'Publishing',
};

export const CLEANUP_LABEL: Record<string, string> = {
  pending: 'Cleanup pending',
  destroyed: 'Cleanup complete',
  failed: 'Cleanup failed',
  unknown: 'Cleanup not recorded',
};

export const PROCESSING_LABEL: Record<string, string> = {
  received: 'Processing result',
  publishing: 'Publishing',
};

export type BadgeTone = 'info' | 'good' | 'bad' | 'warn' | 'muted';

export const STATUS_TONE: Record<string, BadgeTone> = {
  completed: 'good',
  failed: 'bad',
  superseded: 'warn',
  scheduled: 'info',
};

export const CLEANUP_TONE: Record<string, BadgeTone> = {
  destroyed: 'good',
  failed: 'bad',
  pending: 'warn',
  unknown: 'muted',
};

export function milestoneLabel(stage: ExecutionStage | ProcessingStage): string {
  return STAGE_LABEL[stage] ?? PROCESSING_STAGE_LABEL[stage] ?? stage;
}

export function statusLabel(task: TaskState): string {
  if (task.dispatch === 'claimed') return 'Claimed';
  if (task.dispatch === 'queued') return 'Queued';
  return STATUS_LABEL[task.status] ?? task.status;
}

export function statusTone(task: TaskState): BadgeTone {
  if (task.dispatch) return 'info';
  return STATUS_TONE[task.status] ?? 'info';
}

export function cleanupTone(cleanup: CleanupStatus): BadgeTone {
  return CLEANUP_TONE[cleanup] ?? 'muted';
}

export function cleanupLabel(cleanup: CleanupStatus): string {
  return CLEANUP_LABEL[cleanup] ?? cleanup;
}

export function cleanupNote(cleanup: CleanupStatus): string {
  if (cleanup === 'destroyed') return 'Assigned resources were confirmed destroyed.';
  if (cleanup === 'failed') return 'Cleanup failed; resources may still be held.';
  if (cleanup === 'pending') return 'Cleanup is still pending for this task.';
  return 'Cleanup was not recorded for this task.';
}

export function taskLabel(task: TaskState): string {
  if (task.processing) return PROCESSING_LABEL[task.processing] ?? 'Processing result';
  if (task.dispatch === 'claimed') {
    return task.stage ? (STAGE_LABEL[task.stage] ?? task.stage) : 'Claimed; awaiting progress';
  }
  if (task.dispatch === 'queued') return 'Queued';
  return STATUS_LABEL[task.status] ?? task.status;
}

export function progressText(task: TaskState): string {
  return task.lastProgressAt
    ? `Last progress report ${relativeTime(task.lastProgressAt)}`
    : `No progress report; claimed ${relativeTime(task.claimedAt)}`;
}

export function outcomeSummary(task: TaskState): string {
  if (task.processing) return PROCESSING_LABEL[task.processing] ?? 'Processing result';
  if (task.dispatch === 'claimed') {
    return task.stage
      ? `In progress: ${STAGE_LABEL[task.stage] ?? task.stage}.`
      : 'Claimed; awaiting progress.';
  }
  if (task.dispatch === 'queued') return 'Queued. No exact position or start time is promised.';
  if (task.status === 'completed') return 'Published. Core durably recorded the review.';
  if (task.status === 'failed') return task.failure ? `Failed (${task.failure.phase}).` : 'Failed.';
  if (task.status === 'superseded') return 'Superseded by a newer revision before publication.';
  return STATUS_LABEL[task.status] ?? 'Not recorded';
}

export function failureSummary(failure: TaskFailure): string {
  return `Failure category: ${failure.phase}`;
}

export function absoluteTime(value: string | null | undefined): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return 'Not recorded';
  const elapsed = Date.now() - new Date(value).getTime();
  if (Number.isNaN(elapsed)) return 'Not recorded';
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return 'Not recorded';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

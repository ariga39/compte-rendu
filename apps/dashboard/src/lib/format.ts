import type { ExecutionStage, ProcessingStage, TaskState } from './types.ts';

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

export function milestoneLabel(stage: ExecutionStage | ProcessingStage): string {
  return STAGE_LABEL[stage] ?? PROCESSING_STAGE_LABEL[stage] ?? stage;
}

export function statusLabel(task: TaskState): string {
  if (task.dispatch === 'claimed') return 'In progress';
  if (task.dispatch === 'queued') return 'Queued';
  return STATUS_LABEL[task.status] ?? task.status;
}

export function statusTone(task: TaskState): BadgeTone {
  if (task.dispatch) return 'info';
  return STATUS_TONE[task.status] ?? 'info';
}

export function cleanupLabel(task: TaskState): string {
  if (task.cleanup === 'destroyed') return 'Cleaned up';
  if (task.cleanup === 'failed') return 'Cleanup failed';
  if (task.cleanup === 'unknown') return 'Cleanup not recorded';
  if (task.status === 'scheduled') {
    return task.stage === 'cleanup' ? 'Cleaning up' : 'Cleanup after review';
  }
  return 'Cleanup pending';
}

export function cleanupTone(task: TaskState): BadgeTone {
  if (task.cleanup === 'destroyed') return 'good';
  if (task.cleanup === 'failed') return 'bad';
  if (task.cleanup === 'unknown') return 'muted';
  if (task.status === 'scheduled') return task.stage === 'cleanup' ? 'info' : 'muted';
  return 'warn';
}

export function cleanupNote(task: TaskState): string {
  if (task.cleanup === 'destroyed') return 'Cleanup was confirmed.';
  if (task.cleanup === 'failed') return 'Cleanup failed and needs an operator.';
  if (task.cleanup === 'unknown') return 'Cleanup was not recorded for this review.';
  if (task.status === 'scheduled') {
    return task.stage === 'cleanup'
      ? 'Resource cleanup has started; confirmation is pending.'
      : 'Cleanup is confirmed after the review ends. This is expected while a review is in progress.';
  }
  return 'This review has ended, but resource cleanup has not been confirmed.';
}

export function taskLabel(task: TaskState): string {
  if (task.processing) return PROCESSING_LABEL[task.processing] ?? 'Processing result';
  if (task.dispatch === 'claimed') {
    return task.stage ? (STAGE_LABEL[task.stage] ?? task.stage) : 'In progress';
  }
  if (task.dispatch === 'queued') return 'Queued';
  return STATUS_LABEL[task.status] ?? task.status;
}

export function progressText(task: TaskState): string {
  return task.lastProgressAt
    ? `Last progress update ${relativeTime(task.lastProgressAt)}`
    : `Awaiting first update · accepted ${relativeTime(task.claimedAt)}`;
}

export function outcomeSummary(task: TaskState): string {
  if (task.processing) return PROCESSING_LABEL[task.processing] ?? 'Processing result';
  if (task.dispatch === 'claimed') {
    return task.stage
      ? `In progress: ${STAGE_LABEL[task.stage] ?? task.stage}.`
      : 'In progress; awaiting first progress update.';
  }
  if (task.dispatch === 'queued') return 'Waiting to start.';
  if (task.status === 'completed') return 'Review published to GitHub.';
  if (task.status === 'failed') return 'Review ended with an error.';
  if (task.status === 'superseded') return 'A newer revision replaced this review.';
  return STATUS_LABEL[task.status] ?? 'Not recorded';
}

export const FAILURE_PHASE_LABEL: Record<string, string> = {
  scheduling: 'Scheduling',
  checkout: 'Checkout',
  sandbox: 'Sandbox preparation',
  agent: 'Review',
  output_validation: 'Output validation',
  evidence: 'Evidence handling',
  callback: 'Result callback',
  publication: 'GitHub publication',
  cleanup: 'Cleanup',
  unknown: 'Failure reason not recorded',
};

export const FAILURE_REASON_LABEL: Record<string, string> = {
  checkout: 'Checkout could not be completed',
  sandbox: 'The sandbox could not be prepared',
  agent: 'The review agent did not complete',
  timeout: 'The review timed out',
  invalid_output: 'The submitted output was not valid',
  evidence: 'Evidence could not be stored',
  cleanup: 'Cleanup could not be completed',
  callback: 'The result could not be delivered',
  marker_lookup_failed: 'Could not verify an earlier publication',
  publication_uncertain: 'Publication could not be confirmed',
  completion_failed: 'Completion could not be confirmed',
  unknown: 'Reason not recorded',
};

export function failurePhaseLabel(phase: string): string {
  return FAILURE_PHASE_LABEL[phase] ?? 'Failure reason not recorded';
}

export function failureReasonLabel(reason: string): string {
  return FAILURE_REASON_LABEL[reason] ?? 'Reason not recorded';
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

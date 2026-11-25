import type { RunnerJobResponse } from '@compte-rendu/contracts';

export interface JobHandleInput {
  readonly id: string;
  readonly runId: string;
  readonly attempt: number;
  readonly repositoryName: string;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly admissionKey: string;
  readonly claimDeadlineAt: number;
  readonly state: RunnerJobResponse;
  readonly abortRequested: boolean;
}

export interface JobHandle {
  readonly id: string;
  readonly runId: string;
  readonly attempt: number;
  readonly repositoryName: string;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly admissionKey: string;
  readonly claimDeadlineAt: number;
  readonly state: RunnerJobResponse;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  abortRequested: boolean;
  cleanupRecoveryPending: boolean;
  cleanupRecoveryRetryAt?: number;
  abort(): void;
  setAbortHandler(handler: (() => void) | undefined): void;
}

export const createJobHandle = (input: JobHandleInput): JobHandle => {
  let abortHandler: (() => void) | undefined;
  let resolveDone = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    id: input.id,
    runId: input.runId,
    attempt: input.attempt,
    repositoryName: input.repositoryName,
    pullRequestNumber: input.pullRequestNumber,
    baseSha: input.baseSha,
    headSha: input.headSha,
    admissionKey: input.admissionKey,
    claimDeadlineAt: input.claimDeadlineAt,
    state: input.state,
    done,
    resolveDone,
    abortRequested: input.abortRequested,
    cleanupRecoveryPending: false,
    abort() {
      this.abortRequested = true;
      abortHandler?.();
    },
    setAbortHandler(handler) {
      abortHandler = handler;
    },
  };
};

export const createJobRegistry = () => {
  const jobs = new Map<string, JobHandle>();
  const jobsByRun = new Map<string, JobHandle>();
  const values = () => [...jobs.values()];
  return {
    add(job: JobHandle) {
      jobs.set(job.id, job);
      jobsByRun.set(`${job.runId}:${job.attempt}`, job);
    },
    get(id: string) {
      return jobs.get(id);
    },
    getByRun(runId: string, attempt: number) {
      return jobsByRun.get(`${runId}:${attempt}`);
    },
    values,
    findActiveMatch(input: {
      readonly jobId: string;
      readonly runId: string;
      readonly attempt: number;
      readonly evidenceId: string;
    }) {
      return values().some(
        (job) =>
          (job.state.status === 'queued' || job.state.status === 'running') &&
          (job.id === input.jobId ||
            (job.runId === input.runId && job.attempt === input.attempt) ||
            job.state.evidenceId === input.evidenceId),
      );
    },
    retireDestroyed(job: JobHandle) {
      if (job.state.sandbox.cleanup !== 'destroyed') return;
      jobs.delete(job.id);
      jobsByRun.delete(`${job.runId}:${job.attempt}`);
    },
    activeCount() {
      return values().filter(
        (job) => job.state.status === 'queued' || job.state.status === 'running',
      ).length;
    },
    cleanupBlockedCount() {
      return values().filter(
        (job) =>
          (job.state.status === 'succeeded' ||
            job.state.status === 'failed' ||
            job.state.status === 'aborted') &&
          job.state.sandbox.cleanup !== 'destroyed',
      ).length;
    },
    hasCapacity(limit: number, pendingClaim: boolean) {
      return this.activeCount() + (pendingClaim ? 1 : 0) < limit;
    },
    hasUnclearedSamePullRequest(input: {
      readonly repositoryName: string;
      readonly pullRequestNumber: number;
    }) {
      const now = Date.now();
      return values().some((candidate) => {
        if (candidate.state.sandbox.cleanup === 'destroyed') return false;
        if (
          candidate.repositoryName !== input.repositoryName ||
          candidate.pullRequestNumber !== input.pullRequestNumber
        )
          return false;
        // Live executions always serialize. A retained terminal execution only
        // blocks until its durable claim budget expires, matching Core's fallback.
        if (candidate.state.status === 'queued' || candidate.state.status === 'running')
          return true;
        return candidate.claimDeadlineAt > now;
      });
    },
    isLive(jobId: string, closed: boolean) {
      if (closed) return true;
      const job = jobs.get(jobId);
      return job !== undefined && (job.state.status === 'queued' || job.state.status === 'running');
    },
  };
};

export type JobRegistry = ReturnType<typeof createJobRegistry>;

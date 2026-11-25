import type { RunnerProgressSnapshot, RunnerProgressStage } from '@compte-rendu/contracts';
import { currentIso } from './runner-clock.js';

export interface ProgressIdentity {
  readonly id: string;
  readonly runId: string;
  readonly attempt: number;
}

export interface ProgressReporterOptions {
  readonly identity: ProgressIdentity;
  readonly callbackUrl?: string | undefined;
  readonly callbackToken?: string | undefined;
  readonly fetch: typeof fetch;
  readonly runtime: () => string;
}

export interface ProgressReporter {
  readonly snapshot: RunnerProgressSnapshot | undefined;
  stage(stage: RunnerProgressStage): void;
  stop(): void;
}

export const createProgressReporter = (options: ProgressReporterOptions): ProgressReporter => {
  let lifecycle: RunnerProgressSnapshot | undefined;
  let pending: RunnerProgressSnapshot | undefined;
  let controller: AbortController | undefined;
  let stopped = false;

  const send = async (): Promise<void> => {
    if (
      stopped ||
      controller !== undefined ||
      options.callbackUrl === undefined ||
      options.callbackToken === undefined
    )
      return;
    const snapshot = pending;
    if (snapshot === undefined) return;
    pending = undefined;
    const active = new AbortController();
    controller = active;
    const timeout = setTimeout(() => active.abort(), 2_000);
    try {
      await Promise.race([
        options
          .fetch(new URL('/runner-progress', options.callbackUrl).toString(), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.callbackToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              id: options.identity.id,
              runId: options.identity.runId,
              attempt: options.identity.attempt,
              ...snapshot,
            }),
            signal: active.signal,
          })
          .then(async (response) => {
            await response.body?.cancel();
          }),
        new Promise<void>((resolve) =>
          active.signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      ]);
    } catch {
      // Progress is best effort; the terminal callback carries the cumulative snapshot.
    } finally {
      clearTimeout(timeout);
      controller = undefined;
      if (!stopped && pending !== undefined) void send();
    }
  };

  return {
    get snapshot() {
      return lifecycle;
    },
    stage(stage) {
      if (stopped || lifecycle?.milestones.some((entry) => entry.stage === stage)) return;
      const snapshot: RunnerProgressSnapshot = {
        sequence: (lifecycle?.sequence ?? 0) + 1,
        stage,
        milestones: [
          ...(lifecycle?.milestones ?? []),
          {
            stage,
            ...(stage === 'sandbox' ? { runtime: options.runtime() } : {}),
            startedAt: currentIso(),
          },
        ],
      };
      lifecycle = snapshot;
      pending = snapshot;
      void send();
    },
    stop() {
      stopped = true;
      pending = undefined;
      controller?.abort();
    },
  };
};

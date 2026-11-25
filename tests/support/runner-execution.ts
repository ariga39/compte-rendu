import type {
  RunnerJobInput,
  RunnerJobResponse,
  RunnerTerminalCallback,
} from '../../packages/contracts/src';

export interface ClaimExecutionOptions {
  readonly callbackRequests?: Request[];
  readonly callbackStatus?: (attempt: number) => number;
  readonly onClaim?: (request: Request) => void | Promise<void>;
  /** Simulated Core long-poll: wait for an enqueued job instead of returning 204. */
  readonly longPoll?: boolean;
}

const terminalStatuses = new Set(['succeeded', 'failed', 'aborted']);

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 10));

const stateFromCallback = (callback: RunnerTerminalCallback): RunnerJobResponse => ({
  id: callback.id,
  runId: callback.runId,
  attempt: callback.attempt,
  evidenceId: callback.evidence.id,
  evidence: { id: callback.evidence.id, status: callback.evidence.status },
  status: callback.status,
  stage: callback.stage,
  sandbox: callback.sandbox,
  ...(callback.status === 'succeeded' ? { result: callback.result } : {}),
  ...(callback.status === 'failed' ? { failure: callback.failure } : {}),
});

/**
 * The production Runner receives work only through the Core pull claim. This
 * fixture queue supplies immutable jobs to the real claim loop and retains the
 * real terminal callbacks; tests do not submit through the retired direct
 * `/jobs` route and do not reconstruct Runner execution.
 */
export const createClaimExecution = (options: ClaimExecutionOptions = {}) => {
  const queue: RunnerJobInput[] = [];
  const claimRequests: Request[] = [];
  const callbackRequests = options.callbackRequests ?? [];
  let readCallback = 0;
  let wakeClaim: (() => void) | undefined;
  const pendingTerminals: Array<{
    readonly callback: RunnerTerminalCallback;
    readonly terminal: RunnerJobResponse;
    readonly request: Request;
  }> = [];

  let stopped = false;
  const claimFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    claimRequests.push(request);
    await options.onClaim?.(request);
    let next = queue.shift();
    if (next === undefined && options.longPoll === true && !stopped) {
      const signal = init?.signal ?? request.signal;
      if (signal?.aborted !== true) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            wakeClaim = undefined;
            resolve();
          };
          wakeClaim = wake;
          signal?.addEventListener('abort', wake, { once: true });
        });
      }
      next = queue.shift();
    }
    return next === undefined ? new Response(null, { status: 204 }) : Response.json(next);
  };

  const callbackFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    callbackRequests.push(request);
    const status = options.callbackStatus?.(callbackRequests.length) ?? 202;
    return new Response(null, { status });
  };

  const waitForTerminal = async (id?: string) => {
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      while (readCallback < callbackRequests.length) {
        const request = callbackRequests[readCallback]!;
        readCallback += 1;
        const body = await request.text();
        const snapshot = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body,
        });
        callbackRequests[readCallback - 1] = snapshot;
        const callback = JSON.parse(body) as RunnerTerminalCallback;
        if (!terminalStatuses.has(callback.status)) continue;
        pendingTerminals.push({
          callback,
          terminal: stateFromCallback(callback),
          request: snapshot,
        });
      }
      const index = pendingTerminals.findIndex(
        (entry) => id === undefined || entry.callback.id === id,
      );
      if (index >= 0) return pendingTerminals.splice(index, 1)[0]!;
      await nextTick();
    }
    throw new Error(
      `Runner Job did not deliver a terminal callback (claims=${claimRequests.length}, callbacks=${callbackRequests.length})`,
    );
  };

  return {
    queue,
    claimRequests,
    callbackRequests,
    claimFetch,
    callbackFetch,
    enqueue(job: RunnerJobInput) {
      queue.push(job);
      const wake = wakeClaim;
      wakeClaim = undefined;
      wake?.();
    },
    stopClaims() {
      stopped = true;
      const wake = wakeClaim;
      wakeClaim = undefined;
      wake?.();
    },
    waitForTerminal,
  };
};

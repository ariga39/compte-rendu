import type { ReadTokenClient } from './read-token-client.js';
import type { JobSandbox } from './sandbox-runtime.js';

const READ_TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;
export const CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS = 60 * 1000;

export interface ReadTokenLeaseHost {
  /** Records the latest token on the job input after a successful refresh. */
  updateToken(token: string, expiresAt: number): void;
  /** Tightens the job deadline to the refreshed credential's safe expiry. */
  applyFallback(fallbackAt: number): void;
  /** Stops the active execution when the limiting credential expires. */
  reachCredentialDeadline(): void;
}

export interface ReadTokenLeaseOptions {
  readonly identity: { readonly runId: string; readonly jobId: string; readonly attempt: number };
  readonly initialToken: string;
  readonly initialExpiresAt?: number | undefined;
  readonly claimDeadlineAt: number;
  readonly enabled: boolean;
  readonly client?: ReadTokenClient | undefined;
  readonly sandbox: () => JobSandbox | undefined;
  readonly host: ReadTokenLeaseHost;
}

export interface ReadTokenLease {
  readonly token: string;
  readonly expiresAt: number | undefined;
  readonly secrets: readonly string[];
  readonly failed: boolean;
  start(): void;
  ensureFresh(): Promise<void>;
  stop(): void;
  clearSecrets(): void;
}

export const createReadTokenLease = (options: ReadTokenLeaseOptions): ReadTokenLease => {
  let token = options.initialToken;
  let expiresAt = options.initialExpiresAt;
  let secrets = [options.initialToken];
  let refreshAt: number | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshController: AbortController | undefined;
  let refreshInFlight: Promise<void> | undefined;
  let stopped = false;
  let failed = false;

  const clearRefreshTimer = () => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };
  const clearDeadlineTimer = () => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  };
  const refreshLead = (expiry: number) => {
    const remaining = Math.max(0, expiry - Date.now());
    return Math.min(READ_TOKEN_REFRESH_LEAD_MS, Math.floor(remaining / 2));
  };
  const needsRefresh = (): boolean =>
    expiresAt !== undefined &&
    expiresAt <= options.claimDeadlineAt + CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS;
  const applyFallback = (fallbackAt: number) => {
    if (stopped || failed) return;
    failed = true;
    clearRefreshTimer();
    options.host.applyFallback(fallbackAt);
    scheduleDeadline(fallbackAt);
  };
  const scheduleDeadline = (deadlineAt: number) => {
    clearDeadlineTimer();
    const delay = Math.max(0, deadlineAt - Date.now());
    if (delay === 0) {
      options.host.reachCredentialDeadline();
      return;
    }
    const timer = setTimeout(() => {
      if (deadlineTimer !== timer) return;
      deadlineTimer = undefined;
      options.host.reachCredentialDeadline();
    }, delay);
    if (typeof timer === 'object' && timer !== null) timer.unref?.();
    deadlineTimer = timer;
  };
  const scheduleRefresh = () => {
    clearRefreshTimer();
    if (!options.enabled || stopped || failed || !needsRefresh()) {
      refreshAt = undefined;
      return;
    }
    const expiry = expiresAt!;
    const nextRefreshAt = expiry - refreshLead(expiry);
    refreshAt = nextRefreshAt;
    const timer = setTimeout(
      () => {
        if (refreshTimer !== timer) return;
        refreshTimer = undefined;
        void refresh()
          .then(scheduleRefresh)
          .catch(() => undefined);
      },
      Math.max(0, nextRefreshAt - Date.now()),
    );
    if (typeof timer === 'object' && timer !== null) timer.unref?.();
    refreshTimer = timer;
  };
  const refresh = async (): Promise<void> => {
    if (!options.enabled || options.client === undefined || stopped || failed) return;
    if (refreshInFlight !== undefined) return refreshInFlight;
    if (expiresAt === undefined) return;
    const currentExpiresAt = expiresAt;
    const controller = new AbortController();
    refreshController = controller;
    const active = (async () => {
      try {
        const refreshed = await options.client!.refresh({ ...options.identity }, controller.signal);
        if (stopped) return;
        if (
          !Number.isFinite(refreshed.expiresAt) ||
          refreshed.expiresAt <= Date.now() ||
          refreshed.expiresAt <= currentExpiresAt
        ) {
          applyFallback(currentExpiresAt - CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS);
          return;
        }
        if (!secrets.includes(refreshed.token)) secrets = [...secrets, refreshed.token];
        const sandbox = options.sandbox();
        if (sandbox !== undefined) {
          if (sandbox.updateGithubReadToken === undefined) {
            applyFallback(currentExpiresAt - CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS);
            return;
          }
          try {
            await sandbox.updateGithubReadToken(refreshed.token);
          } catch {
            if (!stopped) applyFallback(currentExpiresAt - CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS);
            return;
          }
        }
        if (stopped) return;
        token = refreshed.token;
        expiresAt = refreshed.expiresAt;
        options.host.updateToken(refreshed.token, refreshed.expiresAt);
      } catch {
        if (!stopped) applyFallback(currentExpiresAt - CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS);
      } finally {
        if (refreshController === controller) refreshController = undefined;
      }
    })();
    refreshInFlight = active;
    try {
      await active;
    } finally {
      if (refreshInFlight === active) refreshInFlight = undefined;
    }
  };

  return {
    get token() {
      return token;
    },
    get expiresAt() {
      return expiresAt;
    },
    get secrets() {
      return secrets;
    },
    get failed() {
      return failed;
    },
    start() {
      scheduleRefresh();
    },
    async ensureFresh() {
      if (!options.enabled || stopped || failed || !needsRefresh()) return;
      const nextRefreshAt =
        refreshAt ?? expiresAt! - Math.min(READ_TOKEN_REFRESH_LEAD_MS, refreshLead(expiresAt!));
      if (Date.now() >= nextRefreshAt) {
        await refresh();
        scheduleRefresh();
      }
    },
    stop() {
      stopped = true;
      clearRefreshTimer();
      clearDeadlineTimer();
      refreshController?.abort();
    },
    clearSecrets() {
      secrets = [];
    },
  };
};

import type { LlmServiceClient } from './llm-service-client.js';

export interface GrantRevokerOptions {
  readonly client?: Pick<LlmServiceClient, 'revoke'> | undefined;
  readonly attempts: number;
  readonly budgetMs: number;
}

export interface GrantRevoker {
  revoke(jobId: string, issuanceAttempted: boolean): Promise<boolean>;
}

/**
 * Revoke a job grant for at most `attempts` tries inside `budgetMs`. A lost
 * issuance response is still revoked by job identity; no on-disk marker or
 * startup replay is required because grants have a fixed expiry.
 */
export const createGrantRevoker = (options: GrantRevokerOptions): GrantRevoker => {
  const revoke = async (jobId: string, issuanceAttempted: boolean): Promise<boolean> => {
    if (options.client === undefined || !issuanceAttempted) return true;
    const deadline = Date.now() + options.budgetMs;
    for (let attempt = 0; attempt < options.attempts; attempt += 1) {
      try {
        await options.client.revoke(jobId);
        return true;
      } catch {
        // A bounded retry keeps a transient control failure from losing revocation.
      }
      if (Date.now() >= deadline) break;
    }
    return false;
  };
  return { revoke };
};

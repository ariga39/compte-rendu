import { ReviewResult } from '@compte-rendu/contracts';

export { ReviewResult as ReviewRunOutput } from '@compte-rendu/contracts';

export interface ReviewRunSpec {
  readonly runId: string;
  readonly repositoryUrl: string;
  readonly repositoryName: string;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly repositoryReadToken: string;
  readonly maxAttempts?: number;
  readonly shouldAbort?: () => Promise<boolean>;
}

export type ReviewRunFailureReason =
  | 'agent'
  | 'checkout'
  | 'timeout'
  | 'invalid-output'
  | 'cleanup'
  | 'superseded';

export type ReviewRunResult =
  | {
      readonly status: 'succeeded';
      readonly attempt: number;
      readonly sandboxId: string;
      readonly output: typeof ReviewResult.Type;
    }
  | {
      readonly status: 'failed';
      readonly reason: ReviewRunFailureReason;
      readonly attempt: number;
      readonly sandboxId?: string;
      readonly retryable: boolean;
    };

export interface ReviewRunner {
  readonly runJob: (spec: ReviewRunSpec) => Promise<ReviewRunResult>;
}

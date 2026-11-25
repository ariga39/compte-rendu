import type { OperationalLog } from '@compte-rendu/contracts';
import type { RunnerJobBinding } from './runner-job-client';
import type { GitHubAdapter } from './github-adapter-contract';
import type { ReviewPublicationStateStore } from './review-state-store';
import type { D1DatabaseLike } from './review-state-store';
import type { RelayCatalogSnapshot } from '../../inference-worker/src/catalog';
import type { RelayControl } from './runner-llm-control';

export interface CoreEnv {
  readonly RUNNER: RunnerJobBinding;
  readonly RUNNER_AUTH_TOKEN: string;
}

export interface CoreWorkerEnv extends Partial<CoreEnv> {
  readonly REVIEW_DB: D1DatabaseLike;
  readonly INFERENCE_RELAY?: RelayControl & {
    catalog(input?: {
      readonly includeModels?: boolean;
      readonly models?: boolean;
    }): Promise<RelayCatalogSnapshot>;
    refreshCatalog(scheduledTime: number): Promise<void>;
  };
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly DASHBOARD_ORIGIN?: string;
  readonly GITHUB_CHECK_NAME?: string;
  readonly REVIEW_CONFIGURATION_TOKEN?: string;
  readonly RELAY_DEFAULT_MODEL_ROUTE?: string;
  readonly EVIDENCE_BUCKET?: R2BucketLike;
  readonly [key: string]: unknown;
}

export interface R2BucketLike {
  readonly get?: (
    key: string,
  ) => Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  readonly put: (
    key: string,
    value: ArrayBuffer | string,
    options?: { readonly onlyIf?: { readonly etagDoesNotMatch?: string } },
  ) => Promise<unknown>;
}

export interface CoreWorkerDependencies {
  readonly github?: GitHubAdapter;
  readonly stateStore?: ReviewPublicationStateStore;
  readonly log?: OperationalLog;
  readonly getReadInstallationToken?: (input: {
    installationId: number;
    repositoryId: number;
  }) => Promise<{ readonly token: string; readonly expiresAt: string }>;
}

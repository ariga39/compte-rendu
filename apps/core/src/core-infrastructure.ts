import { createCloudflareOperationalLog } from '@compte-rendu/contracts';
import { createGitHubAppTokenProvider } from './github-app-token';
import { createGitHubPublicationAdapter } from './github-review-adapter';
import { createD1ReviewStateStore } from './review-state-store';
import { createRunnerJobClient } from './runner-job-client';
import type { CoreWorkerDependencies, CoreWorkerEnv } from './core-worker';

/**
 * Builds the Core ports that are shared by the Worker API and the typed
 * application edge. Construction only binds configuration; no GitHub or D1
 * work starts until a port is actually called.
 */
export const createCoreInfrastructure = (
  env: CoreWorkerEnv,
  dependencies: CoreWorkerDependencies = {},
) => {
  const tokenProvider = createGitHubAppTokenProvider({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    crypto: globalThis.crypto,
  });
  const github =
    dependencies.github ??
    createGitHubPublicationAdapter({
      token: tokenProvider.getInstallationToken,
      getReviewAuthorLogin: tokenProvider.getReviewAuthorLogin,
      dashboardOrigin: env.DASHBOARD_ORIGIN,
      checkName: env.GITHUB_CHECK_NAME,
    });
  const stateStore =
    dependencies.stateStore ??
    createD1ReviewStateStore(
      env.REVIEW_DB,
      env.INFERENCE_RELAY ? env.RELAY_DEFAULT_MODEL_ROUTE : undefined,
    );
  const log = dependencies.log ?? createCloudflareOperationalLog();
  const runner =
    env.RUNNER === undefined || env.RUNNER_AUTH_TOKEN === undefined
      ? undefined
      : createRunnerJobClient({ binding: env.RUNNER, authToken: env.RUNNER_AUTH_TOKEN });

  return { tokenProvider, github, stateStore, log, runner } as const;
};

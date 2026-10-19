import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { Schema } from 'effect';

const instanceNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxCloudflareNameLength = 63;
const longestDerivedSuffix = '-review-evidence';
const InstallationId = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
const InstallationIds = Schema.Array(InstallationId).pipe(Schema.check(Schema.isMinLength(1)));
const BotAuthorId = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
const BotAuthorIds = Schema.Array(BotAuthorId);
const PostHogConfig = Schema.Struct({
  enabled: Schema.Boolean,
  projectApiKey: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  deployment: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.Literals(['production', 'staging'])),
});

const replaceRequired = (template: string, marker: string, value: string) => {
  if (!template.includes(marker)) {
    throw new Error(`template marker not found: ${marker}`);
  }
  return template.replace(marker, () => value);
};

const renderDeploymentConfigs = (
  instanceName: string,
  githubAppId: number,
  d1DatabaseId: string,
  runnerVpcServiceId: string,
  allowedInstallationIds: string,
  allowedBotAuthorIds = '[]',
  posthogConfig = '{"enabled":false}',
  checkName = '',
) => {
  if (
    !instanceNamePattern.test(instanceName) ||
    instanceName.length + longestDerivedSuffix.length > maxCloudflareNameLength
  ) {
    throw new Error('instance name must be DNS-safe and fit the derived Cloudflare resource names');
  }
  if (!Number.isSafeInteger(githubAppId) || githubAppId <= 0) {
    throw new Error('GitHub App ID must be a positive integer');
  }
  if (!uuidPattern.test(d1DatabaseId)) {
    throw new Error('D1 database ID must be a UUID');
  }
  if (!uuidPattern.test(runnerVpcServiceId)) {
    throw new Error('Runner VPC Service ID must be a UUID');
  }
  let parsedInstallationIds: readonly number[];
  try {
    parsedInstallationIds = Schema.decodeUnknownSync(Schema.fromJsonString(InstallationIds))(
      allowedInstallationIds,
    );
  } catch {
    throw new Error('GitHub installation IDs must be a non-empty JSON array of positive integers');
  }
  let parsedBotAuthorIds: readonly number[];
  try {
    parsedBotAuthorIds = Schema.decodeUnknownSync(Schema.fromJsonString(BotAuthorIds))(
      allowedBotAuthorIds,
    );
  } catch {
    throw new Error('GitHub Bot author IDs must be a JSON array of positive integers');
  }
  let parsedPostHogConfig: typeof PostHogConfig.Type;
  try {
    parsedPostHogConfig = Schema.decodeUnknownSync(Schema.fromJsonString(PostHogConfig))(
      posthogConfig,
    );
  } catch {
    throw new Error('PostHog configuration must be a JSON object');
  }
  const posthogProjectApiKey = parsedPostHogConfig.projectApiKey ?? '';
  const posthogHost = parsedPostHogConfig.host ?? '';
  const posthogDeployment = parsedPostHogConfig.deployment ?? '';
  const posthogEnvironment = parsedPostHogConfig.environment ?? 'production';
  if (parsedPostHogConfig.enabled) {
    if (!/^phc_[A-Za-z0-9._:-]{1,124}$/.test(posthogProjectApiKey)) {
      throw new Error('enabled PostHog configuration requires a project API key');
    }
    try {
      const host = new URL(posthogHost);
      if (host.protocol !== 'https:') throw new Error('host must use HTTPS');
    } catch {
      throw new Error('enabled PostHog configuration requires an HTTPS host');
    }
    if (!instanceNamePattern.test(posthogDeployment)) {
      throw new Error('enabled PostHog configuration requires a DNS-safe deployment alias');
    }
  }

  const directory = join(process.cwd(), 'apps/dashboard');
  const output = join(directory, `wrangler.${instanceName}.jsonc`);
  if (existsSync(output)) throw new Error('generated Wrangler config already exists');
  let application = readFileSync(join(directory, 'wrangler.jsonc'), 'utf8');
  application = replaceRequired(
    application,
    '"name": "compte-rendu-ingress"',
    `"name": "${instanceName}-ingress"`,
  );
  application = replaceRequired(
    application,
    '"database_name": "compte-rendu-review-state"',
    `"database_name": "${instanceName}-review-state"`,
  );
  application = replaceRequired(
    application,
    '"bucket_name": "compte-rendu-review-evidence"',
    `"bucket_name": "${instanceName}${longestDerivedSuffix}"`,
  );
  application = replaceRequired(
    application,
    '"service_id": "REPLACE_WITH_RUNNER_VPC_SERVICE_ID"',
    `"service_id": "${runnerVpcServiceId}"`,
  );
  application = replaceRequired(
    application,
    '"GITHUB_APP_ID": "REPLACE_WITH_GITHUB_APP_ID"',
    `"GITHUB_APP_ID": "${githubAppId}"`,
  );
  application = replaceRequired(
    application,
    '"POSTHOG_ENABLED": "false"',
    `"POSTHOG_ENABLED": "${parsedPostHogConfig.enabled ? 'true' : 'false'}"`,
  );
  application = replaceRequired(
    application,
    '"POSTHOG_PROJECT_API_KEY": ""',
    `"POSTHOG_PROJECT_API_KEY": ${JSON.stringify(posthogProjectApiKey)}`,
  );
  application = replaceRequired(
    application,
    '"POSTHOG_HOST": ""',
    `"POSTHOG_HOST": ${JSON.stringify(posthogHost)}`,
  );
  application = replaceRequired(
    application,
    '"POSTHOG_DEPLOYMENT": ""',
    `"POSTHOG_DEPLOYMENT": ${JSON.stringify(posthogDeployment)}`,
  );
  application = replaceRequired(
    application,
    '"POSTHOG_ENVIRONMENT": "production"',
    `"POSTHOG_ENVIRONMENT": "${posthogEnvironment}"`,
  );
  application = replaceRequired(
    application,
    '"database_id": "REPLACE_WITH_D1_DATABASE_ID"',
    `"database_id": "${d1DatabaseId}"`,
  );

  application = replaceRequired(
    application,
    '"GITHUB_CHECK_NAME": ""',
    `"GITHUB_CHECK_NAME": ${JSON.stringify(checkName)}`,
  );

  application = replaceRequired(
    application,
    '"ALLOWED_INSTALLATION_IDS": "REPLACE_WITH_GITHUB_INSTALLATION_IDS"',
    `"ALLOWED_INSTALLATION_IDS": ${JSON.stringify(JSON.stringify(parsedInstallationIds))}`,
  );
  application = replaceRequired(
    application,
    '"ALLOWED_BOT_AUTHOR_IDS": "REPLACE_WITH_GITHUB_BOT_AUTHOR_IDS"',
    `"ALLOWED_BOT_AUTHOR_IDS": ${JSON.stringify(JSON.stringify(parsedBotAuthorIds))}`,
  );

  writeFileSync(output, application, { encoding: 'utf8', flag: 'wx' });
  return { application: output };
};

const main = (args: readonly string[]) => {
  if (args.length < 5 || args.length > 8) {
    throw new Error(
      'usage: render-wrangler-config <instance-name> <github-app-id> <d1-uuid> <runner-vpc-service-uuid> <github-installation-ids-json> [github-bot-author-ids-json] [posthog-config-json] [github-check-name]',
    );
  }
  renderDeploymentConfigs(
    args[0],
    Number(args[1]),
    args[2],
    args[3],
    args[4],
    args[5],
    args[6],
    args[7],
  );
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  main(process.argv.slice(2));
}

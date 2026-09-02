import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

const replaceRequired = (template: string, marker: string, value: string) => {
  if (!template.includes(marker)) {
    throw new Error(`template marker not found: ${marker}`);
  }
  return template.replace(marker, value);
};

const renderDeploymentConfigs = (
  instanceName: string,
  githubAppId: number,
  d1DatabaseId: string,
  runnerVpcServiceId: string,
  allowedInstallationIds: string,
  allowedBotAuthorIds = '[]',
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

  const coreDirectory = join(process.cwd(), 'apps/core');
  const ingressDirectory = join(process.cwd(), 'apps/ingress');
  const coreOutput = join(coreDirectory, `wrangler.${instanceName}.jsonc`);
  const ingressOutput = join(ingressDirectory, `wrangler.${instanceName}.jsonc`);
  if (existsSync(coreOutput) || existsSync(ingressOutput)) {
    throw new Error('generated Wrangler config already exists');
  }

  let core = readFileSync(join(coreDirectory, 'wrangler.jsonc'), 'utf8');
  core = replaceRequired(core, '"name": "compte-rendu-core"', `"name": "${instanceName}-core"`);
  core = replaceRequired(
    core,
    '"database_name": "compte-rendu-review-state"',
    `"database_name": "${instanceName}-review-state"`,
  );
  core = replaceRequired(
    core,
    '"bucket_name": "compte-rendu-review-evidence"',
    `"bucket_name": "${instanceName}${longestDerivedSuffix}"`,
  );
  core = replaceRequired(
    core,
    '"service_id": "REPLACE_WITH_RUNNER_VPC_SERVICE_ID"',
    `"service_id": "${runnerVpcServiceId}"`,
  );
  core = replaceRequired(
    core,
    '"GITHUB_APP_ID": "REPLACE_WITH_GITHUB_APP_ID"',
    `"GITHUB_APP_ID": "${githubAppId}"`,
  );
  core = replaceRequired(
    core,
    '"database_id": "REPLACE_WITH_D1_DATABASE_ID"',
    `"database_id": "${d1DatabaseId}"`,
  );

  let ingress = readFileSync(join(ingressDirectory, 'wrangler.jsonc'), 'utf8');
  ingress = replaceRequired(
    ingress,
    '"name": "compte-rendu-ingress"',
    `"name": "${instanceName}-ingress"`,
  );
  ingress = replaceRequired(
    ingress,
    '"service": "compte-rendu-core"',
    `"service": "${instanceName}-core"`,
  );
  ingress = replaceRequired(
    ingress,
    '"ALLOWED_INSTALLATION_IDS": "REPLACE_WITH_GITHUB_INSTALLATION_IDS"',
    `"ALLOWED_INSTALLATION_IDS": ${JSON.stringify(JSON.stringify(parsedInstallationIds))}`,
  );
  ingress = replaceRequired(
    ingress,
    '"ALLOWED_BOT_AUTHOR_IDS": "REPLACE_WITH_GITHUB_BOT_AUTHOR_IDS"',
    `"ALLOWED_BOT_AUTHOR_IDS": ${JSON.stringify(JSON.stringify(parsedBotAuthorIds))}`,
  );

  let coreCreated = false;
  try {
    writeFileSync(coreOutput, core, { encoding: 'utf8', flag: 'wx' });
    coreCreated = true;
    writeFileSync(ingressOutput, ingress, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (coreCreated) {
      unlinkSync(coreOutput);
    }
    throw error;
  }
  return { core: coreOutput, ingress: ingressOutput };
};

const main = (args: readonly string[]) => {
  if (args.length !== 5 && args.length !== 6) {
    throw new Error(
      'usage: render-wrangler-config <instance-name> <github-app-id> <d1-uuid> <runner-vpc-service-uuid> <github-installation-ids-json> [github-bot-author-ids-json]',
    );
  }
  renderDeploymentConfigs(args[0], Number(args[1]), args[2], args[3], args[4], args[5]);
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  main(process.argv.slice(2));
}

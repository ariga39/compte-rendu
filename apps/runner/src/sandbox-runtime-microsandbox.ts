import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Schema } from 'effect';
import {
  SandboxCreateError,
  type SandboxCommand,
  type SandboxRuntimeFactory,
  type RunnerProcessResult,
} from './sandbox-runtime.js';

const evidenceRoot = '/tmp/compte-rendu-evidence';
const inspectedSandbox = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    config: Schema.Struct({ labels: Schema.Record(Schema.String, Schema.String) }),
  }),
);

// msb launches a local host process. Pass only local runtime settings, and
// explicitly select local execution even on hosts with a saved cloud profile.
const localEnvironment = (): NodeJS.ProcessEnv => ({
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
  MSB_HOME: process.env.MSB_HOME,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  MSB_BACKEND: 'local',
});

const complete = (result: RunnerProcessResult) =>
  !result.timedOut &&
  !result.truncated &&
  !result.stderrTruncated &&
  !result.streamError &&
  !result.processError;

// A fresh local catalog also reports "not found". Bind absence to the file
// used at creation so an instance move or replacement cannot release a job.
const catalogIdentity = async () => {
  const path = join(process.env.MSB_HOME || join(homedir(), '.microsandbox'), 'db', 'msb.db');
  const file = await stat(path);
  if (!file.isFile()) throw new Error('Microsandbox catalog missing');
  return createHash('sha256')
    .update(JSON.stringify([path, file.dev, file.ino, file.birthtimeMs]))
    .digest('hex');
};

export const createMicrosandboxPreflight = (image: string) => async (command: SandboxCommand) => {
  const options = { env: localEnvironment() };
  const host = await command(['doctor'], undefined, options);
  if (host.exitCode !== 0 || !complete(host)) return false;
  const cached = await command(['image', 'inspect', image], undefined, options);
  return cached.exitCode === 0 && complete(cached);
};

const inspect = async (command: SandboxCommand, name: string, catalog: string | undefined) => {
  if (!catalog || catalog !== (await catalogIdentity()))
    throw new Error('Microsandbox catalog changed');
  const result = await command(
    ['inspect', '--format', 'json', name],
    { stage: 'cleanup', command: 'inspect-sandbox' },
    { env: localEnvironment(), captureStdout: true, captureStderr: true, maxBytes: 256 * 1024 },
  );
  if (catalog !== (await catalogIdentity()) || !complete(result))
    throw new Error('Incomplete microsandbox inspection');
  if (result.exitCode === 1 && result.stderr?.trim() === `error: sandbox not found: ${name}`)
    return undefined;
  if (result.exitCode !== 0) throw new Error('Microsandbox inspection failed');
  const entry = Schema.decodeUnknownSync(inspectedSandbox)(result.stdout);
  if (entry.name !== name) throw new Error('Microsandbox identity mismatch');
  return entry;
};

export const confirmMicrosandboxAbsent = async (
  command: SandboxCommand,
  name: string,
  catalog: string | undefined,
) => {
  if ((await inspect(command, name, catalog)) !== undefined)
    throw new Error('Microsandbox still present');
};

export const createMicrosandboxRuntimeFactory =
  (image: string, rotationCommand: SandboxCommand): SandboxRuntimeFactory =>
  (spec) => {
    const { name } = spec;
    const owner = randomUUID();
    let catalog: string | undefined;
    let attempted = false;
    let created = false;
    let closed = false;
    let githubToken = spec.githubReadToken;
    let creating: Promise<void> | undefined;
    const create = async (command: SandboxCommand) => {
      const host = spec.modelResource.split(':')[0]!;
      if (
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(host) ||
        host === 'api.github.com' ||
        spec.modelResource !== host + ':443' ||
        !spec.modelTokenFile
      )
        throw new Error('Microsandbox requires a dedicated HTTPS grant endpoint on port 443');
      const model = await readFile(spec.modelTokenFile, 'utf8');
      const env = [
        ...spec.env,
        'NODE_EXTRA_CA_CERTS=/.msb/tls/ca.pem',
        `XDG_CONFIG_HOME=${spec.configRoot}`,
        `XDG_DATA_HOME=${evidenceRoot}/data`,
        `XDG_STATE_HOME=${evidenceRoot}/state`,
      ];
      catalog = await catalogIdentity();
      attempted = true;
      const result = await command(
        [
          'create',
          '--name',
          name,
          '--label',
          `cr-job-owner=${owner}`,
          '--pull',
          'never',
          '--security',
          'restricted',
          '--deployment-profile',
          'multi-tenant',
          '--max-duration',
          '2h',
          '--cpus',
          spec.cpu,
          '--memory',
          `${spec.memoryGib}G`,
          '--mount-dir',
          `${spec.checkoutRoot}:${spec.checkoutRoot}:ro`,
          '--mount-dir',
          `${spec.configRoot}:${spec.configRoot}:ro`,
          '--net-default',
          'deny',
          '--net-rule',
          `allow@${host}:tcp:443,allow@api.github.com:tcp:443`,
          '--tls-intercept',
          '--secret',
          `OPENCODE_API_KEY:headers=authorization@${host}`,
          '--secret',
          'GH_TOKEN:headers=authorization@api.github.com',
          ...env.flatMap((pair) => ['--env', pair]),
          image,
        ],
        { stage: 'sandbox', command: 'create' },
        { env: { ...localEnvironment(), OPENCODE_API_KEY: model, GH_TOKEN: githubToken } },
      );
      if (result.exitCode !== 0 || !complete(result)) throw new SandboxCreateError(result.timedOut);
      created = true;
    };
    return {
      metadata: {
        runtime: 'microsandbox',
        name,
        id: name,
        imageRef: image,
        evidenceRoot,
        get catalogIdentity() {
          return catalog;
        },
        get created() {
          return created;
        },
        hostCleanupConfirmed: true,
      },
      setup(command) {
        creating = create(command);
        return creating;
      },
      exec(args, command, options, diagnostic) {
        return command(
          [
            'exec',
            '--no-tty',
            '--no-stdin',
            '--user',
            '1000',
            '--workdir',
            spec.checkoutRoot,
            name,
            '--',
            ...args,
          ],
          diagnostic,
          { ...options, env: localEnvironment() },
        );
      },
      copyOut(path, destination, command, diagnostic, options) {
        return command(['cp', `${name}:${path}`, destination], diagnostic, {
          ...options,
          env: localEnvironment(),
        });
      },
      async rotateGithubReadToken(token) {
        githubToken = token;
        if (!creating) return;
        await creating;
        if (closed) throw new Error('Microsandbox is closing');
        const result = await rotationCommand(
          ['modify', name, '--secret', 'GH_TOKEN@api.github.com'],
          undefined,
          { env: { ...localEnvironment(), GH_TOKEN: token }, timeoutMs: 30_000 },
        );
        if (result.exitCode !== 0 || !complete(result))
          throw new Error('Microsandbox token update failed');
      },
      async destroy(command) {
        closed = true;
        if (!attempted) return;
        const existing = await inspect(command, name, catalog);
        if (!existing) return;
        if (existing.config.labels['cr-job-owner'] !== owner)
          throw new Error('Microsandbox owner mismatch');
        const removed = await command(
          ['rm', '-f', name],
          { stage: 'cleanup', command: 'remove-sandbox' },
          { env: localEnvironment() },
        );
        if (removed.exitCode !== 0 || !complete(removed))
          throw new Error('Microsandbox removal failed');
        await confirmMicrosandboxAbsent(command, name, catalog);
      },
    };
  };

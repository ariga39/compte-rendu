import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from './execution-commands.js';
import type { ExecutionJob } from './execution-job.js';

const askpassScript =
  '#!/bin/sh\ncase "$1" in *[Uu]sername*) printf %s x-access-token ;; *) printf %s "$CHECKOUT_TOKEN" ;; esac\n';

/**
 * Clones the immutable base/head revisions into a fresh host directory and
 * verifies the merge base. Returns `undefined` when the checkout cannot prove
 * the exact admitted revisions; the caller fails the job as a checkout
 * failure.
 */
export const prepareCheckout = async (
  job: ExecutionJob,
  { runTracked }: Pick<CommandRunner, 'runTracked'>,
): Promise<string | undefined> => {
  const root = await mkdtemp(join(tmpdir(), 'compte-rendu-review-'));
  job.checkoutRoot = root;
  const checkoutPath = join(root, 'checkout');
  const askpassPath = join(root, 'askpass');
  await writeFile(askpassPath, askpassScript, { mode: 0o700 });
  const env = {
    ...process.env,
    CHECKOUT_TOKEN: job.input.repositoryReadToken,
    GIT_ASKPASS: askpassPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const clone = await runTracked(
    job,
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'submodule.recurse=false',
      '-c',
      'filter.lfs.smudge=:',
      'clone',
      '--quiet',
      '--no-checkout',
      '--no-recurse-submodules',
      job.input.repositoryUrl,
      checkoutPath,
    ],
    { env },
    { stage: 'checkout', command: 'clone' },
  );
  if (clone.exitCode !== 0 || clone.timedOut) return undefined;
  const fetch = await runTracked(
    job,
    'git',
    [
      '-C',
      checkoutPath,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'submodule.recurse=false',
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-recurse-submodules',
      'origin',
      `+${job.input.baseSha}:refs/remotes/origin/review-base`,
      `+${job.input.headSha}:refs/remotes/origin/review-head`,
    ],
    { env },
    { stage: 'checkout', command: 'fetch' },
  );
  if (fetch.exitCode !== 0 || fetch.timedOut) return undefined;
  const checkout = await runTracked(
    job,
    'git',
    [
      '-C',
      checkoutPath,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'submodule.recurse=false',
      'checkout',
      '--quiet',
      '--detach',
      'refs/remotes/origin/review-head',
    ],
    { env },
    { stage: 'checkout', command: 'detach' },
  );
  if (checkout.exitCode !== 0 || checkout.timedOut) return undefined;
  const commits = await runTracked(
    job,
    'git',
    [
      '-C',
      checkoutPath,
      'rev-parse',
      'refs/remotes/origin/review-base^{commit}',
      'refs/remotes/origin/review-head^{commit}',
    ],
    { captureStdout: true, maxBytes: 4 * 1024, env },
    { stage: 'checkout', command: 'verify-revision' },
  );
  if (commits.exitCode !== 0 || commits.timedOut) return undefined;
  const reported = commits.stdout.trim().split(/\s+/);
  if (
    reported.length !== 2 ||
    reported[0] !== job.input.baseSha ||
    reported[1] !== job.input.headSha
  ) {
    return undefined;
  }
  const mergeBase = await runTracked(
    job,
    'git',
    [
      '-C',
      checkoutPath,
      'merge-base',
      'refs/remotes/origin/review-base^{commit}',
      'refs/remotes/origin/review-head^{commit}',
    ],
    { captureStdout: true, maxBytes: 4 * 1024, env },
    { stage: 'checkout', command: 'verify-merge-base' },
  );
  if (mergeBase.exitCode !== 0 || mergeBase.timedOut || mergeBase.truncated) return undefined;
  const mergeBaseSha = mergeBase.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(mergeBaseSha)) return undefined;
  const removeRemote = await runTracked(
    job,
    'git',
    ['-C', checkoutPath, 'remote', 'remove', 'origin'],
    { env },
    { stage: 'checkout', command: 'remove-remote' },
  );
  if (removeRemote.exitCode !== 0) return undefined;
  const removeAskpass = await runTracked(
    job,
    'git',
    ['-C', checkoutPath, 'config', '--local', '--unset-all', 'credential.helper'],
    { env },
    { stage: 'checkout', command: 'remove-credential' },
  );
  if (removeAskpass.exitCode !== 0 && removeAskpass.exitCode !== 5) return undefined;
  const removeHook = await runTracked(
    job,
    'git',
    ['-C', checkoutPath, 'config', '--local', '--unset-all', 'core.askPass'],
    { env },
    { stage: 'checkout', command: 'remove-askpass' },
  );
  if (removeHook.exitCode !== 0 && removeHook.exitCode !== 5) return undefined;
  await rm(askpassPath, { force: true });
  return mergeBaseSha;
};

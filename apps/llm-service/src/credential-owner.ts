import { spawn } from 'node:child_process';
import { writeFile, realpath } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { Effect } from 'effect';

// Keep the lock inode stable across atomic credential replacements. The child
// holds the OS lock until stdin closes (including when the service crashes).
export const ownSubscriptionCredential = (file: string) =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      const lock = join(await realpath(dirname(file)), `${basename(file)}.owner.lock`);
      await writeFile(lock, '', { flag: 'a', mode: 0o600 });
      return new Promise<{ signal: AbortSignal; release: () => Promise<void> }>(
        (resolve, reject) => {
          const lost = new AbortController();
          const child = spawn(
            '/usr/bin/flock',
            [
              '--exclusive',
              '--nonblock',
              lock,
              '/bin/sh',
              '-c',
              'printf ready; /bin/cat >/dev/null',
            ],
            { stdio: ['pipe', 'pipe', 'ignore'] },
          );
          const closed = new Promise<void>((done) => {
            child.once('close', () => {
              lost.abort();
              done();
              reject(new Error('subscription credential already owned'));
            });
            child.once('error', () => {
              lost.abort();
              done();
              reject(new Error('subscription credential lock unavailable'));
            });
          });
          child.stdout?.on('data', () =>
            resolve({
              signal: lost.signal,
              release: async () => {
                child.stdin?.end();
                await closed;
              },
            }),
          );
        },
      );
    }).pipe(
      Effect.catch(() =>
        Effect.fail(new Error('subscription credential already owned or lock unavailable')),
      ),
    ),
  );

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'chokidar';
import { Schema } from 'effect';
import { parse } from 'smol-toml';

const RunnerSettingsDocument = Schema.Struct({
  concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
});

export interface RunnerSettings {
  readonly concurrency: number;
}

const decode = (text: string): RunnerSettings => {
  return Schema.decodeUnknownSync(RunnerSettingsDocument, {
    onExcessProperty: 'error',
  })(parse(text));
};

const readRunnerSettings = async (file: string): Promise<RunnerSettings> =>
  decode(await readFile(file, 'utf8'));

export const readRunnerSettingsSync = (file: string): RunnerSettings => {
  try {
    return decode(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('invalid runner settings file');
  }
};

export interface RunnerSettingsWatcher {
  readonly close: () => Promise<void>;
}

export const watchRunnerSettings = (
  file: string,
  handlers: {
    readonly onSettings: (settings: RunnerSettings) => void;
    readonly onError: () => void;
  },
): RunnerSettingsWatcher => {
  let generation = 0;
  let closed = false;
  const reload = async () => {
    const token = (generation += 1);
    try {
      const settings = await readRunnerSettings(file);
      if (!closed && token === generation) handlers.onSettings(settings);
    } catch {
      if (!closed && token === generation) handlers.onError();
    }
  };
  const observedError = () => {
    generation += 1;
    if (!closed) handlers.onError();
  };
  const watcher: FSWatcher = watch(file, {
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  watcher.on('add', () => void reload());
  watcher.on('change', () => void reload());
  watcher.on('unlink', observedError);
  watcher.on('error', observedError);
  watcher.on('ready', () => void reload());
  return {
    close: async () => {
      closed = true;
      generation += 1;
      await watcher.close();
    },
  };
};

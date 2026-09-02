import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runCliWithoutArguments = () => {
  try {
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/github-publication-probe.mts'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' },
    );
    return '';
  } catch (error) {
    const output = error as { stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = output.stderr === undefined ? '' : output.stderr.toString();
    const stdout = output.stdout === undefined ? '' : output.stdout.toString();
    return `${stdout}\n${stderr}`;
  }
};

describe('GitHub publication probe CLI', () => {
  it('reaches its intended usage behavior at the Node CLI seam', () => {
    const output = runCliWithoutArguments();

    expect(output).toContain('usage: github-publication-probe.mts <jobs.json> <evidence-root>');
    expect(output).not.toContain('ERR_UNSUPPORTED_DIR_IMPORT');
  });
});

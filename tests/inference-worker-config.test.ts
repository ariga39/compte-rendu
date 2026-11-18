import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const parseJsonc = (source: string) =>
  JSON.parse(source.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'));

describe('Inference Worker deployment template', () => {
  it('configures the retention sweep cron on the Worker itself', () => {
    const config = parseJsonc(
      readFileSync(
        fileURLToPath(new URL('../apps/inference-worker/wrangler.jsonc', import.meta.url)),
        'utf8',
      ),
    ) as { triggers?: { crons?: readonly string[] } };
    expect(config.triggers?.crons).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(config.triggers?.crons?.every((cron) => cron.trim().length > 0)).toBe(true);
  });
});

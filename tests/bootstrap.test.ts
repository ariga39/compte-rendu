import { describe, expect, it } from 'vitest';
import core from '../apps/core/src/index';
import ingress from '../apps/ingress/src/index';

describe('Worker bootstrap', () => {
  it('returns 501 from each Worker entrypoint', async () => {
    const request = new Request('https://example.com/');

    expect((await ingress.fetch(request)).status).toBe(501);
    expect((await core.fetch(request)).status).toBe(501);
  });
});

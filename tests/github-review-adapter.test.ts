import { describe, expect, it } from 'vitest';
import { createGitHubPublicationAdapter } from '../apps/core/src/github-review-adapter';

describe('per-run dashboard Check links', () => {
  it('keeps creation, recovery, and terminal updates linked to their own run', async () => {
    const checks: Array<{
      id: number;
      external_id: string;
      details_url?: string;
      output?: { summary: string } | null;
    }> = [];
    let loseCreate = true;
    const remote: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/repositories/11') return Response.json({ full_name: 'example/repo' });
      if (request.method === 'GET' && path.endsWith('/check-runs'))
        return Response.json({ check_runs: checks });
      if (request.method === 'POST') {
        checks.push({ id: checks.length + 1, ...(await request.json()) });
        if (loseCreate) {
          loseCreate = false;
          return new Response(null, { status: 503 });
        }
        return Response.json(checks.at(-1));
      }
      if (request.method === 'PATCH') {
        const check = checks.find((entry) => entry.id === Number(path.split('/').at(-1)));
        if (check === undefined) return new Response(null, { status: 404 });
        Object.assign(check, await request.json());
        return Response.json(check);
      }
      return new Response(null, { status: 404 });
    };
    const options = {
      token: 'test-token',
      fetch: remote,
      dashboardOrigin: 'https://dashboard.example',
    };
    const github = createGitHubPublicationAdapter(options);
    const input = {
      repositoryId: 11,
      installationId: 7,
      headSha: '2'.repeat(40),
      runId: 'run-one',
    };
    expect(await github.createCheckRun!(input)).toEqual({ id: 1 });
    expect(checks[0].details_url).toBe('https://dashboard.example/jobs/run-one');
    expect(checks[0].output?.summary).toContain('https://dashboard.example/jobs/run-one');
    delete checks[0].details_url;
    Object.assign(checks[0], { output: null });
    expect(await createGitHubPublicationAdapter(options).createCheckRun!(input)).toEqual({ id: 1 });
    expect(checks).toHaveLength(1);
    expect(checks[0].details_url).toBe('https://dashboard.example/jobs/run-one');
    expect(await github.createCheckRun!({ ...input, runId: 'run-two' })).toEqual({ id: 2 });
    for (const status of ['in_progress', 'success', 'failure', 'cancelled'] as const) {
      await github.updateCheckRun!({ ...input, checkRunId: 1, status });
      expect(checks[0].details_url).toBe('https://dashboard.example/jobs/run-one');
      expect(checks[0].output?.summary).toContain('https://dashboard.example/jobs/run-one');
      expect(checks[1].details_url).toBe('https://dashboard.example/jobs/run-two');
    }
  });
});

import { describe, expect, it } from 'vitest';
import { createGitHubPublicationAdapter } from '../apps/core/src/github-review-adapter';

describe('per-run dashboard Check links', () => {
  it.each([undefined, '', '  ', 'Ariga39 AI Review'])(
    'keeps creation, recovery, and updates linked with check name %s',
    async (checkName) => {
      const checks: Array<{
        id: number;
        name: string;
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
          return Response.json({
            check_runs: checks.filter(
              (check) => check.name === new URL(request.url).searchParams.get('check_name'),
            ),
          });
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
        checkName,
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
      expect(checks[0].name).toBe(checkName?.trim() || 'Compte-rendu review');
      expect(checks[0].details_url).toBe('https://dashboard.example/jobs/run-one');
      expect(checks[0].output?.summary).toContain('https://dashboard.example/jobs/run-one');
      delete checks[0].details_url;
      Object.assign(checks[0], { output: null });
      expect(await createGitHubPublicationAdapter(options).createCheckRun!(input)).toEqual({
        id: 1,
      });
      expect(checks).toHaveLength(1);
      expect(
        await github.findCheckRunForSuite!({
          repositoryId: 11,
          installationId: 7,
          checkSuiteId: 9,
        }),
      ).toEqual({ candidates: [{ id: 1, externalId: 'run-one' }] });
      expect(checks[0].details_url).toBe('https://dashboard.example/jobs/run-one');
      expect(await github.createCheckRun!({ ...input, runId: 'run-two' })).toEqual({ id: 2 });
      for (const status of ['in_progress', 'success', 'failure', 'cancelled'] as const) {
        await github.updateCheckRun!({ ...input, checkRunId: 1, status });
        expect(checks[0].details_url).toBe('https://dashboard.example/jobs/run-one');
        expect(checks[0].output?.summary).toContain('https://dashboard.example/jobs/run-one');
        expect(checks[1].details_url).toBe('https://dashboard.example/jobs/run-two');
      }
    },
  );
});

describe('pull request facts branch refs', () => {
  it('captures the source and target branch names from GitHub', async () => {
    const remote: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/repositories/11') return Response.json({ full_name: 'example/repo' });
      if (path === '/repos/example/repo/pulls/42')
        return Response.json({
          draft: false,
          base: {
            sha: '1'.repeat(40),
            ref: 'main',
            repo: { id: 11, visibility: 'public' },
          },
          head: {
            sha: '2'.repeat(40),
            ref: 'feature/drawer',
            repo: { id: 99 },
          },
        });
      return new Response(null, { status: 404 });
    };
    const github = createGitHubPublicationAdapter({ token: 'test-token', fetch: remote });
    expect(
      await github.getPullRequest!({ repositoryId: 11, pullRequestNumber: 42, installationId: 7 }),
    ).toMatchObject({ baseRef: 'main', headRef: 'feature/drawer' });
  });
});

describe('structured review publication confirmation', () => {
  it.each(['author', 'commit', 'state', 'valid', 'dismissed'])(
    'checks %s when recovering a vote',
    async (scenario) => {
      const headSha = '2'.repeat(40);
      const marker = '<!-- compte-rendu:run:vote -->';
      const record = {
        id: 123,
        body: marker,
        commit_id: scenario === 'commit' ? '3'.repeat(40) : headSha,
        state:
          scenario === 'state' ? 'COMMENTED' : scenario === 'dismissed' ? 'DISMISSED' : 'APPROVED',
        user: { login: scenario === 'author' ? 'other[bot]' : 'reviewer[bot]', type: 'Bot' },
      };
      const github = createGitHubPublicationAdapter({
        token: 'fixture',
        getReviewAuthorLogin: async () => 'reviewer[bot]',
        fetch: async (input) =>
          new URL(input instanceof Request ? input.url : input).pathname === '/repositories/11'
            ? Response.json({ full_name: 'acme/repo' })
            : Response.json([record]),
      });
      const result = github.findReviewByMarker!({
        repositoryId: 11,
        installationId: 7,
        pullRequestNumber: 42,
        marker,
        expected: { headSha, event: 'APPROVE' },
      });
      if (scenario === 'valid' || scenario === 'dismissed')
        expect(await result).toMatchObject({ id: 123, state: record.state });
      else await expect(result).rejects.toThrow();
    },
  );
});

it('labels a delivered Request changes review as a successful Check with its decision', async () => {
  let update: unknown;
  const github = createGitHubPublicationAdapter({
    token: 'fixture',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'PATCH') {
        update = await request.json();
        return Response.json({});
      }
      return Response.json({ full_name: 'acme/repo' });
    },
  });
  await github.updateCheckRun!({
    runId: 'vote',
    repositoryId: 11,
    installationId: 7,
    checkRunId: 4,
    status: 'success',
    decision: 'request_changes',
  });
  expect(update).toMatchObject({
    conclusion: 'success',
    output: { title: 'Review published: Request changes' },
  });
});

it('recovers a lost vote response only from the matching App review without posting twice', async () => {
  const records: unknown[] = [];
  const headSha = '2'.repeat(40);
  const payload = {
    event: 'REQUEST_CHANGES' as const,
    commit_id: headSha,
    body: '<!-- compte-rendu:run:recover -->\n## Review: fix this',
  };
  const github = createGitHubPublicationAdapter({
    token: 'fixture',
    getReviewAuthorLogin: async () => 'reviewer[bot]',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/repositories/11') return Response.json({ full_name: 'acme/repo' });
      if (path.endsWith('/pulls/42')) return Response.json({ head: { sha: headSha } });
      if (request.method === 'POST') {
        const body = await request.json();
        records.push({
          id: 100,
          body: body.body,
          commit_id: body.commit_id,
          state: 'CHANGES_REQUESTED',
          user: { login: 'reviewer[bot]', type: 'Bot' },
        });
        return new Response(null, { status: 503 });
      }
      return Response.json(records);
    },
  });
  expect(
    await github.createReview!({
      repositoryId: 11,
      installationId: 7,
      pullRequestNumber: 42,
      payload,
      verifyPublication: true,
    }),
  ).toMatchObject({ kind: 'created', review: { id: 100, state: 'CHANGES_REQUESTED' } });
  expect(records).toHaveLength(1);
});

it('does not retry a vote whose returned author contradicts the authenticated App', async () => {
  const published: unknown[] = [];
  const headSha = '2'.repeat(40);
  const github = createGitHubPublicationAdapter({
    token: 'fixture',
    getReviewAuthorLogin: async () => 'reviewer[bot]',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/repositories/11') return Response.json({ full_name: 'acme/repo' });
      if (path.endsWith('/pulls/42')) return Response.json({ head: { sha: headSha } });
      if (request.method === 'POST') {
        const body = await request.json();
        published.push(body);
        return Response.json({
          id: 123,
          body: body.body,
          commit_id: headSha,
          state: 'APPROVED',
          user: { type: 'Bot', login: 'other[bot]' },
        });
      }
      return Response.json([]);
    },
  });
  await expect(
    github.createReview!({
      repositoryId: 11,
      installationId: 7,
      pullRequestNumber: 42,
      verifyPublication: true,
      payload: {
        event: 'APPROVE',
        commit_id: headSha,
        body: '<!-- compte-rendu:run:wrong-author -->\n## Review: good',
      },
    }),
  ).rejects.toThrow();
  expect(published).toHaveLength(1);
});

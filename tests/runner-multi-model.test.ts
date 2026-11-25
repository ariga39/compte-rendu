import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SqliteD1Database,
  claimRunnerJob,
  createCoreWorker,
  createD1ReviewStateStore,
  createRelayControl,
  createRunner,
  decisionText,
  finalMarkdownJsonl,
  multiReviewConfig,
  routeRelayControl,
  runAgentScenario,
  runnerJobFields,
  structuredResult,
  waitForTerminal,
} from './support/runner-harness';

describe('Runner multi-model review', () => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  const rootSession = 'ses_multi_root';
  const selection = {
    revision: 3,
    selection: {
      reviewers: ['deepseek-v4.1-flash', 'step-5-preview'],
      synthesis: 'deepseek-v4.1-flash',
    },
  };
  const synthesisMarkdown =
    '## Review:\n\nSynthesized blocking finding reviewer-0-f1 with merged source reviewer-1-f1.';
  const reviewerDecision = {
    'reviewer-0': 'request_changes',
    'reviewer-1': 'comment',
  } as const;

  const multiChildExports = (childId: string, participant: string, route: string) =>
    JSON.stringify({
      info: {
        id: childId,
        parentID: rootSession,
        agent: participant,
        model: { providerID: 'compte-rendu', id: route },
        outcome: 'succeeded',
      },
      messages: [
        {
          type: 'assistant',
          finish: 'stop',
          agent: participant,
          model: { providerID: 'compte-rendu', id: route },
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                participant,
                decision: reviewerDecision[participant as keyof typeof reviewerDecision],
                report: 'independent narrative review',
              }),
            },
          ],
        },
        { type: 'idle', outcome: 'succeeded' },
      ],
    });

  const rootExport = JSON.stringify({
    info: {
      id: rootSession,
      agent: 'multi-review-supervisor',
      model: { providerID: 'compte-rendu', id: 'deepseek-v4.1-flash' },
      outcome: 'succeeded',
    },
    messages: [
      {
        id: 'msg-root-final',
        type: 'assistant',
        finish: 'stop',
        agent: 'multi-review-supervisor',
        model: { providerID: 'compte-rendu', id: 'deepseek-v4.1-flash' },
        content: [
          {
            type: 'text',
            text: JSON.stringify({ decision: 'request_changes', markdown: synthesisMarkdown }),
          },
        ],
      },
      { type: 'idle', outcome: 'succeeded' },
    ],
  });

  const rootJsonl = [
    JSON.stringify({
      type: 'tool_use',
      sessionID: rootSession,
      part: {
        type: 'tool',
        id: 'call-a',
        tool: 'subagent',
        state: {
          status: 'completed',
          input: {
            agent: 'reviewer-0',
            description: 'review A',
            prompt: 'frozen review brief',
            background: false,
          },
          output: '<subagent sessionID="ses_multi_child_a" state="completed">done</subagent>',
          metadata: { metadata: { sessionID: 'ses_multi_child_a', status: 'completed' } },
        },
      },
    }),
    JSON.stringify({
      type: 'tool_use',
      sessionID: rootSession,
      part: {
        type: 'tool',
        id: 'call-b',
        tool: 'subagent',
        state: {
          status: 'completed',
          input: {
            agent: 'reviewer-1',
            description: 'review B',
            prompt: 'frozen review brief',
            background: false,
          },
          output: '<subagent sessionID="ses_multi_child_b" state="completed">done</subagent>',
          metadata: { metadata: { sessionID: 'ses_multi_child_b', status: 'completed' } },
        },
      },
    }),
    JSON.stringify({
      type: 'text',
      sessionID: rootSession,
      part: {
        type: 'text',
        messageID: 'msg-root-final',
        text: JSON.stringify({ decision: 'request_changes', markdown: synthesisMarkdown }),
      },
    }),
  ].join('\n');

  const multiModelConfig = JSON.stringify({
    id: 'opencode-go/legacy-single',
    baseUrl: 'https://inference.example/v1',
    definition: { name: 'Legacy single' },
  });

  const defaultChildren = [
    {
      id: 'ses_multi_child_a',
      parentID: rootSession,
      agent: 'reviewer-0',
      model: { providerID: 'compte-rendu', id: 'deepseek-v4.1-flash' },
      outcome: 'succeeded',
    },
    {
      id: 'ses_multi_child_b',
      parentID: rootSession,
      agent: 'reviewer-1',
      model: { providerID: 'compte-rendu', id: 'step-5-preview' },
      outcome: 'succeeded',
    },
  ];
  const defaultExport = (sessionId: string): string | undefined =>
    sessionId === rootSession
      ? rootExport
      : sessionId === 'ses_multi_child_a'
        ? multiChildExports('ses_multi_child_a', 'reviewer-0', 'deepseek-v4.1-flash')
        : sessionId === 'ses_multi_child_b'
          ? multiChildExports('ses_multi_child_b', 'reviewer-1', 'step-5-preview')
          : undefined;

  // Native OpenCode 2 session.list returns `{ data, cursor }`, and the final
  // non-empty page still advertises a `next` cursor, so the enumeration must
  // follow pagination until an empty page.
  const childSessionPage = (
    data: readonly unknown[],
    next: string | null,
    previous: string | null = null,
  ) => JSON.stringify({ data, cursor: { previous, next } });
  const pagesFor = (children: readonly unknown[]): readonly SessionPageResponse[] => [
    ...children.map((child, index) => ({
      stdout: childSessionPage(
        [child],
        `cursor-${index + 1}`,
        index === 0 ? null : `cursor-${index}`,
      ),
    })),
    { stdout: childSessionPage([], null, `cursor-${children.length}`) },
  ];

  type SessionPageResponse = {
    readonly stdout?: string;
    readonly exitCode?: number;
    readonly timedOut?: boolean;
    readonly truncated?: boolean;
  };
  const completedRootExport = JSON.stringify({
    ...JSON.parse(rootExport),
    messages: [
      {
        type: 'assistant',
        finish: 'stop',
        agent: 'multi-review-supervisor',
        model: { providerID: 'compte-rendu', id: 'deepseek-v4.1-flash' },
        content: [{ type: 'text', text: 'Completed synthesis without submitting.' }],
      },
      { type: 'idle', outcome: 'succeeded' },
    ],
  });
  const multiReminderJsonl = [
    JSON.stringify({
      type: 'text',
      sessionID: rootSession,
      part: { type: 'text', messageID: 'msg-multi-reminder', text: 'Submitting synthesis.' },
    }),
    JSON.stringify({
      type: 'text',
      sessionID: rootSession,
      part: {
        type: 'text',
        messageID: 'msg-root-continuation',
        text: JSON.stringify({ decision: 'request_changes', markdown: synthesisMarkdown }),
      },
    }),
  ].join('\n');

  type MultiScenarioOverrides = {
    readonly descriptors?: readonly unknown[];
    readonly children?: readonly (typeof defaultChildren)[number][];
    readonly pages?: readonly SessionPageResponse[];
    readonly exports?: Readonly<Record<string, string>>;
    readonly rootJsonl?: string;
    readonly agentRounds?: readonly string[];
    readonly rootExport?: string;
    readonly preReminderRootExport?: string;
    readonly continuedRootExport?: string;
    readonly runId?: string;
    readonly selection?: typeof selection;
    readonly agentExitCode?: number;
    readonly agentCredentialObserved?: boolean;
    readonly multiReviewWriteFailure?: boolean;
    readonly issuance?: 'http' | 'transport';
    readonly token?: string;
  };

  const runScenario = async (overrides: MultiScenarioOverrides = {}) => {
    const children = overrides.children ?? defaultChildren;
    const pages = overrides.pages ?? pagesFor(children);
    let sessionPage = 0;
    let expectedCursor: string | undefined;
    const rootJsonlValue = overrides.rootJsonl ?? rootJsonl;
    const agentOutputs = overrides.agentRounds ?? [rootJsonlValue];
    let agentRuns = 0;
    const archivedRootExport = overrides.continuedRootExport ?? overrides.rootExport ?? rootExport;
    const exportValue = (sessionId: string) =>
      overrides.exports?.[sessionId] ??
      (sessionId === rootSession
        ? agentRuns > 1
          ? archivedRootExport
          : (overrides.rootExport ?? rootExport)
        : defaultExport(sessionId));
    const controlRoot = await mkdtemp(join(tmpdir(), 'cr-multi-control-'));
    const relay = createRelayControl({
      descriptors: overrides.descriptors,
      ...(overrides.issuance === undefined ? {} : { issuance: overrides.issuance }),
      ...(overrides.token === undefined ? {} : { token: overrides.token }),
    });

    let createArgs: readonly string[] | undefined;
    let agentArgs: readonly string[] | undefined;
    const agentCommands: string[][] = [];
    const callbacks: Request[] = [];
    const events: Array<Record<string, unknown>> = [];
    const runner = createRunner({
      evidenceRoot: join(controlRoot, 'evidence'),
      authToken: 'runner-test-token',
      modelConfig: multiModelConfig,
      llmRelay: true,
      llmGrantVersion: overrides.descriptors ? 2 : 1,
      callbackUrl: 'https://ingress.test/runner-callback',
      callbackToken: 'callback-token',
      log: {
        record: async (event) => {
          events.push(event as Record<string, unknown>);
        },
      },
      callbackFetch: routeRelayControl(relay, async (input, init) => {
        callbacks.push(new Request(input, init));
        return new Response(null, { status: 202 });
      }),
      process: async (_command, args, options = {}) => {
        if (args[0] === 'create') {
          createArgs = args;
        }
        const isAgent = args[0] === 'exec' && args.includes('--agent');
        if (isAgent) {
          const output = agentOutputs[Math.min(agentRuns, agentOutputs.length - 1)]!;
          agentRuns += 1;
          agentArgs ??= args;
          agentCommands.push([...args]);
          if (overrides.multiReviewWriteFailure === true) {
            await mkdir(join(dirname(options.stdoutFilePath!), 'multi-review.json'), {
              recursive: true,
              mode: 0o700,
            });
          }
          await writeFile(options.stdoutFilePath!, `${output}\n`, {
            ...(options.fileAppend === true ? { flag: 'a' } : {}),
            mode: 0o600,
          });
          if (options.stderrFilePath !== undefined)
            await writeFile(options.stderrFilePath, 'agent stderr\n', {
              ...(options.fileAppend === true ? { flag: 'a' } : {}),
              mode: 0o600,
            });
          return {
            exitCode: overrides.agentExitCode ?? 0,
            stdout: output,
            timedOut: false,
            truncated: false,
            ...(overrides.agentCredentialObserved === true ? { credentialObserved: true } : {}),
          };
        }
        if (args[0] === 'exec' && args.includes('api') && args.includes('session.list')) {
          const cursor = args.find((argument) => argument.startsWith('cursor='))?.slice(7);
          if (!args.includes(`parentID=${rootSession}`) || cursor !== expectedCursor) {
            return { exitCode: 1, stdout: '', timedOut: false, truncated: false };
          }
          const page = pages[Math.min(sessionPage, pages.length - 1)] ?? {};
          sessionPage += 1;
          try {
            expectedCursor = JSON.parse(page.stdout ?? '').cursor?.next ?? undefined;
          } catch {
            expectedCursor = undefined;
          }
          return {
            exitCode: page.exitCode ?? 0,
            stdout: page.stdout ?? '',
            timedOut: page.timedOut ?? false,
            truncated: page.truncated ?? false,
          };
        }
        if (args[0] === 'exec' && args.includes('session') && args.includes('export')) {
          return {
            exitCode: 0,
            stdout: overrides.preReminderRootExport ?? overrides.rootExport ?? rootExport,
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'exec' && args.includes('session') && args.includes('list')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ id: rootSession }]),
            timedOut: false,
            truncated: false,
          };
        }
        if (args[0] === 'cp') {
          const source = args[1];
          const destination = args[2];
          const childId = /opencode-export-([A-Za-z0-9._:-]+)\.json$/.exec(source)?.[1];
          if (childId !== undefined && exportValue(childId) !== undefined) {
            await writeFile(destination, exportValue(childId)!, { mode: 0o600 });
          } else if (source.endsWith('/data') || source.endsWith('/state')) {
            await mkdir(destination, { recursive: true, mode: 0o700 });
            await writeFile(join(destination, 'opencode.db'), 'db', { mode: 0o600 });
            await writeFile(join(destination, 'review.log'), 'log', { mode: 0o600 });
          }
          return { exitCode: 0, stdout: '', timedOut: false, truncated: false };
        }
        return {
          exitCode: 0,
          stdout: args.includes('rev-parse') ? `${baseSha}\n${headSha}\n` : '',
          timedOut: false,
          truncated: false,
        };
      },
    });

    try {
      const submittedJob = {
        ...runnerJobFields,
        reviewConfiguration: overrides.selection ?? selection,
        runId: overrides.runId ?? 'run-multi-success',
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        baseSha,
        headSha,
      };
      runner.enqueue(submittedJob);
      const id = submittedJob.id;
      const terminal = await waitForTerminal(runner, id);
      const evidencePath = join(controlRoot, 'evidence', terminal.evidenceId as string);
      const manifest = JSON.parse(await readFile(join(evidencePath, 'manifest.json'), 'utf8'));
      const childExports: Record<string, unknown> = {};
      for (const sessionId of ['ses_multi_child_a', 'ses_multi_child_b']) {
        try {
          childExports[sessionId] = JSON.parse(
            await readFile(join(evidencePath, `opencode-export-${sessionId}.json`), 'utf8'),
          );
        } catch {
          childExports[sessionId] = undefined;
        }
      }
      const readEvidence = async (name: string): Promise<string | undefined> => {
        try {
          return await readFile(join(evidencePath, name), 'utf8');
        } catch {
          return undefined;
        }
      };
      const sessionPages = (await readdir(evidencePath))
        .filter((name) => /^opencode-child-sessions-\d+\.json$/.test(name))
        .sort();
      const sessionPageContents: Record<string, string> = {};
      for (const name of sessionPages) {
        sessionPageContents[name] = (await readEvidence(name))!;
      }
      const multiReviewText = await readEvidence('multi-review.json');
      return {
        terminal,
        manifest,
        callbacks,
        issued: relay.issued,
        revoked: relay.revoked,
        createArgs,
        agentArgs,
        agentCommands,
        events,
        evidencePath,
        childExports,
        sessionPageContents,
        multiReviewDocument:
          multiReviewText === undefined ? undefined : JSON.parse(multiReviewText),
      };
    } finally {
      await runner.close();
      await rm(controlRoot, { recursive: true, force: true });
    }
  };

  it('uses configured provider/model route IDs as OpenCode identities', () => {
    const config = JSON.parse(
      multiReviewConfig({
        selection: {
          reviewers: ['review-provider/gpt-6-luna', 'openai-platform/gpt-6-luna'],
          synthesis: 'review-provider/gpt-6-luna',
        },
        serviceBaseUrl: 'https://inference.example/v1',
        descriptors: [
          {
            routeId: 'review-provider/gpt-6-luna',
            profile: 'chat',
            limit: { context: 1_000_000, output: 384_000 },
            metadata: { name: 'Luna Go' },
          },
          {
            routeId: 'openai-platform/gpt-6-luna',
            profile: 'responses',
            limit: { context: 1_050_000, output: 128_000 },
            metadata: { name: 'Luna OpenAI' },
          },
        ],
        shellPermissionRules: [],
        reviewerTask: 'review task',
      }),
    );
    expect(config.model).toBe('review-provider/gpt-6-luna');
    expect(config.agents['reviewer-0'].model).toBe('review-provider/gpt-6-luna');
    expect(config.agents['reviewer-1'].model).toBe('openai-platform/gpt-6-luna');
    expect(Object.keys(config.providers['review-provider'].models)).toEqual(['gpt-6-luna']);
    expect(Object.keys(config.providers['openai-platform'].models)).toEqual(['gpt-6-luna']);
    expect(config.providers['review-provider']).toMatchObject({
      canonical: 'review-provider',
      settings: { baseURL: 'https://inference.example/v1' },
      models: {
        'gpt-6-luna': {
          modelID: 'review-provider/gpt-6-luna',
          name: 'Luna Go',
          limit: { context: 1_000_000, output: 384_000 },
        },
      },
    });
    expect(config.providers['openai-platform']).toMatchObject({
      canonical: 'openai-platform',
      settings: { baseURL: 'https://inference.example/v1' },
      models: {
        'gpt-6-luna': {
          modelID: 'openai-platform/gpt-6-luna',
          name: 'Luna OpenAI',
          package: '@opencode/ai/providers/openai',
          settings: {
            baseURL: 'https://inference.example/v1',
            apiKey: '{env:OPENCODE_API_KEY}',
          },
          limit: { context: 1_050_000, output: 128_000 },
        },
      },
    });
  });

  it('keeps the v1 provider and references when descriptors are absent', () => {
    const config = JSON.parse(
      multiReviewConfig({
        selection: {
          reviewers: ['review-provider/gpt-6-luna'],
          synthesis: 'review-provider/gpt-6-luna',
        },
        serviceBaseUrl: 'https://inference.example/v1',
        shellPermissionRules: [],
        reviewerTask: 'review task',
      }),
    );
    expect(config.model).toBe('compte-rendu/review-provider/gpt-6-luna');
    expect(config.agents.review.model).toBe('compte-rendu/review-provider/gpt-6-luna');
    expect(Object.keys(config.providers)).toEqual(['compte-rendu']);
    expect(config.providers['compte-rendu'].models).toEqual({
      'review-provider/gpt-6-luna': { settings: { baseURL: 'https://inference.example/v1' } },
    });
  });

  it('restores qualified child evidence routes from the selected model identity', async () => {
    const qualifiedSelection = {
      revision: 3,
      selection: {
        reviewers: ['review-provider/gpt-6-luna', 'openai-platform/gpt-6-luna'],
        synthesis: 'review-provider/gpt-6-luna',
      },
    };
    const children = [
      {
        id: 'ses_multi_child_a',
        parentID: rootSession,
        agent: 'reviewer-0',
        model: { providerID: 'review-provider', id: 'gpt-6-luna' },
        outcome: 'succeeded',
      },
      {
        id: 'ses_multi_child_b',
        parentID: rootSession,
        agent: 'reviewer-1',
        model: { providerID: 'openai-platform', id: 'gpt-6-luna' },
        outcome: 'succeeded',
      },
    ];
    const childExport = (id: string, agent: string, providerID: string) =>
      JSON.stringify({
        info: {
          id,
          parentID: rootSession,
          agent,
          model: { providerID, id: 'gpt-6-luna' },
          outcome: 'succeeded',
        },
        messages: [],
      });
    const qualifiedRoot = JSON.parse(rootExport) as {
      info: { model: { providerID: string; id: string } };
      messages: Array<{ model?: { providerID: string; id: string } }>;
    };
    qualifiedRoot.info.model = { providerID: 'review-provider', id: 'gpt-6-luna' };
    for (const message of qualifiedRoot.messages)
      if (message.model !== undefined)
        message.model = { providerID: 'review-provider', id: 'gpt-6-luna' };
    const result = await runScenario({
      selection: qualifiedSelection,
      descriptors: [
        { routeId: 'review-provider/gpt-6-luna', profile: 'chat' },
        { routeId: 'openai-platform/gpt-6-luna', profile: 'responses' },
      ],
      children,
      rootExport: JSON.stringify(qualifiedRoot),
      exports: {
        [rootSession]: JSON.stringify(qualifiedRoot),
        ses_multi_child_a: childExport('ses_multi_child_a', 'reviewer-0', 'review-provider'),
        ses_multi_child_b: childExport('ses_multi_child_b', 'reviewer-1', 'openai-platform'),
      },
    });
    expect(result.terminal).toMatchObject({ status: 'succeeded' });
    expect(
      (result.multiReviewDocument as { reviewers: Array<{ route: string }> }).reviewers.map(
        (reviewer) => reviewer.route,
      ),
    ).toEqual(['review-provider/gpt-6-luna', 'openai-platform/gpt-6-luna']);
  });

  it('delivers the frozen adapter per route while keeping reviewer identities stable', async () => {
    const result = await runScenario({
      descriptors: [
        {
          routeId: 'step-5-preview',
          profile: 'responses',
          limit: { context: 120000, output: 15000 },
        },
        { routeId: 'deepseek-v4.1-flash', profile: 'chat' },
      ],
    });
    expect(result.terminal.status).toBe('succeeded');
    const config = JSON.parse(
      result
        .createArgs!.find((x) => x.startsWith('OPENCODE_CONFIG_CONTENT='))!
        .slice('OPENCODE_CONFIG_CONTENT='.length),
    );
    expect(config.providers['compte-rendu'].models['step-5-preview'].package).toBe(
      '@opencode/ai/providers/openai',
    );
    expect(config.providers['compte-rendu'].models['step-5-preview'].limit).toEqual({
      context: 120000,
      output: 15000,
    });
    expect(config.agents['reviewer-1'].model).toBe('compte-rendu/step-5-preview');
  });

  it('applies discovered model metadata without replacing the trusted relay adapter', async () => {
    const result = await runScenario({
      descriptors: [
        {
          routeId: 'step-5-preview',
          profile: 'responses',
          limit: { context: 120000, output: 15000 },
          metadata: {
            name: 'Step 5 Preview',
            family: 'step',
            releaseDate: '2026-10-01',
            capabilities: {
              tools: true,
              input: ['text'],
              output: ['text'],
              reasoning: { supported: true, effort: ['low', 'high'] },
            },
            cost: { input: 1.25, output: 10, cache: { read: 0.25 } },
          },
        },
        { routeId: 'deepseek-v4.1-flash', profile: 'chat', metadata: { name: 'DeepSeek' } },
      ],
    });
    expect(result.terminal.status).toBe('succeeded');
    const config = JSON.parse(
      result
        .createArgs!.find((x) => x.startsWith('OPENCODE_CONFIG_CONTENT='))!
        .slice('OPENCODE_CONFIG_CONTENT='.length),
    );
    const provider = config.providers['compte-rendu'];
    expect(provider.settings.baseURL).toBe('https://inference.example/v1');
    expect(provider.models['step-5-preview']).toMatchObject({
      package: '@opencode/ai/providers/openai',
      settings: {
        baseURL: 'https://inference.example/v1',
        apiKey: '{env:OPENCODE_API_KEY}',
      },
      name: 'Step 5 Preview',
      family: 'step',
      releaseDate: '2026-10-01',
      limit: { context: 120000, output: 15000 },
      capabilities: {
        tools: true,
        input: ['text'],
        output: ['text'],
        reasoning: { supported: true, effort: ['low', 'high'] },
      },
      cost: { input: 1.25, output: 10, cache: { read: 0.25 } },
    });
    expect(provider.models['step-5-preview'].modelID).toBeUndefined();
    expect(provider.models['deepseek-v4.1-flash']).toMatchObject({ name: 'DeepSeek' });
  });

  it('configures signed Messages and path-routed Gemini models on the same sandbox relay', async () => {
    const result = await runScenario({
      descriptors: [
        { routeId: 'step-5-preview', profile: 'gemini' },
        { routeId: 'deepseek-v4.1-flash', profile: 'messages' },
      ],
    });
    const config = JSON.parse(
      result
        .createArgs!.find((x) => x.startsWith('OPENCODE_CONFIG_CONTENT='))!
        .slice('OPENCODE_CONFIG_CONTENT='.length),
    );
    const provider = config.providers['compte-rendu'];
    expect(provider.settings.apiKey).toBeUndefined();
    expect(provider.models['step-5-preview']).toMatchObject({
      package: '@opencode/ai/providers/google',
      modelID: 'r-c3RlcC01LXByZXZpZXc',
      settings: {
        baseURL: 'https://inference.example/v1beta',
        headers: { authorization: 'Bearer {env:OPENCODE_API_KEY}' },
      },
    });
    expect(provider.models['deepseek-v4.1-flash']).toMatchObject({
      package: '@opencode/ai/providers/anthropic',
      settings: { authToken: '{env:OPENCODE_API_KEY}', baseURL: 'https://inference.example/v1' },
    });
  });

  const validGrantDescriptors = [
    { routeId: 'deepseek-v4.1-flash', profile: 'chat' },
    { routeId: 'step-5-preview', profile: 'responses' },
  ];

  // Reuse the multi-model public scenario: every issuance failure must revoke
  // before the fixture records VM creation, and no body or grant may be logged.
  it.each([
    [
      'missing descriptor',
      {
        descriptors: [{ routeId: 'missing-route-body-canary', profile: 'responses' }],
        token: 'grant-token-canary',
      },
      'invalid-response',
      undefined,
    ],
    [
      'duplicate descriptor',
      {
        descriptors: [
          { routeId: 'deepseek-v4.1-flash', profile: 'chat' },
          { routeId: 'duplicate-route-body-canary', profile: 'responses' },
        ],
        token: 'grant-token-canary',
      },
      'invalid-response',
      undefined,
    ],
    [
      'unexpected descriptor',
      {
        descriptors: [
          { routeId: 'other-route-body-canary', profile: 'chat' },
          { routeId: 'step-5-preview', profile: 'responses' },
        ],
        token: 'grant-token-canary',
      },
      'invalid-response',
      undefined,
    ],
    [
      'unknown adapter descriptor',
      {
        descriptors: [
          { routeId: 'deepseek-v4.1-flash', profile: 'chat' },
          { routeId: 'schema-route-body-canary', profile: 'custom-script' },
        ],
        token: 'grant-token-canary',
      },
      'invalid-response',
      undefined,
    ],
    [
      'HTTP failure',
      {
        descriptors: validGrantDescriptors,
        issuance: 'http' as const,
      },
      'http-error',
      503,
    ],
    [
      'transport failure',
      {
        descriptors: validGrantDescriptors,
        issuance: 'transport' as const,
      },
      'transport-error',
      undefined,
    ],
  ])(
    'records a fixed %s grant diagnostic before VM creation and redacts credentials',
    async (_label, overrides, reason, status) => {
      const result = await runScenario(overrides);

      expect(result.terminal.status).toBe('failed');
      expect(result.createArgs).toBeUndefined();
      expect(result.revoked).toEqual([runnerJobFields.id]);
      expect(result.events).toContainEqual({
        phase: 'runner',
        outcome: 'grant',
        runId: 'run-multi-success',
        jobId: runnerJobFields.id,
        attempt: 1,
        reason,
        ...(status === undefined ? {} : { status }),
      });
      const observed = JSON.stringify({ terminal: result.terminal, events: result.events });
      expect(observed).not.toContain('canary');
      for (const { token } of result.issued) expect(observed).not.toContain(token);
    },
  );

  it('runs the frozen roster through native foreground subagents and publishes one synthesis', async () => {
    const result = await runScenario();

    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      sandbox: { cleanup: 'destroyed' },
      result: {
        version: 2,
        decision: 'request_changes',
        markdown: synthesisMarkdown,
      },
    });
    expect(result.issued).toHaveLength(1);
    expect(result.issued[0]?.routes).toEqual(['deepseek-v4.1-flash', 'step-5-preview']);
    expect(result.revoked).toEqual([runnerJobFields.id]);
    expect(result.agentArgs).toEqual(
      expect.arrayContaining([
        '--model',
        'compte-rendu/deepseek-v4.1-flash',
        '--agent',
        'multi-review-supervisor',
      ]),
    );
    const create = result.createArgs ?? [];
    const configEnv = create.find((value) => value.startsWith('OPENCODE_CONFIG_CONTENT='));
    expect(configEnv).toBeDefined();
    const config = JSON.parse(configEnv!.slice('OPENCODE_CONFIG_CONTENT='.length));
    expect(config.model).toBe('compte-rendu/deepseek-v4.1-flash');
    expect(config.providers['compte-rendu']).toMatchObject({
      canonical: 'opencode-go',
      package: '@opencode/ai/providers/openai-compatible',
    });
    expect(Object.keys(config.providers['compte-rendu'].models).sort()).toEqual([
      'deepseek-v4.1-flash',
      'step-5-preview',
    ]);
    expect(config.agents['multi-review-supervisor']).toMatchObject({
      mode: 'primary',
      permissions: expect.arrayContaining([
        { action: 'subagent', resource: 'reviewer-0', effect: 'allow' },
        { action: 'subagent', resource: 'reviewer-1', effect: 'allow' },
      ]),
    });
    expect(config.agents['reviewer-0']).toMatchObject({
      mode: 'subagent',
      permissions: expect.arrayContaining([{ action: 'subagent', resource: '*', effect: 'deny' }]),
    });
    expect(config.agents['reviewer-1']).toMatchObject({ mode: 'subagent' });
    const supervisorPromptText = (result.agentArgs ?? []).join(' ');
    expect(supervisorPromptText).toContain('reviewer-0');
    expect(supervisorPromptText).toContain('reviewer-1');
    expect(supervisorPromptText).toContain('synthesize');
    expect(supervisorPromptText).toContain('Start all configured reviewers in parallel');
    expect(supervisorPromptText).toContain('foreground subagent tasks (background: false)');
    expect(supervisorPromptText).toContain(
      'use exactly this task instruction as the prompt: ' +
        '"Perform one independent review using the complete task and output contract in your system instructions."',
    );
    expect(supervisorPromptText).toContain(
      'Do not restate, summarize, or replace that trusted task',
    );
    expect(supervisorPromptText).toContain('Wait for every configured reviewer to return');
    expect(supervisorPromptText).toContain(
      'Once their reviews return, only synthesize the supplied results',
    );
    expect(supervisorPromptText).toContain(
      'Do not request follow-up reviews or verification rounds',
    );
    expect(supervisorPromptText).toContain(
      'do not inspect the repository again to verify their conclusions',
    );
    // The supervisor keeps the synthesis contract but does not repeat the full
    // trusted review task it dispatches to each reviewer.
    expect(supervisorPromptText).not.toContain('Review task:');
    expect(supervisorPromptText).not.toContain('The token is a capability, never review evidence');
    expect(supervisorPromptText).not.toContain('gh pr view');
    expect(supervisorPromptText).toContain('TLDR:');
    expect(supervisorPromptText).toContain('Return your final answer in exactly this form');
    expect(supervisorPromptText).toContain('DECISION: approve');
    expect(supervisorPromptText).not.toContain('submit_review');

    const reviewerSystem = config.agents['reviewer-0'].system as string;
    expect(reviewerSystem).toBe(config.agents['reviewer-1'].system);
    expect(reviewerSystem).toContain(
      'You are one independent reviewer for this configured review.',
    );
    expect(reviewerSystem).toContain(baseSha);
    expect(reviewerSystem).toContain(headSha);
    expect(reviewerSystem).toContain('Load the bundled `code-review` skill');
    expect(reviewerSystem).toContain('The token is a capability, never review evidence');
    expect(reviewerSystem).toContain('This is a static review');
    expect(reviewerSystem).toContain('Return your final answer in exactly this form');
    expect(reviewerSystem).toContain('DECISION: approve');
    expect(reviewerSystem).toContain('TLDR:');

    expect(result.manifest.multiReview).toMatchObject({
      revision: 3,
      synthesis: { decision: 'request_changes', markdown: synthesisMarkdown },
    });
    expect(result.manifest.multiReview.reviewers).toHaveLength(2);
    expect(
      result.manifest.multiReview.reviewers.map(
        (reviewer: { sessionId: string; route: string }) => ({
          sessionId: reviewer.sessionId,
          route: reviewer.route,
        }),
      ),
    ).toEqual([
      { sessionId: 'ses_multi_child_a', route: 'deepseek-v4.1-flash' },
      { sessionId: 'ses_multi_child_b', route: 'step-5-preview' },
    ]);
    expect(result.manifest.files).toEqual(
      expect.arrayContaining([
        'opencode-export-ses_multi_root.json',
        'opencode-export-ses_multi_child_a.json',
        'opencode-export-ses_multi_child_b.json',
      ]),
    );
    expect(result.manifest.frozenSelection).toEqual({
      reviewers: ['deepseek-v4.1-flash', 'step-5-preview'],
      synthesis: 'deepseek-v4.1-flash',
    });
    // The top-level session list mirrors the archived root-only session list,
    // while every child stays in the multiReview provenance and exports.
    expect(result.manifest.sessionIds).toEqual([rootSession]);

    // The external process fixture rejects an incorrect parent or continuation
    // cursor. Successful results and retained evidence prove pagination works.
    expect(result.manifest.files).toEqual(
      expect.arrayContaining([
        'opencode-child-sessions-1.json',
        'opencode-child-sessions-2.json',
        'opencode-child-sessions-3.json',
        'multi-review.json',
      ]),
    );
    expect(result.sessionPageContents['opencode-child-sessions-1.json']).toContain(
      'ses_multi_child_a',
    );
    const multiReviewDocument = result.multiReviewDocument as {
      revision: number;
      frozenSelection: { reviewers: string[]; synthesis: string };
      rootSessionId: string;
      reviewers: Array<{ sessionId: string; route: string }>;
      synthesis: { decision: string; markdown: string };
    };
    expect(multiReviewDocument).toMatchObject({
      revision: 3,
      frozenSelection: {
        reviewers: ['deepseek-v4.1-flash', 'step-5-preview'],
        synthesis: 'deepseek-v4.1-flash',
      },
      rootSessionId: rootSession,
    });
    expect(multiReviewDocument.reviewers.map((reviewer) => reviewer.sessionId)).toEqual([
      'ses_multi_child_a',
      'ses_multi_child_b',
    ]);
    expect(multiReviewDocument.synthesis).toEqual({
      sessionId: rootSession,
      model: 'compte-rendu/deepseek-v4.1-flash',
      decision: 'request_changes',
      markdown: synthesisMarkdown,
    });

    expect(result.callbacks).toHaveLength(1);
    const callback = (await result.callbacks[0]!.json()) as {
      status: string;
      result: unknown;
      evidence: { manifest: { content: string } };
    };
    expect(callback.status).toBe('succeeded');
    expect(callback.result).toEqual({
      version: 2,
      decision: 'request_changes',
      markdown: synthesisMarkdown,
    });
    const callbackManifest = JSON.parse(
      Buffer.from(callback.evidence.manifest.content, 'base64').toString('utf8'),
    );
    expect(callbackManifest.multiReview.reviewers).toHaveLength(2);
    expect(callbackManifest.multiReview.synthesis).toMatchObject({
      decision: 'request_changes',
      markdown: synthesisMarkdown,
    });
    expect(callbackManifest.sessionIds).toEqual([rootSession]);

    for (const child of ['ses_multi_child_a', 'ses_multi_child_b']) {
      const exported = result.childExports[child] as {
        info: { parentID?: string; outcome?: string };
      };
      expect(exported.info.parentID).toBe(rootSession);
      expect(exported.info.outcome).toBe('succeeded');
    }
  });

  it('reminds the same multi supervisor session when normal completion omitted the synthesis', async () => {
    const result = await runScenario({
      runId: 'run-multi-reminder-success',
      agentRounds: [rootJsonl, multiReminderJsonl],
      preReminderRootExport: completedRootExport,
      continuedRootExport: rootExport,
    });

    expect(result.agentCommands).toHaveLength(2);
    expect(result.agentCommands[0]).toEqual(
      expect.arrayContaining([
        '--model',
        'compte-rendu/deepseek-v4.1-flash',
        '--agent',
        'multi-review-supervisor',
      ]),
    );
    expect(result.agentCommands[1]).toEqual(
      expect.arrayContaining([
        '--session',
        rootSession,
        '--model',
        'compte-rendu/deepseek-v4.1-flash',
        '--agent',
        'multi-review-supervisor',
      ]),
    );
    expect(result.issued[0]?.routes).toEqual(['deepseek-v4.1-flash', 'step-5-preview']);
    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(synthesisMarkdown, 'request_changes'),
      evidence: { status: 'complete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(result.manifest.sessionIds).toEqual([rootSession]);
    expect(result.manifest.multiReview).toMatchObject({
      synthesis: { decision: 'request_changes', markdown: synthesisMarkdown },
    });
    expect(result.callbacks).toHaveLength(1);
    const callback = (await result.callbacks[0]!.json()) as {
      status: string;
      result: unknown;
    };
    expect(callback).toMatchObject({
      status: 'succeeded',
      result: structuredResult(synthesisMarkdown, 'request_changes'),
    });
  });

  it('accepts the decision header from the multi supervisor without JSON escaping', async () => {
    const markdown =
      'TLDR: Request changes — the synthesized "quote" and newline stay raw.\n\n' +
      '## Finding\n\nThe supervisor writes Markdown, not an escaped JSON string.';
    const rootExportWithHeader = JSON.stringify({
      info: {
        id: rootSession,
        agent: 'multi-review-supervisor',
        model: { providerID: 'compte-rendu', id: 'deepseek-v4.1-flash' },
        outcome: 'succeeded',
      },
      messages: [
        {
          id: 'msg-root-final',
          type: 'assistant',
          finish: 'stop',
          agent: 'multi-review-supervisor',
          model: { providerID: 'compte-rendu', id: 'deepseek-v4.1-flash' },
          content: [{ type: 'text', text: decisionText('request_changes', markdown) }],
        },
        { type: 'idle', outcome: 'succeeded' },
      ],
    });
    const result = await runScenario({
      runId: 'run-multi-decision-header',
      rootExport: rootExportWithHeader,
    });

    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: structuredResult(markdown, 'request_changes'),
      evidence: { status: 'complete' },
    });
    expect(result.manifest.multiReview).toMatchObject({
      synthesis: { decision: 'request_changes', markdown },
    });
  });

  it('delivers the shared review contract directly and in every reviewer system', async () => {
    const single = await runAgentScenario({
      runId: 'run-shared-prompt-single',
      output: finalMarkdownJsonl(),
    });
    const multi = await runScenario({ runId: 'run-shared-prompt-multi' });
    const singlePrompt = single.agentArgs?.join(' ') ?? '';
    const multiSupervisorPrompt = multi.agentArgs?.join(' ') ?? '';
    const multiConfig = JSON.parse(
      multi
        .createArgs!.find((value) => value.startsWith('OPENCODE_CONFIG_CONTENT='))!
        .slice('OPENCODE_CONFIG_CONTENT='.length),
    );
    const reviewerPrompts = ['reviewer-0', 'reviewer-1'].map(
      (participant) => multiConfig.agents[participant].system as string,
    );

    for (const prompt of [singlePrompt, ...reviewerPrompts]) {
      expect(prompt).toContain('Load the bundled `code-review` skill');
      expect(prompt).toContain('during independent review');
      expect(prompt).toContain('The skill supplies the review method');
      expect(prompt).toContain(
        'this contract controls scope, tool permissions, orchestration and final output',
      );
      expect(prompt).not.toContain('Use an available topic review skill');
      expect(prompt).not.toContain('Challenge the premise');
      expect(prompt).toContain('Consolidate observations sharing one root cause');
      expect(prompt).toContain('merge disposition');
      expect(prompt).toContain('TLDR:');
      expect(prompt).toContain('Return your final answer in exactly this form');
      expect(prompt).toContain('DECISION: approve');
      expect(prompt).toContain('decision');
      expect(prompt).toContain('Markdown');
      expect(prompt).toContain('This is a static review');
      expect(prompt).toContain('The token is a capability, never review evidence');
      expect(prompt).toContain('every review thread plus independently paginated reply');
      expect(prompt).toContain('Count the nodes and require every connection to report');
      expect(prompt).not.toContain('First load the pr-review skill');
      expect(prompt).not.toContain('submit_review');
      expect(prompt).not.toContain('## Review:');
    }
    expect(singlePrompt).toContain('There is one configured reviewer');
    expect(singlePrompt).not.toContain('reviewer-1');
    for (const prompt of reviewerPrompts) {
      expect(prompt).not.toContain('There is one configured reviewer');
    }
    expect(multiSupervisorPrompt).toContain('reviewer-0');
    expect(multiSupervisorPrompt).toContain('reviewer-1');
    expect(multiSupervisorPrompt).toContain('synthesize');
    expect(multiSupervisorPrompt).toContain('As supervisor, do not load the skill yourself');
    expect(multiSupervisorPrompt).toContain(
      'The full Review task and Final output contract are provided to each reviewer in its system instructions',
    );
    expect(multiSupervisorPrompt).toContain('Do not load skills or inspect code during synthesis');
    expect(multiSupervisorPrompt).toContain(
      'use exactly this task instruction as the prompt: ' +
        '"Perform one independent review using the complete task and output contract in your system instructions."',
    );
    expect(multiSupervisorPrompt).not.toContain('The token is a capability, never review evidence');
  });

  it('uses only the reviewer route for a one-model roster with a distinct synthesis alias', async () => {
    const reviewer = 'deepseek-v4.1-flash';
    const finalText = JSON.stringify({ decision: 'request_changes', markdown: synthesisMarkdown });
    const directExport = JSON.stringify({
      info: {
        id: rootSession,
        agent: 'review',
        model: { providerID: 'compte-rendu', id: reviewer },
        outcome: 'succeeded',
      },
      messages: [
        {
          id: 'msg-root-final',
          type: 'assistant',
          finish: 'stop',
          agent: 'review',
          model: { providerID: 'compte-rendu', id: reviewer },
          content: [{ type: 'text', text: finalText }],
        },
        { type: 'idle', outcome: 'succeeded' },
      ],
    });
    const directJsonl = JSON.stringify({
      type: 'text',
      sessionID: rootSession,
      part: { type: 'text', messageID: 'msg-root-final', text: finalText },
    });
    const result = await runScenario({
      runId: 'run-one-reviewer-distinct-synthesis',
      selection: {
        revision: 4,
        selection: { reviewers: [reviewer], synthesis: 'step-5-preview' },
      },
      agentRounds: [directJsonl],
      rootExport: directExport,
      children: [],
    });

    expect(result.issued).toHaveLength(1);
    expect(result.issued[0]?.routes).toEqual([reviewer]);
    expect(result.agentArgs).toEqual(
      expect.arrayContaining(['--model', `compte-rendu/${reviewer}`, '--agent', 'review']),
    );
    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: { version: 2, decision: 'request_changes', markdown: synthesisMarkdown },
    });
    expect(result.manifest.model).toBe(`compte-rendu/${reviewer}`);
    expect(result.manifest.multiReview.synthesis.model).toBe(`compte-rendu/${reviewer}`);
    expect((result.multiReviewDocument as { synthesis: { model: string } }).synthesis.model).toBe(
      `compte-rendu/${reviewer}`,
    );
    const create = result.createArgs ?? [];
    const configEnv = create.find((value) => value.startsWith('OPENCODE_CONFIG_CONTENT='));
    const config = JSON.parse(configEnv!.slice('OPENCODE_CONFIG_CONTENT='.length));
    expect(config.agents.review).toMatchObject({
      mode: 'primary',
      model: `compte-rendu/${reviewer}`,
    });
    expect(config.agents['multi-review-supervisor']).toBeUndefined();
    expect(config.agents['reviewer-0']).toBeUndefined();
  });

  it('recovers a known provider error for a multi review from its exported final result', async () => {
    const error = JSON.stringify({
      type: 'error',
      sessionID: rootSession,
      error: { type: 'provider.invalid-output', status: 200 },
    });
    const result = await runScenario({
      runId: 'run-multi-recovered-provider',
      agentRounds: [`${error}\n${rootJsonl}`],
      agentExitCode: 1,
    });

    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: { version: 2, decision: 'request_changes', markdown: synthesisMarkdown },
    });
    expect(result.manifest.multiReview.synthesis).toMatchObject({
      decision: 'request_changes',
      markdown: synthesisMarkdown,
    });
    expect(result.manifest.multiReview.reviewers).toHaveLength(2);
  });

  it('does not generically recover a multi review with an invalid exported result', async () => {
    const error = JSON.stringify({
      type: 'error',
      sessionID: rootSession,
      error: { type: 'provider.invalid-output', status: 200 },
    });
    const result = await runScenario({
      runId: 'run-multi-recovered-invalid',
      agentRounds: [`${error}\n${rootJsonl}`],
      agentExitCode: 1,
      rootExport: completedRootExport,
    });

    expect(result.terminal.status).toBe('failed');
    expect(result.terminal).not.toHaveProperty('result');
  });

  it('publishes the actual generated multi callback through Core with root-only session evidence', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    try {
      const claim = await stateStore.claimReview({
        deliveryId: 'delivery-multi-final',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 42,
          baseSha,
          headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (claim.kind !== 'claimed') throw new Error('multi review run was not claimed');
      await claimRunnerJob(stateStore, { runId: claim.runId, jobId: runnerJobFields.id });

      const result = await runScenario({ runId: claim.runId });
      expect(result.terminal).toMatchObject({ status: 'succeeded' });
      const callback = result.callbacks[0]!;

      const reviews: unknown[] = [];
      const env = {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      };
      const worker = createCoreWorker(env, {
        github: {
          loadReviewTarget: async () => ({ headSha }),
          createReview: async ({ payload }) => {
            reviews.push(payload);
            return { kind: 'created', review: payload };
          },
        },
      });

      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body: await callback.clone().text(),
        }),
        env,
        { waitUntil: () => undefined },
      );

      expect(response.status).toBe(202);
      // A 202 alone also covers an evidence rejection that marks the run failed,
      // so observe the stored published outcome and the publication payload.
      expect(await stateStore.getRunOutcome(claim.runId)).toMatchObject({
        status: 'completed',
        decision: 'request_changes',
      });
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ event: 'REQUEST_CHANGES', commit_id: headSha });
      expect((reviews[0] as { body: string }).body).toContain(synthesisMarkdown);
    } finally {
      database.close();
    }
  });

  it('persists a Runner-produced upstream provider failure through Core', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    try {
      const claim = await stateStore.claimReview({
        deliveryId: 'delivery-multi-upstream',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 42,
          baseSha,
          headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (claim.kind !== 'claimed') throw new Error('upstream review run was not claimed');
      await claimRunnerJob(stateStore, { runId: claim.runId, jobId: runnerJobFields.id });

      const error = JSON.stringify({
        type: 'error',
        sessionID: rootSession,
        error: {
          type: 'provider.invalid-request',
          message: 'model request failed',
          status: 400,
        },
      });
      const result = await runScenario({
        runId: claim.runId,
        rootJsonl: error,
        agentExitCode: 1,
      });
      expect(result.terminal).toMatchObject({
        status: 'failed',
        failure: { reason: 'upstream', cause: 'upstream-error', httpStatus: 400 },
      });
      const callback = result.callbacks[0]!;

      const env = {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      };
      const worker = createCoreWorker(env, { github: {} });
      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body: await callback.clone().text(),
        }),
        env,
        { waitUntil: () => undefined },
      );
      expect(response.status).toBe(202);

      const reader = createCoreWorker(env, { github: {} });
      const detail = await (
        await reader.fetch(new Request(`https://core.internal/api/jobs/${claim.runId}`))
      ).json();
      expect(detail).toMatchObject({
        task: {
          status: 'failed',
          failure: { phase: 'agent', reason: 'upstream', httpStatus: 400 },
        },
      });
    } finally {
      database.close();
    }
  });

  const wrongRootAssistantModel = JSON.parse(rootExport);
  wrongRootAssistantModel.messages[0].model.id = 'step-5-preview';
  const rootWrongAgent = JSON.parse(rootExport);
  rootWrongAgent.info.agent = 'reviewer-0';
  const rootInvalidDecision = JSON.parse(rootExport);
  rootInvalidDecision.messages[0].content[0].text = JSON.stringify({
    decision: 'maybe',
    markdown: synthesisMarkdown,
  });
  const rootZeroSubmission = JSON.parse(rootExport);
  rootZeroSubmission.messages[0].content[0].text = 'Prose without review JSON.';
  const rootNoTerminalIdle = JSON.parse(rootExport);
  rootNoTerminalIdle.messages = rootNoTerminalIdle.messages.slice(0, -1);
  const rootMalformedFinalAssistant = JSON.parse(rootExport);
  rootMalformedFinalAssistant.messages = [
    ...JSON.parse(rootExport).messages,
    { type: 'assistant', finish: 'stop', content: 'not-an-array' },
    { type: 'idle', outcome: 'succeeded' },
  ];
  const rootMalformedTextPart = JSON.parse(rootExport);
  rootMalformedTextPart.messages[0].content.push({ type: 'text', text: 123 });

  const failureCases: ReadonlyArray<readonly [string, MultiScenarioOverrides, string]> = [
    [
      'a root assistant with the wrong model',
      { rootExport: JSON.stringify(wrongRootAssistantModel) },
      'result-schema-failure',
    ],
    [
      'a root session with the wrong agent',
      { rootExport: JSON.stringify(rootWrongAgent) },
      'result-schema-failure',
    ],
    [
      'an invalid final decision',
      { rootExport: JSON.stringify(rootInvalidDecision) },
      'result-schema-failure',
    ],
    [
      'a root without a terminal idle message',
      { rootExport: JSON.stringify(rootNoTerminalIdle) },
      'missing-terminal-message',
    ],
    [
      'a root without review JSON',
      { rootExport: JSON.stringify(rootZeroSubmission) },
      'result-schema-failure',
    ],
    [
      'a malformed final assistant',
      { rootExport: JSON.stringify(rootMalformedFinalAssistant) },
      'missing-terminal-message',
    ],
    [
      'a malformed known text part',
      { rootExport: JSON.stringify(rootMalformedTextPart) },
      'result-schema-failure',
    ],
  ];

  it.each(failureCases)('fails closed for %s', async (_name, overrides, cause) => {
    const result = await runScenario(overrides);
    expect(result.terminal).toMatchObject({
      status: 'failed',
      sandbox: { cleanup: 'destroyed' },
      failure: { reason: 'invalid-output', cause },
    });
    expect(result.terminal).not.toHaveProperty('result');
    const callback = (await result.callbacks[0]!.json()) as {
      status: string;
      result?: unknown;
    };
    expect(callback.status).toBe('failed');
    expect(callback.result).toBeUndefined();
  });

  it('retains frozen selection and available child evidence after a failed root review', async () => {
    const result = await runScenario({ rootExport: JSON.stringify(rootInvalidDecision) });

    expect(result.terminal).toMatchObject({
      status: 'failed',
      sandbox: { cleanup: 'destroyed' },
      failure: { reason: 'invalid-output', cause: 'result-schema-failure' },
    });
    expect(result.manifest.frozenSelection).toEqual({
      reviewers: ['deepseek-v4.1-flash', 'step-5-preview'],
      synthesis: 'deepseek-v4.1-flash',
    });
    const document = result.multiReviewDocument as {
      rootSessionId: string;
      sessions: Array<{ sessionId: string }>;
    };
    expect(document.rootSessionId).toBe(rootSession);
    expect(document.sessions.map((session) => session.sessionId)).toEqual(
      expect.arrayContaining([rootSession, 'ses_multi_child_a', 'ses_multi_child_b']),
    );
    expect(result.manifest.files).toEqual(
      expect.arrayContaining(['multi-review.json', 'opencode-export-ses_multi_child_a.json']),
    );
  });

  it('preserves a credential-in-output cause when multi-review evidence cannot be written', async () => {
    const result = await runScenario({
      runId: 'run-multi-credential-write-failure',
      agentCredentialObserved: true,
      multiReviewWriteFailure: true,
    });

    expect(result.terminal).toMatchObject({
      status: 'failed',
      failure: { reason: 'evidence' },
      evidence: { status: 'incomplete' },
      sandbox: { cleanup: 'destroyed' },
    });
    expect(result.terminal).not.toHaveProperty('result');
    expect(result.manifest).toMatchObject({
      evidenceFailure: 'credential-in-output',
      terminal: { status: 'failed', reason: 'evidence' },
    });
  });

  it('accepts unrelated extra fields in the final submission and publishes only decision and markdown', async () => {
    const withExtras = JSON.parse(rootExport);
    withExtras.messages[0].content[0].text = JSON.stringify({
      decision: 'request_changes',
      markdown: synthesisMarkdown,
      findings: [{ id: 'f1', location: 'x', claim: 'c', impact: 'i', evidence: 'e' }],
      coverage: [],
    });
    const result = await runScenario({ rootExport: JSON.stringify(withExtras) });

    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: { version: 2, decision: 'request_changes', markdown: synthesisMarkdown },
    });
    expect(
      (result.terminal as { result?: { findings?: unknown } }).result?.findings,
    ).toBeUndefined();
  });

  it('uses only the last assistant message and ignores earlier invalid text', async () => {
    const intermediate = JSON.parse(rootExport);
    intermediate.messages.unshift({
      id: 'msg-root-intermediate',
      type: 'assistant',
      finish: 'stop',
      agent: 'multi-review-supervisor',
      model: { providerID: 'compte-rendu', id: 'deepseek-v4.1-flash' },
      content: [{ type: 'text', text: '{"decision":"maybe"}' }],
    });
    const result = await runScenario({ rootExport: JSON.stringify(intermediate) });

    expect(result.terminal).toMatchObject({
      status: 'succeeded',
      result: { version: 2, decision: 'request_changes', markdown: synthesisMarkdown },
    });
  });

  it('archives available child sessions without capping them at the roster', async () => {
    const extra = {
      id: 'ses_multi_child_c',
      parentID: rootSession,
      agent: 'reviewer-2',
      model: { providerID: 'compte-rendu', id: 'another-model' },
      outcome: 'succeeded',
    };
    const result = await runScenario({ children: [...defaultChildren, extra] });

    expect(result.terminal).toMatchObject({ status: 'succeeded' });
    expect(result.manifest.files).toEqual(
      expect.arrayContaining(['opencode-export-ses_multi_child_c.json']),
    );
  });
});

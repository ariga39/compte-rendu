import { describe, expect, it } from 'vitest';
import {
  createReviewSandbox,
  type ReviewDeadline,
} from '../apps/core/src/cloudflare-review-adapter';
import { createReviewRunner, type ReviewRunSpec } from '../apps/core/src/review-run';
import type { OperationalLogEvent } from '../packages/contracts/src';

const sha = (digit: string) => digit.repeat(40);

const makeSpec = (overrides: Partial<ReviewRunSpec> = {}): ReviewRunSpec => ({
  runId: 'run-lease-1',
  repositoryUrl: 'https://github.com/acme/reviewed.git',
  baseSha: sha('1'),
  headSha: sha('2'),
  checkoutToken: 'checkout-token-for-test',
  modelCredential: 'model-token-for-test',
  ...overrides,
});

const validAgentOutput = JSON.stringify({
  type: 'text',
  timestamp: 1735689600000,
  sessionID: 'session-test',
  part: {
    type: 'text',
    text: JSON.stringify({ findings: [], summary: 'No findings' }),
    ignoredProviderField: 'ignored',
  },
});

const processOutput = (stdout: string, exitCode = 0) => ({
  output: async () => ({
    stdout,
    stderr: '',
    exitCode,
    timedOut: false,
    truncated: false,
  }),
});

describe('runWithLease', () => {
  it('clears a lease when Sandbox acquisition fails so retry can use a fresh Sandbox', async () => {
    let activeLease = false;
    let firstSandbox = true;
    const sandboxIds = new Set<string>();

    const runner = createReviewRunner({
      lease: {
        register: async () => {
          if (activeLease) throw new Error('previous lease is still active');
          activeLease = true;
          return {
            clear: async () => {
              activeLease = false;
            },
            rearm: async () => {},
          };
        },
      },
      sandbox: {
        getSandbox: async (sandboxId) => {
          sandboxIds.add(sandboxId);
          if (firstSandbox) {
            firstSandbox = false;
            throw new Error('Sandbox acquisition interrupted');
          }
          return {
            checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
            removeCheckoutCredentials: async () => {},
            runAgent: async () => ({ exitCode: 0, stdout: validAgentOutput, stderr: '' }),
            destroy: async () => {},
          };
        },
      },
    });

    const result = await runner.runWithLease(makeSpec({ maxAttempts: 2 }));

    expect(result).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(sandboxIds).toEqual(new Set(['run-lease-1-attempt-1', 'run-lease-1-attempt-2']));
  });

  it('fails checkout when the raw Sandbox reports an unexpected base commit', async () => {
    const requestedBaseSha = sha('1');
    const requestedHeadSha = sha('2');
    const actualBaseSha = sha('3');
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => processOutput(`${actualBaseSha}\n${requestedHeadSha}\n`),
      destroy: async () => undefined,
    };
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () => createReviewSandbox(rawSandbox),
      },
    });

    const result = await runner.runWithLease(
      makeSpec({ baseSha: requestedBaseSha, headSha: requestedHeadSha }),
    );

    expect(result).toMatchObject({ status: 'failed', reason: 'checkout' });
  });

  it('accepts checkout SHAs from a Sandbox 1.0 process output', async () => {
    const requestedBaseSha = sha('1');
    const requestedHeadSha = sha('2');
    const sandbox = createReviewSandbox({
      writeFile: async () => undefined,
      exec: async () => processOutput(`${requestedBaseSha}\n${requestedHeadSha}\n`),
      destroy: async () => undefined,
    });

    const result = await sandbox.checkout({
      repositoryUrl: 'https://github.com/acme/reviewed.git',
      baseSha: requestedBaseSha,
      headSha: requestedHeadSha,
      checkoutToken: 'checkout-token-for-test',
    });

    expect(result).toEqual({ baseSha: requestedBaseSha, headSha: requestedHeadSha });
  });

  it('does not start a lazy Sandbox operation when durable lease and alarm registration fails', async () => {
    let started = false;

    const runner = createReviewRunner({
      lease: {
        register: async () => {
          throw new Error('lease storage unavailable');
        },
      },
      sandbox: {
        getSandbox: async () => ({
          checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
          removeCheckoutCredentials: async () => {},
          runAgent: async () => {
            started = true;
            return { exitCode: 0, stdout: validAgentOutput, stderr: '' };
          },
          destroy: async () => {},
        }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'failed', reason: 'lease' });
    expect(started).toBe(false);
  });

  it('completes leased work and leaves no Sandbox after normal cleanup', async () => {
    let started = false;
    let destroyed = false;

    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () => ({
          checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
          removeCheckoutCredentials: async () => {},
          runAgent: async () => {
            started = true;
            return { exitCode: 0, stdout: validAgentOutput, stderr: '' };
          },
          destroy: async () => {
            destroyed = true;
          },
        }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'succeeded', attempt: 1 });
    expect(started).toBe(true);
    expect(destroyed).toBe(true);
  });

  it('records a clean runner terminal event after Sandbox and lease cleanup', async () => {
    const events: OperationalLogEvent[] = [];
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () => ({
          checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
          removeCheckoutCredentials: async () => {},
          runAgent: async () => ({ exitCode: 0, stdout: validAgentOutput, stderr: '' }),
          destroy: async () => {},
        }),
      },
      log: {
        record: async (event) => {
          events.push(event);
          throw new Error('log sink unavailable');
        },
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'succeeded', attempt: 1 });
    expect(events).toEqual([
      {
        phase: 'runner',
        outcome: 'succeeded',
        runId: 'run-lease-1',
        attempt: 1,
        sandboxId: 'run-lease-1-attempt-1',
        cleanup: 'sandbox_destroyed_lease_cleared',
      },
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('https://github.com/acme/reviewed.git');
    expect(serialized).not.toContain('checkout-token-for-test');
    expect(serialized).not.toContain('model-token-for-test');
    expect(serialized).not.toContain(sha('1'));
    expect(serialized).not.toContain(sha('2'));
  });

  it('keeps review and cleanup successful when agent lifecycle logging fails', async () => {
    let destroyed = false;
    let leaseCleared = false;
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => processOutput(`${sha('1')}\n${sha('2')}\n`),
      destroy: async () => {
        destroyed = true;
      },
    };
    const log = {
      record: async (_event: OperationalLogEvent) => {
        throw new Error('lifecycle log unavailable');
      },
    };
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {
            leaseCleared = true;
          },
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () =>
          createReviewSandbox(
            rawSandbox,
            {
              createClient: async () => ({
                client: {
                  session: {
                    create: async () => ({ id: 'review-session' }),
                    prompt: async () => ({
                      info: {},
                      parts: [
                        {
                          type: 'text',
                          text: JSON.stringify({ findings: [], summary: 'No findings' }),
                        },
                      ],
                    }),
                    abort: async () => true,
                  },
                },
                process: {
                  id: 'review-process',
                  kill: async () => undefined,
                  waitForExit: async () => undefined,
                },
              }),
            },
            undefined,
            { sandboxId: 'run-lease-1-attempt-1', log },
          ),
      },
      log,
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'succeeded', output: { summary: 'No findings' } });
    expect(destroyed).toBe(true);
    expect(leaseCleared).toBe(true);
  });

  it('records a failed runner terminal event after an agent failure is cleaned up', async () => {
    const events: OperationalLogEvent[] = [];
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () => ({
          checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
          removeCheckoutCredentials: async () => {},
          runAgent: async () => ({ exitCode: 1, stdout: 'agent output', stderr: 'agent error' }),
          destroy: async () => {},
        }),
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'agent',
      attempt: 1,
      sandboxId: 'run-lease-1-attempt-1',
      leaseRetained: false,
    });
    expect(events).toEqual([
      {
        phase: 'runner',
        outcome: 'failed',
        runId: 'run-lease-1',
        attempt: 1,
        sandboxId: 'run-lease-1-attempt-1',
        reason: 'agent',
        retryable: true,
        leaseRetained: false,
      },
    ]);
  });

  it('keeps cleanup failure terminal and does not lazy-start a replacement Sandbox', async () => {
    let rearmed = false;
    let firstSandbox = true;
    let replacementStarted = false;
    let destroyed = false;
    let destroyAttempts = 0;
    let alarmDestroy: (() => Promise<void>) | undefined;
    const events: OperationalLogEvent[] = [];

    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {
            rearmed = true;
            await alarmDestroy?.();
          },
        }),
      },
      sandbox: {
        getSandbox: async () => {
          const destroy = async () => {
            destroyAttempts += 1;
            if (destroyAttempts === 1) {
              throw new Error('destroy interrupted');
            }
            destroyed = true;
          };
          alarmDestroy = destroy;
          return {
            checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
            removeCheckoutCredentials: async () => {},
            runAgent: async () => {
              if (!firstSandbox) replacementStarted = true;
              firstSandbox = false;
              return { exitCode: 1, stdout: '', stderr: 'agent failed' };
            },
            destroy,
          };
        },
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });

    const result = await runner.runWithLease(makeSpec({ maxAttempts: 2 }));

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'cleanup',
      retryable: false,
      leaseRetained: true,
    });
    expect(rearmed).toBe(true);
    expect(destroyed).toBe(true);
    expect(replacementStarted).toBe(false);
    expect(events).toEqual([
      {
        phase: 'runner',
        outcome: 'failed',
        runId: 'run-lease-1',
        attempt: 1,
        sandboxId: 'run-lease-1-attempt-1',
        reason: 'cleanup',
        retryable: false,
        leaseRetained: true,
      },
    ]);
  });

  it('uses a fresh Sandbox after retryable work failure and successful cleanup', async () => {
    let workAttempt = 0;
    const startedSandboxIds = new Set<string>();

    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async (sandboxId) => ({
          checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
          removeCheckoutCredentials: async () => {},
          runAgent: async () => {
            startedSandboxIds.add(sandboxId);
            workAttempt += 1;
            return {
              exitCode: workAttempt === 1 ? 1 : 0,
              stdout: workAttempt === 1 ? '' : validAgentOutput,
              stderr: '',
            };
          },
          destroy: async () => {},
        }),
      },
    });

    const result = await runner.runWithLease(makeSpec({ maxAttempts: 2 }));

    expect(result).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(startedSandboxIds).toEqual(new Set(['run-lease-1-attempt-1', 'run-lease-1-attempt-2']));
  });

  it('stops before the agent when checkout does not prove the requested head SHA', async () => {
    let agentStarted = false;
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () => ({
          checkout: async ({ baseSha }) => ({ baseSha, headSha: sha('9') }),
          removeCheckoutCredentials: async () => {},
          runAgent: async () => {
            agentStarted = true;
            return { exitCode: 0, stdout: '', stderr: '' };
          },
          destroy: async () => {},
        }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'failed', reason: 'checkout' });
    expect(agentStarted).toBe(false);
  });

  it('does not start the agent while checkout credentials remain available', async () => {
    let credentialsRemoved = false;
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () => ({
          checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
          removeCheckoutCredentials: async () => {
            credentialsRemoved = true;
          },
          runAgent: async () => {
            if (!credentialsRemoved) {
              throw new Error('checkout credential is still present');
            }
            return { exitCode: 0, stdout: validAgentOutput, stderr: '' };
          },
          destroy: async () => {},
        }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'succeeded' });
  });

  it('returns the single validated review output from the OpenCode JSONL stream', async () => {
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () => ({
          checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
          removeCheckoutCredentials: async () => {},
          runAgent: async () => ({ exitCode: 0, stdout: validAgentOutput, stderr: '' }),
          destroy: async () => {},
        }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({
      status: 'succeeded',
      output: { findings: [], summary: 'No findings' },
    });
  });

  it('rejects an ambiguous review returned by the managed OpenCode client', async () => {
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => processOutput(`${sha('1')}\n${sha('2')}\n`),
      destroy: async () => undefined,
    };
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () =>
          createReviewSandbox(rawSandbox, {
            createClient: async () => ({
              client: {
                session: {
                  create: async () => ({ id: 'review-session' }),
                  prompt: async () => ({
                    info: {},
                    parts: [
                      { type: 'text', text: JSON.stringify({ findings: [], summary: 'first' }) },
                      { type: 'text', text: JSON.stringify({ findings: [], summary: 'second' }) },
                    ],
                  }),
                  abort: async () => true,
                },
              },
              process: {
                id: 'review-process',
                kill: async () => {},
                waitForExit: async () => undefined,
              },
            }),
          }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'failed', reason: 'invalid-output' });
  });

  it('keeps a valid review when managed OpenCode close fails', async () => {
    let destroyed = false;
    let leaseCleared = false;
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => processOutput(`${sha('1')}\n${sha('2')}\n`),
      destroy: async () => {
        destroyed = true;
      },
    };
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {
            leaseCleared = true;
          },
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () =>
          createReviewSandbox(rawSandbox, {
            createClient: async () => ({
              client: {
                session: {
                  create: async () => ({ id: 'review-session' }),
                  prompt: async () => ({
                    info: {},
                    parts: [
                      {
                        type: 'text',
                        text: JSON.stringify({ findings: [], summary: 'No findings' }),
                      },
                    ],
                  }),
                  abort: async () => true,
                },
              },
              process: {
                id: 'review-process',
                kill: async () => {
                  throw new Error('managed close failed');
                },
                waitForExit: async () => undefined,
              },
            }),
          }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({
      status: 'succeeded',
      output: { findings: [], summary: 'No findings' },
    });
    expect(destroyed).toBe(true);
    expect(leaseCleared).toBe(true);
  });

  it('fails closed when the OpenCode JSONL stream is malformed', async () => {
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () => ({
          checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
          removeCheckoutCredentials: async () => {},
          runAgent: async () => ({ exitCode: 0, stdout: '{not-json}', stderr: '' }),
          destroy: async () => {},
        }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'failed', reason: 'invalid-output' });
  });

  it('fails closed when the final text JSON does not match the review output schema', async () => {
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () => ({
          checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
          removeCheckoutCredentials: async () => {},
          runAgent: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              type: 'text',
              text: JSON.stringify({ summary: 'missing findings' }),
            }),
            stderr: '',
          }),
          destroy: async () => {},
        }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'failed', reason: 'invalid-output' });
  });

  it('fails when the OpenCode adapter reports a CLI error', async () => {
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () => ({
          checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
          removeCheckoutCredentials: async () => {},
          runAgent: async () => ({
            exitCode: 1,
            stdout: validAgentOutput,
            stderr: 'opencode failed',
          }),
          destroy: async () => {},
        }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'failed', reason: 'agent' });
  });

  it('fails with timeout when the OpenCode adapter reports a deadline interruption', async () => {
    const sandboxIds: string[] = [];
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async (sandboxId) => {
          sandboxIds.push(sandboxId);
          return {
            checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
            removeCheckoutCredentials: async () => {},
            runAgent: async () => ({
              exitCode: 1,
              stdout: '',
              stderr: 'timed out',
              timedOut: true,
            }),
            destroy: async () => {},
          };
        },
      },
    });

    const result = await runner.runWithLease(makeSpec({ maxAttempts: 2 }));

    expect(result).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(sandboxIds).toEqual(['run-lease-1-attempt-1']);
  });

  it('aborts the managed review at its ten-minute deadline before scoped cleanup', async () => {
    let aborted = false;
    let serverClosed = false;
    let destroyed = false;
    let leaseCleared = false;
    const events: OperationalLogEvent[] = [];
    let leaseExpiresAt: string | undefined;
    const runStartedAt = Date.now();
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => processOutput(`${sha('1')}\n${sha('2')}\n`),
      destroy: async () => {
        destroyed = true;
      },
    };
    const deadline: ReviewDeadline = {
      schedule: (durationMillis, onElapsed) => {
        expect(durationMillis).toBe(10 * 60 * 1000);
        void onElapsed();
        return () => {};
      },
    };
    const runner = createReviewRunner({
      lease: {
        register: async (input) => {
          leaseExpiresAt = input.expiresAt;
          return {
            clear: async () => {
              leaseCleared = true;
            },
            rearm: async () => {},
          };
        },
      },
      sandbox: {
        getSandbox: async () =>
          createReviewSandbox(
            rawSandbox,
            {
              createClient: async () => ({
                client: {
                  session: {
                    create: async () => ({ id: 'review-session' }),
                    prompt: async () => new Promise(() => {}),
                    abort: async () => {
                      aborted = true;
                      return true;
                    },
                  },
                },
                process: {
                  id: 'review-process',
                  kill: async () => {
                    serverClosed = true;
                  },
                  waitForExit: async () => undefined,
                },
              }),
            },
            deadline,
            {
              sandboxId: 'run-lease-1-attempt-1',
              log: {
                record: (event) => {
                  events.push(event);
                },
              },
            },
          ),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(result).not.toHaveProperty('output');
    expect(aborted).toBe(true);
    expect(serverClosed).toBe(true);
    expect(destroyed).toBe(true);
    expect(leaseCleared).toBe(true);
    expect(events).toContainEqual({
      phase: 'agent',
      outcome: 'aborted',
      stage: 'deadline',
      reason: 'deadline',
      sandboxId: 'run-lease-1-attempt-1',
    });
    if (leaseExpiresAt === undefined) throw new Error('lease expiry was not registered');
    const leaseDuration = Date.parse(leaseExpiresAt) - runStartedAt;
    expect(leaseDuration).toBeGreaterThanOrEqual(12 * 60 * 1000 - 1_000);
    expect(leaseDuration).toBeLessThan(12 * 60 * 1000 + 1_000);
  });

  it('keeps timeout terminal when abort settles a pending prompt after deadline begins', async () => {
    let fireDeadline: (() => Promise<void>) | undefined;
    let resolvePromptStarted: (() => void) | undefined;
    let rejectPrompt: ((reason?: unknown) => void) | undefined;
    let aborted = false;
    let serverClosed = false;
    let destroyed = false;
    let leaseCleared = false;
    const promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve;
    });
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => processOutput(`${sha('1')}\n${sha('2')}\n`),
      destroy: async () => {
        destroyed = true;
      },
    };
    const deadline: ReviewDeadline = {
      schedule: (_durationMillis, onElapsed) => {
        fireDeadline = onElapsed;
        return () => {};
      },
    };
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {
            leaseCleared = true;
          },
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () =>
          createReviewSandbox(
            rawSandbox,
            {
              createClient: async () => ({
                client: {
                  session: {
                    create: async () => ({ id: 'review-session' }),
                    prompt: async () => {
                      resolvePromptStarted?.();
                      return new Promise<never>((_resolve, reject) => {
                        rejectPrompt = reject;
                      });
                    },
                    abort: async () => {
                      aborted = true;
                      rejectPrompt?.(new Error('session aborted'));
                      return true;
                    },
                  },
                },
                process: {
                  id: 'review-process',
                  kill: async () => {
                    serverClosed = true;
                  },
                  waitForExit: async () => undefined,
                },
              }),
            },
            deadline,
          ),
      },
    });

    const runPromise = runner.runWithLease(makeSpec());
    await promptStarted;
    if (fireDeadline === undefined) throw new Error('deadline was not scheduled');
    await fireDeadline();
    const result = await runPromise;

    expect(result).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(result).not.toHaveProperty('output');
    expect(aborted).toBe(true);
    expect(serverClosed).toBe(true);
    expect(destroyed).toBe(true);
    expect(leaseCleared).toBe(true);
  });

  it('returns timeout and kills the OpenCode process while session abort is still pending', async () => {
    let fireDeadline: (() => Promise<void>) | undefined;
    let releaseAbort: (() => void) | undefined;
    let processKilled = false;
    const abortPending = new Promise<boolean>((resolve) => {
      releaseAbort = () => resolve(true);
    });
    const rawSandbox = {
      writeFile: async () => undefined,
      exec: async () => processOutput(`${sha('1')}\n${sha('2')}\n`),
      destroy: async () => undefined,
    };
    const deadline: ReviewDeadline = {
      schedule: (_durationMillis, onElapsed) => {
        fireDeadline = onElapsed;
        return () => {};
      },
    };
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () =>
          createReviewSandbox(
            rawSandbox,
            {
              createClient: async () => ({
                client: {
                  session: {
                    create: async () => ({ id: 'review-session' }),
                    prompt: async () => new Promise<never>(() => {}),
                    abort: async () => abortPending,
                  },
                },
                process: {
                  id: 'review-process',
                  kill: async () => {
                    processKilled = true;
                  },
                  waitForExit: async () => undefined,
                },
              }),
            },
            deadline,
          ),
      },
    });

    const runPromise = runner.runWithLease(makeSpec());
    if (fireDeadline === undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (fireDeadline === undefined) throw new Error('deadline was not scheduled');
    void fireDeadline();
    const result = await Promise.race([
      runPromise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 25)),
    ]);

    expect(result).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(processKilled).toBe(true);
    releaseAbort?.();
    await runPromise;
  });

  it('fails closed when agent output exceeds the application limit', async () => {
    const runner = createReviewRunner({
      lease: {
        register: async () => ({
          clear: async () => {},
          rearm: async () => {},
        }),
      },
      sandbox: {
        getSandbox: async () => ({
          checkout: async ({ baseSha, headSha }) => ({ baseSha, headSha }),
          removeCheckoutCredentials: async () => {},
          runAgent: async () => ({
            exitCode: 0,
            stdout: 'x'.repeat(256 * 1024 + 1),
            stderr: '',
          }),
          destroy: async () => {},
        }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'failed', reason: 'invalid-output' });
  });
});

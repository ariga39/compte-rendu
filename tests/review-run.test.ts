import { describe, expect, it } from 'vitest';
import { createReviewSandbox } from '../apps/core/src/cloudflare-review-adapter';
import { createReviewRunner, type ReviewRunSpec } from '../apps/core/src/review-run';

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
      exec: async () => ({
        success: true,
        exitCode: 0,
        stdout: `${actualBaseSha}\n${requestedHeadSha}\n`,
        stderr: '',
      }),
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

  it('keeps cleanup failure terminal and does not lazy-start a replacement Sandbox', async () => {
    let rearmed = false;
    let firstSandbox = true;
    let replacementStarted = false;
    let destroyed = false;
    let destroyAttempts = 0;
    let alarmDestroy: (() => Promise<void>) | undefined;

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
            stdout: '',
            stderr: 'timed out',
            timedOut: true,
          }),
          destroy: async () => {},
        }),
      },
    });

    const result = await runner.runWithLease(makeSpec());

    expect(result).toMatchObject({ status: 'failed', reason: 'timeout' });
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

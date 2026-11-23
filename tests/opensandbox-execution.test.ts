import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandsAdapter, createExecdClient } from '@alibaba-group/opensandbox/internal';
import { executeOpenSandboxCommand } from '../apps/runner/src/opensandbox-execution';
import { describeCaptureContract, type CaptureDriver } from './support/capture-contract';

const streamOf = (events: readonly unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

const baseUrl = 'http://sandbox.test:44772';

const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;

const commandsFor = (
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): CommandsAdapter =>
  new CommandsAdapter(createExecdClient({ baseUrl, fetch }), { baseUrl, fetch });

const commandFixture = (stream: string) => {
  let request: { url: string; body: unknown } | undefined;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    request = {
      url: urlOf(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return {
    commands: commandsFor(fetch),
    request: () => request,
  };
};

const failingStreamCommands = (events: readonly unknown[]): CommandsAdapter => {
  const fetch = async (): Promise<Response> =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(streamOf(events)));
          setTimeout(() => controller.error(new Error('stream aborted')), 0);
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  return commandsFor(fetch);
};

const cancellationFixture = (
  options: {
    interruptStatus?: number;
    initDelayMs?: number;
    streamErrorAfterInterrupt?: boolean;
    hangOnInterruptFailure?: boolean;
    neverInit?: boolean;
  } = {},
) => {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let notifyInit: (() => void) | undefined;
  const initiated = new Promise<void>((resolve) => {
    notifyInit = resolve;
  });
  const interruptIds: string[] = [];
  let fallback: ReturnType<typeof setTimeout> | undefined;

  const write = (event: unknown) => {
    streamController?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      const sendInit = () => {
        write({ type: 'init', text: 'cmd-cancel', timestamp: 1 });
        notifyInit?.();
      };
      if (options.neverInit === true) return;
      if (options.initDelayMs === undefined) sendInit();
      else setTimeout(sendInit, options.initDelayMs);
    },
  });

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? urlOf(input));
    if ((init?.method ?? request?.method) === 'DELETE') {
      interruptIds.push(url.searchParams.get('id') ?? '');
      if (fallback !== undefined) clearTimeout(fallback);
      if (options.interruptStatus !== undefined) {
        if (options.hangOnInterruptFailure !== true) {
          write({ type: 'execution_complete', timestamp: 2, execution_time: 1 });
          streamController?.close();
        }
        return new Response(null, { status: options.interruptStatus });
      }
      if (options.streamErrorAfterInterrupt === true) {
        streamController?.error(new Error('stream aborted'));
        return new Response(null, { status: 204 });
      }
      write({
        type: 'error',
        error: {
          ename: 'CommandExecError',
          evalue: 'signal: terminated',
          traceback: ['signal: terminated'],
          exit_code: -1,
        },
        timestamp: 2,
      });
      streamController?.close();
      return new Response(null, { status: 204 });
    }
    init?.signal?.addEventListener(
      'abort',
      () => streamController?.error(new Error('client aborted')),
      { once: true },
    );
    if (options.neverInit !== true) {
      fallback = setTimeout(() => {
        write({ type: 'execution_complete', timestamp: 3, execution_time: 1 });
        streamController?.close();
      }, 100);
    }
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  return {
    commands: commandsFor(fetch),
    initiated,
    interruptIds: () => interruptIds,
  };
};

const sandboxDriver = (): CaptureDriver => {
  let started = false;
  return {
    run: async ({ stdout = [], stderr = [] }, options) => {
      const events = [
        { type: 'init', text: 'cmd-capture', timestamp: 1 },
        ...stdout.map((text) => ({ type: 'stdout', text, timestamp: 2 })),
        ...stderr.map((text) => ({ type: 'stderr', text, timestamp: 3 })),
        { type: 'execution_complete', timestamp: 4, execution_time: 1 },
      ];
      const fetch = async (): Promise<Response> => {
        started = true;
        return new Response(streamOf(events), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      };
      return executeOpenSandboxCommand(
        { commands: commandsFor(fetch) },
        ['sh', '-c', 'capture-contract'],
        options,
      );
    },
    started: () => started,
  };
};

describeCaptureContract('OpenSandbox executeOpenSandboxCommand', sandboxDriver);

describe('executeOpenSandboxCommand', () => {
  it.each(['error', 'early-eof'])('interrupts initialized remote work after %s', async (ending) => {
    let stopped = false;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method === 'DELETE') {
        stopped = true;
        return new Response(null, { status: 204 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                streamOf([{ type: 'init', text: 'remote-running', timestamp: 1 }]),
              ),
            );
            setTimeout(
              () =>
                ending === 'error'
                  ? controller.error(new Error('transport disconnected'))
                  : controller.close(),
              0,
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const result = await executeOpenSandboxCommand(
      { commands: commandsFor(fetch) },
      ['long-running-work'],
      {},
    );
    expect(stopped).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.streamError).toBe(true);
  });

  it('returns the remote exit code, stdout and stderr while preserving argv', async () => {
    const argv = ['sh', '-c', 'printf stdout-ok; printf stderr-ok >&2; exit 7'];
    const fixture = commandFixture(
      streamOf([
        { type: 'init', text: 'cmd-1', timestamp: 1 },
        { type: 'stdout', text: 'stdout-ok', timestamp: 2 },
        { type: 'stderr', text: 'stderr-ok', timestamp: 3 },
        {
          type: 'error',
          error: {
            ename: 'CommandExecError',
            evalue: '7',
            traceback: ['exit status 7'],
            exit_code: 7,
          },
          timestamp: 4,
        },
      ]),
    );

    const result = await executeOpenSandboxCommand({ commands: fixture.commands }, argv, {
      captureStdout: true,
      captureStderr: true,
    });

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('stdout-ok');
    expect(result.stderr).toBe('stderr-ok');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(fixture.request()?.body).toMatchObject({ argv });
  });

  it('fails closed without throwing when the transport fails', async () => {
    const fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ message: 'socket down' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });

    const result = await executeOpenSandboxCommand(
      { commands: commandsFor(fetch) },
      ['sh', '-c', 'exit 0'],
      {},
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.streamError).toBe(true);
  });

  it('fails closed when the stream ends without a terminal exit state', async () => {
    const fixture = commandFixture(
      streamOf([
        { type: 'init', text: 'cmd-incomplete', timestamp: 1 },
        { type: 'stdout', text: 'partial', timestamp: 2 },
      ]),
    );

    const result = await executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'printf partial'],
      {},
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.streamError).toBe(true);
  });

  it('passes workingDirectory to the SDK command', async () => {
    const fixture = commandFixture(
      streamOf([{ type: 'execution_complete', timestamp: 1, execution_time: 1 }]),
    );

    const result = await executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['git', 'status'],
      { workingDirectory: '/workspace/checkout' },
    );

    expect(result.exitCode).toBe(0);
    expect(fixture.request()?.body).toMatchObject({ cwd: '/workspace/checkout' });
  });

  it('interrupts the remote command when abort races a delayed init', async () => {
    const fixture = cancellationFixture({ initDelayMs: 25 });
    const controller = new AbortController();
    const pending = executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'sleep 30'],
      { signal: controller.signal },
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await fixture.initiated;
    const result = await pending;

    expect(fixture.interruptIds()).toEqual(['cmd-cancel']);
    expect(result.exitCode).not.toBe(0);
  });

  it('does not treat an aborted HTTP stream as a stopped remote command', async () => {
    const fixture = cancellationFixture({ streamErrorAfterInterrupt: true });
    const controller = new AbortController();
    const pending = executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'sleep 30'],
      { signal: controller.signal },
    );

    await fixture.initiated;
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;

    expect(fixture.interruptIds()).toEqual(['cmd-cancel']);
    expect(result.streamError).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('fails closed when the remote interrupt fails', async () => {
    const fixture = cancellationFixture({ interruptStatus: 500 });
    const controller = new AbortController();
    const pending = executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'sleep 30'],
      { signal: controller.signal },
    );

    await fixture.initiated;
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;

    expect(fixture.interruptIds()).toEqual(['cmd-cancel']);
    expect(result.streamError).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('aborts the HTTP stream when the signal fires before init arrives', async () => {
    const fixture = cancellationFixture({ neverInit: true });
    const controller = new AbortController();
    const pending = executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'sleep 30'],
      { signal: controller.signal },
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;

    expect(fixture.interruptIds()).toEqual([]);
    expect(result.streamError).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 2000);

  it('unblocks when a failed interrupt leaves the HTTP stream open', async () => {
    const fixture = cancellationFixture({ interruptStatus: 500, hangOnInterruptFailure: true });
    const controller = new AbortController();
    const pending = executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'sleep 30'],
      { signal: controller.signal },
    );

    await fixture.initiated;
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;

    expect(fixture.interruptIds()).toEqual(['cmd-cancel']);
    expect(result.streamError).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 1000);

  it('flushes buffered redaction suffixes when the SDK stream errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-opensandbox-error-'));
    try {
      const stdoutFilePath = join(directory, 'stdout.log');
      const stderrFilePath = join(directory, 'stderr.log');
      const result = await executeOpenSandboxCommand(
        {
          commands: failingStreamCommands([
            { type: 'init', text: 'cmd-error', timestamp: 1 },
            { type: 'stdout', text: 'out SEC', timestamp: 2 },
            { type: 'stderr', text: 'warn SEC', timestamp: 3 },
          ]),
        },
        ['sh', '-c', 'capture-suffix'],
        {
          captureStdout: true,
          captureStderr: true,
          stderrRedactions: ['SECRETVALUE'],
          credentialValues: ['SECRETVALUE'],
          maxBytes: 64,
          stdoutFilePath,
          stderrFilePath,
        },
      );

      expect(result.streamError).toBe(true);
      expect(result.truncated).toBe(false);
      expect(result.stderrTruncated).not.toBe(true);
      expect(result.stdout).toBe('out SEC');
      expect(result.stderr).toBe('warn SEC');
      await expect(readFile(stdoutFilePath, 'utf8')).resolves.toBe('out SEC');
      await expect(readFile(stderrFilePath, 'utf8')).resolves.toBe('warn SEC');
      await expect(readFile(stderrFilePath, 'utf8')).resolves.not.toContain('SECRETVALUE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports truncation after flushing a redacted stream error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-opensandbox-error-'));
    try {
      const stderrFilePath = join(directory, 'stderr.log');
      const result = await executeOpenSandboxCommand(
        {
          commands: failingStreamCommands([
            { type: 'init', text: 'cmd-error', timestamp: 1 },
            { type: 'stderr', text: 'warn SECRETVALUE', timestamp: 2 },
          ]),
        },
        ['sh', '-c', 'capture-overflow'],
        {
          captureStderr: true,
          stderrRedactions: ['SECRETVALUE'],
          credentialValues: ['SECRETVALUE'],
          maxBytes: 8,
          stderrFilePath,
        },
      );

      expect(result.streamError).toBe(true);
      expect(result.truncated).toBe(false);
      expect(result.stderrTruncated).toBe(true);
      expect(result.stderr).toBe('warn [re');
      await expect(readFile(stderrFilePath, 'utf8')).resolves.toBe('warn [re');
      await expect(readFile(stderrFilePath, 'utf8')).resolves.not.toContain('SECRETVALUE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not start a command when the signal is already aborted', async () => {
    const fixture = commandFixture(
      streamOf([{ type: 'execution_complete', timestamp: 1, execution_time: 1 }]),
    );
    const controller = new AbortController();
    controller.abort();

    const result = await executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'touch /tmp/must-not-run'],
      { signal: controller.signal },
    );

    expect(fixture.request()).toBeUndefined();
    expect(result.exitCode).not.toBe(0);
  });

  it('interrupts the remote command by init id and returns its nonzero exit', async () => {
    const fixture = cancellationFixture();
    const controller = new AbortController();
    const pending = executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'sleep 30'],
      { signal: controller.signal },
    );

    await fixture.initiated;
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;

    expect(fixture.interruptIds()).toEqual(['cmd-cancel']);
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
    expect(result.streamError).not.toBe(true);
  });
});

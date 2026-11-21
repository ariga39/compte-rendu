import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandsAdapter, createExecdClient } from '@alibaba-group/opensandbox/internal';
import { executeOpenSandboxCommand } from '../apps/runner/src/opensandbox-execution';

const streamOf = (events: readonly unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

const baseUrl = 'http://sandbox.test:44772';

const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;

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
    commands: new CommandsAdapter(createExecdClient({ baseUrl, fetch }), { baseUrl, fetch }),
    request: () => request,
  };
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
    commands: new CommandsAdapter(createExecdClient({ baseUrl, fetch }), { baseUrl, fetch }),
    initiated,
    interruptIds: () => interruptIds,
  };
};

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
    const commands = new CommandsAdapter(createExecdClient({ baseUrl, fetch }), { baseUrl, fetch });
    const result = await executeOpenSandboxCommand({ commands }, ['long-running-work'], {});
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

  it('omits stdout and stderr that were not requested', async () => {
    const fixture = commandFixture(
      streamOf([
        { type: 'stdout', text: 'unrequested-out', timestamp: 1 },
        { type: 'stderr', text: 'unrequested-err', timestamp: 2 },
        { type: 'execution_complete', timestamp: 3, execution_time: 1 },
      ]),
    );

    const result = await executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['echo', 'x'],
      {},
    );

    expect(result.stdout).toBe('');
    expect(result.stderr).toBeUndefined();
  });

  it('bounds stderr capture and reports stderrTruncated', async () => {
    const fixture = commandFixture(
      streamOf([
        { type: 'stderr', text: 'abcdef', timestamp: 1 },
        { type: 'stderr', text: 'ghij', timestamp: 2 },
        { type: 'execution_complete', timestamp: 3, execution_time: 1 },
      ]),
    );

    const result = await executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'printf abcdefghij >&2'],
      { captureStderr: true, maxBytes: 8 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('abcdefgh');
    expect(result.stderrTruncated).toBe(true);
  });

  it('fails closed without throwing when the transport fails', async () => {
    const fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ message: 'socket down' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    const commands = new CommandsAdapter(createExecdClient({ baseUrl, fetch }), { baseUrl, fetch });

    const result = await executeOpenSandboxCommand({ commands }, ['sh', '-c', 'exit 0'], {});

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

  it('writes stdout and stderr files with mode 0600 and honors fileAppend', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-osb-execution-'));
    const stdoutFilePath = join(directory, 'stdout.log');
    const stderrFilePath = join(directory, 'stderr.log');
    try {
      const first = commandFixture(
        streamOf([
          { type: 'stdout', text: 'out\n', timestamp: 1 },
          { type: 'stderr', text: 'err\n', timestamp: 2 },
          { type: 'execution_complete', timestamp: 3, execution_time: 1 },
        ]),
      );
      await executeOpenSandboxCommand({ commands: first.commands }, ['echo', 'out'], {
        stdoutFilePath,
        stderrFilePath,
      });

      expect(await readFile(stdoutFilePath, 'utf8')).toBe('out\n');
      expect(await readFile(stderrFilePath, 'utf8')).toBe('err\n');
      expect((await stat(stdoutFilePath)).mode & 0o777).toBe(0o600);
      expect((await stat(stderrFilePath)).mode & 0o777).toBe(0o600);

      const second = commandFixture(
        streamOf([
          { type: 'stdout', text: 'more\n', timestamp: 1 },
          { type: 'stderr', text: 'warn\n', timestamp: 2 },
          { type: 'execution_complete', timestamp: 3, execution_time: 1 },
        ]),
      );
      await executeOpenSandboxCommand({ commands: second.commands }, ['echo', 'more'], {
        stdoutFilePath,
        stderrFilePath,
        fileAppend: true,
      });

      expect(await readFile(stdoutFilePath, 'utf8')).toBe('out\nmore\n');
      expect(await readFile(stderrFilePath, 'utf8')).toBe('err\nwarn\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds stdout and stderr files to maxBytes and keeps the in-limit prefix', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-osb-execution-'));
    const stdoutFilePath = join(directory, 'stdout.log');
    const stderrFilePath = join(directory, 'stderr.log');
    try {
      const fixture = commandFixture(
        streamOf([
          { type: 'stdout', text: 'hello', timestamp: 1 },
          { type: 'stdout', text: 'world', timestamp: 2 },
          { type: 'stderr', text: 'abcdef', timestamp: 3 },
          { type: 'stderr', text: 'ghij', timestamp: 4 },
          { type: 'execution_complete', timestamp: 5, execution_time: 1 },
        ]),
      );

      const result = await executeOpenSandboxCommand(
        { commands: fixture.commands },
        ['sh', '-c', 'printf helloworld; printf abcdefghij >&2'],
        {
          captureStdout: true,
          captureStderr: true,
          maxBytes: 8,
          stdoutFilePath,
          stderrFilePath,
        },
      );

      expect(result.stdout).toBe('hellowor');
      expect(result.stderr).toBe('abcdefgh');
      expect(result.truncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
      await expect(readFile(stdoutFilePath, 'utf8')).resolves.toBe('hellowor');
      await expect(readFile(stderrFilePath, 'utf8')).resolves.toBe('abcdefgh');
      expect((await stat(stdoutFilePath)).size).toBe(8);
      expect((await stat(stderrFilePath)).size).toBe(8);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('drops a trailing secret prefix from a truncated stdout file across chunks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-osb-execution-'));
    const stdoutFilePath = join(directory, 'stdout.log');
    const secret = 'CANARYSECRET';
    try {
      const fixture = commandFixture(
        streamOf([
          { type: 'stdout', text: 'okokokCA', timestamp: 1 },
          { type: 'stdout', text: 'NARYSECRETTAIL', timestamp: 2 },
          { type: 'execution_complete', timestamp: 3, execution_time: 1 },
        ]),
      );

      const result = await executeOpenSandboxCommand(
        { commands: fixture.commands },
        ['sh', '-c', 'printf output'],
        {
          captureStdout: true,
          stderrRedactions: [secret],
          maxBytes: 8,
          stdoutFilePath,
        },
      );

      expect(result.stdout).toBe('okokokCA');
      expect(result.truncated).toBe(true);
      await expect(readFile(stdoutFilePath, 'utf8')).resolves.toBe('okokok');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when append sizing fails for a non-ENOENT reason', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-osb-execution-'));
    const blocker = join(directory, 'blocker');
    await writeFile(blocker, 'not a directory', { mode: 0o600 });
    try {
      const fixture = commandFixture(
        streamOf([{ type: 'execution_complete', timestamp: 1, execution_time: 1 }]),
      );

      const result = await executeOpenSandboxCommand(
        { commands: fixture.commands },
        ['sh', '-c', 'printf output'],
        {
          captureStdout: true,
          maxBytes: 8,
          stdoutFilePath: join(blocker, 'stdout.log'),
          fileAppend: true,
        },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.streamError).toBe(true);
      expect(fixture.request()).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not start after an abort observed during append initialization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-osb-execution-'));
    const stdoutFilePath = join(directory, 'stdout.log');
    await writeFile(stdoutFilePath, 'old', { mode: 0o600 });
    try {
      const fixture = commandFixture(
        streamOf([{ type: 'execution_complete', timestamp: 1, execution_time: 1 }]),
      );
      const controller = new AbortController();
      controller.abort();

      const result = await executeOpenSandboxCommand(
        { commands: fixture.commands },
        ['sh', '-c', 'printf output'],
        {
          captureStdout: true,
          maxBytes: 8,
          stdoutFilePath,
          fileAppend: true,
          signal: controller.signal,
        },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(fixture.request()).toBeUndefined();
      await expect(readFile(stdoutFilePath, 'utf8')).resolves.toBe('old');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('applies maxBytes to the aggregate file across an append and reports truncation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-osb-execution-'));
    const stdoutFilePath = join(directory, 'stdout.log');
    await writeFile(stdoutFilePath, '123456', { mode: 0o600 });
    try {
      const fixture = commandFixture(
        streamOf([
          { type: 'stdout', text: 'abcdef', timestamp: 1 },
          { type: 'execution_complete', timestamp: 2, execution_time: 1 },
        ]),
      );

      const result = await executeOpenSandboxCommand(
        { commands: fixture.commands },
        ['sh', '-c', 'printf abcdef'],
        {
          captureStdout: true,
          maxBytes: 8,
          stdoutFilePath,
          fileAppend: true,
        },
      );

      expect(result.stdout).toBe('ab');
      expect(result.truncated).toBe(true);
      await expect(readFile(stdoutFilePath, 'utf8')).resolves.toBe('123456ab');
      expect((await stat(stdoutFilePath)).size).toBe(8);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('redacts stderr before writing the evidence file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-osb-execution-'));
    const stderrFilePath = join(directory, 'stderr.log');
    try {
      const fixture = commandFixture(
        streamOf([
          { type: 'stderr', text: 'before s3c', timestamp: 1 },
          { type: 'stderr', text: 'r3t after', timestamp: 2 },
          { type: 'execution_complete', timestamp: 3, execution_time: 1 },
        ]),
      );

      const result = await executeOpenSandboxCommand(
        { commands: fixture.commands },
        ['sh', '-c', 'printf secret >&2'],
        {
          captureStderr: true,
          stderrRedactions: ['s3cr3t'],
          credentialValues: ['s3cr3t'],
          maxBytes: 64,
          stderrFilePath,
        },
      );

      expect(result.credentialObserved).toBe(true);
      expect(result.stderr).toBe('before [redacted] after');
      await expect(readFile(stderrFilePath, 'utf8')).resolves.toBe('before [redacted] after');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('observes credentials per stream without combining stdout and stderr', async () => {
    const fixture = commandFixture(
      streamOf([
        { type: 'stdout', text: 'SEC', timestamp: 1 },
        { type: 'stderr', text: 'RET', timestamp: 2 },
        { type: 'execution_complete', timestamp: 3, execution_time: 1 },
      ]),
    );

    const result = await executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'printf SEC; printf RET >&2'],
      {
        captureStdout: true,
        captureStderr: true,
        credentialValues: ['SECRET'],
        maxBytes: 64,
      },
    );

    expect(result.credentialObserved).not.toBe(true);
  });

  it('does not write a partially cut credential when the file limit is reached', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-osb-execution-'));
    const stderrFilePath = join(directory, 'stderr.log');
    const secret = 'SECRETVALUE';
    try {
      const fixture = commandFixture(
        streamOf([
          { type: 'stderr', text: `12345${secret}`, timestamp: 1 },
          { type: 'execution_complete', timestamp: 2, execution_time: 1 },
        ]),
      );

      const result = await executeOpenSandboxCommand(
        { commands: fixture.commands },
        ['sh', '-c', 'printf secret >&2'],
        {
          captureStderr: true,
          stderrRedactions: [secret],
          maxBytes: 9,
          stderrFilePath,
        },
      );

      await expect(readFile(stderrFilePath, 'utf8')).resolves.toBe('12345[red');
      expect(result.stderr).toBe('12345[red');
      expect(result.stderrTruncated).toBe(true);
      expect(await readFile(stderrFilePath, 'utf8')).not.toContain('SEC');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('redacts a secret split across stderr chunks', async () => {
    const fixture = commandFixture(
      streamOf([
        { type: 'stderr', text: 'before s3c', timestamp: 1 },
        { type: 'stderr', text: 'r3t after', timestamp: 2 },
        { type: 'execution_complete', timestamp: 3, execution_time: 1 },
      ]),
    );

    const result = await executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'printf secret >&2'],
      { captureStderr: true, stderrRedactions: ['s3cr3t'] },
    );

    expect(result.stderr).toBe('before [redacted] after');
  });

  it('bounds stdout capture by maxBytes and reports truncation', async () => {
    const fixture = commandFixture(
      streamOf([
        { type: 'stdout', text: 'hello', timestamp: 1 },
        { type: 'stdout', text: 'world', timestamp: 2 },
        { type: 'execution_complete', timestamp: 3, execution_time: 1 },
      ]),
    );

    const result = await executeOpenSandboxCommand(
      { commands: fixture.commands },
      ['sh', '-c', 'printf helloworld'],
      { captureStdout: true, maxBytes: 8 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hellowor');
    expect(result.truncated).toBe(true);
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

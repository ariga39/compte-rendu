declare module 'node:fs' {
  export function copyFileSync(source: string, destination: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  export function unlinkSync(path: string): void;
  export function writeFileSync(
    path: string,
    data: string,
    options: { encoding: 'utf8'; flag: 'wx' },
  ): void;
}

declare module 'node:child_process' {
  export interface ChildProcess {
    readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
    kill(signal?: string): boolean;
    once(event: 'error', listener: () => void): void;
    once(event: 'close', listener: (exitCode: number | null) => void): void;
  }
  export function spawn(
    file: string,
    args: readonly string[],
    options?: {
      env?: Record<string, string | undefined>;
      stdio?: readonly string[];
    },
  ): ChildProcess;
  export function execFileSync(
    file: string,
    args: readonly string[],
    options?: {
      cwd?: string;
      encoding?: 'utf8';
      stdio?: 'pipe';
    },
  ): string;
}

declare module 'node:http' {
  export interface IncomingMessage {
    readonly headers: Record<string, string | readonly string[] | undefined>;
    readonly method?: string;
    readonly url?: string;
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | string>;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: string | Uint8Array): void;
  }
  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): {
    listen(port: number): unknown;
    listen(options: { port: number; host: string }): unknown;
  };
}

declare module 'node:crypto' {
  export function randomUUID(): string;
}

declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(
    path: string,
    options?: { force?: boolean; recursive?: boolean },
  ): Promise<void>;
  export function writeFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}

declare module 'node:sqlite' {
  interface RunResult {
    changes: number | bigint;
  }

  interface PreparedStatement {
    run(...values: unknown[]): RunResult;
    get(...values: unknown[]): unknown;
  }

  export class DatabaseSync {
    constructor(filename: string);
    exec(sql: string): void;
    prepare(sql: string): PreparedStatement;
    close(): void;
  }
}

declare namespace NodeJS {
  type ProcessEnv = Record<string, string | undefined>;
  type Signals = string;
}

declare const process: {
  argv: string[];
  cwd(): string;
  execPath: string;
  env: NodeJS.ProcessEnv;
};

declare class Buffer extends Uint8Array {
  static concat(chunks: readonly Buffer[]): Buffer;
  static isBuffer(value: unknown): value is Buffer;
  static from(value: string | Uint8Array | ArrayBuffer): Buffer;
  toString(encoding?: string): string;
}

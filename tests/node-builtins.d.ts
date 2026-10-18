declare module 'node:fs' {
  export interface WriteStream {
    write(chunk: string | Uint8Array): boolean;
    end(callback?: () => void): void;
    on(event: 'error', listener: () => void): this;
  }
  export function createWriteStream(
    path: string,
    options?: { flags?: string; mode?: number },
  ): WriteStream;
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
    readonly stdin: { end(): void } | null;
    readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
    readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
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
      maxBuffer?: number;
      env?: Record<string, string | undefined>;
    },
  ): string;
}

declare module 'node:http' {
  export function request(
    options: { socketPath: string; path: string; method: string },
    callback: (response: IncomingMessage) => void,
  ): { on(event: 'error', listener: (error: Error) => void): void; end(): void };
  export interface IncomingMessage {
    readonly headers: Record<string, string | string[] | undefined>;
    readonly method?: string;
    readonly url?: string;
    on(event: 'data', listener: (data: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | string>;
  }
  export interface ServerResponse {
    statusCode: number;
    readonly headersSent: boolean;
    readonly writableEnded: boolean;
    once(event: 'drain', listener: () => void): this;
    removeListener(event: 'drain', listener: () => void): this;
    on(event: 'close', listener: () => void): this;
    write(chunk: Uint8Array): boolean;
    destroy(): void;
    setHeader(name: string, value: string): void;
    writeHead(statusCode: number, headers?: Record<string, string>): this;
    end(data?: string | Uint8Array): void;
  }
  export interface Server {
    close(callback: () => void): void;
    closeAllConnections(): void;
    listen(path: string, callback: () => void): this;
    listen(port: number, host: string, callback: () => void): this;
    listen(options: { port: number; host: string }): this;
    once(event: 'error', listener: (error: unknown) => void): this;
    address(): { readonly port: number } | string | null;
  }
  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  ): Server;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomUUID(): string;
}

declare module 'node:zlib' {
  export function gunzipSync(value: Uint8Array): Buffer;
}

declare module 'node:fs/promises' {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function chmod(path: string, mode: number): Promise<void>;
  export function mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<string | undefined>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function readFile(path: string): Promise<Buffer>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function stat(path: string): Promise<{ readonly mode: number; readonly size: number }>;
  export function unlink(path: string): Promise<void>;
  export function rm(
    path: string,
    options?: { force?: boolean; recursive?: boolean },
  ): Promise<void>;
  export function writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { flag?: string; mode?: number } | 'utf8',
  ): Promise<void>;
}

declare module 'node:os' {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function dirname(path: string): string;
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
  exitCode: number;
  once(event: string, listener: () => void): void;
  argv: string[];
  cwd(): string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  stdout: { write(value: string): boolean };
};

declare class Buffer extends Uint8Array {
  static concat(chunks: readonly Buffer[]): Buffer;
  static isBuffer(value: unknown): value is Buffer;
  static from(value: string | Uint8Array | ArrayBuffer): Buffer;
  static from(value: string, encoding: string): Buffer;
  toString(encoding?: string): string;
}

declare module 'node:events' {
  export function once(
    emitter: unknown,
    event: string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown[]>;
  export class EventEmitter<Events = Record<string, unknown[]>> {
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}

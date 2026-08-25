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

declare const process: {
  argv: string[];
  cwd(): string;
  execPath: string;
};

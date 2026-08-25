declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string;
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

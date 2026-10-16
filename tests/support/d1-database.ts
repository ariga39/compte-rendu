import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../../apps/core/src/index';

type SqliteBindValue = string | number | bigint | Uint8Array | null;

const toSqliteBindValue = (value: unknown): SqliteBindValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new TypeError('unsupported SQLite bind value');
};

class SqlitePreparedStatement implements D1PreparedStatementLike {
  private values: SqliteBindValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values.map(toSqliteBindValue);
    return this;
  }

  async run(): Promise<D1ResultLike> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ readonly results: readonly T[] }> {
    const statement = this.database.prepare(this.sql) as unknown as {
      all: (...values: unknown[]) => unknown[];
    };
    return { results: statement.all(...this.values) as T[] };
  }
}

export class SqliteD1Database implements D1DatabaseLike {
  readonly database = new DatabaseSync(':memory:');
  private batchTail: Promise<void> = Promise.resolve();

  constructor(
    migrationNames: readonly string[] = [
      '0001_review_state.sql',
      '0002_allow_manual_retry.sql',
      '0003_runner_evidence.sql',
      '0004_runner_admission.sql',
      '0005_publication_claim.sql',
      '0006_review_check_runs.sql',
      '0007_check_setup_lease.sql',
      '0008_runner_cleanup.sql',
      '0009_dashboard_lifecycle.sql',
    ],
  ) {
    this.applyMigrations(migrationNames);
  }

  applyMigrations(migrationNames: readonly string[]) {
    for (const migrationName of migrationNames) {
      this.database.exec(
        readFileSync(
          fileURLToPath(new URL(`../../apps/core/migrations/${migrationName}`, import.meta.url)),
          'utf8',
        ),
      );
    }
  }

  prepare(query: string): D1PreparedStatementLike {
    return new SqlitePreparedStatement(this.database, query);
  }

  async batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]> {
    const batch = this.batchTail.then(async () => {
      this.database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        this.database.exec('COMMIT');
        return results;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    });
    this.batchTail = batch.then(
      () => undefined,
      () => undefined,
    );
    return batch;
  }

  close() {
    this.database.close();
  }
}

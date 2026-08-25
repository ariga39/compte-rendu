import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../../apps/core/src/index';

class SqlitePreparedStatement implements D1PreparedStatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run(): Promise<D1ResultLike> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }
}

export class SqliteD1Database implements D1DatabaseLike {
  readonly database = new DatabaseSync(':memory:');

  constructor() {
    const migration = readFileSync(
      fileURLToPath(new URL('../../apps/core/migrations/0001_review_state.sql', import.meta.url)),
      'utf8',
    );
    this.database.exec(migration);
  }

  prepare(query: string): D1PreparedStatementLike {
    return new SqlitePreparedStatement(this.database, query);
  }

  async batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]> {
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
  }

  close() {
    this.database.close();
  }
}

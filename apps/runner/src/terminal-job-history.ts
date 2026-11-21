import { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';
import type { RunnerJobResponse } from '@compte-rendu/contracts';

const HistoryRow = Schema.Struct({ admission_key: Schema.String, state: Schema.String });
const decodeRow = Schema.decodeUnknownSync(HistoryRow);

// An empty filename opens a private temporary SQLite database that is removed
// on close or process exit. Its page cache can spill to disk as history grows.
export function createTerminalJobHistory() {
  const db = new DatabaseSync('');
  db.exec(`CREATE TABLE terminal_jobs (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt INTEGER NOT NULL,
    admission_key TEXT NOT NULL, state TEXT NOT NULL, UNIQUE(run_id, attempt)
  )`);
  const insert = db.prepare('INSERT INTO terminal_jobs VALUES (?, ?, ?, ?, ?)');
  const byId = db.prepare('SELECT admission_key, state FROM terminal_jobs WHERE id = ?');
  const byAttempt = db.prepare(
    'SELECT admission_key, state FROM terminal_jobs WHERE run_id = ? AND attempt = ?',
  );
  return {
    save(state: RunnerJobResponse, admissionKey: string) {
      insert.run(state.id, state.runId, state.attempt, admissionKey, JSON.stringify(state));
    },
    find(id: string, runId?: string, attempt?: number) {
      const row =
        byId.get(id) ??
        (runId !== undefined && attempt !== undefined ? byAttempt.get(runId, attempt) : undefined);
      return row === undefined ? undefined : decodeRow(row);
    },
    close: () => db.close(),
  };
}

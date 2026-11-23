import { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';
import {
  RunnerJobResponse,
  type RunnerJobResponse as RunnerJobResponseValue,
} from '@compte-rendu/contracts';

// Full terminal bodies are large (the review result alone can be several MiB).
// Keep them briefly for authenticated GET/repost, then retain only the compact
// identity/status record for the rest of the process lifetime.
export const TERMINAL_BODY_RETENTION_MS = 15 * 60 * 1000;
export const TERMINAL_HISTORY_PAGE_SIZE = 4 * 1024;
// 8192 pages caps the private temporary database at 32 MiB. Identity rows stay
// small; when the cap is reached the caller keeps duplicate protection in memory.
export const TERMINAL_HISTORY_MAX_PAGES = 8192;

export type TerminalHistoryFailureReason = 'full' | 'unwritable' | 'unavailable';

export interface TerminalJobHistoryOptions {
  /** Empty/undefined uses a private temporary database in the host TMPDIR. */
  readonly path?: string;
  readonly bodyRetentionMs?: number;
  readonly maxPageCount?: number;
}

export interface TerminalJobHistoryMatch {
  readonly admissionKey: string;
  readonly state: RunnerJobResponseValue;
  readonly bodyExpired: boolean;
}

const HistoryRow = Schema.Struct({
  admission_key: Schema.String,
  state: Schema.NullOr(Schema.String),
  compact: Schema.String,
});
const decodeRow = Schema.decodeUnknownSync(HistoryRow);
const decodeFullState = Schema.decodeUnknownSync(Schema.fromJsonString(RunnerJobResponse));
const decodeCompactState = Schema.decodeUnknownSync(Schema.fromJsonString(RunnerJobResponse));

export const terminalHistoryFailureReason = (error: unknown): TerminalHistoryFailureReason => {
  const errcode = (error as { readonly errcode?: unknown } | null)?.errcode;
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (errcode === 13 || code === 'ENOSPC') return 'full';
  if (
    errcode === 8 ||
    errcode === 14 ||
    errcode === 23 ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EROFS' ||
    code === 'ENOENT'
  ) {
    return 'unwritable';
  }
  return 'unavailable';
};

const compactState = (state: RunnerJobResponseValue): RunnerJobResponseValue => ({
  id: state.id,
  runId: state.runId,
  attempt: state.attempt,
  ...(state.evidenceId === undefined ? {} : { evidenceId: state.evidenceId }),
  evidence: { id: state.evidence.id, status: state.evidence.status },
  status: state.status,
  stage: state.stage,
  sandbox: { cleanup: state.sandbox.cleanup },
  ...(state.failure === undefined ? {} : { failure: state.failure }),
});

// An empty filename opens a private temporary SQLite database that is removed
// on close or process exit. The page cap bounds disk use even when identities
// accumulate; expired full bodies become reusable free pages.
export function createTerminalJobHistory(options: TerminalJobHistoryOptions = {}) {
  const bodyRetentionMs = options.bodyRetentionMs ?? TERMINAL_BODY_RETENTION_MS;
  const db = new DatabaseSync(options.path ?? '');
  db.exec(`PRAGMA page_size = ${TERMINAL_HISTORY_PAGE_SIZE}`);
  db.exec(`PRAGMA max_page_count = ${options.maxPageCount ?? TERMINAL_HISTORY_MAX_PAGES}`);
  // Keep rollback available when a large body hits the page cap after dirty
  // pages spill. MEMORY keeps the rollback journal off disk, so the page cap
  // remains the database's disk bound.
  db.exec('PRAGMA journal_mode = MEMORY');
  db.exec(`CREATE TABLE IF NOT EXISTS terminal_jobs (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt INTEGER NOT NULL,
    admission_key TEXT NOT NULL, state TEXT, compact TEXT NOT NULL, saved_at INTEGER NOT NULL,
    UNIQUE(run_id, attempt)
  )`);
  // The retention write only touches rows that still hold a full body.
  db.exec(`CREATE INDEX IF NOT EXISTS terminal_jobs_live_bodies
    ON terminal_jobs(saved_at) WHERE state IS NOT NULL`);
  const insert = db.prepare(`INSERT OR REPLACE INTO terminal_jobs
    (id, run_id, attempt, admission_key, state, compact, saved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const byId = db.prepare('SELECT admission_key, state, compact FROM terminal_jobs WHERE id = ?');
  const byAttempt = db.prepare(
    'SELECT admission_key, state, compact FROM terminal_jobs WHERE run_id = ? AND attempt = ?',
  );
  const expireBodies = db.prepare(
    'UPDATE terminal_jobs SET state = NULL WHERE state IS NOT NULL AND saved_at <= ?',
  );
  const rowFor = (id: string, runId?: string, attempt?: number) =>
    byId.get(id) ??
    (runId !== undefined && attempt !== undefined ? byAttempt.get(runId, attempt) : undefined);

  const saveRow = (
    state: RunnerJobResponseValue,
    admissionKey: string,
    fullState: string | null,
  ) => {
    const now = Date.now();
    expireBodies.run(now - bodyRetentionMs);
    insert.run(
      state.id,
      state.runId,
      state.attempt,
      admissionKey,
      fullState,
      JSON.stringify(compactState(state)),
      now,
    );
  };

  return {
    save(state: RunnerJobResponseValue, admissionKey: string) {
      saveRow(state, admissionKey, JSON.stringify(state));
    },
    saveCompact(state: RunnerJobResponseValue, admissionKey: string) {
      saveRow(state, admissionKey, null);
    },
    find(id: string, runId?: string, attempt?: number): TerminalJobHistoryMatch | undefined {
      expireBodies.run(Date.now() - bodyRetentionMs);
      const raw = rowFor(id, runId, attempt);
      if (raw === undefined) return undefined;
      const row = decodeRow(raw);
      if (row.state !== null) {
        return {
          admissionKey: row.admission_key,
          state: decodeFullState(row.state),
          bodyExpired: false,
        };
      }
      return {
        admissionKey: row.admission_key,
        state: { ...decodeCompactState(row.compact), bodyExpired: true },
        bodyExpired: true,
      };
    },
    close: () => db.close(),
  };
}

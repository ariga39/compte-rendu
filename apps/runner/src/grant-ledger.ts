import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Option, Schema } from 'effect';
import type { LlmServiceClient } from './llm-service-client.js';

const GrantMarkerIssuer = Schema.Struct({
  transport: Schema.Literal('relay'),
  origin: Schema.NonEmptyString,
  generation: Schema.NonEmptyString,
});
const GrantMarker = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.NonEmptyString,
  issuer: GrantMarkerIssuer,
});
export type GrantIssuer = typeof GrantMarkerIssuer.Type;

export type GrantMarkerRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'present'; readonly jobId: string; readonly issuer: GrantIssuer };

export interface GrantLedgerOptions {
  readonly root: string;
  readonly client?: Pick<LlmServiceClient, 'revoke'> | undefined;
  readonly activeIssuer?: GrantIssuer | undefined;
  readonly attempts: number;
  readonly budgetMs: number;
}

export interface GrantLedger {
  read(jobId: string): Promise<GrantMarkerRead>;
  write(jobId: string): Promise<void>;
  clear(jobId: string): Promise<void>;
  revokeRecorded(jobId: string, issuer: GrantIssuer | undefined): Promise<boolean>;
  revoke(jobId: string, issuanceAttempted: boolean): Promise<boolean>;
  recoverPending(): Promise<boolean>;
  startRecovery(): Promise<boolean>;
  recovery(): Promise<boolean> | undefined;
  status(): boolean | undefined;
}

const markerName = (jobId: string) => `${createHash('sha256').update(jobId).digest('hex')}.marker`;

export const createGrantLedger = (options: GrantLedgerOptions): GrantLedger => {
  const pathFor = (jobId: string) => join(options.root, markerName(jobId));
  const read = async (jobId: string): Promise<GrantMarkerRead> => {
    let value: string;
    try {
      value = await readFile(pathFor(jobId), 'utf8');
    } catch (error) {
      return Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(error)
        ? { kind: 'missing' }
        : { kind: 'invalid' };
    }
    const decoded = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.fromJsonString(GrantMarker), { onExcessProperty: 'error' })(
        value,
      ),
    );
    if (decoded === undefined || markerName(decoded.jobId) !== basename(pathFor(jobId)))
      return { kind: 'invalid' };
    return { kind: 'present', jobId: decoded.jobId, issuer: decoded.issuer };
  };
  const write = async (jobId: string): Promise<void> => {
    const issuer = options.activeIssuer;
    if (!issuer) throw new Error('missing relay grant issuer');
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    await writeFile(pathFor(jobId), `${JSON.stringify({ version: 1, jobId, issuer })}\n`, {
      mode: 0o600,
    });
  };
  const clear = async (jobId: string): Promise<void> => {
    try {
      await rm(pathFor(jobId), { force: true });
    } catch {
      // A stale marker only causes a redundant identity revocation next start.
    }
  };
  const revokeRecorded = async (
    jobId: string,
    issuer: GrantIssuer | undefined,
  ): Promise<boolean> => {
    const client = options.client;
    const active = options.activeIssuer;
    if (
      client === undefined ||
      issuer === undefined ||
      active === undefined ||
      active.origin !== issuer.origin ||
      active.generation !== issuer.generation
    )
      return false;
    const deadline = Date.now() + options.budgetMs;
    for (let attempt = 0; attempt < options.attempts; attempt += 1) {
      try {
        await client.revoke(jobId);
        await clear(jobId);
        return true;
      } catch {
        // A bounded retry keeps a transient control failure from losing revocation.
      }
      if (Date.now() >= deadline) break;
    }
    return false;
  };
  const revoke = async (jobId: string, issuanceAttempted: boolean): Promise<boolean> => {
    if (options.client === undefined || !issuanceAttempted) return true;
    const deadline = Date.now() + options.budgetMs;
    for (let attempt = 0; attempt < options.attempts; attempt += 1) {
      try {
        await options.client.revoke(jobId);
        await clear(jobId);
        return true;
      } catch {
        // A bounded retry keeps a transient control failure from losing revocation.
      }
      if (Date.now() >= deadline) break;
    }
    return false;
  };
  const recoverPending = async (): Promise<boolean> => {
    let names: string[];
    try {
      names = await readdir(options.root);
    } catch (error) {
      if (!Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(error)) return false;
      names = [];
    }
    let unresolved = false;
    for (const name of names) {
      if (!name.endsWith('.marker')) continue;
      const decoded = Option.getOrUndefined(
        Schema.decodeUnknownOption(Schema.fromJsonString(GrantMarker), {
          onExcessProperty: 'error',
        })(await readFile(join(options.root, name), 'utf8').catch(() => '')),
      );
      const marker =
        decoded === undefined || markerName(decoded.jobId) !== name
          ? { kind: 'invalid' as const }
          : { kind: 'present' as const, jobId: decoded.jobId, issuer: decoded.issuer };
      if (marker.kind !== 'present') {
        unresolved = true;
        continue;
      }
      if (!(await revokeRecorded(marker.jobId, marker.issuer))) unresolved = true;
    }
    return !unresolved;
  };
  let recovered: boolean | undefined;
  let recovery: Promise<boolean> | undefined;
  const startRecovery = () => {
    recovered = undefined;
    const active = recoverPending()
      .catch(() => false)
      .then((ok) => {
        recovered = ok;
        return ok;
      });
    recovery = active;
    return active;
  };
  return {
    read,
    write,
    clear,
    revokeRecorded,
    revoke: (jobId, attempted) => revoke(jobId, attempted),
    recoverPending,
    startRecovery,
    recovery: () => recovery,
    status: () => recovered,
  };
};

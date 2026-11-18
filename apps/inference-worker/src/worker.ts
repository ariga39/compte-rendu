import { Option, Schema } from 'effect';
import type { ModelUsageSummary } from '@compte-rendu/contracts';
import { readUsage, sweep } from './ledger.ts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  createGrantControl,
  type D1DatabaseLike,
  type IssueGrantInput,
  type IssueGrantResult,
  type RevokeGrantInput,
  type RevokeGrantResult,
} from './grants';

const UsageInput = Schema.Struct({ jobId: Schema.NonEmptyString });

export interface InferenceWorkerEnv {
  readonly RELAY_DB: D1DatabaseLike;
}

export class InferenceWorker extends WorkerEntrypoint<InferenceWorkerEnv> {
  fetch(): Response {
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  issue(input: IssueGrantInput): Promise<IssueGrantResult> {
    return createGrantControl(this.env.RELAY_DB).issue(input);
  }

  revoke(input: RevokeGrantInput): Promise<RevokeGrantResult> {
    return createGrantControl(this.env.RELAY_DB).revoke(input);
  }

  usage(input: { readonly jobId: string }): Promise<ModelUsageSummary | null> {
    const decoded = Schema.decodeUnknownOption(UsageInput, { onExcessProperty: 'error' })(input);
    if (Option.isNone(decoded)) return Promise.resolve(null);
    return readUsage(this.env.RELAY_DB, decoded.value.jobId);
  }

  sweep(): Promise<number> {
    return sweep(this.env.RELAY_DB);
  }

  async scheduled(): Promise<void> {
    await sweep(this.env.RELAY_DB);
  }
}

export default InferenceWorker;

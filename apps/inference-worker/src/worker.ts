import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  createGrantControl,
  type D1DatabaseLike,
  type IssueGrantInput,
  type IssueGrantResult,
  type RevokeGrantInput,
  type RevokeGrantResult,
} from './grants';

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
}

export default InferenceWorker;

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { Schema } from 'effect';
import {
  GitHubSha,
  MAX_RUNNER_CALLBACK_BYTES,
  RunnerJobInput,
  RunnerResultCallback,
  type RunnerResultCallback as RunnerResultCallbackType,
} from '../packages/contracts/src/index.ts';
import { formatReviewPublicationPayload } from '../apps/core/src/review-publication-format.ts';
import {
  createGitHubPublicationShim,
  type GitHubPublicationShim,
  type GitHubReadAdapter,
} from '../tests/support/github-publication-shim.ts';

const probeJob = Schema.Struct({
  repositoryId: Schema.Int,
  installationId: Schema.Int,
  job: RunnerJobInput,
});
const reviewTarget = Schema.Struct({ headSha: GitHubSha });

type ProbeJob = typeof probeJob.Type;

export interface GitHubPublicationProbeOptions {
  readonly jobsPath: string;
  readonly evidenceRoot: string;
  readonly callbackToken: string;
  readonly readAdapter?: GitHubReadAdapter;
}

export interface GitHubPublicationProbe {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly github: GitHubPublicationShim;
}

const requireMode = async (path: string, expected: number) => {
  const permissions = (await stat(path)).mode & 0o777;
  if (permissions !== expected) {
    throw new Error(`${path} must have mode ${expected.toString(8)}`);
  }
};

const readProbeJobs = async (jobsPath: string): Promise<readonly ProbeJob[]> => {
  await requireMode(jobsPath, 0o600);
  const value: unknown = JSON.parse(await readFile(jobsPath, 'utf8'));
  return Schema.decodeUnknownPromise(Schema.Array(probeJob))(value);
};

const writePrivate = async (path: string, content: string | Uint8Array) => {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
};

const response = (status: number, body?: string, contentType?: string) =>
  new Response(body, {
    status,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': contentType ?? 'application/json; charset=utf-8' } }),
  });

const authorized = (request: Request, token: string) =>
  request.headers.get('authorization') === `Bearer ${token}`;

const route = (request: Request) => new URL(request.url).pathname;

export const createGitHubPublicationProbe = async (
  options: GitHubPublicationProbeOptions,
): Promise<GitHubPublicationProbe> => {
  const jobs = [...(await readProbeJobs(options.jobsPath))];
  await mkdir(options.evidenceRoot, { recursive: true, mode: 0o700 });
  await chmod(options.evidenceRoot, 0o700);

  const github = createGitHubPublicationShim(options.readAdapter ?? {});
  const claimed = new Map<string, ProbeJob>();
  let callbackNumber = 0;
  let reviewNumber = 0;

  const handleClaim = async (request: Request) => {
    if (!authorized(request, options.callbackToken)) return response(401);
    const next = jobs.shift();
    if (next === undefined) return response(204);
    claimed.set(next.job.id, next);
    return response(200, JSON.stringify(next.job));
  };

  const handleCallback = async (request: Request) => {
    if (!authorized(request, options.callbackToken)) return response(401);
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_RUNNER_CALLBACK_BYTES) return response(413);

    let callback: RunnerResultCallbackType;
    try {
      callback = await Schema.decodeUnknownPromise(RunnerResultCallback)(
        JSON.parse(new TextDecoder().decode(body)),
      );
    } catch {
      return response(400);
    }

    const expected = claimed.get(callback.id);
    if (expected === undefined) return response(404);
    if (expected.job.runId !== callback.runId || expected.job.attempt !== callback.attempt) {
      return response(409);
    }

    callbackNumber += 1;
    await writePrivate(
      join(options.evidenceRoot, `callback-${callbackNumber}.json`),
      new Uint8Array(body),
    );

    if (callback.status === 'succeeded') {
      if (options.readAdapter?.loadReviewTarget !== undefined) {
        try {
          const target = await Schema.decodeUnknownPromise(reviewTarget)(
            await options.readAdapter.loadReviewTarget({
              repositoryId: expected.repositoryId,
              pullRequestNumber: expected.job.pullRequestNumber,
              installationId: expected.installationId,
            }),
          );
          if (target.headSha !== expected.job.headSha) return response(409);
        } catch {
          return response(503);
        }
      }

      await github.createReview!({
        repositoryId: expected.repositoryId,
        pullRequestNumber: expected.job.pullRequestNumber,
        installationId: expected.installationId,
        payload: formatReviewPublicationPayload({
          runId: expected.job.runId,
          headSha: expected.job.headSha,
          markdown: callback.result,
        }),
      });
      const capturedReview = github.capturedReviews.at(-1);
      if (capturedReview === undefined) return response(500);
      reviewNumber += 1;
      await writePrivate(
        join(options.evidenceRoot, `captured-review-${reviewNumber}.json`),
        JSON.stringify(capturedReview, null, 2),
      );
    }

    claimed.delete(callback.id);
    return response(202);
  };

  return {
    github,
    fetch: async (request) => {
      const pathname = route(request);
      if (pathname !== '/runner-claim' && pathname !== '/runner-callback') {
        return response(404);
      }
      if (request.method !== 'POST') return response(405);
      return pathname === '/runner-claim' ? handleClaim(request) : handleCallback(request);
    },
  };
};

const collectBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const nodeRequest = async (request: IncomingMessage) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(name, typeof value === 'string' ? value : value.join(', '));
    }
  }
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await collectBody(request);
  const host = typeof request.headers.host === 'string' ? request.headers.host : '127.0.0.1';
  return new Request(`http://${host}${request.url ?? '/'}`, {
    method: request.method,
    headers,
    body,
  });
};

const sendNodeResponse = async (response: Response, reply: ServerResponse) => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  reply.writeHead(response.status, headers);
  reply.end(Buffer.from(await response.arrayBuffer()));
};

export const createGitHubPublicationProbeServer = (probe: GitHubPublicationProbe): Server =>
  createServer(async (request, reply) => {
    try {
      await sendNodeResponse(await probe.fetch(await nodeRequest(request)), reply);
    } catch {
      if (!reply.headersSent) reply.writeHead(500);
      reply.end();
    }
  });

const listen = (server: Server, port: number) =>
  new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('probe server did not expose a TCP address'));
        return;
      }
      resolvePort(address.port);
    });
  });

const runCli = async () => {
  const [jobsPath, evidenceRoot] = process.argv.slice(2);
  if (jobsPath === undefined || evidenceRoot === undefined) {
    throw new Error('usage: github-publication-probe.mts <jobs.json> <evidence-root>');
  }
  const callbackToken = process.env.RUNNER_CALLBACK_TOKEN;
  if (callbackToken === undefined || callbackToken.length === 0) {
    throw new Error('RUNNER_CALLBACK_TOKEN is required');
  }
  const probe = await createGitHubPublicationProbe({
    jobsPath,
    evidenceRoot,
    callbackToken,
  });
  const server = createGitHubPublicationProbeServer(probe);
  const port = await listen(server, Number(process.env.COMPTE_RENDU_PROBE_PORT ?? 0));
  process.stdout.write(`GitHub publication probe listening on http://127.0.0.1:${port}\n`);
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  await runCli();
}

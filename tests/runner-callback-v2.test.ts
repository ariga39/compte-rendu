import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_RUNNER_EVIDENCE_BYTES } from '../packages/contracts/src';
import { finalMarkdownJsonl, runAgentScenario, sessionExportJson } from './support/runner-harness';

const readRequest = async (request: Request) => JSON.parse(await request.clone().text());

const expectEvidenceField = (field: Record<string, unknown>) => {
  expect(field).toMatchObject({
    content: expect.any(String),
    size: expect.any(Number),
    sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
};

describe('Runner v2 callback and private diagnostic upload', () => {
  it('sends a slim terminal callback and uploads readable diagnostics separately', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-callback-v2-'));
    const callbackRequests: Request[] = [];
    const evidenceRequests: Request[] = [];
    try {
      const result = await runAgentScenario({
        runId: 'run-callback-v2-slim',
        output: finalMarkdownJsonl(),
        evidenceRoot,
        callbackRequests,
        evidenceRequests,
      });

      expect(result.terminal.status).toBe('succeeded');
      expect(callbackRequests).toHaveLength(1);
      expect(evidenceRequests).toHaveLength(1);
      expect(callbackRequests[0]!.url).toBe('https://ingress.test/runner-callback');
      expect(evidenceRequests[0]!.url).toBe('https://ingress.test/runner-evidence');
      expect(evidenceRequests[0]!.headers.get('authorization')).toBe('Bearer callback-token');

      const callback = await readRequest(callbackRequests[0]!);
      expect(callback).toMatchObject({
        version: 2,
        id: result.terminal.id,
        runId: 'run-callback-v2-slim',
        attempt: 1,
        status: 'succeeded',
        sandbox: { cleanup: 'destroyed' },
        evidence: { id: result.terminal.evidenceId, status: 'complete' },
      });
      expect(callback.evidence).not.toHaveProperty('manifest');
      expect(callback.evidence).not.toHaveProperty('opencodeJsonl');
      expect(callback).not.toHaveProperty('failure');

      const upload = await readRequest(evidenceRequests[0]!);
      expect(upload).toMatchObject({
        version: 2,
        id: result.terminal.id,
        runId: 'run-callback-v2-slim',
        attempt: 1,
        evidenceId: result.terminal.evidenceId,
        evidence: { id: result.terminal.evidenceId, status: 'complete' },
      });
      expectEvidenceField(upload.evidence.manifest);
      expectEvidenceField(upload.evidence.opencodeJsonl);
      expectEvidenceField(upload.evidence.opencodeStderr);
      expectEvidenceField(upload.evidence.validatedReview);
      expectEvidenceField(upload.evidence.opencodeSessionList);
      expect(upload.evidence.opencodeExport).toMatchObject({ sessionId: 'scenario-session' });
      expectEvidenceField(upload.evidence.opencodeExport.content);
      expect(upload).not.toHaveProperty('result');
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('keeps the verified result when the independent evidence upload is unavailable', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-callback-v2-failure-'));
    const callbackRequests: Request[] = [];
    const evidenceRequests: Request[] = [];
    try {
      const result = await runAgentScenario({
        runId: 'run-callback-v2-evidence-unavailable',
        output: finalMarkdownJsonl(),
        evidenceRoot,
        callbackRequests,
        evidenceRequests,
        evidenceStatuses: [503],
      });

      expect(result.terminal).toMatchObject({
        status: 'succeeded',
        sandbox: { cleanup: 'destroyed' },
      });
      expect(callbackRequests).toHaveLength(1);
      expect(evidenceRequests).toHaveLength(1);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('retries transient callback delivery before declaring the result published', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-callback-v2-retry-'));
    const callbackRequests: Request[] = [];
    const evidenceRequests: Request[] = [];
    try {
      const result = await runAgentScenario({
        runId: 'run-callback-v2-retry',
        output: finalMarkdownJsonl(),
        evidenceRoot,
        callbackRequests,
        evidenceRequests,
        callbackStatuses: [503, 429, 202],
        callbackRetryDelaysMs: [0, 0, 0],
      });

      expect(result.terminal.status).toBe('succeeded');
      expect(callbackRequests).toHaveLength(3);
      expect(await callbackRequests[1]!.clone().text()).toBe(
        await callbackRequests[0]!.clone().text(),
      );
      expect(await callbackRequests[2]!.clone().text()).toBe(
        await callbackRequests[0]!.clone().text(),
      );
      expect(evidenceRequests).toHaveLength(1);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('uploads a 4 MiB session export intact within the real upload budget', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-callback-v2-4mi-'));
    const callbackRequests: Request[] = [];
    const evidenceRequests: Request[] = [];
    const exportValue = (() => {
      const exported = JSON.parse(sessionExportJson('scenario-session')) as {
        messages: unknown[];
      };
      exported.messages.unshift({
        type: 'assistant',
        id: 'preamble',
        finish: 'stop',
        content: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024) }],
      });
      return JSON.stringify(exported);
    })();
    try {
      const result = await runAgentScenario({
        runId: 'run-callback-v2-four-mib-export',
        output: finalMarkdownJsonl(),
        evidenceRoot,
        callbackRequests,
        evidenceRequests,
        sessionExport: exportValue,
      });

      expect(result.terminal.status).toBe('succeeded');
      expect(callbackRequests).toHaveLength(1);
      expect(evidenceRequests).toHaveLength(1);
      expect(Buffer.byteLength(await evidenceRequests[0]!.clone().text())).toBeLessThanOrEqual(
        MAX_RUNNER_EVIDENCE_BYTES,
      );
      const upload = await readRequest(evidenceRequests[0]!);
      const exported = upload.evidence.opencodeExport.content as {
        content: string;
        size: number;
        truncated?: boolean;
      };
      expect(exported.truncated).toBeUndefined();
      expect(exported.size).toBe(Buffer.byteLength(exportValue));
      expect(Buffer.from(exported.content, 'base64').toString('utf8')).toBe(exportValue);
      expect((upload.evidence.manifest as { truncated?: boolean }).truncated).toBeUndefined();
      expect(
        (upload.evidence.opencodeSessionList as { truncated?: boolean }).truncated,
      ).toBeUndefined();
      expect(
        (upload.evidence.validatedReview as { truncated?: boolean }).truncated,
      ).toBeUndefined();
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('truncates an oversized diagnostic artifact without changing the verified result', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-callback-v2-large-'));
    const callbackRequests: Request[] = [];
    const evidenceRequests: Request[] = [];
    const oversizedExport = (() => {
      const exported = JSON.parse(sessionExportJson('scenario-session')) as {
        messages: unknown[];
      };
      exported.messages.unshift({
        type: 'assistant',
        id: 'preamble',
        finish: 'stop',
        content: [{ type: 'text', text: 'x'.repeat(30 * 1024 * 1024) }],
      });
      return JSON.stringify(exported);
    })();
    try {
      const result = await runAgentScenario({
        runId: 'run-callback-v2-large-diagnostic',
        output: finalMarkdownJsonl(),
        evidenceRoot,
        callbackRequests,
        evidenceRequests,
        sessionExport: oversizedExport,
      });

      expect(result.terminal).toMatchObject({
        status: 'succeeded',
        sandbox: { cleanup: 'destroyed' },
      });
      expect(callbackRequests).toHaveLength(1);
      expect(evidenceRequests).toHaveLength(1);
      expect(Buffer.byteLength(await evidenceRequests[0]!.clone().text())).toBeLessThanOrEqual(
        MAX_RUNNER_EVIDENCE_BYTES,
      );

      const callback = await readRequest(callbackRequests[0]!);
      expect(callback.status).toBe('succeeded');
      expect(callback.evidence).toEqual({
        id: result.terminal.evidenceId,
        status: 'complete',
      });
      expect(await callbackRequests[0]!.clone().text()).not.toContain('xxxxxxxxxx');

      const upload = await readRequest(evidenceRequests[0]!);
      const exported = upload.evidence.opencodeExport.content as {
        content: string;
        size: number;
        truncated?: boolean;
      };
      expect(exported.truncated).toBe(true);
      expect(exported.size).toBeLessThan(Buffer.byteLength(oversizedExport));
      expect(Buffer.from(exported.content, 'base64').byteLength).toBe(exported.size);
      expect((upload.evidence.manifest as { truncated?: boolean }).truncated).toBeUndefined();
      expect(
        (upload.evidence.opencodeSessionList as { truncated?: boolean }).truncated,
      ).toBeUndefined();
      expect(
        (upload.evidence.validatedReview as { truncated?: boolean }).truncated,
      ).toBeUndefined();
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});

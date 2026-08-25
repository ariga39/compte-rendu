import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const readConfig = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, `file://${repositoryRoot}/`)), 'utf8');
const parseConfig = (path: string) =>
  JSON.parse(
    readConfig(path)
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,\s*([}\]])/g, '$1'),
  ) as {
    secrets?: { required?: readonly string[] };
  };

describe('Wrangler deployment wiring', () => {
  it('declares the private core resources and public ingress service binding', () => {
    const core = readConfig('apps/core/wrangler.jsonc');
    const ingress = readConfig('apps/ingress/wrangler.jsonc');

    expect(core).toContain('"workers_dev": false');
    expect(core).toContain('"name": "petit-chiba-core"');
    expect(core).toContain('"binding": "REVIEW_DB"');
    expect(core).toContain('"database_name": "petit-chiba-review-state"');
    expect(core).toContain('"binding": "REVIEW_WORKFLOW"');
    expect(core).toContain('"name": "petit-chiba-review"');
    expect(core).toContain('"class_name": "ReviewWorkflow"');
    expect(core).toContain('"class_name": "Sandbox"');
    expect(core).toContain('"class_name": "ReviewLeaseDurableObject"');
    expect(core).toContain('GITHUB_APP_PRIVATE_KEY');
    expect(core).toContain('MODEL_API_KEY');
    expect(core).toContain('"GITHUB_APP_ID": "REPLACE_WITH_GITHUB_APP_ID"');
    expect(core).not.toMatch(/"GITHUB_APP_ID": "\d+"/);
    expect(core).toContain('"database_id": "REPLACE_WITH_D1_DATABASE_ID"');
    expect(core).not.toMatch(/"database_id": "\d+"/);

    expect(ingress).toContain('"workers_dev": true');
    expect(ingress).toContain('"name": "petit-chiba-ingress"');
    expect(ingress).toContain('"binding": "CORE"');
    expect(ingress).toContain('"service": "petit-chiba-core"');
    expect(ingress).toContain('WEBHOOK_SECRET');
  });

  it('declares deployment-required secrets as Wrangler configuration', () => {
    const coreSecrets = parseConfig('apps/core/wrangler.jsonc').secrets?.required;
    const ingressSecrets = parseConfig('apps/ingress/wrangler.jsonc').secrets?.required;

    expect(coreSecrets).toHaveLength(2);
    expect(coreSecrets).toEqual(
      expect.arrayContaining(['GITHUB_APP_PRIVATE_KEY', 'MODEL_API_KEY']),
    );
    expect(ingressSecrets).toEqual(['WEBHOOK_SECRET']);
  });
});

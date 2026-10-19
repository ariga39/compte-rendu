import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite-plus';

// Build the same Effect contract Runner imports into a self-contained module
// for OpenCode. No compiler or dependency installation runs inside a job.
export const reviewContractBundle = (): Plugin => {
  const moduleId = 'virtual:review-contract-source';
  const resolvedId = `\0${moduleId}`;
  const entry = fileURLToPath(
    new URL('../apps/runner/src/review-submission-contract.ts', import.meta.url),
  );
  return {
    name: 'review-contract-bundle',
    resolveId(id) {
      if (id === moduleId) return resolvedId;
    },
    async load(id) {
      if (id !== resolvedId) return;
      this.addWatchFile(entry);
      const result = await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          write: false,
          target: 'es2022',
          minify: false,
          lib: { entry, formats: ['es'] },
          rollupOptions: { output: { codeSplitting: false } },
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const chunks = outputs.flatMap((output) => ('output' in output ? output.output : []));
      if (chunks.length !== 1 || chunks[0].type !== 'chunk') {
        throw new Error('Review contract must build to one standalone module');
      }
      return `export default ${JSON.stringify(chunks[0].code)};`;
    },
  };
};

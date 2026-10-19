import type {
  ModelUsageRow,
  ModelUsageSummary,
  TokenCount,
} from '../../../packages/contracts/src/model-usage.js';

export interface UpstreamUsage {
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly complete: boolean;
}

type Accumulator = {
  total: number;
  reportedRequests: number;
};

type MutableRow = {
  route: string;
  model: string | null;
  requests: number;
  incompleteRequests: number;
  input: Accumulator;
  uncachedInput: Accumulator;
  cacheRead: Accumulator;
  cacheWrite: Accumulator;
  output: Accumulator;
  reasoning: Accumulator;
};

const MAX_ROWS = 32;

const add = (target: Accumulator, value: number | null): void => {
  if (value === null) return;
  target.total += value;
  target.reportedRequests += 1;
};

const tokenCount = (value: Accumulator): TokenCount | null =>
  value.reportedRequests === 0
    ? null
    : { total: value.total, reportedRequests: value.reportedRequests };

const empty = (): Accumulator => ({ total: 0, reportedRequests: 0 });

const uncachedInput = (usage: UpstreamUsage): number | null =>
  usage.inputTokens !== null &&
  usage.cacheReadTokens !== null &&
  usage.inputTokens >= usage.cacheReadTokens
    ? usage.inputTokens - usage.cacheReadTokens
    : null;

export const createUsageCollector = () => {
  const rows = new Map<string, MutableRow>();
  let truncated = false;
  return {
    record(route: string, usage: UpstreamUsage): void {
      const model = usage.model;
      const key = `${route}\u0000${model ?? ''}`;
      let row = rows.get(key);
      if (row === undefined) {
        if (rows.size >= MAX_ROWS) {
          truncated = true;
          return;
        }
        row = {
          route,
          model,
          requests: 0,
          incompleteRequests: 0,
          input: empty(),
          uncachedInput: empty(),
          cacheRead: empty(),
          cacheWrite: empty(),
          output: empty(),
          reasoning: empty(),
        };
        rows.set(key, row);
      }
      row.requests += 1;
      if (!usage.complete) row.incompleteRequests += 1;
      add(row.input, usage.inputTokens);
      add(row.uncachedInput, uncachedInput(usage));
      add(row.cacheRead, usage.cacheReadTokens);
      add(row.cacheWrite, usage.cacheWriteTokens);
      add(row.output, usage.outputTokens);
      add(row.reasoning, usage.reasoningTokens);
    },
    snapshot(): ModelUsageSummary {
      const models: ModelUsageRow[] = [...rows.values()].map((row) => ({
        route: row.route,
        model: row.model,
        requests: row.requests,
        incompleteRequests: row.incompleteRequests,
        inputTokens: tokenCount(row.input),
        uncachedInputTokens: tokenCount(row.uncachedInput),
        cacheReadTokens: tokenCount(row.cacheRead),
        cacheWriteTokens: tokenCount(row.cacheWrite),
        outputTokens: tokenCount(row.output),
        reasoningTokens: tokenCount(row.reasoning),
      }));
      return { version: 1, models, ...(truncated ? { truncated: true } : {}) };
    },
  };
};

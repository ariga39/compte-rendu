export interface UpstreamUsage {
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly complete: boolean;
}

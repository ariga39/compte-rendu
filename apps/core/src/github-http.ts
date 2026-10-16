export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`GitHub request failed with ${status}`);
  }
}

export class GitHubNotFoundError extends GitHubRequestError {
  constructor() {
    super(404);
  }
}

export const parseRetryAfterMs = (response: Response): number | undefined => {
  const header = response.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const reset = response.headers.get('x-ratelimit-reset');
  if ((response.status === 403 || response.status === 429) && reset !== null) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) return Math.max(0, epochSeconds * 1000 - Date.now());
  }
  return undefined;
};

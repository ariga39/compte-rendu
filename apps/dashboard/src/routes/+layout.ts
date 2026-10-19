import { DEFAULT_REVIEW_NAME, PublicDashboardConfig } from '@compte-rendu/contracts';
import { Schema } from 'effect';
import type { LayoutLoad } from './$types';

export const ssr = true;
export const prerender = false;

export const load: LayoutLoad = async ({ fetch }) => {
  try {
    const response = await fetch('/api/dashboard-config', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { reviewName: DEFAULT_REVIEW_NAME };
    const config = Schema.decodeUnknownSync(PublicDashboardConfig)(await response.json());
    return { reviewName: config.name };
  } catch {
    return { reviewName: DEFAULT_REVIEW_NAME };
  }
};

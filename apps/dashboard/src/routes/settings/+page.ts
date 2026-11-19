import type { ReviewConfiguration } from '@compte-rendu/contracts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, depends }) => {
  depends('dashboard:model-settings');
  const reply = await fetch('/api/model-settings');
  const settings = reply.ok
    ? ((await reply.json()) as { configuration: ReviewConfiguration; routes: string[] })
    : null;
  return { settings, status: reply.status };
};

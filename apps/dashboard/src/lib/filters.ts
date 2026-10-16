import type { Filters, StatusFilter } from './types.ts';

export const STATUSES: StatusFilter[] = [
  'all',
  'queued',
  'in_progress',
  'published',
  'failed',
  'superseded',
];

export function dateBound(value: string | null, edge: 'start' | 'end'): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value + (edge === 'end' ? 'T23:59:59.999Z' : 'T00:00:00.000Z');
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function dateOnly(value: string | null): string | null {
  if (!value) return null;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return null;
  return match[0];
}

export function readFilters(search: string): Filters {
  const params = new URLSearchParams(search);
  const rawStatus = params.get('status');
  const rawView = params.get('view');
  const rawCleanup = params.get('cleanup');
  const rawFrom = params.get('from');
  const rawTo = params.get('to');
  const status: StatusFilter = STATUSES.includes(rawStatus as StatusFilter)
    ? (rawStatus as StatusFilter)
    : 'all';
  const removedScope =
    rawStatus === 'active' ||
    (rawView !== null && rawView !== 'history') ||
    (rawCleanup !== null && rawCleanup !== 'all');
  return {
    status,
    from: dateBound(rawFrom, 'start'),
    to: dateBound(rawTo, 'end'),
    fromDate: dateOnly(rawFrom),
    toDate: dateOnly(rawTo),
    cursor: removedScope ? null : params.get('cursor') || null,
  };
}

export function buildFilterQuery(filters: Filters, includeCursor: boolean): string {
  const params = new URLSearchParams();
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (includeCursor && filters.cursor) params.set('cursor', filters.cursor);
  return params.toString();
}

export function cleanHistorySearch(search: string): string {
  return buildFilterQuery(readFilters(search), true);
}

export function historyRequestUrl(search: string): string {
  const query = buildFilterQuery(readFilters(search), true);
  return `/api/jobs${query ? `?${query}` : ''}`;
}

import type { CleanupFilter, Filters, StatusFilter, View } from './types';

export const VIEWS: View[] = ['history', 'current', 'cleanup'];
export const STATUSES: StatusFilter[] = ['all', 'active', 'published', 'failed', 'superseded'];
export const CLEANUPS: CleanupFilter[] = ['all', 'pending', 'destroyed', 'failed', 'unknown'];

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
  const rawView = params.get('view');
  const rawStatus = params.get('status');
  const rawCleanup = params.get('cleanup');
  const rawFrom = params.get('from');
  const rawTo = params.get('to');
  return {
    view: VIEWS.includes(rawView as View) ? (rawView as View) : 'history',
    status: STATUSES.includes(rawStatus as StatusFilter) ? (rawStatus as StatusFilter) : 'all',
    cleanup: CLEANUPS.includes(rawCleanup as CleanupFilter) ? (rawCleanup as CleanupFilter) : 'all',
    from: dateBound(rawFrom, 'start'),
    to: dateBound(rawTo, 'end'),
    fromDate: dateOnly(rawFrom),
    toDate: dateOnly(rawTo),
    cursor: params.get('cursor') || null,
  };
}

export function buildFilterQuery(filters: Filters, includeCursor: boolean): string {
  const params = new URLSearchParams();
  if (filters.view !== 'history') params.set('view', filters.view);
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.cleanup !== 'all') params.set('cleanup', filters.cleanup);
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

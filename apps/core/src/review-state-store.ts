import { ReviewModelSelection } from '@compte-rendu/contracts';
import { Option, Schema } from 'effect';
import { createCancellationStore, type CancellationStore } from './cancellation-store';
import {
  createDashboardMetadataStore,
  type DashboardMetadataStore,
} from './dashboard-metadata-store';
import { createCheckRunStore, type CheckRunStore } from './check-run-store';
import { createReviewLifecycleStore, type ReviewLifecycleStore } from './review-lifecycle-store';

export type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from './review-store-support';

export type { ReviewLifecycleStore } from './review-lifecycle-store';
export type { CheckRunStore, ReviewCheckDeliveryWorkItem } from './check-run-store';
export type {
  CancellationStore,
  ReviewCancellationResult,
  ReviewCancellationState,
  ReviewCancellationWorkItem,
} from './cancellation-store';
export type {
  DashboardMetadataStore,
  PublicOverviewCounts,
  PublicRunCursor,
  PublicRunFilter,
  PublicRunRow,
  PublicRunStatus,
  PublicRunStatusValue,
  PublicRunView,
  RecordProgressInput,
  RepositoryMetadataRow,
  RepositoryVisibility,
} from './dashboard-metadata-store';

export type D1ReviewStateStore = ReviewLifecycleStore &
  CheckRunStore &
  CancellationStore &
  DashboardMetadataStore;

// Historical aliases keep existing imports working while the Worker composes
// the four transaction-owned ports required by its behavior seam.
export type ReviewStateStore = D1ReviewStateStore;
export type ReviewStateQueries = D1ReviewStateStore;
export type ReviewPublicationStateStore = D1ReviewStateStore;

export const createD1ReviewStateStore = (
  database: import('./review-store-support').D1DatabaseLike,
  defaultRoute?: string,
): D1ReviewStateStore => {
  const route = defaultRoute?.trim();
  let defaultSelection: string | null = null;
  if (route) {
    const selection = Schema.decodeUnknownOption(ReviewModelSelection)({
      reviewers: [route],
      synthesis: route,
    });
    defaultSelection = Option.isSome(selection) ? JSON.stringify(selection.value) : null;
  }
  return {
    ...createReviewLifecycleStore(database, defaultSelection),
    ...createCheckRunStore(database),
    ...createCancellationStore(database),
    ...createDashboardMetadataStore(database),
  };
};

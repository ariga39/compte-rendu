import { onTestFinished } from 'vitest';
import { createD1ReviewStateStore } from '../../apps/core/src/review-state-store';
import { SqliteD1Database } from './d1-database';

export const createTestReviewStore = () => {
  const database = new SqliteD1Database();
  onTestFinished(() => database.close());
  return createD1ReviewStateStore(database);
};

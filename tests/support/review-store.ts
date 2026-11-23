import { onTestFinished } from 'vitest';
import { createD1ReviewStateStore } from '../../apps/core/src/review-state-store';
import { SqliteD1Database } from './d1-database';

export const runIdForDelivery = async (
  database: SqliteD1Database,
  deliveryId: string,
): Promise<string | undefined> =>
  (
    await database
      .prepare('SELECT run_id FROM review_runs WHERE delivery_id = ? ORDER BY rowid DESC LIMIT 1')
      .bind(deliveryId)
      .first<{ readonly run_id: string }>()
  )?.run_id;

export const createTestReviewStore = () => {
  const database = new SqliteD1Database();
  onTestFinished(() => database.close());
  const store = createD1ReviewStateStore(database);
  return Object.assign(store, {
    runIdForDelivery: (deliveryId: string) => runIdForDelivery(database, deliveryId),
  });
};

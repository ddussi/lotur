import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./postgres-transaction.ts";

/** Own the feed lock before any account/binding/thread locks, through COMMIT.
 * Sequence IDs are allocated only after the preceding writer has committed.
 * Hash collisions can serialize unrelated feeds, but cannot lose events.
 */
export function withReviewEventTransaction<T>(
  database: Pool,
  feed: Readonly<{ revisionId: string; routePath: string }>,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      JSON.stringify(["rt_review_events", feed.revisionId, feed.routePath]),
    ]);
    return work(client);
  });
}

import type { Pool, PoolClient } from "pg";

export type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export async function withTransaction<T>(
  database: Pool,
  work: (client: PoolClient) => Promise<T>,
  mode: "write" | "snapshot" = "write",
): Promise<T> {
  const client = await database.connect();
  let discardClient = false;
  try {
    await client.query(mode === "snapshot" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      discardClient = true;
      throw new AggregateError(
        [error, rollbackError],
        "PostgreSQL transaction failed and rollback also failed",
        { cause: error },
      );
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, inject, it } from "vitest";

import { useTestDatabase } from "../../test/database.ts";
import { connectDatabase, type DatabaseConnection } from "./client.ts";

const getDatabase = useTestDatabase();

let connection: DatabaseConnection | undefined;

afterEach(async () => {
  await connection?.close();
  connection = undefined;
});

async function backendPid(current: DatabaseConnection): Promise<number> {
  const result = await current.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  const pid = result.rows[0]?.pid;
  if (pid === undefined) {
    throw new Error("No backend pid");
  }
  return pid;
}

describe("connectDatabase", () => {
  it("reports a connection that the database closes, and keeps working with a new one", async () => {
    const errors: Error[] = [];
    connection = connectDatabase(inject("testAppDatabaseUrl"), {
      onError: (error) => errors.push(error),
    });
    const pid = await backendPid(connection);

    // What a restart of the database does to a connection waiting in the pool.
    await getDatabase().execute(sql`select pg_terminate_backend(${pid})`);
    await expect.poll(() => errors.length).toBe(1);

    expect(await backendPid(connection)).not.toBe(pid);
  });

  it("stops a statement that runs longer than the limit", async () => {
    connection = connectDatabase(inject("testAppDatabaseUrl"), { statementTimeoutMs: 100 });

    // 57014: query_canceled, the code PostgreSQL gives to a statement stopped by the timeout.
    await expect(connection.db.execute(sql`select pg_sleep(1)`)).rejects.toMatchObject({
      cause: { code: "57014", message: expect.stringContaining("statement timeout") },
    });
  });

  it("lets a statement run without limit when asked, as a migration needs", async () => {
    connection = connectDatabase(inject("testAppDatabaseUrl"), { statementTimeoutMs: 0 });

    const result = await connection.db.execute<{ timeout: string }>(
      sql`select current_setting('statement_timeout') as timeout`,
    );
    expect(result.rows[0]?.timeout).toBe("0");
  });

  it("limits statements and open transactions by default", async () => {
    connection = connectDatabase(inject("testAppDatabaseUrl"));

    const result = await connection.db.execute<{ statement: string; idle: string }>(
      sql`select current_setting('statement_timeout') as statement,
        current_setting('idle_in_transaction_session_timeout') as idle`,
    );
    expect(result.rows[0]).toEqual({ statement: "30s", idle: "1min" });
  });
});

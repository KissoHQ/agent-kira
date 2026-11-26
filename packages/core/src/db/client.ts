import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.ts";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseConnection {
  db: Database;
  close: () => Promise<void>;
}

export interface ConnectionOptions {
  // Called when a connection waiting in the pool fails, such as when the database restarts. Without
  // a listener, node-postgres raises it as an uncaught error, which stops the whole process.
  onError?: (error: Error) => void;
  // Longest run of one statement, in milliseconds; 0 for none, as for migrations.
  statementTimeoutMs?: number;
}

// A request waits at most this long for a connection, instead of forever when the database is down.
const connectionTimeoutMs = 10_000;
// Every statement of the application takes well under a second. A longer one is stopped, so it
// cannot hold a connection and its locks while the others wait.
const defaultStatementTimeoutMs = 30_000;
// No transaction waits on the model or on the network: one left open is a bug, and its locks are
// released after this delay.
const idleInTransactionTimeoutMs = 60_000;

export function connectDatabase(
  databaseUrl: string,
  options: ConnectionOptions = {},
): DatabaseConnection {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: connectionTimeoutMs,
    statement_timeout: options.statementTimeoutMs ?? defaultStatementTimeoutMs,
    idle_in_transaction_session_timeout: idleInTransactionTimeoutMs,
  });
  pool.on(
    "error",
    options.onError ??
      ((error) => {
        console.error(`Database connection lost: ${error.message}`);
      }),
  );
  return {
    db: drizzle({ client: pool, schema }),
    close: () => pool.end(),
  };
}

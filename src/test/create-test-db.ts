import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/db/schema";

/** Fresh in-memory database built from migrations, with the same pragmas
 * src/db/index.ts sets. The raw sqlite handle is exposed for tests that need
 * to step outside the drizzle schema (e.g. simulating a pre-upgrade DB). */
export function createTestDb(
  migrationsFolder = path.join(process.cwd(), "drizzle")
) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return { db, sqlite };
}

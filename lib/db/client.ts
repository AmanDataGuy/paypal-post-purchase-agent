/**
 * # client.ts - opens the database and applies migrations
 *
 * - `DATABASE_URL` set -> real Postgres (hosted). Unset -> PGlite, an embedded Postgres in ./.data (dev).
 * - Tests call `createDb("memory://")` for a fresh in-memory DB per test file.
 */
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzleLite } from "drizzle-orm/pglite";
import { migrate as migrateLite } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";
import * as schema from "./schema";

const migrationsFolder = "./drizzle";

// Open a DB (Postgres URL, or a PGlite data dir / "memory://") and bring its schema up to date.
export async function createDb(url = process.env.DATABASE_URL ?? "./.data/pglite") {
  if (url.startsWith("postgres")) {
    const db = drizzlePg(url, { schema });
    await migratePg(db, { migrationsFolder });
    return db;
  }
  if (!url.includes("://")) mkdirSync(url, { recursive: true }); // PGlite won't create missing parent folders
  const db = drizzleLite(new PGlite(url), { schema });
  await migrateLite(db, { migrationsFolder });
  // shortcut: both drivers share the Drizzle pg query API; the cast keeps one Db type for callers.
  return db as unknown as ReturnType<typeof drizzlePg<typeof schema>>;
}

export type Db = Awaited<ReturnType<typeof createDb>>;

let shared: Promise<Db> | undefined;
// The app-wide DB connection, opened on first use.
export const getDb = () => (shared ??= createDb());

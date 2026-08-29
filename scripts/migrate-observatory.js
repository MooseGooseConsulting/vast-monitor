import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = String(process.env.OWNER_DATABASE_URL || "").trim();
if (!url) throw new Error("OWNER_DATABASE_URL is required for observatory migration");
const client = new Client({ connectionString: url, application_name: "vast-observatory-migrator" });
await client.connect();
try {
  await client.query("SET ROLE vast_observatory_owner");
  await client.query("SELECT pg_advisory_lock(hashtext('vast-observatory-migrations'))");
  await client.query("CREATE SCHEMA IF NOT EXISTS ops AUTHORIZATION vast_observatory_owner");
  await client.query("CREATE TABLE IF NOT EXISTS ops.schema_migration (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())");
  for (const version of [1, 2, 3]) {
    const prior = await client.query("SELECT 1 FROM ops.schema_migration WHERE version=$1", [version]);
    if (prior.rowCount) continue;
    const sql = await fs.readFile(path.join(root, "migrations", `observatory-${String(version).padStart(4, "0")}.sql`), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO ops.schema_migration(version) VALUES($1)", [version]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    console.log(`applied observatory migration ${version}`);
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('vast-observatory-migrations'))").catch(() => {});
  await client.end();
}

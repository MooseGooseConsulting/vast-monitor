import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = String(process.env.OWNER_DATABASE_URL || "").trim();
if (!url) throw new Error("OWNER_DATABASE_URL is required for raw-market migration");
const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('vast-monitor-raw-market-migrations'))");
  await client.query("CREATE TABLE IF NOT EXISTS raw_market_schema_migration (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())");
  const migrations = [1, 2];
  for (const version of migrations) {
    const prior = await client.query("SELECT 1 FROM raw_market_schema_migration WHERE version=$1", [version]);
    if (prior.rowCount) continue;
    const sql = await fs.readFile(path.join(root, "migrations", `raw-market-${String(version).padStart(4, "0")}.sql`), "utf8");
    await client.query("BEGIN");
    try { await client.query(sql); await client.query("INSERT INTO raw_market_schema_migration(version) VALUES($1)", [version]); await client.query("COMMIT"); }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    console.log(`applied raw-market migration ${version}`);
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('vast-monitor-raw-market-migrations'))").catch(() => {});
  await client.end();
}

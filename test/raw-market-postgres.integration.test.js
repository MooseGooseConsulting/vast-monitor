import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.RAW_MARKET_TEST_DATABASE_URL;

test("PostgreSQL preserves raw response bytes, duplicate headers, and SHA-256", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const schema = `raw_market_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const body = Buffer.from([0, 255, 10, 13]);
  const headers = [{ name: "X-Trace", value: "one" }, { name: "X-Trace", value: "two" }];
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE ${schema}.document (body bytea NOT NULL, headers jsonb NOT NULL, sha256 text NOT NULL)`);
    await pool.query(`INSERT INTO ${schema}.document(body, headers, sha256) VALUES ($1, $2, $3)`, [body, JSON.stringify(headers), digest]);
    const { rows: [stored] } = await pool.query(`SELECT body, headers, sha256 FROM ${schema}.document`);
    assert.deepEqual(stored.body, body);
    assert.deepEqual(stored.headers, headers);
    assert.equal(stored.sha256, crypto.createHash("sha256").update(stored.body).digest("hex"));
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await pool.end();
  }
});

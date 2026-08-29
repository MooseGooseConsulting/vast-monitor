import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { ObservatoryCollector, SOURCE_CONTRACT_VERSION } from "../src/observatory/collector.js";

const once = process.argv.includes("--once");
const healthcheck = process.argv.includes("--healthcheck");
const databaseUrl = await requiredSecret("DATABASE_URL", "DATABASE_URL_FILE");
const pollIntervalMs = numberEnv("OBSERVATORY_POLL_INTERVAL_MS", 300_000);
if (pollIntervalMs !== 300_000) throw new Error("OBSERVATORY_POLL_INTERVAL_MS must be 300000");

const pool = new Pool({ connectionString: databaseUrl, application_name: "vast-observatory-v1" });
if (healthcheck) {
  const result = await pool.query("SELECT max(completed_at) AS completed_at FROM ops.collection_run WHERE collector_name=$1 AND status='complete'", [process.env.OBSERVATORY_COLLECTOR_NAME || "vast-observatory-v1"]);
  await pool.end();
  const completedAt = result.rows[0]?.completed_at ? new Date(result.rows[0].completed_at).getTime() : 0;
  if (!completedAt || Date.now() - completedAt > 20 * 60 * 1000) process.exit(1);
  process.exit(0);
}

const apiKey = await requiredSecret("VAST_API_KEY", "VAST_API_KEY_PATH");
const abortController = new AbortController();

const collector = new ObservatoryCollector({
  collectorName: process.env.OBSERVATORY_COLLECTOR_NAME || "vast-observatory-v1",
  contractVersion: process.env.OBSERVATORY_CONTRACT_VERSION || SOURCE_CONTRACT_VERSION,
  collectorRevision: process.env.OCI_REVISION || "unknown",
  imageDigest: process.env.IMAGE_DIGEST || null,
  pollIntervalMs,
  requestTimeoutMs: numberEnv("OBSERVATORY_REQUEST_TIMEOUT_MS", 120_000),
  cliTimeoutMs: numberEnv("OBSERVATORY_CLI_TIMEOUT_MS", 180_000),
  vastCliPath: process.env.VAST_CLI_PATH || "/usr/local/bin/vast",
  home: process.env.HOME || os.homedir(),
  apiKey,
  signal: abortController.signal
}, { pool });

let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopped = true;
  abortController.abort(new Error(signal));
});

try {
  if (once) {
    const result = await collector.collect();
    console.log(JSON.stringify(result));
  } else {
    while (!stopped) {
      const delay = alignedDelay(pollIntervalMs);
      await wait(delay, abortController.signal);
      if (stopped) break;
      const result = await collector.collect();
      console.log(JSON.stringify(result));
    }
  }
} finally {
  await pool.end();
}

async function requiredSecret(envName, fileEnvName) {
  const direct = String(process.env[envName] || "").trim();
  if (direct) return direct;
  const file = String(process.env[fileEnvName] || "").trim();
  if (!file) throw new Error(`${envName} or ${fileEnvName} is required`);
  const value = (await fs.readFile(path.resolve(file), "utf8")).trim();
  if (!value) throw new Error(`${fileEnvName} is empty`);
  return value;
}
function numberEnv(name, fallback) { const value = Number(process.env[name]); return Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function alignedDelay(interval) { const remainder = Date.now() % interval; return remainder === 0 ? interval : interval - remainder; }
function wait(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

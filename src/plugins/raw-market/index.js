import crypto from "node:crypto";
import https from "node:https";
import { Pool } from "pg";
import { definePlugin } from "../loader.js";

const R6000_WS = "RTX PRO 6000 WS";
const R6000_S = "RTX PRO 6000 S";
const HIGH_END_GPU_NAMES = [
  "A100 PCIE", "A100 SXM4", "A800 PCIE", "A40", "B200", "B300", "GB10",
  "H100 NVL", "H100 PCIE", "H100 SXM", "H200", "H200 NVL", "L40", "L40S",
  "RTX 5000 Ada", "RTX 5000Ada", "RTX 5880 Ada", "RTX 5880Ada",
  "RTX 6000 Ada", "RTX 6000Ada", "RTX A6000", "RTX 5090"
];
const DIRECTIONS = ["asc", "desc"];

export function offerSearchBody(gpuNames, direction) {
  if (!DIRECTIONS.includes(direction)) throw new Error("invalid_sort_direction");
  return Buffer.from(JSON.stringify({ gpu_name: { in: [...gpuNames] }, limit: 10000, order: [["id", direction]] }));
}

export function queryMatrix(catalogNames) {
  const groups = [["rtx-pro-6000-ws", [R6000_WS]], ["rtx-pro-6000-s", [R6000_S]]];
  if (Array.isArray(catalogNames)) {
    const others = [...new Set(catalogNames)].filter((name) => name.startsWith("RTX PRO ") && name !== R6000_WS && name !== R6000_S).sort();
    if (others.length) groups.push(["other-rtx-pro", others]);
  }
  groups.push(["named-high-end", HIGH_END_GPU_NAMES]);
  return groups.flatMap(([group, names]) => DIRECTIONS.map((direction) => ({ group, names, direction })));
}

export function gpuCatalogNames(raw) {
  const parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
  const names = Array.isArray(parsed) ? parsed : parsed?.gpu_names;
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) throw new Error("unexpected_gpu_catalog_shape");
  return names;
}

export function requestExact(urlString, { method = "GET", body = null, apiKey, timeoutMs = 60_000, request = https.request } = {}) {
  const payload = body == null ? null : Buffer.from(body);
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      handler(value);
    };
    const req = request(url, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}) }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.once("error", (error) => settle(reject, error));
      res.once("aborted", () => settle(reject, new Error("response_aborted")));
      res.once("close", () => settle(reject, new Error("response_closed_before_end")));
      res.once("end", () => settle(resolve, { status: res.statusCode || 0, headers: res.rawHeaders || [], body: Buffer.concat(chunks) }));
    });
    deadline = setTimeout(() => req.destroy(new Error(`request_deadline_${timeoutMs}ms`)), timeoutMs);
    req.once("error", (error) => settle(reject, error));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request_timeout_${timeoutMs}ms`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function headersToPairs(rawHeaders) {
  const pairs = [];
  for (let index = 0; index < rawHeaders.length; index += 2) pairs.push({ name: rawHeaders[index], value: rawHeaders[index + 1] });
  return pairs;
}

export class RawMarketArchive {
  constructor(config, { request } = {}) {
    this.config = config;
    this.request = request;
    this.pool = null;
    this.timer = null;
    this.polling = false;
    this.pollPromise = null;
    this.stopping = false;
    this.health = { ok: true, status: "disabled", last_attempt_at: null, last_success_at: null, last_error: null, response_documents: 0, raw_bytes: 0 };
  }

  async start() {
    if (!this.config.rawArchiveEnabled) return this;
    const databaseUrl = this.config.rawArchiveDatabaseUrl || await readSecret(this.config.rawArchiveDatabaseUrlFile, "DATABASE_URL is required when RAW_ARCHIVE_ENABLED=true");
    this.pool = new Pool({ connectionString: databaseUrl });
    this.pool.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.health = { ...this.health, ok: false, status: "degraded", last_error: `postgres_pool_error:${message}` };
    });
    this.health = { ...this.health, status: "starting" };
    // Begin only at the next aligned slot so cutover never creates an
    // off-cadence second writer.
    const delay = alignedDelay(this.config.rawArchivePollIntervalMs);
    this.timer = setTimeout(() => {
      this.launchPoll();
      this.timer = setInterval(() => this.launchPoll(), this.config.rawArchivePollIntervalMs);
      this.timer.unref?.();
    }, delay);
    this.timer.unref?.();
    return this;
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const completed = await settleWithin(this.pollPromise, 10_000);
    if (!completed) return;
    await this.pool?.end();
    this.pool = null;
  }

  getHealth() { return { ...this.health }; }

  launchPoll() {
    if (this.pollPromise || this.stopping) return this.pollPromise;
    this.pollPromise = this.poll()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.health = { ...this.health, ok: false, status: "degraded", last_error: `poll_runtime_error:${message}` };
      })
      .finally(() => { this.pollPromise = null; });
    return this.pollPromise;
  }

  async poll() {
    const pool = this.pool;
    if (!pool || this.polling || this.stopping) return;
    this.polling = true;
    const observedAt = new Date();
    const slot = new Date(Math.floor(observedAt.getTime() / this.config.rawArchivePollIntervalMs) * this.config.rawArchivePollIntervalMs);
    this.health = { ...this.health, status: "running", ok: true, last_attempt_at: observedAt.toISOString(), last_error: null };
    let runId;
    try {
      await pool.query("UPDATE raw_collection_run SET status='failed', completed_at=clock_timestamp(), error_code='stale_running_run', error_message='raw market extension restarted before completion' WHERE collector_name=$1 AND status='running' AND started_at < clock_timestamp() - interval '10 minutes'", ["vast-monitor-raw-market"]);
      const begun = await pool.query("INSERT INTO raw_collection_run (collector_name, poll_slot, status) VALUES ($1,$2,'running') ON CONFLICT (collector_name,poll_slot) DO NOTHING RETURNING id", ["vast-monitor-raw-market", slot]);
      runId = begun.rows[0]?.id;
      if (!runId) {
        const prior = await pool.query("SELECT status, error_message FROM raw_collection_run WHERE collector_name=$1 AND poll_slot=$2", ["vast-monitor-raw-market", slot]);
        const state = prior.rows[0];
        this.health = { ...this.health, ok: state?.status === "complete", status: state?.status === "complete" ? "ok" : "degraded", last_error: state?.error_message || `slot_${state?.status || "unknown"}` };
        return;
      }
      const apiKey = await readApiKey(this.config.vastApiKeyPath);
      let docs = 0; let bytes = 0;
      let catalogNames = null;
      const failures = [];
      let catalogPersistenceFailed = false;
      try {
        const catalog = await requestExact(this.config.rawArchiveGpuCatalogUrl, { apiKey, timeoutMs: this.config.rawArchiveRequestTimeoutMs, request: this.request });
        try {
          await this.persist(pool, runId, new Date(), "gpu-catalog", "gpu-catalog", null, this.config.rawArchiveGpuCatalogUrl, null, catalog); docs++; bytes += catalog.body.length;
        } catch (error) {
          catalogPersistenceFailed = true;
          failures.push(formatFailure("gpu_catalog_persist", error));
        }
        if (catalog.status !== 200) failures.push(`gpu_catalog_http_${catalog.status}`);
        else {
          try { catalogNames = gpuCatalogNames(catalog.body); }
          catch (error) { failures.push(`gpu_catalog_${error.constructor.name}`); }
        }
      } catch (error) { failures.push(formatFailure("gpu_catalog", error)); }
      if (catalogPersistenceFailed) throw new Error(failures.join(";"));
      for (const query of queryMatrix(catalogNames)) {
        const body = offerSearchBody(query.names, query.direction);
        let response;
        try {
          response = await requestExact(this.config.rawArchiveOffersUrl, { method: "POST", body, apiKey, timeoutMs: this.config.rawArchiveRequestTimeoutMs, request: this.request });
        } catch (error) {
          failures.push(formatFailure(`${query.group}_${query.direction}`, error));
          continue;
        }
        try {
          await this.persist(pool, runId, new Date(), "offer-search", query.group, query.direction, this.config.rawArchiveOffersUrl, body, response);
          docs++; bytes += response.body.length;
          if (response.status !== 200) failures.push(`${query.group}_${query.direction}_http_${response.status}`);
        } catch (error) {
          failures.push(formatFailure(`${query.group}_${query.direction}_persist`, error));
          break;
        }
      }
      const status = failures.length ? "failed" : "complete";
      await pool.query("UPDATE raw_collection_run SET status=$1, completed_at=clock_timestamp(), poll_duration_ms=$2, error_code=$3, error_message=$4 WHERE id=$5", [status, Date.now() - observedAt.getTime(), failures.length ? "collection_error" : null, failures.join(";").slice(0, 500) || null, runId]);
      this.health = { ...this.health, ok: failures.length === 0, status: failures.length ? "degraded" : "ok", last_success_at: failures.length ? this.health.last_success_at : new Date().toISOString(), last_error: failures.join(";") || null, response_documents: docs, raw_bytes: bytes };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runId) await pool.query("UPDATE raw_collection_run SET status='failed', completed_at=clock_timestamp(), error_code='runtime_error', error_message=$1 WHERE id=$2", [message.slice(0, 500), runId]).catch(() => {});
      this.health = { ...this.health, ok: false, status: "degraded", last_error: message };
    } finally { this.polling = false; }
  }

  async persist(pool, runId, observedAt, requestKind, queryGroup, direction, requestUrl, requestBody, response) {
    const headers = headersToPairs(response.headers);
    const contentType = headers.find((pair) => pair.name.toLowerCase() === "content-type")?.value || "";
    const metadata = { method: requestBody ? "POST" : "GET", url: requestUrl, body_sha256: requestBody ? sha256(requestBody) : null, body_bytes: requestBody?.length || 0 };
    await pool.query(`INSERT INTO raw_response_document (run_id,observed_at,request_kind,query_group,sort_direction,request_metadata,request_body,http_status,response_headers,response_content_type,response_sha256,response_bytes,response_body) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [runId, observedAt, requestKind, queryGroup, direction, JSON.stringify(metadata), requestBody, response.status, JSON.stringify(headers), contentType, sha256(response.body), response.body.length, response.body]);
  }
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function formatFailure(prefix, error) { const detail = error instanceof Error ? error.message : String(error); return `${prefix}_${error?.constructor?.name || "Error"}:${detail}`.slice(0, 450); }
async function readApiKey(file) { const { readFile } = await import("node:fs/promises"); const key = (await readFile(file, "utf8")).trim(); if (!key) throw new Error("empty_api_key_file"); return key; }
async function readSecret(file, missingMessage) { if (!file) throw new Error(missingMessage); const { readFile } = await import("node:fs/promises"); const value = (await readFile(file, "utf8")).trim(); if (!value) throw new Error(missingMessage); return value; }
function alignedDelay(interval) { const remainder = Date.now() % interval; return remainder === 0 ? interval : interval - remainder; }
async function settleWithin(promise, timeoutMs) {
  if (!promise) return true;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs));
  return Promise.race([promise.then(() => true, () => true), timeout]);
}

export default definePlugin({
  name: "raw-market",
  async start({ config }) { return new RawMarketArchive(config).start(); },
  async stop({ instance }) { await instance?.stop(); },
  getHealth({ instance }) { return instance?.getHealth() || { ok: true, status: "disabled" }; }
});

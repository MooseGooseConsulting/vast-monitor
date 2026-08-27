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
    const req = request(url, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}) }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.rawHeaders || [], body: Buffer.concat(chunks) }));
    });
    req.once("error", reject);
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

class RawMarketArchive {
  constructor(config) {
    this.config = config;
    this.pool = null;
    this.timer = null;
    this.polling = false;
    this.health = { ok: true, status: "disabled", last_attempt_at: null, last_success_at: null, last_error: null, response_documents: 0, raw_bytes: 0 };
  }

  async start() {
    if (!this.config.rawArchiveEnabled) return this;
    if (!this.config.rawArchiveDatabaseUrl) throw new Error("DATABASE_URL is required when RAW_ARCHIVE_ENABLED=true");
    this.pool = new Pool({ connectionString: this.config.rawArchiveDatabaseUrl });
    this.health = { ...this.health, status: "starting" };
    // An extension outage must not delay the community dashboard listener.
    void this.poll();
    const delay = alignedDelay(this.config.rawArchivePollIntervalMs);
    this.timer = setTimeout(() => {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), this.config.rawArchivePollIntervalMs);
      this.timer.unref?.();
    }, delay);
    this.timer.unref?.();
    return this;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pool?.end();
    this.pool = null;
  }

  getHealth() { return { ...this.health }; }

  async poll() {
    if (!this.pool || this.polling) return;
    this.polling = true;
    const observedAt = new Date();
    const slot = new Date(Math.floor(observedAt.getTime() / this.config.rawArchivePollIntervalMs) * this.config.rawArchivePollIntervalMs);
    this.health = { ...this.health, status: "running", ok: true, last_attempt_at: observedAt.toISOString(), last_error: null };
    let runId;
    try {
      await this.pool.query("UPDATE raw_collection_run SET status='failed', completed_at=clock_timestamp(), error_code='stale_running_run', error_message='raw market extension restarted before completion' WHERE collector_name=$1 AND status='running' AND started_at < clock_timestamp() - interval '10 minutes'", ["vast-monitor-raw-market"]);
      const begun = await this.pool.query("INSERT INTO raw_collection_run (collector_name, poll_slot, status) VALUES ($1,$2,'running') ON CONFLICT (collector_name,poll_slot) DO NOTHING RETURNING id", ["vast-monitor-raw-market", slot]);
      runId = begun.rows[0]?.id;
      if (!runId) { this.health = { ...this.health, status: "ok" }; return; }
      const apiKey = await readApiKey(this.config.vastApiKeyPath);
      let docs = 0; let bytes = 0;
      let catalogNames = null;
      const failures = [];
      try {
        const catalog = await requestExact(this.config.rawArchiveGpuCatalogUrl, { apiKey, timeoutMs: this.config.rawArchiveRequestTimeoutMs });
        await this.persist(runId, observedAt, "gpu-catalog", "gpu-catalog", null, this.config.rawArchiveGpuCatalogUrl, null, catalog); docs++; bytes += catalog.body.length;
        if (catalog.status !== 200) failures.push(`gpu_catalog_http_${catalog.status}`);
        else {
          try { catalogNames = gpuCatalogNames(catalog.body); }
          catch (error) { failures.push(`gpu_catalog_${error.constructor.name}`); }
        }
      } catch (error) { failures.push(`gpu_catalog_${error.constructor.name}`); }
      for (const query of queryMatrix(catalogNames)) {
        const body = offerSearchBody(query.names, query.direction);
        try {
          const response = await requestExact(this.config.rawArchiveOffersUrl, { method: "POST", body, apiKey, timeoutMs: this.config.rawArchiveRequestTimeoutMs });
          await this.persist(runId, observedAt, "offer-search", query.group, query.direction, this.config.rawArchiveOffersUrl, body, response);
          docs++; bytes += response.body.length;
          if (response.status !== 200) failures.push(`${query.group}_${query.direction}_http_${response.status}`);
        } catch (error) { failures.push(`${query.group}_${query.direction}_${error.constructor.name}`); }
      }
      const status = failures.length ? "failed" : "complete";
      await this.pool.query("UPDATE raw_collection_run SET status=$1, completed_at=clock_timestamp(), poll_duration_ms=$2, error_code=$3, error_message=$4 WHERE id=$5", [status, Date.now() - observedAt.getTime(), failures.length ? "collection_error" : null, failures.join(";").slice(0, 500) || null, runId]);
      this.health = { ...this.health, ok: failures.length === 0, status: failures.length ? "degraded" : "ok", last_success_at: failures.length ? this.health.last_success_at : new Date().toISOString(), last_error: failures.join(";") || null, response_documents: docs, raw_bytes: bytes };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runId) await this.pool.query("UPDATE raw_collection_run SET status='failed', completed_at=clock_timestamp(), error_code='runtime_error', error_message=$1 WHERE id=$2", [message.slice(0, 500), runId]).catch(() => {});
      this.health = { ...this.health, ok: false, status: "degraded", last_error: message };
    } finally { this.polling = false; }
  }

  async persist(runId, observedAt, requestKind, queryGroup, direction, requestUrl, requestBody, response) {
    const headers = headersToPairs(response.headers);
    const contentType = headers.find((pair) => pair.name.toLowerCase() === "content-type")?.value || "";
    const metadata = { method: requestBody ? "POST" : "GET", url: requestUrl, body_sha256: requestBody ? sha256(requestBody) : null, body_bytes: requestBody?.length || 0 };
    await this.pool.query(`INSERT INTO raw_response_document (run_id,observed_at,request_kind,query_group,sort_direction,request_metadata,request_body,http_status,response_headers,response_content_type,response_sha256,response_bytes,response_body) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [runId, observedAt, requestKind, queryGroup, direction, metadata, requestBody, response.status, headers, contentType, sha256(response.body), response.body.length, response.body]);
  }
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
async function readApiKey(file) { const { readFile } = await import("node:fs/promises"); const key = (await readFile(file, "utf8")).trim(); if (!key) throw new Error("empty_api_key_file"); return key; }
function alignedDelay(interval) { const remainder = Date.now() % interval; return remainder === 0 ? interval : interval - remainder; }

let archive;
export default definePlugin({
  name: "raw-market",
  async start({ config }) { archive = new RawMarketArchive(config); return archive.start(); },
  async stop() { await archive?.stop(); },
  getHealth() { return archive?.getHealth() || { ok: true, status: "disabled" }; }
});

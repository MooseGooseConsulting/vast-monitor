import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeEarningsDay } from "../vast-client.js";

const execFileAsync = promisify(execFile);

export const SOURCE_CONTRACT_VERSION = "vast-observatory-v1";
export const HTTP_SOURCES = Object.freeze([
  { name: "vast-gpu-catalog", url: "https://console.vast.ai/api/v0/gpu_names/unique/", authenticated: true, normalizer: "gpu-catalog" },
  { name: "vast-gpu-metrics-current", url: "https://console.vast.ai/api/v0/metrics/gpu/current/?verified=all&hosting_type=all&num_gpus=all", authenticated: true, normalizer: "gpu-rollup" },
  { name: "500farm-machines", url: "https://500.farm/vastai-exporter/machines", normalizer: "machines" },
  { name: "500farm-offers", url: "https://500.farm/vastai-exporter/offers", normalizer: "offers" },
  { name: "500farm-hosts", url: "https://500.farm/vastai-exporter/hosts", normalizer: "hosts" },
  { name: "500farm-gpu-stats", url: "https://500.farm/vastai-exporter/gpu-stats", normalizer: "gpu-rollup" },
  { name: "500farm-gpu-stats-v2", url: "https://500.farm/vastai-exporter/gpu-stats/v2", normalizer: "gpu-rollup" }
]);

export function accountSourceContract(now = new Date()) {
  const end = now.toISOString();
  const start = new Date(now.getTime() - (48 * 60 * 60 * 1000)).toISOString();
  return [
    { name: "vast-account-machines", args: ["show", "machines", "--raw"], normalizer: "account-machines" },
    { name: "vast-account-instances", args: ["show", "instances", "--raw"], normalizer: "account-instances" },
    { name: "vast-account-earnings", args: ["show", "earnings", "--raw", "-s", start, "-e", end], normalizer: "account-earnings" }
  ];
}

export class ObservatoryCollector {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.pool = dependencies.pool;
    this.fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    this.execFileImpl = dependencies.execFileImpl || execFileAsync;
    this.now = dependencies.now || (() => new Date());
    this.logger = dependencies.logger || console;
  }

  async collect() {
    const startedAt = this.now();
    const pollSlot = alignedSlot(startedAt, this.config.pollIntervalMs);
    const run = await this.pool.query(
      `INSERT INTO ops.collection_run
         (collector_name, poll_slot, status, contract_version, collector_revision, image_digest, source_contract)
       VALUES ($1,$2,'running',$3,$4,$5,$6)
       ON CONFLICT (collector_name,poll_slot) DO NOTHING
       RETURNING id`,
      [
        this.config.collectorName,
        pollSlot,
        this.config.contractVersion,
        this.config.collectorRevision,
        this.config.imageDigest,
        JSON.stringify(sourceContractSummary(startedAt, this.config.contractVersion))
      ]
    );
    const runId = run.rows[0]?.id;
    if (!runId) return { claimed: false, pollSlot };

    const failures = [];
    let documents = 0;
    let responseBytes = 0;

    for (const source of HTTP_SOURCES) {
      try {
        const response = await fetchSource(source, this.config, this.fetchImpl);
        const documentId = await this.persistDocument(runId, source, response);
        documents += 1;
        responseBytes += response.body.length;
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`http_${response.status}`);
        }
        await this.normalizeDocument(documentId, source, response.body, response.observedAt);
      } catch (error) {
        failures.push(await this.persistFailure(runId, source.name, error));
      }
      if (this.config.signal?.aborted) break;
    }

    for (const source of accountSourceContract(startedAt)) {
      try {
        const response = await runCliSource(source, this.config, this.execFileImpl, this.now);
        const documentId = await this.persistDocument(runId, source, response);
        documents += 1;
        responseBytes += response.body.length;
        await this.normalizeDocument(documentId, source, response.body, response.observedAt);
      } catch (error) {
        failures.push(await this.persistFailure(runId, source.name, error));
      }
      if (this.config.signal?.aborted) break;
    }

    const status = failures.length ? "failed" : "complete";
    await this.pool.query(
      `UPDATE ops.collection_run
          SET status=$1, completed_at=clock_timestamp(), poll_duration_ms=$2,
              document_count=$3, response_bytes=$4, error_count=$5,
              error_message=$6
        WHERE id=$7`,
      [
        status,
        this.now().getTime() - startedAt.getTime(),
        documents,
        responseBytes,
        failures.length,
        failures.join(";").slice(0, 2000) || null,
        runId
      ]
    );
    return { claimed: true, runId, pollSlot, status, documents, responseBytes, failures };
  }

  async persistDocument(runId, source, response) {
    const result = await this.pool.query(
      `INSERT INTO raw.source_document
         (run_id, source_name, endpoint, operation, observed_at, source_timestamp, source_declared_count,
          request_method, request_metadata, request_body, response_status,
          response_headers, response_content_type, response_sha256, response_bytes, response_body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        runId,
        source.name,
        response.endpoint,
        response.operation,
        response.observedAt,
        response.sourceTimestamp,
        response.sourceDeclaredCount,
        response.requestMethod,
        JSON.stringify(response.requestMetadata),
        response.requestBody,
        response.status,
        JSON.stringify(response.headers),
        response.contentType,
        sha256(response.body),
        response.body.length,
        response.body
      ]
    );
    return result.rows[0].id;
  }

  async persistFailure(runId, sourceName, error) {
    const message = safeError(error);
    await this.pool.query(
      `INSERT INTO ops.source_failure (run_id, source_name, observed_at, error_code, error_message)
       VALUES ($1,$2,clock_timestamp(),$3,$4)`,
      [runId, sourceName, error?.code || error?.name || "Error", message.slice(0, 2000)]
    );
    this.logger.error?.(`[observatory] ${sourceName}: ${message}`);
    return `${sourceName}:${message}`;
  }

  async normalizeDocument(documentId, source, body, observedAt) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.normalize(client, documentId, source, body, observedAt);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async normalize(database, documentId, source, body, observedAt) {
    const parsed = parseJson(body, source.name);
    switch (source.normalizer) {
      case "offers":
        return insertOfferObservations(database, documentId, source.name, observedAt, arrayFrom(parsed, "offers"));
      case "machines":
        return insertMachineObservations(database, documentId, source.name, observedAt, arrayFrom(parsed, "offers"));
      case "hosts":
        return insertHostObservations(database, documentId, source.name, observedAt, arrayFrom(parsed, "hosts"));
      case "gpu-rollup":
        return insertGpuRollups(database, documentId, source.name, observedAt, gpuRows(parsed));
      case "gpu-catalog":
        return insertGpuCatalog(database, documentId, source.name, observedAt, arrayFrom(parsed, "gpu_names"));
      case "account-machines":
        return insertAccountMachines(database, documentId, observedAt, Array.isArray(parsed) ? parsed : arrayFrom(parsed, "machines"));
      case "account-instances":
        return insertAccountInstances(database, documentId, observedAt, Array.isArray(parsed) ? parsed : arrayFrom(parsed, "instances"));
      case "account-earnings":
        return insertAccountEarnings(database, documentId, observedAt, parsed);
      default:
        throw new Error(`unknown_normalizer:${source.normalizer}`);
    }
  }
}

export async function fetchSource(source, config, fetchImpl = globalThis.fetch) {
  const observedAt = new Date();
  const headers = { Accept: "application/json", "User-Agent": "vast-observatory/1" };
  if (source.authenticated) headers.Authorization = `Bearer ${config.apiKey}`;
  const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs);
  const signal = config.signal ? AbortSignal.any([timeoutSignal, config.signal]) : timeoutSignal;
  const response = await fetchImpl(source.url, { method: "GET", headers, signal });
  const body = Buffer.from(await response.arrayBuffer());
  const parsedTimestamp = sourceTimestampFromBody(body);
  return {
    endpoint: source.url,
    operation: "GET",
    observedAt,
    sourceTimestamp: parsedTimestamp,
    sourceDeclaredCount: sourceDeclaredCountFromBody(body),
    requestMethod: "GET",
    requestMetadata: { authenticated: Boolean(source.authenticated), transport_decoded: true },
    requestBody: null,
    status: response.status,
    headers: [...response.headers.entries()].map(([name, value]) => ({ name, value })),
    contentType: response.headers.get("content-type") || "",
    body
  };
}

export async function runCliSource(source, config, execFileImpl = execFileAsync, now = () => new Date()) {
  const observedAt = now();
  const { stdout, stderr } = await execFileImpl(config.vastCliPath, source.args, {
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
    timeout: config.cliTimeoutMs,
    signal: config.signal,
    env: { ...process.env, HOME: config.home, VAST_API_KEY: config.apiKey }
  });
  const body = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || "");
  return {
    endpoint: config.vastCliPath,
    operation: source.args.slice(0, 2).join(" "),
    observedAt,
    sourceTimestamp: null,
    sourceDeclaredCount: null,
    requestMethod: "CLI",
    requestMetadata: { argv: source.args, stderr_present: Boolean(Buffer.from(stderr || "").length) },
    requestBody: null,
    status: 0,
    headers: [],
    contentType: "application/json",
    body
  };
}

export function sourceContractSummary(now = new Date(), version = SOURCE_CONTRACT_VERSION) {
  return {
    version,
    http: HTTP_SOURCES.map(({ name, url, authenticated }) => ({ name, url, authenticated: Boolean(authenticated) })),
    account_cli: accountSourceContract(now).map(({ name, args }) => ({ name, argv: args.slice(0, 2) }))
  };
}

export function normalizeOffer(row) {
  return [
    text(row.id ?? row.offer_id), int(row.machine_id), int(row.host_id), text(row.bundle_id), text(row.ask_contract_id),
    text(row.gpu_name), int(row.num_gpus), numeric(row.gpu_frac), bool(row.rentable), bool(row.rented), text(row.verification),
    int(row.hosting_type), numeric(row.dph_total ?? row.dph_total_adj), numeric(row.dph_base), numeric(row.min_bid), timestamp(row.end_date), row
  ];
}

export function normalizeAccountMachine(row) {
  return [
    int(row.machine_id ?? row.id), text(row.gpu_name), int(row.num_gpus), text(row.gpu_occupancy), int(row.current_rentals_running),
    int(row.current_rentals_on_demand), int(row.current_rentals_reserved), int(row.current_rentals_resident),
    int(row.current_rentals_running_on_demand), int(row.current_rentals_running_reserved), numeric(row.listed_gpu_cost),
    numeric(row.min_bid_price ?? row.min_bid), numeric(row.bid_gpu_cost), numeric(row.earn_day), timestamp(row.end_date), row
  ];
}

export function normalizeAccountInstance(row) {
  return [
    text(row.id ?? row.contract_id), int(row.machine_id), text(row.status ?? row.actual_status), text(row.actual_status), text(row.intended_status),
    text(row.gpu_name), int(row.num_gpus), numeric(row.dph_total), timestamp(row.start_date ?? row.created_at), timestamp(row.end_date),
    rentalType(row), text(row.label), row
  ];
}

async function insertOfferObservations(pool, documentId, sourceName, observedAt, rows) {
  return batchInsert(pool,
    `INSERT INTO market.offer_observation
      (document_id,row_ordinal,source_name,observed_at,source_offer_id,machine_id,host_id,bundle_id,ask_contract_id,gpu_name,num_gpus,gpu_frac,rentable,rented,verification,hosting_type,dph_total,dph_base,min_bid,end_date,payload) VALUES`,
    rows.map((row, index) => [documentId, index + 1, sourceName, observedAt, ...normalizeOffer(row)]), 21);
}

async function insertMachineObservations(pool, documentId, sourceName, observedAt, rows) {
  return batchInsert(pool,
    `INSERT INTO market.machine_observation
      (document_id,row_ordinal,source_name,observed_at,machine_id,host_id,gpu_name,num_gpus,min_chunk,rentable,rented,verification,hosting_type,dph_total,min_bid,end_date,payload) VALUES`,
    rows.map((row, index) => [documentId, index + 1, sourceName, observedAt, int(row.machine_id), int(row.host_id), text(row.gpu_name), int(row.num_gpus), int(row.min_chunk), bool(row.rentable), bool(row.rented), text(row.verification), int(row.hosting_type), numeric(row.dph_total ?? row.dph_total_adj), numeric(row.min_bid), timestamp(row.end_date), row]), 17);
}

async function insertHostObservations(pool, documentId, sourceName, observedAt, rows) {
  return batchInsert(pool,
    `INSERT INTO market.host_observation
      (document_id,row_ordinal,source_name,observed_at,host_id,machine_ids,gpus,datacenter,location,payload) VALUES`,
    rows.map((row, index) => [documentId, index + 1, sourceName, observedAt, int(row.host_id), JSON.stringify(row.machine_ids ?? []), JSON.stringify(row.gpus ?? []), bool(row.datacenter), text(row.location), row]), 10);
}

async function insertGpuRollups(pool, documentId, sourceName, observedAt, rows) {
  return batchInsert(pool,
    `INSERT INTO market.gpu_rollup_observation
      (document_id,row_ordinal,source_name,observed_at,gpu_name,payload) VALUES`,
    rows.map((row, index) => [documentId, index + 1, sourceName, observedAt, text(row.name ?? row.gpu_name ?? row.key), row.value ?? row]), 6);
}

async function insertGpuCatalog(pool, documentId, sourceName, observedAt, rows) {
  return batchInsert(pool,
    `INSERT INTO market.gpu_catalog_observation
      (document_id,row_ordinal,source_name,observed_at,gpu_name) VALUES`,
    rows.map((name, index) => [documentId, index + 1, sourceName, observedAt, text(name)]), 5);
}

async function insertAccountMachines(pool, documentId, observedAt, rows) {
  return batchInsert(pool,
    `INSERT INTO host.machine_observation
      (document_id,row_ordinal,observed_at,machine_id,gpu_name,num_gpus,gpu_occupancy,current_rentals_running,current_rentals_on_demand,current_rentals_reserved,current_rentals_resident,current_rentals_running_on_demand,current_rentals_running_reserved,listed_gpu_cost,min_bid_price,bid_gpu_cost,earn_day,end_date,payload) VALUES`,
    rows.map((row, index) => [documentId, index + 1, observedAt, ...normalizeAccountMachine(row)]), 19);
}

async function insertAccountInstances(pool, documentId, observedAt, rows) {
  return batchInsert(pool,
    `INSERT INTO host.instance_observation
      (document_id,row_ordinal,observed_at,contract_id,machine_id,status,actual_status,intended_status,gpu_name,num_gpus,dph_total,start_date,end_date,rental_type,label,payload) VALUES`,
    rows.map((row, index) => [documentId, index + 1, observedAt, ...normalizeAccountInstance(row)]), 16);
}

async function insertAccountEarnings(pool, documentId, observedAt, payload) {
  const rows = [];
  for (const [scope, entries] of [["day", payload?.per_day], ["machine", payload?.per_machine]]) {
    for (const entry of Array.isArray(entries) ? entries : []) rows.push({ scope, entry });
  }
  if (payload?.summary && typeof payload.summary === "object") rows.push({ scope: "summary", entry: payload.summary });
  if (payload?.current && typeof payload.current === "object") rows.push({ scope: "current", entry: payload.current });
  return batchInsert(pool,
    `INSERT INTO host.earnings_observation
      (document_id,row_ordinal,observed_at,scope,day,machine_id,gpu_earn,storage_earn,bandwidth_up_earn,bandwidth_down_earn,sla_earn,total,payload) VALUES`,
    rows.map(({ scope, entry }, index) => [documentId, index + 1, observedAt, scope, date(entry.day), int(entry.machine_id), numeric(entry.gpu_earn ?? entry.total_gpu), numeric(entry.sto_earn ?? entry.total_stor), numeric(entry.bwu_earn ?? entry.total_bwu), numeric(entry.bwd_earn ?? entry.total_bwd), numeric(entry.sla_earn ?? entry.total_sla), earningsTotal(entry), entry]), 13);
}

async function batchInsert(pool, prefix, rows, columnCount, batchSize = 400) {
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    const tuples = batch.map((row, rowIndex) => {
      if (row.length !== columnCount) throw new Error(`column_count_mismatch:${row.length}:${columnCount}`);
      values.push(...row.map((value) => isPlainObject(value) || Array.isArray(value) ? JSON.stringify(value) : value));
      const start = rowIndex * columnCount;
      return `(${Array.from({ length: columnCount }, (_, index) => `$${start + index + 1}`).join(",")})`;
    });
    if (tuples.length) {
      const result = await pool.query(`${prefix} ${tuples.join(",")}`, values);
      inserted += result.rowCount ?? batch.length;
    }
  }
  return inserted;
}

function gpuRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.models)) return parsed.models;
  if (parsed?.gpus && typeof parsed.gpus === "object") return Object.entries(parsed.gpus).map(([key, value]) => ({ key, value }));
  throw new Error("unexpected_gpu_rollup_shape");
}

function arrayFrom(parsed, key) {
  const rows = parsed?.[key];
  if (!Array.isArray(rows)) throw new Error(`unexpected_${key}_shape`);
  return rows;
}

function parseJson(body, sourceName) {
  try { return JSON.parse(Buffer.from(body).toString("utf8")); }
  catch (error) { throw new Error(`${sourceName}_invalid_json:${safeError(error)}`); }
}

function sourceTimestampFromBody(body) {
  try {
    const timestampValue = JSON.parse(Buffer.from(body).toString("utf8"))?.timestamp;
    return timestamp(timestampValue);
  } catch { return null; }
}

function sourceDeclaredCountFromBody(body) {
  try {
    const count = Number(JSON.parse(Buffer.from(body).toString("utf8"))?.count);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch { return null; }
}

function alignedSlot(dateValue, intervalMs) {
  return new Date(Math.floor(dateValue.getTime() / intervalMs) * intervalMs);
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeError(error) { return error instanceof Error ? error.message : String(error); }
function text(value) { return value == null || value === "" ? null : String(value); }
function int(value) { if (missing(value)) return null; const parsed = Number(value); return Number.isInteger(parsed) ? parsed : null; }
function numeric(value) { if (missing(value)) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function bool(value) { if (value === true || value === 1 || value === "true" || value === "1") return true; if (value === false || value === 0 || value === "false" || value === "0") return false; return null; }
function timestamp(value) { if (value == null || value === "") return null; const parsed = typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value)) ? new Date(Number(value) * (Number(value) < 10_000_000_000 ? 1000 : 1)) : new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(); }
export function normalizeEarningsDate(value) { return normalizeEarningsDay(value)?.slice(0, 10) ?? null; }
function date(value) { return normalizeEarningsDate(value); }
function earningsTotal(row) {
  const explicit = numeric(row.total ?? row.total_earn ?? row.earnings);
  if (explicit !== null) return explicit;
  const components = [row.gpu_earn ?? row.total_gpu, row.sto_earn ?? row.total_stor, row.bwu_earn ?? row.total_bwu, row.bwd_earn ?? row.total_bwd, row.sla_earn ?? row.total_sla]
    .map(numeric)
    .filter((value) => value !== null);
  return components.length ? components.reduce((sum, value) => sum + value, 0) : null;
}
function missing(value) { return value == null || (typeof value === "string" && value.trim() === ""); }
function rentalType(row) { if (bool(row.is_bid) === true || String(row.type || row.rental_type || "").toLowerCase() === "bid") return "bid"; if (bool(row.is_reserved) === true || String(row.type || row.rental_type || "").toLowerCase() === "reserved") return "reserved"; if (["on-demand", "ondemand", "on_demand"].includes(String(row.type || row.rental_type || "").toLowerCase())) return "on_demand"; return "unknown"; }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Date); }

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { offerSearchBody, queryMatrix, gpuCatalogNames, RawMarketArchive, requestExact } from "../src/plugins/raw-market/index.js";
import { startPluginRuntime } from "../src/plugins/runtime.js";
import { validateRawArchiveSettings } from "../src/config.js";

test("raw market query matrix only contains named GPU membership, limit and id ordering", () => {
  const matrix = queryMatrix(["RTX PRO 6000 WS", "RTX PRO 6000 S", "RTX PRO 4000", "RTX 5090"]);
  assert.equal(matrix.length, 8);
  const dynamic = matrix.filter((entry) => entry.group === "other-rtx-pro");
  assert.deepEqual(dynamic[0].names, ["RTX PRO 4000"]);
  const body = JSON.parse(offerSearchBody(dynamic[0].names, dynamic[0].direction));
  assert.deepEqual(Object.keys(body).sort(), ["gpu_name", "limit", "order"]);
  assert.equal(body.limit, 10000);
  assert.deepEqual(body.order, [["id", "asc"]]);
  assert.equal("num_gpus" in body, false);
});

test("catalog parsing is the only raw response parsing", () => {
  assert.deepEqual(gpuCatalogNames(Buffer.from('{"gpu_names":["RTX PRO 4000"]}')), ["RTX PRO 4000"]);
  assert.throws(() => gpuCatalogNames(Buffer.from('{"offers":[]}')), /unexpected_gpu_catalog_shape/);
});

test("catalog failure still leaves the six static raw-market requests available", () => {
  const fallback = queryMatrix(null);
  assert.deepEqual(fallback.map(({ group, direction }) => [group, direction]), [
    ["rtx-pro-6000-ws", "asc"], ["rtx-pro-6000-ws", "desc"],
    ["rtx-pro-6000-s", "asc"], ["rtx-pro-6000-s", "desc"],
    ["named-high-end", "asc"], ["named-high-end", "desc"]
  ]);
});

test("plugin runtime isolates optional extension startup and health errors", async () => {
  const runtime = await startPluginRuntime({ plugins: [{ name: "broken", async start() { throw new Error("db unavailable"); } }], logger: { error() {} } });
  assert.deepEqual(await runtime.getHealth(), { broken: { ok: false, status: "degraded", error: "db unavailable" } });
});

test("requestExact preserves duplicate ordered headers and byte-exact non-JSON bodies", async () => {
  const request = (_url, _options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {
      const response = new EventEmitter();
      response.statusCode = 503;
      response.rawHeaders = ["X-Trace", "first", "X-Trace", "second", "Content-Type", "text/plain"];
      callback(response);
      response.emit("data", Buffer.from([0, 255, 10]));
      response.emit("end");
      response.emit("close");
    };
    return req;
  };
  const result = await requestExact("https://example.invalid/", { apiKey: "read-only", request });
  assert.equal(result.status, 503);
  assert.deepEqual(result.headers, ["X-Trace", "first", "X-Trace", "second", "Content-Type", "text/plain"]);
  assert.deepEqual(result.body, Buffer.from([0, 255, 10]));
});

test("requestExact rejects an aborted response rather than wedging the scheduler", async () => {
  const request = (_url, _options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => { const response = new EventEmitter(); callback(response); response.emit("aborted"); };
    return req;
  };
  await assert.rejects(requestExact("https://example.invalid/", { apiKey: "read-only", request }), /response_aborted/);
});

test("requestExact has an absolute deadline even when no response event occurs", async () => {
  const request = () => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {};
    req.destroy = (error) => req.emit("error", error);
    return req;
  };
  await assert.rejects(requestExact("https://example.invalid/", { apiKey: "read-only", timeoutMs: 5, request }), /request_deadline_5ms/);
});

test("raw archive only accepts the fixed five-minute cadence and safe request timeout", () => {
  assert.deepEqual(validateRawArchiveSettings({ rawArchiveEnabled: true, rawArchivePollIntervalMs: 0, rawArchiveRequestTimeoutMs: 0 }), ["RAW_ARCHIVE_POLL_INTERVAL_MS must be exactly 300000", "RAW_ARCHIVE_REQUEST_TIMEOUT_MS must be a positive timer-safe integer"]);
  assert.deepEqual(validateRawArchiveSettings({ rawArchiveEnabled: true, rawArchivePollIntervalMs: 300000, rawArchiveRequestTimeoutMs: 60000 }), []);
});

test("failed lifecycle plugins are excluded while hook-only plugins remain active", async () => {
  const healthy = { name: "hook-only" };
  const broken = { name: "broken", async start() { throw new Error("unavailable"); } };
  const runtime = await startPluginRuntime({ plugins: [healthy, broken], logger: { error() {} } });
  assert.deepEqual(runtime.activePlugins(), [healthy]);
  assert.equal((await runtime.getHealth())["hook-only"].status, "ok");
});

test("raw archive poll persists byte-exact catalog and eight directional documents", async () => {
  const queries = [];
  const pool = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.startsWith("INSERT INTO raw_collection_run")) return { rows: [{ id: 7 }] };
      return { rows: [] };
    }
  };
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.rawHeaders = ["X-Duplicate", "one", "X-Duplicate", "two", "Content-Type", "application/json"];
      callback(response);
      const body = url.pathname.includes("gpu_names")
        ? Buffer.from('{"gpu_names":["RTX PRO 6000 WS","RTX PRO 6000 S","RTX PRO 4000"]}')
        : Buffer.from([0, 255, 10]);
      response.emit("data", body);
      response.emit("end");
    };
    return req;
  };
  const archive = new RawMarketArchive({
    rawArchiveEnabled: true,
    rawArchivePollIntervalMs: 300000,
    rawArchiveRequestTimeoutMs: 60000,
    rawArchiveGpuCatalogUrl: "https://example.invalid/gpu_names/unique/",
    rawArchiveOffersUrl: "https://example.invalid/bundles/",
    vastApiKeyPath: "/unused"
  }, { request });
  archive.pool = pool;
  const originalReadFile = await import("node:fs/promises");
  // poll reads its key lazily; supply a temporary valid key file instead.
  const { mkdtemp, writeFile } = originalReadFile;
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const keyDirectory = await mkdtemp(join(tmpdir(), "vast-monitor-raw-test-"));
  const keyPath = join(keyDirectory, "key");
  await writeFile(keyPath, "read-only-key\n");
  archive.config.vastApiKeyPath = keyPath;
  await archive.poll();
  const documents = queries.filter(({ sql }) => sql.startsWith("INSERT INTO raw_response_document"));
  assert.equal(documents.length, 9);
  assert.deepEqual(documents[0].values[12], Buffer.from('{"gpu_names":["RTX PRO 6000 WS","RTX PRO 6000 S","RTX PRO 4000"]}'));
  assert.deepEqual(JSON.parse(documents[1].values[8]), [
    { name: "X-Duplicate", value: "one" }, { name: "X-Duplicate", value: "two" }, { name: "Content-Type", value: "application/json" }
  ]);
  assert.deepEqual(documents[1].values[12], Buffer.from([0, 255, 10]));
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  HTTP_SOURCES,
  ObservatoryCollector,
  accountSourceContract,
  fetchSource,
  normalizeAccountInstance,
  normalizeAccountMachine,
  normalizeOffer,
  runCliSource,
  sourceContractSummary
} from "../src/observatory/collector.js";

test("observatory source contract contains the complete public feeds and read-only account commands", () => {
  assert.deepEqual(HTTP_SOURCES.map(({ name }) => name), [
    "vast-gpu-catalog",
    "vast-gpu-metrics-current",
    "500farm-machines",
    "500farm-offers",
    "500farm-hosts",
    "500farm-gpu-stats",
    "500farm-gpu-stats-v2"
  ]);
  const account = accountSourceContract(new Date("2026-08-29T12:00:00Z"));
  assert.deepEqual(account.map(({ args }) => args.slice(0, 2)), [
    ["show", "machines"],
    ["show", "instances"],
    ["show", "earnings"]
  ]);
  const serialized = JSON.stringify(sourceContractSummary(new Date("2026-08-29T12:00:00Z")));
  for (const forbidden of ["create", "destroy", "start", "stop", "list machine", "unlist", "change bid", "set min-bid"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("HTTP sources use GET and authenticate only official Vast endpoints", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response('{"gpu_names":["RTX 5090"]}', { status: 200, headers: { "content-type": "application/json" } });
  };
  await fetchSource(HTTP_SOURCES[0], { apiKey: "not-logged", requestTimeoutMs: 1000 }, fetchImpl);
  await fetchSource(HTTP_SOURCES[2], { apiKey: "not-logged", requestTimeoutMs: 1000 }, fetchImpl);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer not-logged");
  assert.equal("Authorization" in calls[1].options.headers, false);
});

test("CLI source execution passes an argv array without a shell", async () => {
  const calls = [];
  const execFileImpl = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: Buffer.from("[]"), stderr: Buffer.alloc(0) };
  };
  const source = accountSourceContract(new Date("2026-08-29T12:00:00Z"))[1];
  const result = await runCliSource(source, { vastCliPath: "/usr/local/bin/vast", cliTimeoutMs: 1000, home: "/home/node" }, execFileImpl, () => new Date("2026-08-29T12:00:00Z"));
  assert.deepEqual(calls[0].args, ["show", "instances", "--raw"]);
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(result.requestMetadata.argv.join(" "), "show instances --raw");
});

test("normalizers preserve source payloads while exposing query fields", () => {
  const offer = { id: 44, machine_id: 9, host_id: 7, gpu_name: "RTX 5090", num_gpus: 2, dph_total_adj: 1.5, min_bid: 0.4 };
  const normalizedOffer = normalizeOffer(offer);
  assert.equal(normalizedOffer[0], "44");
  assert.equal(normalizedOffer[1], 9);
  assert.equal(normalizedOffer[12], 1.5);
  assert.equal(normalizedOffer.at(-1), offer);

  const machine = { machine_id: 9, current_rentals_running: 1, current_rentals_on_demand: 1, listed_gpu_cost: 0.65 };
  const normalizedMachine = normalizeAccountMachine(machine);
  assert.equal(normalizedMachine[0], 9);
  assert.equal(normalizedMachine[4], 1);
  assert.equal(normalizedMachine[10], 0.65);
  assert.equal(normalizedMachine.at(-1), machine);

  const instance = { id: 123, machine_id: 9, actual_status: "running", is_bid: true };
  const normalizedInstance = normalizeAccountInstance(instance);
  assert.equal(normalizedInstance[0], "123");
  assert.equal(normalizedInstance[1], 9);
  assert.equal(normalizedInstance[10], "bid");
  assert.equal(normalizedInstance.at(-1), instance);
});

test("a complete collection stores every raw source and normalized surface", async () => {
  const queries = [];
  let documentId = 10;
  const pool = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.startsWith("INSERT INTO ops.collection_run")) return { rows: [{ id: 1 }], rowCount: 1 };
      if (sql.startsWith("INSERT INTO raw.source_document")) return { rows: [{ id: documentId++ }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }
  };
  const fetchImpl = async (url) => {
    let body;
    if (url.includes("gpu_names")) body = { gpu_names: ["RTX 5090"] };
    else if (url.includes("metrics/gpu")) body = { gpus: { "RTX 5090": { available: 2 } } };
    else if (url.endsWith("/machines")) body = { timestamp: "2026-08-29T12:00:00Z", offers: [{ machine_id: 1, gpu_name: "RTX 5090" }] };
    else if (url.endsWith("/offers")) body = { timestamp: "2026-08-29T12:00:00Z", offers: [{ id: 2, machine_id: 1, gpu_name: "RTX 5090" }] };
    else if (url.endsWith("/hosts")) body = { timestamp: "2026-08-29T12:00:00Z", hosts: [{ host_id: 3, machine_ids: [1], gpus: ["RTX 5090"] }] };
    else body = { timestamp: "2026-08-29T12:00:00Z", models: [{ name: "RTX 5090" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const cliCalls = [];
  const execFileImpl = async (_file, args) => {
    cliCalls.push(args);
    if (args[1] === "machines") return { stdout: Buffer.from('{"machines":[{"machine_id":1,"current_rentals_running":1}]}'), stderr: Buffer.alloc(0) };
    if (args[1] === "instances") return { stdout: Buffer.from('[{"id":4,"machine_id":1,"actual_status":"running"}]'), stderr: Buffer.alloc(0) };
    return { stdout: Buffer.from('{"per_day":[{"day":"2026-08-29","gpu_earn":2.5}]}'), stderr: Buffer.alloc(0) };
  };
  const fixedTimes = [new Date("2026-08-29T12:01:00Z"), new Date("2026-08-29T12:01:02Z")];
  const collector = new ObservatoryCollector({
    collectorName: "test", contractVersion: "test-v1", collectorRevision: "abc", imageDigest: "sha256:test",
    pollIntervalMs: 300000, requestTimeoutMs: 1000, cliTimeoutMs: 1000,
    vastCliPath: "/usr/local/bin/vast", home: "/home/node", apiKey: "not-logged"
  }, { pool, fetchImpl, execFileImpl, now: () => fixedTimes.shift() || new Date("2026-08-29T12:01:02Z"), logger: { error() {} } });
  const result = await collector.collect();
  assert.equal(result.status, "complete");
  assert.equal(result.documents, 10);
  assert.deepEqual(cliCalls.map((args) => args.slice(0, 2)), [["show", "machines"], ["show", "instances"], ["show", "earnings"]]);
  for (const table of ["market.offer_observation", "market.machine_observation", "market.host_observation", "market.gpu_rollup_observation", "market.gpu_catalog_observation", "host.machine_observation", "host.instance_observation", "host.earnings_observation"]) {
    assert.ok(queries.some(({ sql }) => sql.includes(`INSERT INTO ${table}`)), table);
  }
});

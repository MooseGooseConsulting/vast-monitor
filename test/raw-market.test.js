import assert from "node:assert/strict";
import test from "node:test";
import { offerSearchBody, queryMatrix, gpuCatalogNames } from "../src/plugins/raw-market/index.js";
import { startPluginRuntime } from "../src/plugins/runtime.js";

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

test("plugin runtime isolates optional extension startup and health errors", async () => {
  const runtime = await startPluginRuntime({ plugins: [{ name: "broken", async start() { throw new Error("db unavailable"); } }], logger: { error() {} } });
  assert.deepEqual(await runtime.getHealth(), { broken: { ok: false, status: "degraded", error: "db unavailable" } });
});

import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";

const connectionString = process.env.OBSERVATORY_TEST_DATABASE_URL;

test("PostgreSQL current-state views handle replacement, gaps, repricing, and rental evidence", { skip: !connectionString }, async () => {
  const client = new Client({ connectionString, application_name: "observatory-integration-test", connectionTimeoutMillis: 5000 });
  await client.connect();
  await client.query("BEGIN");
  try {
    const run1 = await insertRun(client, "2040-01-01T00:00:00Z", "complete");
    const machine1 = await insertDocument(client, run1, "vast-account-machines", "2040-01-01T00:00:01Z");
    await insertMachine(client, machine1, "2040-01-01T00:00:01Z", 1, 0.75);
    const instances1 = await insertDocument(client, run1, "vast-account-instances", "2040-01-01T00:00:02Z");
    await insertInstance(client, instances1, "contract-a", "bid", "2040-01-01T00:00:02Z");
    assert.deepEqual(await currentClassification(client), { party_class: "self", self_instance_count: 1, self_rental_types: ["bid"], host_count_below_self: false, listed_gpu_cost: "0.75" });

    const run2 = await insertRun(client, "2040-01-01T00:05:00Z", "complete");
    const instances2 = await insertDocument(client, run2, "vast-account-instances", "2040-01-01T00:05:02Z");
    await insertInstance(client, instances2, "contract-b", "on_demand", "2040-01-01T00:05:02Z");
    assert.deepEqual((await client.query("SELECT contract_id FROM derived.current_account_instance")).rows.map((row) => row.contract_id), ["contract-b"]);
    assert.deepEqual(await currentClassification(client), { party_class: "self", self_instance_count: 1, self_rental_types: ["on_demand"], host_count_below_self: false, listed_gpu_cost: "0.75" });

    const run3 = await insertRun(client, "2040-01-01T00:10:00Z", "complete");
    await insertDocument(client, run3, "vast-account-instances", "2040-01-01T00:10:02Z");
    assert.deepEqual(await currentClassification(client), { party_class: "external", self_instance_count: 0, self_rental_types: [], host_count_below_self: false, listed_gpu_cost: "0.75" });

    const run4 = await insertRun(client, "2040-01-01T00:15:00Z", "complete");
    const machine2 = await insertDocument(client, run4, "vast-account-machines", "2040-01-01T00:15:01Z");
    await insertMachine(client, machine2, "2040-01-01T00:15:01Z", 0, 1.25);
    const instances4 = await insertDocument(client, run4, "vast-account-instances", "2040-01-01T00:15:02Z");
    await insertInstance(client, instances4, "contract-c", "unknown", "2040-01-01T00:15:02Z");
    assert.deepEqual(await currentClassification(client), { party_class: "self", self_instance_count: 1, self_rental_types: ["unknown"], host_count_below_self: true, listed_gpu_cost: "1.25" });

    await insertRun(client, "2040-01-01T00:20:00Z", "failed");
    assert.deepEqual((await client.query("SELECT contract_id FROM derived.current_account_instance")).rows.map((row) => row.contract_id), ["contract-c"]);

    const run6 = await insertRun(client, "2040-01-01T00:25:00Z", "complete");
    const machine3 = await insertDocument(client, run6, "vast-account-machines", "2040-01-01T00:25:01Z");
    await insertMachine(client, machine3, "2040-01-01T00:25:01Z", 0, 1.50);
    assert.equal((await currentClassification(client)).listed_gpu_cost, "1.5");

    const earnings = await insertDocument(client, run6, "vast-account-earnings", "2040-01-01T00:25:02Z");
    await client.query(
      `INSERT INTO host.earnings_observation
         (document_id,row_ordinal,observed_at,scope,day,gpu_earn,storage_earn,total,payload)
       VALUES ($1,1,$2,'day','2040-01-01',4.0,0.2,4.2,$3)`,
      [earnings, "2040-01-01T00:25:02Z", { gpu_earn: 4.0, sto_earn: 0.2, total: 4.2 }]
    );
    const ledger = await client.query("SELECT gpu_earn,storage_earn,total,payload FROM host.earnings_observation WHERE document_id=$1", [earnings]);
    assert.deepEqual(ledger.rows[0], { gpu_earn: "4.0", storage_earn: "0.2", total: "4.2", payload: { gpu_earn: 4.0, sto_earn: 0.2, total: 4.2 } });
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

async function insertRun(client, pollSlot, status) {
  const result = await client.query(
    `INSERT INTO ops.collection_run
       (collector_name,poll_slot,status,contract_version,collector_revision,source_contract,completed_at)
     VALUES ('integration-test',$1,$2,'test-v1','test-revision','{}',$1)
     RETURNING id`,
    [pollSlot, status]
  );
  return result.rows[0].id;
}

async function insertDocument(client, runId, sourceName, observedAt) {
  const result = await client.query(
    `INSERT INTO raw.source_document
       (run_id,source_name,endpoint,operation,observed_at,request_method,request_metadata,
        response_status,response_headers,response_content_type,response_sha256,response_bytes,response_body)
     VALUES ($1,$2,'test','test',$3,'CLI','{}',0,'[]','application/json',$4,2,$5)
     RETURNING id`,
    [runId, sourceName, observedAt, "0".repeat(64), Buffer.from("{}")]
  );
  return result.rows[0].id;
}

async function insertMachine(client, documentId, observedAt, running, listedPrice) {
  await client.query(
    `INSERT INTO host.machine_observation
       (document_id,row_ordinal,observed_at,machine_id,current_rentals_running,listed_gpu_cost,payload)
     VALUES ($1,1,$2,147734,$3,$4,'{}')`,
    [documentId, observedAt, running, listedPrice]
  );
}

async function insertInstance(client, documentId, contractId, rentalType, observedAt) {
  await client.query(
    `INSERT INTO host.instance_observation
       (document_id,row_ordinal,observed_at,contract_id,machine_id,status,actual_status,rental_type,payload)
     VALUES ($1,1,$2,$3,147734,'running','running',$4,'{}')`,
    [documentId, observedAt, contractId, rentalType]
  );
}

async function currentClassification(client) {
  const result = await client.query(
    `SELECT party_class,self_instance_count,self_rental_types,host_count_below_self,listed_gpu_cost
     FROM derived.current_rental_classification WHERE machine_id=147734`
  );
  return result.rows[0];
}

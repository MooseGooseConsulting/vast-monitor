CREATE SCHEMA IF NOT EXISTS raw AUTHORIZATION vast_observatory_owner;
CREATE SCHEMA IF NOT EXISTS market AUTHORIZATION vast_observatory_owner;
CREATE SCHEMA IF NOT EXISTS host AUTHORIZATION vast_observatory_owner;
CREATE SCHEMA IF NOT EXISTS derived AUTHORIZATION vast_observatory_owner;

CREATE TABLE ops.collection_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collector_name text NOT NULL,
  poll_slot timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','complete','failed')),
  contract_version text NOT NULL,
  collector_revision text NOT NULL,
  image_digest text,
  source_contract jsonb NOT NULL,
  poll_duration_ms integer,
  document_count integer NOT NULL DEFAULT 0,
  response_bytes bigint NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  error_message text,
  UNIQUE (collector_name, poll_slot)
);
CREATE TABLE ops.source_failure (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES ops.collection_run(id),
  source_name text NOT NULL,
  observed_at timestamptz NOT NULL,
  error_code text NOT NULL,
  error_message text NOT NULL
);
CREATE TABLE raw.source_document (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES ops.collection_run(id),
  source_name text NOT NULL,
  endpoint text NOT NULL,
  operation text NOT NULL,
  observed_at timestamptz NOT NULL,
  source_timestamp timestamptz,
  source_declared_count bigint CHECK (source_declared_count IS NULL OR source_declared_count >= 0),
  request_method text NOT NULL CHECK (request_method IN ('GET','POST','CLI')),
  request_metadata jsonb NOT NULL,
  request_body bytea,
  response_status integer NOT NULL,
  response_headers jsonb NOT NULL,
  response_content_type text NOT NULL,
  response_sha256 text NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  response_bytes bigint NOT NULL CHECK (response_bytes >= 0),
  response_body bytea NOT NULL,
  UNIQUE (run_id, source_name)
);

CREATE TABLE market.offer_observation (
  document_id bigint NOT NULL REFERENCES raw.source_document(id), row_ordinal integer NOT NULL,
  source_name text NOT NULL, observed_at timestamptz NOT NULL, source_offer_id text,
  machine_id bigint, host_id bigint, bundle_id text, ask_contract_id text, gpu_name text,
  num_gpus integer, gpu_frac numeric, rentable boolean, rented boolean, verification text,
  hosting_type integer, dph_total numeric, dph_base numeric, min_bid numeric, end_date timestamptz,
  payload jsonb NOT NULL, PRIMARY KEY (document_id,row_ordinal)
);
CREATE TABLE market.machine_observation (
  document_id bigint NOT NULL REFERENCES raw.source_document(id), row_ordinal integer NOT NULL,
  source_name text NOT NULL, observed_at timestamptz NOT NULL, machine_id bigint, host_id bigint,
  gpu_name text, num_gpus integer, min_chunk integer, rentable boolean, rented boolean,
  verification text, hosting_type integer, dph_total numeric, min_bid numeric, end_date timestamptz,
  payload jsonb NOT NULL, PRIMARY KEY (document_id,row_ordinal)
);
CREATE TABLE market.host_observation (
  document_id bigint NOT NULL REFERENCES raw.source_document(id), row_ordinal integer NOT NULL,
  source_name text NOT NULL, observed_at timestamptz NOT NULL, host_id bigint,
  machine_ids jsonb NOT NULL, gpus jsonb NOT NULL, datacenter boolean, location text,
  payload jsonb NOT NULL, PRIMARY KEY (document_id,row_ordinal)
);
CREATE TABLE market.gpu_rollup_observation (
  document_id bigint NOT NULL REFERENCES raw.source_document(id), row_ordinal integer NOT NULL,
  source_name text NOT NULL, observed_at timestamptz NOT NULL, gpu_name text, payload jsonb NOT NULL,
  PRIMARY KEY (document_id,row_ordinal)
);
CREATE TABLE market.gpu_catalog_observation (
  document_id bigint NOT NULL REFERENCES raw.source_document(id), row_ordinal integer NOT NULL,
  source_name text NOT NULL, observed_at timestamptz NOT NULL, gpu_name text NOT NULL,
  PRIMARY KEY (document_id,row_ordinal)
);

CREATE TABLE host.machine_observation (
  document_id bigint NOT NULL REFERENCES raw.source_document(id), row_ordinal integer NOT NULL,
  observed_at timestamptz NOT NULL, machine_id bigint, gpu_name text, num_gpus integer,
  gpu_occupancy text, current_rentals_running integer, current_rentals_on_demand integer,
  current_rentals_reserved integer, current_rentals_resident integer,
  current_rentals_running_on_demand integer, current_rentals_running_reserved integer,
  listed_gpu_cost numeric, min_bid_price numeric, bid_gpu_cost numeric, earn_day numeric,
  end_date timestamptz, payload jsonb NOT NULL, PRIMARY KEY (document_id,row_ordinal)
);
CREATE TABLE host.instance_observation (
  document_id bigint NOT NULL REFERENCES raw.source_document(id), row_ordinal integer NOT NULL,
  observed_at timestamptz NOT NULL, contract_id text, machine_id bigint, status text,
  actual_status text, intended_status text, gpu_name text, num_gpus integer, dph_total numeric,
  start_date timestamptz, end_date timestamptz, rental_type text NOT NULL CHECK (rental_type IN ('bid','on_demand','reserved','unknown')),
  label text, payload jsonb NOT NULL, PRIMARY KEY (document_id,row_ordinal)
);
CREATE TABLE host.earnings_observation (
  document_id bigint NOT NULL REFERENCES raw.source_document(id), row_ordinal integer NOT NULL,
  observed_at timestamptz NOT NULL, scope text NOT NULL CHECK (scope IN ('day','machine','summary','current')),
  day date, machine_id bigint, gpu_earn numeric, storage_earn numeric, bandwidth_up_earn numeric,
  bandwidth_down_earn numeric, sla_earn numeric, total numeric, payload jsonb NOT NULL,
  PRIMARY KEY (document_id,row_ordinal)
);

CREATE INDEX offer_observation_gpu_time_idx ON market.offer_observation(gpu_name,observed_at DESC);
CREATE INDEX offer_observation_machine_time_idx ON market.offer_observation(machine_id,observed_at DESC);
CREATE INDEX machine_observation_machine_time_idx ON market.machine_observation(machine_id,observed_at DESC);
CREATE INDEX host_machine_observation_machine_time_idx ON host.machine_observation(machine_id,observed_at DESC);
CREATE INDEX host_instance_observation_contract_time_idx ON host.instance_observation(contract_id,observed_at DESC);
CREATE INDEX earnings_observation_day_idx ON host.earnings_observation(day,observed_at DESC);

CREATE VIEW derived.current_host_machine AS
SELECT DISTINCT ON (machine_id) * FROM host.machine_observation
WHERE machine_id IS NOT NULL ORDER BY machine_id, observed_at DESC, document_id DESC;
CREATE VIEW derived.current_account_instance AS
SELECT DISTINCT ON (contract_id) * FROM host.instance_observation
WHERE contract_id IS NOT NULL ORDER BY contract_id, observed_at DESC, document_id DESC;
CREATE VIEW derived.current_rental_classification AS
WITH active_self AS (
  SELECT machine_id, count(*)::integer AS self_instance_count,
         array_agg(DISTINCT rental_type ORDER BY rental_type) AS self_rental_types
  FROM derived.current_account_instance
  WHERE machine_id IS NOT NULL AND coalesce(actual_status,status,'') IN ('running','loading','created')
  GROUP BY machine_id
)
SELECT m.machine_id, m.observed_at, m.current_rentals_running,
       coalesce(s.self_instance_count,0) AS self_instance_count,
       greatest(coalesce(m.current_rentals_running,0)-coalesce(s.self_instance_count,0),0) AS external_rental_count_lower_bound,
       CASE
         WHEN coalesce(m.current_rentals_running,0)=0 THEN 'none'
         WHEN coalesce(s.self_instance_count,0)=0 THEN 'external'
         WHEN coalesce(s.self_instance_count,0)>=coalesce(m.current_rentals_running,0) THEN 'self'
         ELSE 'mixed'
       END AS party_class,
       coalesce(s.self_rental_types,ARRAY[]::text[]) AS self_rental_types,
       m.current_rentals_on_demand, m.current_rentals_reserved, m.current_rentals_resident,
       m.current_rentals_running_on_demand, m.current_rentals_running_reserved,
       m.listed_gpu_cost, m.min_bid_price, m.bid_gpu_cost, m.earn_day
FROM derived.current_host_machine m LEFT JOIN active_self s USING (machine_id);

GRANT USAGE ON SCHEMA ops,raw,market,host,derived TO vast_observatory_writer,vast_observatory_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA ops,raw,market,host TO vast_observatory_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA derived TO vast_observatory_reader;
GRANT SELECT,INSERT ON ops.collection_run,ops.source_failure,raw.source_document,
  market.offer_observation,market.machine_observation,market.host_observation,
  market.gpu_rollup_observation,market.gpu_catalog_observation,
  host.machine_observation,host.instance_observation,host.earnings_observation TO vast_observatory_writer;
GRANT UPDATE (status,completed_at,poll_duration_ms,document_count,response_bytes,error_count,error_message) ON ops.collection_run TO vast_observatory_writer;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ops,raw,market,host TO vast_observatory_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA ops,raw,market,host,derived TO vast_observatory_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE vast_observatory_owner IN SCHEMA ops,raw,market,host,derived GRANT SELECT ON TABLES TO vast_observatory_reader;

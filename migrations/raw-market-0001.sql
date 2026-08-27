-- Append-only raw HTTP archive. This migration never drops or transforms data.
CREATE TABLE IF NOT EXISTS raw_collection_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collector_name text NOT NULL,
  poll_slot timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','complete','failed')),
  poll_duration_ms integer,
  error_code text,
  error_message text,
  UNIQUE (collector_name, poll_slot)
);
CREATE TABLE IF NOT EXISTS raw_response_document (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES raw_collection_run(id),
  observed_at timestamptz NOT NULL,
  request_kind text NOT NULL CHECK (request_kind IN ('gpu-catalog','offer-search')),
  query_group text NOT NULL,
  sort_direction text CHECK (sort_direction IN ('asc','desc')),
  request_metadata jsonb NOT NULL,
  request_body bytea,
  http_status integer NOT NULL,
  response_headers jsonb NOT NULL,
  response_content_type text NOT NULL,
  response_sha256 text NOT NULL,
  response_bytes bigint NOT NULL CHECK (response_bytes >= 0),
  response_body bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_response_document_observed_at_idx ON raw_response_document(observed_at);
CREATE INDEX IF NOT EXISTS raw_response_document_group_observed_at_idx ON raw_response_document(query_group, observed_at);
GRANT USAGE ON SCHEMA public TO vast_market_writer;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON raw_collection_run FROM vast_market_writer;
GRANT SELECT, INSERT, UPDATE ON raw_collection_run TO vast_market_writer;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON raw_response_document FROM vast_market_writer;
GRANT SELECT, INSERT ON raw_response_document TO vast_market_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vast_market_writer;

-- Tighten an installation that received the initial broad writer grants.
REVOKE UPDATE ON raw_collection_run FROM vast_market_writer;
GRANT UPDATE (status, completed_at, poll_duration_ms, error_code, error_message) ON raw_collection_run TO vast_market_writer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM vast_market_writer;
GRANT USAGE, SELECT ON SEQUENCE raw_collection_run_id_seq, raw_response_document_id_seq TO vast_market_writer;

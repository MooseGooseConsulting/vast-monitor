CREATE OR REPLACE VIEW derived.current_host_machine AS
WITH latest_account_run AS (
  SELECT r.id
  FROM ops.collection_run r
  WHERE r.status = 'complete'
    AND EXISTS (SELECT 1 FROM raw.source_document d WHERE d.run_id=r.id AND d.source_name='vast-account-machines')
    AND EXISTS (SELECT 1 FROM raw.source_document d WHERE d.run_id=r.id AND d.source_name='vast-account-instances')
  ORDER BY r.poll_slot DESC, r.id DESC
  LIMIT 1
)
SELECT m.*
FROM latest_account_run r
JOIN raw.source_document d ON d.run_id=r.id AND d.source_name='vast-account-machines'
JOIN host.machine_observation m ON m.document_id=d.id;

CREATE OR REPLACE VIEW derived.current_account_instance AS
WITH latest_account_run AS (
  SELECT r.id
  FROM ops.collection_run r
  WHERE r.status = 'complete'
    AND EXISTS (SELECT 1 FROM raw.source_document d WHERE d.run_id=r.id AND d.source_name='vast-account-machines')
    AND EXISTS (SELECT 1 FROM raw.source_document d WHERE d.run_id=r.id AND d.source_name='vast-account-instances')
  ORDER BY r.poll_slot DESC, r.id DESC
  LIMIT 1
)
SELECT i.*
FROM latest_account_run r
JOIN raw.source_document d ON d.run_id=r.id AND d.source_name='vast-account-instances'
JOIN host.instance_observation i ON i.document_id=d.id;

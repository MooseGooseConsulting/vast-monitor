CREATE OR REPLACE VIEW derived.current_host_machine AS
WITH latest_document AS (
  SELECT id
  FROM raw.source_document
  WHERE source_name = 'vast-account-machines'
  ORDER BY observed_at DESC, id DESC
  LIMIT 1
)
SELECT m.*
FROM host.machine_observation m
JOIN latest_document d ON d.id = m.document_id;

CREATE OR REPLACE VIEW derived.current_account_instance AS
WITH latest_document AS (
  SELECT id
  FROM raw.source_document
  WHERE source_name = 'vast-account-instances'
  ORDER BY observed_at DESC, id DESC
  LIMIT 1
)
SELECT i.*
FROM host.instance_observation i
JOIN latest_document d ON d.id = i.document_id;

CREATE OR REPLACE VIEW derived.current_rental_classification AS
WITH active_self AS (
  SELECT machine_id,
         max(observed_at) AS observed_at,
         count(*)::integer AS self_instance_count,
         array_agg(DISTINCT rental_type ORDER BY rental_type) AS self_rental_types
  FROM derived.current_account_instance
  WHERE machine_id IS NOT NULL
    AND coalesce(actual_status,status,'') IN ('running','loading','created')
  GROUP BY machine_id
)
SELECT coalesce(m.machine_id,s.machine_id) AS machine_id,
       coalesce(m.observed_at,s.observed_at) AS observed_at,
       m.current_rentals_running,
       coalesce(s.self_instance_count,0) AS self_instance_count,
       greatest(coalesce(m.current_rentals_running,0)-coalesce(s.self_instance_count,0),0) AS external_rental_count_lower_bound,
       CASE
         WHEN coalesce(m.current_rentals_running,0)=0 AND coalesce(s.self_instance_count,0)=0 THEN 'none'
         WHEN coalesce(s.self_instance_count,0)=0 THEN 'external'
         WHEN coalesce(m.current_rentals_running,0)<=coalesce(s.self_instance_count,0) THEN 'self'
         ELSE 'mixed'
       END AS party_class,
       coalesce(s.self_rental_types,ARRAY[]::text[]) AS self_rental_types,
       m.current_rentals_on_demand,
       m.current_rentals_reserved,
       m.current_rentals_resident,
       m.current_rentals_running_on_demand,
       m.current_rentals_running_reserved,
       m.listed_gpu_cost,
       m.min_bid_price,
       m.bid_gpu_cost,
       m.earn_day,
       m.machine_id IS NOT NULL AS host_observation_present,
       coalesce(m.current_rentals_running,0)<coalesce(s.self_instance_count,0) AS host_count_below_self
FROM derived.current_host_machine m
FULL OUTER JOIN active_self s USING (machine_id);

-- Run once as the PostgreSQL owner, substituting the password through psql:
-- psql -v writer_password='...' -f scripts/bootstrap-raw-market-roles.sql
CREATE ROLE vast_market_writer LOGIN PASSWORD :'writer_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

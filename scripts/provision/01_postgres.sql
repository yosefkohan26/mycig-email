-- Provisions the Postgres role + database for MyCIG Email (the Zero fork).
-- Idempotent: safe to re-run; existing role/db are left untouched.
--
-- Run as a Postgres superuser (not `appuser`, which lacks CREATEROLE):
--   ssh root@5.78.159.244 sudo -u postgres psql \
--     -v zero_password="'$ZERO_USER_PASSWORD'" \
--     -f 01_postgres.sql
--
-- State produced (must match CF Hyperdrive config):
--   role     zero_user      LOGIN, CREATEDB
--   database zero_email_dev OWNER zero_user

\set ON_ERROR_STOP on

-- Role. psql substitutes :'zero_password' client-side; format(%L) quote-escapes it.
-- Skipped when the role already exists — password unchanged (rotate separately).
SELECT format('CREATE ROLE zero_user LOGIN PASSWORD %L CREATEDB', :'zero_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zero_user')\gexec

-- Database (CREATE DATABASE can't run in a transaction).
SELECT 'CREATE DATABASE zero_email_dev OWNER zero_user'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'zero_email_dev')\gexec

\echo 'Provisioning complete. Verify with: \l zero_email_dev'

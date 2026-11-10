\set ON_ERROR_STOP on
\getenv migration_password MIGRATION_DATABASE_PASSWORD
\getenv app_password APP_DATABASE_PASSWORD

-- Bootstrap connects as the local cluster administrator. Application code and
-- migrations never use this role. \gexec safely quotes passwords/identifiers.
SELECT 'CREATE ROLE may_be_migrator LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'may_be_migrator') \gexec
SELECT 'CREATE ROLE may_be_app LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'may_be_app') \gexec

ALTER ROLE may_be_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE may_be_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
SELECT format('ALTER ROLE may_be_migrator PASSWORD %L', :'migration_password') \gexec
SELECT format('ALTER ROLE may_be_app PASSWORD %L', :'app_password') \gexec

-- Apply to the connected DB: may_be_gay normally, a separate *_test DB in CI.
SELECT format('ALTER DATABASE %I OWNER TO may_be_migrator', current_database()) \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO may_be_app', current_database()) \gexec

ALTER SCHEMA public OWNER TO may_be_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM may_be_app;
GRANT USAGE ON SCHEMA public TO may_be_app;

-- Existing objects and future migrator-owned objects receive only the runtime
-- DML privileges. The migration journal lives outside public and stays private.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM may_be_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO may_be_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM may_be_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO may_be_app;
ALTER DEFAULT PRIVILEGES FOR ROLE may_be_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO may_be_app;
ALTER DEFAULT PRIVILEGES FOR ROLE may_be_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO may_be_app;
ALTER DEFAULT PRIVILEGES FOR ROLE may_be_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

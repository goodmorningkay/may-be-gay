-- Dummy roles in a unique disposable container only. Migrations run as source
-- owner; dump as SELECT-only backup; restore as an independent target DB owner.
CREATE ROLE may_be_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE recovery_source LOGIN PASSWORD 'source_local_dummy' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE recovery_backup LOGIN PASSWORD 'backup_local_dummy' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE recovery_target LOGIN PASSWORD 'target_local_dummy' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE recovery_runtime LOGIN PASSWORD 'runtime_local_dummy' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE recovery_test OWNER recovery_source;
CREATE DATABASE worker_test OWNER recovery_source;
CREATE DATABASE restore_test OWNER recovery_target;
CREATE DATABASE crash_test OWNER recovery_target;
REVOKE ALL ON DATABASE recovery_test, worker_test, restore_test, crash_test FROM PUBLIC;
GRANT CONNECT ON DATABASE recovery_test TO recovery_backup;
GRANT CONNECT ON DATABASE restore_test TO recovery_runtime;
\connect recovery_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO recovery_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE recovery_source IN SCHEMA public GRANT SELECT ON TABLES TO recovery_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE recovery_source IN SCHEMA public GRANT SELECT ON SEQUENCES TO recovery_backup;
-- drizzle schema is created by migration runner; grant USAGE after migration.

\connect restore_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\connect crash_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;

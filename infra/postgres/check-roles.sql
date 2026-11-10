\set ON_ERROR_STOP on
-- Run as the bootstrap administrator against a migrated disposable/local DB.
-- This checks privileges with SET ROLE and rolls back its probe table.
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname IN ('may_be_app', 'may_be_migrator')
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Application and migration roles must be unprivileged logins';
  END IF;
  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') <> 'may_be_migrator' THEN
    RAISE EXCEPTION 'Migrator must own public schema';
  END IF;
  IF has_schema_privilege('may_be_app', 'public', 'CREATE')
    OR has_database_privilege('may_be_app', current_database(), 'CREATE')
    OR has_database_privilege('may_be_app', current_database(), 'TEMP')
    OR pg_has_role('may_be_app', 'may_be_migrator', 'MEMBER') THEN
    RAISE EXCEPTION 'Runtime has unexpected DDL/role privileges';
  END IF;
END $$;

SET LOCAL ROLE may_be_migrator;
CREATE TABLE public.__foundation_role_probe (id integer PRIMARY KEY, value text NOT NULL);
SET LOCAL ROLE may_be_app;
INSERT INTO public.__foundation_role_probe VALUES (1, 'first');
SELECT * FROM public.__foundation_role_probe;
UPDATE public.__foundation_role_probe SET value = 'second' WHERE id = 1;
DELETE FROM public.__foundation_role_probe WHERE id = 1;
DO $$
BEGIN
  BEGIN
    CREATE TABLE public.__foundation_forbidden (id integer);
    RAISE EXCEPTION 'Runtime unexpectedly created a table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    TRUNCATE public.__foundation_role_probe;
    RAISE EXCEPTION 'Runtime unexpectedly truncated a table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

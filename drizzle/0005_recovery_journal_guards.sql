CREATE FUNCTION public.guard_recovery_journal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Recovery journal is append-only' USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recovery_journal_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.recovery_events
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_recovery_journal();
--> statement-breakpoint
REVOKE ALL ON public.recovery_events FROM may_be_app;
GRANT SELECT, INSERT ON public.recovery_events TO may_be_app;
REVOKE ALL ON public.recovery_replay FROM may_be_app;
REVOKE ALL ON SEQUENCE public.recovery_events_sequence_seq FROM may_be_app;
GRANT USAGE, SELECT ON SEQUENCE public.recovery_events_sequence_seq TO may_be_app;

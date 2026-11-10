-- Cascades from user -> media and user -> profile -> revision may run in
-- either order. Check the retained references against the final transaction
-- state, so account deletion succeeds without allowing dangling references.
ALTER TABLE public.revision_media
  ALTER CONSTRAINT revision_media_media_id_owner_id_media_id_owner_id_fk
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE public.profiles
  ALTER CONSTRAINT profiles_current_revision_fk
  DEFERRABLE INITIALLY DEFERRED;

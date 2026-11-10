ALTER TABLE "profiles" ADD COLUMN "publication_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_publication_number_check" CHECK ("profiles"."publication_number" BETWEEN 0 AND 2147483647);
--> statement-breakpoint
LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
UPDATE public.profiles p
SET publication_number = greatest(p.publication_number, r.maximum)
FROM (SELECT profile_id, max(revision_number) AS maximum
      FROM public.profile_revisions GROUP BY profile_id) r
WHERE p.id = r.profile_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_profile_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Profile identity and ownership are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.publication_number < OLD.publication_number THEN
    RAISE EXCEPTION 'Publication counter cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Handwritten invariants are intentionally separate from Drizzle's schema snapshot.
CREATE FUNCTION public.guard_username_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Username reservations cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.username IS DISTINCT FROM OLD.username OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Username reservation identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.owner_id IS NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Retired username reservations are immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.owner_id IS NULL THEN
    -- Includes the FK's ON DELETE SET NULL; retain no former owner identity.
    NEW.retired_at := statement_timestamp();
  ELSIF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Username reservations cannot change owners' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER username_claim_guard BEFORE UPDATE OR DELETE ON public.username_claims
FOR EACH ROW EXECUTE FUNCTION public.guard_username_claim();
--> statement-breakpoint
CREATE FUNCTION public.guard_profile_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Profile identity and ownership are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER profile_identity_guard BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_identity();
--> statement-breakpoint
CREATE FUNCTION public.guard_profile_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Published snapshots are immutable; insert a new revision' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER profile_revision_guard BEFORE UPDATE ON public.profile_revisions
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_revision();
--> statement-breakpoint
CREATE FUNCTION public.guard_draft_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.profile_id IS DISTINCT FROM OLD.profile_id OR NEW.edit_version::bigint <> OLD.edit_version::bigint + 1 THEN
    RAISE EXCEPTION 'Draft updates must preserve profile and advance edit_version by one' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER draft_version_guard BEFORE UPDATE ON public.profile_drafts
FOR EACH ROW EXECUTE FUNCTION public.guard_draft_version();
--> statement-breakpoint
CREATE FUNCTION public.guard_invite() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
      OR NEW.email IS DISTINCT FROM OLD.email OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'Issued invitation identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'An invitation cannot be unrevoked' USING ERRCODE = '23514';
    END IF;
    IF OLD.redeemed_at IS NOT NULL THEN
      IF NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        OR (NEW.redeemed_by IS DISTINCT FROM OLD.redeemed_by AND NEW.redeemed_by IS NOT NULL) THEN
        RAISE EXCEPTION 'An invitation cannot be redeemed twice or reset' USING ERRCODE = '23514';
      END IF;
      -- A deleting account can clear the recipient FK without permitting reuse.
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.redeemed_at IS NOT NULL THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.expires_at <= statement_timestamp()
      OR NEW.redeemed_by IS NULL
      OR NOT EXISTS (SELECT 1 FROM public."user" u WHERE u.id = NEW.redeemed_by AND lower(btrim(u.email)) = NEW.email) THEN
      RAISE EXCEPTION 'Invitation is not redeemable by this recipient' USING ERRCODE = '23514';
    END IF;
    NEW.redeemed_at := statement_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invite_guard BEFORE INSERT OR UPDATE ON public.invites
FOR EACH ROW EXECUTE FUNCTION public.guard_invite();

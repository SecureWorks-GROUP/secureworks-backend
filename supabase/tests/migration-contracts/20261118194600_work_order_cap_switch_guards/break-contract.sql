-- Break: the approver list answers yes for anyone. The preview and the door take
-- owner_approval_authority's word, and this migration does not own it, so the
-- contract's re-apply does not undo this. (Database-local: no role is changed.)
CREATE OR REPLACE FUNCTION public.owner_approval_authority(p_user uuid)
RETURNS text LANGUAGE sql STABLE AS $$ SELECT CASE WHEN p_user IS NULL THEN NULL ELSE 'owner' END $$;

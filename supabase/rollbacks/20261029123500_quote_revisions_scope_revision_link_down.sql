-- Down for 20261029123500_quote_revisions_scope_revision_link. Roll send-quote and
-- ops-api back FIRST: both INSERT quote_revisions.scope_revision_id, and with the
-- column gone that insert is refused and the send's quote_revisions row is not
-- written (the email still goes out; the release record is lost).
--
-- Refuses while any sent quote records which sealed revision it came from
-- (a non-null scope_revision_id): that column is the only record of it and is
-- never backfilled, so dropping it would lose it. Keep or export those links
-- first (D1 review F5). With no recorded link it drops the foreign key and the
-- column; every quote_revisions row stays.
-- The check and both drops are one statement, so a refusal leaves nothing
-- dropped even under a plain psql -f that carries on after an error.

DO $$
DECLARE
  v_kept boolean := false;
BEGIN
  -- Checked only while the column is there, so a second run is a no-op.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'quote_revisions'
                AND column_name = 'scope_revision_id') THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.quote_revisions WHERE scope_revision_id IS NOT NULL)'
      INTO v_kept;
  END IF;
  IF v_kept THEN
    RAISE EXCEPTION 'sent quotes with a recorded sealed revision exist; keep or export quote_revisions.scope_revision_id before rolling back 20261029123500';
  END IF;

  ALTER TABLE public.quote_revisions DROP CONSTRAINT IF EXISTS quote_revisions_scope_revision_id_fkey;
  ALTER TABLE public.quote_revisions DROP COLUMN IF EXISTS scope_revision_id;
END $$;

-- Down for 20261029123500_quote_revisions_scope_revision_link. Roll send-quote and
-- ops-api back FIRST: both INSERT quote_revisions.scope_revision_id, and with the
-- column gone that insert is refused and the send's quote_revisions row is not
-- written (the email still goes out; the release record is lost).
-- Drops the foreign key and the column; every quote_revisions row stays. Every
-- recorded link is lost with the column.
ALTER TABLE public.quote_revisions DROP CONSTRAINT IF EXISTS quote_revisions_scope_revision_id_fkey;
ALTER TABLE public.quote_revisions DROP COLUMN IF EXISTS scope_revision_id;

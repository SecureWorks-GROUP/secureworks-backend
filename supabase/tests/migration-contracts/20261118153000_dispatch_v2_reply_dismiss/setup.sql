-- Prerequisites for 20261118153000_dispatch_v2_reply_dismiss: dispatch_v2_supplier_emails as the 20261105171000 case's
-- setup made it, plus the columns the backfill reads (received_at and the tray decision columns, production:
-- 20261023230000_dispatch_v2_replies_tables.sql), and users for the dismissed_by foreign key. Four replies saved before
-- the migration, so the contract can read what the backfill did to each.
CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY);
ALTER TABLE public.dispatch_v2_supplier_emails
  ADD COLUMN IF NOT EXISTS received_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS decision text NULL,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS decided_by uuid NULL,
  ADD COLUMN IF NOT EXISTS decided_by_email text NULL;
DO $$
DECLARE
  cols text;
  vals text;
BEGIN
  IF to_regclass('public.dispatch_v2_supplier_emails') IS NULL THEN
    RAISE EXCEPTION 'reply dismiss prerequisites missing: public.dispatch_v2_supplier_emails';
  END IF;
  -- users may carry NOT NULL org_id and name from an earlier case's setup.
  cols := 'id';
  vals := quote_literal('e1180000-0000-4000-8000-0000000000aa');
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'org_id') THEN
    cols := cols || ', org_id';
    vals := vals || ', ' || quote_literal('00000000-0000-0000-0000-000000000001');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'name') THEN
    cols := cols || ', name';
    vals := vals || ', ' || quote_literal('Dismiss contract');
  END IF;
  EXECUTE format('INSERT INTO public.users (%s) VALUES (%s) ON CONFLICT (id) DO NOTHING', cols, vals);
END $$;
INSERT INTO public.dispatch_v2_supplier_emails
  (id, org_id, state, rung, job_id, received_at, decision, decided_at, decided_by, decided_by_email)
VALUES
  -- Before 16 Nov 2026 Perth: dismissed by the backfill.
  ('e1180000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'matched', 'job_number',
   'e1180000-0000-4000-8000-000000000101', '2026-11-12T03:00:00Z', NULL, NULL, NULL, NULL),
  -- 16 Nov 2026 00:00 Perth exactly: stays flagged.
  ('e1180000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'matched', 'job_number',
   'e1180000-0000-4000-8000-000000000101', '2026-11-15T16:00:00Z', NULL, NULL, NULL, NULL),
  -- Put on a job from the tray on 17 Nov: dismissed then, by that person.
  ('e1180000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'matched', 'manual',
   'e1180000-0000-4000-8000-000000000101', '2026-11-17T01:00:00Z', 'assigned', '2026-11-17T02:00:00Z',
   'e1180000-0000-4000-8000-0000000000aa', 'shaun@example.test'),
  -- No received time: dismissed by the backfill.
  ('e1180000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'unmatched', NULL,
   NULL, NULL, NULL, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

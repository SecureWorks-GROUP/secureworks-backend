-- The repair recipient list exists, names users, and is empty in a database
-- that does not hold the seeded user: nothing is invented.
DO $contract$
DECLARE
  v_column record;
BEGIN
  SELECT data_type, udt_name, is_nullable, column_default
  INTO v_column
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'makesafe_notify_settings'
    AND column_name = 'repair_new_job_user_ids';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repair_new_job_user_ids is missing';
  END IF;
  IF v_column.udt_name <> '_uuid' OR v_column.is_nullable <> 'NO' THEN
    RAISE EXCEPTION 'repair_new_job_user_ids must be uuid[] NOT NULL, got % / %',
      v_column.udt_name, v_column.is_nullable;
  END IF;
  IF (SELECT count(*) FROM public.makesafe_notify_settings) <> 1 THEN
    RAISE EXCEPTION 'makesafe_notify_settings must keep its one row';
  END IF;
  IF (SELECT cardinality(repair_new_job_user_ids)
      FROM public.makesafe_notify_settings WHERE id) <> 0 THEN
    RAISE EXCEPTION 'no recipient may be seeded when the user row is absent';
  END IF;
END;
$contract$;

-- A new settings row names nobody: an empty list sends nothing.
BEGIN;
DELETE FROM public.makesafe_notify_settings;
INSERT INTO public.makesafe_notify_settings (id) VALUES (true);
DO $contract$
BEGIN
  IF (SELECT repair_new_job_user_ids
      FROM public.makesafe_notify_settings WHERE id) <> '{}'::uuid[] THEN
    RAISE EXCEPTION 'the default repair recipient list must be empty';
  END IF;
END;
$contract$;
ROLLBACK;

-- First apply in a database that holds the user: the list names that user
-- and nothing else on the row moves.
BEGIN;
ALTER TABLE public.makesafe_notify_settings
  DROP COLUMN repair_new_job_user_ids;
UPDATE public.makesafe_notify_settings
SET notify_enabled = false, from_number = '+61000000009'
WHERE id;
INSERT INTO public.users (id, org_id, name, role)
VALUES (
  'b353f39a-b3cc-495d-a016-50ebf4a8497d',
  '00000000-0000-0000-0000-000000000001',
  'Contract repair recipient',
  'ops_manager'
);
\ir ../../../migrations/20261013170000_makesafe_notify_repair_recipients.sql
DO $contract$
DECLARE
  v_row public.makesafe_notify_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.makesafe_notify_settings WHERE id;
  IF v_row.repair_new_job_user_ids
     <> ARRAY['b353f39a-b3cc-495d-a016-50ebf4a8497d']::uuid[] THEN
    RAISE EXCEPTION 'first apply must seed the one repair recipient, got %',
      v_row.repair_new_job_user_ids;
  END IF;
  IF v_row.notify_enabled IS DISTINCT FROM false
     OR v_row.from_number <> '+61000000009'
     OR v_row.arrival_general_phones <> ARRAY[]::text[] THEN
    RAISE EXCEPTION 'the seed moved a make-safe setting';
  END IF;
END;
$contract$;

-- A later run leaves the list as someone set it: emptied stays empty, and a
-- different user stays.
UPDATE public.makesafe_notify_settings
SET repair_new_job_user_ids = '{}'::uuid[] WHERE id;
\ir ../../../migrations/20261013170000_makesafe_notify_repair_recipients.sql
DO $contract$
BEGIN
  IF (SELECT cardinality(repair_new_job_user_ids)
      FROM public.makesafe_notify_settings WHERE id) <> 0 THEN
    RAISE EXCEPTION 're-apply refilled a list someone emptied';
  END IF;
END;
$contract$;
UPDATE public.makesafe_notify_settings
SET repair_new_job_user_ids =
  ARRAY['11111111-1111-1111-1111-111111111111']::uuid[]
WHERE id;
\ir ../../../migrations/20261013170000_makesafe_notify_repair_recipients.sql
DO $contract$
BEGIN
  IF (SELECT repair_new_job_user_ids
      FROM public.makesafe_notify_settings WHERE id)
     <> ARRAY['11111111-1111-1111-1111-111111111111']::uuid[] THEN
    RAISE EXCEPTION 're-apply wrote over a list someone set';
  END IF;
END;
$contract$;
ROLLBACK;

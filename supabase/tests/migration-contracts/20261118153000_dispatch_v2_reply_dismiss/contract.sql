-- Items 17 and 5 (18 Nov 2026): a supplier reply is flagged until a person dismisses it. The backfill dismisses
-- every reply before 16 Nov 2026 (Perth), and a reply put on a job from the tray is dismissed by that person; who, when and
-- how are checked together. Writes rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  shaun uuid := 'e1180000-0000-4000-8000-0000000000aa';
  r record;
BEGIN
  -- 1. The backfill.
  SELECT dismissed_at, dismissed_source, dismissed_by_email INTO r FROM public.dispatch_v2_supplier_emails
   WHERE id = 'e1180000-0000-4000-8000-000000000001';
  IF r.dismissed_at IS NULL OR r.dismissed_source IS DISTINCT FROM 'backfill' OR r.dismissed_by_email IS NOT NULL THEN
    RAISE EXCEPTION 'contract 1a: a reply before 16 Nov was not dismissed by the backfill: %', r;
  END IF;
  SELECT dismissed_at, dismissed_source INTO r FROM public.dispatch_v2_supplier_emails
   WHERE id = 'e1180000-0000-4000-8000-000000000002';
  IF r.dismissed_at IS NOT NULL OR r.dismissed_source IS NOT NULL THEN
    RAISE EXCEPTION 'contract 1b: a reply from 16 Nov on was dismissed: %', r;
  END IF;
  SELECT dismissed_at, dismissed_source, dismissed_by, dismissed_by_email INTO r FROM public.dispatch_v2_supplier_emails
   WHERE id = 'e1180000-0000-4000-8000-000000000003';
  IF r.dismissed_at IS DISTINCT FROM '2026-11-17T02:00:00Z'::timestamptz OR r.dismissed_source IS DISTINCT FROM 'tray'
     OR r.dismissed_by IS DISTINCT FROM shaun OR r.dismissed_by_email IS DISTINCT FROM 'shaun@example.test' THEN
    RAISE EXCEPTION 'contract 1c: a reply put on a job from the tray was not dismissed by that person: %', r;
  END IF;
  SELECT dismissed_at, dismissed_source INTO r FROM public.dispatch_v2_supplier_emails
   WHERE id = 'e1180000-0000-4000-8000-000000000004';
  IF r.dismissed_at IS NULL OR r.dismissed_source IS DISTINCT FROM 'backfill' THEN
    RAISE EXCEPTION 'contract 1d: a reply with no received time was not dismissed by the backfill: %', r;
  END IF;

  -- 2. A press names who and when, and saves.
  UPDATE public.dispatch_v2_supplier_emails
     SET dismissed_at = '2026-11-18T03:00:00Z', dismissed_by = shaun, dismissed_by_email = 'shaun@example.test',
         dismissed_source = 'button'
   WHERE id = 'e1180000-0000-4000-8000-000000000002';
  INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, dismissed_at, dismissed_by_email, dismissed_source)
  VALUES (org, 'matched', now(), 'ops@example.test', 'suggestion');

  -- 3. A press with no person is refused.
  BEGIN
    INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, dismissed_at, dismissed_source)
    VALUES (org, 'matched', now(), 'button');
    RAISE EXCEPTION 'contract 3: a Dismiss press with no person saved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- 4. A when with no how, or a how with no when, is refused.
  BEGIN
    INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, dismissed_at) VALUES (org, 'matched', now());
    RAISE EXCEPTION 'contract 4a: dismissed_at with no dismissed_source saved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, dismissed_source) VALUES (org, 'matched', 'backfill');
    RAISE EXCEPTION 'contract 4b: dismissed_source with no dismissed_at saved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- 5. A person on a flagged reply is refused.
  BEGIN
    INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, dismissed_by_email)
    VALUES (org, 'matched', 'x@example.test');
    RAISE EXCEPTION 'contract 5: a person on a flagged reply saved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- 6. An unknown how is refused.
  BEGIN
    INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, dismissed_at, dismissed_by_email, dismissed_source)
    VALUES (org, 'matched', now(), 'x@example.test', 'opened');
    RAISE EXCEPTION 'contract 6: an unknown dismissed_source saved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- 7. dismissed_by must name a user.
  BEGIN
    INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, dismissed_at, dismissed_by, dismissed_by_email, dismissed_source)
    VALUES (org, 'matched', now(), gen_random_uuid(), 'x@example.test', 'button');
    RAISE EXCEPTION 'contract 7: dismissed_by naming no user saved';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;

-- Contract: 20261020170100_job_client_signoffs. An on-site sign-off needs a name and the stored
-- signature; an office waiver needs a reason and names who made it; a row is never changed or
-- deleted; browser roles cannot read or write it; the settings row and the switch are seeded with
-- the switch OFF.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('9c000000-0000-4000-8000-000000000001', '9c000000-0000-4000-8000-0000000000aa', 'complete', 'fencing', 'SWF-W2-CONTRACT');
INSERT INTO public.job_media (id, job_id, phase, type, storage_url)
VALUES ('9c000000-0000-4000-8000-000000000002', '9c000000-0000-4000-8000-000000000001', 'signature', 'photo', 'https://example.invalid/sig.png');

INSERT INTO public.job_client_signoffs (job_id, method, signed_name, happy, satisfaction_rating, signature_media_id, captured_by_actor)
VALUES ('9c000000-0000-4000-8000-000000000001', 'on_site', 'Client Name', true, 5, '9c000000-0000-4000-8000-000000000002', 'user:9c000000-0000-4000-8000-0000000000bb');
INSERT INTO public.job_client_signoffs (job_id, method, waiver_reason, captured_by_actor)
VALUES ('9c000000-0000-4000-8000-000000000001', 'office_waiver', 'client overseas, will not respond', 'user:9c000000-0000-4000-8000-0000000000cc');

DO $$
BEGIN
 IF (SELECT count(*) FROM public.job_client_signoffs WHERE job_id = '9c000000-0000-4000-8000-000000000001') <> 2 THEN
  RAISE EXCEPTION 'client signoff contract: both valid sign-offs must be stored';
 END IF;
 BEGIN
  INSERT INTO public.job_client_signoffs (job_id, method, signed_name, captured_by_actor)
  VALUES ('9c000000-0000-4000-8000-000000000001', 'on_site', 'No Signature', 'user:x');
  RAISE EXCEPTION 'client signoff contract: an on-site sign-off without a signature was stored';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO public.job_client_signoffs (job_id, method, waiver_reason, captured_by_actor)
  VALUES ('9c000000-0000-4000-8000-000000000001', 'office_waiver', '', 'user:x');
  RAISE EXCEPTION 'client signoff contract: a waiver without a reason was stored';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO public.job_client_signoffs (job_id, method, waiver_reason, captured_by_actor)
  VALUES ('9c000000-0000-4000-8000-000000000001', 'office_waiver', 'a reason', 'actor_missing');
  RAISE EXCEPTION 'client signoff contract: a sign-off with no named actor was stored';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  UPDATE public.job_client_signoffs SET happy = false WHERE job_id = '9c000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'client signoff contract: a sign-off was changed';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  DELETE FROM public.job_client_signoffs WHERE job_id = '9c000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'client signoff contract: a sign-off was deleted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  TRUNCATE public.job_client_signoffs;
  RAISE EXCEPTION 'client signoff contract: the sign-offs were truncated';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 IF has_table_privilege('service_role', 'public.job_client_signoffs', 'TRUNCATE')
    OR has_table_privilege('service_role', 'public.job_client_signoffs', 'UPDATE')
    OR has_table_privilege('service_role', 'public.job_client_signoffs', 'DELETE') THEN
  RAISE EXCEPTION 'client signoff contract: service_role can change or remove sign-offs';
 END IF;
 IF has_table_privilege('service_role', 'public.client_signoff_settings', 'UPDATE')
    OR has_table_privilege('service_role', 'public.client_signoff_settings', 'INSERT')
    OR has_table_privilege('service_role', 'public.client_signoff_settings', 'DELETE')
    OR has_table_privilege('service_role', 'public.client_signoff_settings', 'TRUNCATE')
    OR NOT has_table_privilege('service_role', 'public.client_signoff_settings', 'SELECT') THEN
  RAISE EXCEPTION 'client signoff contract: service_role must only read the settings';
 END IF;
 IF has_table_privilege('authenticated', 'public.job_client_signoffs', 'SELECT')
    OR has_table_privilege('anon', 'public.job_client_signoffs', 'INSERT') THEN
  RAISE EXCEPTION 'client signoff contract: a browser role can reach job_client_signoffs';
 END IF;
 IF NOT has_table_privilege('service_role', 'public.job_client_signoffs', 'INSERT') THEN
  RAISE EXCEPTION 'client signoff contract: service_role cannot record a sign-off';
 END IF;
 IF (SELECT min_happy_rating FROM public.client_signoff_settings WHERE id = 1) IS DISTINCT FROM 4 THEN
  RAISE EXCEPTION 'client signoff contract: the settings row is not seeded';
 END IF;
 IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'trade_invoice_requires_client_signoff_v1') IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'client signoff contract: the invoice switch must be seeded off';
 END IF;
END $$;
ROLLBACK;

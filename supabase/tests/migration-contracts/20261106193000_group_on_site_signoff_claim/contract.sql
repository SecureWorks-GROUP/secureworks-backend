-- Invented job only. One on-site capture key writes one sign-off and one
-- signature image; a repeat writes nothing. No live record is touched.
BEGIN;
DO $$
DECLARE
  j uuid := gen_random_uuid();
  k uuid := gen_random_uuid();
  h text := 'sha256:' || repeat('b', 64);
  first jsonb; second jsonb; other jsonb; refused boolean := false;
  fn regprocedure := 'public.record_on_site_client_signoff(uuid, text, uuid, uuid, text, boolean, smallint, text, uuid, text, text, text)'::regprocedure;
BEGIN
  IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')
    OR NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'on-site claim: execute must be service role only';
  END IF;
  INSERT INTO public.jobs(id, org_id, type, status, job_number)
  VALUES (j, '00000000-0000-0000-0000-000000000001', 'patio', 'quoted', 'SYN-ONSITE-CLAIM-1');

  first := public.record_on_site_client_signoff(k, h, '00000000-0000-0000-0000-000000000001', j,
    'Invented Client', false, NULL, 'data:image/png;base64,AAAA', NULL, 'user:invented', NULL, 'Gate latch');
  second := public.record_on_site_client_signoff(k, h, '00000000-0000-0000-0000-000000000001', j,
    'Invented Client', false, NULL, 'data:image/png;base64,AAAA', NULL, 'user:invented', NULL, 'Gate latch');
  IF (first->>'claimed')::boolean IS NOT TRUE OR (second->>'claimed')::boolean IS NOT FALSE
    OR first->>'signoff_id' IS DISTINCT FROM second->>'signoff_id'
    OR (second->>'same_capture')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'on-site claim: a repeat must return the stored row: % %', first, second;
  END IF;
  IF (SELECT count(*) FROM public.job_client_signoffs WHERE job_id = j) <> 1
    OR (SELECT count(*) FROM public.job_media WHERE job_id = j AND phase = 'signature') <> 1 THEN
    RAISE EXCEPTION 'on-site claim: a repeat wrote a second row';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.job_client_signoffs s JOIN public.job_media m ON m.id = s.signature_media_id
     WHERE s.job_id = j AND s.method = 'on_site' AND s.happy = false AND s.outstanding_items = 'Gate latch'
       AND s.capture_request_id = k AND s.capture_payload_hash = h
  ) THEN
    RAISE EXCEPTION 'on-site claim: stored row does not match the capture';
  END IF;

  other := public.record_on_site_client_signoff(k, 'sha256:' || repeat('c', 64), '00000000-0000-0000-0000-000000000001', j,
    'Invented Client', true, 5, 'data:image/png;base64,AAAA', NULL, 'user:invented', NULL, NULL);
  IF (other->>'claimed')::boolean IS NOT FALSE OR (other->>'same_capture')::boolean IS NOT FALSE
    OR (SELECT count(*) FROM public.job_client_signoffs WHERE job_id = j) <> 1 THEN
    RAISE EXCEPTION 'on-site claim: a key reused with other answers must write nothing: %', other;
  END IF;

  BEGIN
    PERFORM public.record_on_site_client_signoff(gen_random_uuid(), 'not-a-hash', '00000000-0000-0000-0000-000000000001', j,
      'Invented Client', true, 5, 'data:image/png;base64,AAAA', NULL, 'user:invented', NULL, NULL);
  EXCEPTION WHEN invalid_parameter_value THEN refused := true;
  END;
  IF NOT refused OR (SELECT count(*) FROM public.job_media WHERE job_id = j) <> 1 THEN
    RAISE EXCEPTION 'on-site claim: a call without a valid key must write nothing';
  END IF;
END $$;
ROLLBACK;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE writer_md5 text; unread_md5 text;
BEGIN
 SELECT md5(prosrc) INTO writer_md5
 FROM pg_proc WHERE oid=to_regprocedure('public.capture_business_event(jsonb)');
 SELECT md5(prosrc) INTO unread_md5
 FROM pg_proc WHERE oid=to_regprocedure('public.context_unread_rows(uuid[])');
 IF writer_md5 IS DISTINCT FROM '4819869e6dcc40d5cd19a7eba295392c' THEN
  RAISE EXCEPTION 'ghl_call_pairing_writer_preimage_mismatch: %',coalesce(writer_md5,'<missing>');
 END IF;
 IF unread_md5 IS DISTINCT FROM 'd426adcccab139a188ee158e14ca4fb1' THEN
  RAISE EXCEPTION 'ghl_call_pairing_unread_preimage_mismatch: %',coalesce(unread_md5,'<missing>');
 END IF;
END $guard$;

CREATE INDEX IF NOT EXISTS business_events_legacy_call_pair_lookup
 ON public.business_events ((payload->>'legacy_event_id'))
 WHERE event_type='client.call_logged' AND payload ? 'legacy_event_id';

CREATE OR REPLACE FUNCTION public.pair_legacy_ghl_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_contact_id text; v_match_count integer; v_legacy_id uuid;
BEGIN
 IF NEW.event_type IS DISTINCT FROM 'client.call_logged' THEN RETURN NEW; END IF;
 NEW.payload:=coalesce(NEW.payload,'{}'::jsonb)-'legacy_event_id';
 v_contact_id:=nullif(btrim(NEW.contact_id),'');
 IF v_contact_id IS NULL OR NEW.event_at IS NULL THEN RETURN NEW; END IF;

 PERFORM pg_advisory_xact_lock(hashtextextended(v_contact_id,0));
 SELECT count(*)::integer,(array_agg(e.id ORDER BY e.id))[1]
 INTO v_match_count,v_legacy_id
 FROM public.business_events e
 WHERE e.event_type='client.call_complete' AND e.contact_id=v_contact_id
  AND coalesce(e.event_at,e.occurred_at) BETWEEN NEW.event_at-interval '120 seconds' AND NEW.event_at+interval '120 seconds'
  AND NOT EXISTS(
   SELECT 1 FROM public.business_events logged
   WHERE logged.event_type='client.call_logged'
    AND logged.payload->>'legacy_event_id'=e.id::text
  );
 IF v_match_count=1 THEN
  NEW.payload:=NEW.payload||jsonb_build_object('legacy_event_id',v_legacy_id::text);
 END IF;
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.pair_legacy_ghl_call() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pair_legacy_ghl_call() TO service_role;

DO $trigger$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.business_events'::regclass AND tgname='business_events_pair_legacy_call' AND NOT tgisinternal) THEN
  EXECUTE 'CREATE TRIGGER business_events_pair_legacy_call BEFORE INSERT ON public.business_events FOR EACH ROW EXECUTE FUNCTION public.pair_legacy_ghl_call()';
 ELSIF (SELECT tgfoid FROM pg_trigger WHERE tgrelid='public.business_events'::regclass AND tgname='business_events_pair_legacy_call' AND NOT tgisinternal)
    IS DISTINCT FROM 'public.pair_legacy_ghl_call()'::regprocedure THEN
  RAISE EXCEPTION 'ghl_call_pairing_trigger_preimage_mismatch';
 END IF;
END $trigger$;

CREATE OR REPLACE FUNCTION public.context_unread_rows(p_job_ids uuid[]) RETURNS SETOF public.business_events
LANGUAGE sql STABLE AS $$
 SELECT e.* FROM public.business_events e
 WHERE e.job_id IS NOT NULL AND (p_job_ids IS NULL OR e.job_id OPERATOR(pg_catalog.=) ANY(p_job_ids))
  AND public.context_linked_status(e.attribution_status)
  AND e.context_captured_at IS NOT NULL
  AND coalesce(e.metadata OPERATOR(pg_catalog.->>) 'written_as','service_role') OPERATOR(pg_catalog.=) 'service_role'
  AND pg_catalog.btrim(public.context_event_text(e)) OPERATOR(pg_catalog.<>) ''
  AND NOT (e.event_type OPERATOR(pg_catalog.=) 'client.call_complete' AND EXISTS(
   SELECT 1 FROM public.business_events logged
   WHERE logged.event_type OPERATOR(pg_catalog.=) 'client.call_logged'
    AND logged.payload OPERATOR(pg_catalog.->>) 'legacy_event_id' OPERATOR(pg_catalog.=) e.id::text
  ))
  AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r
   WHERE r.event_id OPERATOR(pg_catalog.=) e.id AND r.job_id OPERATOR(pg_catalog.=) e.job_id
    AND r.extractor_version OPERATOR(pg_catalog.=) 'luna_v2')
$$;

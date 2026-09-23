-- Earlier registered context fixtures supply jobs (ghl_contact_id, metadata),
-- business_events (source, channel, direction, contact_id), the B1 run ledger,
-- B2 attribution, B3 custody and the 17 Sep heartbeat. No extra columns.
--
-- Those fixtures leave exactly production's pre-image, as read from production
-- on 23 Sep 2026: the repository bodies are byte-identical to the live ones.
-- Prove it here so the contract below runs against production's starting
-- point, not an assumed one.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_pipeline_status()')) IS DISTINCT FROM '0fa6842cebf236e47b608a520c6c9fd1'
 THEN RAISE EXCEPTION 'f1 setup: context_pipeline_status() is not the production pre-image'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer)'))
    IS DISTINCT FROM 'd3441ee4b6c93777564f1385b00c73dc'
 THEN RAISE EXCEPTION 'f1 setup: persist_luna_context_revision (9 args) is not the production pre-image'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.persist_luna_context_revision(text,text,jsonb,text,jsonb)'))
    IS DISTINCT FROM 'f8c4bd29bba0878396ee7626c21ee65d'
 THEN RAISE EXCEPTION 'f1 setup: persist_luna_context_revision (5 args) is not the production pre-image'; END IF;
 IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid='public.business_events'::regclass AND c.conname='business_events_attribution_status_check')
    IS DISTINCT FROM 'CHECK ((attribution_status = ANY (ARRAY[''direct''::text, ''thread''::text, ''single_open''::text, ''single_line''::text, ''luna''::text, ''admin_bucket''::text, ''pending_luna''::text, ''empty''::text, ''automated''::text])))'
 THEN RAISE EXCEPTION 'f1 setup: attribution status check is not the production nine values'; END IF;
 PERFORM set_config('search_path','public',true);
 IF md5(pg_get_viewdef('public.current_job_context_facts'::regclass)) IS DISTINCT FROM '4430e6fe155e0bbb8f95c110df417c7c'
 THEN RAISE EXCEPTION 'f1 setup: current_job_context_facts is not the production pre-image'; END IF;
END $$;

BEGIN;
DO $$
DECLARE ev uuid:='aa000000-0000-4000-8000-00000000mail';
 a jsonb; b jsonb;
BEGIN
 INSERT INTO public.business_events(id,event_type,payload) VALUES(ev,'email.received',jsonb_build_object('subject','same letter'));
 a:=public.record_context_mail_occurrence('graph-logical-1','marnin:inbox','occ-inbox','inbound',ev);
 b:=public.record_context_mail_occurrence('graph-logical-1','marnin:sentitems','occ-sent','outbound',ev);
 IF a->>'event_id' IS DISTINCT FROM b->>'event_id' THEN RAISE EXCEPTION 'occurrences created two logical sources'; END IF;
 IF a->>'outcome'<>'new_logical' OR b->>'outcome'<>'existing_logical' THEN RAISE EXCEPTION 'occurrence outcomes % %',a,b; END IF;
 IF (SELECT count(*) FROM public.context_mail_observations WHERE logical_message_id='graph-logical-1')<>2 THEN
  RAISE EXCEPTION 'both occurrences not preserved';
 END IF;
 IF (SELECT count(DISTINCT event_id) FROM public.context_mail_observations WHERE logical_message_id='graph-logical-1')<>1 THEN
  RAISE EXCEPTION 'logical source was split';
 END IF;
END $$;
ROLLBACK;

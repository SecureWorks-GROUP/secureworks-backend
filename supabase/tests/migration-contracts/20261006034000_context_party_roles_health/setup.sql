-- Prerequisites for 20261006034000_context_party_roles_health: nothing new.
-- Every table and function it reads or replaces is created by an earlier
-- registered case (the parties status block of 20261002120000, the party-role
-- classifier and trigger of 20261005200000 and 20261006000000, L1d's template
-- reading of 20261005090000, the scorecard lane rule of 20261006032000). This
-- check fails early, and by name, if one is missing.
DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_parties_status()','public.context_pipeline_status()',
   'public.context_message_party_roles(public.business_events)','public.context_stamp_party_roles()',
   'public.context_internal_text_role(public.business_events)',
   'public.context_scorecard_lane_of(text,text,text,text,text,jsonb)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'party roles health setup: % is missing from the registered stack', f; END IF;
 END LOOP;
END $$;

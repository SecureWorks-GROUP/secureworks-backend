-- Prerequisites for 20261009131000_context_group_mailbox_audience. Every table, column, trigger
-- and function it reads comes from earlier registered setups and migrations: business_events with
-- the email reader's columns and the provider key's unique index (20260911171000), the party-roles
-- trigger and classifier (20261005200000, v4 20261007060000), inbox_events with the old poller's
-- columns, the lane switch (20260911170000), and, for the contract's judge case, the ledger store
-- and its judge (20261006013000, 20261007010000). This checks they are there; it adds nothing, so
-- no fixture row outlives a contract.
DO $$
DECLARE f text; t text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.automation_lane_enabled(text)', 'public.context_message_party_roles(public.business_events)',
  'public.context_stamp_party_roles()', 'public.context_ledger_judge(uuid[])',
  'public.context_ledger_evidence_rows(uuid[],timestamptz)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'group mailbox audience setup: % missing from the registered stack', f; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['business_events.event_type', 'business_events.direction', 'business_events.channel',
   'business_events.source', 'business_events.payload', 'business_events.metadata', 'business_events.provider_message_id',
   'business_events.event_at', 'business_events.occurred_at', 'business_events.recorded_at', 'business_events.context_captured_at',
   'business_events.job_id', 'business_events.attribution_status', 'business_events.attribution_confidence',
   'business_events.attributed_at', 'business_events.match_method',
   'inbox_events.from_email', 'inbox_events.to_email', 'inbox_events.received_at', 'inbox_events.subject',
   'inbox_events.mailbox', 'inbox_events.processed_at', 'inbox_events.graph_message_id',
   'automation_switches.capture', 'automation_switches.extraction', 'context_ledger_settings.mode',
   'context_ledger_generations.evidence_until'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND a.attnum > 0 AND NOT a.attisdropped) THEN
   RAISE EXCEPTION 'group mailbox audience setup: public.% missing from the registered stack', t;
  END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = 'public.business_events'::regclass
   AND tg.tgname = 'context_party_roles_business_event' AND NOT tg.tgisinternal) THEN
  RAISE EXCEPTION 'group mailbox audience setup: the party-roles trigger is missing';
 END IF;
END $$;

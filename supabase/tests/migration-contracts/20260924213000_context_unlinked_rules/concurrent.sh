#!/usr/bin/env bash
set -euo pipefail

: "${CONTRACT_DATABASE_URL:?local contract database required}"
case "$CONTRACT_DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*)
    ;;
  *)
    echo "error: contract database must target localhost" >&2
    exit 2
    ;;
esac

cleanup() {
  psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL' || true
DROP TRIGGER IF EXISTS p4_contract_supplier_pause ON public.event_threads;
DROP FUNCTION IF EXISTS public.p4_contract_supplier_pause();
DELETE FROM public.event_threads WHERE thread_key='supplier_ref:perth.metroll.example:7654321';
DELETE FROM public.business_events WHERE id IN ('d4e00000-0000-4000-8000-000000000991','d4e00000-0000-4000-8000-000000000992');
DELETE FROM public.jobs WHERE id IN ('d4000000-0000-4000-8000-000000000991','d4000000-0000-4000-8000-000000000992');
UPDATE public.feature_flags SET enabled=false WHERE flag_name='context_unlinked_rules_v1';
UPDATE public.automation_switches SET attribution=true WHERE id=1;
SQL
}
trap cleanup EXIT

psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
UPDATE public.feature_flags SET enabled=true WHERE flag_name='context_unlinked_rules_v1';
UPDATE public.automation_switches SET attribution=true WHERE id=1;
INSERT INTO public.jobs(id,org_id,job_number,status,type,created_at,metadata) VALUES
 ('d4000000-0000-4000-8000-000000000991',gen_random_uuid(),'SWP-99091','scheduled','patio',now(),'{}'),
 ('d4000000-0000-4000-8000-000000000992',gen_random_uuid(),'SWP-99092','scheduled','patio',now(),'{}');
CREATE FUNCTION public.p4_contract_supplier_pause() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_event_id='d4e00000-0000-4000-8000-000000000991' THEN PERFORM pg_sleep(2); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER p4_contract_supplier_pause BEFORE INSERT ON public.event_threads
FOR EACH ROW EXECUTE FUNCTION public.p4_contract_supplier_pause();
SQL

psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL' &
INSERT INTO public.business_events(id,event_type,source,channel,direction,event_at,payload)
VALUES('d4e00000-0000-4000-8000-000000000991','supplier.email_in','monitor-inbox','email','inbound',now(),
 '{"from":"Quotes@perth.metroll.example","subject":"SWP-99091 - 7654321","body":"First order note."}');
SQL
worker_a=$!
sleep 0.25
psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL' &
INSERT INTO public.business_events(id,event_type,source,channel,direction,event_at,payload)
VALUES('d4e00000-0000-4000-8000-000000000992','supplier.email_in','monitor-inbox','email','inbound',now(),
 '{"from":"Quotes@perth.metroll.example","subject":"SWP-99092 - 7654321","body":"Second order note."}');
SQL
worker_b=$!
wait "$worker_a"
wait "$worker_b"

psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE e public.business_events;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.event_threads WHERE thread_key='supplier_ref:perth.metroll.example:7654321'
  AND retired_at IS NOT NULL AND retired_reason='conflict'
  AND job_id IN ('d4000000-0000-4000-8000-000000000991','d4000000-0000-4000-8000-000000000992')
  AND retired_conflict_job_id IN ('d4000000-0000-4000-8000-000000000991','d4000000-0000-4000-8000-000000000992')
  AND job_id<>retired_conflict_job_id)
 THEN RAISE EXCEPTION 'concurrent supplier binding was not retired as a conflict'; END IF;
 INSERT INTO public.business_events(event_type,source,channel,direction,event_at,payload)
 VALUES('supplier.email_in','monitor-inbox','email','inbound',now(),
  '{"from":"Quotes@perth.metroll.example","subject":"RE: Quote 7654321","body":"Collect today."}')
 RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'unplaced'
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY['d4000000-0000-4000-8000-000000000991','d4000000-0000-4000-8000-000000000992']::uuid[]
  OR e.metadata->>'placement_rule'<>'supplier_order_retired'
 THEN RAISE EXCEPTION 'later supplier mail did not rest with both jobs: % % %',e.attribution_status,e.candidate_job_ids,e.metadata; END IF;
END $$;
SQL

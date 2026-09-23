#!/usr/bin/env bash
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?local contract database required}"
case "$CONTRACT_DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgresql://*@localhost:*/*) ;;
  *) echo 'local database required' >&2; exit 2 ;;
esac

# A message locked by another session (say, Luna placing it) must never block
# a job insert: P1b waits at most 2 seconds for it, skips it, and the insert
# commits. The skipped message stays where it was.
psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
VALUES('ghl-webhook-receiver','{"body":"Busy text"}','p1b-busy','sms','inbound','2026-09-01Z');
SQL
psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL' &
BEGIN;
SELECT id FROM public.business_events WHERE contact_id='p1b-busy' FOR UPDATE;
SELECT pg_sleep(6);
COMMIT;
SQL
holder=$!
sleep 1
started=$(date +%s)
psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at)
VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','quoted','fencing','P1B-BUSY','p1b-busy','2026-09-05Z');
SQL
elapsed=$(( $(date +%s) - started ))
wait "$holder"
if [ "$elapsed" -ge 5 ]; then
  echo "contract: the job insert waited ${elapsed}s on a locked message" >&2
  exit 1
fi
psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE job_number='P1B-BUSY') THEN RAISE EXCEPTION 'contract: the job insert did not commit'; END IF;
  IF (SELECT attribution_status FROM public.business_events WHERE contact_id='p1b-busy') IS DISTINCT FROM 'admin_bucket'
  THEN RAISE EXCEPTION 'contract: the locked message was moved'; END IF;
  -- The skipped message is still reconsidered when the new job is offered again.
  PERFORM public.context_reconsider_contact('p1b-busy','2026-08-06Z','job_created',(SELECT id FROM public.jobs WHERE job_number='P1B-BUSY'));
  IF (SELECT attribution_status FROM public.business_events WHERE contact_id='p1b-busy') IS DISTINCT FROM 'single_open'
  THEN RAISE EXCEPTION 'contract: a later call did not place the skipped message'; END IF;
END $$;
DELETE FROM public.business_events WHERE contact_id='p1b-busy';
DELETE FROM public.jobs WHERE job_number='P1B-BUSY';
SQL

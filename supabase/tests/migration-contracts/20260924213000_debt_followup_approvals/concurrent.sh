#!/usr/bin/env bash
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?local contract database required}"
case "$CONTRACT_DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgresql://*@localhost:*/*) ;;
  *) echo 'local database required' >&2; exit 2 ;;
esac

psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.debt_followup_concurrency_results (
  worker text NOT NULL,
  approval_id text NOT NULL
);
SQL

insert_approval() {
  local worker=$1
  local approval_id=$2
  psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "
    SELECT pg_sleep(1);
    WITH created AS (
      SELECT approval_id
      FROM public.debt_followup_create_approval(jsonb_build_object(
        'approval_id', '$approval_id',
        'binding_hash', repeat('f',64),
        'contract', 'debt-followup-approval/v1',
        'kind', 'chase_sms',
        'channel', 'sms',
        'xero_invoice_ids', jsonb_build_array('inv-concurrent'),
        'request', '{}'::jsonb,
        'proposal', jsonb_build_object('contract','debt-followup-approval/v1','body_sha256',repeat('e',64)),
        'body_sha256', repeat('e',64),
        'approved_by_email', 'captain@example.test',
        'approved_by_user_id', '706c5258-70dd-483a-b36c-af6864b24498',
        'approved_at', now(),
        'expires_at', now() + interval '30 minutes'
      ))
    )
    INSERT INTO public.debt_followup_concurrency_results(worker, approval_id)
    SELECT '$worker', approval_id FROM created;
  " >/dev/null
}

insert_approval first "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" &
first_pid=$!
insert_approval second "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" &
second_pid=$!
wait "$first_pid"
wait "$second_pid"

psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM public.debt_followup_concurrency_results) <> 2 OR
     (SELECT count(DISTINCT approval_id) FROM public.debt_followup_concurrency_results) <> 1 OR
     (SELECT count(*) FROM public.debt_followup_approvals
       WHERE binding_hash = repeat('f',64) AND state = 'open') <> 1 THEN
    RAISE EXCEPTION 'concurrent identical approvals did not converge on one open row';
  END IF;
END $$;
DROP TABLE public.debt_followup_concurrency_results;
SQL

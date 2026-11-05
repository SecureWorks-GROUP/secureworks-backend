#!/usr/bin/env bash
# One disposable local database. No credentials, provider traffic, or live data.
set -euo pipefail
admin_url=${INVOICE_DRAFT_TEST_DATABASE_URL:-}
if [[ "${INVOICE_DRAFT_DISPOSABLE_ACK:-}" != I-confirm-this-is-disposable-local-postgres ]]; then echo 'error: explicit disposable local acknowledgement required' >&2; exit 2; fi
case "$admin_url" in postgresql://*@127.0.0.1:*/postgres|postgresql://*@localhost:*/postgres) ;; *) echo 'error: localhost /postgres admin URL required' >&2; exit 2 ;; esac
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
database="ws6_invoice_draft_${BASHPID}"
database_url="${admin_url%/*}/$database"
created=false
cleanup(){ if [[ "$created" == true ]]; then psql "$admin_url" -X -v ON_ERROR_STOP=1 -q -c "DROP DATABASE \"$database\" WITH (FORCE)" >/dev/null; fi; }
trap cleanup EXIT
psql "$admin_url" -X -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$database\""
created=true
case_name=20261105130000_invoice_milestone_draft_claims
psql "$database_url" -X -v ON_ERROR_STOP=1 -q \
 -f "$repo/supabase/tests/migration-contracts/$case_name/setup.sql" \
 -f "$repo/supabase/migrations/20261105003000_invoice_milestone_review_intents.sql" \
 -f "$repo/supabase/migrations/$case_name.sql" \
 -f "$repo/supabase/tests/migration-contracts/$case_name/contract.sql"
# Two real concurrent CAS writers contend for a second prepared fixture claim.
psql "$database_url" -X -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.invoice_milestone_draft_claims(org_id,job_id,quote_revision_id,review_id,stage_id,xero_contact_id,amount_cents,currency,label,printed_terms,due_date,reference,payload_hash,state)
SELECT org_id,job_id,accepted_quote_revision_id,id,'concurrent','66000000-0000-4000-8000-000000000002',1,'AUD','Fixture stage','Fixture accepted terms','2026-11-06','WS6-CONTRACT-CONCURRENT',repeat('b',64),'prepared'
FROM public.invoice_milestone_reviews WHERE job_id='66000000-0000-4000-8000-000000000001';
SQL
psql "$database_url" -X -v ON_ERROR_STOP=1 -q <<'SQL' &
BEGIN;
UPDATE public.invoice_milestone_draft_claims SET state='dispatching',hold_reason='first' WHERE reference='WS6-CONTRACT-CONCURRENT' AND state='prepared';
SELECT pg_sleep(1);
COMMIT;
SQL
first=$!
psql "$database_url" -X -v ON_ERROR_STOP=1 -q <<'SQL' &
BEGIN;
UPDATE public.invoice_milestone_draft_claims SET state='dispatching',hold_reason='second' WHERE reference='WS6-CONTRACT-CONCURRENT' AND state='prepared';
COMMIT;
SQL
second=$!
wait "$first"
wait "$second"
psql "$database_url" -X -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
 IF (SELECT count(*) FROM public.invoice_milestone_draft_claims WHERE reference='WS6-CONTRACT-CONCURRENT' AND state='dispatching' AND hold_reason IN('first','second')) <> 1 THEN RAISE EXCEPTION 'Concurrent dispatch identity lost'; END IF;
END $$;
SQL
psql "$database_url" -X -v ON_ERROR_STOP=1 -q -f "$repo/supabase/rollbacks/${case_name}_down.sql" -f "$repo/supabase/tests/migration-contracts/$case_name/rollback-contract.sql"
echo 'result: pass; frozen payer, unknown retry hold, payload immutability, real concurrent CAS, RLS/grants and preserving rollback'

#!/usr/bin/env bash
set -euo pipefail
admin_url=${INVOICE_DRAFT_TEST_DATABASE_URL:-}
if [[ "${INVOICE_DRAFT_DISPOSABLE_ACK:-}" != I-confirm-this-is-disposable-local-postgres ]]; then echo 'error: explicit disposable local acknowledgement required' >&2; exit 2; fi
case "$admin_url" in postgresql://*@127.0.0.1:*/postgres|postgresql://*@localhost:*/postgres) ;; *) echo 'error: localhost /postgres admin URL required' >&2; exit 2 ;; esac
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
database="ws6_council_draft_${BASHPID}"
database_url="${admin_url%/*}/$database"
created=false
cleanup(){ if [[ "$created" == true ]]; then psql "$admin_url" -X -v ON_ERROR_STOP=1 -q -c "DROP DATABASE \"$database\" WITH (FORCE)" >/dev/null; fi; }
trap cleanup EXIT
psql "$admin_url" -X -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$database\""
created=true
case_name=20261105140000_invoice_council_step_bindings
psql "$database_url" -X -v ON_ERROR_STOP=1 -q \
 -f "$repo/supabase/tests/migration-contracts/$case_name/setup.sql" \
 -f "$repo/supabase/migrations/20261105003000_invoice_milestone_review_intents.sql" \
 -f "$repo/supabase/migrations/20261105130000_invoice_milestone_draft_claims.sql" \
 -f "$repo/supabase/migrations/$case_name.sql" \
 -f "$repo/supabase/tests/migration-contracts/$case_name/contract.sql" \
 -f "$repo/supabase/rollbacks/${case_name}_down.sql" \
 -f "$repo/supabase/tests/migration-contracts/$case_name/rollback-contract.sql"
echo 'result: pass; exact prequote council binding, explicit completion, jump exclusion, reset/recompletion, admission recheck and preserving rollback'

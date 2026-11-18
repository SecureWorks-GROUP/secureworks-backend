#!/usr/bin/env bash
# Only the new case, in a fresh PostgreSQL cluster with a private socket.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
case_dir=("$root"/supabase/tests/migration-contracts/*_customer_invoices_on_no_job)
cluster=$(mktemp -d "${TMPDIR:-/tmp}/invoice-items.XXXXXXXX")
cleanup() {
  if [[ -s "$cluster/data/postmaster.pid" ]]; then
    pg_ctl -D "$cluster/data" -m fast -w stop >/dev/null
  fi
  rm -rf "$cluster"
}
trap cleanup EXIT
initdb -D "$cluster/data" -U postgres -A trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$cluster/data" -l "$cluster/server.log" \
  -o "-c listen_addresses='' -c unix_socket_directories='$cluster'" -w start >/dev/null
sql=(psql -X -v ON_ERROR_STOP=1 -h "$cluster" -U postgres -d postgres)
"${sql[@]}" -f "$case_dir/setup.sql"

# Install the original evidence tables, lookup indexes and current view from
# their owning migration. The wider revenue loader is outside this contract.
awk '
  /^CREATE TABLE public.bookkeeping_(evidence_revisions|line_evidence) \(/ ||
  /^CREATE INDEX bookkeeping_line_evidence_/ ||
  /^CREATE VIEW public.v_bookkeeping_line_evidence_current AS$/ { copying = 1 }
  copying { print; if (/;$/) copying = 0 }
' "$root/supabase/migrations/20261102070000_job_profit_line_evidence.sql" | "${sql[@]}"
"${sql[@]}" -1 -f "$root/supabase/migrations/$(basename "$case_dir").sql"
"${sql[@]}" -f "$root/supabase/tests/customer_invoices_on_no_job_contract.sql"
"${sql[@]}" -f "$case_dir/plan.sql"

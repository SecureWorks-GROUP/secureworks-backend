#!/usr/bin/env bash
# Local proof for the row 3 hand-run scripts (20261007070000_context_placement_grades):
#   scripts/context-placement-misfile-repair.sql (+ -undo)
#   scripts/context-holding-thread-retire.sql (+ -undo)
#   scripts/context-bucket-rerun-l1g.sql (+ -undo)
#   scripts/context-placement-grades-load.sql (+ -undo)
# On a disposable localhost PostgreSQL it applies every registered migration
# contract case (setup and migration, in timestamp order, as run.sh does), writes
# synthetic fixtures shaped like the 7 Oct 2026 production rows, and runs each
# script three ways: as written (a dry run: nothing may change), with its count
# constants set to the fixture's and its final ROLLBACK turned into COMMIT (the
# real write: the planned change must happen), and then each undo the same way
# (the database must read byte for byte as before). Never point it at anything
# but a disposable database: it drops and recreates its own.
#
# MIGRATION_CONTRACT_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/postgres \
# MIGRATION_CONTRACT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres \
# bash scripts/test-context-placement-row3.sh
set -euo pipefail
export LC_ALL=C

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
CONTRACT_ROOT="$REPO_ROOT/supabase/tests/migration-contracts"
ADMIN_DATABASE_URL=${MIGRATION_CONTRACT_ADMIN_DATABASE_URL:-}
if [ "${MIGRATION_CONTRACT_DISPOSABLE_ACK:-}" != "I-confirm-this-is-disposable-local-postgres" ]; then
  echo "error: set MIGRATION_CONTRACT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres" >&2; exit 2
fi
case "$ADMIN_DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*) ;;
  *) echo "error: MIGRATION_CONTRACT_ADMIN_DATABASE_URL must target localhost" >&2; exit 2 ;;
esac
DB=secureworks_placement_row3_scripts
URL="${ADMIN_DATABASE_URL%/*}/$DB"
# PLACEMENT_ROW3_KEEP_LOGS=<new directory> keeps every script's output there; otherwise a temporary one is removed.
WORK=${PLACEMENT_ROW3_KEEP_LOGS:-$(mktemp -d)}
mkdir -p "$WORK"
cleanup() {
  psql "$ADMIN_DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);" >/dev/null 2>&1 || true
  if [ -z "${PLACEMENT_ROW3_KEEP_LOGS:-}" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

q() { psql "$URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
val() { psql "$URL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }
snapshot() {
  val "SELECT md5(coalesce((SELECT string_agg(to_jsonb(e)::text, '|' ORDER BY e.id) FROM public.business_events e), '')
        || coalesce((SELECT string_agg(to_jsonb(t)::text, '|' ORDER BY t.thread_key COLLATE \"C\") FROM public.event_threads t), '')
        || coalesce((SELECT string_agg(to_jsonb(g)::text, '|' ORDER BY g.id) FROM public.context_placement_grades g), ''))"
}
# A copy of a script with its constants set and (optionally) its final ROLLBACK turned into COMMIT.
variant() {
  local src=$1 out=$2 commit=$3; shift 3
  python3 - "$src" "$out" "$commit" "$@" <<'PY'
import sys
src, out, commit, *subs = sys.argv[1:]
s = open(src).read()
for pair in subs:
    old, new = pair.split('=>', 1)
    if old not in s:
        sys.exit(f'variant: {old!r} not in {src}')
    s = s.replace(old, new)
if commit == 'commit':
    i = s.rindex('ROLLBACK;')
    s = s[:i] + 'COMMIT;' + s[i + len('ROLLBACK;'):]
open(out, 'w').write(s)
PY
}
expect_same() { if [ "$1" != "$2" ]; then echo "FAIL: $3" >&2; exit 1; fi; echo "ok: $3"; }
expect_eq() { local got; got=$(val "$1"); if [ "$got" != "$2" ]; then echo "FAIL: $3 (got '$got', want '$2')" >&2; exit 1; fi; echo "ok: $3"; }

echo "== building $DB from the registered contract stack =="
psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);" -c "CREATE DATABASE \"$DB\";"
for d in "$CONTRACT_ROOT"/20*; do
  n=$(basename "$d")
  q -f "$d/setup.sql" >/dev/null 2>&1 || { echo "setup failed: $n" >&2; q -f "$d/setup.sql"; exit 1; }
  q -f "$REPO_ROOT/supabase/migrations/$n.sql" >/dev/null 2>&1 || { echo "migration failed: $n" >&2; q -f "$REPO_ROOT/supabase/migrations/$n.sql"; exit 1; }
done

echo "== fixtures (synthetic, pinned to March 2031) =="
q <<'SQL'
SET session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, ghl_contact_id, client_email, created_at, updated_at, completed_at, metadata) VALUES
 ('a7c00000-0000-4000-8000-0000000000b0', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC-HOLD', 'archived', 'fencing', NULL, NULL,
  '2031-01-02 00:00Z', '2031-01-02 00:00Z', NULL, '{"do_not_schedule":true,"purpose":"pdf_unlock_bucket"}'),
 ('a7c00000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC01', 'accepted', 'fencing', 'ctPGCa', 'owner.a@pgc.example.test',
  '2031-02-01 00:00Z', '2031-02-01 00:00Z', NULL, '{}'),
 ('a7c00000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC02', 'quoted', 'fencing', 'ctPGCb', NULL,
  '2031-02-01 00:00Z', '2031-02-01 00:00Z', NULL, '{}'),
 ('a7c00000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC03', 'quoted', 'patio', 'ctPGCb', NULL,
  '2031-02-10 00:00Z', '2031-02-10 00:00Z', NULL, '{}'),
 ('a7c00000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC04', 'accepted', 'fencing', 'ctPGCc', NULL,
  '2030-12-01 00:00Z', '2030-12-01 00:00Z', NULL, '{}'),
 ('a7c00000-0000-4000-8000-0000000000b5', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC05', 'completed', 'fencing', 'ctPGCc', NULL,
  '2030-06-01 00:00Z', '2030-08-01 00:00Z', '2030-08-01 00:00Z', '{}');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, metadata, payload, occurred_at,
 recorded_at, context_captured_at, event_at, attribution_status, attribution_step, match_method, match_status, attribution_confidence,
 match_confidence, thread_key, candidate_job_ids) VALUES
 -- Three text-cache misfiles on the holding job (move, review, review with the ladder disagreeing) and one elsewhere.
 ('a7c00000-0000-4000-800a-000000000001', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, NULL,
  '{"party_roles":{"version":"party_roles_v3","sender_role":"unknown","recipient_role":"staff","counterpart_role":"unknown","basis":"no_match","audience":"unknown"}}',
  '{"ghl_contact_id":"ctPGCa","job_id":"a7c00000-0000-4000-8000-0000000000b1","body":"Thanks, see you Monday","direction":"inbound"}',
  '2031-03-01 02:00Z', '2031-03-01 02:05Z', '2031-03-01 02:05Z', '2031-03-01 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL, NULL),
 ('a7c00000-0000-4000-800a-000000000002', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, NULL,
  '{"party_roles":{"version":"party_roles_v3","sender_role":"unknown","recipient_role":"staff","counterpart_role":"unknown","basis":"no_match","audience":"unknown"}}',
  '{"ghl_contact_id":"ctPGCb","job_id":"a7c00000-0000-4000-8000-0000000000b2","body":"Which day works?","direction":"inbound"}',
  '2031-03-02 02:00Z', '2031-03-02 02:05Z', '2031-03-02 02:05Z', '2031-03-02 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL, NULL),
 ('a7c00000-0000-4000-800a-000000000003', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', NULL,
  '{"party_roles":{"version":"party_roles_v3","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"no_match","audience":"customer"}}',
  '{"ghl_contact_id":"ctPGCc","job_id":"a7c00000-0000-4000-8000-0000000000b5","body":"Can you quote the side fence too?","direction":"inbound"}',
  '2031-01-05 02:00Z', '2031-01-05 02:05Z', '2031-01-05 02:05Z', '2031-01-05 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL, NULL),
 ('a7c00000-0000-4000-800a-000000000004', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, 'ctPGCa',
  '{}', '{"ghl_contact_id":"ctPGCa","job_id":"a7c00000-0000-4000-8000-0000000000b2","body":"ok"}',
  '2031-03-04 02:00Z', '2031-03-04 02:05Z', '2031-03-04 02:05Z', '2031-03-04 02:00Z', 'single_open', 3, 'contact_id', 'matched', 1, 1, NULL, NULL),
 -- Group mail on the holding job that bound two threads, and the bucket.
 ('a7c00000-0000-4000-800c-000000000001', 'a7c00000-0000-4000-8000-0000000000b0', 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{}', '{"subject":"Invoice copy","body":"Please find attached"}',
  '2031-02-20 02:00Z', '2031-02-20 02:00Z', '2031-02-20 02:00Z', '2031-02-20 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, 'outlook:pgc-hold-1', NULL),
 ('a7c00000-0000-4000-800c-000000000002', 'a7c00000-0000-4000-8000-0000000000b0', 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{}', '{"subject":"Statement","body":"Statement attached"}',
  '2031-02-21 02:00Z', '2031-02-21 02:00Z', '2031-02-21 02:00Z', '2031-02-21 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, 'outlook:pgc-hold-2', NULL),
 -- The bucket: B1 an email from job one's client (the rules read payload.from), B2 naming SWF-PGC02 on its own
 -- thread, B3 following a holding-job thread, B4 nothing to go on, B5 resting with two candidates.
 ('a7c00000-0000-4000-800d-000000000001', NULL, 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{"bucket_reason":"no_identity"}', '{"subject":"Gate","from":"Owner A <owner.a@pgc.example.test>","body":"The gate is sticking"}',
  '2031-03-05 02:00Z', '2031-03-05 02:00Z', '2031-03-05 02:00Z', '2031-03-05 02:00Z', 'admin_bucket', 6, 'none', 'unresolved', NULL, NULL, 'outlook:pgc-b1', NULL),
 ('a7c00000-0000-4000-800d-000000000002', NULL, 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{"bucket_reason":"no_identity"}', '{"subject":"Re: SWF-PGC02 quote","body":"Happy to go ahead with SWF-PGC02"}',
  '2031-03-06 02:00Z', '2031-03-06 02:00Z', '2031-03-06 02:00Z', '2031-03-06 02:00Z', 'admin_bucket', 6, 'none', 'unresolved', NULL, NULL, 'outlook:pgc-b2', NULL),
 ('a7c00000-0000-4000-800d-000000000003', NULL, 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{"bucket_reason":"no_identity"}', '{"subject":"Re: Statement","body":"Thanks"}',
  '2031-03-07 02:00Z', '2031-03-07 02:00Z', '2031-03-07 02:00Z', '2031-03-07 02:00Z', 'admin_bucket', 6, 'none', 'unresolved', NULL, NULL, 'outlook:pgc-hold-2', NULL),
 ('a7c00000-0000-4000-800d-000000000004', NULL, 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{"bucket_reason":"no_identity"}', '{"subject":"Hello","body":"Who do I talk to about a fence?"}',
  '2031-03-08 02:00Z', '2031-03-08 02:00Z', '2031-03-08 02:00Z', '2031-03-08 02:00Z', 'admin_bucket', 6, 'none', 'unresolved', NULL, NULL, 'outlook:pgc-b4', NULL),
 ('a7c00000-0000-4000-800d-000000000005', NULL, 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound', 'ctPGCb',
  '{"placement_rule":"review_several","capture_mode":"backfill"}', '{"body":"Which one is booked?"}',
  '2031-03-09 02:00Z', '2031-03-09 02:00Z', '2031-03-09 02:00Z', '2031-03-09 02:00Z', 'unplaced', 5, 'none', 'unresolved', NULL, NULL, NULL,
  ARRAY['a7c00000-0000-4000-8000-0000000000b2'::uuid, 'a7c00000-0000-4000-8000-0000000000b3'::uuid]);
INSERT INTO public.event_threads (thread_key, job_id, bound_by, bound_at, source_event_id) VALUES
 ('outlook:pgc-hold-1', 'a7c00000-0000-4000-8000-0000000000b0', 'ladder', '2031-02-20 02:00Z', 'a7c00000-0000-4000-800c-000000000001'),
 ('outlook:pgc-hold-2', 'a7c00000-0000-4000-8000-0000000000b0', 'ladder', '2031-02-21 02:00Z', 'a7c00000-0000-4000-800c-000000000002');
INSERT INTO public.event_threads (thread_key, job_id, bound_by, bound_at, source_event_id, retired_at, retired_reason) VALUES
 ('outlook:pgc-hold-old', 'a7c00000-0000-4000-8000-0000000000b0', 'ladder', '2031-01-20 02:00Z', NULL, '2031-01-21 02:00Z', 'conflict');
SQL
S0=$(snapshot)

WINDOW="'2026-10-07 04:00:00+00'::timestamptz=>'2031-03-15 04:00:00+00'::timestamptz"

# A script run with production's counts on the fixtures must refuse by its exact-count guard, and change nothing.
expect_refused() {
  if q -f "$1" > "$WORK/refused.log" 2>&1; then echo "FAIL: $3 ran" >&2; exit 1; fi
  grep -qF -- "$2" "$WORK/refused.log" || { echo "FAIL: $3 refused for another reason:" >&2; cat "$WORK/refused.log" >&2; exit 1; }
  echo "ok: $3"
}

echo "== misfile repair =="
expect_refused "$REPO_ROOT/scripts/context-placement-misfile-repair.sql" "expected 40, 30, 0; re-run PART 1" \
  "the repair as written refuses a plan of other counts"
expect_same "$(snapshot)" "$S0" "a refused repair changes nothing"
REPAIRSUB=("expected_move constant integer := 40;=>expected_move constant integer := 1;"
  "expected_review constant integer := 30;=>expected_review constant integer := 2;")
variant "$REPO_ROOT/scripts/context-placement-misfile-repair.sql" "$WORK/repair-dry.sql" rollback "${REPAIRSUB[@]}"
q -f "$WORK/repair-dry.sql" > "$WORK/repair-dry.log"
expect_same "$(snapshot)" "$S0" "the repair dry run passes its checks and changes nothing"
variant "$REPO_ROOT/scripts/context-placement-misfile-repair.sql" "$WORK/repair-commit.sql" commit "${REPAIRSUB[@]}"
q -f "$WORK/repair-commit.sql" > "$WORK/repair-commit.log"
expect_eq "SELECT count(*) FROM public.context_payload_job_mismatch_rows() m JOIN public.jobs j ON j.id = m.from_job_id
  WHERE coalesce(j.metadata->>'do_not_schedule','') IN ('true','1')" "0" "no misfile is left on the holding job"
expect_eq "SELECT job_id || ':' || attribution_status || ':' || contact_id || ':' || (metadata->>'capture_mode')
  FROM public.business_events WHERE id = 'a7c00000-0000-4000-800a-000000000001'" \
  "a7c00000-0000-4000-8000-0000000000b1:single_open:ctPGCa:relink" "the proven misfile moved to its job, as the ladder labels it"
expect_eq "SELECT string_agg(coalesce(job_id::text, '-') || ':' || attribution_status || ':' || array_to_string(candidate_job_ids, '+'), ',' ORDER BY id)
  FROM public.business_events WHERE id IN ('a7c00000-0000-4000-800a-000000000002', 'a7c00000-0000-4000-800a-000000000003')" \
  "-:unplaced:a7c00000-0000-4000-8000-0000000000b2+a7c00000-0000-4000-8000-0000000000b3,-:unplaced:a7c00000-0000-4000-8000-0000000000b4+a7c00000-0000-4000-8000-0000000000b5" \
  "the unproven misfiles rest in review with their candidates"
expect_eq "SELECT job_id FROM public.business_events WHERE id = 'a7c00000-0000-4000-800a-000000000004'" \
  "a7c00000-0000-4000-8000-0000000000b1" "a misfile not on a holding job is untouched"
S1=$(snapshot)

echo "== thread retire =="
expect_refused "$REPO_ROOT/scripts/context-holding-thread-retire.sql" "2 live bindings to holding jobs, expected 50" \
  "the retire as written refuses another count"
variant "$REPO_ROOT/scripts/context-holding-thread-retire.sql" "$WORK/retire-dry.sql" rollback \
  "expected_bindings constant integer := 50;=>expected_bindings constant integer := 2;"
q -f "$WORK/retire-dry.sql" > "$WORK/retire-dry.log"
expect_same "$(snapshot)" "$S1" "the retire dry run passes its checks and changes nothing"
variant "$REPO_ROOT/scripts/context-holding-thread-retire.sql" "$WORK/retire-commit.sql" commit \
  "expected_bindings constant integer := 50;=>expected_bindings constant integer := 2;"
q -f "$WORK/retire-commit.sql" > "$WORK/retire-commit.log"
expect_eq "SELECT count(*) FROM public.event_threads t JOIN public.jobs j ON j.id = t.job_id
  WHERE t.retired_at IS NULL AND coalesce(j.metadata->>'do_not_schedule','') IN ('true','1')" "0" "no live binding points at the holding job"
expect_eq "SELECT string_agg(thread_key, ',' ORDER BY thread_key COLLATE \"C\") FROM public.event_threads WHERE thread_key LIKE 'retired:holding_job:%'" \
  "retired:holding_job:outlook:pgc-hold-1,retired:holding_job:outlook:pgc-hold-2" "both holding bindings are re-keyed"
expect_eq "SELECT retired_at FROM public.event_threads WHERE thread_key = 'outlook:pgc-hold-old'" "2031-01-21 10:00:00+08" \
  "a binding retired before is untouched"
S2=$(snapshot)

echo "== bucket re-run =="
variant "$REPO_ROOT/scripts/context-bucket-rerun-l1g.sql" "$WORK/rerun-dry.sql" rollback "$WINDOW" \
  "expected_rows constant integer := 250;=>expected_rows constant integer := 6;"
q -f "$WORK/rerun-dry.sql" > "$WORK/rerun-dry.log"
expect_same "$(snapshot)" "$S2" "the re-run dry run changes nothing"
variant "$REPO_ROOT/scripts/context-bucket-rerun-l1g.sql" "$WORK/rerun-commit.sql" commit "$WINDOW" \
  "expected_rows constant integer := 250;=>expected_rows constant integer := 6;"
q -f "$WORK/rerun-commit.sql" > "$WORK/rerun-commit.log"
expect_eq "SELECT string_agg(right(id::text, 1) || ':' || coalesce(right(job_id::text, 2), '-') || ':' || attribution_status || ':' || coalesce(metadata->>'placement_rule', '-'), ',' ORDER BY id)
  FROM public.business_events WHERE id::text LIKE 'a7c00000-0000-4000-800d-%'" \
  "1:b1:single_open:identity_email,2:b2:direct:direct_ref,3:-:admin_bucket:no_contact,4:-:admin_bucket:no_contact,5:-:unplaced:review_several" \
  "the rules place the two rows the evidence proves and leave the rest"
expect_eq "SELECT job_id || ':' || source_event_id FROM public.event_threads WHERE thread_key = 'outlook:pgc-b2'" \
  "a7c00000-0000-4000-8000-0000000000b2:a7c00000-0000-4000-800d-000000000002" "the reference placement bound its thread"
expect_eq "SELECT count(*) FROM public.business_events e JOIN public.jobs j ON j.id = e.job_id
  WHERE e.id::text LIKE 'a7c00000-0000-4000-800d-%' AND coalesce(j.metadata->>'do_not_schedule','') IN ('true','1')" "0" \
  "no bucket row lands on the holding job"
# A bucket row the rules would place on a job other than the one its own payload names is a new known misfile: refused.
q -c "BEGIN; SET LOCAL session_replication_role = replica; INSERT INTO public.business_events (id, job_id, event_type, source, contact_id,
  metadata, payload, occurred_at, recorded_at, context_captured_at, event_at, attribution_status, attribution_step, match_method, match_status)
  VALUES ('a7c00000-0000-4000-800d-000000000009', NULL, 'client.reply', 'ghl_sms_cache_backfill', 'ctPGCa', '{}',
  '{\"ghl_contact_id\":\"ctPGCa\",\"job_id\":\"a7c00000-0000-4000-8000-0000000000b2\",\"body\":\"see you then\"}',
  '2031-03-10 02:00Z', '2031-03-10 02:00Z', '2031-03-10 02:00Z', '2031-03-10 02:00Z', 'admin_bucket', 6, 'none', 'unresolved'); COMMIT;"
variant "$REPO_ROOT/scripts/context-bucket-rerun-l1g.sql" "$WORK/rerun-misfile.sql" rollback "$WINDOW" \
  "expected_rows constant integer := 250;=>expected_rows constant integer := 1;"
if q -f "$WORK/rerun-misfile.sql" > "$WORK/rerun-misfile.log" 2>&1; then echo "FAIL: the re-run made a new known misfile" >&2; exit 1; fi
grep -q "new known misfiles); refusing" "$WORK/rerun-misfile.log"
echo "ok: the re-run refuses a placement off the row's own payload job"
q -c "DELETE FROM public.business_events WHERE id = 'a7c00000-0000-4000-800d-000000000009';"
q -c "BEGIN; SET LOCAL session_replication_role = replica; INSERT INTO public.event_threads (thread_key, job_id, bound_by, bound_at)
  VALUES ('outlook:pgc-relive', 'a7c00000-0000-4000-8000-0000000000b0', 'ladder', '2031-03-01Z'); COMMIT;"
if q -f "$WORK/rerun-dry.sql" > "$WORK/rerun-refused.log" 2>&1; then echo "FAIL: the re-run ran with a live holding binding" >&2; exit 1; fi
grep -q "commit scripts/context-holding-thread-retire.sql first" "$WORK/rerun-refused.log"
echo "ok: the re-run refuses while a live binding points at a holding job"
q -c "DELETE FROM public.event_threads WHERE thread_key = 'outlook:pgc-relive';"

echo "== undo, newest first =="
variant "$REPO_ROOT/scripts/context-bucket-rerun-l1g-undo.sql" "$WORK/rerun-undo.sql" commit \
  "expected_rows constant integer := 0;=>expected_rows constant integer := 6;"
q -f "$WORK/rerun-undo.sql" > "$WORK/rerun-undo.log"
expect_same "$(snapshot)" "$S2" "the re-run undo restores every row and binding"
variant "$REPO_ROOT/scripts/context-holding-thread-retire-undo.sql" "$WORK/retire-undo.sql" commit \
  "expected_rows constant integer := 50;=>expected_rows constant integer := 2;"
q -f "$WORK/retire-undo.sql" > "$WORK/retire-undo.log"
expect_same "$(snapshot)" "$S1" "the retire undo restores both bindings"
variant "$REPO_ROOT/scripts/context-placement-misfile-repair-undo.sql" "$WORK/repair-undo.sql" commit \
  "expected_rows constant integer := 70;=>expected_rows constant integer := 3;"
q -f "$WORK/repair-undo.sql" > "$WORK/repair-undo.log"
expect_same "$(snapshot)" "$S0" "the repair undo restores every row exactly, party roles included"

echo "== grades load =="
GRADES='[{"sample_id":"placement-20260901t040000z-n120-d30","as_of":"2026-09-01T04:00:00Z","event_id":"a7c00000-0000-4000-800a-000000000004","placed_job_id":"a7c00000-0000-4000-8000-0000000000b1","stratum":"single_open","stratum_rows":60,"verdict":"wrong","reason":"other_job","right_job_id":"a7c00000-0000-4000-8000-0000000000b2","grader":"grader-1","graded_at":"2026-09-01T05:00:00Z"},{"sample_id":"placement-20260901t040000z-n120-d30","as_of":"2026-09-01T04:00:00Z","event_id":"a7c00000-0000-4000-800d-000000000005","placed_job_id":"a7c00000-0000-4000-8000-0000000000b2","stratum":"single_open","stratum_rows":60,"verdict":"right","reason":null,"right_job_id":null,"grader":"grader-1","graded_at":"2026-09-01T05:00:00Z"}]'
variant "$REPO_ROOT/scripts/context-placement-grades-load.sql" "$WORK/load-commit.sql" commit \
  "'[]'::jsonb AS grades=>'$GRADES'::jsonb AS grades" \
  "expected_sample_id constant text := 'placement-YYYYMMDDtHHMMSSz-n120-d30';=>expected_sample_id constant text := 'placement-20260901t040000z-n120-d30';" \
  "expected_rows constant integer := 120;=>expected_rows constant integer := 2;"
q -f "$WORK/load-commit.sql" > "$WORK/load-commit.log"
expect_eq "SELECT sample_id || ':' || graded || ':' || right_count || ':' || wrong_count || ':' || right_share FROM public.context_placement_grades_newest(now())" \
  "placement-20260901t040000z-n120-d30:2:1:1:0.5000" "a loaded sample is the newest, 1 right of 2"
if q -f "$WORK/load-commit.sql" > "$WORK/load-again.log" 2>&1; then echo "FAIL: one sample loaded twice" >&2; exit 1; fi
grep -q "is already loaded" "$WORK/load-again.log"; echo "ok: a second load of one sample refuses"
variant "$REPO_ROOT/scripts/context-placement-grades-load-undo.sql" "$WORK/load-undo.sql" commit \
  "expected_sample_id constant text := 'placement-YYYYMMDDtHHMMSSz-n120-d30';=>expected_sample_id constant text := 'placement-20260901t040000z-n120-d30';" \
  "expected_rows constant integer := 120;=>expected_rows constant integer := 2;"
q -f "$WORK/load-undo.sql" > "$WORK/load-undo.log"
expect_same "$(snapshot)" "$S0" "the load undo removes the sample"

echo "row 3 script proofs passed"

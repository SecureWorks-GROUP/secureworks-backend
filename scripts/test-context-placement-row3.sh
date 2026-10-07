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
# (the database must read byte for byte as before). Each guard is also shown to
# refuse: a copy of the script with the guarded step taken out is run and must
# stop. Never point it at anything but a disposable database: it drops and
# recreates its own.
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
valq() { psql "$URL" -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }
snapshot() {
  val "SELECT md5(coalesce((SELECT string_agg(to_jsonb(e)::text, '|' ORDER BY e.id) FROM public.business_events e), '')
        || coalesce((SELECT string_agg(to_jsonb(t)::text, '|' ORDER BY t.thread_key COLLATE \"C\") FROM public.event_threads t), '')
        || coalesce((SELECT string_agg(to_jsonb(g)::text, '|' ORDER BY g.id) FROM public.context_placement_grades g), '')
        || coalesce((SELECT string_agg(to_jsonb(a)::text, '|' ORDER BY a.proposal_id) FROM public.ai_proposed_actions a), '')
        || coalesce((SELECT string_agg(to_jsonb(s)::text, '|' ORDER BY s.id) FROM public.smart_nudges s), ''))"
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
expect_eqq() { local got; got=$(valq "$1"); if [ "$got" != "$2" ]; then echo "FAIL: $3 (got '$got', want '$2')" >&2; exit 1; fi; echo "ok: $3"; }
# One field of PART 1's measurement (the JSON object it prints), read as JSON.
preview_field() {
  python3 - "$1" "$2" <<'PY2'
import json, sys
log, path = sys.argv[1], sys.argv[2]
for line in open(log):
    line = line.strip()
    if line.startswith('{') and '"model_queue"' in line:
        v = json.loads(line)
        for k in path.split('.'):
            v = v[k]
        print(json.dumps(v, sort_keys=True))
        break
else:
    sys.exit('no measurement in ' + log)
PY2
}
expect_preview() { local got; got=$(preview_field "$1" "$2"); if [ "$got" != "$3" ]; then echo "FAIL: $4 (got '$got', want '$3')" >&2; exit 1; fi; echo "ok: $4"; }
# A script that must stop: it fails, for the named reason, and changes nothing.
expect_refused() {
  local before; before=$(snapshot)
  if q -f "$1" > "$WORK/refused.log" 2>&1; then echo "FAIL: $3 ran" >&2; exit 1; fi
  grep -qF -- "$2" "$WORK/refused.log" || { echo "FAIL: $3 refused for another reason:" >&2; cat "$WORK/refused.log" >&2; exit 1; }
  expect_same "$(snapshot)" "$before" "$3 (and changes nothing)"
}

echo "== building $DB from the registered contract stack =="
psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);" -c "CREATE DATABASE \"$DB\";"
for d in "$CONTRACT_ROOT"/20*; do
  n=$(basename "$d")
  q -f "$d/setup.sql" >/dev/null 2>&1 || { echo "setup failed: $n" >&2; q -f "$d/setup.sql"; exit 1; }
  q -f "$REPO_ROOT/supabase/migrations/$n.sql" >/dev/null 2>&1 || { echo "migration failed: $n" >&2; q -f "$REPO_ROOT/supabase/migrations/$n.sql"; exit 1; }
done

echo "== fixtures (synthetic, pinned to March 2031; the graded draw to August 2026) =="
q <<'SQL'
-- The follow-ups the Jarvis listener would cancel, as production keeps them (only the columns its query reads).
CREATE TABLE IF NOT EXISTS public.ai_proposed_actions (proposal_id uuid PRIMARY KEY, job_id uuid, action_type text, status text,
 created_at timestamptz);
CREATE TABLE IF NOT EXISTS public.smart_nudges (id uuid PRIMARY KEY, job_id uuid, status text, created_at timestamptz);
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
 match_confidence, thread_key, candidate_job_ids, provider_message_id) VALUES
 -- Text-cache misfiles on the holding job: move, review, review with the ladder disagreeing, two copies whose message the
 -- history load already saved (placed on the job named; waiting for review), and one elsewhere.
 ('a7c00000-0000-4000-800a-000000000001', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, NULL,
  '{"party_roles":{"version":"party_roles_v3","sender_role":"unknown","recipient_role":"staff","counterpart_role":"unknown","basis":"no_match","audience":"unknown"}}',
  '{"ghl_contact_id":"ctPGCa","ghl_message_id":"pgc-m1","job_id":"a7c00000-0000-4000-8000-0000000000b1","body":"Thanks, see you Monday","direction":"inbound"}',
  '2031-03-01 02:00Z', '2031-03-01 02:05Z', '2031-03-01 02:05Z', '2031-03-01 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL, NULL, NULL),
 ('a7c00000-0000-4000-800a-000000000002', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, NULL,
  '{"party_roles":{"version":"party_roles_v3","sender_role":"unknown","recipient_role":"staff","counterpart_role":"unknown","basis":"no_match","audience":"unknown"}}',
  '{"ghl_contact_id":"ctPGCb","ghl_message_id":"pgc-m2","job_id":"a7c00000-0000-4000-8000-0000000000b2","body":"Which day works?","direction":"inbound"}',
  '2031-03-02 02:00Z', '2031-03-02 02:05Z', '2031-03-02 02:05Z', '2031-03-02 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL, NULL, NULL),
 ('a7c00000-0000-4000-800a-000000000003', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', NULL,
  '{"party_roles":{"version":"party_roles_v3","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"no_match","audience":"customer"}}',
  '{"ghl_contact_id":"ctPGCc","ghl_message_id":"pgc-m3","job_id":"a7c00000-0000-4000-8000-0000000000b5","body":"Can you quote the side fence too?","direction":"inbound"}',
  '2031-01-05 02:00Z', '2031-01-05 02:05Z', '2031-01-05 02:05Z', '2031-01-05 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL, NULL, NULL),
 ('a7c00000-0000-4000-800a-000000000004', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, 'ctPGCa',
  '{}', '{"ghl_contact_id":"ctPGCa","job_id":"a7c00000-0000-4000-8000-0000000000b2","body":"ok"}',
  '2031-03-04 02:00Z', '2031-03-04 02:05Z', '2031-03-04 02:05Z', '2031-03-04 02:00Z', 'single_open', 3, 'contact_id', 'matched', 1, 1, NULL, NULL, NULL),
 ('a7c00000-0000-4000-800a-000000000005', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, NULL,
  '{"party_roles":{"version":"party_roles_v3","sender_role":"unknown","recipient_role":"staff","counterpart_role":"unknown","basis":"no_match","audience":"unknown"}}',
  '{"ghl_contact_id":"ctPGCa","ghl_message_id":"pgc-m5","job_id":"a7c00000-0000-4000-8000-0000000000b1","body":"See you at eight","direction":"inbound"}',
  '2031-03-01 03:00Z', '2031-03-01 03:05Z', '2031-03-01 03:05Z', '2031-03-01 03:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL, NULL, NULL),
 ('a7c00000-0000-4000-800a-000000000006', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, NULL,
  '{"party_roles":{"version":"party_roles_v3","sender_role":"unknown","recipient_role":"staff","counterpart_role":"unknown","basis":"no_match","audience":"unknown"}}',
  '{"ghl_contact_id":"ctPGCb","ghl_message_id":"pgc-m6","job_id":"a7c00000-0000-4000-8000-0000000000b2","body":"Both quotes please","direction":"inbound"}',
  '2031-03-02 03:00Z', '2031-03-02 03:05Z', '2031-03-02 03:05Z', '2031-03-02 03:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL, NULL, NULL),
 -- The history load's keyed rows of those two texts: one placed and read on the job named, one waiting for review.
 ('a7c00000-0000-4000-800e-000000000005', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl-history-load', 'sms', 'inbound', 'ctPGCa',
  '{"capture_mode":"backfill"}', '{"body":"See you at eight"}',
  '2031-03-01 03:00Z', '2031-03-05 00:00Z', '2031-03-05 00:00Z', '2031-03-01 03:00Z', 'single_open', 3, 'contact_id', 'matched', 1, 1, NULL, NULL, 'ghl:pgc-m5'),
 ('a7c00000-0000-4000-800e-000000000006', NULL, 'client.reply', 'ghl-history-load', 'sms', 'inbound', 'ctPGCb',
  '{"capture_mode":"backfill"}', '{"body":"Both quotes please"}',
  '2031-03-02 03:00Z', '2031-03-05 00:00Z', '2031-03-05 00:00Z', '2031-03-02 03:00Z', 'pending_luna', 5, 'none', 'unresolved', NULL, NULL, NULL,
  ARRAY['a7c00000-0000-4000-8000-0000000000b2'::uuid, 'a7c00000-0000-4000-8000-0000000000b3'::uuid], 'ghl:pgc-m6'),
 -- Group mail on the holding job that bound two threads.
 ('a7c00000-0000-4000-800c-000000000001', 'a7c00000-0000-4000-8000-0000000000b0', 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{}', '{"subject":"Invoice copy","body":"Please find attached"}',
  '2031-02-20 02:00Z', '2031-02-20 02:00Z', '2031-02-20 02:00Z', '2031-02-20 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, 'outlook:pgc-hold-1', NULL, NULL),
 ('a7c00000-0000-4000-800c-000000000002', 'a7c00000-0000-4000-8000-0000000000b0', 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{}', '{"subject":"Statement","body":"Statement attached"}',
  '2031-02-21 02:00Z', '2031-02-21 02:00Z', '2031-02-21 02:00Z', '2031-02-21 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, 'outlook:pgc-hold-2', NULL, NULL),
 -- The bucket: B1 an email from job one's client (the rules read payload.from), B2 naming SWF-PGC02 on its own thread,
 -- B3 following a holding-job thread, B4 nothing to go on, B5 history resting with two candidates, B6 a live customer
 -- text from job one's client (placed: must be history to the listener), B7 a live text Luna already answered (the
 -- rules would ask Luna again), B8 a key-less copy of a text the history load already placed.
 ('a7c00000-0000-4000-800d-000000000001', NULL, 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{"bucket_reason":"no_identity"}', '{"subject":"Gate","from":"Owner A <owner.a@pgc.example.test>","body":"The gate is sticking"}',
  '2031-03-05 02:00Z', '2031-03-05 02:00Z', '2031-03-05 02:00Z', '2031-03-05 02:00Z', 'admin_bucket', 6, 'none', 'unresolved', NULL, NULL, 'outlook:pgc-b1', NULL, NULL),
 ('a7c00000-0000-4000-800d-000000000002', NULL, 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{"bucket_reason":"no_identity"}', '{"subject":"Re: SWF-PGC02 quote","body":"Happy to go ahead with SWF-PGC02"}',
  '2031-03-06 02:00Z', '2031-03-06 02:00Z', '2031-03-06 02:00Z', '2031-03-06 02:00Z', 'admin_bucket', 6, 'none', 'unresolved', NULL, NULL, 'outlook:pgc-b2', NULL, NULL),
 ('a7c00000-0000-4000-800d-000000000003', NULL, 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{"bucket_reason":"no_identity"}', '{"subject":"Re: Statement","body":"Thanks"}',
  '2031-03-07 02:00Z', '2031-03-07 02:00Z', '2031-03-07 02:00Z', '2031-03-07 02:00Z', 'admin_bucket', 6, 'none', 'unresolved', NULL, NULL, 'outlook:pgc-hold-2', NULL, NULL),
 ('a7c00000-0000-4000-800d-000000000004', NULL, 'client.email_in', 'monitor-inbox-group', 'email', 'inbound', NULL,
  '{"bucket_reason":"no_identity"}', '{"subject":"Hello","body":"Who do I talk to about a fence?"}',
  '2031-03-08 02:00Z', '2031-03-08 02:00Z', '2031-03-08 02:00Z', '2031-03-08 02:00Z', 'admin_bucket', 6, 'none', 'unresolved', NULL, NULL, 'outlook:pgc-b4', NULL, NULL),
 ('a7c00000-0000-4000-800d-000000000005', NULL, 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound', 'ctPGCb',
  '{"placement_rule":"review_several","capture_mode":"backfill"}', '{"body":"Which one is booked?"}',
  '2031-03-09 02:00Z', '2031-03-09 02:00Z', '2031-03-09 02:00Z', '2031-03-09 02:00Z', 'unplaced', 5, 'none', 'unresolved', NULL, NULL, NULL,
  ARRAY['a7c00000-0000-4000-8000-0000000000b2'::uuid, 'a7c00000-0000-4000-8000-0000000000b3'::uuid], NULL),
 ('a7c00000-0000-4000-800d-000000000006', NULL, 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound', 'ctPGCa',
  '{"capture_mode":"live","bucket_reason":"no_candidate_at_time"}', '{"body":"Is the gate going in this week?"}',
  '2031-03-10 01:00Z', '2031-03-10 01:00Z', '2031-03-10 01:00Z', '2031-03-10 01:00Z', 'admin_bucket', 6, 'none', 'unresolved', NULL, NULL, NULL, NULL, NULL),
 ('a7c00000-0000-4000-800d-000000000007', NULL, 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound', 'ctPGCb',
  '{"capture_mode":"live","placement_rule":"review_several","luna_outcome":"several"}', '{"body":"Can you send it again?"}',
  '2031-03-10 02:00Z', '2031-03-10 02:00Z', '2031-03-10 02:00Z', '2031-03-10 02:00Z', 'unplaced', 5, 'none', 'unresolved', NULL, NULL, NULL,
  ARRAY['a7c00000-0000-4000-8000-0000000000b2'::uuid, 'a7c00000-0000-4000-8000-0000000000b3'::uuid], NULL),
 ('a7c00000-0000-4000-800d-000000000008', NULL, 'client.reply', 'ghl-proxy', 'sms', 'inbound', 'ctPGCa',
  '{"bucket_reason":"no_candidate_at_time"}', '{"ghl_message_id":"pgc-m8","body":"Running late"}',
  '2031-03-10 03:00Z', '2031-03-10 03:00Z', '2031-03-10 03:00Z', '2031-03-10 03:00Z', 'admin_bucket', 6, 'none', 'unresolved', NULL, NULL, NULL, NULL, NULL),
 ('a7c00000-0000-4000-800e-000000000008', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl-history-load', 'sms', 'inbound', 'ctPGCa',
  '{"capture_mode":"backfill"}', '{"body":"Running late"}',
  '2031-03-10 03:00Z', '2031-03-11 00:00Z', '2031-03-11 00:00Z', '2031-03-10 03:00Z', 'single_open', 3, 'contact_id', 'matched', 1, 1, NULL, NULL, 'ghl:pgc-m8'),
 -- The graded draw's population: three placed customer texts of August 2026 (before any wall clock this runs on).
 ('a7c00000-0000-4000-800f-000000000001', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound', 'ctPGCa',
  '{"capture_mode":"live","party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}', '{"body":"Thanks"}',
  '2026-08-20 01:00Z', '2026-08-20 01:00Z', '2026-08-20 01:00Z', '2026-08-20 01:00Z', 'single_open', 3, 'contact_id', 'matched', 1, 1, NULL, NULL, NULL),
 ('a7c00000-0000-4000-800f-000000000002', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound', 'ctPGCa',
  '{"capture_mode":"live","party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}', '{"body":"Yes please"}',
  '2026-08-21 01:00Z', '2026-08-21 01:00Z', '2026-08-21 01:00Z', '2026-08-21 01:00Z', 'single_open', 3, 'contact_id', 'matched', 1, 1, NULL, NULL, NULL),
 ('a7c00000-0000-4000-800f-000000000003', 'a7c00000-0000-4000-8000-0000000000b2', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound', 'ctPGCb',
  '{"capture_mode":"live","party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}', '{"body":"See you"}',
  '2026-08-22 01:00Z', '2026-08-22 01:00Z', '2026-08-22 01:00Z', '2026-08-22 01:00Z', 'single_open', 3, 'contact_id', 'matched', 1, 1, NULL, NULL, NULL);
INSERT INTO public.event_threads (thread_key, job_id, bound_by, bound_at, source_event_id) VALUES
 ('outlook:pgc-hold-1', 'a7c00000-0000-4000-8000-0000000000b0', 'ladder', '2031-02-20 02:00Z', 'a7c00000-0000-4000-800c-000000000001'),
 ('outlook:pgc-hold-2', 'a7c00000-0000-4000-8000-0000000000b0', 'ladder', '2031-02-21 02:00Z', 'a7c00000-0000-4000-800c-000000000002');
INSERT INTO public.event_threads (thread_key, job_id, bound_by, bound_at, source_event_id, retired_at, retired_reason) VALUES
 ('outlook:pgc-hold-old', 'a7c00000-0000-4000-8000-0000000000b0', 'ladder', '2031-01-20 02:00Z', NULL, '2031-01-21 02:00Z', 'conflict');
-- A pending proposal and a nudge on job one, where the bucket re-run places B1 and B6.
INSERT INTO public.ai_proposed_actions (proposal_id, job_id, action_type, status, created_at) VALUES
 ('a7c00000-0000-4000-8010-000000000001', 'a7c00000-0000-4000-8000-0000000000b1', 'deposit_followup', 'pending', '2031-03-12 00:00Z');
INSERT INTO public.smart_nudges (id, job_id, status, created_at) VALUES
 ('a7c00000-0000-4000-8011-000000000001', 'a7c00000-0000-4000-8000-0000000000b1', 'pending', '2031-03-12 00:00Z');
SQL
S0=$(snapshot)

WINDOW="'2026-10-07 04:00:00+00'::timestamptz=>'2031-03-15 04:00:00+00'::timestamptz"

echo "== misfile repair =="
expect_refused "$REPO_ROOT/scripts/context-placement-misfile-repair.sql" "expected 12, 18, 40, 0; re-run PART 1" \
  "the repair as written refuses a plan of other counts"
REPAIRSUB=("expected_move constant integer := 12;=>expected_move constant integer := 1;"
  "expected_review constant integer := 18;=>expected_review constant integer := 2;"
  "expected_duplicate constant integer := 40;=>expected_duplicate constant integer := 2;")
variant "$REPO_ROOT/scripts/context-placement-misfile-repair.sql" "$WORK/repair-dry.sql" rollback "${REPAIRSUB[@]}"
q -f "$WORK/repair-dry.sql" > "$WORK/repair-dry.log"
expect_same "$(snapshot)" "$S0" "the repair dry run passes its checks and changes nothing"
# Its copy guard: with the copies planned as moves, the repair would make a second live copy and must stop.
variant "$REPO_ROOT/scripts/context-placement-misfile-repair.sql" "$WORK/repair-nocopy.sql" rollback "${REPAIRSUB[@]}" \
  "expected_move constant integer := 1;=>expected_move constant integer := 2;" \
  "expected_duplicate constant integer := 2;=>expected_duplicate constant integer := 1;" \
  "SELECT p.* FROM public.context_placement_misfile_plan() p WHERE p.event_id IN (SELECT l.id FROM mr_locked l);=>SELECT p.event_id, p.from_job_id, p.payload_job_id, p.mismatch_class, p.on_holding_job, CASE WHEN p.duplicate_of = 'a7c00000-0000-4000-800e-000000000005' THEN 'move' ELSE p.plan END AS plan, p.to_job_id, p.candidate_job_ids, p.contact_id, CASE WHEN p.duplicate_of = 'a7c00000-0000-4000-800e-000000000005' THEN NULL ELSE p.duplicate_of END AS duplicate_of, p.set_aside_payload_job, p.decided FROM public.context_placement_misfile_plan() p WHERE p.event_id IN (SELECT l.id FROM mr_locked l);"
expect_refused "$WORK/repair-nocopy.sql" "would be a second live copy of a message already read" \
  "the repair refuses to make a second live copy of a text already on its job"
variant "$REPO_ROOT/scripts/context-placement-misfile-repair.sql" "$WORK/repair-commit.sql" commit "${REPAIRSUB[@]}"
q -f "$WORK/repair-commit.sql" > "$WORK/repair-commit.log"
expect_eq "SELECT count(*) FROM public.context_payload_job_mismatch_rows() m JOIN public.jobs j ON j.id = m.from_job_id
  WHERE coalesce(j.metadata->>'do_not_schedule','') IN ('true','1')" "0" "no misfile is left on the holding job"
expect_eq "SELECT job_id || ':' || attribution_status || ':' || contact_id || ':' || (metadata->>'capture_mode') || ':' || (payload->>'job_id')
  FROM public.business_events WHERE id = 'a7c00000-0000-4000-800a-000000000001'" \
  "a7c00000-0000-4000-8000-0000000000b1:single_open:ctPGCa:relink:a7c00000-0000-4000-8000-0000000000b1" \
  "the proven misfile moved to its job, as the ladder labels it, its payload job kept"
expect_eq "SELECT string_agg(coalesce(job_id::text, '-') || ':' || attribution_status || ':' || array_to_string(candidate_job_ids, '+')
  || ':' || (payload ? 'job_id')::text || ':' || (metadata->'placement_repaired'->>'payload_job_set_aside'), ',' ORDER BY id)
  FROM public.business_events WHERE id IN ('a7c00000-0000-4000-800a-000000000002', 'a7c00000-0000-4000-800a-000000000003')" \
  "-:unplaced:a7c00000-0000-4000-8000-0000000000b2+a7c00000-0000-4000-8000-0000000000b3:false:a7c00000-0000-4000-8000-0000000000b2,-:unplaced:a7c00000-0000-4000-8000-0000000000b4+a7c00000-0000-4000-8000-0000000000b5:false:a7c00000-0000-4000-8000-0000000000b5" \
  "the unproven misfiles rest in review with their candidates, the guessed payload job set aside"
expect_eq "SELECT string_agg(coalesce(job_id::text, '-') || ':' || coalesce(attribution_status, '-') || ':' || (metadata->>'duplicate_of')
  || ':' || public.context_event_source_admissible(e)::text || ':' || (payload ? 'job_id')::text || ':' || (metadata->>'capture_mode'), ',' ORDER BY id)
  FROM public.business_events e WHERE id IN ('a7c00000-0000-4000-800a-000000000005', 'a7c00000-0000-4000-800a-000000000006')" \
  "a7c00000-0000-4000-8000-0000000000b1:single_open:a7c00000-0000-4000-800e-000000000005:false:true:relink,-:-:a7c00000-0000-4000-800e-000000000006:false:false:relink" \
  "a copy goes where its twin is, marked and never read: on the twin's job, or off every job and queue while the twin waits"
expect_eq "SELECT (SELECT count(*) FROM public.context_job_record_messages(ARRAY['a7c00000-0000-4000-8000-0000000000b1'::uuid], '2031-03-20Z') m
   WHERE m.source_id IN ('a7c00000-0000-4000-800a-000000000005', 'a7c00000-0000-4000-800e-000000000005'))
  || ':' || (SELECT count(*) FROM public.context_ledger_evidence_rows(ARRAY['a7c00000-0000-4000-8000-0000000000b1'::uuid], '2031-03-20Z') l
   WHERE l.src_id IN ('a7c00000-0000-4000-800a-000000000005', 'a7c00000-0000-4000-800e-000000000005'))" \
  "1:1" "the job story and the ledger evidence read the text once"
expect_eq "SELECT count(*) FROM public.business_events WHERE job_id IS NULL AND attribution_status IN ('admin_bucket','unplaced','pending_luna')
  AND (payload->>'ghl_message_id' = 'pgc-m6' OR provider_message_id = 'ghl:pgc-m6')" "1" "the waiting text is queued once, not twice"
# A reviewer who picks the candidate the backfill did not guess places a row every reader reads and no misfile.
expect_eqq "BEGIN; UPDATE public.business_events SET job_id = 'a7c00000-0000-4000-8000-0000000000b3', attribution_status = 'direct',
   attribution_confidence = 1, match_status = 'matched', match_method = 'manual' WHERE id = 'a7c00000-0000-4000-800a-000000000002';
  SELECT public.context_event_source_admissible(e)::text || ':' || (SELECT count(*) FROM public.context_payload_job_mismatch_rows() m WHERE m.id = e.id)
  FROM public.business_events e WHERE e.id = 'a7c00000-0000-4000-800a-000000000002'; ROLLBACK;" "true:0" \
  "a review row placed on a candidate other than the old guess is read and is no new misfile"
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
expect_eq "SELECT retired_at = '2031-01-21 02:00Z' FROM public.event_threads WHERE thread_key = 'outlook:pgc-hold-old'" "t" \
  "a binding retired before is untouched"
S2=$(snapshot)

echo "== bucket re-run =="
# In the window after the repair: the eight bucket rows, the review row the repair rested there (its sibling in review
# was captured before the window), and the history load's waiting copy of the queued text.
RERUNSUB=("$WINDOW" "expected_rows constant integer := 250;=>expected_rows constant integer := 10;")
variant "$REPO_ROOT/scripts/context-bucket-rerun-l1g.sql" "$WORK/rerun-dry.sql" rollback "${RERUNSUB[@]}"
q -f "$WORK/rerun-dry.sql" > "$WORK/rerun-dry.log"
expect_same "$(snapshot)" "$S2" "the re-run dry run changes nothing"
expect_preview "$WORK/rerun-dry.log" listener_without_stamp \
  '{"jobs": 1, "pending_nudges": 1, "pending_proposals": 1, "placed_live_customer_texts": 1}' \
  "PART 1 reports the proposals and nudges on the jobs a live customer text would be placed on"
expect_preview "$WORK/rerun-dry.log" model_queue \
  '{"kept_luna_answered": 1, "leave": 1, "new_asks": 0, "new_asks_already_answered": 0, "stay": 0, "waiting_after": 0, "waiting_before": 1}' \
  "PART 1 reports the model queue: who leaves it, the new asks and the Luna-answered rows kept out of it"
expect_preview "$WORK/rerun-dry.log" outcome '{"copy_marked": 1, "kept_luna_answered": 1, "off_job": 5, "placed": 3}' \
  "PART 1 reports each row's outcome: placed, off a job, a copy marked, a Luna answer kept"
# Each guard stops a batch that would break it: no relink stamp, no copy check, no Luna rule.
variant "$REPO_ROOT/scripts/context-bucket-rerun-l1g.sql" "$WORK/rerun-nostamp.sql" rollback "${RERUNSUB[@]}" \
  "jsonb_build_object('capture_mode', 'relink',=>jsonb_build_object('capture_mode_unused', 'relink',"
expect_refused "$WORK/rerun-nostamp.sql" "would read as new placements to the Jarvis listener and the reader" \
  "the re-run refuses a placed row the Jarvis listener would read as a new placement"
variant "$REPO_ROOT/scripts/context-bucket-rerun-l1g.sql" "$WORK/rerun-nocopy.sql" rollback "${RERUNSUB[@]}" \
  "IF v_twin_state = 'placed' THEN=>IF false THEN"
expect_refused "$WORK/rerun-nocopy.sql" "would be a second live copy of a message already read" \
  "the re-run refuses to place a copy of a text already on its job"
variant "$REPO_ROOT/scripts/context-bucket-rerun-l1g.sql" "$WORK/rerun-noluna.sql" rollback "${RERUNSUB[@]}" \
  "IF r.attribution_status = 'pending_luna' AND coalesce(e.metadata, '{}'::jsonb) ? 'luna_outcome' THEN=>IF false THEN"
expect_refused "$WORK/rerun-noluna.sql" "rows Luna already answered would be asked again" \
  "the re-run refuses to send a row Luna already answered back to Luna"
variant "$REPO_ROOT/scripts/context-bucket-rerun-l1g.sql" "$WORK/rerun-commit.sql" commit "${RERUNSUB[@]}"
q -f "$WORK/rerun-commit.sql" > "$WORK/rerun-commit.log"
expect_eq "SELECT string_agg(right(id::text, 1) || ':' || coalesce(right(job_id::text, 2), '-') || ':' || attribution_status || ':'
  || coalesce(metadata->>'placement_rule', '-') || ':' || coalesce(metadata->>'capture_mode', '-') || ':' || coalesce(metadata->'bucket_rerun'->>'kept', '-'), ',' ORDER BY id)
  FROM public.business_events WHERE id::text LIKE 'a7c00000-0000-4000-800d-%'" \
  "1:b1:single_open:identity_email:relink:-,2:b2:direct:direct_ref:relink:-,3:-:admin_bucket:no_contact:-:-,4:-:admin_bucket:no_contact:-:-,5:-:unplaced:review_several:backfill:-,6:b1:single_open:single_open:relink:-,7:-:unplaced:review_several:live:luna_answered,8:-:admin_bucket:-:-:copy_marked" \
  "the rules place the rows the evidence proves, as history, keep Luna's answer and mark the copy, and leave the rest"
expect_eq "SELECT string_agg(right(id::text, 1) || ':' || coalesce(metadata->>'capture_mode_before', '-'), ',' ORDER BY id)
  FROM public.business_events WHERE id IN ('a7c00000-0000-4000-800d-000000000001', 'a7c00000-0000-4000-800d-000000000006')" \
  "1:live,6:live" "a placed row keeps its mode before"
expect_eq "SELECT (metadata->>'duplicate_of') || ':' || public.context_event_source_admissible(e)::text || ':' || coalesce(job_id::text, '-')
  FROM public.business_events e WHERE id = 'a7c00000-0000-4000-800d-000000000008'" \
  "a7c00000-0000-4000-800e-000000000008:false:-" "the key-less copy is marked a copy of the text already placed, and stays where it was"
expect_eq "SELECT attribution_status || ':' || array_to_string(candidate_job_ids, '+') FROM public.business_events WHERE id = 'a7c00000-0000-4000-800d-000000000007'" \
  "unplaced:a7c00000-0000-4000-8000-0000000000b2+a7c00000-0000-4000-8000-0000000000b3" "the row Luna answered stays exactly as Luna left it"
expect_eq "SELECT string_agg(right(id::text, 1) || ':' || coalesce(job_id::text, '-') || ':' || attribution_status, ',' ORDER BY id)
  FROM public.business_events WHERE id IN ('a7c00000-0000-4000-800a-000000000002', 'a7c00000-0000-4000-800e-000000000006')" \
  "2:-:unplaced,6:-:unplaced" "history rows waiting for Luna rest unplaced, never asked"
expect_eq "SELECT job_id || ':' || source_event_id FROM public.event_threads WHERE thread_key = 'outlook:pgc-b2'" \
  "a7c00000-0000-4000-8000-0000000000b2:a7c00000-0000-4000-800d-000000000002" "the reference placement bound its thread"
expect_eq "SELECT count(*) FROM public.business_events e JOIN public.jobs j ON j.id = e.job_id
  WHERE e.id::text LIKE 'a7c00000-0000-4000-800d-%' AND coalesce(j.metadata->>'do_not_schedule','') IN ('true','1')" "0" \
  "no bucket row lands on the holding job"
expect_eq "SELECT (SELECT string_agg(status, ',') FROM public.ai_proposed_actions) || ':' || (SELECT string_agg(status, ',') FROM public.smart_nudges)" \
  "pending:pending" "the follow-ups waiting on the job the customer text was placed on are left as they are"
# A bucket row the rules would place on a job other than the one its own payload names is a new known misfile: refused.
q -c "BEGIN; SET LOCAL session_replication_role = replica; INSERT INTO public.business_events (id, job_id, event_type, source, contact_id,
  metadata, payload, occurred_at, recorded_at, context_captured_at, event_at, attribution_status, attribution_step, match_method, match_status)
  VALUES ('a7c00000-0000-4000-800d-000000000009', NULL, 'client.reply', 'ghl_sms_cache_backfill', 'ctPGCa', '{}',
  '{\"ghl_contact_id\":\"ctPGCa\",\"job_id\":\"a7c00000-0000-4000-8000-0000000000b2\",\"body\":\"see you then\"}',
  '2031-03-10 02:00Z', '2031-03-10 02:00Z', '2031-03-10 02:00Z', '2031-03-10 02:00Z', 'admin_bucket', 6, 'none', 'unresolved'); COMMIT;"
variant "$REPO_ROOT/scripts/context-bucket-rerun-l1g.sql" "$WORK/rerun-misfile.sql" rollback "$WINDOW" \
  "expected_rows constant integer := 250;=>expected_rows constant integer := 1;"
expect_refused "$WORK/rerun-misfile.sql" "new known misfiles); refusing" "the re-run refuses a placement off the row's own payload job"
q -c "DELETE FROM public.business_events WHERE id = 'a7c00000-0000-4000-800d-000000000009';"
q -c "BEGIN; SET LOCAL session_replication_role = replica; INSERT INTO public.event_threads (thread_key, job_id, bound_by, bound_at)
  VALUES ('outlook:pgc-relive', 'a7c00000-0000-4000-8000-0000000000b0', 'ladder', '2031-03-01Z'); COMMIT;"
expect_refused "$WORK/rerun-dry.sql" "commit scripts/context-holding-thread-retire.sql first" \
  "the re-run refuses while a live binding points at a holding job"
q -c "DELETE FROM public.event_threads WHERE thread_key = 'outlook:pgc-relive';"

echo "== undo, newest first =="
variant "$REPO_ROOT/scripts/context-bucket-rerun-l1g-undo.sql" "$WORK/rerun-undo.sql" commit \
  "expected_rows constant integer := 0;=>expected_rows constant integer := 10;"
q -f "$WORK/rerun-undo.sql" > "$WORK/rerun-undo.log"
expect_same "$(snapshot)" "$S2" "the re-run undo restores every row and binding"
variant "$REPO_ROOT/scripts/context-holding-thread-retire-undo.sql" "$WORK/retire-undo.sql" commit \
  "expected_rows constant integer := 50;=>expected_rows constant integer := 2;"
q -f "$WORK/retire-undo.sql" > "$WORK/retire-undo.log"
expect_same "$(snapshot)" "$S1" "the retire undo restores both bindings"
variant "$REPO_ROOT/scripts/context-placement-misfile-repair-undo.sql" "$WORK/repair-undo.sql" commit \
  "expected_rows constant integer := 70;=>expected_rows constant integer := 5;"
q -f "$WORK/repair-undo.sql" > "$WORK/repair-undo.log"
expect_same "$(snapshot)" "$S0" "the repair undo restores every row exactly, payload jobs, copy marks and party roles included"

echo "== grades load =="
# The draw as the grader's orchestrator saves it, from the real sampler, and the grader's answers.
DRAW=$(val "SELECT jsonb_agg(to_jsonb(s) ORDER BY s.pos) FROM public.context_placement_sample('2026-09-01 04:00:00+00', 3) s")
SID=$(val "SELECT min(s.sample_id) FROM public.context_placement_sample('2026-09-01 04:00:00+00', 3) s")
[ "$SID" = "placement-cf-20260901t040000z-n3-d30" ] || { echo "FAIL: the draw is $SID" >&2; exit 1; }
ANSWERS='[{"event_id":"a7c00000-0000-4000-800f-000000000001","verdict":"right","reason":null,"right_job_id":null},{"event_id":"a7c00000-0000-4000-800f-000000000002","verdict":"unsure","reason":"not_enough_evidence","right_job_id":null},{"event_id":"a7c00000-0000-4000-800f-000000000003","verdict":"wrong","reason":"other_job","right_job_id":"a7c00000-0000-4000-8000-0000000000b3","placed_job_id":"a7c00000-0000-4000-8000-0000000000b2"}]'
loadsub() {
  echo "'[]'::jsonb AS draw, '[]'::jsonb AS answers=>'$1'::jsonb AS draw, '$2'::jsonb AS answers"
}
LOADSUB=("expected_sample_id constant text := 'placement-cf-YYYYMMDDtHHMMSSz-n120-d30';=>expected_sample_id constant text := '$SID';"
  "expected_rows constant integer := 120;=>expected_rows constant integer := 3;"
  "'2026-10-07 00:00:00+00'::timestamptz AS graded_at=>'2026-09-01 05:00:00+00'::timestamptz AS graded_at")
# Refused: an answer missing (a draw loads whole), a draw saved short, an answer naming another job, an answer for an item not drawn.
variant "$REPO_ROOT/scripts/context-placement-grades-load.sql" "$WORK/load-partial.sql" commit "${LOADSUB[@]}" \
  "$(loadsub "$DRAW" "$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]); print(json.dumps(a[:2]))' "$ANSWERS")")"
expect_refused "$WORK/load-partial.sql" "drawn items have no answer; a draw loads whole or not at all" "a sample graded in part never loads"
variant "$REPO_ROOT/scripts/context-placement-grades-load.sql" "$WORK/load-short.sql" commit "${LOADSUB[@]}" \
  "$(loadsub "$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(json.dumps(d[:2]))' "$DRAW")" "$ANSWERS")"
expect_refused "$WORK/load-short.sql" "with 2 of 3 items" "a draw saved short never loads"
variant "$REPO_ROOT/scripts/context-placement-grades-load.sql" "$WORK/load-edited.sql" commit "${LOADSUB[@]}" \
  "$(loadsub "$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d[0]["placed_job_id"]="a7c00000-0000-4000-8000-0000000000b3"; print(json.dumps(d))' "$DRAW")" "$ANSWERS")"
expect_refused "$WORK/load-edited.sql" "does not match its own digest" "a draw edited after it was drawn never loads"
variant "$REPO_ROOT/scripts/context-placement-grades-load.sql" "$WORK/load-otherjob.sql" commit "${LOADSUB[@]}" \
  "$(loadsub "$DRAW" "$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a[2]["placed_job_id"]="a7c00000-0000-4000-8000-0000000000b1"; print(json.dumps(a))' "$ANSWERS")")"
expect_refused "$WORK/load-otherjob.sql" "answers name another position or job than the draw" "an answer about another job never loads"
variant "$REPO_ROOT/scripts/context-placement-grades-load.sql" "$WORK/load-stray.sql" commit "${LOADSUB[@]}" \
  "$(loadsub "$DRAW" "$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a.append({"event_id":"a7c00000-0000-4000-800a-000000000004","verdict":"right"}); print(json.dumps(a))' "$ANSWERS")")"
expect_refused "$WORK/load-stray.sql" "answers grade items the draw does not hold" "an answer for an item the draw does not hold never loads"
variant "$REPO_ROOT/scripts/context-placement-grades-load.sql" "$WORK/load-dry.sql" rollback "${LOADSUB[@]}" "$(loadsub "$DRAW" "$ANSWERS")"
q -f "$WORK/load-dry.sql" > "$WORK/load-dry.log"
expect_same "$(snapshot)" "$S0" "the load dry run passes its checks and changes nothing"
variant "$REPO_ROOT/scripts/context-placement-grades-load.sql" "$WORK/load-commit.sql" commit "${LOADSUB[@]}" "$(loadsub "$DRAW" "$ANSWERS")"
q -f "$WORK/load-commit.sql" > "$WORK/load-commit.log"
expect_eq "SELECT sample_id || ':' || drawn || ':' || graded || ':' || missing || ':' || right_count || ':' || unsure_count || ':' || wrong_count
  || ':' || right_share || ':' || placed_share || ':' || right_of_all FROM public.context_placement_grades_newest(now())" \
  "placement-cf-20260901t040000z-n3-d30:3:3:0:1:1:1:0.3333:1.0000:0.3333" "a loaded sample is the newest, 1 right of 3 drawn, unsure never right"
expect_refused "$WORK/load-commit.sql" "is already loaded" "a second load of one sample refuses"
variant "$REPO_ROOT/scripts/context-placement-grades-load-undo.sql" "$WORK/load-undo.sql" commit \
  "expected_sample_id constant text := 'placement-cf-YYYYMMDDtHHMMSSz-n120-d30';=>expected_sample_id constant text := '$SID';" \
  "expected_rows constant integer := 120;=>expected_rows constant integer := 3;"
q -f "$WORK/load-undo.sql" > "$WORK/load-undo.log"
expect_same "$(snapshot)" "$S0" "the load undo removes the sample"

echo "row 3 script proofs passed"

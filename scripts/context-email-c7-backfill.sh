#!/usr/bin/env bash
# Finish line row C7 (3 Nov 2026): re-read a window of mail through the email reader's own fixed-window sweep, so
# the emails the old rules dropped (partner documents sent through Xero, MYOB, QuickBooks or Buildertrend; Dispatch
# suppliers' automatic replies and bounces; builders' no-reply mail; owner mail naming a builder reference; our own
# system's notices) are saved once the fixed reader is deployed.
#
# Each call is one source and one window of at most 48 hours (the reader's sweep limit), sent with wait true, in
# order. The reader saves what its rules now keep; an email already saved is a duplicate and changes nothing. A run
# cut by the time budget is sent again with the same bounds, which resumes it (at most 4 times).
#
# Usage:
#   scripts/context-email-c7-backfill.sh <from> <to> <source_key>...          # prints the plan; sends nothing
#   scripts/context-email-c7-backfill.sh <from> <to> <source_key>... --send   # runs the sweeps, prints each answer
#
# <from> and <to> are UTC, YYYY-MM-DDTHH:MM:SSZ, to not in the future, from not more than 60 days ago.
# --send needs SW_API_KEY (the server key) and SUPABASE_ANON_KEY (the project anon key); neither is printed.
# Every insert is counted as a sweep miss, so the email_poll_missed alarm reads these sources for 26 hours.
#
# The C7 window of 3 Nov 2026 (27 Oct to 3 Nov Perth), the six mailboxes where the dropped emails were:
#   scripts/context-email-c7-backfill.sh 2026-10-26T16:00:00Z 2026-11-03T12:00:00Z admin finance jan marnin nithin shaun
set -euo pipefail

usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

[ "$#" -ge 3 ] || usage
FROM=$1
TO=$2
shift 2
SEND=""
SOURCES=()
for a in "$@"; do
  if [ "$a" = "--send" ]; then SEND=1; else SOURCES+=("$a"); fi
done
[ "${#SOURCES[@]}" -gt 0 ] || usage
for s in "${SOURCES[@]}"; do
  [[ "$s" =~ ^[a-z][a-z0-9_]{1,40}$ ]] || { echo "error: source key must look like a monitored_mailboxes source_key ($s)" >&2; exit 2; }
done
for t in "$FROM" "$TO"; do
  [[ "$t" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "error: times are UTC, YYYY-MM-DDTHH:MM:SSZ ($t)" >&2; exit 2; }
done
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
[[ "$FROM" < "$TO" ]] || { echo "error: from must be before to" >&2; exit 2; }
[[ "$TO" < "$NOW" || "$TO" == "$NOW" ]] || { echo "error: to is in the future" >&2; exit 2; }

PROJECT_REF=${PROJECT_REF:-kevgrhcjxspbxgovpmfl}
URL="https://${PROJECT_REF}.supabase.co/functions/v1/outlook-mail-capture"

# 48-hour slices of [FROM, TO).
SLICES=$(python3 -I - "$FROM" "$TO" <<'PY'
import sys
from datetime import datetime, timedelta, timezone
f, t = (datetime.strptime(x, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) for x in sys.argv[1:3])
if datetime.now(timezone.utc) - f > timedelta(days=60):
    sys.exit("error: from is more than 60 days ago (the reader's sweep limit)")
while f < t:
    e = min(f + timedelta(hours=48), t)
    print(f.strftime("%Y-%m-%dT%H:%M:%SZ"), e.strftime("%Y-%m-%dT%H:%M:%SZ"))
    f = e
PY
)

if [ -z "$SEND" ]; then
  echo "dry run: would POST to $URL, in this order, each with wait true:"
  for s in "${SOURCES[@]}"; do
    while read -r a b; do
      printf '{"mode":"sweep","source":"%s","from":"%s","to":"%s","wait":true}\n' "$s" "$a" "$b"
    done <<<"$SLICES"
  done
  echo "add --send to run them (the reader saves what its rules keep; duplicates change nothing)"
  exit 0
fi
: "${SW_API_KEY:?set SW_API_KEY (the server key)}"
: "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY (the project anon key)}"
for s in "${SOURCES[@]}"; do
  while read -r a b; do
    BODY=$(printf '{"mode":"sweep","source":"%s","from":"%s","to":"%s","wait":true}' "$s" "$a" "$b")
    for try in 1 2 3 4; do
      OUT=$(curl -sS --max-time 170 -X POST "$URL" \
        -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
        -H "apikey: ${SUPABASE_ANON_KEY}" \
        -H "x-api-key: ${SW_API_KEY}" \
        -H "Content-Type: application/json" \
        --data "$BODY" || echo '{"outcome":"http_failed"}')
      STATUS=$(printf '%s' "$OUT" | python3 -I -c 'import json,sys
try:
    d = json.load(sys.stdin)
except ValueError:
    print("unreadable"); sys.exit()
s = (d.get("sources") or [{}])[0]
print(s.get("status") or s.get("outcome") or d.get("outcome") or "unknown")')
      echo "$s $a $b try $try: $OUT"
      [ "$STATUS" = "succeeded" ] && break
      [ "$STATUS" = "partial" ] || [ "$STATUS" = "busy" ] || [ "$STATUS" = "http_failed" ] || break
      sleep 10
    done
  done <<<"$SLICES"
done

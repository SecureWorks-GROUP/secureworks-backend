#!/usr/bin/env bash
# History depth go point G6: the counts-only deep probe. Read only.
#
# Asks the deployed email reader (outlook-mail-capture, mode deep, probe true)
# how much mail Microsoft Graph gives ONE mailbox for a window, by Perth month,
# before the deep load saves anything. The reader lists the window and answers
# counts and times only: it writes no evidence row, no run row and no
# attachment, reads no message body, and does not need the deep load's flag
# (email_reader_deep_v1 may stay off). It still needs the reader's own flags
# and the capture lane on, as every reader call does. A user mailbox lists at
# most 100 messages a month ("more": there were more); a group counts its
# conversations by the month each was last delivered.
#
# Usage:
#   scripts/context-email-deep-probe.sh <source_key> <from> <to>          # prints the request; sends nothing
#   scripts/context-email-deep-probe.sh <source_key> <from> <to> --send   # asks the reader, prints its answer
#
# <from> and <to> are UTC times, YYYY-MM-DDTHH:MM:SSZ. Guards: a source key of
# monitored_mailboxes' shape; from before to; to not in the future; from not
# before the deep load's hard floor (2024-12-31T16:00:00Z, 1 Jan 2025 Perth).
# One mailbox per call. --send needs SW_API_KEY (the server key) and
# SUPABASE_ANON_KEY (the project's public anon key, for the gateway's JWT
# check); neither is printed.
#
# The design's pair (owner's go first), one user mailbox and one group:
#   scripts/context-email-deep-probe.sh nithin 2025-07-01T00:00:00Z 2026-10-03T00:00:00Z --send
#   scripts/context-email-deep-probe.sh ses 2025-07-01T00:00:00Z 2026-10-03T00:00:00Z --send
set -euo pipefail

usage() {
  sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

[ "$#" -ge 3 ] || usage
SOURCE=$1
FROM=$2
TO=$3
SEND=${4:-}
HARD_FLOOR=2024-12-31T16:00:00Z
PROJECT_REF=${PROJECT_REF:-kevgrhcjxspbxgovpmfl}
URL="https://${PROJECT_REF}.supabase.co/functions/v1/outlook-mail-capture"

[[ "$SOURCE" =~ ^[a-z][a-z0-9_]{1,40}$ ]] || { echo "error: source key must look like a monitored_mailboxes source_key" >&2; exit 2; }
for t in "$FROM" "$TO"; do
  [[ "$t" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "error: times are UTC, YYYY-MM-DDTHH:MM:SSZ ($t)" >&2; exit 2; }
done
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Same fixed format, so byte order is time order.
[[ "$FROM" < "$TO" ]] || { echo "error: from must be before to" >&2; exit 2; }
[[ "$TO" < "$NOW" || "$TO" == "$NOW" ]] || { echo "error: to is in the future" >&2; exit 2; }
[[ "$FROM" < "$HARD_FLOOR" ]] && { echo "error: from is before the hard floor $HARD_FLOOR" >&2; exit 2; }
[ -z "$SEND" ] || [ "$SEND" = "--send" ] || usage

BODY=$(printf '{"mode":"deep","probe":true,"source":"%s","from":"%s","to":"%s","wait":true}' "$SOURCE" "$FROM" "$TO")
if [ "$SEND" != "--send" ]; then
  echo "dry run: would POST to $URL"
  echo "$BODY"
  echo "add --send to ask the reader (it writes nothing)"
  exit 0
fi
: "${SW_API_KEY:?set SW_API_KEY (the server key)}"
: "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY (the project anon key)}"
curl -sS --max-time 170 -X POST "$URL" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "x-api-key: ${SW_API_KEY}" \
  -H "Content-Type: application/json" \
  --data "$BODY"
echo

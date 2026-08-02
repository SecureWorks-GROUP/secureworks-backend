#!/bin/bash
# Batch 5 CDP capture driver. Read-only: opens the stored /share/ URL, polls until
# the SPA has SETTLED (same rendered text length twice AND the Job Details block
# laid out), redacts client PII with additive overlays, VERIFIES the redaction,
# and only then takes the screenshot. Both gates are inherited deliberately from
# ses-reissue-list-verified-v1: a shutter that fires before layout produced a
# false reading once and leaked a client name once.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
D="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SP="$(mktemp -d "${TMPDIR:-/tmp}/ses-capture.XXXXXX")"
trap 'rm -rf "$SP"' EXIT
SP="/private/tmp/claude-501/-Users-marninstobbe--treehouse-secureworks-backend-5961a6-10-secureworks-backend/2cb261b3-0992-457c-8d33-197540b407b1/scratchpad/b5"
SP="$(mktemp -d "${TMPDIR:-/tmp}/ses-capture.XXXXXX")"
trap 'rm -rf "$SP"' EXIT
CLS="$(cat "$D/evidence/classify.js")"
RED="$(cat "$D/evidence/redact.js")"
MAX_POLL=40
OUT="$D/evidence/portal-captures.jsonl"
: > "$OUT"
unesc() { python3 -c 'import sys,json;print(json.loads("\""+sys.stdin.read().rstrip("\n")+"\""))' 2>/dev/null; }
axi_json() { chrome-devtools-axi eval "$1" 2>/dev/null | sed -n 's/^result: "\(.*\)"$/\1/p' | unesc; }

while IFS=$'\t' read -r card slug url; do
  [ -z "${url:-}" ] && continue
  echo ">>> $card $slug"
  : > "$SP/res.json"
  chrome-devtools-axi open "$url" >/dev/null 2>&1
  prev_len=-1; stable=0
  for i in $(seq 1 $MAX_POLL); do
    chrome-devtools-axi wait 3000 >/dev/null 2>&1
    : > "$SP/res.json"
    axi_json "$CLS" > "$SP/res.json"
    [ -s "$SP/res.json" ] || continue
    st=$(jq -r '.state // "err"' "$SP/res.json" 2>/dev/null)
    len=$(jq -r '.innerTextLen // 0' "$SP/res.json" 2>/dev/null)
    if [ "$len" = "$prev_len" ]; then stable=$((stable+1)); else stable=0; fi
    prev_len="$len"
    if [ "$st" = "expired" ] && [ "$stable" -ge 1 ]; then break; fi
    jn=$(jq -r '.jobNo // ""' "$SP/res.json" 2>/dev/null)
    if { [ "$st" = "present-and-locked" ] || [ "$st" = "present-but-not-submitted" ]; } \
       && [ "$stable" -ge 1 ] && [ -n "$jn" ]; then break; fi
  done
  [ -s "$SP/res.json" ] || { echo "{\"card\":\"$card\",\"slug\":\"$slug\",\"state\":\"capture-failed\"}" >> "$OUT"; continue; }
  : > "$SP/red.json"
  axi_json "$RED" > "$SP/red.json"
  rok=$(jq -r '.ok // false' "$SP/red.json" 2>/dev/null)
  shot_rel="shots/${slug}.png"
  if [ "$rok" = "true" ]; then
    chrome-devtools-axi screenshot "$SP/shot.png" >/dev/null 2>&1 && cp "$SP/shot.png" "$D/$shot_rel" 2>/dev/null
  else
    shot_rel="REDACTION-FAILED-NO-SCREENSHOT"
    echo "    !! redaction unverified, screenshot withheld: $(cat "$SP/red.json")"
  fi
  jq -c --arg card "$card" --arg slug "$slug" --arg shot "$shot_rel" \
     --argjson red "$(cat "$SP/red.json")" \
     '. + {card:$card, slug:$slug, screenshot:$shot, redaction:$red}' "$SP/res.json" >> "$OUT"
  echo "    state=$(jq -r .state "$SP/res.json") why=$(jq -r .why "$SP/res.json") shot=$shot_rel"
done < "$D/evidence/capture-list.tsv"
echo "== done =="

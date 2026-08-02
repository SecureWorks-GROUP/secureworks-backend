#!/bin/bash
# Batch 5 expired-link RE-VERIFICATION driver.
#
# Difference from capture.sh, and the reason for it: SWMS-261116 classified
# 'expired' off Prime's own dead-link page, then rendered a fully live form
# 21-of-24 answered minutes later on the identical URL. Prime serves its expiry
# page transiently. So 'expired' is the verdict that must be hardest to reach,
# not the easiest: here it only stands when it survives a full reload.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
D="/Users/marninstobbe/.treehouse/secureworks-backend-5961a6/10/secureworks-backend/data/ses-run-skill-batch5-links-v1"; SP="/private/tmp/claude-501/-Users-marninstobbe--treehouse-secureworks-backend-5961a6-10-secureworks-backend/2cb261b3-0992-457c-8d33-197540b407b1/scratchpad/b5"
CLS="$(cat "$D/evidence/classify.js")"
RED="$(cat "$D/evidence/redact.js")"
OUT="$D/evidence/portal-captures-expired.jsonl"
LIST="${1:-$D/evidence/capture-list-expired.tsv}"
unesc() { python3 -c 'import sys,json;print(json.loads("\""+sys.stdin.read().rstrip("\n")+"\""))' 2>/dev/null; }
axi_json() { chrome-devtools-axi eval "$1" 2>/dev/null | sed -n 's/^result: "\(.*\)"$/\1/p' | unesc; }

settle() {  # $1=url ; leaves verdict in $SP/res.json
  chrome-devtools-axi open "$1" >/dev/null 2>&1
  local prev=-1 stable=0 i st len jn
  for i in $(seq 1 14); do
    chrome-devtools-axi wait 3000 >/dev/null 2>&1
    axi_json "$CLS" > "$SP/res.json"
    [ -s "$SP/res.json" ] || continue
    st=$(jq -r '.state // "err"' "$SP/res.json" 2>/dev/null)
    len=$(jq -r '.innerTextLen // 0' "$SP/res.json" 2>/dev/null)
    if [ "$len" = "$prev" ]; then stable=$((stable+1)); else stable=0; fi
    prev="$len"
    jn=$(jq -r '.jobNo // ""' "$SP/res.json" 2>/dev/null)
    if { [ "$st" = "present-and-locked" ] || [ "$st" = "present-but-not-submitted" ]; } \
       && [ "$stable" -ge 1 ] && [ -n "$jn" ]; then return; fi
    # expired needs a LONG stable window here, not two polls
    if [ "$st" = "expired" ] && [ "$stable" -ge 3 ]; then return; fi
  done
}

while IFS=$'\t' read -r card slug url; do
  [ -z "${url:-}" ] && continue
  settle "$url"
  st1=$(jq -r '.state // "err"' "$SP/res.json" 2>/dev/null); cp "$SP/res.json" "$SP/pass1.json"
  verdict="$st1"; note="single pass"
  if [ "$st1" = "expired" ]; then
    settle "$url"                       # RELOAD — the transient test
    st2=$(jq -r '.state // "err"' "$SP/res.json" 2>/dev/null)
    if [ "$st2" = "expired" ]; then verdict="expired"; note="expired on both passes"
    else verdict="$st2"; note="PASS1 EXPIRED, PASS2 $st2 — transient expiry page"; fi
  fi
  axi_json "$RED" > "$SP/red.json"
  rok=$(jq -r '.ok // false' "$SP/red.json" 2>/dev/null)
  shot="shots/exp-${slug}.png"
  if [ "$rok" = "true" ]; then
    chrome-devtools-axi screenshot "$SP/shot.png" >/dev/null 2>&1 && cp "$SP/shot.png" "$D/$shot" 2>/dev/null
  else shot="REDACTION-FAILED-NO-SCREENSHOT"; fi
  jq -c --arg card "$card" --arg slug "$slug" --arg v "$verdict" --arg n "$note" --arg s "$shot" \
     '. + {card:$card, slug:$slug, verdict:$v, note:$n, screenshot:$s}' "$SP/res.json" >> "$OUT"
  echo "$card $slug -> $verdict  [$note]"
done < "$LIST"
echo "== chunk done =="

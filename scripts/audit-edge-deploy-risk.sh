#!/usr/bin/env bash
# Read-only inventory for Supabase edge deploy risk.
#
# Prints deploy workflows and duplicate ops-api/send-quote sources under a
# workspace. It does not modify files, fetch remotes, deploy, or contact
# Supabase.

set -euo pipefail

ROOT="${1:-/Users/marninstobbe/Projects}"

echo "== Deploy workflow references =="
find "$ROOT" -path '*/.github/workflows/*' -type f -print0 2>/dev/null \
  | xargs -0 rg -n 'supabase functions deploy|functions deploy|deploy ops-api|deploy send-quote|ops-api|send-quote' \
  || true

echo
echo "== Function source copies =="
find "$ROOT" \( -path '*/supabase/functions/ops-api/index.ts' -o -path '*/supabase/functions/send-quote/index.ts' \) -type f -print0 2>/dev/null \
  | while IFS= read -r -d '' file; do
      repo="$file"
      while [[ "$repo" != "/" && ! -d "$repo/.git" && ! -f "$repo/.git" ]]; do
        repo="$(dirname "$repo")"
      done
      branch=""
      commit=""
      dirty="?"
      if [[ "$repo" != "/" ]]; then
        branch="$(git -C "$repo" branch --show-current 2>/dev/null || true)"
        commit="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || true)"
        dirty="$(git -C "$repo" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
      fi
      node -e "
        const fs=require('fs');
        const text=fs.readFileSync(process.argv[1],'utf8');
        const actions=[...new Set([...text.matchAll(/case\\s+['\\\"]([^'\\\"]+)['\\\"]\\s*:/g)].map(m=>m[1]))];
        const required=['ops_api_version','list_ops_notes','send_quote_followup_sms','approve_quote_review_task','finance_health_summary','daily_coverage_audit','freeze_scope','get_evidence_health'];
        const missing=required.filter(a=>!actions.includes(a));
        console.log(JSON.stringify({file:process.argv[1],repo:process.argv[2],branch:process.argv[3]||'detached',commit:process.argv[4],dirty:Number(process.argv[5]),lines:text.split(/\\n/).length,actions:actions.length,missing},null,2));
      " "$file" "$repo" "$branch" "$commit" "$dirty"
    done

#!/usr/bin/env bash
# Static guardrails for production edge deploy safety.

set -euo pipefail

fail() {
  echo "FAIL $*" >&2
  exit 1
}

node <<'NODE'
const fs = require('fs');
const path = 'supabase/functions/ops-api/index.ts';
const text = fs.readFileSync(path, 'utf8');
const actions = [...new Set([...text.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map(m => m[1]))];
const required = [
  'ops_api_version',
  'list_ops_notes',
  'upsert_ops_note',
  'delete_ops_note',
  'get_ops_upload_url',
  'send_ops_note_to_trade',
  'get_comms_upload_url',
  'send_comms_message',
  'delete_note',
  'list_proposed_actions',
  'send_quote_followup_sms',
  'approve_scoper_call_task',
  'approve_quote_review_task',
  'approve_booking_proposal',
  'list_stale_quote_review_tasks',
  'update_playbook',
  'finance_health_summary',
  'daily_coverage_audit',
  'freeze_scope',
  'record_scope_artifact',
  'get_evidence_health',
  'get_evidence_body',
  'assemble_job_dossier',
  'assemble_job_brain',
  'get_job_context_facts',
  'get_job_conversation',
];
const missing = required.filter(a => !actions.includes(a));
console.log(JSON.stringify({ ops_api_actions: actions.length, missing }, null, 2));
if (missing.length) process.exit(1);

if (!text.includes("const OPS_API_SOURCE_REPO = 'secureworks-site'")) {
  console.error('ops_api_version must report source_repo: secureworks-site');
  process.exit(1);
}
NODE

grep -q 'scripts/deploy-edge-function.sh ops-api' docs/project-knowledge/sync-layer.md \
  || fail "sync-layer docs must point ops-api deploys at scripts/deploy-edge-function.sh"

grep -q 'scripts/deploy-edge-function.sh send-quote' docs/project-knowledge/sync-layer.md \
  || fail "sync-layer docs must point send-quote deploys at scripts/deploy-edge-function.sh"

grep -q 'Canonical Edge Deploy Lane' docs/project-knowledge/EDGE_DEPLOY_LANE.md \
  || fail "canonical deploy lane doc is missing"

if find .github/workflows -type f -print0 2>/dev/null \
  | xargs -0 grep -nE 'supabase functions deploy (ops-api|send-quote)' \
  | grep -v 'deploy-production-edge-functions.yml' >/dev/null; then
  fail "raw ops-api/send-quote deploy found in a non-canonical workflow"
fi

echo "PASS edge deploy guardrails"

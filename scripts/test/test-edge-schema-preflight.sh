#!/usr/bin/env bash
# Regression tests for the read-only production Edge Function schema gate.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PREFLIGHT="$REPO_ROOT/scripts/check-edge-schema-preflight.sh"
MANIFEST="$REPO_ROOT/scripts/edge-function-schema-requirements.txt"
MIGRATION="$REPO_ROOT/supabase/migrations/20260727000001_makesafe_attendance_cycles_u2_s1.sql"
MEDIA_MIGRATION="$REPO_ROOT/supabase/migrations/20260728000001_makesafe_state_authority_u2.sql"
FRESH_HEALTH_MIGRATION="$REPO_ROOT/supabase/migrations/20260727020000_makesafe_intake_fresh_source_health.sql"
U5_U6_MIGRATION="$REPO_ROOT/supabase/migrations/20260728020000_makesafe_ses_invoice_release_u5_u6.sql"
FENCE_HARDENING_MIGRATION="$REPO_ROOT/supabase/migrations/20260728050000_makesafe_ses_fence_hardening.sql"
DOCS_READY_MIGRATION="$REPO_ROOT/supabase/migrations/20260728210000_makesafe_ses_docs_ready_signoff.sql"
SIBLING_EVIDENCE_MIGRATION="$REPO_ROOT/supabase/migrations/20260728730000_makesafe_sibling_evidence_bundle_u7.sql"
PORTAL_CAPTURE_MIGRATION="$REPO_ROOT/supabase/migrations/20260728500000_makesafe_portal_capture_bridge_u4.sql"
SEED_SCOPE_MIGRATION="$REPO_ROOT/supabase/migrations/20260729000000_makesafe_state_seed_scope_accounting.sql"
RECONCILE_TRUTH_MIGRATION="$REPO_ROOT/supabase/migrations/20260728060000_makesafe_board_reconcile_truth_u2.sql"
HUGO_NOTIFICATION_MIGRATION="$REPO_ROOT/supabase/migrations/20260729010000_makesafe_hugo_notification_sla_v1.sql"
CYCLE_UNIQUENESS_MIGRATION="$REPO_ROOT/supabase/migrations/20260730000001_makesafe_report_cycle_uniqueness.sql"
PDF_EXTRACTION_MIGRATION="$REPO_ROOT/supabase/migrations/20260731000001_makesafe_pdf_extraction_belt.sql"
INTAKE_SETTLEMENT_MIGRATION="$REPO_ROOT/supabase/migrations/20260731000002_makesafe_intake_settlement_closure.sql"
BOARD_V2_PREVIEW_MIGRATION="$REPO_ROOT/supabase/migrations/20260731085928_board_v2_seed_preview.sql"
VAULT_SYNC_MIGRATION="$REPO_ROOT/supabase/migrations/20260731152254_vault_sync_sw_api_key.sql"
SES_RECOVERY_MIGRATION="$REPO_ROOT/supabase/migrations/20260801062000_ses_adjudicated_job_recovery.sql"
PORTAL_COMPLETION_SUBSTATUS_MIGRATION="$REPO_ROOT/supabase/migrations/20260802010000_makesafe_awaiting_portal_completion_substatus.sql"
TRADE_CONFIRMATION_MIGRATION="$REPO_ROOT/supabase/migrations/20260802030000_makesafe_trade_portal_confirmation.sql"
LEAD_INSTALLER_MIGRATION="$REPO_ROOT/supabase/migrations/20260803070000_job_assignment_lead_installer.sql"
ROOF_INITIAL_CYCLE_MIGRATION="$REPO_ROOT/supabase/migrations/20260803080000_makesafe_roof_initial_cycle_binding.sql"
INVOICE_BOUND_ADOPT_MIGRATION="$REPO_ROOT/supabase/migrations/20260804010000_ses_invoice_bound_docket_idempotent_adopt.sql"
RELEASE_ROUTE_KIND_MIGRATION="$REPO_ROOT/supabase/migrations/20260804090000_ses_release_report_invoice_route_kind.sql"
MAILER_OPS_SEND_MIGRATION="$REPO_ROOT/supabase/migrations/20260805020000_ses_mailer_ops_send_effect.sql"
ECHO_CODE_APPROVAL_MIGRATION="$REPO_ROOT/supabase/migrations/20260808010000_ses_echo_code_approval.sql"
D1_RECONCILE_KILL_SWITCH_MIGRATION="$REPO_ROOT/supabase/migrations/20260809000001_makesafe_d1_reconcile_sms_kill_switch.sql"
STALE_ROUTE_DISPATCH_MIGRATION="$REPO_ROOT/supabase/migrations/20260825034944_ses_stale_route_dispatch_recovery.sql"
TRADE_INVOICE_MONEY_MIGRATION="$REPO_ROOT/supabase/migrations/20260827112928_trade_invoice_super_gst_split.sql"
TRADE_INVOICE_WEEKLY_MIGRATION="$REPO_ROOT/supabase/migrations/20260831021701_trade_invoice_weekly_deductions.sql"
TRADE_PACK_MIGRATION="$REPO_ROOT/supabase/migrations/20260904090000_job_documents_trade_pack_json.sql"
SEND_CLAIMED_AT_MIGRATION="$REPO_ROOT/supabase/migrations/20260906140000_job_documents_send_claimed_at.sql"
SEND_RUNS_CLAIMED_AT_MIGRATION="$REPO_ROOT/supabase/migrations/20260906150000_jobs_send_runs_claimed_at.sql"
SEND_CLAIM_TOKEN_MIGRATION="$REPO_ROOT/supabase/migrations/20260906160000_job_documents_send_claim_token.sql"


PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()
TEST_TMP="$(mktemp -d 2>/dev/null || mktemp -d -t edge-schema-preflight-test)"

cleanup() {
  find "$TEST_TMP" -depth -delete
}
trap cleanup EXIT

pass() {
  echo "PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "FAIL: $1" >&2
  echo "      $2" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_TESTS+=("$1")
}

migration_sha() {
  shasum -a 256 "$MIGRATION" | awk '{print $1}'
}

media_migration_sha() {
  shasum -a 256 "$MEDIA_MIGRATION" | awk '{print $1}'
}

fresh_health_migration_sha() {
  shasum -a 256 "$FRESH_HEALTH_MIGRATION" | awk '{print $1}'
}

u5_u6_migration_sha() {
  shasum -a 256 "$U5_U6_MIGRATION" | awk '{print $1}'
}

fence_hardening_migration_sha() {
  shasum -a 256 "$FENCE_HARDENING_MIGRATION" | awk '{print $1}'
}

docs_ready_migration_sha() {
  shasum -a 256 "$DOCS_READY_MIGRATION" | awk '{print $1}'
}
sibling_evidence_migration_sha() {
  shasum -a 256 "$SIBLING_EVIDENCE_MIGRATION" | awk '{print $1}'
}
portal_capture_migration_sha() {
  shasum -a 256 "$PORTAL_CAPTURE_MIGRATION" | awk '{print $1}'
}

seed_scope_migration_sha() {
  shasum -a 256 "$SEED_SCOPE_MIGRATION" | awk '{print $1}'
}

reconcile_truth_migration_sha() {
  shasum -a 256 "$RECONCILE_TRUTH_MIGRATION" | awk '{print $1}'
}

hugo_notification_migration_sha() {
  shasum -a 256 "$HUGO_NOTIFICATION_MIGRATION" | awk '{print $1}'
}

cycle_uniqueness_migration_sha() {
  shasum -a 256 "$CYCLE_UNIQUENESS_MIGRATION" | awk '{print $1}'
}

pdf_extraction_migration_sha() {
  shasum -a 256 "$PDF_EXTRACTION_MIGRATION" | awk '{print $1}'
}

intake_settlement_migration_sha() {
  shasum -a 256 "$INTAKE_SETTLEMENT_MIGRATION" | awk '{print $1}'
}

board_v2_preview_migration_sha() {
  shasum -a 256 "$BOARD_V2_PREVIEW_MIGRATION" | awk '{print $1}'
}

vault_sync_migration_sha() {
  shasum -a 256 "$VAULT_SYNC_MIGRATION" | awk '{print $1}'
}

ses_recovery_migration_sha() {
  shasum -a 256 "$SES_RECOVERY_MIGRATION" | awk '{print $1}'
}

portal_completion_substatus_migration_sha() {
  shasum -a 256 "$PORTAL_COMPLETION_SUBSTATUS_MIGRATION" | awk '{print $1}'
}

trade_confirmation_migration_sha() {
  shasum -a 256 "$TRADE_CONFIRMATION_MIGRATION" | awk '{print $1}'
}

lead_installer_migration_sha() {
  shasum -a 256 "$LEAD_INSTALLER_MIGRATION" | awk '{print $1}'
}

roof_initial_cycle_migration_sha() {
  shasum -a 256 "$ROOF_INITIAL_CYCLE_MIGRATION" | awk '{print $1}'
}

invoice_bound_adopt_migration_sha() {
  shasum -a 256 "$INVOICE_BOUND_ADOPT_MIGRATION" | awk '{print $1}'
}

release_route_kind_migration_sha() {
  shasum -a 256 "$RELEASE_ROUTE_KIND_MIGRATION" | awk '{print $1}'
}

mailer_ops_send_migration_sha() {
  shasum -a 256 "$MAILER_OPS_SEND_MIGRATION" | awk '{print $1}'
}

echo_code_approval_migration_sha() {
  shasum -a 256 "$ECHO_CODE_APPROVAL_MIGRATION" | awk '{print $1}'
}

d1_reconcile_kill_switch_migration_sha() {
  shasum -a 256 "$D1_RECONCILE_KILL_SWITCH_MIGRATION" | awk '{print $1}'
}

stale_route_dispatch_migration_sha() {
  shasum -a 256 "$STALE_ROUTE_DISPATCH_MIGRATION" | awk '{print $1}'
}

trade_invoice_money_migration_sha() {
  shasum -a 256 "$TRADE_INVOICE_MONEY_MIGRATION" | awk '{print $1}'
}

trade_invoice_weekly_migration_sha() {
  shasum -a 256 "$TRADE_INVOICE_WEEKLY_MIGRATION" | awk '{print $1}'
}

trade_pack_migration_sha() {
  shasum -a 256 "$TRADE_PACK_MIGRATION" | awk '{print $1}'
}

send_claimed_at_migration_sha() {
  shasum -a 256 "$SEND_CLAIMED_AT_MIGRATION" | awk '{print $1}'
}

send_runs_claimed_at_migration_sha() {
  shasum -a 256 "$SEND_RUNS_CLAIMED_AT_MIGRATION" | awk '{print $1}'
}

send_claim_token_migration_sha() {
  shasum -a 256 "$SEND_CLAIM_TOKEN_MIGRATION" | awk '{print $1}'
}

write_response() {
  local file="$1"
  local actual_name="$2"
  local actual_sha="$3"
  local missing_markers_json="$4"
  local actual_statement_count="${5:-1}"
  EXPECTED_SHA="$(migration_sha)" \
  MEDIA_EXPECTED_SHA="$(media_migration_sha)" \
  FRESH_HEALTH_EXPECTED_SHA="$(fresh_health_migration_sha)" \
  U5_U6_EXPECTED_SHA="$(u5_u6_migration_sha)" \
  FENCE_HARDENING_EXPECTED_SHA="$(fence_hardening_migration_sha)" \
  DOCS_READY_EXPECTED_SHA="$(docs_ready_migration_sha)" \
  SIBLING_EVIDENCE_EXPECTED_SHA="$(sibling_evidence_migration_sha)" \
  PORTAL_CAPTURE_EXPECTED_SHA="$(portal_capture_migration_sha)" \
  SEED_SCOPE_EXPECTED_SHA="$(seed_scope_migration_sha)" \
  RECONCILE_TRUTH_EXPECTED_SHA="$(reconcile_truth_migration_sha)" \
  HUGO_NOTIFICATION_EXPECTED_SHA="$(hugo_notification_migration_sha)" \
  CYCLE_UNIQUENESS_EXPECTED_SHA="$(cycle_uniqueness_migration_sha)" \
  PDF_EXTRACTION_EXPECTED_SHA="$(pdf_extraction_migration_sha)" \
  INTAKE_SETTLEMENT_EXPECTED_SHA="$(intake_settlement_migration_sha)" \
  BOARD_V2_PREVIEW_EXPECTED_SHA="$(board_v2_preview_migration_sha)" \
  VAULT_SYNC_EXPECTED_SHA="$(vault_sync_migration_sha)" \
  SES_RECOVERY_EXPECTED_SHA="$(ses_recovery_migration_sha)" \
  PORTAL_COMPLETION_SUBSTATUS_EXPECTED_SHA="$(portal_completion_substatus_migration_sha)" \
  TRADE_CONFIRMATION_EXPECTED_SHA="$(trade_confirmation_migration_sha)" \
  LEAD_INSTALLER_EXPECTED_SHA="$(lead_installer_migration_sha)" \
  ROOF_INITIAL_CYCLE_EXPECTED_SHA="$(roof_initial_cycle_migration_sha)" \
  INVOICE_BOUND_ADOPT_EXPECTED_SHA="$(invoice_bound_adopt_migration_sha)" \
  RELEASE_ROUTE_KIND_EXPECTED_SHA="$(release_route_kind_migration_sha)" \
  MAILER_OPS_SEND_EXPECTED_SHA="$(mailer_ops_send_migration_sha)" \
  ECHO_CODE_APPROVAL_EXPECTED_SHA="$(echo_code_approval_migration_sha)" \
  D1_RECONCILE_KILL_SWITCH_EXPECTED_SHA="$(d1_reconcile_kill_switch_migration_sha)" \
  STALE_ROUTE_DISPATCH_EXPECTED_SHA="$(stale_route_dispatch_migration_sha)" \
  TRADE_INVOICE_MONEY_EXPECTED_SHA="$(trade_invoice_money_migration_sha)" \
  TRADE_INVOICE_WEEKLY_EXPECTED_SHA="$(trade_invoice_weekly_migration_sha)" \
  TRADE_PACK_EXPECTED_SHA="$(trade_pack_migration_sha)" \
  SEND_CLAIMED_AT_EXPECTED_SHA="$(send_claimed_at_migration_sha)" \
  SEND_RUNS_CLAIMED_AT_EXPECTED_SHA="$(send_runs_claimed_at_migration_sha)" \
  SEND_CLAIM_TOKEN_EXPECTED_SHA="$(send_claim_token_migration_sha)" \
  ACTUAL_NAME="$actual_name" \
  ACTUAL_SHA="$actual_sha" \
  MISSING_MARKERS_JSON="$missing_markers_json" \
  ACTUAL_STATEMENT_COUNT="$actual_statement_count" \
  python3 - "$file" <<'PY'
import json
import os
import sys

actual_name = os.environ["ACTUAL_NAME"] or None
actual_sha = os.environ["ACTUAL_SHA"] or None
row = {
    "function_name": "ops-api",
    "migration_version": "20260727000001",
    "expected_migration_name": "makesafe_attendance_cycles_u2_s1",
    "expected_statement_sha256": os.environ["EXPECTED_SHA"],
    "actual_migration_version": "20260727000001" if actual_name else None,
    "actual_migration_name": actual_name,
    "actual_statement_count": (
        int(os.environ["ACTUAL_STATEMENT_COUNT"]) if actual_name else None
    ),
    "actual_statement_sha256": actual_sha,
    "missing_markers": json.loads(os.environ["MISSING_MARKERS_JSON"]),
}
media_row = {
    "function_name": "ops-api",
    "migration_version": "20260728000001",
    "expected_migration_name": "makesafe_state_authority_u2",
    "expected_statement_sha256": os.environ["MEDIA_EXPECTED_SHA"],
    "actual_migration_version": "20260728000001",
    "actual_migration_name": "makesafe_state_authority_u2",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["MEDIA_EXPECTED_SHA"],
    "missing_markers": [],
}
fresh_health_row = {
    "function_name": "ops-api",
    "migration_version": "20260727020000",
    "expected_migration_name": "makesafe_intake_fresh_source_health",
    "expected_statement_sha256": os.environ["FRESH_HEALTH_EXPECTED_SHA"],
    "actual_migration_version": "20260727020000",
    "actual_migration_name": "makesafe_intake_fresh_source_health",
    "actual_statement_count": 11,
    "actual_statement_sha256": os.environ["FRESH_HEALTH_EXPECTED_SHA"],
    "missing_markers": [],
}
u5_u6_row = {
    "function_name": "ops-api",
    "migration_version": "20260728020000",
    "expected_migration_name": "makesafe_ses_invoice_release_u5_u6",
    "expected_statement_sha256": os.environ["U5_U6_EXPECTED_SHA"],
    "actual_migration_version": "20260728020000" if actual_name else None,
    "actual_migration_name": "makesafe_ses_invoice_release_u5_u6" if actual_name else None,
    "actual_statement_count": 1 if actual_name else None,
    "actual_statement_sha256": os.environ["U5_U6_EXPECTED_SHA"] if actual_name else None,
    "missing_markers": [],
}
fence_hardening_row = {
    "function_name": "ops-api",
    "migration_version": "20260728050000",
    "expected_migration_name": "makesafe_ses_fence_hardening",
    "expected_statement_sha256": os.environ["FENCE_HARDENING_EXPECTED_SHA"],
    "actual_migration_version": "20260728050000",
    "actual_migration_name": "makesafe_ses_fence_hardening",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["FENCE_HARDENING_EXPECTED_SHA"],
    "missing_markers": [],
}
docs_ready_row = {
    "function_name": "ops-api",
    "migration_version": "20260728210000",
    "expected_migration_name": "makesafe_ses_docs_ready_signoff",
    "expected_statement_sha256": os.environ["DOCS_READY_EXPECTED_SHA"],
    "actual_migration_version": "20260728210000",
    "actual_migration_name": "makesafe_ses_docs_ready_signoff",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["DOCS_READY_EXPECTED_SHA"],
    "missing_markers": [],
}
sibling_evidence_row = {
    "function_name": "ops-api",
    "migration_version": "20260728730000",
    "expected_migration_name": "makesafe_sibling_evidence_bundle_u7",
    "expected_statement_sha256": os.environ["SIBLING_EVIDENCE_EXPECTED_SHA"],
    "actual_migration_version": "20260728730000",
    "actual_migration_name": "makesafe_sibling_evidence_bundle_u7",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["SIBLING_EVIDENCE_EXPECTED_SHA"],
    "missing_markers": [],
}
portal_capture_row = {
    "function_name": "ops-api",
    "migration_version": "20260728500000",
    "expected_migration_name": "makesafe_portal_capture_bridge_u4",
    "expected_statement_sha256": os.environ["PORTAL_CAPTURE_EXPECTED_SHA"],
    "actual_migration_version": "20260728500000",
    "actual_migration_name": "makesafe_portal_capture_bridge_u4",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["PORTAL_CAPTURE_EXPECTED_SHA"],
    "missing_markers": [],
}
reconcile_truth_row = {
    "function_name": "ops-api",
    "migration_version": "20260728060000",
    "expected_migration_name": "makesafe_board_reconcile_truth_u2",
    "expected_statement_sha256": os.environ["RECONCILE_TRUTH_EXPECTED_SHA"],
    "actual_migration_version": "20260728060000",
    "actual_migration_name": "makesafe_board_reconcile_truth_u2",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["RECONCILE_TRUTH_EXPECTED_SHA"],
    "missing_markers": [],
}
seed_scope_row = {
    "function_name": "ops-api",
    "migration_version": "20260729000000",
    "expected_migration_name": "makesafe_state_seed_scope_accounting",
    "expected_statement_sha256": os.environ["SEED_SCOPE_EXPECTED_SHA"],
    "actual_migration_version": "20260729000000",
    "actual_migration_name": "makesafe_state_seed_scope_accounting",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["SEED_SCOPE_EXPECTED_SHA"],
    "missing_markers": [],
}
hugo_notification_row = {
    "function_name": "ops-api",
    "migration_version": "20260729010000",
    "expected_migration_name": "makesafe_hugo_notification_sla_v1",
    "expected_statement_sha256": os.environ["HUGO_NOTIFICATION_EXPECTED_SHA"],
    "actual_migration_version": "20260729010000",
    "actual_migration_name": "makesafe_hugo_notification_sla_v1",
    "actual_statement_count": 10,
    "actual_statement_sha256": None,
    "missing_markers": [],
}
cycle_uniqueness_row = {
    "function_name": "ops-api",
    "migration_version": "20260730000001",
    "expected_migration_name": "makesafe_report_cycle_uniqueness",
    "expected_statement_sha256": os.environ["CYCLE_UNIQUENESS_EXPECTED_SHA"],
    "actual_migration_version": "20260730000001",
    "actual_migration_name": "makesafe_report_cycle_uniqueness",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["CYCLE_UNIQUENESS_EXPECTED_SHA"],
    "missing_markers": [],
}
pdf_extraction_row = {
    "function_name": "ops-api",
    "migration_version": "20260731000001",
    "expected_migration_name": "makesafe_pdf_extraction_belt",
    "expected_statement_sha256": os.environ["PDF_EXTRACTION_EXPECTED_SHA"],
    "actual_migration_version": "20260731000001",
    "actual_migration_name": "makesafe_pdf_extraction_belt",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["PDF_EXTRACTION_EXPECTED_SHA"],
    "missing_markers": [],
}
intake_settlement_row = {
    "function_name": "ops-api",
    "migration_version": "20260731000002",
    "expected_migration_name": "makesafe_intake_settlement_closure",
    "expected_statement_sha256": os.environ["INTAKE_SETTLEMENT_EXPECTED_SHA"],
    "actual_migration_version": "20260731000002",
    "actual_migration_name": "makesafe_intake_settlement_closure",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["INTAKE_SETTLEMENT_EXPECTED_SHA"],
    "missing_markers": [],
}
board_v2_preview_row = {
    "function_name": "ops-api",
    "migration_version": "20260731085928",
    "expected_migration_name": "board_v2_seed_preview",
    "expected_statement_sha256": os.environ["BOARD_V2_PREVIEW_EXPECTED_SHA"],
    "actual_migration_version": "20260731085928",
    "actual_migration_name": "board_v2_seed_preview",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["BOARD_V2_PREVIEW_EXPECTED_SHA"],
    "missing_markers": [],
}
vault_sync_row = {
    "function_name": "ops-api",
    "migration_version": "20260731152254",
    "expected_migration_name": "vault_sync_sw_api_key",
    "expected_statement_sha256": os.environ["VAULT_SYNC_EXPECTED_SHA"],
    "actual_migration_version": "20260731152254",
    "actual_migration_name": "vault_sync_sw_api_key",
    "actual_statement_count": 5,
    "actual_statement_sha256": None,
    "missing_markers": [],
}
ses_recovery_row = {
    "function_name": "ops-api",
    "migration_version": "20260801062000",
    "expected_migration_name": "ses_adjudicated_job_recovery",
    "expected_statement_sha256": os.environ["SES_RECOVERY_EXPECTED_SHA"],
    "actual_migration_version": "20260801062000",
    "actual_migration_name": "ses_adjudicated_job_recovery",
    "actual_statement_count": 5,
    "actual_statement_sha256": None,
    "missing_markers": [],
}
portal_completion_substatus_row = {
    "function_name": "ops-api",
    "migration_version": "20260802010000",
    "expected_migration_name": "makesafe_awaiting_portal_completion_substatus",
    "expected_statement_sha256": os.environ["PORTAL_COMPLETION_SUBSTATUS_EXPECTED_SHA"],
    "actual_migration_version": "20260802010000",
    "actual_migration_name": "makesafe_awaiting_portal_completion_substatus",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["PORTAL_COMPLETION_SUBSTATUS_EXPECTED_SHA"],
    "missing_markers": [],
}
trade_confirmation_row = {
    "function_name": "ops-api",
    "migration_version": "20260802030000",
    "expected_migration_name": "makesafe_trade_portal_confirmation",
    "expected_statement_sha256": os.environ["TRADE_CONFIRMATION_EXPECTED_SHA"],
    "actual_migration_version": "20260802030000",
    "actual_migration_name": "makesafe_trade_portal_confirmation",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["TRADE_CONFIRMATION_EXPECTED_SHA"],
    "missing_markers": [],
}
lead_installer_row = {
    "function_name": "ops-api",
    "migration_version": "20260803070000",
    "expected_migration_name": "job_assignment_lead_installer",
    "expected_statement_sha256": os.environ["LEAD_INSTALLER_EXPECTED_SHA"],
    "actual_migration_version": "20260803070000",
    "actual_migration_name": "job_assignment_lead_installer",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["LEAD_INSTALLER_EXPECTED_SHA"],
    "missing_markers": [],
}
roof_initial_cycle_row = {
    "function_name": "ops-api",
    "migration_version": "20260803080000",
    "expected_migration_name": "makesafe_roof_initial_cycle_binding",
    "expected_statement_sha256": os.environ["ROOF_INITIAL_CYCLE_EXPECTED_SHA"],
    "actual_migration_version": "20260803080000",
    "actual_migration_name": "makesafe_roof_initial_cycle_binding",
    "actual_statement_count": 4,
    "actual_statement_sha256": None,
    "missing_markers": [],
}
invoice_bound_adopt_row = {
    "function_name": "ops-api",
    "migration_version": "20260804010000",
    "expected_migration_name": "ses_invoice_bound_docket_idempotent_adopt",
    "expected_statement_sha256": os.environ["INVOICE_BOUND_ADOPT_EXPECTED_SHA"],
    "actual_migration_version": "20260804010000",
    "actual_migration_name": "ses_invoice_bound_docket_idempotent_adopt",
    "actual_statement_count": 2,
    "actual_statement_sha256": None,
    "missing_markers": [],
}
release_route_kind_row = {
    "function_name": "ops-api",
    "migration_version": "20260804090000",
    "expected_migration_name": "ses_release_report_invoice_route_kind",
    "expected_statement_sha256": os.environ["RELEASE_ROUTE_KIND_EXPECTED_SHA"],
    "actual_migration_version": "20260804090000",
    "actual_migration_name": "ses_release_report_invoice_route_kind",
    "actual_statement_count": 7,
    "actual_statement_sha256": None,
    "missing_markers": [],
}
mailer_ops_send_row = {
    "function_name": "ops-api",
    "migration_version": "20260805020000",
    "expected_migration_name": "ses_mailer_ops_send_effect",
    "expected_statement_sha256": os.environ["MAILER_OPS_SEND_EXPECTED_SHA"],
    "actual_migration_version": "20260805020000",
    "actual_migration_name": "ses_mailer_ops_send_effect",
    "actual_statement_count": 5,
    "actual_statement_sha256": None,
    "missing_markers": [],
}
echo_code_approval_row = {
    "function_name": "ops-api",
    "migration_version": "20260808010000",
    "expected_migration_name": "ses_echo_code_approval",
    "expected_statement_sha256": os.environ["ECHO_CODE_APPROVAL_EXPECTED_SHA"],
    "actual_migration_version": "20260808010000",
    "actual_migration_name": "ses_echo_code_approval",
    "actual_statement_count": 13,
    "actual_statement_sha256": None,
    "missing_markers": [],
}
d1_reconcile_kill_switch_row = {
    "function_name": "ops-api",
    "migration_version": "20260809000001",
    "expected_migration_name": "makesafe_d1_reconcile_sms_kill_switch",
    "expected_statement_sha256": os.environ["D1_RECONCILE_KILL_SWITCH_EXPECTED_SHA"],
    "actual_migration_version": "20260809000001",
    "actual_migration_name": "makesafe_d1_reconcile_sms_kill_switch",
    "actual_statement_count": 2,
    "actual_statement_sha256": None,
    "missing_markers": [],
}
stale_route_dispatch_row = {
    "function_name": "ops-api",
    "migration_version": "20260825034944",
    "expected_migration_name": "ses_stale_route_dispatch_recovery",
    "expected_statement_sha256": os.environ["STALE_ROUTE_DISPATCH_EXPECTED_SHA"],
    "actual_migration_version": "20260825034944",
    "actual_migration_name": "ses_stale_route_dispatch_recovery",
    "actual_statement_count": 18,
    "actual_statement_sha256": None,
    "missing_markers": [],
}
trade_invoice_money_row = {
    "function_name": "ops-api",
    "migration_version": "20260827112928",
    "expected_migration_name": "trade_invoice_super_gst_split",
    "expected_statement_sha256": os.environ["TRADE_INVOICE_MONEY_EXPECTED_SHA"],
    "actual_migration_version": "20260827112928",
    "actual_migration_name": "trade_invoice_super_gst_split",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["TRADE_INVOICE_MONEY_EXPECTED_SHA"],
    "missing_markers": [],
}
trade_invoice_weekly_row = {
    "function_name": "ops-api",
    "migration_version": "20260831021701",
    "expected_migration_name": "trade_invoice_weekly_deductions",
    "expected_statement_sha256": os.environ["TRADE_INVOICE_WEEKLY_EXPECTED_SHA"],
    "actual_migration_version": "20260831021701",
    "actual_migration_name": "trade_invoice_weekly_deductions",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["TRADE_INVOICE_WEEKLY_EXPECTED_SHA"],
    "missing_markers": [],
}
trade_pack_row = {
    "function_name": "ops-api",
    "migration_version": "20260904090000",
    "expected_migration_name": "job_documents_trade_pack_json",
    "expected_statement_sha256": os.environ["TRADE_PACK_EXPECTED_SHA"],
    "actual_migration_version": "20260904090000",
    "actual_migration_name": "job_documents_trade_pack_json",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["TRADE_PACK_EXPECTED_SHA"],
    "missing_markers": [],
}
send_claimed_at_row = {
    "function_name": "ops-api",
    "migration_version": "20260906140000",
    "expected_migration_name": "job_documents_send_claimed_at",
    "expected_statement_sha256": os.environ["SEND_CLAIMED_AT_EXPECTED_SHA"],
    "actual_migration_version": "20260906140000",
    "actual_migration_name": "job_documents_send_claimed_at",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["SEND_CLAIMED_AT_EXPECTED_SHA"],
    "missing_markers": [],
}
send_runs_claimed_at_row = {
    "function_name": "send-quote",
    "migration_version": "20260906150000",
    "expected_migration_name": "jobs_send_runs_claimed_at",
    "expected_statement_sha256": os.environ["SEND_RUNS_CLAIMED_AT_EXPECTED_SHA"],
    "actual_migration_version": "20260906150000",
    "actual_migration_name": "jobs_send_runs_claimed_at",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["SEND_RUNS_CLAIMED_AT_EXPECTED_SHA"],
    "missing_markers": [],
}
send_claim_token_row = {
    "function_name": "send-quote",
    "migration_version": "20260906160000",
    "expected_migration_name": "job_documents_send_claim_token",
    "expected_statement_sha256": os.environ["SEND_CLAIM_TOKEN_EXPECTED_SHA"],
    "actual_migration_version": "20260906160000",
    "actual_migration_name": "job_documents_send_claim_token",
    "actual_statement_count": 1,
    "actual_statement_sha256": os.environ["SEND_CLAIM_TOKEN_EXPECTED_SHA"],
    "missing_markers": [],
}
with open(sys.argv[1], "w") as f:
    json.dump(
        [
            row,
            fresh_health_row,
            media_row,
            u5_u6_row,
            fence_hardening_row,
            docs_ready_row,
            sibling_evidence_row,
            portal_capture_row,
            reconcile_truth_row,
            seed_scope_row,
            hugo_notification_row,
            cycle_uniqueness_row,
            pdf_extraction_row,
            intake_settlement_row,
            board_v2_preview_row,
            vault_sync_row,
            ses_recovery_row,
            portal_completion_substatus_row,
            trade_confirmation_row,
            lead_installer_row,
            roof_initial_cycle_row,
            invoice_bound_adopt_row,
            release_route_kind_row,
            mailer_ops_send_row,
            echo_code_approval_row,
            d1_reconcile_kill_switch_row,
            stale_route_dispatch_row,
            trade_invoice_money_row,
            trade_invoice_weekly_row,
            trade_pack_row,
            send_claimed_at_row,
            send_runs_claimed_at_row,
            send_claim_token_row,
        ],
        f,
    )
PY
}

run_preflight() {
  local response_file="$1"
  shift
  local output_file="$TEST_TMP/output"
  EDGE_SCHEMA_PREFLIGHT_TEST_MODE=1 \
  SUPABASE_SCHEMA_PREFLIGHT_RESPONSE_FILE="$response_file" \
  bash "$PREFLIGHT" "$@" >"$output_file" 2>&1
  PREFLIGHT_RC=$?
  PREFLIGHT_OUTPUT="$(cat "$output_file")"
}

test_incident_dependency_is_declared() {
  local name="test_incident_dependency_is_declared"
  local report_expected='ops-api|supabase/migrations/20260727000001_makesafe_attendance_cycles_u2_s1.sql|column|job_service_reports.attendance_cycle_id'
  local media_expected='ops-api|supabase/migrations/20260728000001_makesafe_state_authority_u2.sql|column|job_media.attendance_cycle_id'
  local fresh_health_expected='ops-api|supabase/migrations/20260727020000_makesafe_intake_fresh_source_health.sql|column|makesafe_intake_health.fresh_source_lag_seconds'
  local seed_scope_expected='ops-api|supabase/migrations/20260729000000_makesafe_state_seed_scope_accounting.sql|table|makesafe_state_seed_scope_runs'
  local board_v2_preview_expected='ops-api|supabase/migrations/20260731085928_board_v2_seed_preview.sql|function|preview_makesafe_state_authority_v2'
  local vault_sync_expected='ops-api|supabase/migrations/20260731152254_vault_sync_sw_api_key.sql|function|vault_upsert_sw_api_key'
  local ses_recovery_expected='ops-api|supabase/migrations/20260801062000_ses_adjudicated_job_recovery.sql|function|bind_adjudicated_ses_existing_job'
  local roof_initial_cycle_expected='ops-api|supabase/migrations/20260803080000_makesafe_roof_initial_cycle_binding.sql|function|bind_makesafe_roof_initial_cycle_v1'
  local stale_route_dispatch_expected='ops-api|supabase/migrations/20260825034944_ses_stale_route_dispatch_recovery.sql|function|settle_stale_ses_route_dispatch_v1'
  if grep -Fxq "$report_expected" "$MANIFEST" && \
    grep -Fxq "$media_expected" "$MANIFEST" && \
    grep -Fxq "$fresh_health_expected" "$MANIFEST" && \
    grep -Fxq "$seed_scope_expected" "$MANIFEST" && \
    grep -Fxq "$board_v2_preview_expected" "$MANIFEST" && \
    grep -Fxq "$vault_sync_expected" "$MANIFEST" && \
    grep -Fxq "$ses_recovery_expected" "$MANIFEST" && \
    grep -Fxq "$roof_initial_cycle_expected" "$MANIFEST" && \
    grep -Fxq "$stale_route_dispatch_expected" "$MANIFEST"; then
    pass "$name"
  else
    fail "$name" "the report, media-cycle, fresh-source health, seed-scope, board-v2 preview, vault-sync, SES recovery, and stale-route dispatch markers are not permanent ops-api deploy requirements"
  fi
}

# Exact incident sequence: source that requires U2-S1 reaches the deploy gate,
# but the production migration ledger/schema is missing. Deployment must stop.
test_missing_migration_refuses_before_deploy() {
  local name="test_missing_migration_refuses_before_deploy"
  local response="$TEST_TMP/missing.json"
  write_response "$response" "" "" '["column:job_service_reports.attendance_cycle_id"]'
  run_preflight "$response" ops-api
  if [[ "$PREFLIGHT_RC" -ne 0 ]] && \
    grep -q 'migration ledger row is missing' <<<"$PREFLIGHT_OUTPUT" && \
    grep -q 'Refusing Edge Function deploy' <<<"$PREFLIGHT_OUTPUT"; then
    pass "$name"
  else
    fail "$name" "missing migration did not stop deployment: rc=$PREFLIGHT_RC output=$PREFLIGHT_OUTPUT"
  fi
}

test_missing_trade_invoice_requirement_refuses_before_deploy() {
  local name="test_missing_trade_invoice_requirement_refuses_before_deploy"
  local response="$TEST_TMP/missing-trade-invoice-money.json"
  write_response "$response" "makesafe_attendance_cycles_u2_s1" "$(migration_sha)" '[]'
  python3 - "$response" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path) as source:
    rows = json.load(source)
with open(path, "w") as target:
    json.dump(
        [row for row in rows if row.get("migration_version") != "20260827112928"],
        target,
    )
PY
  run_preflight "$response" ops-api
  if [[ "$PREFLIGHT_RC" -ne 0 ]] && \
    grep -q 'ops-api requires 20260827112928_trade_invoice_super_gst_split: no catalog result returned' <<<"$PREFLIGHT_OUTPUT" && \
    grep -q 'Refusing Edge Function deploy' <<<"$PREFLIGHT_OUTPUT"; then
    pass "$name"
  else
    fail "$name" "missing trade-invoice schema fixture did not stop deployment: rc=$PREFLIGHT_RC output=$PREFLIGHT_OUTPUT"
  fi
}

test_multi_statement_ledger_may_deploy() {
  local name="test_multi_statement_ledger_may_deploy"
  local response="$TEST_TMP/applied.json"
  # Parsed multi-statement ledgers have no comparable raw-file checksum.
  write_response "$response" "makesafe_attendance_cycles_u2_s1" "" '[]' 27
  run_preflight "$response" ops-api
  if [[ "$PREFLIGHT_RC" -eq 0 ]] && \
    grep -q 'PASS edge schema preflight' <<<"$PREFLIGHT_OUTPUT" && \
    grep -q 'advisory raw-file checksum is unavailable for 27 parsed ledger statements' <<<"$PREFLIGHT_OUTPUT"; then
    pass "$name"
  else
    fail "$name" "fully applied multi-statement schema was refused: rc=$PREFLIGHT_RC output=$PREFLIGHT_OUTPUT"
  fi
}

test_missing_schema_marker_refuses() {
  local name="test_missing_schema_marker_refuses"
  local response="$TEST_TMP/missing-marker.json"
  write_response "$response" "makesafe_attendance_cycles_u2_s1" "$(migration_sha)" '["table:makesafe_report_pack_cycles"]'
  run_preflight "$response" ops-api
  if [[ "$PREFLIGHT_RC" -ne 0 ]] && \
    grep -q 'required production markers missing' <<<"$PREFLIGHT_OUTPUT"; then
    pass "$name"
  else
    fail "$name" "missing schema marker did not stop deployment: rc=$PREFLIGHT_RC output=$PREFLIGHT_OUTPUT"
  fi
}

test_raw_statement_checksum_drift_is_advisory() {
  local name="test_raw_statement_checksum_drift_is_advisory"
  local response="$TEST_TMP/checksum.json"
  write_response "$response" "makesafe_attendance_cycles_u2_s1" "0000000000000000000000000000000000000000000000000000000000000000" '[]'
  run_preflight "$response" ops-api
  if [[ "$PREFLIGHT_RC" -eq 0 ]] && \
    grep -q 'advisory raw-statement checksum differs from checked-in raw file bytes' <<<"$PREFLIGHT_OUTPUT" && \
    ! grep -q 'Refusing Edge Function deploy' <<<"$PREFLIGHT_OUTPUT"; then
    pass "$name"
  else
    fail "$name" "checksum representation drift blocked deployment or was hidden: rc=$PREFLIGHT_RC output=$PREFLIGHT_OUTPUT"
  fi
}

test_raw_statement_checksum_matches_like_for_like() {
  local name="test_raw_statement_checksum_matches_like_for_like"
  local response="$TEST_TMP/checksum-match.json"
  write_response "$response" "makesafe_attendance_cycles_u2_s1" "$(migration_sha)" '[]'
  run_preflight "$response" ops-api
  if [[ "$PREFLIGHT_RC" -eq 0 ]] && \
    ! grep -q 'advisory raw-statement checksum differs' <<<"$PREFLIGHT_OUTPUT"; then
    pass "$name"
  else
    fail "$name" "byte-identical one-statement ledger produced a false-positive warning: rc=$PREFLIGHT_RC output=$PREFLIGHT_OUTPUT"
  fi
}

test_unrelated_function_without_requirements_passes_without_credentials() {
  local name="test_unrelated_function_without_requirements_passes_without_credentials"
  local output rc
  output="$(env -u SUPABASE_ACCESS_TOKEN -u SUPABASE_SCHEMA_PREFLIGHT_RESPONSE_FILE \
    bash "$PREFLIGHT" ghl-proxy 2>&1)"
  rc=$?
  if [[ "$rc" -eq 0 ]] && grep -q 'no declared requirements' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "unrelated function required production credentials: rc=$rc output=$output"
  fi
}

test_fixture_response_requires_explicit_test_mode() {
  local name="test_fixture_response_requires_explicit_test_mode"
  local response="$TEST_TMP/guarded-fixture.json" output rc
  write_response "$response" "makesafe_attendance_cycles_u2_s1" "$(migration_sha)" '[]'
  output="$(SUPABASE_SCHEMA_PREFLIGHT_RESPONSE_FILE="$response" \
    bash "$PREFLIGHT" ops-api 2>&1)"
  rc=$?
  if [[ "$rc" -ne 0 ]] && grep -q 'only in explicit test mode' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "fixture seam was usable outside test mode: rc=$rc output=$output"
  fi
}

test_read_only_safety_boundary() {
  local name="test_read_only_safety_boundary"
  local response="$TEST_TMP/read-only.json"
  local capture="$TEST_TMP/request.json"
  local fake_curl="$TEST_TMP/fake-curl"
  write_response "$response" "makesafe_attendance_cycles_u2_s1" "$(migration_sha)" '[]'
  CAPTURE_FILE="$capture" RESPONSE_FILE="$response" python3 - "$fake_curl" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).write_text("""#!/usr/bin/env python3
import os
import shutil
import sys

args = sys.argv[1:]
output_path = args[args.index('-o') + 1]
payload_path = args[args.index('--data-binary') + 1][1:]
shutil.copyfile(payload_path, os.environ['CAPTURE_FILE'])
shutil.copyfile(os.environ['RESPONSE_FILE'], output_path)
print('200', end='')
""")
Path(sys.argv[1]).chmod(0o755)
PY
  CAPTURE_FILE="$capture" RESPONSE_FILE="$response" CURL_BIN="$fake_curl" \
    SUPABASE_ACCESS_TOKEN=test bash "$PREFLIGHT" ops-api >"$TEST_TMP/read-only-output" 2>&1
  local rc=$?
  local safety_result
  safety_result="$(CAPTURE_FILE="$capture" PREFLIGHT="$PREFLIGHT" python3 <<'PY'
import json
import os
import re
from pathlib import Path

source = Path(os.environ['PREFLIGHT']).read_text()
payload = json.loads(Path(os.environ['CAPTURE_FILE']).read_text())
query = payload['query']
forbidden = re.compile(
    r"\b(?:insert|update|delete|merge|create|alter|drop|truncate|grant|revoke)\b|"
    r"\bsupabase\s+(?:db\s+push|migration\s+apply)\b",
    re.IGNORECASE,
)
hostile_queries = [
    'UPDATE public.jobs SET status = \'x\'',
    'DELETE FROM "public"."jobs"',
    'CREATE TABLE public.shadow (id integer)',
]
if any(not forbidden.search(hostile) for hostile in hostile_queries):
    raise SystemExit('hostile write statement was not rejected')
source_without_cleanup_flag = re.sub(r"(?<!\w)-delete\b", "", source)
if forbidden.search(query) or forbidden.search(source_without_cleanup_flag):
    raise SystemExit('write or migration-application operation found')
if 'extensions.digest(' not in query:
    raise SystemExit('generated query does not schema-qualify digest')
if 'convert_to(m.statements[1]' not in query or 'array_to_json(m.statements)' in query:
    raise SystemExit('generated query does not compare raw statement bytes like-for-like')
print('safe')
PY
)"
  if [[ "$rc" -eq 0 ]] && [[ "$safety_result" == "safe" ]]; then
    pass "$name"
  else
    fail "$name" "read-only boundary failed: rc=$rc result=$safety_result"
  fi
}

main() {
  echo "Running Edge Function schema preflight tests..."
  echo
  if [[ ! -f "$PREFLIGHT" || ! -f "$MANIFEST" || ! -f "$MIGRATION" || ! -f "$MEDIA_MIGRATION" || ! -f "$FRESH_HEALTH_MIGRATION" || ! -f "$U5_U6_MIGRATION" || ! -f "$FENCE_HARDENING_MIGRATION" || ! -f "$DOCS_READY_MIGRATION" || ! -f "$SIBLING_EVIDENCE_MIGRATION" || ! -f "$PORTAL_CAPTURE_MIGRATION" || ! -f "$SEED_SCOPE_MIGRATION" || ! -f "$HUGO_NOTIFICATION_MIGRATION" || ! -f "$CYCLE_UNIQUENESS_MIGRATION" || ! -f "$PDF_EXTRACTION_MIGRATION" || ! -f "$INTAKE_SETTLEMENT_MIGRATION" || ! -f "$BOARD_V2_PREVIEW_MIGRATION" || ! -f "$VAULT_SYNC_MIGRATION" || ! -f "$SES_RECOVERY_MIGRATION" || ! -f "$ROOF_INITIAL_CYCLE_MIGRATION" || ! -f "$INVOICE_BOUND_ADOPT_MIGRATION" || ! -f "$RELEASE_ROUTE_KIND_MIGRATION" || ! -f "$MAILER_OPS_SEND_MIGRATION" || ! -f "$ECHO_CODE_APPROVAL_MIGRATION" ]]; then
    fail "test_setup" "preflight, manifest, or canonical migration missing"
  else
    test_incident_dependency_is_declared
    test_missing_migration_refuses_before_deploy
    test_missing_trade_invoice_requirement_refuses_before_deploy
    test_multi_statement_ledger_may_deploy
    test_missing_schema_marker_refuses
    test_raw_statement_checksum_drift_is_advisory
    test_raw_statement_checksum_matches_like_for_like
    test_unrelated_function_without_requirements_passes_without_credentials
    test_fixture_response_requires_explicit_test_mode
    test_read_only_safety_boundary
  fi

  echo
  echo "Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    echo "Failed tests:" >&2
    printf '  %s\n' "${FAILED_TESTS[@]}" >&2
    exit 1
  fi
  echo "All tests passed."
}

main "$@"

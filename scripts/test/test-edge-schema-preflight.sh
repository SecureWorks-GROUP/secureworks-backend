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
HUGO_NOTIFICATION_MIGRATION="$REPO_ROOT/supabase/migrations/20260729010000_makesafe_hugo_notification_sla_v1.sql"
CYCLE_UNIQUENESS_MIGRATION="$REPO_ROOT/supabase/migrations/20260730000001_makesafe_report_cycle_uniqueness.sql"
PDF_EXTRACTION_MIGRATION="$REPO_ROOT/supabase/migrations/20260731000001_makesafe_pdf_extraction_belt.sql"
INTAKE_SETTLEMENT_MIGRATION="$REPO_ROOT/supabase/migrations/20260731000002_makesafe_intake_settlement_closure.sql"
BOARD_V2_PREVIEW_MIGRATION="$REPO_ROOT/supabase/migrations/20260731085928_board_v2_seed_preview.sql"
VAULT_SYNC_MIGRATION="$REPO_ROOT/supabase/migrations/20260731152254_vault_sync_sw_api_key.sql"
SES_RECOVERY_MIGRATION="$REPO_ROOT/supabase/migrations/20260801000001_ses_adjudicated_job_recovery.sql"

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
  HUGO_NOTIFICATION_EXPECTED_SHA="$(hugo_notification_migration_sha)" \
  CYCLE_UNIQUENESS_EXPECTED_SHA="$(cycle_uniqueness_migration_sha)" \
  PDF_EXTRACTION_EXPECTED_SHA="$(pdf_extraction_migration_sha)" \
  INTAKE_SETTLEMENT_EXPECTED_SHA="$(intake_settlement_migration_sha)" \
  BOARD_V2_PREVIEW_EXPECTED_SHA="$(board_v2_preview_migration_sha)" \
  VAULT_SYNC_EXPECTED_SHA="$(vault_sync_migration_sha)" \
  SES_RECOVERY_EXPECTED_SHA="$(ses_recovery_migration_sha)" \
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
    "migration_version": "20260801000001",
    "expected_migration_name": "ses_adjudicated_job_recovery",
    "expected_statement_sha256": os.environ["SES_RECOVERY_EXPECTED_SHA"],
    "actual_migration_version": "20260801000001",
    "actual_migration_name": "ses_adjudicated_job_recovery",
    "actual_statement_count": 5,
    "actual_statement_sha256": None,
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
            seed_scope_row,
            hugo_notification_row,
            cycle_uniqueness_row,
            pdf_extraction_row,
            intake_settlement_row,
            board_v2_preview_row,
            vault_sync_row,
            ses_recovery_row,
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
  local ses_recovery_expected='ops-api|supabase/migrations/20260801000001_ses_adjudicated_job_recovery.sql|function|bind_adjudicated_ses_existing_job'
  if grep -Fxq "$report_expected" "$MANIFEST" && \
    grep -Fxq "$media_expected" "$MANIFEST" && \
    grep -Fxq "$fresh_health_expected" "$MANIFEST" && \
    grep -Fxq "$seed_scope_expected" "$MANIFEST" && \
    grep -Fxq "$board_v2_preview_expected" "$MANIFEST" && \
    grep -Fxq "$vault_sync_expected" "$MANIFEST" && \
    grep -Fxq "$ses_recovery_expected" "$MANIFEST"; then
    pass "$name"
  else
    fail "$name" "the report, media-cycle, fresh-source health, seed-scope, board-v2 preview, vault-sync, and SES recovery markers are not permanent ops-api deploy requirements"
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
  if [[ ! -f "$PREFLIGHT" || ! -f "$MANIFEST" || ! -f "$MIGRATION" || ! -f "$MEDIA_MIGRATION" || ! -f "$FRESH_HEALTH_MIGRATION" || ! -f "$U5_U6_MIGRATION" || ! -f "$FENCE_HARDENING_MIGRATION" || ! -f "$DOCS_READY_MIGRATION" || ! -f "$SIBLING_EVIDENCE_MIGRATION" || ! -f "$PORTAL_CAPTURE_MIGRATION" || ! -f "$SEED_SCOPE_MIGRATION" || ! -f "$HUGO_NOTIFICATION_MIGRATION" || ! -f "$CYCLE_UNIQUENESS_MIGRATION" || ! -f "$PDF_EXTRACTION_MIGRATION" || ! -f "$INTAKE_SETTLEMENT_MIGRATION" || ! -f "$BOARD_V2_PREVIEW_MIGRATION" || ! -f "$VAULT_SYNC_MIGRATION" || ! -f "$SES_RECOVERY_MIGRATION" ]]; then
    fail "test_setup" "preflight, manifest, or canonical migration missing"
  else
    test_incident_dependency_is_declared
    test_missing_migration_refuses_before_deploy
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

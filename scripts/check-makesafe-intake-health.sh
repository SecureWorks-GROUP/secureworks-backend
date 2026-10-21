#!/usr/bin/env bash
# The make-safe intake watchdog's one check, run from outside Supabase by
# .github/workflows/makesafe-intake-watchdog.yml every 30 minutes.
#
# It reads the single makesafe_intake_health row through the Supabase
# Management API `/database/query` endpoint with `read_only: true`, the same
# read-only lane the deploy preflight and the SES checkers use, and fails when
# the read cannot be made (project paused or unreachable, token refused) or the
# last completed intake scan is older than STALE_MINUTES.
#
# Why not ops-api `intake_health`: since PR #667 (12 Aug 2026) ops-api refuses
# the shared SW_API_KEY on every protected action, and intake_health is one.
# The watchdog was red on every run from then until this script replaced the
# probe. The read below is the same two fields the action published as
# `extraction.last_scan_at` and `extraction.status`.
#
# Read-only by construction: one fixed SELECT, sent with `read_only: true`, so
# the database runs it in a read-only transaction. The token is never printed.

set -euo pipefail

PROJECT_REF="${PROJECT_REF:-kevgrhcjxspbxgovpmfl}"
MANAGEMENT_API_BASE="${SUPABASE_MANAGEMENT_API_BASE:-https://api.supabase.com}"
CURL_BIN="${CURL_BIN:-curl}"
STALE_MINUTES="${STALE_MINUTES:-30}"

fail() {
  echo "FAIL make-safe intake watchdog: $*" >&2
  exit 1
}

[[ "$PROJECT_REF" =~ ^[a-z0-9]+$ ]] || fail "invalid PROJECT_REF"
[[ "$STALE_MINUTES" =~ ^[1-9][0-9]*$ ]] ||
  fail "STALE_MINUTES must be a positive whole number of minutes (got '${STALE_MINUTES}')"
[[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]] ||
  fail "SUPABASE_ACCESS_TOKEN is not set; the watchdog cannot read intake health. It is a production environment secret, so the job must declare 'environment: production'."

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t makesafe-intake-health)"
cleanup() {
  find "$TMP_DIR" -depth -delete
}
trap cleanup EXIT

# The scan age is computed by the database clock, so a runner clock or a
# timestamp format can never make a stale scan read as fresh.
python3 - "$TMP_DIR/payload.json" <<'PY'
import json
import sys
from pathlib import Path

query = (
    "SELECT last_scan_at, extraction_status, "
    "floor(extract(epoch FROM (now() - last_scan_at)) / 60)::bigint AS scan_age_minutes "
    "FROM public.makesafe_intake_health WHERE id = true"
)
Path(sys.argv[1]).write_text(json.dumps({"query": query, "read_only": True}))
PY

echo "Reading makesafe_intake_health on project ${PROJECT_REF} (read-only)"
HTTP_CODE="$("$CURL_BIN" -sS --max-time 25 \
  -o "$TMP_DIR/response.json" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: SecureWorks-MakeSafe-Intake-Watchdog/1.0' \
  --data-binary @"$TMP_DIR/payload.json" \
  "${MANAGEMENT_API_BASE}/v1/projects/${PROJECT_REF}/database/query")" || HTTP_CODE="000"

python3 - "$TMP_DIR/response.json" "$HTTP_CODE" "$STALE_MINUTES" <<'PY'
import json
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"FAIL make-safe intake watchdog: {message}")


response_path = Path(sys.argv[1])
http_code = sys.argv[2]
stale_minutes = int(sys.argv[3])
raw = response_path.read_text() if response_path.exists() else ""

if http_code == "000":
    fail(
        "the Supabase Management API could not be reached, so intake health is unknown. "
        "Supabase itself may be down."
    )
if not http_code.isdigit() or not 200 <= int(http_code) < 300:
    detail = raw[:500].strip() or "<empty body>"
    fail(
        f"the intake health read returned HTTP {http_code}. The project may be paused or "
        f"down, or the access token was refused. Response: {detail}"
    )
try:
    rows = json.loads(raw)
except Exception as exc:
    fail(f"the intake health read did not return JSON: {exc}")
if not isinstance(rows, list):
    fail("the intake health read did not return a row list")
if len(rows) != 1 or not isinstance(rows[0], dict):
    fail(
        f"expected exactly one makesafe_intake_health row, got {len(rows)}. "
        "The intake scan may never have completed a run."
    )

row = rows[0]
last_scan_at = row.get("last_scan_at")
status = row.get("extraction_status") or "unknown"
age = row.get("scan_age_minutes")
print(f"extraction_status={status} last_scan_at={last_scan_at or '<none>'}")

if not last_scan_at:
    fail("makesafe_intake_health has no last_scan_at. The intake scan may never have completed a run.")
try:
    age_minutes = int(age)
except (TypeError, ValueError):
    fail(f"could not read the scan age (scan_age_minutes={age!r}).")

print(f"last completed scan was {age_minutes} min ago (budget {stale_minutes} min)")
if age_minutes > stale_minutes:
    fail(
        f"make-safe intake scan is STALE ({age_minutes} min > {stale_minutes} min). "
        "The email-to-card pipeline is not running, and the in-function alarms may be down "
        "too (pg_cron off or the project paused)."
    )

print(f"OK: make-safe intake pipeline healthy (scan {age_minutes} min ago, status={status}).")
PY

#!/usr/bin/env bash
# Refuse a production Edge Function deploy until its declared database schema
# requirements are present. This is read-only: it queries catalog + migration
# ledger state through the Supabase Management API and never applies SQL.
#
# Deployment is refused only when the declared migration VERSION is absent or a
# schema marker the function queries is absent/not queryable. File-byte checksum
# equality is advisory. A one-statement ledger entry is compared directly with
# the checked-in raw bytes; parsed multi-statement entries cannot be reproduced
# from the file without the exact writer/parser version, so their checksum stays
# unavailable rather than comparing unlike JSON-array and raw-file encodings.

set -euo pipefail

PROJECT_REF="${PROJECT_REF:-kevgrhcjxspbxgovpmfl}"
MANIFEST="${EDGE_SCHEMA_REQUIREMENTS_FILE:-scripts/edge-function-schema-requirements.txt}"
MANAGEMENT_API_BASE="${SUPABASE_MANAGEMENT_API_BASE:-https://api.supabase.com}"
CURL_BIN="${CURL_BIN:-curl}"

fail() {
  echo "FAIL edge schema preflight: $*" >&2
  exit 1
}

if [[ "$#" -gt 0 ]]; then
  FUNCTIONS=("$@")
else
  # GitHub Actions supplies the classifier's space-delimited, validated function
  # names through this variable so workflow YAML never shell-expands an output.
  read -r -a FUNCTIONS <<< "${CHANGED_FUNCTIONS:-}"
fi

[[ "${#FUNCTIONS[@]}" -gt 0 ]] || fail "no changed function names supplied"
[[ -f "$MANIFEST" ]] || fail "requirements manifest not found: $MANIFEST"

for function_name in "${FUNCTIONS[@]}"; do
  [[ "$function_name" =~ ^[A-Za-z0-9_-]+$ ]] ||
    fail "invalid function name: $function_name"
done

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t edge-schema-preflight)"
cleanup() {
  find "$TMP_DIR" -depth -delete
}
trap cleanup EXIT

# Parse and validate the declarative manifest, hash canonical migration files,
# and emit one bounded catalog SELECT plus the local expectations used to check
# the response. No checked-in SQL is submitted to production.
python3 - "$MANIFEST" "$TMP_DIR/query.sql" "$TMP_DIR/expected.json" "${FUNCTIONS[@]}" <<'PY'
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
query_path = Path(sys.argv[2])
expected_path = Path(sys.argv[3])
selected = set(sys.argv[4:])

function_re = re.compile(r"^[A-Za-z0-9_-]+$")
migration_re = re.compile(
    r"^supabase/migrations/(?P<version>[0-9]{14})_(?P<name>[a-z0-9_]+)\.sql$"
)
identifier_re = re.compile(r"^[a-z_][a-z0-9_]*$")
marker_kinds = {"table", "column", "constraint", "index", "policy", "trigger"}

def validate_marker(kind: str, marker: str, line_no: int) -> None:
    parts = marker.split(".")
    expected_parts = 2 if kind in {"column", "policy", "trigger"} else 1
    if len(parts) != expected_parts or any(not identifier_re.fullmatch(p) for p in parts):
        raise SystemExit(
            f"{manifest_path}:{line_no}: invalid {kind} marker {marker!r}"
        )

requirements: dict[tuple[str, str], dict[str, object]] = {}
for line_no, raw in enumerate(manifest_path.read_text().splitlines(), 1):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    parts = line.split("|")
    if len(parts) != 4:
        raise SystemExit(f"{manifest_path}:{line_no}: expected four pipe-delimited fields")
    function_name, migration_file, marker_kind, marker_name = parts
    if not function_re.fullmatch(function_name):
        raise SystemExit(f"{manifest_path}:{line_no}: invalid function name {function_name!r}")
    match = migration_re.fullmatch(migration_file)
    if not match:
        raise SystemExit(f"{manifest_path}:{line_no}: invalid canonical migration path")
    if marker_kind not in marker_kinds:
        raise SystemExit(f"{manifest_path}:{line_no}: unknown marker kind {marker_kind!r}")
    validate_marker(marker_kind, marker_name, line_no)
    if function_name not in selected:
        continue
    migration_path = Path(migration_file)
    if not migration_path.is_file():
        raise SystemExit(f"{manifest_path}:{line_no}: migration file missing: {migration_file}")
    key = (function_name, migration_file)
    requirement = requirements.setdefault(
        key,
        {
            "function_name": function_name,
            "migration_file": migration_file,
            "migration_version": match.group("version"),
            "migration_name": match.group("name"),
            "statement_sha256": hashlib.sha256(migration_path.read_bytes()).hexdigest(),
            "markers": [],
        },
    )
    marker = {"kind": marker_kind, "name": marker_name}
    if marker in requirement["markers"]:
        raise SystemExit(f"{manifest_path}:{line_no}: duplicate marker {marker_kind}:{marker_name}")
    requirement["markers"].append(marker)

ordered = sorted(
    requirements.values(),
    key=lambda r: (str(r["function_name"]), str(r["migration_version"])),
)
expected_path.write_text(json.dumps(ordered, sort_keys=True))
if not ordered:
    query_path.write_text("")
    raise SystemExit(0)

# Every interpolated value has already passed a strict identifier/path regex.
def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"

requirement_values = []
marker_values = []
for req_id, requirement in enumerate(ordered, 1):
    requirement_values.append(
        "(" + ",".join(
            [
                str(req_id),
                sql_literal(str(requirement["function_name"])),
                sql_literal(str(requirement["migration_version"])),
                sql_literal(str(requirement["migration_name"])),
                sql_literal(str(requirement["statement_sha256"])),
            ]
        ) + ")"
    )
    for marker in requirement["markers"]:
        marker_values.append(
            f"({req_id},{sql_literal(marker['kind'])},{sql_literal(marker['name'])})"
        )

query = f"""
WITH requirements(req_id, function_name, migration_version, expected_name, expected_sha256) AS (
  VALUES {','.join(requirement_values)}
),
required_markers(req_id, marker_kind, marker_name) AS (
  VALUES {','.join(marker_values)}
),
marker_state AS (
  SELECT rm.req_id, rm.marker_kind, rm.marker_name,
    CASE rm.marker_kind
      WHEN 'table' THEN to_regclass('public.' || rm.marker_name) IS NOT NULL
      WHEN 'column' THEN EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = split_part(rm.marker_name, '.', 1)
          AND c.column_name = split_part(rm.marker_name, '.', 2)
      )
      WHEN 'constraint' THEN EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE n.nspname = 'public' AND c.conname = rm.marker_name
      )
      WHEN 'index' THEN EXISTS (
        SELECT 1 FROM pg_indexes i
        WHERE i.schemaname = 'public' AND i.indexname = rm.marker_name
      )
      WHEN 'policy' THEN EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = split_part(rm.marker_name, '.', 1)
          AND p.policyname = split_part(rm.marker_name, '.', 2)
      )
      WHEN 'trigger' THEN EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class r ON r.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE n.nspname = 'public'
          AND r.relname = split_part(rm.marker_name, '.', 1)
          AND t.tgname = split_part(rm.marker_name, '.', 2)
          AND NOT t.tgisinternal
      )
      ELSE false
    END AS present
  FROM required_markers rm
)
SELECT
  r.function_name,
  r.migration_version,
  r.expected_name AS expected_migration_name,
  r.expected_sha256 AS expected_statement_sha256,
  m.version AS actual_migration_version,
  m.name AS actual_migration_name,
  CASE WHEN m.version IS NULL THEN NULL ELSE cardinality(m.statements)
  END AS actual_statement_count,
  CASE WHEN m.version IS NULL OR cardinality(m.statements) <> 1 THEN NULL
       ELSE encode(
         extensions.digest(convert_to(m.statements[1], 'UTF8'), 'sha256'),
         'hex'
       )
  END AS actual_statement_sha256,
  COALESCE((
    SELECT json_agg(ms.marker_kind || ':' || ms.marker_name ORDER BY ms.marker_kind, ms.marker_name)
    FROM marker_state ms
    WHERE ms.req_id = r.req_id AND NOT ms.present
  ), '[]'::json) AS missing_markers
FROM requirements r
LEFT JOIN supabase_migrations.schema_migrations m
  ON m.version = r.migration_version
ORDER BY r.function_name, r.migration_version;
"""
query_path.write_text(query)
PY

if [[ ! -s "$TMP_DIR/query.sql" ]]; then
  echo "PASS edge schema preflight: no declared requirements for ${FUNCTIONS[*]}"
  exit 0
fi

if [[ -n "${SUPABASE_SCHEMA_PREFLIGHT_RESPONSE_FILE:-}" ]]; then
  [[ "${EDGE_SCHEMA_PREFLIGHT_TEST_MODE:-}" == "1" ]] ||
    fail "fixture response is allowed only in explicit test mode"
  [[ -f "$SUPABASE_SCHEMA_PREFLIGHT_RESPONSE_FILE" ]] ||
    fail "fixture response file not found"
  cp "$SUPABASE_SCHEMA_PREFLIGHT_RESPONSE_FILE" "$TMP_DIR/response.json"
  HTTP_CODE=200
else
  [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]] ||
    fail "SUPABASE_ACCESS_TOKEN is required"
  python3 -c 'import json,sys; print(json.dumps({"query": sys.stdin.read()}))' \
    < "$TMP_DIR/query.sql" > "$TMP_DIR/payload.json"
  HTTP_CODE="$($CURL_BIN -sS --max-time 90 \
    -o "$TMP_DIR/response.json" -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary @"$TMP_DIR/payload.json" \
    "${MANAGEMENT_API_BASE}/v1/projects/${PROJECT_REF}/database/query")"
fi

python3 - "$TMP_DIR/expected.json" "$TMP_DIR/response.json" "$HTTP_CODE" "$PROJECT_REF" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

expected = json.loads(Path(sys.argv[1]).read_text())
try:
    response = json.loads(Path(sys.argv[2]).read_text())
except Exception as exc:
    raise SystemExit(f"FAIL edge schema preflight: management response is not JSON: {exc}")
http_code = int(sys.argv[3])
project_ref = sys.argv[4]
if http_code not in {200, 201}:
    message = response.get("message") if isinstance(response, dict) else None
    raise SystemExit(
        f"FAIL edge schema preflight: production catalog query returned HTTP {http_code}"
        + (f" ({message})" if message else "")
    )
if not isinstance(response, list):
    raise SystemExit("FAIL edge schema preflight: production catalog response is not a row list")

rows = {
    (str(row.get("function_name")), str(row.get("migration_version"))): row
    for row in response
    if isinstance(row, dict)
}
failures: list[str] = []
warnings: list[str] = []
print("schema_preflight:")
print(f"  project_ref: {project_ref}")
print(f"  requirements_checked: {len(expected)}")
for requirement in expected:
    key = (requirement["function_name"], requirement["migration_version"])
    row = rows.get(key)
    label = f"{key[0]} requires {key[1]}_{requirement['migration_name']}"
    if row is None:
        failures.append(f"{label}: no catalog result returned")
        continue
    if row.get("expected_migration_name") != requirement["migration_name"] or \
       row.get("expected_statement_sha256") != requirement["statement_sha256"]:
        failures.append(f"{label}: query expectation drifted from the local manifest")
        continue
    actual_version = row.get("actual_migration_version")
    actual_name = row.get("actual_migration_name")
    actual_statement_count = row.get("actual_statement_count")
    actual_sha = row.get("actual_statement_sha256")
    missing_markers = row.get("missing_markers")
    if actual_version is None:
        failures.append(f"{label}: migration ledger row is missing")
        continue
    if actual_name != requirement["migration_name"]:
        warnings.append(
            f"{label}: advisory ledger name drift (found {actual_name!r})"
        )
    if not isinstance(actual_statement_count, int) or actual_statement_count < 1:
        warnings.append(f"{label}: advisory ledger statement set is missing or empty")
    if actual_statement_count != 1:
        warnings.append(
            f"{label}: advisory raw-file checksum is unavailable for "
            f"{actual_statement_count} parsed ledger statements"
        )
    elif not isinstance(actual_sha, str) or not actual_sha:
        warnings.append(f"{label}: advisory raw-statement checksum is unavailable")
    elif actual_sha != requirement["statement_sha256"]:
        warnings.append(
            f"{label}: advisory raw-statement checksum differs from checked-in raw file bytes"
        )
    if not isinstance(missing_markers, list):
        failures.append(f"{label}: missing-marker result is malformed")
    elif missing_markers:
        failures.append(
            f"{label}: required production markers missing: {', '.join(missing_markers)}"
        )
    if not any(f.startswith(label + ":") for f in failures):
        print(
            f"  PASS {key[0]} migration={key[1]} markers={len(requirement['markers'])}"
        )

for warning in warnings:
    print(f"  WARN {warning}", file=sys.stderr)
if failures:
    for failure in failures:
        print(f"  FAIL {failure}", file=sys.stderr)
    print(
        "Refusing Edge Function deploy. Apply only the reviewed required migration, "
        "then rerun this read-only preflight.",
        file=sys.stderr,
    )
    raise SystemExit(1)
print("PASS edge schema preflight: every declared production requirement is present")
PY

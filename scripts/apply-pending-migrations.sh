#!/usr/bin/env bash
# Apply repository migrations missing from the production migration ledger.
#
# Safety contract:
# - exact-file audited exclusions are never applied or misrecorded;
# - unledgered version collisions fail unless every colliding file is excluded;
# - each migration API transaction must succeed before its ledger write begins;
# - each ledger write is read back and checked against the exact raw file bytes;
# - GitHub Actions serializes production deploy runs around this script.

set -euo pipefail

PROJECT_REF="${PROJECT_REF:-kevgrhcjxspbxgovpmfl}"
EXPECTED_PROJECT_REF="kevgrhcjxspbxgovpmfl"
MANAGEMENT_API_BASE="${SUPABASE_MANAGEMENT_API_BASE:-https://api.supabase.com}"
CURL_BIN="${CURL_BIN:-curl}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_DIR="${SUPABASE_MIGRATION_DIR:-$REPO_ROOT/supabase/migrations}"
EXCLUSIONS_FILE="${MIGRATION_AUTOAPPLY_EXCLUSIONS_FILE:-$SCRIPT_DIR/migration-autoapply-exclusions.txt}"
LEDGER_ALIASES_FILE="${MIGRATION_AUTOAPPLY_LEDGER_ALIASES_FILE:-$SCRIPT_DIR/migration-autoapply-ledger-aliases.txt}"
MIN_VERSION="${MIGRATION_AUTOAPPLY_MIN_VERSION:-20260722000001}"
MODE=apply

if [[ "${1:-}" == "--dry-run" ]]; then
  MODE=dry-run
  shift
fi
[[ "$#" -eq 0 ]] || {
  echo "Usage: $0 [--dry-run]" >&2
  exit 64
}

fail() {
  echo "FAIL migration auto-apply: $*" >&2
  exit 1
}

for command_name in python3 "$CURL_BIN"; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required command is unavailable: $command_name"
done
[[ -d "$MIGRATION_DIR" ]] || fail "migration directory not found: $MIGRATION_DIR"
[[ -f "$EXCLUSIONS_FILE" ]] || fail "exclusions ledger not found: $EXCLUSIONS_FILE"
[[ -f "$LEDGER_ALIASES_FILE" ]] || fail "ledger aliases file not found: $LEDGER_ALIASES_FILE"
[[ "$PROJECT_REF" == "$EXPECTED_PROJECT_REF" ]] ||
  fail "runner is production-locked to project ${EXPECTED_PROJECT_REF}"
[[ "$MIN_VERSION" =~ ^[0-9]{14}$ ]] || fail "invalid migration baseline: $MIN_VERSION"
[[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]] || fail "SUPABASE_ACCESS_TOKEN is required"

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t migration-autoapply)"
cleanup() {
  find "$TMP_DIR" -depth -delete
}
trap cleanup EXIT

run_sql_file() {
  local sql_file="$1"
  local response_file="$2"
  local label="$3"
  local payload_file="$TMP_DIR/payload.json"
  local http_code

  python3 - "$sql_file" "$payload_file" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[2]).write_text(json.dumps({"query": Path(sys.argv[1]).read_text()}))
PY

  http_code="$("$CURL_BIN" -sS --max-time 300 \
    -o "$response_file" -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    -H 'User-Agent: SecureWorks-Migration-Autoapply/1.0' \
    --data-binary @"$payload_file" \
    "${MANAGEMENT_API_BASE}/v1/projects/${PROJECT_REF}/database/query")" ||
    fail "$label transport failed"

  python3 - "$response_file" "$http_code" "$label" <<'PY'
import json
import sys
from pathlib import Path

response_path = Path(sys.argv[1])
http_code = int(sys.argv[2])
label = sys.argv[3]
try:
    response = json.loads(response_path.read_text())
except Exception as exc:
    raise SystemExit(
        f"FAIL migration auto-apply: {label} returned non-JSON: {exc}"
    )
if not 200 <= http_code < 300:
    detail = response.get("message") if isinstance(response, dict) else response
    raise SystemExit(
        f"FAIL migration auto-apply: {label} returned HTTP {http_code}: {detail}"
    )
if not isinstance(response, list):
    raise SystemExit(
        f"FAIL migration auto-apply: {label} returned a non-row success payload"
    )
PY
}

write_ledger_query() {
  cat > "$1" <<'SQL'
SELECT
  version,
  name,
  cardinality(statements) AS statement_count,
  CASE
    WHEN cardinality(statements) = 1 THEN
      encode(
        extensions.digest(convert_to(statements[1], 'UTF8'), 'sha256'),
        'hex'
      )
    ELSE NULL
  END AS raw_statement_sha256
FROM supabase_migrations.schema_migrations
ORDER BY version;
SQL
}

build_plan() {
  local ledger_response="$1"
  local plan_file="$2"
  python3 - \
    "$MIGRATION_DIR" \
    "$EXCLUSIONS_FILE" \
    "$LEDGER_ALIASES_FILE" \
    "$ledger_response" \
    "$plan_file" \
    "$MIN_VERSION" <<'PY'
from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

migration_dir = Path(sys.argv[1])
exclusions_path = Path(sys.argv[2])
aliases_path = Path(sys.argv[3])
ledger_path = Path(sys.argv[4])
plan_path = Path(sys.argv[5])
min_version = sys.argv[6]
migration_re = re.compile(r"^(?P<version>[0-9]{14})_(?P<name>[a-z0-9_]+)\.sql$")
sha_re = re.compile(r"^[0-9a-f]{64}$")

exclusions: dict[str, dict[str, str]] = {}
for line_no, raw in enumerate(exclusions_path.read_text().splitlines(), 1):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    parts = line.split("|", 3)
    if len(parts) != 4:
        raise SystemExit(
            f"FAIL migration auto-apply: {exclusions_path}:{line_no}: "
            "expected path|sha256|audit_key|reason"
        )
    path, expected_sha, audit_key, reason = parts
    if path in exclusions:
        raise SystemExit(
            f"FAIL migration auto-apply: duplicate exclusion for {path}"
        )
    if not path.startswith("supabase/migrations/") or "/" in path.removeprefix(
        "supabase/migrations/"
    ):
        raise SystemExit(
            f"FAIL migration auto-apply: invalid exclusion path {path!r}"
        )
    if not sha_re.fullmatch(expected_sha):
        raise SystemExit(
            f"FAIL migration auto-apply: invalid exclusion SHA-256 for {path}"
        )
    if not re.fullmatch(r"[a-z0-9_]+", audit_key) or not reason.strip():
        raise SystemExit(
            f"FAIL migration auto-apply: invalid audit metadata for {path}"
        )
    exclusions[path] = {
        "sha256": expected_sha,
        "audit_key": audit_key,
        "reason": reason,
    }

aliases: dict[str, dict[str, str]] = {}
for line_no, raw in enumerate(aliases_path.read_text().splitlines(), 1):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    parts = line.split("|", 5)
    if len(parts) != 6:
        raise SystemExit(
            f"FAIL migration auto-apply: {aliases_path}:{line_no}: "
            "expected path|sha256|ledger_version|ledger_name|ledger_raw_statement_sha256|reason"
        )
    (
        path,
        expected_sha,
        ledger_version,
        ledger_name,
        ledger_raw_statement_sha256,
        reason,
    ) = parts
    if path in aliases or path in exclusions:
        raise SystemExit(
            f"FAIL migration auto-apply: duplicate migration exception for {path}"
        )
    if not path.startswith("supabase/migrations/") or "/" in path.removeprefix(
        "supabase/migrations/"
    ):
        raise SystemExit(
            f"FAIL migration auto-apply: invalid ledger alias path {path!r}"
        )
    if not sha_re.fullmatch(expected_sha):
        raise SystemExit(
            f"FAIL migration auto-apply: invalid ledger alias SHA-256 for {path}"
        )
    if not re.fullmatch(r"[0-9]{14}", ledger_version):
        raise SystemExit(
            f"FAIL migration auto-apply: invalid ledger alias version for {path}"
        )
    if not re.fullmatch(r"[a-z0-9_]+", ledger_name) or not reason.strip():
        raise SystemExit(
            f"FAIL migration auto-apply: invalid ledger alias metadata for {path}"
        )
    if not sha_re.fullmatch(ledger_raw_statement_sha256):
        raise SystemExit(
            f"FAIL migration auto-apply: invalid ledger raw statement SHA-256 for {path}"
        )
    aliases[path] = {
        "sha256": expected_sha,
        "ledger_version": ledger_version,
        "ledger_name": ledger_name,
        "ledger_raw_statement_sha256": ledger_raw_statement_sha256,
        "reason": reason,
    }

by_version: dict[str, list[dict[str, str]]] = defaultdict(list)
seen_paths: set[str] = set()
legacy_baseline: list[dict[str, str]] = []
for migration_path in sorted(migration_dir.glob("*.sql")):
    match = migration_re.fullmatch(migration_path.name)
    if not match:
        raise SystemExit(
            f"FAIL migration auto-apply: invalid migration filename "
            f"{migration_path.name!r}"
        )
    relative_path = f"supabase/migrations/{migration_path.name}"
    sha256 = hashlib.sha256(migration_path.read_bytes()).hexdigest()
    entry = {
        "version": match.group("version"),
        "name": match.group("name"),
        "path": relative_path,
        "absolute_path": str(migration_path),
        "sha256": sha256,
    }
    seen_paths.add(relative_path)
    if entry["version"] < min_version:
        legacy_baseline.append(entry)
    else:
        by_version[entry["version"]].append(entry)

for path, exception in {**exclusions, **aliases}.items():
    if path not in seen_paths:
        raise SystemExit(
            f"FAIL migration auto-apply: migration exception is missing: {path}"
        )
    actual_path = migration_dir / Path(path).name
    actual_sha = hashlib.sha256(actual_path.read_bytes()).hexdigest()
    if actual_sha != exception["sha256"]:
        raise SystemExit(
            f"FAIL migration auto-apply: exception hash drift for {path}: "
            f"expected {exception['sha256']}, got {actual_sha}"
        )

try:
    ledger_rows = json.loads(ledger_path.read_text())
except Exception as exc:
    raise SystemExit(f"FAIL migration auto-apply: invalid ledger response: {exc}")
if not isinstance(ledger_rows, list):
    raise SystemExit("FAIL migration auto-apply: ledger response is not a row list")

ledger: dict[str, dict[str, object]] = {}
for row in ledger_rows:
    if not isinstance(row, dict) or not str(row.get("version", "")).isdigit():
        raise SystemExit("FAIL migration auto-apply: malformed migration ledger row")
    version = str(row["version"])
    if version in ledger:
        raise SystemExit(
            f"FAIL migration auto-apply: duplicate ledger version {version}"
        )
    ledger[version] = row

plan: dict[str, object] = {
    "legacy_baseline": legacy_baseline,
    "ledgered": [],
    "ledger_aliases": [],
    "excluded": [],
    "pending": [],
}
plan["minimum_version"] = min_version
for path, alias in aliases.items():
    ledger_row = ledger.get(alias["ledger_version"])
    if (
        ledger_row is None
        or ledger_row.get("name") != alias["ledger_name"]
        or ledger_row.get("statement_count") != 1
        or ledger_row.get("raw_statement_sha256") != alias["ledger_raw_statement_sha256"]
    ):
        raise SystemExit(
            f"FAIL migration auto-apply: ledger alias for {path} is not "
            f"verified as {alias['ledger_version']}_{alias['ledger_name']} "
            "with one matching raw statement"
        )

def append_accounted_entry(entry: dict[str, str]) -> None:
    exclusion = exclusions.get(entry["path"])
    alias = aliases.get(entry["path"])
    if exclusion:
        plan["excluded"].append({**entry, **exclusion})
    elif alias:
        plan["ledger_aliases"].append({**entry, **alias})
    else:
        raise SystemExit(
            f"FAIL migration auto-apply: unaccounted migration {entry['path']}"
        )

for version, entries in sorted(by_version.items()):
    entries.sort(key=lambda entry: entry["name"])
    ledger_row = ledger.get(version)
    if ledger_row is not None:
        exact_entries = [
            entry for entry in entries if entry["name"] == ledger_row.get("name")
        ]
        if len(exact_entries) > 1:
            raise SystemExit(
                f"FAIL migration auto-apply: duplicate repository migration name for {version}"
            )
        unresolved = [
            entry["path"]
            for entry in entries
            if entry not in exact_entries
            and entry["path"] not in exclusions
            and entry["path"] not in aliases
        ]
        if unresolved:
            raise SystemExit(
                f"FAIL migration auto-apply: ledger version/name collision {version}; "
                "every non-matching repository file must be explicitly accounted for: "
                + ", ".join(unresolved)
            )
        plan["ledgered"].append(
            {
                "version": version,
                "ledger_name": ledger_row.get("name"),
                "repository_files": [entry["path"] for entry in exact_entries],
            }
        )
        for entry in entries:
            if entry not in exact_entries:
                append_accounted_entry(entry)
        continue

    accounted_entries = [
        entry
        for entry in entries
        if entry["path"] in exclusions or entry["path"] in aliases
    ]
    if len(entries) > 1 and len(accounted_entries) != len(entries):
        unresolved = [
            entry["path"]
            for entry in entries
            if entry["path"] not in exclusions and entry["path"] not in aliases
        ]
        raise SystemExit(
            f"FAIL migration auto-apply: unledgered version collision {version}; "
            "every colliding file must be explicitly excluded before deploy: "
            + ", ".join(unresolved)
        )

    for entry in entries:
        if entry["path"] in exclusions or entry["path"] in aliases:
            append_accounted_entry(entry)
        else:
            plan["pending"].append(entry)

plan["pending"].sort(key=lambda entry: (entry["version"], entry["name"]))
transaction_control = re.compile(
    r"(?im)^\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;"
)
for entry in plan["pending"]:
    if transaction_control.search(Path(entry["absolute_path"]).read_text()):
        raise SystemExit(
            f"FAIL migration auto-apply: pending migration {entry['path']} "
            "contains explicit transaction control; review it before auto-apply"
        )
plan_path.write_text(json.dumps(plan, indent=2, sort_keys=True))
PY
}

print_plan() {
  python3 - "$1" "$MODE" <<'PY'
import json
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text())
mode = sys.argv[2]
print("migration_autoapply:")
print(f"  mode: {mode}")
print(f"  minimum_version: {plan['minimum_version']}")
print(f"  legacy_baseline_files: {len(plan['legacy_baseline'])}")
print(f"  ledgered_versions: {len(plan['ledgered'])}")
print(f"  ledger_aliases: {len(plan['ledger_aliases'])}")
for entry in plan["ledger_aliases"]:
    print(
        f"  LEDGER_ALIAS {entry['version']}_{entry['name']} "
        f"as={entry['ledger_version']}_{entry['ledger_name']}"
    )
print(f"  audited_exclusions: {len(plan['excluded'])}")
for entry in plan["excluded"]:
    print(
        f"  EXCLUDED {entry['version']}_{entry['name']} "
        f"audit={entry['audit_key']} sha256={entry['sha256']}"
    )
print(f"  pending_migrations: {len(plan['pending'])}")
for index, entry in enumerate(plan["pending"], 1):
    print(
        f"  PENDING {index} {entry['version']}_{entry['name']} "
        f"sha256={entry['sha256']}"
    )
PY
}

ledger_query="$TMP_DIR/ledger-query.sql"
ledger_response="$TMP_DIR/ledger-response.json"
plan_file="$TMP_DIR/plan.json"
write_ledger_query "$ledger_query"
run_sql_file "$ledger_query" "$ledger_response" "migration ledger read"
build_plan "$ledger_response" "$plan_file"
print_plan "$plan_file"

if [[ "$MODE" == "dry-run" ]]; then
  echo "PASS migration auto-apply dry-run: no production changes were made"
  exit 0
fi

python3 - "$plan_file" <<'PY' > "$TMP_DIR/pending.tsv"
import json
import sys
from pathlib import Path

for entry in json.loads(Path(sys.argv[1]).read_text())["pending"]:
    print(
        "\t".join(
            [
                entry["version"],
                entry["name"],
                entry["absolute_path"],
                entry["sha256"],
            ]
        )
    )
PY

applied_count=0
while IFS=$'\t' read -r version name migration_path expected_sha; do
  [[ -n "$version" ]] || continue

  python3 - "$version" > "$TMP_DIR/version-query.sql" <<'PY'
import sys
version = sys.argv[1]
print(
    "SELECT version, name FROM supabase_migrations.schema_migrations "
    f"WHERE version = '{version}';"
)
PY
  run_sql_file \
    "$TMP_DIR/version-query.sql" \
    "$TMP_DIR/version-response.json" \
    "ledger recheck for ${version}_${name}"

  concurrent_state="$(
    python3 - "$TMP_DIR/version-response.json" "$name" <<'PY'
import json
import sys
from pathlib import Path

rows = json.loads(Path(sys.argv[1]).read_text())
expected_name = sys.argv[2]
if not rows:
    print("absent")
elif len(rows) == 1 and rows[0].get("name") == expected_name:
    print("already-applied")
else:
    print("conflict")
PY
  )"
  case "$concurrent_state" in
    already-applied)
      echo "SKIP ${version}_${name}: ledger row appeared during this run"
      continue
      ;;
    conflict)
      fail "${version}: ledger slot changed to an unexpected migration"
      ;;
    absent) ;;
    *) fail "${version}: invalid concurrent ledger state" ;;
  esac

  echo "APPLY ${version}_${name}"
  run_sql_file \
    "$migration_path" \
    "$TMP_DIR/apply-response.json" \
    "migration transaction ${version}_${name}"
  echo "VERIFY ${version}_${name}: migration transaction committed successfully"

  MIGRATION_VERSION="$version" \
  MIGRATION_NAME="$name" \
  MIGRATION_PATH="$migration_path" \
  python3 - "$TMP_DIR/ledger-insert.sql" <<'PY'
import base64
import os
from pathlib import Path

version = os.environ["MIGRATION_VERSION"]
name = os.environ["MIGRATION_NAME"]
encoded = base64.b64encode(Path(os.environ["MIGRATION_PATH"]).read_bytes()).decode()
Path(os.sys.argv[1]).write_text(
    f"""
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES (
  '{version}',
  '{name}',
  ARRAY[convert_from(decode('{encoded}', 'base64'), 'UTF8')]
)
ON CONFLICT (version) DO NOTHING;

SELECT
  version,
  name,
  cardinality(statements) AS statement_count,
  CASE
    WHEN cardinality(statements) = 1 THEN
      encode(
        extensions.digest(convert_to(statements[1], 'UTF8'), 'sha256'),
        'hex'
      )
    ELSE NULL
  END AS raw_statement_sha256
FROM supabase_migrations.schema_migrations
WHERE version = '{version}';
"""
)
PY
  run_sql_file \
    "$TMP_DIR/ledger-insert.sql" \
    "$TMP_DIR/ledger-insert-response.json" \
    "ledger write ${version}_${name}"

  python3 - \
    "$TMP_DIR/ledger-insert-response.json" \
    "$version" \
    "$name" \
    "$expected_sha" <<'PY'
import json
import sys
from pathlib import Path

rows = json.loads(Path(sys.argv[1]).read_text())
version, name, expected_sha = sys.argv[2:]
if len(rows) != 1:
    raise SystemExit(
        f"FAIL migration auto-apply: ledger verification for {version}_{name} "
        f"returned {len(rows)} rows"
    )
row = rows[0]
if (
    str(row.get("version")) != version
    or row.get("name") != name
    or row.get("statement_count") != 1
    or row.get("raw_statement_sha256") != expected_sha
):
    raise SystemExit(
        f"FAIL migration auto-apply: ledger verification failed for "
        f"{version}_{name}"
    )
PY
  echo "LEDGER ${version}_${name}: exact raw migration bytes recorded"
  applied_count=$((applied_count + 1))
done < "$TMP_DIR/pending.tsv"

echo "PASS migration auto-apply: applied=${applied_count}; every migration is ledgered or explicitly excluded"

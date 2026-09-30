#!/usr/bin/env bash
# Refuse committed Supabase server keys.
#
# Fails when a tracked file contains a JWT whose payload claims
# "role": "service_role" (the legacy service-role key), or a new-style
# sb_secret_ key. The anon/publishable key is public by design and passes.
# Listed in pr-check.yml; run it before committing, or as a pre-commit hook
# with --cached, which checks the staged index instead of the working tree.
#
# It never prints a key: findings name the file, line and the first 6 hex
# characters of the key's sha256.
#
# Usage: scripts/check-no-committed-service-keys.sh [--cached]

set -euo pipefail

GREP_SCOPE=()
case "${1:-}" in
  "") ;;
  --cached) GREP_SCOPE=(--cached) ;;
  *)
    echo "Usage: $0 [--cached]" >&2
    exit 64
    ;;
esac

command -v python3 >/dev/null 2>&1 || {
  echo "FAIL service-key check: python3 is required" >&2
  exit 2
}

set +e
matches=$(git grep -I -n -o -E ${GREP_SCOPE[@]+"${GREP_SCOPE[@]}"} \
  -e 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*' \
  -e 'sb_secret_[A-Za-z0-9_-]{16,}')
status=$?
set -e
if [[ "$status" -eq 1 && -z "$matches" ]]; then
  echo "OK service-key check: no committed server keys"
  exit 0
fi
[[ "$status" -eq 0 && -n "$matches" ]] || {
  echo "FAIL service-key check: git grep exited $status" >&2
  exit 2
}

printf '%s\n' "$matches" | python3 -c '
import base64
import hashlib
import json
import sys

findings = []
for raw in sys.stdin:
    line = raw.rstrip("\n")
    if not line:
        continue
    location, _, key = line.rpartition(":")
    fingerprint = hashlib.sha256(key.encode()).hexdigest()[:6]
    if key.startswith("sb_secret_"):
        findings.append(f"{location}: sb_secret_ key (sha256 {fingerprint})")
        continue
    payload = key.split(".")[1]
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except Exception:
        continue
    if isinstance(claims, dict) and claims.get("role") == "service_role":
        findings.append(f"{location}: JWT with role service_role (sha256 {fingerprint})")

if findings:
    print("FAIL service-key check: committed server key(s) found:", file=sys.stderr)
    for finding in findings:
        print(f"  {finding}", file=sys.stderr)
    print(
        "Read the key at run time instead (Vault via public.sw_service_key(), or the "
        "function environment); a committed key must be rotated, not just deleted.",
        file=sys.stderr,
    )
    sys.exit(1)
print("OK service-key check: no committed server keys")
'

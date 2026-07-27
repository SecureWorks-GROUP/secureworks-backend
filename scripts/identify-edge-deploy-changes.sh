#!/usr/bin/env bash
# Classify a production edge workflow change without constructing an invalid
# git diff range. Writes step outputs when GITHUB_OUTPUT is set.

set -euo pipefail

BEFORE_SHA="${BEFORE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-HEAD}"
EVENT_NAME="${EVENT_NAME:-unknown}"

fail() {
  echo "FAIL $*" >&2
  exit 1
}

resolve_commit() {
  local candidate="$1"
  [[ -n "$candidate" && "$candidate" != "null" ]] || return 1
  git rev-parse --verify "${candidate}^{commit}" 2>/dev/null
}

emit_output() {
  local key="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  else
    printf '%s=%s\n' "$key" "$value"
  fi
}

is_verification_contract_path() {
  case "$1" in
    .github/workflows/deploy-edge-functions.yml | \
      scripts/identify-edge-deploy-changes.sh | \
      scripts/apply-pending-migrations.sh | \
      scripts/migration-autoapply-exclusions.txt | \
      scripts/migration-autoapply-ledger-aliases.txt | \
      scripts/check-edge-schema-preflight.sh | \
      scripts/edge-function-schema-requirements.txt | \
      scripts/check-ops-api-source-actions.sh | \
      scripts/stamp-ops-api-build-metadata.sh | \
      scripts/smoke-ops-api-action-surface.sh | \
      scripts/_ops-api-required-actions.txt)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

HEAD_COMMIT="$(resolve_commit "$HEAD_SHA")" ||
  fail "head is not a valid commit: ${HEAD_SHA}"

DIFF_MODE=
DIFF_BASE=
FULL_TREE=false

if [[ "$EVENT_NAME" == "push" && "$BEFORE_SHA" =~ ^0+$ ]]; then
  DIFF_MODE=initial-full-tree
  FULL_TREE=true
elif DIFF_BASE="$(resolve_commit "$BEFORE_SHA")"; then
  if [[ "$EVENT_NAME" == "push" ]]; then
    DIFF_MODE=push-range
  else
    DIFF_MODE=explicit-range
  fi
elif [[ "$EVENT_NAME" == "push" ]]; then
  # A push with an unavailable previous object must not feed an empty or
  # unresolvable value to git diff. Refuse before any deployment selection
  # rather than silently skipping changes or broadening to every function.
  fail "push base is not a valid commit: ${BEFORE_SHA:-<empty>}"
elif DIFF_BASE="$(resolve_commit "${HEAD_COMMIT}^1")"; then
  # Manual or future unusual events do not define github.event.before. Compare
  # the checked-out commit with its parent rather than constructing `git diff
  # '' HEAD`.
  DIFF_MODE=head-parent-fallback
else
  fail "event '${EVENT_NAME}' has no valid before SHA and head has no parent"
fi

if [[ "$FULL_TREE" == "true" ]]; then
  CHANGED_FUNCTIONS="$(
    find supabase/functions -mindepth 1 -maxdepth 1 -type d ! -name '_shared' \
      -exec basename {} \; 2>/dev/null |
      sort -u |
      tr '\n' ' '
  )"
  VERIFICATION_CONTRACT_CHANGED=true
  SHARED_CHANGED=false
else
  CHANGED_FILES="$(git diff --name-only "$DIFF_BASE" "$HEAD_COMMIT" --)"
  # Select on ANY file inside a function directory, not just index.ts. PR #164
  # changed ops-api/makesafe_compact_reads.ts, an index.ts-only match produced
  # an empty function set, and the deploy step was skipped so the fix silently
  # never reached production. NF>=4 drops top-level files such as
  # supabase/functions/README.md; _shared is excluded here and warned about
  # below rather than auto-deploying every function that imports it.
  CHANGED_FUNCTIONS="$(
    printf '%s\n' "$CHANGED_FILES" |
      awk -F/ '$1=="supabase" && $2=="functions" && NF>=4 && $3!="_shared" {print $3}' |
      sort -u |
      tr '\n' ' '
  )"

  VERIFICATION_CONTRACT_CHANGED=false
  while IFS= read -r changed_file; do
    [[ -n "$changed_file" ]] || continue
    if is_verification_contract_path "$changed_file"; then
      VERIFICATION_CONTRACT_CHANGED=true
      break
    fi
  done <<< "$CHANGED_FILES"

  SHARED_CHANGED=false
  if printf '%s\n' "$CHANGED_FILES" | grep -q '^supabase/functions/_shared/'; then
    SHARED_CHANGED=true
  fi
fi

FUNCTION_SOURCE_CHANGED=false
if [[ -n "$CHANGED_FUNCTIONS" ]]; then
  FUNCTION_SOURCE_CHANGED=true
fi

OPS_API_SOURCE_CHANGED=false
case " $CHANGED_FUNCTIONS " in
  *" ops-api "*) OPS_API_SOURCE_CHANGED=true ;;
esac

VERIFY_OPS_API=false
if [[ "$OPS_API_SOURCE_CHANGED" == "true" || "$VERIFICATION_CONTRACT_CHANGED" == "true" ]]; then
  VERIFY_OPS_API=true
fi

VERIFICATION_ONLY=false
if [[ "$VERIFICATION_CONTRACT_CHANGED" == "true" && "$FUNCTION_SOURCE_CHANGED" == "false" ]]; then
  VERIFICATION_ONLY=true
fi

emit_output functions "$CHANGED_FUNCTIONS"
emit_output function_source_changed "$FUNCTION_SOURCE_CHANGED"
emit_output ops_api_source_changed "$OPS_API_SOURCE_CHANGED"
emit_output verification_contract_changed "$VERIFICATION_CONTRACT_CHANGED"
emit_output verification_only "$VERIFICATION_ONLY"
emit_output verify_ops_api "$VERIFY_OPS_API"
emit_output diff_mode "$DIFF_MODE"

echo "Diff mode: $DIFF_MODE"
echo "Changed functions: ${CHANGED_FUNCTIONS:-<none>}"
echo "Function source changed: $FUNCTION_SOURCE_CHANGED"
echo "Ops-api verification contract changed: $VERIFICATION_CONTRACT_CHANGED"
echo "Verification-only: $VERIFICATION_ONLY"
echo "Verify ops-api: $VERIFY_OPS_API"

if [[ "$SHARED_CHANGED" == "true" ]]; then
  echo "::warning::_shared directory changed — functions that import from it may need manual redeployment"
fi

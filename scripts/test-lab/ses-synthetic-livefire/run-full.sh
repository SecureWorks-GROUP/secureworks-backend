#!/usr/bin/env bash
set -euo pipefail

project_ref="kevgrhcjxspbxgovpmfl"
supabase_url="https://${project_ref}.supabase.co"
runner_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi
deno_bin="${DENO_BIN:-$(command -v deno || true)}"
if [[ -z "${deno_bin}" && -x "${HOME}/.deno/bin/deno" ]]; then
  deno_bin="${HOME}/.deno/bin/deno"
fi
if [[ -z "${deno_bin}" ]]; then
  echo "deno is required" >&2
  exit 1
fi
if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "SUPABASE_ACCESS_TOKEN is required to retrieve the transient service-role key" >&2
  exit 1
fi
if [[ -z "${SW_API_KEY:-}" ]]; then
  echo "SW_API_KEY is required for authenticated ops-api verification" >&2
  exit 1
fi

service_role_key="$(
  supabase projects api-keys --project-ref "${project_ref}" -o json |
    jq -er '.[] | select(.name == "service_role") | .api_key'
)"
livefire_run_id="$(
  python3 -c 'import uuid; print(uuid.uuid4())'
)"

SUPABASE_URL="${supabase_url}" \
SUPABASE_SERVICE_ROLE_KEY="${service_role_key}" \
SW_API_KEY="${SW_API_KEY}" \
SYNTHETIC_LIVEFIRE_RUN_ID="${livefire_run_id}" \
SYNTHETIC_LIVEFIRE_CONFIRM="SEND_7_SELF_ADDRESSED_TEST_EMAILS" \
  "${deno_bin}" run \
    --allow-env \
    --allow-net \
    --allow-read \
    --allow-write \
    "${runner_dir}/run.ts" full

unset service_role_key

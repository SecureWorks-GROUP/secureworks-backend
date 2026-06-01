#!/usr/bin/env bash
# Pre-deploy source-side guard for production ops-api.
#
# Business purpose: before GitHub is allowed to deploy the backend switchboard,
# prove that the source file still contains every action name the company has
# declared as required in scripts/_ops-api-required-actions.txt. This catches a
# bad/stale source tree before it can overwrite the live Supabase function.

set -euo pipefail

REQUIRED_ACTIONS_FILE="${REQUIRED_ACTIONS_FILE:-scripts/_ops-api-required-actions.txt}"
OPS_API_SOURCE="${OPS_API_SOURCE:-supabase/functions/ops-api/index.ts}"

REQUIRED_ACTIONS_FILE="$REQUIRED_ACTIONS_FILE" OPS_API_SOURCE="$OPS_API_SOURCE" node <<'NODE'
const fs = require('fs');
const manifest = process.env.REQUIRED_ACTIONS_FILE;
const sourcePath = process.env.OPS_API_SOURCE;

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

if (!fs.existsSync(manifest)) fail(`required action manifest missing: ${manifest}`);
if (!fs.existsSync(sourcePath)) fail(`ops-api source missing: ${sourcePath}`);

const source = fs.readFileSync(sourcePath, 'utf8');
const actions = [...new Set([...source.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map(m => m[1]))].sort();
const required = fs.readFileSync(manifest, 'utf8')
  .split('\n')
  .map(line => line.replace(/#.*$/, '').trim())
  .filter(Boolean);

const missing = required.filter(action => !actions.includes(action));
console.log(`ops-api source actions found: ${actions.length}`);
console.log(`ops-api required actions checked: ${required.length}`);

for (const action of required) {
  if (actions.includes(action)) console.log(`PASS source recognises ${action}`);
}

if (missing.length) {
  console.error('Missing required actions:');
  for (const action of missing) console.error(`- ${action}`);
  process.exit(1);
}

console.log(`PASS ops-api source action-surface: all ${required.length} required actions present before deploy`);
NODE

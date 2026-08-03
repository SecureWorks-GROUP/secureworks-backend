// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("PO-57602 source-persistence recovery is API-key exact, bounded, and no-send", async () => {
  const routeStart = source.indexOf(
    "case 'makesafe_source_persist_recovery'",
  );
  const routeEnd = source.indexOf(
    "case 'makesafe_deterministic_intake_exact_rescan'",
    routeStart,
  );
  assert(routeStart > 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assertStringIncludes(route, "authMode !== 'api_key'");
  assertStringIncludes(route, "req.method !== 'POST'");
  assertStringIncludes(route, "sourcePersistRecoveryAction(client, body)");

  const actionStart = source.indexOf(
    "async function sourcePersistRecoveryAction",
  );
  const actionEnd = source.indexOf(
    "async function adjudicatedExactRescanAction",
    actionStart,
  );
  assert(actionStart > 0 && actionEnd > actionStart);
  const action = source.slice(actionStart, actionEnd);
  assertStringIncludes(action, "maxSources: 4");
  assertStringIncludes(action, "maxCases: 1");
  assertStringIncludes(action, "allowSourcePostIds: []");
  assertStringIncludes(action, "suppressPhysicalJobNotifications: true");
  assertStringIncludes(action, "SOURCE_PERSIST_NO_SEND_RECOVERY");
  assert(!action.includes("notifyMintedDeterministicPhysicalJob"));
  assert(!action.includes("notifyVerticalManagersSms"));
  assert(!action.includes("sendEmail"));
  assert(!action.includes("sendSms"));

  const createStart = source.indexOf("async function createMakesafeJob(");
  const createEnd = source.indexOf(
    "export const _createMakesafeJob",
    createStart,
  );
  const create = source.slice(createStart, createEnd);
  assertStringIncludes(create, "internalOptions.suppressGeocoding");

  const allowlistStart = source.indexOf(
    "const ROUTINE_ALLOWED_ACTIONS = new Set",
  );
  const allowlistEnd = source.indexOf("])\n", allowlistStart);
  const allowlist = source.slice(allowlistStart, allowlistEnd);
  assert(!allowlist.includes("makesafe_source_persist_recovery"));

  const requiredActions = await Deno.readTextFile(
    new URL("../../../scripts/_ops-api-required-actions.txt", import.meta.url),
  );
  assertStringIncludes(
    requiredActions,
    "makesafe_source_persist_recovery # probe=source-only",
  );
});

Deno.test("adjudicated exact rescan route is privileged POST-only and not routine-callable", () => {
  const routeStart = source.indexOf(
    "case 'makesafe_deterministic_intake_exact_rescan'",
  );
  const routeEnd = source.indexOf(
    "case 'makesafe_adjudicated_historical_backfill'",
    routeStart,
  );
  assert(routeStart > 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assertStringIncludes(route, "authMode === 'api_key'");
  assertStringIncludes(route, "authUser?.role === 'admin'");
  assertStringIncludes(route, "req.method !== 'POST'");
  assertStringIncludes(route, "adjudicatedExactRescanAction(client, body)");

  const allowlistStart = source.indexOf(
    "const ROUTINE_ALLOWED_ACTIONS = new Set",
  );
  const allowlistEnd = source.indexOf("])\n", allowlistStart);
  const allowlist = source.slice(allowlistStart, allowlistEnd);
  assert(!allowlist.includes("makesafe_deterministic_intake_exact_rescan"));
});

Deno.test("historical backfill route is privileged POST-only and has no communication callback", () => {
  const routeStart = source.indexOf(
    "case 'makesafe_adjudicated_historical_backfill'",
  );
  const routeEnd = source.indexOf(
    "case 'makesafe_gap_fill_queue'",
    routeStart,
  );
  assert(routeStart > 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assertStringIncludes(route, "authMode === 'api_key'");
  assertStringIncludes(route, "req.method !== 'POST'");
  assertStringIncludes(
    route,
    "adjudicatedHistoricalBackfillAction(client, body)",
  );
  assert(!route.includes("notifyMintedDeterministicPhysicalJob"));
  assert(!route.includes("notifyVerticalManagersSms"));
  assert(!route.includes("sendEmail"));
  assert(!route.includes("sendSms"));
});

Deno.test("five-card roof cycle recovery is API-key POST-only, source-gated, and cannot send or assign", async () => {
  const routeStart = source.indexOf(
    "case 'makesafe_roof_cycle_binding_recovery'",
  );
  const routeEnd = source.indexOf(
    "case 'makesafe_adjudicated_historical_backfill'",
    routeStart,
  );
  assert(routeStart > 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assertStringIncludes(route, "authMode !== 'api_key'");
  assertStringIncludes(route, "req.method !== 'POST'");
  assertStringIncludes(route, "roofCycleBindingRecoveryAction(client, body)");
  for (
    const forbidden of [
      "notifyVerticalManagersSms",
      "sendEmail",
      "sendSms",
      "job_assignments",
    ]
  ) {
    assert(!route.includes(forbidden));
  }

  const allowlistStart = source.indexOf(
    "const ROUTINE_ALLOWED_ACTIONS = new Set",
  );
  const allowlistEnd = source.indexOf("])\n", allowlistStart);
  const allowlist = source.slice(allowlistStart, allowlistEnd);
  assert(!allowlist.includes("makesafe_roof_cycle_binding_recovery"));

  const requiredActions = await Deno.readTextFile(
    new URL("../../../scripts/_ops-api-required-actions.txt", import.meta.url),
  );
  assertStringIncludes(
    requiredActions,
    "makesafe_roof_cycle_binding_recovery # probe=source-only",
  );
});

Deno.test("historical create metadata is internal-only and suppresses geocoding plus manager notification", () => {
  const createStart = source.indexOf("async function createMakesafeJob(");
  const createEnd = source.indexOf(
    "export const _createMakesafeJob",
    createStart,
  );
  const create = source.slice(createStart, createEnd);
  assertStringIncludes(create, "internalOptions.historicalBackfill");
  assertStringIncludes(create, "legacy_incomplete_evidence: true");
  assertStringIncludes(
    create,
    "!reviewedSyntheticLivefireMarker && !internalOptions.historicalBackfill",
  );
  assertStringIncludes(create, "suppress_manager_notification !== true");
  assert(!create.includes("body.historical_backfill"));
});

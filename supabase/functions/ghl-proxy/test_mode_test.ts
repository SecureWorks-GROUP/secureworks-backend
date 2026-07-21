import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isOutboundCommsAction,
  resolveGhlProxyRoute,
  testModeCommsBlock,
} from "./test_mode.ts";

const PRODUCTION_PIPELINE = "prod-pipeline";
const PRODUCTION_LOCATION = "prod-location";
const PRODUCTION_ORG = "00000000-0000-0000-0000-000000000001";
const TEST_PIPELINE = "kMSiJnd4KyPyIUletHbH";
const TEST_LOCATION = "13yKADzN94BRxX4hByYX";
const TEST_ORG = "00000000-0000-0000-0000-00000000f001";

function route(rawTestMode: string | null, overrides: Record<string, unknown> = {}) {
  return resolveGhlProxyRoute(rawTestMode, {
    productionPipelineId: PRODUCTION_PIPELINE,
    productionLocationId: PRODUCTION_LOCATION,
    productionOrganisationId: PRODUCTION_ORG,
    testPipelineId: TEST_PIPELINE,
    testLocationId: TEST_LOCATION,
    testOrganisationId: TEST_ORG,
    ...overrides,
  });
}

Deno.test("default and malformed testMode values retain the production route unchanged", () => {
  for (const flag of [null, "", "false", "1", "TRUE", " true "]) {
    const result = route(flag);
    assertStrictEquals(result.ok, true);
    if (!result.ok) continue;
    assertEquals(result.route, {
      testMode: false,
      pipelineId: PRODUCTION_PIPELINE,
      locationId: PRODUCTION_LOCATION,
      organisationId: PRODUCTION_ORG,
    });
  }
});

Deno.test("exact testMode=true routes pipeline, location and organisation to configured test IDs", () => {
  const result = route("true");
  assertStrictEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.route, {
    testMode: true,
    pipelineId: TEST_PIPELINE,
    locationId: TEST_LOCATION,
    organisationId: TEST_ORG,
  });
});

Deno.test("test mode refuses when any test route ID is unconfigured and never returns production IDs", () => {
  const noPipeline = route("true", { testPipelineId: "" });
  assertEquals(noPipeline, {
    ok: false,
    status: 503,
    code: "test_mode_not_configured",
    error: "Test mode is unavailable until all test route IDs are configured",
    missing: ["GHL_TEST_PIPELINE_ID"],
  });

  const noIds = route("true", {
    testPipelineId: " ",
    testLocationId: null,
    testOrganisationId: null,
  });
  assertStrictEquals(noIds.ok, false);
  if (noIds.ok) return;
  assertEquals(noIds.missing, [
    "GHL_TEST_PIPELINE_ID",
    "GHL_TEST_LOCATION_ID",
    "SUPABASE_TEST_ORG_ID",
  ]);
  assertStrictEquals(JSON.stringify(noIds).includes(PRODUCTION_PIPELINE), false);
  assertStrictEquals(JSON.stringify(noIds).includes(PRODUCTION_LOCATION), false);
  assertStrictEquals(JSON.stringify(noIds).includes(PRODUCTION_ORG), false);
});

Deno.test("test-mode proxy guard blocks outbound communications and leaves production untouched", () => {
  assertStrictEquals(isOutboundCommsAction("send_sms"), true);
  assertStrictEquals(isOutboundCommsAction("send_email"), true);
  assertStrictEquals(isOutboundCommsAction("initiate_call"), true);
  assertStrictEquals(isOutboundCommsAction("save_scope"), false);
  assertStrictEquals(isOutboundCommsAction(null), false);
  const blocked = {
    status: 403,
    body: {
      success: false,
      error: "Outbound communications are disabled in test mode",
      code: "test_mode_comms_blocked",
    },
  };
  assertEquals(testModeCommsBlock(true, "send_sms"), blocked);
  assertEquals(testModeCommsBlock(true, "send_email"), blocked);
  assertStrictEquals(testModeCommsBlock(false, "send_sms"), null);
  assertStrictEquals(testModeCommsBlock(true, "save_scope"), null);
});

Deno.test("deployed handler applies general test routing before action handlers", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const routeGuard = source.indexOf("resolveGhlProxyRoute(");
  const smsHandler = source.indexOf("action === 'send_sms'");
  const emailHandler = source.indexOf("action === 'send_email'");
  assertStrictEquals(routeGuard >= 0, true);
  assertStrictEquals(source.indexOf("testModeCommsBlock(route.testMode, action)", routeGuard) > routeGuard, true);
  assertStrictEquals(source.includes("fencing: route.pipelineId"), true);
  assertStrictEquals(source.includes("patio: route.pipelineId"), true);
  assertStrictEquals(source.includes("decking: route.pipelineId"), true);
  assertStrictEquals(source.includes("combo: route.pipelineId"), true);
  assertStrictEquals(source.includes("const GHL_LOCATION_ID = route.locationId"), true);
  assertStrictEquals(routeGuard < smsHandler, true);
  assertStrictEquals(routeGuard < emailHandler, true);
});

Deno.test("TEST-ZZZ general scope seed is idempotent and contains no real contact data", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260722000001_scope_test_lab_seed.sql", import.meta.url),
  );
  assertStrictEquals(sql.includes("TEST-ZZZ Scope Save Lab"), true);
  assertStrictEquals(sql.includes("test-zzz-scope-lab@example.invalid"), true);
  assertStrictEquals(sql.includes("ON CONFLICT DO NOTHING"), true);
  assertStrictEquals(sql.includes("00000000-0000-0000-0000-00000000f001"), true);
  assertStrictEquals(sql.includes("00000000-0000-0000-0000-00000000f002"), true);
});

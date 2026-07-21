import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isOutboundCommsAction,
  resolveGhlProxyRoute,
  testModeCommsBlock,
} from "./test_mode.ts";

const PRODUCTION_PIPELINE = "prod-fence-pipeline";
const PRODUCTION_ORG = "00000000-0000-0000-0000-000000000001";
const TEST_PIPELINE = "TEST-ZZZ-fence-pipeline";
const TEST_ORG = "00000000-0000-0000-0000-00000000f001";

function route(rawTestMode: string | null, overrides: Record<string, unknown> = {}) {
  return resolveGhlProxyRoute(rawTestMode, {
    productionFencingPipelineId: PRODUCTION_PIPELINE,
    productionOrganisationId: PRODUCTION_ORG,
    testFencingPipelineId: TEST_PIPELINE,
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
      fencingPipelineId: PRODUCTION_PIPELINE,
      organisationId: PRODUCTION_ORG,
    });
  }
});

Deno.test("exact testMode=true routes fencing pipeline and organisation to configured test IDs", () => {
  const result = route("true");
  assertStrictEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.route, {
    testMode: true,
    fencingPipelineId: TEST_PIPELINE,
    organisationId: TEST_ORG,
  });
});

Deno.test("test mode refuses when either test route ID is unconfigured and never returns production IDs", () => {
  const noPipeline = route("true", { testFencingPipelineId: "" });
  assertEquals(noPipeline, {
    ok: false,
    status: 503,
    code: "test_mode_not_configured",
    error: "Fence test mode is unavailable until all test route IDs are configured",
    missing: ["GHL_TEST_FENCING_PIPELINE_ID"],
  });

  const noIds = route("true", {
    testFencingPipelineId: " ",
    testOrganisationId: null,
  });
  assertStrictEquals(noIds.ok, false);
  if (noIds.ok) return;
  assertEquals(noIds.missing, [
    "GHL_TEST_FENCING_PIPELINE_ID",
    "SUPABASE_TEST_ORG_ID",
  ]);
  assertStrictEquals(JSON.stringify(noIds).includes(PRODUCTION_PIPELINE), false);
  assertStrictEquals(JSON.stringify(noIds).includes(PRODUCTION_ORG), false);
});

Deno.test("test-mode proxy guard blocks outbound communications and leaves production untouched", () => {
  assertStrictEquals(isOutboundCommsAction("send_sms"), true);
  assertStrictEquals(isOutboundCommsAction("send_email"), true);
  assertStrictEquals(isOutboundCommsAction("initiate_call"), true);
  assertStrictEquals(isOutboundCommsAction("save_scope"), false);
  assertStrictEquals(isOutboundCommsAction(null), false);
  assertEquals(testModeCommsBlock(true, "send_sms"), {
    status: 403,
    body: {
      success: false,
      error: "Outbound communications are disabled in fence test mode",
      code: "test_mode_comms_blocked",
    },
  });
  assertEquals(testModeCommsBlock(true, "send_email"), {
    status: 403,
    body: {
      success: false,
      error: "Outbound communications are disabled in fence test mode",
      code: "test_mode_comms_blocked",
    },
  });
  assertStrictEquals(testModeCommsBlock(false, "send_sms"), null);
  assertStrictEquals(testModeCommsBlock(true, "save_scope"), null);
});

Deno.test("deployed handler applies route before handlers and blocks test communications", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const routeGuard = source.indexOf("resolveGhlProxyRoute(");
  const smsHandler = source.indexOf("action === 'send_sms'");
  const emailHandler = source.indexOf("action === 'send_email'");
  assertStrictEquals(routeGuard >= 0, true);
  assertStrictEquals(source.indexOf("testModeCommsBlock(route.testMode, action)", routeGuard) > routeGuard, true);
  assertStrictEquals(routeGuard < smsHandler, true);
  assertStrictEquals(routeGuard < emailHandler, true);
});

Deno.test("TEST-ZZZ seed is idempotent and contains no real contact data", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260722000001_fence_test_lab_seed.sql", import.meta.url),
  );
  assertStrictEquals(sql.includes("TEST-ZZZ Fence Save Lab"), true);
  assertStrictEquals(sql.includes("test-zzz-fence-lab@example.invalid"), true);
  assertStrictEquals(sql.includes("ON CONFLICT DO NOTHING"), true);
  assertStrictEquals(sql.includes("00000000-0000-0000-0000-00000000f001"), true);
  assertStrictEquals(sql.includes("00000000-0000-0000-0000-00000000f002"), true);
});

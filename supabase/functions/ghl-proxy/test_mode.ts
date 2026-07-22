export const TEST_MODE_QUERY_VALUE = "true";

const OUTBOUND_COMMS_ACTIONS = new Set([
  "send_sms",
  "send_email",
  "initiate_call",
]);

export type GhlProxyRoute = {
  testMode: boolean;
  pipelineId: string;
  locationId: string;
  organisationId: string;
};

type RouteConfig = {
  productionPipelineId: string;
  productionLocationId: string;
  productionOrganisationId: string;
  testPipelineId?: string | null;
  testLocationId?: string | null;
  testOrganisationId?: string | null;
};

export type GhlProxyRouteResult =
  | { ok: true; route: GhlProxyRoute }
  | {
    ok: false;
    status: 503;
    code: "test_mode_not_configured";
    error: string;
    missing: string[];
  };

/**
 * Test mode is deliberately exact. Missing values and malformed variants such
 * as `1`, `TRUE`, or a body-only flag retain the existing production route.
 */
export function resolveGhlProxyRoute(
  rawTestMode: string | null,
  config: RouteConfig,
): GhlProxyRouteResult {
  if (rawTestMode !== TEST_MODE_QUERY_VALUE) {
    return {
      ok: true,
      route: {
        testMode: false,
        pipelineId: config.productionPipelineId,
        locationId: config.productionLocationId,
        organisationId: config.productionOrganisationId,
      },
    };
  }

  const testPipelineId = String(config.testPipelineId || "").trim();
  const testLocationId = String(config.testLocationId || "").trim();
  const testOrganisationId = String(config.testOrganisationId || "").trim();
  const missing: string[] = [];
  if (!testPipelineId) missing.push("GHL_TEST_PIPELINE_ID");
  if (!testLocationId) missing.push("GHL_TEST_LOCATION_ID");
  if (!testOrganisationId) missing.push("SUPABASE_TEST_ORG_ID");

  if (missing.length) {
    return {
      ok: false,
      status: 503,
      code: "test_mode_not_configured",
      error: "Test mode is unavailable until all test route IDs are configured",
      missing,
    };
  }

  return {
    ok: true,
    route: {
      testMode: true,
      pipelineId: testPipelineId,
      locationId: testLocationId,
      organisationId: testOrganisationId,
    },
  };
}

export function isOutboundCommsAction(action: string | null): boolean {
  return !!action && OUTBOUND_COMMS_ACTIONS.has(action);
}

export function testModeCommsBlock(testMode: boolean, action: string | null) {
  if (!testMode || !isOutboundCommsAction(action)) return null;
  return {
    status: 403,
    body: {
      success: false,
      error: "Outbound communications are disabled in test mode",
      code: "test_mode_comms_blocked",
    },
  } as const;
}

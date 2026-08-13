// deno-lint-ignore-file no-import-prefix

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsSignedCaller,
  _opsApiActionNeedsStaffRole,
  _opsApiServerSecretPresented,
  _preferBearerForOpsApiAction,
  _resolveOpsApiAuthIntent,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

function actionUrl(action: string, query = ""): URL {
  return new URL(`https://example.invalid/ops-api?action=${action}${query}`);
}

function authorizationStatus(input: {
  action: string;
  query?: string;
  authMode: "api_key" | "jwt" | "routine" | "agent_read" | "none";
  role?: string;
  serverSecretPresented?: boolean;
}): number {
  const decision = _authorizeOpsApiAction({
    url: actionUrl(input.action, input.query),
    authMode: input.authMode,
    authUser: input.role ? { role: input.role } : null,
    serverSecretPresented: input.serverSecretPresented,
  });
  return decision.ok ? 200 : decision.status;
}

function scopedDispatchStatus(
  action: string,
  authMode: "api_key" | "jwt" | "routine" | "agent_read" | "none",
  role?: string,
): number {
  const outerStatus = authorizationStatus({ action, authMode, role });
  if (outerStatus !== 200) return outerStatus;
  if (authMode === "agent_read" && !AGENT_READ_ALLOWED_ACTIONS.has(action)) {
    return 403;
  }
  return 200;
}

Deno.test("operator board and money data reject missing, anon-only, and shared-key-only auth with 401", () => {
  for (const action of ["makesafe_board", "job_financials"]) {
    for (const authMode of ["none", "jwt", "api_key"] as const) {
      const decision = _authorizeOpsApiAction({
        url: actionUrl(action),
        authMode,
      });
      assertEquals(decision.ok, false);
      if (!decision.ok) {
        assertEquals(decision.status, 401);
        assertEquals(decision.code, "user_jwt_required");
      }
    }
  }
});

Deno.test("authenticated operator JWT roles pass the existing users.role predicate", () => {
  for (const role of ["admin", "owner", "ops_manager"]) {
    assertEquals(
      authorizationStatus({ action: "makesafe_board", authMode: "jwt", role }),
      200,
      role,
    );
    assertEquals(
      authorizationStatus({ action: "job_financials", authMode: "jwt", role }),
      200,
      role,
    );
  }
  assertEquals(
    authorizationStatus({
      action: "pipeline",
      authMode: "jwt",
      role: "crew",
    }),
    401,
  );
});

Deno.test("the distinct existing service-role secret still authorizes protected actions", () => {
  const serverSecretPresented = _opsApiServerSecretPresented({
    xApiKey: "service-role-secret",
    bearerToken: null,
    sharedKey: "browser-shared-key",
    serviceKey: "service-role-secret",
  });
  assertEquals(serverSecretPresented, true);
  assertEquals(
    authorizationStatus({
      action: "makesafe_board",
      authMode: "api_key",
      serverSecretPresented,
    }),
    200,
  );

  assertEquals(
    _opsApiServerSecretPresented({
      xApiKey: "same-key",
      bearerToken: null,
      sharedKey: "same-key",
      serviceKey: "same-key",
    }),
    false,
  );
});

Deno.test("OPS_AGENT_SERVER_KEY resolves from x-api-key or Bearer and reads makesafe_board", () => {
  for (
    const headers of [
      { xApiKey: "agent-server-secret", bearerToken: null },
      { xApiKey: null, bearerToken: "agent-server-secret" },
    ]
  ) {
    const authMode = _resolveOpsApiAuthIntent({
      ...headers,
      validKey: "browser-shared-key",
      serviceKey: "service-role-secret",
      routineKey: "routine-secret",
      agentServerKey: "agent-server-secret",
      preferBearerOverApiKey: true,
    });
    assertEquals(authMode, "agent_read");
    assertEquals(scopedDispatchStatus("makesafe_board", authMode), 200);
  }
});

Deno.test("agent_read is default-denied from write and money actions", () => {
  for (
    const action of [
      "create_ses_invoice_draft",
      "allocate_job",
      "send_invoice_email",
      "approve_invoice",
    ]
  ) {
    assertEquals(AGENT_READ_ALLOWED_ACTIONS.has(action), false, action);
    assertEquals(scopedDispatchStatus(action, "agent_read"), 403, action);
  }
});

Deno.test("unset or colliding OPS_AGENT_SERVER_KEY never grants agent_read", () => {
  for (const agentServerKey of [undefined, null, ""]) {
    assertEquals(
      _resolveOpsApiAuthIntent({
        xApiKey: "agent-server-secret",
        bearerToken: null,
        validKey: "browser-shared-key",
        serviceKey: "service-role-secret",
        routineKey: "routine-secret",
        agentServerKey,
      }),
      "none",
    );
  }

  for (
    const collision of [
      { key: "browser-shared-key", expectedMode: "api_key" },
      { key: "routine-secret", expectedMode: "routine" },
      { key: "service-role-secret", expectedMode: "api_key" },
    ] as const
  ) {
    assertEquals(
      _resolveOpsApiAuthIntent({
        xApiKey: collision.key,
        bearerToken: null,
        validKey: "browser-shared-key",
        serviceKey: "service-role-secret",
        routineKey: "routine-secret",
        agentServerKey: collision.key,
      }),
      collision.expectedMode,
    );
  }
});

Deno.test("agent read allow-list contains only the five reviewed read actions", () => {
  assertEquals([...AGENT_READ_ALLOWED_ACTIONS], [
    "makesafe_board",
    "makesafe_pipeline",
    "makesafe_pipeline_items",
    "makesafe_audit",
    "intake_health",
  ]);
});

Deno.test("W5 browser-key 401, staff board 200, and routine board refusal remain unchanged", async () => {
  const browserDecision = _authorizeOpsApiAction({
    url: actionUrl("makesafe_board"),
    authMode: "api_key",
  });
  assertEquals(browserDecision, {
    ok: false,
    status: 401,
    code: "user_jwt_required",
    error: "A signed-in Supabase user session is required.",
  });
  assertEquals(
    scopedDispatchStatus("makesafe_board", "jwt", "ops_manager"),
    200,
  );

  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const allowStart = index.indexOf("const ROUTINE_ALLOWED_ACTIONS = new Set([");
  const agentDispatchStart = index.indexOf(
    "    if (authMode === 'agent_read') {",
    index.indexOf("console.log(`[ops-api] action=${action}"),
  );
  const agentDispatch = index.slice(agentDispatchStart, allowStart);
  assertEquals(
    agentDispatchStart >= 0 && allowStart > agentDispatchStart,
    true,
  );
  assertEquals(
    agentDispatch.includes("!AGENT_READ_ALLOWED_ACTIONS.has(action)"),
    true,
  );
  for (const action of AGENT_READ_ALLOWED_ACTIONS) {
    assertEquals(agentDispatch.includes(`case '${action}'`), true, action);
  }
  for (
    const action of [
      "create_ses_invoice_draft",
      "allocate_job",
      "send_invoice_email",
      "approve_invoice",
    ]
  ) {
    assertEquals(agentDispatch.includes(`case '${action}'`), false, action);
  }

  const allowEnd = index.indexOf(
    "])\n    if (authMode === 'routine'",
    allowStart,
  );
  assertEquals(allowStart >= 0 && allowEnd > allowStart, true);
  const routineBoardStatus = index
      .slice(allowStart, allowEnd)
      .includes("'makesafe_board'")
    ? 200
    : 403;
  assertEquals(routineBoardStatus, 403);
  assertEquals(scopedDispatchStatus("makesafe_pipeline", "routine"), 200);
});

Deno.test("mixed browser credentials prefer the user JWT while service-role remains server auth", () => {
  const operatorUrl = actionUrl("pipeline");
  assertEquals(_preferBearerForOpsApiAction(operatorUrl), true);
  assertEquals(
    _resolveOpsApiAuthIntent({
      xApiKey: "browser-shared-key",
      bearerToken: "signed-user-jwt",
      validKey: "browser-shared-key",
      serviceKey: "service-role-secret",
      preferBearerOverApiKey: _preferBearerForOpsApiAction(operatorUrl),
    }),
    "jwt",
  );
  assertEquals(
    _resolveOpsApiAuthIntent({
      xApiKey: "service-role-secret",
      bearerToken: "signed-user-jwt",
      validKey: "browser-shared-key",
      serviceKey: "service-role-secret",
      preferBearerOverApiKey: true,
    }),
    "api_key",
  );
});

Deno.test("operator action families are protected and role-scoped Trade allocation keeps its existing predicate", () => {
  for (
    const action of [
      "makesafe_board",
      "pipeline",
      "job_financials",
      "get_inbox",
      "approve_invoice",
      "allocate_job",
      "create_invoice",
      "send_invoice_email",
      "update_job_status",
    ]
  ) {
    assertEquals(
      _opsApiActionNeedsSignedCaller(actionUrl(action)),
      true,
      action,
    );
  }
  assertEquals(_opsApiActionNeedsStaffRole(actionUrl("allocate_job")), false);
  assertEquals(
    authorizationStatus({
      action: "allocate_job",
      authMode: "jwt",
      role: "lead_installer",
    }),
    200,
  );
  assertEquals(
    authorizationStatus({ action: "allocate_job", authMode: "api_key" }),
    401,
  );
});

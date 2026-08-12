// deno-lint-ignore-file no-import-prefix

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsSignedCaller,
  _opsApiActionNeedsStaffRole,
  _opsApiServerSecretPresented,
  _preferBearerForOpsApiAction,
  _resolveOpsApiAuthIntent,
} from "./index.ts";

function actionUrl(action: string, query = ""): URL {
  return new URL(`https://example.invalid/ops-api?action=${action}${query}`);
}

function authorizationStatus(input: {
  action: string;
  query?: string;
  authMode: "api_key" | "jwt" | "routine" | "none";
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

Deno.test("operator board and money data reject missing, anon-only, and shared-key-only auth with 401", () => {
  for (const action of ["makesafe_board", "job_financials"]) {
    assertEquals(authorizationStatus({ action, authMode: "none" }), 401);
    assertEquals(authorizationStatus({ action, authMode: "jwt" }), 401);
    assertEquals(authorizationStatus({ action, authMode: "api_key" }), 401);
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

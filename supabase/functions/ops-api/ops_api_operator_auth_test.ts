// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assertAssignedOrMakesafeAccessForTest,
  _authorizeOpsApiAction,
  _opsApiActionNeedsSignedCaller,
  _opsApiActionNeedsStaffRole,
  _opsApiCallerIsStaffOperator,
  _opsApiServerSecretPresented,
  _opsApiStaffOperatorRole,
  _preferBearerForOpsApiAction,
  _resolveOpsApiAuthIntent,
  AGENT_READ_ALLOWED_ACTIONS,
  assertAssignmentMutationAuthz,
  LEAD_INSTALLER_READ_ACTIONS,
  OPS_API_STAFF_OPERATOR_ROLES,
} from "./index.ts";

function actionUrl(action: string, query = ""): URL {
  return new URL(`https://example.invalid/ops-api?action=${action}${query}`);
}

function authorizationStatus(input: {
  action: string;
  query?: string;
  authMode: "api_key" | "jwt" | "routine" | "agent_read" | "none";
  role?: string;
  managedVerticals?: string[];
  serverSecretPresented?: boolean;
}): number {
  const decision = _authorizeOpsApiAction({
    url: actionUrl(input.action, input.query),
    authMode: input.authMode,
    authUser: input.role
      ? { role: input.role, managedVerticals: input.managedVerticals }
      : null,
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
    403,
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

Deno.test("OPS_AGENT_SERVER_KEY is a full inside pass from x-api-key or Bearer", () => {
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
    assertEquals(authMode, "api_key");
    const serverSecretPresented = _opsApiServerSecretPresented({
      ...headers,
      sharedKey: "browser-shared-key",
      serviceKey: "service-role-secret",
      agentServerKey: "agent-server-secret",
      routineKey: "routine-secret",
    });
    assertEquals(serverSecretPresented, true);
    for (
      const action of [
        "makesafe_board",
        "job_detail",
        "bind_existing_makesafe_invoice_pack",
        "create_ses_invoice_draft",
        "allocate_job",
      ]
    ) {
      assertEquals(
        authorizationStatus({ action, authMode, serverSecretPresented }),
        200,
        action,
      );
    }
  }
});

Deno.test("leftover agent_read dispatch still cannot reach write and money actions", () => {
  for (
    const action of [
      "create_ses_invoice_draft",
      "bind_existing_makesafe_invoice_pack",
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

Deno.test("agent read allow-list contains only the six reviewed read actions", () => {
  assertEquals([...AGENT_READ_ALLOWED_ACTIONS], [
    "makesafe_board",
    "makesafe_pipeline",
    "makesafe_pipeline_items",
    "makesafe_audit",
    "intake_health",
    "makesafe_prime_capture_sweep",
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

// ── #680 SWF-261098 + #681 regression coverage ──────────────────────────────

// Minimal query-builder mock in the makesafe_access_shape_test pattern: an
// ordinary unassigned job with no makesafe detail, so the only way through
// assertAssignedOrMakesafeAccess is the operator (isAdmin) bypass.
function makeAccessClient(job: {
  id: string;
  type: string;
  job_number: string;
}) {
  return {
    from(table: string) {
      const builder: {
        select: () => typeof builder;
        eq: () => typeof builder;
        neq: () => typeof builder;
        limit: () => typeof builder;
        maybeSingle: () => Promise<{ data: unknown; error: null }>;
      } = {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        limit: () => builder,
        maybeSingle: () => {
          if (table === "jobs") {
            return Promise.resolve({ data: job, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

Deno.test("the staff-operator predicate is the exact front-door role set", () => {
  assertEquals(
    [...OPS_API_STAFF_OPERATOR_ROLES].sort(),
    ["admin", "owner", "ops_manager"].sort(),
  );
  for (const role of OPS_API_STAFF_OPERATOR_ROLES) {
    assertEquals(_opsApiStaffOperatorRole(role), true, role);
    assertEquals(_opsApiCallerIsStaffOperator("jwt", { role }), true, role);
  }
  for (const role of ["crew", "lead_installer", "estimator", "sales", ""]) {
    assertEquals(_opsApiStaffOperatorRole(role), false, role);
    assertEquals(_opsApiCallerIsStaffOperator("jwt", { role }), false, role);
  }
});

Deno.test("SWF-261098: an ops_manager JWT is an add_note operator and bypasses the assignment check on a job they are not assigned to", async () => {
  // add_note is profile-scoped (trades reach the handler), so the operator/
  // trade split happens INSIDE the case via the shared staff predicate.
  assertEquals(_opsApiActionNeedsStaffRole(actionUrl("add_note")), false);
  for (const role of ["ops_manager", "owner", "admin"]) {
    assertEquals(
      authorizationStatus({ action: "add_note", authMode: "jwt", role }),
      200,
      role,
    );
    const noteIsAdmin = _opsApiCallerIsStaffOperator("jwt", { role });
    assertEquals(noteIsAdmin, true, role);
    // With the operator flag set, addNote's per-user assignment check is
    // bypassed exactly as it always was for api_key dashboard callers.
    await _assertAssignedOrMakesafeAccessForTest(
      makeAccessClient({
        id: "job-patio",
        type: "patio",
        job_number: "SWP-261098",
      }),
      "job-patio",
      `${role}-user`,
      noteIsAdmin,
    );
  }
});

Deno.test("a trade JWT still cannot note a job they are not assigned to", async () => {
  const noteIsAdmin = _opsApiCallerIsStaffOperator("jwt", {
    role: "lead_installer",
  });
  assertEquals(noteIsAdmin, false);
  await assertRejects(
    () =>
      _assertAssignedOrMakesafeAccessForTest(
        makeAccessClient({
          id: "job-patio",
          type: "patio",
          job_number: "SWP-261098",
        }),
        "job-patio",
        "trade-user",
        noteIsAdmin,
      ),
    Error,
    "You are not assigned to this job",
  );
});

Deno.test("the api_key and service-role branches are unchanged by the operator predicate", () => {
  assertEquals(_opsApiCallerIsStaffOperator("api_key", null), true);
  for (const authMode of ["routine", "agent_read", "none"] as const) {
    assertEquals(_opsApiCallerIsStaffOperator(authMode, null), false, authMode);
    assertEquals(
      _opsApiCallerIsStaffOperator(authMode, { role: "admin" }),
      false,
      authMode,
    );
  }
  // Shared-key-only browser callers still get 401 at the front door; the
  // distinct service-role secret still passes.
  assertEquals(
    authorizationStatus({ action: "add_note", authMode: "api_key" }),
    401,
  );
  assertEquals(
    authorizationStatus({
      action: "add_note",
      authMode: "api_key",
      serverSecretPresented: true,
    }),
    200,
  );
});

Deno.test("#681: trade login-path actions pass the front-door gate for a trade JWT", () => {
  for (
    const action of [
      "get_crew_availability",
      "add_note",
      "trade_calendar",
      "my_jobs",
      "clock_event",
    ]
  ) {
    assertEquals(_opsApiActionNeedsStaffRole(actionUrl(action)), false, action);
    assertEquals(
      authorizationStatus({ action, authMode: "jwt", role: "lead_installer" }),
      200,
      action,
    );
  }
});

Deno.test("#681: a signed-in trade on a staff-only action gets 403 operator_access_required, never a logout-inducing 401", () => {
  // `pipeline` moved out of this list on 2026-08-13: it is now a
  // LEAD_INSTALLER_READ_ACTIONS entitlement (see the lockout tests below).
  // A crew JWT still 403s on it, covered there too.
  for (
    const action of ["makesafe_board", "job_financials", "list_work_orders"]
  ) {
    const decision = _authorizeOpsApiAction({
      url: actionUrl(action),
      authMode: "jwt",
      authUser: { role: "lead_installer" },
    });
    assertEquals(decision.ok, false, action);
    if (!decision.ok) {
      assertEquals(decision.status, 403, action);
      assertEquals(decision.code, "operator_access_required", action);
    }
  }
});

// ── 2026-08-13 trade-app outage: lead_installer dispatcher-view reads ──

Deno.test("lead installer read entitlement is exactly the two division-manager boot reads", () => {
  // Captain 2026-08-17 three-tier model: `pipeline` (every job's quoted value,
  // every vertical) and `ops_summary` (cross-vertical money aggregate) are gone;
  // the served trade.html manager boot path calls only calendar + list_users.
  assertEquals(
    [...LEAD_INSTALLER_READ_ACTIONS].sort(),
    ["calendar", "list_users"].sort(),
  );
  // The entitlement must never grow into staff-role membership.
  assertEquals(_opsApiStaffOperatorRole("lead_installer"), false);
  assertEquals(
    _opsApiCallerIsStaffOperator("jwt", { role: "lead_installer" }),
    false,
  );
});

Deno.test("outage fix: a lead_installer JWT WITH a managed vertical passes the front door on the manager boot reads", () => {
  for (const action of LEAD_INSTALLER_READ_ACTIONS) {
    assertEquals(
      authorizationStatus({
        action,
        authMode: "jwt",
        role: "lead_installer",
        managedVerticals: ["fencing"],
      }),
      200,
      action,
    );
  }
});

Deno.test("three-tier: a lead_installer with NO managed vertical is an allocated trade and gets none of the office reads (403, not 401)", () => {
  for (const action of [...LEAD_INSTALLER_READ_ACTIONS, "pipeline", "ops_summary"]) {
    const decision = _authorizeOpsApiAction({
      url: actionUrl(action),
      authMode: "jwt",
      authUser: { role: "lead_installer", managedVerticals: [] },
    });
    assertEquals(decision.ok, false, action);
    if (!decision.ok) {
      assertEquals(decision.status, 403, action);
      assertEquals(decision.code, "operator_access_required", action);
    }
  }
});

Deno.test("three-tier: pipeline / ops_summary are refused even for a division manager (quoted value + cross-vertical aggregate)", () => {
  for (const action of ["pipeline", "ops_summary"]) {
    const decision = _authorizeOpsApiAction({
      url: actionUrl(action),
      authMode: "jwt",
      authUser: { role: "lead_installer", managedVerticals: ["fencing"] },
    });
    assertEquals(decision.ok, false, action);
    if (!decision.ok) assertEquals(decision.status, 403, action);
  }
});

Deno.test("outage fix: the entitlement is role-scoped — crew and other non-staff JWTs still 403 on those reads", () => {
  for (const role of ["crew", "estimator", "sales", ""]) {
    for (const action of LEAD_INSTALLER_READ_ACTIONS) {
      const decision = _authorizeOpsApiAction({
        url: actionUrl(action),
        authMode: "jwt",
        authUser: { role },
      });
      assertEquals(decision.ok, false, `${role}:${action}`);
      if (!decision.ok) {
        assertEquals(decision.status, 403, `${role}:${action}`);
        assertEquals(
          decision.code,
          "operator_access_required",
          `${role}:${action}`,
        );
      }
    }
  }
});

Deno.test("outage fix: a missing or invalid session still gets 401 on the four reads", () => {
  for (const action of LEAD_INSTALLER_READ_ACTIONS) {
    for (const authMode of ["none", "jwt", "api_key"] as const) {
      const decision = _authorizeOpsApiAction({
        url: actionUrl(action),
        authMode,
      });
      assertEquals(decision.ok, false, `${authMode}:${action}`);
      if (!decision.ok) {
        assertEquals(decision.status, 401, `${authMode}:${action}`);
        assertEquals(
          decision.code,
          "user_jwt_required",
          `${authMode}:${action}`,
        );
      }
    }
  }
});

Deno.test("outage fix: lead_installer stays a non-operator inside add_note — assignment check still applies", async () => {
  // The four-read entitlement must not leak into the shared staff predicate
  // that handlers (add_note, approvals) use for their inner operator split.
  const noteIsAdmin = _opsApiCallerIsStaffOperator("jwt", {
    role: "lead_installer",
  });
  assertEquals(noteIsAdmin, false);
  await assertRejects(
    () =>
      _assertAssignedOrMakesafeAccessForTest(
        makeAccessClient({
          id: "job-patio",
          type: "patio",
          job_number: "SWP-261098",
        }),
        "job-patio",
        "lead-installer-user",
        noteIsAdmin,
      ),
    Error,
    "You are not assigned to this job",
  );
});

Deno.test("#681: a missing or expired session still gets 401 user_jwt_required", () => {
  for (
    const input of [
      { authMode: "none" as const },
      { authMode: "jwt" as const }, // token rejected upstream -> no authUser
      { authMode: "api_key" as const }, // shared browser key only
    ]
  ) {
    const decision = _authorizeOpsApiAction({
      url: actionUrl("makesafe_board"),
      authMode: input.authMode,
    });
    assertEquals(decision.ok, false, input.authMode);
    if (!decision.ok) {
      assertEquals(decision.status, 401, input.authMode);
      assertEquals(decision.code, "user_jwt_required", input.authMode);
    }
  }
});

Deno.test("deliberately-strict admin/owner gates still reject an ops_manager JWT", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // Case-level strict gates: each must keep its literal admin/owner predicate
  // and must NOT have been rewired to the broader staff-operator helper.
  for (
    const action of [
      "heal_scope_revisions",
      "auto_approve_clean_intake_drafts",
      "recapture_intake_draft",
      "makesafe_gap_fill_apply",
    ]
  ) {
    const start = index.indexOf(`case '${action}': {`);
    assertEquals(start >= 0, true, action);
    const nextCase = index.indexOf("case '", start + 1);
    assertEquals(nextCase > start, true, action);
    const block = index.slice(start, nextCase);
    assertEquals(
      block.includes("_opsApiCallerIsStaffOperator"),
      false,
      action,
    );
    assertEquals(block.includes("'ops_manager'"), false, action);
    assertEquals(block.includes("authUser?.role === 'admin'"), true, action);
  }
  // Credential surface: vault_sync_sw_api_key keeps its admin/owner-only JWT
  // predicate.
  const vaultStart = index.indexOf("async function vaultSyncSwApiKeyAction(");
  assertEquals(vaultStart >= 0, true);
  const vaultBlock = index.slice(vaultStart, vaultStart + 1200);
  assertEquals(vaultBlock.includes("_opsApiCallerIsStaffOperator"), false);
  assertEquals(
    vaultBlock.includes(
      "authUser?.role === 'admin' || authUser?.role === 'owner'",
    ),
    true,
  );
  // And the aligned sites really are wired to the ONE shared predicate.
  assertEquals(
    index.includes(
      "const noteIsAdmin = _opsApiCallerIsStaffOperator(authMode, authUser)",
    ),
    true,
  );
  assertEquals(
    index.includes(
      "const approveIsPrivileged = _opsApiCallerIsStaffOperator(authMode, authUser)",
    ),
    true,
  );
});

// ── set_job_lead front door (Henry / SWF-26091, Captain ruling 2026-08-17) ──
//
// set_job_lead was shipped in #513 with the same in-route gate as allocate_job
// (assertAssignmentMutationAuthz: api_key, dispatcher, or a manager of that
// job's vertical). #667 made the front door default-deny and left it off the
// profile-scoped list, so a lead_installer vertical manager received the
// staff-role 403 before the route gate ever ran. This pins the two-layer
// contract end to end: the front door lets a signed-in trade through, and the
// route gate still decides on the vertical alone.

function makeAssignmentAuthzClient(
  job: { id: string; type: string; job_number: string },
) {
  return {
    from(table: string) {
      const builder: {
        select: () => typeof builder;
        eq: () => typeof builder;
        maybeSingle: () => Promise<{ data: unknown; error: null }>;
      } = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () =>
          Promise.resolve({ data: table === "jobs" ? job : null, error: null }),
      };
      return builder;
    },
  };
}

const FENCING_JOB = {
  id: "job-swf-26091",
  type: "fencing",
  job_number: "SWF-26091",
};

async function setJobLeadOutcome(
  authUser: { id: string; role: string; managedVerticals?: unknown },
): Promise<"allowed" | "front_door_403" | "route_403"> {
  const front = _authorizeOpsApiAction({
    url: actionUrl("set_job_lead"),
    authMode: "jwt",
    authUser,
  });
  if (!front.ok) return front.status === 403 ? "front_door_403" : "allowed";
  try {
    await assertAssignmentMutationAuthz(
      makeAssignmentAuthzClient(FENCING_JOB),
      "jwt",
      authUser,
      { jobId: FENCING_JOB.id, assignmentId: "asg-1" },
    );
    return "allowed";
  } catch (e) {
    assertEquals((e as { status?: number }).status, 403);
    return "route_403";
  }
}

Deno.test("Henry: a lead_installer managing fencing reaches set_job_lead on a fencing job", async () => {
  assertEquals(_opsApiActionNeedsSignedCaller(actionUrl("set_job_lead")), true);
  assertEquals(_opsApiActionNeedsStaffRole(actionUrl("set_job_lead")), false);
  const decision = _authorizeOpsApiAction({
    url: actionUrl("set_job_lead"),
    authMode: "jwt",
    authUser: { role: "lead_installer" },
  });
  assertEquals(decision, { ok: true });
  assertEquals(
    await setJobLeadOutcome({
      id: "henry",
      role: "lead_installer",
      managedVerticals: ["fencing"],
    }),
    "allowed",
  );
});

Deno.test("set_job_lead: the same lead_installer managing only patios is refused by the route gate on a fencing job", async () => {
  assertEquals(
    await setJobLeadOutcome({
      id: "henry",
      role: "lead_installer",
      managedVerticals: ["patio"],
    }),
    "route_403",
  );
});

Deno.test("set_job_lead: a signed-in caller with no managed vertical is refused by the route gate", async () => {
  assertEquals(
    await setJobLeadOutcome({ id: "crew", role: "installer" }),
    "route_403",
  );
  assertEquals(
    await setJobLeadOutcome({
      id: "crew2",
      role: "lead_installer",
      managedVerticals: [],
    }),
    "route_403",
  );
});

Deno.test("set_job_lead: a missing session still gets 401 and the staff-role set is untouched", () => {
  assertEquals(
    authorizationStatus({ action: "set_job_lead", authMode: "none" }),
    401,
  );
  assertEquals(
    authorizationStatus({ action: "set_job_lead", authMode: "api_key" }),
    401,
  );
  assertEquals(
    authorizationStatus({
      action: "set_job_lead",
      authMode: "api_key",
      serverSecretPresented: true,
    }),
    200,
  );
  assertEquals([...OPS_API_STAFF_OPERATOR_ROLES].sort(), [
    "admin",
    "ops_manager",
    "owner",
  ]);
  assertEquals(LEAD_INSTALLER_READ_ACTIONS.has("set_job_lead"), false);
});

Deno.test("allocate_job behaviour is unchanged beside set_job_lead", async () => {
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
  // The route gate answers identically for both actions: vertical, not role.
  await assertAssignmentMutationAuthz(
    makeAssignmentAuthzClient(FENCING_JOB),
    "jwt",
    { id: "henry", role: "lead_installer", managedVerticals: ["fencing"] },
    { jobId: FENCING_JOB.id },
  );
  await assertRejects(() =>
    assertAssignmentMutationAuthz(
      makeAssignmentAuthzClient(FENCING_JOB),
      "jwt",
      { id: "crew", role: "installer" },
      { jobId: FENCING_JOB.id },
    )
  );
});

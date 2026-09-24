// deno-lint-ignore-file no-explicit-any no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _resolveOpsApiAuthIntent } from "./index.ts";
import {
  authorizeMakesafeTradeProjection,
  buildCanonicalMakesafeRows,
  MAKESAFE_TRADE_PROJECTION_ROLES,
  type MakesafeBoardViewer,
  type MakesafeTradeProjectionAuthMode,
  projectTradeMakesafeBoard,
} from "./makesafe_board_read_model.ts";

function job(id: string, userId: string) {
  return {
    id,
    job_number: `SWMS-${id}`,
    type: "makesafe",
    status: "scheduled",
    board_stage: "allocated",
    substatus: "waiting_on_trade_report",
    assignments: [{
      id: `assignment-${id}`,
      user_id: userId,
      status: "scheduled",
      users: { id: userId, name: userId },
    }],
  };
}

const ROWS = buildCanonicalMakesafeRows([
  job("hugo-job", "hugo"),
  job("ordinary-job", "ordinary"),
]);

function tradeRoute(
  authMode: MakesafeTradeProjectionAuthMode,
  viewer?: MakesafeBoardViewer,
): { status: number; body: any } {
  const access = authorizeMakesafeTradeProjection(authMode, viewer);
  if (!access.ok) {
    return { status: access.status, body: { error: access.error } };
  }
  return { status: 200, body: projectTradeMakesafeBoard(ROWS, viewer!) };
}

const ES256_JWT = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";

Deno.test("Trade board mixed credentials prefer the signed-in ES256 Bearer over x-api-key", () => {
  assertEquals(
    _resolveOpsApiAuthIntent({
      xApiKey: "master-key",
      bearerToken: ES256_JWT,
      validKey: "master-key",
      serviceKey: "service-key",
      preferBearerOverApiKey: true,
    }),
    "jwt",
  );
});

Deno.test("auth resolver retains explicit shared-key precedence when browser JWT preference is disabled", () => {
  assertEquals(
    _resolveOpsApiAuthIntent({
      xApiKey: "master-key",
      bearerToken: ES256_JWT,
      validKey: "master-key",
      serviceKey: "service-key",
      preferBearerOverApiKey: false,
    }),
    "api_key",
  );
  // Absent flag keeps the low-level resolver default; protected routes enable
  // browser JWT preference through _preferBearerForOpsApiAction.
  assertEquals(
    _resolveOpsApiAuthIntent({
      xApiKey: "master-key",
      bearerToken: ES256_JWT,
      validKey: "master-key",
      serviceKey: "service-key",
    }),
    "api_key",
  );
});

Deno.test("legacy shared-key Bearer remains classified as api_key before the protected-route rejection", () => {
  assertEquals(
    _resolveOpsApiAuthIntent({
      xApiKey: null,
      bearerToken: "master-key",
      validKey: "master-key",
      serviceKey: "service-key",
      preferBearerOverApiKey: true,
    }),
    "api_key",
  );
});

Deno.test("routine key still wins regardless of Trade board scoping", () => {
  assertEquals(
    _resolveOpsApiAuthIntent({
      xApiKey: "routine-key",
      bearerToken: ES256_JWT,
      validKey: "master-key",
      serviceKey: "service-key",
      routineKey: "routine-key",
      preferBearerOverApiKey: true,
    }),
    "routine",
  );
});

Deno.test("Hugo lead_installer token gets 200 and every make-safe", () => {
  const response = tradeRoute("jwt", {
    userId: "hugo",
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  assertEquals(response.status, 200);
  assertEquals(response.body.rows.map((row: any) => row.id).sort(), [
    "hugo-job",
    "ordinary-job",
  ]);
  assertEquals(response.body.permissions, {
    visibility: "all_makesafes",
    sees_all_makesafes: true,
    fencing_view_only: false,
    can_allocate: true,
  });
});

Deno.test("ordinary crew token gets 200 with allocated-only rows", () => {
  const response = tradeRoute("jwt", {
    userId: "ordinary",
    role: "crew",
    managedVerticals: [],
  });
  assertEquals(response.status, 200);
  assertEquals(response.body.rows.map((row: any) => row.id), ["ordinary-job"]);
  assertEquals(response.body.permissions.visibility, "allocated_only");
  assertEquals(response.body.permissions.can_allocate, false);
});

// Retired 2026-09-24 (Captain ruling, "go A"): the role==='sales' /
// managed_verticals 'fencing' fencing_view_only special case on this board is
// gone — nothing live depended on it (no production user held role 'sales',
// and trade.html never read fencing_view_only). A fencing category manager
// with no make-safe standing now gets plain allocated_only, matching "let
// them have access to history of the jobs they were allocated to" for every
// category they don't manage. Khairo's actual post-migration profile is
// managed_verticals=['fencing'], not role='sales' — this proves the shape
// either way produces the same, now-uniform answer.
Deno.test("a fencing-only manager (sales role or managed_verticals fencing) gets plain allocated_only on the make-safe board, not a special view-only shape", () => {
  const bySalesRole = tradeRoute("jwt", {
    userId: "khairo",
    role: "sales",
    managedVerticals: [],
  });
  const byManagedVertical = tradeRoute("jwt", {
    userId: "khairo",
    role: "lead_installer",
    managedVerticals: ["fencing"],
  });
  for (const response of [bySalesRole, byManagedVertical]) {
    assertEquals(response.status, 200);
    assertEquals(response.body.rows, []);
    assertEquals(response.body.permissions, {
      visibility: "allocated_only",
      sees_all_makesafes: false,
      fencing_view_only: false,
      can_allocate: false,
    });
  }
});

Deno.test("role alone (admin) no longer grants make-safe board see-all — the see-everything flag is required", () => {
  const response = tradeRoute("jwt", {
    userId: "marnin",
    role: "admin",
    managedVerticals: [],
  });
  assertEquals(response.status, 200);
  assertEquals(response.body.permissions.sees_all_makesafes, false);
  assertEquals(response.body.rows, []);
});

Deno.test("see-everything (Shaun/Marnin/Jan/Esther) gets Hugo-equivalent read access, regardless of role", () => {
  const response = tradeRoute("jwt", {
    userId: "marnin",
    role: "admin",
    managedVerticals: [],
    seeEverything: true,
  });
  assertEquals(response.status, 200);
  assertEquals(response.body.rows.length, ROWS.length);
  assertEquals(response.body.permissions.sees_all_makesafes, true);
  assertEquals(response.body.permissions.can_allocate, true);
});

Deno.test("anonymous and master-key callers still get 403", () => {
  assertEquals(tradeRoute("anonymous").status, 403);
  assertEquals(tradeRoute("api_key").status, 403);
});

Deno.test("unknown signed-in role fails closed with 403", () => {
  const response = tradeRoute("jwt", {
    userId: "unknown",
    role: "unexpected_role",
    managedVerticals: ["makesafe"],
  });
  assertEquals(response.status, 403);
  assertEquals(
    response.body.error,
    "trade projection is not permitted for this account role",
  );
});

// The allow-list of roles permitted to REACH this endpoint at all is
// unchanged (an authentication question). Which VISIBILITY each gets is no
// longer role-shaped at all since the 2026-09-24 ruling: every listed role,
// absent the explicit see-everything flag and with no managed vertical, gets
// the same allocated_only answer — proven once here rather than per-role.
Deno.test("the published trade projection role contract is exact and every listed role is recognized", () => {
  const roles = [
    "admin",
    "owner",
    "ops_manager",
    "crew",
    "estimator",
    "installer",
    "lead_installer",
    "sales",
  ];
  assertEquals([...MAKESAFE_TRADE_PROJECTION_ROLES], roles);
  for (const role of roles) {
    const access = authorizeMakesafeTradeProjection("jwt", {
      userId: `user-${role}`,
      role,
      managedVerticals: [],
    });
    assertEquals(access.status, 200, role);
    if (access.ok) {
      assertEquals(
        access.permissions.visibility,
        "allocated_only",
        `${role}: role alone no longer grants board see-all`,
      );
    }
  }
  // The see-everything flag grants all_makesafes for EVERY role on the
  // allow-list, not just the traditional office roles.
  for (const role of roles) {
    const access = authorizeMakesafeTradeProjection("jwt", {
      userId: `user-${role}`,
      role,
      managedVerticals: [],
      seeEverything: true,
    });
    assertEquals(access.status, 200, role);
    if (access.ok) {
      assertEquals(access.permissions.visibility, "all_makesafes", role);
    }
  }
});

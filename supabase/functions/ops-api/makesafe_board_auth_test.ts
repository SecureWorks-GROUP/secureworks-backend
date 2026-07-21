// deno-lint-ignore-file no-explicit-any no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _resolveOpsApiAuthIntent } from "./index.ts";
import {
  authorizeMakesafeTradeProjection,
  buildCanonicalMakesafeRows,
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

Deno.test("mixed browser credentials prefer the signed-in ES256 Bearer over x-api-key", () => {
  const es256Jwt = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
  assertEquals(
    _resolveOpsApiAuthIntent({
      xApiKey: "master-key",
      bearerToken: es256Jwt,
      validKey: "master-key",
      serviceKey: "service-key",
    }),
    "jwt",
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

Deno.test("Khairo production sales-role token gets fencing view-only", () => {
  const response = tradeRoute("jwt", {
    userId: "khairo",
    role: "sales",
    managedVerticals: [],
  });
  assertEquals(response.status, 200);
  assertEquals(response.body.rows, []);
  assertEquals(response.body.permissions, {
    visibility: "allocated_only",
    sees_all_makesafes: false,
    fencing_view_only: true,
    can_allocate: false,
  });
});

Deno.test("admin token gets Hugo-equivalent read access for verification", () => {
  const response = tradeRoute("jwt", {
    userId: "marnin",
    role: "admin",
    managedVerticals: [],
  });
  assertEquals(response.status, 200);
  assertEquals(response.body.rows.length, ROWS.length);
  assertEquals(response.body.permissions.sees_all_makesafes, true);
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

Deno.test("every role value currently present in production is explicitly recognized", () => {
  const expected: Record<string, string> = {
    admin: "all_makesafes",
    crew: "allocated_only",
    estimator: "allocated_only",
    installer: "allocated_only",
    lead_installer: "allocated_only",
    ops_manager: "all_makesafes",
    sales: "allocated_only",
  };
  for (const [role, visibility] of Object.entries(expected)) {
    const access = authorizeMakesafeTradeProjection("jwt", {
      userId: `user-${role}`,
      role,
      managedVerticals: [],
    });
    assertEquals(access.status, 200, role);
    if (access.ok) {
      assertEquals(access.permissions.visibility, visibility, role);
    }
  }
});

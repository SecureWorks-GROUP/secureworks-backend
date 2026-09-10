// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _authorizeOpsApiAction,
  _preferBearerForOpsApiAction,
  _readInsuranceEvidenceAction,
  _resolveOpsApiAuthIntent,
} from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const JOB = "11111111-1111-4111-8111-111111111111";
const actions = [
  "list_job_service_reports",
  "list_job_roof_report_drafts",
  "list_job_documents",
  "get_job_document",
];
const user = (role: string, orgId = ORG) => ({ role, orgId });
const noRead = {
  from() {
    throw new Error("Unauthorised reads must not reach data");
  },
};

Deno.test("all insurance evidence actions retain server or staff auth at the actual front door", async () => {
  for (const action of actions) {
    const url = new URL(
      `https://example.invalid/ops-api?action=${action}&job_id=${JOB}`,
    );
    assertEquals(_preferBearerForOpsApiAction(url), true);
    assertEquals(
      _authorizeOpsApiAction({
        url,
        authMode: "api_key",
        serverSecretPresented: false,
      }).ok,
      false,
    );
    assertEquals(_authorizeOpsApiAction({ url, authMode: "none" }).ok, false);
    assertEquals(
      _authorizeOpsApiAction({
        url,
        authMode: "api_key",
        serverSecretPresented: true,
      }).ok,
      true,
    );
    for (const role of ["admin", "owner", "ops_manager"]) {
      assertEquals(
        _authorizeOpsApiAction({ url, authMode: "jwt", authUser: user(role) })
          .ok,
        true,
      );
    }
    for (const role of ["installer", "lead_installer", "unknown"]) {
      assertEquals(
        _authorizeOpsApiAction({ url, authMode: "jwt", authUser: user(role) })
          .ok,
        false,
      );
      assertEquals(
        (await _readInsuranceEvidenceAction(
          noRead,
          url.searchParams,
          "GET",
          "jwt",
          user(role),
          false,
        )).status,
        403,
      );
    }
    for (const mode of ["api_key", "routine", "agent_read", "none"] as const) {
      assertEquals(
        (await _readInsuranceEvidenceAction(
          noRead,
          url.searchParams,
          "GET",
          mode,
          null,
          false,
        )).status,
        403,
      );
    }
    assertEquals(
      (await _readInsuranceEvidenceAction(
        noRead,
        url.searchParams,
        "POST",
        "api_key",
        null,
        true,
      )).status,
      405,
    );
  }
  assertEquals(
    _resolveOpsApiAuthIntent({
      xApiKey: "distinct-server",
      bearerToken: null,
      validKey: "browser",
      serviceKey: "service",
      routineKey: "routine",
      agentServerKey: "distinct-server",
    }),
    "api_key",
  );
});

Deno.test("integrated wrapper derives JWT organisation and preserves structured evidence/refusal", async () => {
  const seen: any[] = [];
  const client = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const query: any = {
        select() {
          return query;
        },
        eq(key: string, value: unknown) {
          filters.push([key, value]);
          return query;
        },
        order() {
          return query;
        },
        limit() {
          seen.push({ table, filters });
          return Promise.resolve({
            data: table === "jobs" && filters.some(([key, value]) =>
                key === "org_id" && value === ORG
              )
              ? [{ id: JOB, org_id: ORG }]
              : [],
            error: null,
          });
        },
      };
      return query;
    },
  };
  const params = new URLSearchParams({
    action: "list_job_documents",
    job_id: JOB,
  });
  const response = await _readInsuranceEvidenceAction(
    client,
    params,
    "GET",
    "jwt",
    user("ops_manager"),
    false,
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.job_id, JOB);
  assertEquals(body.rows, []);
  assertEquals(body.pagination.has_more, false);
  assertEquals(body.pagination.next_cursor, null);
  assertEquals(seen[0], {
    table: "jobs",
    filters: [["org_id", ORG], ["id", JOB]],
  });
  const before = seen.length;
  const wrong = await _readInsuranceEvidenceAction(
    client,
    params,
    "GET",
    "jwt",
    user("admin", OTHER),
    false,
  );
  assertEquals(wrong.status, 404);
  assertEquals((await wrong.json()).ok, false);
  assertEquals(
    seen.length,
    before + 1,
    "A foreign parent must stop before child access",
  );
  const missingOrg = await _readInsuranceEvidenceAction(
    noRead,
    params,
    "GET",
    "jwt",
    user("admin", ""),
    false,
  );
  assertEquals(missingOrg.status, 403);
});

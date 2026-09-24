// Slice S-M1: the link_site_jobs door. Behaviour on the module (body contract,
// RPC arguments with the actor, refusal mapping) and on the real ops-api front
// door (staff only; not a trade or agent-read action). The SQL
// writer's own behaviour on the named sites is in the migration contract
// supabase/tests/migration-contracts/20260925040000_job_parties_foundation.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { linkSiteJobs, siteLinkArgs, SiteLinkError } from "./site_links.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

// S1: SWF-26078 proposed as the same site as SWF-26075 (INV-0665 names both).
const S1_LEAD = "68e2e301-aa3a-4d5d-9924-d907643e1cba";
const S1_OTHER = "8ad5bc77-50e5-48b6-bff7-34a7234b977d";

function fakeRpc(data: unknown, error: unknown = null) {
  const calls: { fn: string; args: any }[] = [];
  return {
    calls,
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data, error });
    },
  };
}

Deno.test("S1 proposal reaches the one SQL writer with the recorded actor", async () => {
  const rpc = fakeRpc({ outcome: "site_link_proposed", status: "proposed" });
  const out = await linkSiteJobs(rpc, {
    job_id: S1_OTHER,
    site_lead_job_id: S1_LEAD,
    link_kind: "split_party",
    decision: "propose",
    evidence: { basis: ["invoice_names_job", "same_address"] },
  }, "user:5b0e0000-0000-4000-8000-000000000001");
  assertEquals(out.status, "proposed");
  assertEquals(rpc.calls, [{
    fn: "link_site_jobs",
    args: {
      p_job_id: S1_OTHER,
      p_site_lead_job_id: S1_LEAD,
      p_link_kind: "split_party",
      p_decision: "propose",
      p_actor: "user:5b0e0000-0000-4000-8000-000000000001",
      p_evidence: { basis: ["invoice_names_job", "same_address"] },
    },
  }]);
});

Deno.test("a call with no actor is recorded as actor_missing, never refused", async () => {
  const rpc = fakeRpc({ outcome: "site_link_confirmed" });
  await linkSiteJobs(rpc, {
    job_id: S1_OTHER,
    site_lead_job_id: S1_LEAD,
    link_kind: "stage",
    decision: "confirm",
  }, "actor_missing");
  assertEquals(rpc.calls[0].args.p_actor, "actor_missing");
  assertEquals(rpc.calls[0].args.p_evidence, {});
});

Deno.test("the body contract refuses before any database call", () => {
  const base = {
    job_id: S1_OTHER,
    site_lead_job_id: S1_LEAD,
    link_kind: "split_party",
    decision: "propose",
  };
  const cases: [unknown, string][] = [
    [null, "invalid_request"],
    [[], "invalid_request"],
    [{ ...base, job_id: "SWF-26078" }, "invalid_request"],
    [{ ...base, site_lead_job_id: "" }, "invalid_request"],
    [{ ...base, site_lead_job_id: S1_OTHER }, "site_link_self"],
    [{ ...base, link_kind: "merge" }, "invalid_request"],
    [{ ...base, decision: "delete" }, "invalid_request"],
    [{ ...base, evidence: [1] }, "invalid_request"],
    [{ ...base, evidence: { note: "x".repeat(5000) } }, "invalid_request"],
    [{ ...base, status: "confirmed" }, "invalid_request"],
  ];
  for (const [body, code] of cases) {
    const e = assertThrows(() => siteLinkArgs(body, "user:x"), SiteLinkError);
    assertEquals(
      [e.code, e.status],
      [code, 400],
      JSON.stringify(body)?.slice(0, 80),
    );
  }
});

Deno.test("SQL refusals keep their code; anything else is a 503 with no detail", async () => {
  const body = {
    job_id: S1_OTHER,
    site_lead_job_id: S1_LEAD,
    link_kind: "split_party",
    decision: "propose",
  };
  for (
    const [message, status] of [
      ["site_link_already_confirmed", 409],
      ["site_lead_is_linked", 409],
      ["job_is_site_lead", 409],
      ["site_link_other_lead", 409],
      ["site_link_job_not_found", 404],
    ] as const
  ) {
    const e = await assertRejects(
      () => linkSiteJobs(fakeRpc(null, { message }), body, "user:x"),
      SiteLinkError,
    );
    assertEquals([e.code, e.status], [message, status]);
  }
  const e = await assertRejects(
    () =>
      linkSiteJobs(
        fakeRpc(null, {
          message: "canceling statement due to statement timeout",
          code: "57014",
        }),
        body,
        "user:x",
      ),
    SiteLinkError,
  );
  assertEquals([e.code, e.status, e.message], [
    "site_link_failed",
    503,
    "the site link could not be written",
  ]);
});

Deno.test("link_site_jobs is staff-only: trades refused, never agent-read", () => {
  const url = new URL("https://example.invalid/ops-api?action=link_site_jobs");
  assertEquals(_opsApiActionNeedsStaffRole(url), true);
  assertEquals(AGENT_READ_ALLOWED_ACTIONS.has("link_site_jobs"), false);
  const decide = (
    authMode: "api_key" | "jwt",
    role?: string,
    managedVerticals?: string[],
    secret = authMode === "api_key",
  ) => {
    const d = _authorizeOpsApiAction({
      url,
      authMode,
      authUser: role ? { role, managedVerticals } : null,
      serverSecretPresented: secret,
    });
    return d.ok ? 200 : d.status;
  };
  assertEquals(decide("jwt", "admin"), 200);
  assertEquals(decide("jwt", "ops_manager"), 200);
  assertEquals(decide("api_key"), 200);
  assertEquals(decide("api_key", undefined, undefined, false), 401);
  assertEquals(decide("jwt", "lead_installer", ["fencing"]), 403);
  assertEquals(decide("jwt", "trade"), 403);
});

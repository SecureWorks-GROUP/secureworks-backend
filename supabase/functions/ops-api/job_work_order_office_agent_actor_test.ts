// deno-lint-ignore-file no-explicit-any no-import-prefix
// Owner, 21 Nov 2026: the ops agent's server key reviews a held invoice line
// for a named office person. Every id here is made up.
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { JobWorkOrderOfficeError, officeActorNamedByAgent } from "./job_work_order_office.ts";

const OFFICE = "0a200000-0000-4000-8000-000000000001";
const TRADE = "0a200000-0000-4000-8000-000000000002";

function fakeClient(row: any, error: any = null) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _id: string) => ({
          maybeSingle: () => Promise.resolve({ data: row, error }),
        }),
      }),
    }),
  };
}

async function code(p: Promise<unknown>): Promise<[string, number]> {
  const e = await assertRejects(() => p, JobWorkOrderOfficeError) as any;
  return [e.body?.code ?? e.code, e.status];
}

Deno.test("agent line review: the named person must be a real office person", async () => {
  assertEquals((await code(officeActorNamedByAgent(fakeClient(null), "nope")))[1], 403);
  assertEquals((await code(officeActorNamedByAgent(fakeClient(null), OFFICE)))[1], 403);
  assertEquals((await code(officeActorNamedByAgent(fakeClient({ id: TRADE, org_id: "o", role: "crew" }), TRADE)))[1], 403);
  assertEquals((await code(officeActorNamedByAgent(fakeClient({ id: TRADE, org_id: "o", role: "lead_installer" }), TRADE)))[1], 403);
  assertEquals((await code(officeActorNamedByAgent(fakeClient(null, { message: "down" }), OFFICE)))[1], 503);
});

Deno.test("agent line review: an office person is the actor, marked as via the agent", async () => {
  for (const role of ["admin", "owner", "ops_manager", "Admin"]) {
    assertEquals(
      await officeActorNamedByAgent(fakeClient({ id: OFFICE, org_id: "o", role }), OFFICE),
      { staff: true, userId: OFFICE, orgId: "o", viaAgent: true },
    );
  }
});

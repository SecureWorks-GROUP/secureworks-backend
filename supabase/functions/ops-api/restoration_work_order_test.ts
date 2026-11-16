import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseRestorationAgreedLabour,
  setRestorationWorkOrderAction,
} from "./restoration_work_order.ts";
import { RestorationWorkflowError } from "./restoration_workflow.ts";

const USER = "706c5258-70dd-483a-b36c-af6864b24498";
const JOB = "d1deeaac-3733-4a99-b906-f14e23cce3fe";
const WO = "7723ea05-a924-431c-ba3a-acaf0d0e36af";

function makeClient(opts: { authority?: string | null; woStatus?: string; agreed?: number | null; family?: string } = {}) {
  const calls: Array<{ kind: string; name: string; args?: any; patch?: any }> = [];
  const wo = {
    id: WO,
    org_id: "00000000-0000-0000-0000-000000000001",
    job_id: JOB,
    kind: "job",
    status: opts.woStatus ?? "draft",
    wo_number: "WO-1",
    agreed_labour_ex: opts.agreed ?? null,
    special_instructions: null,
    updated_at: "2026-11-12T01:00:00Z",
  };
  const job = {
    id: JOB,
    org_id: "00000000-0000-0000-0000-000000000001",
    job_number: "SWRESTO-261718",
    type: "makesafe",
    status: "processing",
    metadata: { makesafe_job_family: opts.family ?? "restoration" },
  };
  return {
    calls,
    client: {
      rpc(name: string, args: any) {
        calls.push({ kind: "rpc", name, args });
        if (name === "owner_approval_authority") {
          return Promise.resolve({ data: opts.authority === undefined ? "approver_list" : opts.authority, error: null });
        }
        if (name === "approve_job_work_order") {
          return Promise.resolve({ data: { ...wo, status: "approved", agreed_labour_ex: 160 }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      from(table: string) {
        let patch: any = null;
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          update: (p: any) => {
            patch = p;
            calls.push({ kind: "update", name: table, patch: p });
            return chain;
          },
          insert: (row: any) => {
            calls.push({ kind: "insert", name: table, args: row });
            return Promise.resolve({ error: null });
          },
          maybeSingle: () => {
            if (table === "jobs") return Promise.resolve({ data: job, error: null });
            if (table === "work_orders" && patch) {
              return Promise.resolve({ data: { ...wo, ...patch, updated_at: "2026-11-12T02:00:00Z" }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          then: (resolve: any) => resolve({ data: table === "work_orders" ? [wo] : [], error: null }),
        };
        return chain;
      },
    },
  };
}

const JWT = { authMode: "jwt" as const, userId: USER, orgId: null, relayedBy: null };
const BODY = { job_id: JOB, agreed_labour_ex: 160, breakdown: "Jean Crous: 2 h on site + 2 h travel at $40/h" };

Deno.test("restoration work order: the amount is dollars ex GST, cents exact", () => {
  assertEquals(parseRestorationAgreedLabour("160"), 160);
  assertEquals(parseRestorationAgreedLabour(80.005), 80.01);
  for (const bad of [null, "", "abc", -1, 200_000]) {
    let code = "";
    try {
      parseRestorationAgreedLabour(bad);
    } catch (e) {
      code = (e as RestorationWorkflowError).code;
    }
    assertEquals(code !== "", true);
  }
});

Deno.test("restoration work order: an approver sets the amount and approves the job's work order", async () => {
  const { client, calls } = makeClient();
  const result = await setRestorationWorkOrderAction(client, BODY, JWT);
  assertEquals(result.success, true);
  assertEquals((result.work_order as any).agreed_labour_ex, 160);
  const update = calls.find((c) => c.kind === "update" && c.name === "work_orders")!;
  assertEquals(update.patch, { agreed_labour_ex: 160, special_instructions: BODY.breakdown });
  const approve = calls.find((c) => c.name === "approve_job_work_order")!;
  assertEquals([approve.args.p_work_order_id, approve.args.p_approver, approve.args.p_via], [WO, USER, "session"]);
  assertEquals(calls.some((c) => c.kind === "insert" && c.args?.event_type === "restoration_work_order_set"), true);
});

Deno.test("restoration work order: refused for a non-approver, a routine, a non-restoration job, no breakdown, or a sealed change", async () => {
  const cases: Array<[ReturnType<typeof makeClient>, any, any, string]> = [
    [makeClient({ authority: null }), BODY, JWT, "approver_required"],
    [makeClient(), BODY, { ...JWT, authMode: "routine" }, "operator_access_required"],
    [makeClient({ family: "general_makesafe" }), BODY, JWT, "not_a_restoration_job"],
    [makeClient(), { ...BODY, breakdown: "" }, JWT, "breakdown_required"],
    [makeClient({ woStatus: "approved", agreed: 80 }), BODY, JWT, "work_order_sealed"],
  ];
  for (const [{ client }, body, auth, code] of cases) {
    const err = await assertRejects(() => setRestorationWorkOrderAction(client, body, auth), Error);
    assertEquals((err as any).code, code);
  }
  const same = await setRestorationWorkOrderAction(makeClient({ woStatus: "approved", agreed: 160 }).client, BODY, JWT);
  assertEquals(same.unchanged, true);
});

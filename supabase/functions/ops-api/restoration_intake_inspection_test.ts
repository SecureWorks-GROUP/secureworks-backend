// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRestorationInspectionText,
  buildRestorationInspectionWorkOrder,
  RESTORATION_INSPECTION_ACTOR,
  RESTORATION_INSPECTION_AGREED_EX,
  RESTORATION_INSPECTION_TEXT_EVENT,
  RESTORATION_INSPECTION_TRADE_EMAIL,
  restorationInspectionReference,
  restorationInspectionSite,
  runRestorationInspectionIntake,
} from "./restoration_intake_inspection.ts";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const WO_ID = "22222222-2222-4222-8222-222222222222";

const CTX = {
  jobId: JOB_ID,
  orgId: ORG_ID,
  jobNumber: "SWRESTO-260001",
  siteAddress: "1 Test Street",
  suburb: "Testville",
  builderReference: "MLB-10001",
  builderPoNumber: "PO-20002",
  clientName: "Test Client",
  clientPhone: "0400000002",
};
const JEAN = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Jean Crous",
  email: RESTORATION_INSPECTION_TRADE_EMAIL,
  phone: "+61400000000",
};
const MARNIN = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Marnin",
  email: "marnin@secureworkswa.com.au",
  phone: "+61400000001",
};

function fakeClient(opts: { wo?: any; approveError?: any; priorText?: boolean } = {}) {
  const calls: any[] = [];
  const events: any[] = opts.priorText
    ? [{ id: "e0", job_id: JOB_ID, event_type: RESTORATION_INSPECTION_TEXT_EVENT }]
    : [];
  let wo: any = opts.wo === undefined
    ? { id: WO_ID, job_id: JOB_ID, kind: "job", status: "draft", wo_number: "WO-SWRESTO-260001", agreed_labour_ex: null, updated_at: "t0" }
    : opts.wo;
  const client = {
    calls,
    events,
    get wo() { return wo; },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let patch: any = null;
      const q: any = {
        select() { return q; },
        eq(col: string, v: unknown) { filters[col] = v; return q; },
        limit() { return q; },
        update(p: any) { patch = p; return q; },
        insert(row: any) {
          if (table === "job_events") events.push(row);
          return Promise.resolve({ error: null });
        },
        maybeSingle() {
          if (table === "work_orders" && patch) {
            if (!wo || wo.status !== filters.status) return Promise.resolve({ data: null, error: null });
            wo = { ...wo, ...patch, updated_at: "t1" };
            calls.push(["update", patch]);
            return Promise.resolve({ data: wo, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: any) {
          if (table === "work_orders") return resolve({ data: wo ? [wo] : [], error: null });
          if (table === "job_events") {
            return resolve({
              data: events.filter((e) => e.event_type === filters.event_type),
              error: null,
            });
          }
          return resolve({ data: [], error: null });
        },
      };
      return q;
    },
    rpc(name: string, args: any) {
      calls.push(["rpc", name, args]);
      if (name === "approve_job_work_order_by_agent") {
        if (opts.approveError) return Promise.resolve({ data: null, error: opts.approveError });
        wo = { ...wo, status: "approved" };
        return Promise.resolve({ data: wo, error: null });
      }
      return Promise.resolve({ data: WO_ID, error: null });
    },
  };
  return client;
}

function sender() {
  const sent: any[] = [];
  return {
    sent,
    deps: {
      sendSms: (phone: string, message: string, recipient: any) => {
        sent.push({ phone, message, recipient });
        return Promise.resolve({ accepted: true, messageId: "m1", failureReason: null });
      },
    },
  };
}

Deno.test("site and reference read cleanly without repeats", () => {
  assertEquals(restorationInspectionSite("1 Test Street", "Testville"), "1 Test Street, Testville");
  assertEquals(restorationInspectionSite("1 Test Street, Testville WA", "Testville"), "1 Test Street, Testville WA");
  assertEquals(restorationInspectionReference("MLB-10001", "PO-20002"), "MLB-10001 / PO-20002");
  assertEquals(restorationInspectionReference("MLB-10001PO-20002", "PO-20002"), "MLB-10001PO-20002");
  assertEquals(restorationInspectionReference(null, "PO-20002"), "PO-20002");
});

Deno.test("the inspection work order is 2 hours, $88, undated, with the site and references", () => {
  const f = buildRestorationInspectionWorkOrder(CTX, JEAN);
  assertEquals(f.agreed_labour_ex, 88);
  assertEquals(f.scope_items[0].quantity, 2);
  assertEquals(f.scope_items[0].unit, "hours");
  assert(f.scope_items[0].description.includes("moisture inspection"));
  assertEquals("scheduled_date" in f, false);
  assertEquals(f.site_address, "1 Test Street, Testville");
  assert(f.special_instructions.startsWith("Jean Crous: 2 hours"));
  assert(f.special_instructions.includes("MLB-10001 / PO-20002"));
});

Deno.test("the text names the job, site, client, reference, the work, the booking ask and the link", () => {
  const t = buildRestorationInspectionText(CTX, JEAN, true);
  assert(t.startsWith("Hi Jean, new restoration job SWRESTO-260001 for you and Marnin."));
  assert(t.includes("Client: Test Client, 0400000002"));
  assert(t.includes("call the client to arrange a time, then book the date in the Trade App"));
  assert(!t.includes("today"));
  assert(t.includes("Site: 1 Test Street, Testville"));
  assert(t.includes("Builder ref: MLB-10001 / PO-20002"));
  assert(t.includes("2 hours ($88)"));
  assert(t.includes(`trade.html#job/${JOB_ID}`));
  assert(!buildRestorationInspectionText(CTX, JEAN, false).includes("$88"));
});

Deno.test("mint fills and approves the work order by the standing rule, then texts Jean once", async () => {
  const client = fakeClient();
  const { sent, deps } = sender();
  const result: any = await runRestorationInspectionIntake(client, CTX, [MARNIN, JEAN], deps);
  assertEquals(result.work_order.state, "approved");
  assertEquals(client.wo.agreed_labour_ex, RESTORATION_INSPECTION_AGREED_EX);
  const approve = client.calls.find((c) => c[1] === "approve_job_work_order_by_agent");
  assertEquals(approve[2].p_actor, RESTORATION_INSPECTION_ACTOR);
  assertEquals(approve[2].p_expected_updated_at, "t1");
  assertEquals(approve[2].p_org_id, ORG_ID);
  assertEquals(result.text.state, "sent");
  assertEquals(sent.length, 1);
  assertEquals(sent[0].phone, JEAN.phone);
  assertEquals(sent[0].recipient, { role: "crew", aboutJobId: JOB_ID });

  const again: any = await runRestorationInspectionIntake(client, CTX, [MARNIN, JEAN], deps);
  assertEquals(again.work_order.state, "already_approved");
  assertEquals(again.text.state, "already_texted");
  assertEquals(sent.length, 1);
});

Deno.test("an approved or hand-filled work order is left alone", async () => {
  const approved = fakeClient({ wo: { id: WO_ID, job_id: JOB_ID, kind: "job", status: "approved", agreed_labour_ex: 120, updated_at: "t0" } });
  const r1: any = await runRestorationInspectionIntake(approved, CTX, [JEAN], sender().deps);
  assertEquals(r1.work_order.state, "already_approved");
  assertEquals(approved.calls.filter((c) => c[0] === "update").length, 0);

  const filled = fakeClient({ wo: { id: WO_ID, job_id: JOB_ID, kind: "job", status: "draft", agreed_labour_ex: 120, updated_at: "t0" } });
  const r2: any = await runRestorationInspectionIntake(filled, CTX, [JEAN], sender().deps);
  assertEquals(r2.work_order.state, "draft_in_use");
  assertEquals(filled.calls.filter((c) => c[0] === "update").length, 0);
});

Deno.test("a refused approval keeps the draft and the text leaves out the money", async () => {
  const client = fakeClient({ approveError: { message: "owner_approval_required" } });
  const { sent, deps } = sender();
  const r: any = await runRestorationInspectionIntake(client, CTX, [JEAN], deps);
  assertEquals(r.work_order.state, "saved_not_approved");
  assertEquals(client.wo.status, "draft");
  assertEquals(sent.length, 1);
  assert(!sent[0].message.includes("$88"));
});

Deno.test("no inspection trade booked means nothing is written or sent", async () => {
  const client = fakeClient();
  const { sent, deps } = sender();
  const r: any = await runRestorationInspectionIntake(client, CTX, [MARNIN], deps);
  assertEquals(r.skipped, "inspection_trade_not_booked");
  assertEquals(client.calls.length, 0);
  assertEquals(sent.length, 0);
});

Deno.test("a trade with no phone is not texted", async () => {
  const client = fakeClient();
  const { sent, deps } = sender();
  const r: any = await runRestorationInspectionIntake(client, CTX, [{ ...JEAN, phone: null }], deps);
  assertEquals(r.text.state, "no_phone");
  assertEquals(sent.length, 0);
});

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  SelfAllocationRefusal,
  selfAllocateForInvoice,
  selfAllocationDateRefusal,
  selfAllocationJobRefusal,
} from "./trade_self_allocation.ts";

const TODAY = "2026-11-11";
const TRADE = { id: "trade-1", orgId: "org-1", name: "Sam Trade" };

function fakeClient(job: any) {
  const calls: any[] = [];
  const client = {
    calls,
    from(table: string) {
      const q: any = { table, filters: [] as any[], op: "select", payload: null };
      const chain: any = {
        select() { return chain; },
        eq(col: string, val: unknown) { q.filters.push([col, val]); return chain; },
        update(payload: any) { q.op = "update"; q.payload = payload; return chain; },
        insert(payload: any) {
          calls.push({ table, op: "insert", payload });
          return Promise.resolve({ error: null });
        },
        maybeSingle() {
          calls.push({ ...q });
          if (table === "jobs") {
            const orgOk = q.filters.some(([c, v]: any) => c === "org_id" && v === job?.org_id);
            return Promise.resolve({ data: job && orgOk ? job : null, error: null });
          }
          if (table === "job_assignments" && q.op === "update") {
            return Promise.resolve({
              data: { id: "asn-new", status: q.payload.status, user_id: TRADE.id },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
  return client;
}

function deps(over: Partial<any> = {}) {
  const created: any[] = [];
  return {
    created,
    value: {
      today: TODAY,
      findExisting: () => Promise.resolve(null),
      createAssignment: (body: any) => {
        created.push(body);
        return Promise.resolve({ assignment: { id: "asn-new", status: "scheduled", user_id: body.userId } });
      },
      isUserDateConflict: (e: any) => e?.code === "23505",
      ...over,
    },
  };
}

const LIVE_JOB = { id: "job-1", org_id: "org-1", job_number: "SWF-1001", status: "scheduled", type: "fencing", metadata: {} };

Deno.test("date rule: today and earlier pass, after today and over a year ago refuse", () => {
  assertEquals(selfAllocationDateRefusal(TODAY, TODAY), null);
  assertEquals(selfAllocationDateRefusal("2026-11-03", TODAY), null);
  assertEquals(selfAllocationDateRefusal("2026-11-12", TODAY)?.code, "self_allocate_future_date");
  assertEquals(selfAllocationDateRefusal("2025-11-01", TODAY)?.code, "self_allocate_date_too_old");
  assertEquals(selfAllocationDateRefusal("2026-02-30", TODAY)?.code, "self_allocate_date_invalid");
  assertEquals(selfAllocationDateRefusal("", TODAY)?.code, "self_allocate_date_invalid");
});

Deno.test("job rule: leads, drafts, quotes, lost and cancelled refuse; finished and archived jobs pass", () => {
  for (const status of ["draft", "quoted", "lost", "cancelled", "lead"]) {
    assertEquals(selfAllocationJobRefusal({ status })?.code, "self_allocate_job_not_open", status);
  }
  for (const status of ["accepted", "scheduled", "in_progress", "complete", "invoiced", "archived", "get_review"]) {
    assertEquals(selfAllocationJobRefusal({ status }), null, status);
  }
  assertEquals(
    selfAllocationJobRefusal({ status: "scheduled", metadata: { do_not_schedule: "true" } })?.code,
    "self_allocate_job_not_open",
  );
});

Deno.test("books only the caller, on the day given, with no text, accepted, and logs a job event", async () => {
  const client = fakeClient(LIVE_JOB);
  const d = deps();
  const res = await selfAllocateForInvoice(client, {
    body: { job_id: "job-1", work_date: "2026-11-10", userId: "someone-else", user_id: "someone-else" },
    trade: TRADE,
  }, d.value);
  assertEquals(res.mode, "created");
  assertEquals(res.assignment.status, "confirmed");
  assertEquals(d.created.length, 1);
  const body = d.created[0];
  assertEquals(body.userId, TRADE.id, "a body user id is never used");
  assertEquals(body.scheduledDate, "2026-11-10");
  assertEquals(body.suppress_notifications, true);
  assertEquals(body.allocated_by_user_id, TRADE.id);
  const ev = client.calls.find((c: any) => c.op === "insert" && c.table === "job_events");
  assert(ev, "job event written");
  assertEquals(ev.payload.event_type, "trade_self_allocated");
  assertEquals(ev.payload.detail_json.work_date, "2026-11-10");
});

Deno.test("an existing row for that day is returned, nothing is created", async () => {
  const client = fakeClient(LIVE_JOB);
  const d = deps({ findExisting: () => Promise.resolve({ id: "asn-old", status: "scheduled" }) });
  const res = await selfAllocateForInvoice(client, { body: { job_id: "job-1", work_date: TODAY }, trade: TRADE }, d.value);
  assertEquals(res.mode, "existing");
  assertEquals(res.assignment.id, "asn-old");
  assertEquals(d.created.length, 0);
});

Deno.test("a job in another company is not found and nothing is created", async () => {
  const client = fakeClient({ ...LIVE_JOB, org_id: "org-2" });
  const d = deps();
  const err = await assertRejects(
    () => selfAllocateForInvoice(client, { body: { job_id: "job-1", work_date: TODAY }, trade: TRADE }, d.value),
    SelfAllocationRefusal,
  );
  assertEquals((err as SelfAllocationRefusal).code, "self_allocate_job_not_found");
  assertEquals(d.created.length, 0);
});

Deno.test("a cancelled job or a future day refuses before any write", async () => {
  const d = deps();
  await assertRejects(
    () => selfAllocateForInvoice(fakeClient({ ...LIVE_JOB, status: "cancelled" }), { body: { job_id: "job-1", work_date: TODAY }, trade: TRADE }, d.value),
    SelfAllocationRefusal,
  );
  await assertRejects(
    () => selfAllocateForInvoice(fakeClient(LIVE_JOB), { body: { job_id: "job-1", work_date: "2026-11-12" }, trade: TRADE }, d.value),
    SelfAllocationRefusal,
  );
  assertEquals(d.created.length, 0);
});

Deno.test("a unique-key race returns the row that won", async () => {
  let reads = 0;
  const d = deps({
    findExisting: () => Promise.resolve(reads++ === 0 ? null : { id: "asn-raced" }),
    createAssignment: () => Promise.reject(Object.assign(new Error("dup"), { code: "23505" })),
  });
  const res = await selfAllocateForInvoice(fakeClient(LIVE_JOB), { body: { job_id: "job-1", work_date: TODAY }, trade: TRADE }, d.value);
  assertEquals(res.mode, "existing");
  assertEquals(res.assignment.id, "asn-raced");
});

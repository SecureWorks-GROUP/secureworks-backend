import { assert, assertEquals } from "jsr:@std/assert";
import { findFenceProblem, isNormalWorkOrderPayLine, isOfficeFeeLine } from "./group_work_order.ts";
import {
  autoGroupPatioJobs,
  crewByJob,
  GROUP_WORK_ORDER_AUTO_PATIO_FLAG,
  openMissingPatioWorkOrders,
} from "./patio_auto_group.ts";

type Row = Record<string, any>;

// A small stand-in for the Supabase client: eq / in / gt / not-is-null
// filters, with "jobs.x" filters read from the embedded job.
class Fake {
  tables: Record<string, Row[]> = {};
  rpcs: { fn: string; args: Row }[] = [];
  failInsert: Record<string, { code: string; message: string }> = {};
  rows(t: string) {
    return (this.tables[t] ||= []);
  }
  client() {
    const fake = this;
    return {
      from: (t: string) => new FakeQuery(fake, t),
      rpc: (fn: string, args: Row) => {
        fake.rpcs.push({ fn, args });
        if (fn === "ensure_job_work_order_draft") {
          const id = `wo-${args.p_job_id}`;
          fake.rows("work_orders").push({ id, job_id: args.p_job_id, kind: "job", status: "draft" });
          return Promise.resolve({ data: id, error: null });
        }
        return Promise.resolve({ data: null, error: { code: "42883", message: "no rpc" } });
      },
    };
  }
}

class FakeQuery {
  filters: ((r: Row) => boolean)[] = [];
  insertRows: Row[] | null = null;
  wantSingle = false;
  constructor(private fake: Fake, private table: string) {}
  private get(r: Row, col: string) {
    return col.startsWith("jobs.") ? r.jobs?.[col.slice(5)] : r[col];
  }
  select() { return this; }
  limit() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => this.get(r, c) === v); return this; }
  in(c: string, v: unknown[]) { this.filters.push((r) => v.includes(this.get(r, c))); return this; }
  gt(c: string, v: number) { this.filters.push((r) => Number(this.get(r, c)) > v); return this; }
  not(c: string, _op: string, _v: null) { this.filters.push((r) => this.get(r, c) != null); return this; }
  insert(rows: Row | Row[]) { this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
  single() { this.wantSingle = true; return this; }
  maybeSingle() { this.wantSingle = true; return this; }
  then(resolve: (v: unknown) => void) {
    if (this.insertRows) {
      const fail = this.fake.failInsert[this.table];
      if (fail) return resolve({ data: null, error: fail });
      const made = this.insertRows.map((r, i) => ({ id: r.id ?? `${this.table}-${this.fake.rows(this.table).length + i}`, ...r }));
      this.fake.rows(this.table).push(...made);
      return resolve({ data: this.wantSingle ? made[0] : made, error: null });
    }
    const out = this.fake.rows(this.table).filter((r) => this.filters.every((f) => f(r)));
    resolve({ data: this.wantSingle ? out[0] ?? null : out, error: null });
  }
}

function patioWorld() {
  const fake = new Fake();
  fake.rows("feature_flags").push(
    { flag_name: "group_work_order_v1", enabled: true },
    { flag_name: GROUP_WORK_ORDER_AUTO_PATIO_FLAG, enabled: true },
  );
  fake.rows("users").push(
    { id: "isaac", role: "lead_installer" },
    { id: "ryan", role: "crew" },
    { id: "nithin", role: "ops_manager" },
    { id: "jan", role: "admin" },
  );
  const job = (id: string, status = "scheduled", type = "patio") => ({
    id, org_id: "org", job_number: id.toUpperCase(), type, status, work_order_id: `wo-${id}`,
  });
  for (const j of [job("a"), job("b"), job("c"), job("d", "archived"), job("e", "scheduled", "fencing")]) {
    fake.rows("jobs").push(j);
    fake.rows("work_orders").push({
      id: `wo-${j.id}`, job_id: j.id, kind: "job", status: "approved", agreed_labour_ex: 2160,
      sealed_content_hash: "h", approved_by: null, jobs: j,
    });
  }
  const allocate = (jobId: string, userId: string, extra: Row = {}) =>
    fake.rows("job_assignments").push({ job_id: jobId, user_id: userId, status: "scheduled", role: "lead_installer", ...extra });
  // a: Isaac, Ryan, Nithin plus a watching admin. b: Isaac and Ryan, Ryan paid by hours.
  // c: Isaac and a cancelled Ryan. d: archived. e: fencing.
  for (const u of ["isaac", "ryan", "nithin", "jan"]) allocate("a", u);
  allocate("b", "isaac"); allocate("b", "ryan");
  allocate("c", "isaac"); allocate("c", "ryan", { status: "cancelled" }); allocate("c", "ryan", { is_ghost: true, status: "scheduled" });
  for (const j of ["d", "e"]) { allocate(j, "isaac"); allocate(j, "ryan"); }
  fake.rows("trade_invoices").push({ id: "inv-n", status: "paid" }, { id: "inv-r", status: "approved" });
  // Nithin's council fee on a does not block; Ryan's hours on b do.
  fake.rows("trade_invoice_lines").push(
    { job_id: "a", line_type: "labour", description: "Council Approval (Job Complete)", trade_invoice_id: "inv-n" },
    { job_id: "a", line_type: "commission", description: "Commission", trade_invoice_id: "inv-n" },
    { job_id: "b", line_type: "labour", description: "Plant posts and framing", trade_invoice_id: "inv-r" },
  );
  return fake;
}

Deno.test("office milestone fees are not crew pay; install hours still are", () => {
  assert(isOfficeFeeLine({ line_type: "labour", description: "Council Approval" }));
  assert(isOfficeFeeLine({ line_type: "labour", description: "  materials ordered" }));
  assert(isOfficeFeeLine({ line_type: "labour", description: "Council Approval + Materials Ordered" }));
  assert(!isOfficeFeeLine({ line_type: "labour", description: "Patio install, council approval chased" }));
  assert(!isOfficeFeeLine({ line_type: "work order", description: "Council Approval" }));
  assert(!isOfficeFeeLine({ line_type: "labour", description: null }));
  assertEquals(isNormalWorkOrderPayLine({ line_type: "labour", description: "Council Approval Process" }), false);
  assertEquals(isNormalWorkOrderPayLine({ line_type: "labour", description: "Patio install" }), true);
  // A share next to a prior council fee is fine; next to prior hours it is refused.
  const share = [{ job_id: "j", line_type: "group share" }];
  assertEquals(findFenceProblem("isaac", share, [{ job_id: "j", line_type: "labour", description: "Council Approval", user_id: "nithin" }]), null);
  assertEquals(findFenceProblem("isaac", share, [{ job_id: "j", line_type: "labour", description: "Patio install", user_id: "henry" }])?.code, "group_share_blocked_by_work_order_claim");
  // A council fee on a grouped job is billable; hours are not.
  const prior = [{ job_id: "j", line_type: "group share", user_id: "isaac" }];
  assertEquals(findFenceProblem("nithin", [{ job_id: "j", line_type: "labour", description: "Council Approval" }], prior), null);
  assertEquals(findFenceProblem("ryan", [{ job_id: "j", line_type: "labour", description: "Framing" }], prior)?.code, "work_order_claim_blocked_by_group_share");
});

Deno.test("crew is live allocations, admins left out", () => {
  const crew = crewByJob([
    { job_id: "a", user_id: "isaac", status: "scheduled" },
    { job_id: "a", user_id: "isaac", status: "complete" },
    { job_id: "a", user_id: "ryan", status: "cancelled" },
    { job_id: "a", user_id: "obs", status: "scheduled", role: "observer" },
    { job_id: "a", user_id: "ghost", status: "scheduled", is_ghost: true },
    { job_id: "a", user_id: "jan", status: "scheduled" },
    { job_id: "a", user_id: "nithin", status: "scheduled" },
  ], new Map([["jan", "admin"], ["nithin", "ops_manager"]]));
  assertEquals(crew.get("a"), ["isaac", "nithin"]);
});

Deno.test("auto group: priced open patio jobs with 2+ crew get a group with the crew on it", async () => {
  const fake = patioWorld();
  const out = await autoGroupPatioJobs(fake.client());
  assertEquals(out.switched_on, true);
  const by = Object.fromEntries(out.results.map((r) => [r.job_id, r]));
  assertEquals(by.a.reason, "group_created");
  assertEquals(by.b.reason, "crew_paid_by_hours_already");
  assertEquals(by.c, undefined); // one live crew
  assertEquals(by.d, undefined); // archived
  assertEquals(by.e, undefined); // fencing
  const groups = fake.rows("group_work_orders");
  assertEquals(groups.length, 1);
  assertEquals(groups[0].pay_basis, "all_in_12_v2");
  assertEquals(groups[0].work_order_id, "wo-a");
  assertEquals(groups[0].created_by, null);
  assertEquals(groups[0].approved_budget_ex, undefined);
  assertEquals(fake.rows("group_work_order_participants").map((p) => p.user_id).sort(), ["isaac", "nithin", "ryan"]);
  assertEquals(fake.rows("job_events").map((e) => e.event_type), ["group_work_order_auto_created"]);

  // Next sweep: nothing new; a crew member allocated later joins.
  const again = await autoGroupPatioJobs(fake.client());
  assertEquals(again.created, 0);
  fake.rows("users").push({ id: "aydan", role: "crew" });
  fake.rows("job_assignments").push({ job_id: "a", user_id: "aydan", status: "scheduled" });
  const topped = await autoGroupPatioJobs(fake.client());
  assertEquals(topped.crew_added, 1);
  assertEquals(fake.rows("group_work_order_participants").length, 4);

  // A frozen group takes nobody new.
  groups[0].split_frozen_at = "2026-11-02T00:00:00Z";
  fake.rows("users").push({ id: "late", role: "crew" });
  fake.rows("job_assignments").push({ job_id: "a", user_id: "late", status: "scheduled" });
  assertEquals((await autoGroupPatioJobs(fake.client())).crew_added, 0);
});

Deno.test("auto group: off switch, and the database fence wins", async () => {
  const off = patioWorld();
  off.rows("feature_flags")[1].enabled = false;
  assertEquals((await autoGroupPatioJobs(off.client())).switched_on, false);
  assertEquals(off.rows("group_work_orders").length, 0);
  assertEquals((await openMissingPatioWorkOrders(off.client())).switched_on, false);
  assertEquals(off.rpcs.length, 0);

  const groupsOff = patioWorld();
  groupsOff.rows("feature_flags")[0].enabled = false;
  assertEquals((await autoGroupPatioJobs(groupsOff.client())).switched_on, false);

  const fenced = patioWorld();
  fenced.failInsert.group_work_orders = { code: "23514", message: "group_open_blocked_by_work_order_claim" };
  const out = await autoGroupPatioJobs(fenced.client());
  assertEquals(out.results.find((r) => r.job_id === "a")?.reason, "crew_paid_by_hours_already");
  assertEquals(fenced.rows("group_work_order_participants").length, 0);
});

Deno.test("missing work orders: open patio jobs with 2+ crew get a draft", async () => {
  const fake = patioWorld();
  fake.rows("jobs").push(
    { id: "f", job_number: "F", type: "patio", status: "scheduled" },
    { id: "g", job_number: "G", type: "patio", status: "scheduled" },
    { id: "h", job_number: "H", type: "patio", status: "quoted" },
  );
  for (const j of ["f", "h"]) {
    fake.rows("job_assignments").push({ job_id: j, user_id: "isaac", status: "scheduled" }, { job_id: j, user_id: "ryan", status: "scheduled" });
  }
  fake.rows("job_assignments").push({ job_id: "g", user_id: "isaac", status: "scheduled" }, { job_id: "g", user_id: "jan", status: "scheduled" });
  const out = await openMissingPatioWorkOrders(fake.client());
  assertEquals(out.results.map((r: any) => r.job_id), ["f"]);
  assertEquals(fake.rpcs, [{ fn: "ensure_job_work_order_draft", args: { p_job_id: "f", p_origin: "backfill" } }]);
});

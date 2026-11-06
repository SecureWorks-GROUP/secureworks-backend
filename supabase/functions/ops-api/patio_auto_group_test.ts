import { assert, assertEquals } from "jsr:@std/assert";
import { findFenceProblem, isNormalWorkOrderPayLine, isOfficeFeeLine } from "./group_work_order.ts";
import {
  autoGroupFenceJobs,
  autoGroupPatioJobs,
  GROUP_WORK_ORDER_AUTO_FENCE_FLAG,
  GROUP_WORK_ORDER_AUTO_PATIO_FLAG,
  labourOutsidePool,
  openMissingFenceWorkOrders,
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
        if (fn === "group_work_order_crew") {
          // Fixture stand-in for SQL; the PostgreSQL contract owns qualification.
          const out = new Map<string, Row>();
          for (const row of fake.rows("job_assignments")) {
            const user = fake.rows("users").find((u) => u.id === row.user_id);
            if (!(args.p_job_ids as string[]).includes(row.job_id) || row.is_ghost === true ||
              row.status === "cancelled" || row.role === "observer" || user?.role === "admin") continue;
            out.set(`${row.job_id}:${row.user_id}`,{job_id:row.job_id,user_id:row.user_id});
          }
          for (const member of fake.rows("group_work_order_participants")) {
            const group = fake.rows("group_work_orders").find((g) => g.id === member.group_id);
            if (group && group.status !== "void" && (args.p_job_ids as string[]).includes(group.job_id)) {
              out.set(`${group.job_id}:${member.user_id}`,{job_id:group.job_id,user_id:member.user_id});
            }
          }
          let bounds: [number, number] | null = null;
          const q: any = {order: () => q, range: (a:number,b:number) => {bounds=[a,b];return q;},
            then: (resolve:any) => {
              const rows=[...out.values()];
              return Promise.resolve({data:bounds?rows.slice(bounds[0],bounds[1]+1):rows,error:null}).then(resolve);
            }};
          return q;
        }
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

Deno.test("patio pay through the group: one crew, or none yet, still gets the group", async () => {
  const fake = patioWorld();
  fake.rows("feature_flags").push({ flag_name: "patio_pay_group_only_v1", enabled: true });
  fake.rows("jobs").push({
    id: "solo-none", org_id: "org", job_number: "SOLO-NONE", type: "patio", status: "scheduled", work_order_id: "wo-solo-none",
  });
  fake.rows("work_orders").push({
    id: "wo-solo-none", job_id: "solo-none", kind: "job", status: "approved", agreed_labour_ex: 2160,
    sealed_content_hash: "h", approved_by: null,
    jobs: { id: "solo-none", org_id: "org", job_number: "SOLO-NONE", type: "patio", status: "scheduled", work_order_id: "wo-solo-none" },
  });
  const out = await autoGroupPatioJobs(fake.client());
  const by = Object.fromEntries(out.results.map((r) => [r.job_id, r]));
  assertEquals(by.c.reason, "group_created");
  assertEquals(by["solo-none"].reason, "group_created");
  assertEquals(by["solo-none"].added, 0);
  const shell = fake.rows("group_work_orders").find((g) => g.job_id === "solo-none");
  assertEquals(shell?.work_order_id, "wo-solo-none");
  assertEquals(fake.rows("group_work_order_participants").filter((p) => p.group_id === shell?.id).length, 0);
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
  assertEquals(fake.rpcs.filter((call) => call.fn !== "group_work_order_crew"), [{ fn: "ensure_job_work_order_draft", args: { p_job_id: "f", p_origin: "backfill" } }]);
});

// ── V8 fence groups (job-profit INBOX 3 Nov 2026), switched off ─────────────
// Fixtures follow live records read 3 Nov 2026 (read only):
// - SWF-261370: Alyx (crew) and Henry (ops_manager, who claims fence work
//   orders himself, so he installs); approved, sealed work order, labour
//   $535.00 = install $385.00 + plinths $150.00; removal $137.50 is counted
//   as materials by the quote, so it is outside labour but not labour the
//   quote prices as labour.
// - SWF-261459: three crew; the fence tool's labour is $0.35 (one panel)
//   while the quote prices $480 + $720 of labour outside it
//   (outside_quote_labour).
// - SWF-26968: the lead billed "Work order $650.00. Less labour: Sonny 3h x
//   $35 ..." (SW-INV-A-261011-029), a fixed-price work-order claim.
// - SW-INV-JC-261030-015 (V1): a solo fence job, hours only.
function fenceWorld(fenceOn: boolean) {
  const fake = new Fake();
  fake.rows("feature_flags").push(
    { flag_name: "group_work_order_v1", enabled: true },
    { flag_name: GROUP_WORK_ORDER_AUTO_PATIO_FLAG, enabled: true },
    { flag_name: GROUP_WORK_ORDER_AUTO_FENCE_FLAG, enabled: fenceOn },
  );
  fake.rows("users").push(
    { id: "alyx", role: "crew" },
    { id: "henry", role: "ops_manager" },
    { id: "sonny", role: "crew" },
    { id: "kim", role: "crew" },
    { id: "isaac", role: "lead_installer" },
    { id: "ryan", role: "crew" },
    { id: "jan", role: "admin" },
  );
  const item = (description: string, basis: string, total: number | null, counted: boolean, flags: string[] = []) =>
    ({ description, basis, total, counted, flags, needs_review: flags.length > 0 && basis !== "removal" });
  const add = (id: string, type: string, labour: number, scope: Row[], crew: string[]) => {
    const j = { id, org_id: "org", job_number: id.toUpperCase(), type, status: "scheduled", work_order_id: `wo-${id}` };
    fake.rows("jobs").push(j);
    fake.rows("work_orders").push({
      id: `wo-${id}`, job_id: id, kind: "job", status: "approved", agreed_labour_ex: labour,
      sealed_content_hash: "h", approved_by: null, scope_items: scope, jobs: j,
    });
    for (const u of crew) fake.rows("job_assignments").push({ job_id: id, user_id: u, status: "scheduled" });
  };
  add("swf-261370", "fencing", 535, [
    item("Install Trimclad fence (5 panels)", "fence_install", 385, true),
    item("Install retaining plinths", "fence_plinths", 150, true),
    item("Remove Hardie fence", "removal", 137.5, false, ["quote_counted_as_materials"]),
  ], ["alyx", "henry", "jan"]);
  add("swf-261459", "fencing", 0.35, [
    item("Install Ridgeside fence (1 panel)", "fence_install", 0.35, true),
    item("Front fence replant 3 posts and reassure fence", "quote_labour_line", 480, false, ["saved_as_material", "outside_quote_labour"]),
    item("Back fence replant post and reassemble fence", "quote_labour_line", 720, false, ["saved_as_material", "outside_quote_labour"]),
    item("Concrete per bag", "quote_extra", null, false, ["labour_or_material_unknown"]),
  ], ["alyx", "henry", "sonny"]);
  add("swf-26968", "fencing", 650, [item("Install Colorbond fence (4 panels)", "fence_install", 650, true)], ["henry", "sonny", "kim"]);
  add("swf-solo", "fencing", 787.5, [item("Install fence", "fence_install", 787.5, true)], ["alyx"]);
  // A patio job in the same world: a priced work order and 2 crew. Its quote
  // has a labour line outside the pool; patio groups as it did before V8.
  add("swp-1", "patio", 2160, [
    item("Labour - 2 trades x 3 days", "quote_labour_line", 2160, true),
    item("Gutter rework", "quote_labour_line", 240, false, ["outside_quote_labour"]),
  ], ["isaac", "ryan"]);
  fake.rows("trade_invoices").push({ id: "inv-a-261011-029", status: "paid" });
  fake.rows("trade_invoice_lines").push({
    job_id: "swf-26968", line_type: "work order", trade_invoice_id: "inv-a-261011-029",
    description: "Work order $650.00.\nLess labour: Sonny 3h x $35 = $105.00\nKim 8h x $30 = $240.00.",
  });
  return fake;
}

Deno.test("labour outside the pool: only a priced line the quote keeps out of its labour", () => {
  // SWF-261459's two custom labour lines.
  assert(labourOutsidePool([
    { basis: "fence_install", total: 0.35, counted: true, flags: [] },
    { basis: "quote_labour_line", total: 480, counted: false, flags: ["saved_as_material", "outside_quote_labour"] },
  ]));
  // SWF-261370: removal counted as materials by the quote is not this case.
  assertEquals(labourOutsidePool([
    { basis: "fence_install", total: 385, counted: true, flags: [] },
    { basis: "removal", total: 137.5, counted: false, flags: ["quote_counted_as_materials"] },
  ]), false);
  // An unpriced line has no labour to lose; no scope or a bad shape is no.
  assertEquals(labourOutsidePool([{ basis: "quote_labour_line", total: null, flags: ["outside_quote_labour"] }]), false);
  assertEquals(labourOutsidePool([{ basis: "quote_labour_line", total: 0, flags: ["outside_quote_labour"] }]), false);
  assertEquals(labourOutsidePool(null), false);
  assertEquals(labourOutsidePool("[]"), false);
  assertEquals(labourOutsidePool([null, 3, { flags: "outside_quote_labour", total: 5 }]), false);
});

Deno.test("fence switch off (as the migration adds it): no fence draft or group; patio exactly as before", async () => {
  const off = fenceWorld(false);
  const fence = await autoGroupFenceJobs(off.client());
  assertEquals(fence, { switched_on: false, created: 0, crew_added: 0, results: [] });
  assertEquals((await openMissingFenceWorkOrders(off.client())).switched_on, false);
  assertEquals(off.rpcs.length, 0);
  // Patio: the one priced patio job with 2 crew is grouped, nothing else.
  const patio = await autoGroupPatioJobs(off.client());
  assertEquals(patio.results.map((r) => [r.job_id, r.reason]), [["swp-1", "group_created"]]);
  assertEquals(off.rows("group_work_orders").map((g) => g.job_id), ["swp-1"]);
  assertEquals(off.rows("group_work_order_participants").map((p) => p.user_id).sort(), ["isaac", "ryan"]);

  // A missing fence flag row reads as off too.
  const missing = fenceWorld(true);
  missing.tables.feature_flags = missing.rows("feature_flags").filter((f) => f.flag_name !== GROUP_WORK_ORDER_AUTO_FENCE_FLAG);
  assertEquals((await autoGroupFenceJobs(missing.client())).switched_on, false);
  assertEquals(missing.rows("group_work_orders").length, 0);
});

Deno.test("fence switch on: 2+ crew on a priced fence work order get a group; named reasons for the rest", async () => {
  const fake = fenceWorld(true);
  const out = await autoGroupFenceJobs(fake.client());
  assertEquals(out.switched_on, true);
  const by = Object.fromEntries(out.results.map((r) => [r.job_id, r]));
  // SWF-261370: Alyx and Henry; the watching admin is left out.
  assertEquals(by["swf-261370"].reason, "group_created");
  assertEquals(by["swf-261370"].crew, 2);
  // SWF-261459: the $0.35 pool would leave $1,200 of quoted labour out.
  assertEquals(by["swf-261459"].reason, "labour_outside_pool");
  // SWF-26968: the lead's fixed-price work-order claim is pay already.
  assertEquals(by["swf-26968"].reason, "crew_paid_by_hours_already");
  assertEquals(by["swf-26968"].code, "group_open_blocked_by_work_order_claim");
  // Solo stays hours only; the patio job is not the fence sweep's.
  assertEquals(by["swf-solo"], undefined);
  assertEquals(by["swp-1"], undefined);
  assertEquals(out.created, 1);

  const groups = fake.rows("group_work_orders");
  assertEquals(groups.length, 1);
  assertEquals(groups[0].job_id, "swf-261370");
  assertEquals(groups[0].work_order_id, "wo-swf-261370"); // pool = the work order's $535.00 labour
  assertEquals(groups[0].pay_basis, "all_in_12_v2");
  assertEquals(groups[0].status, "open");
  assertEquals(fake.rows("group_work_order_participants").map((p) => p.user_id).sort(), ["alyx", "henry"]);
  assertEquals(fake.rows("job_events").map((e) => [e.job_id, e.event_type]), [["swf-261370", "group_work_order_auto_created"]]);

  // Fence switch on does not change the patio sweep's result.
  const patio = await autoGroupPatioJobs(fake.client());
  assertEquals(patio.results.map((r) => [r.job_id, r.reason]), [["swp-1", "group_created"]]);

  // Next fence sweep: nothing new; a crew member allocated later joins.
  assertEquals((await autoGroupFenceJobs(fake.client())).created, 0);
  fake.rows("job_assignments").push({ job_id: "swf-261370", user_id: "sonny", status: "scheduled" });
  const topped = await autoGroupFenceJobs(fake.client());
  assertEquals(topped.results.find((r) => r.job_id === "swf-261370")?.reason, "crew_added");
  assertEquals(fake.rows("group_work_order_participants").filter((p) => p.group_id === groups[0].id).length, 3);
});

Deno.test("fence switch on, patio switch off: fencing only", async () => {
  const fake = fenceWorld(true);
  fake.rows("feature_flags").find((f) => f.flag_name === GROUP_WORK_ORDER_AUTO_PATIO_FLAG)!.enabled = false;
  assertEquals((await autoGroupPatioJobs(fake.client())).switched_on, false);
  await autoGroupFenceJobs(fake.client());
  assertEquals(fake.rows("group_work_orders").map((g) => g.job_id), ["swf-261370"]);
  // The group feature switch still governs both.
  const groupsOff = fenceWorld(true);
  groupsOff.rows("feature_flags")[0].enabled = false;
  assertEquals((await autoGroupFenceJobs(groupsOff.client())).switched_on, false);
  assertEquals(groupsOff.rows("group_work_orders").length, 0);
});

Deno.test("fence missing work orders: open fence jobs with 2+ crew get a draft; patio jobs are not the fence step's", async () => {
  const fake = fenceWorld(true);
  fake.rows("jobs").push(
    { id: "swf-26091", job_number: "SWF-26091", type: "fencing", status: "rectification" },
    { id: "swf-quoted", job_number: "SWF-Q", type: "fencing", status: "quoted" },
    { id: "swf-one", job_number: "SWF-ONE", type: "fencing", status: "scheduled" },
    { id: "swp-new", job_number: "SWP-NEW", type: "patio", status: "scheduled" },
  );
  for (const j of ["swf-26091", "swf-quoted", "swp-new"]) {
    fake.rows("job_assignments").push({ job_id: j, user_id: "alyx", status: "scheduled" }, { job_id: j, user_id: "henry", status: "scheduled" });
  }
  fake.rows("job_assignments").push({ job_id: "swf-one", user_id: "alyx", status: "scheduled" }, { job_id: "swf-one", user_id: "jan", status: "scheduled" });
  const out = await openMissingFenceWorkOrders(fake.client());
  assertEquals(out.results.map((r: any) => r.job_id), ["swf-26091"]);
  assertEquals(fake.rpcs.filter((call) => call.fn !== "group_work_order_crew"), [{ fn: "ensure_job_work_order_draft", args: { p_job_id: (out.results as Array<{job_id:string}>)[0].job_id, p_origin: "backfill" } }]);

  // Off, the same world opens nothing.
  const off = fenceWorld(false);
  off.rows("jobs").push({ id: "swf-26091", job_number: "SWF-26091", type: "fencing", status: "rectification" });
  off.rows("job_assignments").push({ job_id: "swf-26091", user_id: "alyx", status: "scheduled" }, { job_id: "swf-26091", user_id: "henry", status: "scheduled" });
  await openMissingFenceWorkOrders(off.client());
  assertEquals(off.rpcs.length, 0);
});

// Owner, 3 Nov 2026: patio pay goes through the group work order (patio jobs
// after Zoo). What the crew see: hours on a patio job are refused with the
// reason; a patio job already paid by hours finishes on hours; commission and
// the council fee still go through; switched off, nothing changes.
Deno.test("patio pay only through the group: what the crew are told", async () => {
  const { assertPatioPaysThroughGroup } = await import("./group_work_order.ts");
  const world = (flagOn: boolean) => {
    const fake = new Fake();
    fake.rows("feature_flags").push({ flag_name: "patio_pay_group_only_v1", enabled: flagOn });
    fake.rows("jobs").push(
      { id: "p-new", type: "patio" }, { id: "p-grouped", type: "patio" },
      { id: "p-legacy", type: "patio" }, { id: "fence", type: "fencing" },
    );
    fake.rows("group_work_orders").push({ job_id: "p-grouped", status: "open" });
    // A previous ordinary claim alone does not prove earlier scheduling.
    fake.rows("trade_invoice_lines").push({ job_id: "p-legacy", line_type: "labour", description: "Patio install", trade_invoice_id: "old", trade_invoices: { status: "approved" } });
    return fake.client();
  };
  const hours = (job_id: string) => [{ job_id, line_type: "labour", description: "Framing" }];
  const refused = async (client: any, lines: any[]) => {
    try { await assertPatioPaysThroughGroup(client, lines); return null; } catch (e) { return e as any; }
  };
  const noWo = await refused(world(true), hours("p-new"));
  assertEquals(noWo?.code, "patio_pay_group_only");
  assertEquals(noWo?.status, 409);
  assert(String(noWo?.message).includes("office needs to set the job work-order amount first"));
  const grouped = await refused(world(true), hours("p-grouped"));
  assert(String(grouped?.message).includes("Log your hours on the group"));
  assertEquals((await refused(world(true), hours("p-legacy")))?.code, "patio_pay_group_only");
  assertEquals(await refused(world(true), hours("fence")), null);
  assertEquals(await refused(world(true), [{ job_id: "p-new", line_type: "commission", description: "Commission" }]), null);
  assertEquals(await refused(world(true), [{ job_id: "p-new", line_type: "labour", description: "Council Approval" }]), null);
  assertEquals(await refused(world(false), hours("p-new")), null);
  // The office is asked for a work order only when there is none; a failed
  // ask still gives the crew the same refusal.
  const asked: string[] = [];
  const ask = (jobId: string) => (asked.push(jobId), Promise.reject(new Error("graph down")));
  const withAsk = async (lines: any[]) => {
    try { await assertPatioPaysThroughGroup(world(true), lines, null, ask); return null; } catch (e) { return e as any; }
  };
  assertEquals((await withAsk(hours("p-new")))?.code, "patio_pay_group_only");
  assertEquals((await withAsk(hours("p-grouped")))?.code, "patio_pay_group_only");
  assertEquals(asked, ["p-new"]);
});

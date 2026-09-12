// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchCalendar,
  dispatchCommand,
  DispatchError,
  dispatchRun,
  dispatchTrigger,
  emptyState,
  handleDispatch,
  hash,
  readDispatchJob,
} from "./dispatch_workbench.ts";
import { formatPoDeliveryNotes, isPoPickup } from "../_shared/po_reference.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = id(1), job = id(2), otherJob = id(3), poId = id(4), req = id(5);
class Fixture {
  tables: Record<string, any[]> = {
    jobs: [{ id: job, org_id: org }, { id: otherJob, org_id: org }],
    dispatch_plans: [{
      org_id: org,
      job_id: job,
      version: 0,
      state: emptyState(),
    }],
    purchase_orders: [],
    dispatch_supply_lots: [],
    job_documents: [],
    po_communications: [],
    job_media: [],
    current_job_context_facts: [],
    dispatch_commands: [],
    calendar_events: [],
    dispatch_tasks: [],
  };
  commits: any[] = [];
  enqueued: any[] = [];
  from(table: string) {
    return new Query(this, table);
  }
  async rpc(name: string, args: any) {
    if (name === "dispatch_order_reservations") return { data: [] };
    if (name === "dispatch_context_facts_for_source") {
      return {
        data: this.tables.current_job_context_facts.filter((r) =>
          r.job_id === args.p_job
        ).slice(0, args.p_limit),
      };
    }
    if (name === "dispatch_finalize_task") {
      const task = this.tables.dispatch_tasks.find((t) =>
        t.org_id === args.p_org &&
        t.job_id === args.p_job && t.source_version === args.p_source_version &&
        t.plan_version === args.p_plan_version &&
        t.lease_token === args.p_lease_token
      );
      if (!task) return { error: { message: "task_lease_lost" } };
      Object.assign(task, { status: args.p_status, result: args.p_result });
      return { data: task };
    }
    if (name === "dispatch_source_version") {
      return {
        data: await hash({
          po: this.tables.purchase_orders,
          lots: this.tables.dispatch_supply_lots,
          context: this.tables.current_job_context_facts,
        }),
      };
    }
    if (name === "dispatch_claim_tasks") {
      return {
        data: this.tables.dispatch_tasks.filter((t) =>
          t.org_id === args.p_org && t.status === "running"
        ).slice(0, args.p_limit),
      };
    }
    if (
      name === "dispatch_enqueue_job" ||
      name === "dispatch_reconcile_eligible_jobs"
    ) {
      this.enqueued.push({ name, ...args });
      return {
        data: { queued: true, job_id: args.p_job, count: args.p_limit },
      };
    }
    if (name !== "dispatch_commit") throw Error(`Unexpected RPC ${name}`);
    this.commits.push(structuredClone(args));
    this.tables.dispatch_plans[0] = {
      org_id: org,
      job_id: job,
      state: args.p_state,
      version: args.p_expected + 1,
    };
    for (const lot of args.p_lots) {
      this.tables.dispatch_supply_lots = this.tables.dispatch_supply_lots
        .filter((l) => l.id !== lot.id);
      this.tables.dispatch_supply_lots.push({ ...lot, org_id: org });
    }
    if (args.p_command === "order_prepare") {
      const draft = args.p_state.order_drafts.find((o: any) =>
        o.id === args.p_state.prepared_order_id
      );
      this.tables.purchase_orders.push({
        ...draft,
        job_id: job,
        org_id: org,
        notes: draft.po_notes,
      });
    }
    return { data: { version: args.p_expected + 1 } };
  }
}
class Query {
  filters: ((r: any) => boolean)[] = [];
  take = 1000;
  single = false;
  patch: any;
  constructor(private db: Fixture, private table: string) {}
  update(patch: any) {
    this.patch = patch;
    return this;
  }
  select(_columns?: string) {
    return this;
  }
  eq(key: string, value: any) {
    this.filters.push((r) =>
      key === "jobs.org_id"
        ? this.db.tables.jobs.some((j) =>
          j.id === r.job_id && j.org_id === value
        )
        : r[key] === value
    );
    return this;
  }
  in(key: string, values: any[]) {
    this.filters.push((r) => values.includes(r[key]));
    return this;
  }
  neq(key: string, value: any) {
    this.filters.push((r) => r[key] !== value);
    return this;
  }
  lte(key: string, value: any) {
    this.filters.push((r) => r[key] <= value);
    return this;
  }
  or(_filter: string) {
    return this;
  }
  order(_key: string) {
    return this;
  }
  limit(value: number) {
    this.take = Math.min(1000, value);
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  then(resolve: (r: any) => any) {
    if (this.patch) {
      for (
        const row of this.db.tables[this.table].filter((r) =>
          this.filters.every((fn) => fn(r))
        )
      ) Object.assign(row, this.patch);
    }
    const rows = this.db.tables[this.table].filter((r) =>
      this.filters.every((fn) => fn(r))
    )
      .slice(0, this.take).map((r) => ({
        ...structuredClone(r),
        jobs: this.db.tables.jobs.find((j) => j.id === r.job_id),
      }));
    return Promise.resolve(
      resolve({ data: this.single ? rows[0] || null : rows }),
    );
  }
}
async function command(db: Fixture, name: string, payload: any) {
  const current = await readDispatchJob(db, org, job);
  return dispatchCommand(db, org, "operator", {
    job_id: job,
    expected_version: current.version,
    source_version: current.source_version,
    request_id: crypto.randomUUID(),
    command: name,
    payload,
  });
}
async function reviewedState(db: Fixture) {
  await command(db, "requirement_upsert", {
    id: req,
    description: "Sheets",
    quantity: 10,
    unit: "each",
    specification: "Reviewed profile",
  });
  await command(db, "requirement_review", { id: req });
}

Deno.test("owner-deleted or changed PO drafts no longer consume cached preparation coverage", async () => {
  for (const fate of ["deleted", "cancelled", "missing", "reduced"]) {
    const db = new Fixture();
    await reviewedState(db);
    const order = {
      id: poId,
      requirement_ids: [req],
      supplier_name: "Fixture supplier",
      delivery_address: "12 Fixture Road",
      notes: "Gate access",
      existing_supply_reviewed: true,
    };
    await command(db, "order_prepare", order);
    assertEquals(
      db.tables.purchase_orders[0].notes,
      formatPoDeliveryNotes(order.delivery_address, order.notes),
    );
    assertEquals(isPoPickup(db.tables.purchase_orders[0].notes), false);
    assertEquals(
      (await readDispatchJob(db, org, job)).purchase_orders[0].delivery_address,
      order.delivery_address,
    );
    if (fate === "missing") db.tables.purchase_orders = [];
    else if (fate === "reduced") {
      db.tables.purchase_orders[0].line_items[0].quantity = 3;
    } else db.tables.purchase_orders[0].status = fate;
    await command(db, "requirement_review", { id: req });
    const result = await command(db, "order_prepare", { ...order, id: id(9) });
    assertEquals(
      result.order_drafts.find((o: any) => o.id === id(9)).line_items[0]
        .quantity,
      fate === "reduced" ? 7 : 10,
    );
  }
});

Deno.test("assessment reconciles externally owned PO status, line revisions and tenant isolation", async () => {
  const db = new Fixture();
  await reviewedState(db);
  const line = { quantity: 10, description: "Sheets", unit: "each" };
  db.tables.purchase_orders = [{
    id: poId,
    org_id: org,
    job_id: otherJob,
    status: "confirmed",
    line_items: [line],
  }];
  db.tables.dispatch_supply_lots = [{
    org_id: org,
    id: `po:${poId}:0`,
    quantity: 10,
    unit: "each",
    source_version: await hash(line),
    source_ref: {
      kind: "purchase_order_line",
      po_id: poId,
      index: 0,
      po_lines: [line],
    },
  }];
  db.tables.dispatch_plans[0].state.allocations = [{
    id: id(8),
    requirement_id: req,
    supply_id: `po:${poId}:0`,
    quantity: 10,
    unit: "each",
  }];
  assertEquals(
    (await readDispatchJob(db, org, job)).allocations[0].supply_valid,
    true,
  );
  const original = structuredClone(db.tables.purchase_orders[0]);
  for (
    const mutate of [
      (p: any) => p.status = "cancelled",
      (p: any) => p.line_items[0].quantity = 4,
      (p: any) => p.line_items[0].description = "Different sheet",
      (p: any) => p.org_id = id(99),
    ]
  ) {
    db.tables.purchase_orders[0] = structuredClone(original);
    mutate(db.tables.purchase_orders[0]);
    const current = await readDispatchJob(db, org, job);
    assertEquals(current.allocations[0].supply_valid, false);
    const result = await command(db, "assess", {});
    assert(
      result.assessment.obligations.some((o: any) =>
        o.code === "supply_gap" && o.quantity === 10
      ),
    );
    assert(
      result.assessment.obligations.some((o: any) =>
        o.code === "supply_reconciliation"
      ),
    );
    assertEquals(result.assessment.ready, false);
  }
  assertEquals(db.tables.dispatch_plans[0].state.allocations.length, 1);
});

Deno.test("truncated calendar, job and context reads fail closed beneath the REST cap", async () => {
  for (
    const table of [
      "purchase_orders",
      "job_documents",
      "po_communications",
      "job_media",
      "current_job_context_facts",
    ]
  ) {
    const db = new Fixture();
    db.tables[table] = Array.from(
      { length: 1005 },
      (_, n) => ({
        id: id(n + 100),
        job_id: job,
        org_id: org,
        kind: "instruction",
        status: "draft",
        line_items: [],
        delivery_date: "2026-09-14",
      }),
    );
    const current = await readDispatchJob(db, org, job);
    if (table === "current_job_context_facts") {
      assertEquals(current.coverage.context.complete, false);
    } else assertEquals(current.coverage.complete, false);
    await assertRejects(
      () => command(db, "assess", {}),
      DispatchError,
      "coverage incomplete",
    );
    assertEquals(db.commits.length, 0);
    if (table === "purchase_orders") {
      const calendar = await dispatchCalendar(
        db,
        org,
        new URLSearchParams({ from: "2026-09-01", to: "2026-09-30" }),
      );
      assertEquals(calendar.coverage.complete, false);
      assert(calendar.events.length < 1000);
    }
  }
});

Deno.test("correcting unreserved stock to zero persists the empty count", async () => {
  const db = new Fixture();
  const stock = {
    id: id(7),
    description: "Sheets",
    quantity: 10,
    unit: "each",
    location: "yard",
    evidence: "Physical count",
  };
  await command(db, "stock_record", stock);
  await command(db, "stock_record", {
    ...stock,
    quantity: 0,
    evidence: "Rack empty",
  });
  assertEquals(db.tables.dispatch_supply_lots[0].quantity, 0);
  assertEquals(db.commits[1].p_lots[0].quantity, 0);
});

Deno.test("automatic trigger uses durable reconciliation and validates its bounded window", async () => {
  const db = new Fixture();
  await dispatchTrigger(db, org, {});
  assertEquals(db.enqueued, [{
    name: "dispatch_reconcile_eligible_jobs",
    p_org: org,
    p_limit: 25,
  }]);
  for (const limit of [0, 26, "25", 1.5]) {
    await assertRejects(
      () => dispatchTrigger(db, org, { limit }),
      DispatchError,
    );
  }
  await dispatchTrigger(db, org, { job_ids: [job] });
  assertEquals(db.enqueued[1], {
    name: "dispatch_enqueue_job",
    p_org: org,
    p_job: job,
    p_reason: "manual",
  });
});

Deno.test("worker durably distinguishes assessed, superseded and failed jobs", async () => {
  for (const fate of ["assessed", "superseded", "failed"]) {
    const db = new Fixture();
    if (fate === "failed") {
      db.tables.job_documents = Array.from(
        { length: 1005 },
        (_, n) => ({ id: id(100 + n), job_id: job }),
      );
    }
    const current = await readDispatchJob(db, org, job);
    db.tables.dispatch_tasks.push({
      org_id: org,
      job_id: job,
      source_version: fate === "superseded" ? "old" : current.source_version,
      plan_version: current.version,
      lease_token: id(90),
      status: "running",
    });
    const result = await dispatchRun(db, org, "worker");
    assertEquals(result.results[0].status, fate);
    assertEquals(db.tables.dispatch_tasks[0].result.status, fate);
    if (fate === "assessed") {
      assertEquals(
        db.tables.dispatch_tasks[0].result.assessment.source_version,
        current.source_version,
      );
    }
    if (fate === "superseded") assertEquals(db.enqueued[0].p_job, job);
    if (fate === "failed") assertEquals(db.commits.length, 0);
  }
});

Deno.test("task status and explicit retry use bounded tenant and actor coordinates", async () => {
  const calls: any[] = [];
  const db = {
    rpc: (name: string, args: any) => {
      calls.push({ name, args });
      return Promise.resolve({
        data: { items: [], live_actions_enabled: false },
      });
    },
  };
  const invoke = (
    action: string,
    method: string,
    params = new URLSearchParams(),
    body: any = {},
  ) =>
    Promise.resolve().then(() =>
      handleDispatch(db, org, "operator", action, method, params, body)
    );
  await invoke(
    "dispatch_tasks",
    "GET",
    new URLSearchParams({ status: "exhausted", limit: "10", offset: "20" }),
  );
  assertEquals(calls[0], {
    name: "dispatch_list_tasks",
    args: { p_org: org, p_status: "exhausted", p_limit: 10, p_offset: 20 },
  });
  for (
    const params of [{ limit: "101" }, { offset: "-1" }, { status: "all" }]
  ) {
    await assertRejects(() =>
      invoke(
        "dispatch_tasks",
        "GET",
        new URLSearchParams(params as Record<string, string>),
      ), DispatchError);
  }
  const request = id(81);
  await invoke("dispatch_retry_task", "POST", undefined, {
    job_id: job,
    request_id: request,
    source_version: "source",
    plan_version: 4,
    reason: "Source corrected",
    actor: "spoofed",
    org_id: id(98),
  });
  assertEquals(calls[1], {
    name: "dispatch_retry_task",
    args: {
      p_org: org,
      p_job: job,
      p_request: request,
      p_source_version: "source",
      p_plan_version: 4,
      p_actor: "operator",
      p_reason: "Source corrected",
    },
  });
  for (
    const body of [{ job_id: job, reason: "Missing request" }, {
      job_id: job,
      request_id: request,
      reason: "Partial coordinate",
      source_version: "source",
    }]
  ) {
    await assertRejects(
      () => invoke("dispatch_retry_task", "POST", undefined, body),
      DispatchError,
    );
  }
  await assertRejects(
    () => invoke("dispatch_retry_task", "GET"),
    DispatchError,
  );
  assertEquals(calls.length, 2);
});

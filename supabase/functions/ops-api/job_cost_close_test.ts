import { assertEquals } from "jsr:@std/assert@1";
import {
  costCloseFromRow,
  readJobCostClose,
  readJobCostCloseMany,
} from "./job_cost_close.ts";

const JOB = "a1000000-0000-4000-8000-000000000001";
const OTHER = "a1000000-0000-4000-8000-000000000002";

function row(over: Record<string, unknown> = {}) {
  return {
    job_id: JOB,
    org_id: "00000000-0000-0000-0000-000000000001",
    job_number: "SWF-1",
    cost_state: "final",
    cost_final: true,
    final_on: "2026-10-03",
    closed_by: "rule:cost-close-v1",
    finished: true,
    finished_on: "2026-08-30",
    finished_basis: "work_done",
    last_cost_on: "2026-09-03",
    waiting_on: [],
    actual_cost_ex: 1100,
    all_costs_paid: true,
    quiet_days: 30,
    as_of: "2026-11-15",
    rule: "cost-close-v1",
    ...over,
  };
}

function client(answer: (args: any) => { data: unknown; error: { message: string } | null }) {
  const seen: unknown[] = [];
  return {
    seen,
    rpc(fn: string, args: unknown) {
      seen.push([fn, args]);
      return Promise.resolve(answer(args));
    },
  };
}

Deno.test("cost close: one job's row comes back as the engine published it, without a money figure", async () => {
  const c = client(() => ({ data: [row()], error: null }));
  const out = await readJobCostClose(c, JOB);
  assertEquals(out, {
    ok: true,
    cost_state: "final",
    cost_final: true,
    final_on: "2026-10-03",
    closed_by: "rule:cost-close-v1",
    finished: true,
    finished_on: "2026-08-30",
    finished_basis: "work_done",
    last_cost_on: "2026-09-03",
    waiting_on: [],
    all_costs_paid: true,
    quiet_days: 30,
    as_of: "2026-11-15",
    rule: "cost-close-v1",
  });
  assertEquals(c.seen, [["job_cost_close", { p_job_ids: [JOB] }]]);
});

Deno.test("cost close: a waiting job names what it is waiting on", async () => {
  const c = client(() => ({
    data: [row({
      cost_state: "waiting", cost_final: false, final_on: null, closed_by: null,
      waiting_on: ["no_labour_linked", "work_done_no_labour_overdue"],
    })],
    error: null,
  }));
  const out = await readJobCostClose(c, JOB) as any;
  assertEquals(out.ok, true);
  assertEquals(out.cost_state, "waiting");
  assertEquals(out.cost_final, false);
  assertEquals(out.final_on, null);
  assertEquals(out.waiting_on, ["no_labour_linked", "work_done_no_labour_overdue"]);
});

Deno.test("cost close: a failed read, no row or a wrong shape is unknown, never open and never final", async () => {
  const failed = await readJobCostClose(client(() => ({ data: null, error: { message: "timeout" } })), JOB);
  assertEquals(failed, { ok: false, reason: "cost close read failed: timeout" });

  const nothing = await readJobCostClose(client(() => ({ data: { status: "provisional" }, error: null })), JOB);
  assertEquals(nothing, { ok: false, reason: "cost close read returned nothing" });

  const noRow = await readJobCostClose(client(() => ({ data: [row({ job_id: OTHER })], error: null })), JOB);
  assertEquals(noRow, { ok: false, reason: "the engine has no cost close row for this job" });

  const noRpc = await readJobCostClose({}, JOB);
  assertEquals(noRpc, { ok: false, reason: "cost close is not readable here" });

  const thrown = await readJobCostClose({ rpc: () => Promise.reject(new Error("socket closed")) }, JOB);
  assertEquals(thrown, { ok: false, reason: "cost close read failed: socket closed" });

  for (
    const bad of [
      row({ cost_state: "closed" }),
      row({ cost_state: "final", cost_final: false }),
      row({ cost_state: "settling", cost_final: true }),
      row({ cost_state: "final", final_on: null }),
      row({ cost_state: "final", closed_by: null }),
    ]
  ) {
    assertEquals(costCloseFromRow(bad), null);
    const out = await readJobCostClose(client(() => ({ data: [bad], error: null })), JOB);
    assertEquals(out.ok, false);
  }
});

Deno.test("cost close: a page of jobs is keyed by job, and a job the engine did not answer is left out", async () => {
  const c = client(() => ({
    data: [
      row(),
      row({ job_id: OTHER, cost_state: "open", cost_final: false, final_on: null, closed_by: null, finished: false }),
      row({ job_id: "a1000000-0000-4000-8000-000000000009" }),
      row({ job_id: "a1000000-0000-4000-8000-000000000003", cost_state: "nonsense" }),
    ],
    error: null,
  }));
  const third = "a1000000-0000-4000-8000-000000000003";
  const out = await readJobCostCloseMany(c, [JOB, OTHER, JOB, third, "", undefined as unknown as string]) as any;
  assertEquals(out.ok, true);
  assertEquals(Object.keys(out.by_job).sort(), [JOB, OTHER]);
  assertEquals(out.by_job[OTHER].cost_state, "open");
  assertEquals(c.seen, [["job_cost_close", { p_job_ids: [JOB, OTHER, third] }]]);

  const empty = client(() => ({ data: [], error: null }));
  assertEquals(await readJobCostCloseMany(empty, []), { ok: true, by_job: {} });
  assertEquals(empty.seen, [], "no jobs on the page: nothing is asked");

  const failed = await readJobCostCloseMany(client(() => ({ data: null, error: { message: "timeout" } })), [JOB]);
  assertEquals(failed, { ok: false, reason: "cost close read failed: timeout" });
});

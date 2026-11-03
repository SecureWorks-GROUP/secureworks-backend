import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  placeRecentInvoiceEvidence,
  XERO_EVIDENCE_PLACE_FLAG,
} from "./invoice_evidence_place.ts";

const JOB = "a0000000-0000-4000-8000-000000000001";
const OTHER = "a0000000-0000-4000-8000-000000000002";
const INV = "b0000000-0000-4000-8000-000000000001";

type Call = { name: string; args: Record<string, unknown> };

function fakeClient(opts: {
  flag?: boolean | "error";
  lane?: boolean;
  dry?: Record<string, unknown> | null;
  failTable?: string;
  jobs?: unknown[];
}) {
  const calls: Call[] = [];
  const tables: Record<string, unknown[]> = {
    jobs: opts.jobs ?? [
      { id: JOB, job_number: "SWMS-1", type: "makesafe", metadata: {} },
      { id: OTHER, job_number: "SWF-2", type: "fencing", metadata: {} },
    ],
    makesafe_job_details: [{ job_id: JOB, external_ref: "MLB-26344" }],
    xero_invoices: [{ id: INV, invoice_number: "INV-1", reference: "MLB-26344", status: "PAID", invoice_type: "ACCREC", job_id: null }],
  };
  const client = {
    calls,
    from(table: string) {
      if (table === "feature_flags") {
        return {
          select: () => ({
            eq: (_c: string, name: string) => ({
              limit: () =>
                Promise.resolve(
                  opts.flag === "error"
                    ? { data: null, error: { message: "boom" } }
                    : { data: name === XERO_EVIDENCE_PLACE_FLAG && opts.flag ? [{ enabled: true }] : [], error: null },
                ),
            }),
          }),
        };
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        eq: () => q,
        is: () => q,
        order: () => q,
        range: (from: number, to: number) =>
          Promise.resolve(
            opts.failTable === table
              ? { data: null, error: { message: "read failed" } }
              : { data: (tables[table] ?? []).slice(from, to + 1), error: null },
          ),
      };
      return q;
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "automation_lane_enabled") return Promise.resolve({ data: opts.lane ?? true, error: null });
      if (name === "context_xero_evidence_place") {
        if (args.p_dry_run) return Promise.resolve({ data: opts.dry ?? null, error: opts.dry ? null : { message: "x" } });
        return Promise.resolve({
          data: { by_class: { reference_unique: 1 }, written: { placed: 1, queued_with_candidates: 0, skipped_busy: 0, changed_meanwhile: 0 } },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: "unexpected rpc " + name } });
    },
  };
  return client;
}

const NOW = new Date("2026-10-05T00:00:00Z");

// B3 (3 Nov 2026): INV-1688's payment of 28 Oct was recorded while the invoice had no job; the
// invoice was linked at 11:34Z and the payment stayed on no job, because the flag was off and
// nothing ran. Rows whose invoice now has a job follow it whatever the flag says.
Deno.test("flag off (or unreadable): rows whose invoice has a job follow it; nothing is matched, guessed or queued", async () => {
  for (const flag of [false, "error"] as const) {
    const sb = fakeClient({ flag, failTable: "jobs", dry: { to_write: 5, unlinked_invoices: [INV], by_class: { invoice_job: 2, reference_unique: 1, review_candidates: 2 } } });
    const result = await placeRecentInvoiceEvidence(sb, NOW);
    assertEquals(result.ran && result.mode, "own_job");
    const place = sb.calls.filter((c) => c.name === "context_xero_evidence_place");
    assertEquals(place.map((c) => c.args.p_dry_run), [true, false]);
    // An empty plan: the SQL can then place only rows whose invoice has its own job.
    assertEquals(place[1].args.p_plan, { matches: [], candidates: [] });
    assertEquals(place[1].args.p_since, "2026-09-21T00:00:00.000Z");
    assertEquals(result.ran && result.plan, { matches: 0, candidates: 0 }, "the matcher's inputs were never read");
  }
});

Deno.test("flag off: no row whose invoice has a job means only the dry run", async () => {
  const sb = fakeClient({ flag: false, dry: { to_write: 1, unlinked_invoices: [INV], by_class: { no_candidate: 1, review_candidates: 1 } } });
  const result = await placeRecentInvoiceEvidence(sb, NOW);
  assertEquals([result.ran, result.ran && result.mode, result.ran && result.written], [true, "own_job", null]);
  assertEquals(sb.calls.filter((c) => c.name === "context_xero_evidence_place").map((c) => c.args.p_dry_run), [true]);
});

Deno.test("attribution lane off: nothing written, flag on or off", async () => {
  for (const flag of [true, false]) {
    const sb = fakeClient({ flag, lane: false, dry: { to_write: 3, unlinked_invoices: [], by_class: { invoice_job: 3 } } });
    assertEquals(await placeRecentInvoiceEvidence(sb, NOW), { ran: false, reason: "attribution_lane_off" });
    assertEquals(sb.calls.filter((c) => c.name === "context_xero_evidence_place").length, 0);
  }
});

Deno.test("nothing to place: only the dry run is called", async () => {
  const sb = fakeClient({ flag: true, dry: { to_write: 0, unlinked_invoices: [], by_class: {} } });
  const result = await placeRecentInvoiceEvidence(sb, NOW);
  assertEquals(result.ran, true);
  const place = sb.calls.filter((c) => c.name === "context_xero_evidence_place");
  assertEquals(place.length, 1);
  assertEquals(place[0].args.p_dry_run, true);
  assertEquals(place[0].args.p_since, "2026-09-21T00:00:00.000Z");
});

Deno.test("an unlinked invoice gets the matcher's plan, then one real call", async () => {
  const sb = fakeClient({ flag: true, dry: { to_write: 0, unlinked_invoices: [INV], by_class: { no_candidate: 1 } } });
  const result = await placeRecentInvoiceEvidence(sb, NOW);
  assertEquals(result.ran && result.mode, "full");
  const place = sb.calls.filter((c) => c.name === "context_xero_evidence_place");
  assertEquals(place.length, 2);
  assertEquals(place[1].args.p_dry_run, false);
  assertEquals(place[1].args.p_plan, {
    matches: [{ invoice_id: INV, job_id: JOB, digits: ["26344"] }],
    candidates: [],
  });
  assertEquals(result.ran && result.plan, { matches: 1, candidates: 0 });
});

Deno.test("a failed read of the job population writes nothing", async () => {
  for (const failTable of ["jobs", "makesafe_job_details", "xero_invoices"]) {
    const sb = fakeClient({ flag: true, failTable, dry: { to_write: 2, unlinked_invoices: [INV], by_class: {} } });
    assertEquals(await placeRecentInvoiceEvidence(sb, NOW), { ran: false, reason: "matcher_inputs_unreadable" });
    assertEquals(sb.calls.filter((c) => c.name === "context_xero_evidence_place" && c.args.p_dry_run === false).length, 0);
  }
});

Deno.test("rows whose invoice has a job are placed without loading the matcher inputs", async () => {
  const sb = fakeClient({ flag: true, failTable: "jobs", dry: { to_write: 3, unlinked_invoices: [], by_class: { invoice_job: 3 } } });
  const result = await placeRecentInvoiceEvidence(sb, NOW);
  assertEquals(result.ran, true);
  const real = sb.calls.find((c) => c.name === "context_xero_evidence_place" && c.args.p_dry_run === false);
  assertEquals(real?.args.p_plan, { matches: [], candidates: [] });
});

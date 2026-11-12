import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveRestorationStage,
  presentRestorationStage,
  restorationAutoAdvanceTarget,
  type RestorationStageFacts,
  restorationStageRefusal,
} from "./restoration_stage.ts";
import {
  advanceRestorationStageAfter,
  restorationBoardAction,
  setRestorationStageAction,
} from "./restoration_stage_store.ts";
import { RestorationWorkflowError } from "./restoration_workflow.ts";

function facts(over: Partial<RestorationStageFacts> = {}): RestorationStageFacts {
  return {
    job_status: "processing",
    mode: "do_and_charge",
    phase: "attend_and_charge",
    stored: undefined,
    live_assignments: 0,
    report_received: false,
    invoices: [],
    ...over,
  };
}

const AUTH = { invoice_number: "INV-1", status: "AUTHORISED", total: 968, amount_due: 968 };
const PAID = { invoice_number: "INV-1", status: "PAID", total: 968, amount_due: 0 };
const DRAFT = { invoice_number: "INV-2", status: "DRAFT", total: 100, amount_due: 100 };

Deno.test("restoration stage: derived from the job's own facts, in order", () => {
  assertEquals(deriveRestorationStage(facts()), "new");
  assertEquals(deriveRestorationStage(facts({ live_assignments: 2 })), "booked");
  assertEquals(deriveRestorationStage(facts({ live_assignments: 2, report_received: true })), "report_due");
  assertEquals(deriveRestorationStage(facts({ report_received: true, invoices: [AUTH] })), "invoiced");
  assertEquals(deriveRestorationStage(facts({ invoices: [PAID] })), "closed");
  assertEquals(deriveRestorationStage(facts({ job_status: "complete" })), "closed");
  // Assess and quote: the quote decides, even with an assessment fee invoiced.
  const quoting = { mode: "assess_and_quote", report_received: true, invoices: [AUTH] };
  assertEquals(deriveRestorationStage(facts({ ...quoting, phase: "quote_drafted" })), "report_due");
  assertEquals(deriveRestorationStage(facts({ ...quoting, phase: "awaiting_approval" })), "quote_with_builder");
  assertEquals(deriveRestorationStage(facts({ ...quoting, phase: "approved_works" })), "works");
});

Deno.test("restoration stage: a stored stage wins; a paid invoiced card shows closed", () => {
  const stored = { stage: "works", set_at: "2026-11-12T00:00:00Z", set_by: "owner" };
  const shown = presentRestorationStage(facts({ stored }));
  assertEquals([shown.stage, shown.source], ["works", "set"]);
  const paid = presentRestorationStage(facts({ stored: { stage: "invoiced" }, invoices: [PAID] }));
  assertEquals([paid.stage, paid.source], ["closed", "paid"]);
  const unpaid = presentRestorationStage(facts({ stored: { stage: "invoiced" }, invoices: [AUTH] }));
  assertEquals(unpaid.stage, "invoiced");
  const junk = presentRestorationStage(facts({ stored: { stage: "nonsense" }, live_assignments: 1 }));
  assertEquals([junk.stage, junk.source], ["booked", "derived"]);
});

Deno.test("restoration stage: a stage that claims something needs it on record", () => {
  assertEquals(restorationStageRefusal("quote_with_builder", facts())?.code, "restoration_stage_no_quote_stage");
  assertEquals(
    restorationStageRefusal("quote_with_builder", facts({ mode: "assess_and_quote", phase: "quote_drafted" }))?.code,
    "restoration_stage_quote_not_sent",
  );
  assertEquals(
    restorationStageRefusal("works", facts({ mode: "assess_and_quote", phase: "awaiting_approval" }))?.code,
    "restoration_stage_quote_not_approved",
  );
  assertEquals(restorationStageRefusal("works", facts()), null);
  assertEquals(restorationStageRefusal("invoiced", facts())?.code, "restoration_stage_no_invoice");
  assertEquals(restorationStageRefusal("closed", facts())?.code, "restoration_stage_close_without_invoice");
  assertEquals(restorationStageRefusal("closed", facts(), { no_charge_reason: "Builder cancelled" }), null);
  assertEquals(
    restorationStageRefusal("closed", facts({ invoices: [AUTH, DRAFT] }))?.code,
    "restoration_stage_close_with_draft",
  );
  assertEquals(restorationStageRefusal("closed", facts({ invoices: [AUTH] })), null);
  // Moving back is always allowed.
  assertEquals(restorationStageRefusal("booked", facts({ invoices: [AUTH] })), null);
});

Deno.test("restoration stage: actions move the card forward only, never past a pending quote", () => {
  const quoting = facts({ mode: "assess_and_quote", phase: "awaiting_approval", invoices: [AUTH] });
  assertEquals(restorationAutoAdvanceTarget("quote_sent", "report_due", quoting), "quote_with_builder");
  // The assessment fee going out while the quote is with the builder moves nothing.
  assertEquals(restorationAutoAdvanceTarget("invoice_sent", "quote_with_builder", quoting), null);
  const approved = facts({ mode: "assess_and_quote", phase: "approved_works", invoices: [AUTH] });
  assertEquals(restorationAutoAdvanceTarget("quote_approved", "quote_with_builder", approved), "works");
  assertEquals(restorationAutoAdvanceTarget("invoice_sent", "works", approved), "invoiced");
  const doCharge = facts({ invoices: [AUTH] });
  assertEquals(restorationAutoAdvanceTarget("invoice_sent", "report_due", doCharge), "invoiced");
  // Never backwards.
  assertEquals(restorationAutoAdvanceTarget("quote_sent", "works", quoting), null);
  assertEquals(restorationAutoAdvanceTarget("invoice_sent", "closed", doCharge), null);
});

// ── Store, against a small in-memory client ──────────────────────────────────

const JOB_ID = "d1deeaac-3733-4a99-b906-f14e23cce3fe";

function makeClient(over: { invoices?: any[]; metadata?: any; assignments?: any[] } = {}) {
  const tables: Record<string, any[]> = {
    jobs: [{
      id: JOB_ID,
      org_id: null,
      job_number: "SWRESTO-261718",
      type: "makesafe",
      status: "processing",
      client_name: "Client",
      site_address: "12 Midsummer Cir",
      site_suburb: "Pinjarra",
      notes: "",
      metadata: { makesafe_job_family: "restoration", ...(over.metadata || {}) },
      created_at: "2026-11-12T01:00:00Z",
      updated_at: "2026-11-12T01:00:00Z",
    }],
    makesafe_job_details: [{
      job_id: JOB_ID,
      external_ref: "MLB-41225",
      requesting_company_id: "co-1",
      requesting_company_name: "mlb",
      requesting_company_slug: "mlb",
      special_instructions: null,
      report_received_at: "2026-11-12T06:00:00Z",
    }],
    makesafe_companies: [{ id: "co-1", name: "ML Builders" }],
    job_assignments: over.assignments ?? [
      { job_id: JOB_ID, user_id: "u1", status: "complete", role: "lead_installer", is_ghost: false, scheduled_date: "2026-11-12" },
      { job_id: JOB_ID, user_id: "u9", status: "complete", role: "observer", is_ghost: true, scheduled_date: "2026-11-12" },
    ],
    users: [{ id: "u1", name: "Jean Crous" }],
    xero_invoices: over.invoices ?? [
      { job_id: JOB_ID, xero_invoice_id: "x1", invoice_number: "INV-1890", invoice_type: "ACCREC", status: "AUTHORISED", total: 968, amount_due: 968 },
    ],
    job_events: [],
  };
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let update: any = null;
    let insert: any = null;
    const rows = () => (tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), chain),
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (u: any) => ((update = u), chain),
      insert: (row: any) => {
        insert = row;
        tables[table].push(row);
        return Promise.resolve({ error: null });
      },
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (resolve: any) => {
        if (update) {
          const hit = rows();
          for (const r of hit) Object.assign(r, update, { updated_at: "2026-11-12T02:00:00Z" });
          return resolve({ data: hit, error: null });
        }
        void insert;
        return resolve({ data: rows(), error: null });
      },
    };
    return chain;
  }
  return { client: { from }, tables };
}

const CALLER = { label: "owner@example.test", userId: null, orgId: null };

Deno.test("restoration board: a do-and-charge card with its invoice out reads Invoiced", async () => {
  const { client } = makeClient();
  const board = await restorationBoardAction(client, {}, CALLER);
  const cards = board.cards as any[];
  assertEquals(cards.length, 1);
  assertEquals(cards[0].stage, "invoiced");
  assertEquals(cards[0].builder, "ML Builders");
  assertEquals(cards[0].crew.map((c: any) => c.name), ["Jean Crous"]);
  assertEquals((board.columns as any[]).find((c) => c.key === "invoiced").count, 1);
});

Deno.test("restoration set stage: closes with its invoice, writes job status and an event", async () => {
  const { client, tables } = makeClient();
  const result = await setRestorationStageAction(client, { job_id: JOB_ID, stage: "closed" }, CALLER);
  assertEquals((result.card as any).stage, "closed");
  assertEquals(tables.jobs[0].status, "complete");
  assertEquals(tables.jobs[0].metadata.restoration_stage.stage, "closed");
  assertEquals(tables.jobs[0].metadata.makesafe_job_family, "restoration");
  assert(tables.job_events.some((e) => e.event_type === "restoration_stage_changed"));
});

Deno.test("restoration set stage: refuses to close with nothing invoiced, and an unknown stage", async () => {
  const { client } = makeClient({ invoices: [] });
  const err = await assertRejects(
    () => setRestorationStageAction(client, { job_id: JOB_ID, stage: "closed" }, CALLER),
    RestorationWorkflowError,
  );
  assertEquals(err.code, "restoration_stage_close_without_invoice");
  const bad = await assertRejects(
    () => setRestorationStageAction(client, { job_id: JOB_ID, stage: "done" }, CALLER),
    RestorationWorkflowError,
  );
  assertEquals(bad.code, "restoration_stage_invalid");
});

Deno.test("restoration advance: an invoice sent moves a booked do-and-charge card to Invoiced", async () => {
  const { client, tables } = makeClient({ metadata: { restoration_stage: { stage: "booked" } } });
  const moved = await advanceRestorationStageAfter(client, JOB_ID, "invoice_sent", "owner");
  assertEquals(moved, { moved: true, stage: "invoiced" });
  assertEquals(tables.jobs[0].status, "invoiced");
  const again = await advanceRestorationStageAfter(client, JOB_ID, "invoice_sent", "owner");
  assertEquals(again.moved, false);
});

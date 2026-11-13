// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// Restoration workflow: reads, writes, the quote PDF and the ops-api doors
// (docs/restoration-workflow-v1.md). The database is an in-memory fake; no
// test here reaches a network, Xero or a mailbox.
import "./trade_app_visibility_rules_test_env.ts";
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideRestorationQuoteAction,
  getRestorationPlan,
  isRestorationCard,
  markRestorationQuoteSentAction,
  saveRestorationQuoteAction,
  setRestorationPlanAction,
} from "./restoration_workflow_store.ts";
import { RestorationWorkflowError } from "./restoration_workflow.ts";
import {
  formatAud,
  formatQuoteDate,
  renderRestorationQuotePdf,
  restorationQuoteFileName,
  restorationQuoteHeaderRows,
} from "./restoration_quote_render.ts";
import { buildCommercialQuantityOverrideLines } from "./ses_commercial_quantity_override.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  _toggleDocumentVisibilityForTest,
  AGENT_READ_ALLOWED_ACTIONS,
  dispatchRestorationAction,
} from "./index.ts";

type Row = Record<string, any>;
type Store = Record<string, Row[]>;

const ORG = "00000000-0000-0000-0000-000000000001";
const RESTORATION_JOB = "11111111-1111-4111-8111-111111111111";
const MAKESAFE_JOB = "22222222-2222-4222-8222-222222222222";
const REPAIR_JOB = "33333333-3333-4333-8333-333333333333";
const LEGACY_RESTORATION_JOB = "44444444-4444-4444-8444-444444444444";
const STAFF = {
  label: "office@example.invalid",
  userId: "66666666-6666-4666-8666-666666666666",
  orgId: ORG,
};

let clock = Date.parse("2026-11-12T00:00:00Z");
function tick(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function baseStore(): Store {
  return {
    jobs: [
      {
        id: RESTORATION_JOB,
        org_id: ORG,
        job_number: "SWMS-261999",
        type: "makesafe",
        status: "accepted",
        client_name: "JORDAN EXAMPLE",
        site_address: "1 Example Way",
        site_suburb: "Lynwood",
        notes:
          "Allocation Work Order MLR-40001PO-60001 Restoration Restoration Please attend to inspect damage to the bedroom.\nPlease provide a quote for structural drying. Please cap drying equipment at 5 days.\nDAL (designated authority limit) - $1k for initial attendance.",
        metadata: {
          makesafe_job_family: "restoration",
          builder_claim_ref: "MLR-40001",
          builder_po_number: "PO-60001",
          requesting_company: { name: "ML Builders", slug: "mlb" },
        },
        updated_at: tick(),
      },
      {
        id: MAKESAFE_JOB,
        org_id: ORG,
        job_number: "SWMS-261000",
        type: "makesafe",
        status: "accepted",
        site_address: "2 Example Way",
        metadata: { makesafe_job_family: "general_makesafe" },
        updated_at: tick(),
      },
      {
        id: REPAIR_JOB,
        org_id: ORG,
        job_number: "SWR-261000",
        type: "repair",
        status: "accepted",
        site_address: "3 Example Way",
        metadata: { makesafe_job_family: "repair" },
        updated_at: tick(),
      },
      {
        id: LEGACY_RESTORATION_JOB,
        org_id: ORG,
        job_number: "SWMS-26936",
        type: "insurance",
        status: "processing",
        site_address: "4 Example Way",
        notes: "Please attend to dry carpets after burst pipe.",
        metadata: {
          makesafe_job_family: "general_makesafe",
          insurance_job_type: "restoration",
        },
        updated_at: tick(),
      },
    ],
    makesafe_job_details: [
      {
        job_id: RESTORATION_JOB,
        external_ref: "MLR-40001",
        requesting_company_name: "ML Builders",
        requesting_company_slug: "mlb",
        special_instructions: null,
      },
    ],
    makesafe_docket_revisions: [],
    job_documents: [],
    job_events: [],
  };
}

function makeFakeClient(
  store: Store,
  hooks: {
    selectError?: (table: string) => Row | null;
    beforeUpdate?: (table: string) => void;
    insertError?: (table: string) => Row | null;
  } = {},
) {
  function from(table: string) {
    store[table] = store[table] || [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: any = null;
    let returning = false;
    const preds: Array<(r: Row) => boolean> = [];
    const orders: Array<{ key: string; asc: boolean }> = [];
    let limitN: number | null = null;

    function exec(): { data: any; error: any } {
      if (mode === "insert") {
        const refused = hooks.insertError?.(table);
        if (refused) return { data: null, error: refused };
        const rows = (Array.isArray(payload) ? payload : [payload]).map((
          r: Row,
        ) => ({
          id: r.id ?? crypto.randomUUID(),
          created_at: tick(),
          version: 1,
          ...r,
        }));
        store[table].push(...rows);
        return { data: returning ? rows : null, error: null };
      }
      if (mode === "update") {
        hooks.beforeUpdate?.(table);
        const matched = store[table].filter((r) => preds.every((p) => p(r)));
        for (const row of matched) {
          Object.assign(row, payload);
          // trg_jobs_updated: every jobs update moves updated_at.
          if (table === "jobs") row.updated_at = tick();
        }
        return { data: returning ? matched : null, error: null };
      }
      const refused = hooks.selectError?.(table);
      if (refused) return { data: null, error: refused };
      let rows = store[table].filter((r) => preds.every((p) => p(r)));
      for (const order of [...orders].reverse()) {
        rows = [...rows].sort((a, b) =>
          String(a[order.key] ?? "").localeCompare(String(b[order.key] ?? "")) *
          (order.asc ? 1 : -1)
        );
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    }

    const builder: any = {
      select(_columns?: string) {
        if (mode === "select") return builder;
        returning = true;
        return builder;
      },
      insert(rows: any) {
        mode = "insert";
        payload = rows;
        return builder;
      },
      update(values: any) {
        mode = "update";
        payload = values;
        return builder;
      },
      eq(key: string, value: any) {
        preds.push((r) => r[key] === value);
        return builder;
      },
      is(key: string, value: any) {
        preds.push((r) => (r[key] ?? null) === value);
        return builder;
      },
      order(key: string, options?: { ascending?: boolean }) {
        orders.push({ key, asc: options?.ascending !== false });
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      maybeSingle() {
        const result = exec();
        if (result.error) return Promise.resolve(result);
        const rows = Array.isArray(result.data) ? result.data : [];
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (value: any) => any, reject?: (reason: any) => any) {
        return Promise.resolve(exec()).then(resolve, reject);
      },
    };
    return builder;
  }
  return { from };
}

function deps(uploads: Array<{ jobId: string; fileName: string; bytes: number }> = []) {
  return {
    now: () => tick(),
    persistPdf: (args: { jobId: string; fileName: string; bytes: Uint8Array }) => {
      uploads.push({
        jobId: args.jobId,
        fileName: args.fileName,
        bytes: args.bytes.length,
      });
      return Promise.resolve({
        publicUrl: `https://storage.example.invalid/job-documents/${args.jobId}/${
          encodeURIComponent(args.fileName)
        }`,
        storagePath: `${args.jobId}/${args.fileName}`,
      });
    },
  };
}

const DRYING_LINES = [
  { kind: "labour", description: "Remove and dispose of wet carpet and underlay, 2 trades", quantity: 6, unit: "hr", unit_price_ex_gst: 110 },
  { kind: "equipment", description: "Air movers x 3 and dehumidifier x 1", quantity: 5, unit: "day", unit_price_ex_gst: 180 },
  { kind: "disposal", description: "Tipping fee", quantity: 1, unit: "each", unit_price_ex_gst: 120 },
];

async function refusal(promise: Promise<unknown>): Promise<[string, number]> {
  const error = await assertRejects(() => promise, RestorationWorkflowError);
  return [error.code, error.status];
}

Deno.test("restoration card: only a restoration family job on the make-safe board", () => {
  const store = baseStore();
  const byId = (id: string) => store.jobs.find((job) => job.id === id);
  assertEquals(isRestorationCard(byId(RESTORATION_JOB)), true);
  // The older storage shape (type insurance, insurance_job_type restoration).
  assertEquals(isRestorationCard(byId(LEGACY_RESTORATION_JOB)), true);
  assertEquals(isRestorationCard(byId(MAKESAFE_JOB)), false);
  // A repair job has the Repairs board and the quote builder.
  assertEquals(isRestorationCard(byId(REPAIR_JOB)), false);
  assertEquals(isRestorationCard({ type: "fencing", metadata: { makesafe_job_family: "restoration" } }), false);
});

Deno.test("restoration read: the plan comes off the work order and nothing is written", async () => {
  const store = baseStore();
  const before = JSON.stringify(store);
  const read = await getRestorationPlan(makeFakeClient(store), { job_number: "swms-261999" }, STAFF) as any;
  assertEquals(read.job.job_number, "SWMS-261999");
  assertEquals(read.job.builder_reference, "MLR-40001");
  assertEquals(read.job.builder_purchase_order, "PO-60001");
  assertEquals(read.restoration.stored, false);
  assertEquals(read.restoration.mode, "assess_and_quote");
  assertEquals(read.restoration.phase, "assess");
  assertEquals(read.restoration.authority_limit_ex_gst, 1000);
  assertEquals(read.restoration.equipment_day_cap, 5);
  assertEquals(read.authority_limit.status, "not_priced");
  assertEquals(read.invoice_handoff, null);
  assertEquals(read.docket.read, "ok");
  assertEquals(JSON.stringify(store), before);
});

Deno.test("restoration read: wrong jobs, other tenants and unreadable data are refused by name", async () => {
  const store = baseStore();
  const client = makeFakeClient(store);
  assertEquals(await refusal(getRestorationPlan(client, {}, STAFF)), ["job_required", 400]);
  assertEquals(await refusal(getRestorationPlan(client, { job_id: "not-a-uuid" }, STAFF)), ["job_id_invalid", 400]);
  assertEquals(await refusal(getRestorationPlan(client, { job_number: "SWMS-000" }, STAFF)), ["job_not_found", 404]);
  assertEquals(await refusal(getRestorationPlan(client, { job_id: MAKESAFE_JOB }, STAFF)), ["not_a_restoration_job", 409]);
  assertEquals(await refusal(getRestorationPlan(client, { job_id: REPAIR_JOB }, STAFF)), ["not_a_restoration_job", 409]);
  assertEquals(
    await refusal(getRestorationPlan(client, { job_id: RESTORATION_JOB }, { ...STAFF, orgId: "99999999-9999-4999-8999-999999999999" })),
    ["job_not_found", 404],
  );
  // A failed read is an error, never "no plan".
  const broken = makeFakeClient(store, { selectError: (table) => table === "jobs" ? { message: "boom" } : null });
  assertEquals(await refusal(getRestorationPlan(broken, { job_id: RESTORATION_JOB }, STAFF)), ["restoration_read_failed", 503]);
});

Deno.test("restoration quote: saved, filed as an office-only document, then sent, then approved", async () => {
  const store = baseStore();
  const client = makeFakeClient(store);
  const uploads: Array<{ jobId: string; fileName: string; bytes: number }> = [];

  // A dry run totals the quote and writes nothing.
  const before = JSON.stringify(store);
  const dry = await saveRestorationQuoteAction(client, { job_id: RESTORATION_JOB, lines: DRYING_LINES, dry_run: true }, STAFF, deps(uploads)) as any;
  assertEquals(dry.dry_run, true);
  assertEquals(dry.quote.subtotal_ex_gst, 1680);
  assertEquals(JSON.stringify(store), before);
  assertEquals(uploads.length, 0);

  const saved = await saveRestorationQuoteAction(client, {
    job_id: RESTORATION_JOB,
    lines: DRYING_LINES,
    scope_of_works: "Lift and dispose of wet carpet and underlay to bedroom 2. Structural drying for up to 5 days.",
    exclusions: "Re-laying carpet. Plumbing repairs.",
    attention: "Builder Coordinator",
  }, STAFF, deps(uploads)) as any;
  assertEquals(saved.quote.quote_number, "SWMS-261999-Q1");
  assertEquals(saved.quote.total_inc_gst, 1848);
  assertEquals(saved.sent_to_builder, false);
  assertEquals(saved.restoration.phase, "quote_drafted");

  // The PDF is a real PDF, filed once, office only, and never a 'quote' row.
  assertEquals(uploads.length, 1);
  assertEquals(uploads[0].fileName, "Restoration Quote - SWMS-261999-Q1 - MLR-40001.pdf");
  assert(uploads[0].bytes > 1000);
  assertEquals(store.job_documents.length, 1);
  const document = store.job_documents[0];
  assertEquals(document.type, "other");
  assertEquals(document.visible_to_trades, false);
  assertEquals(document.sent_at ?? null, null);
  assertEquals(document.metadata.restoration_document, "quote");
  assertEquals(document.data_snapshot_json.restoration_quote.subtotal_ex_gst, 1680);
  assertEquals(saved.quote.document_id, document.id);
  assertEquals(store.jobs[0].metadata.restoration.quotes[0].document_id, document.id);
  // Other metadata on the card is untouched.
  assertEquals(store.jobs[0].metadata.builder_po_number, "PO-60001");

  // Re-saving the draft replaces its own file; no second document.
  await saveRestorationQuoteAction(client, { job_id: RESTORATION_JOB, lines: DRYING_LINES }, STAFF, deps(uploads));
  assertEquals(store.job_documents.length, 1);
  assertEquals(store.job_documents[0].version, 2);

  const sent = await markRestorationQuoteSentAction(client, { job_id: RESTORATION_JOB, revision: 1, sent_to: "coordinator@builder.example" }, STAFF, deps()) as any;
  assertEquals(sent.restoration.phase, "awaiting_approval");

  const read = await getRestorationPlan(client, { job_id: RESTORATION_JOB }, STAFF) as any;
  assertEquals(read.invoice_handoff, null);

  const approved = await decideRestorationQuoteAction(client, {
    job_id: RESTORATION_JOB,
    revision: 1,
    decision: "approved",
    decided_by: "Builder Coordinator",
    evidence_kind: "email",
    evidence_ref: "Re: MLR-40001 quote, 13 Nov 2026",
  }, STAFF, deps()) as any;
  assertEquals(approved.restoration.phase, "approved_works");
  assertEquals(approved.restoration.approved_total_ex_gst, 1680);

  // The same decision again is a no-op, not a second event.
  const again = await decideRestorationQuoteAction(client, {
    job_id: RESTORATION_JOB,
    revision: 1,
    decision: "approved",
    decided_by: "Builder Coordinator",
    evidence_ref: "Re: MLR-40001 quote, 13 Nov 2026",
  }, STAFF, deps()) as any;
  assertEquals(again.unchanged, true);

  assertEquals(
    store.job_events.map((event) => event.event_type),
    [
      "restoration_quote_saved",
      "restoration_quote_saved",
      "restoration_quote_sent",
      "restoration_quote_approved",
    ],
  );
  const approvalEvent = store.job_events[3];
  assertEquals(approvalEvent.detail_json.decided_by, "Builder Coordinator");
  assertEquals(approvalEvent.detail_json.operator, "office@example.invalid");
});

Deno.test("restoration quote: no price, total or PDF link is stored where a trade can read", async () => {
  const store = baseStore();
  const client = makeFakeClient(store);
  await saveRestorationQuoteAction(client, { job_id: RESTORATION_JOB, lines: DRYING_LINES, scope_of_works: "Dry the bedroom." }, STAFF, deps());
  await markRestorationQuoteSentAction(client, { job_id: RESTORATION_JOB, revision: 1, sent_to: "coordinator@builder.example" }, STAFF, deps());
  await decideRestorationQuoteAction(client, { job_id: RESTORATION_JOB, revision: 1, decision: "approved", decided_by: "Builder Coordinator", evidence_ref: "email 13 Nov" }, STAFF, deps());

  // jobs.metadata and job_events reach trade reads; the quote's money must not.
  const stored = store.jobs[0].metadata.restoration;
  assertEquals(Object.keys(stored.quotes[0]).sort(), [
    "content_hash",
    "decision",
    "document_id",
    "prepared_at",
    "prepared_by",
    "quote_number",
    "revision",
    "sent",
    "status",
  ]);
  assert(/^sha256:[0-9a-f]{64}$/.test(stored.quotes[0].content_hash));
  const exposed = JSON.stringify([store.jobs[0].metadata, store.job_events]);
  for (const leak of ["unit_price", "subtotal", "total_inc", "line_total", "1680", "1848", "storage.example.invalid", "pdf_url", "Air movers"]) {
    assertEquals(exposed.includes(leak), false, `"${leak}" must not be stored on the job or its events`);
  }
  // The priced content is on the office-only document, and a staff read has it.
  assertEquals(store.job_documents[0].visible_to_trades, false);
  assertEquals(store.job_documents[0].data_snapshot_json.restoration_quote.lines.length, 3);
  const read = await getRestorationPlan(client, { job_id: RESTORATION_JOB }, STAFF) as any;
  assertEquals(read.restoration.quote.subtotal_ex_gst, 1680);
  assertEquals(read.restoration.quote.lines[1].description, "Air movers x 3 and dehumidifier x 1");
  assert(String(read.restoration.quote.pdf_url).startsWith("https://"));
});

Deno.test("restoration quote: an approval is of exactly the filed content; a changed document is refused", async () => {
  const store = baseStore();
  const client = makeFakeClient(store);
  await saveRestorationQuoteAction(client, { job_id: RESTORATION_JOB, lines: DRYING_LINES }, STAFF, deps());
  await decideRestorationQuoteAction(client, { job_id: RESTORATION_JOB, revision: 1, decision: "approved", decided_by: "Builder Coordinator", evidence_ref: "email 13 Nov" }, STAFF, deps());

  // Someone edits the filed content after the approval.
  const lines = store.job_documents[0].data_snapshot_json.restoration_quote.lines;
  lines[0] = { ...lines[0], quantity: 60 };
  assertEquals(await refusal(getRestorationPlan(client, { job_id: RESTORATION_JOB }, STAFF)), ["restoration_quote_mismatch", 409]);
  // Not even a new save may paper over a quote the builder decided on.
  assertEquals(
    await refusal(saveRestorationQuoteAction(client, { job_id: RESTORATION_JOB, lines: DRYING_LINES, revise_approved: true }, STAFF, deps())),
    ["restoration_quote_mismatch", 409],
  );
  // A missing document is the same refusal, never "no quote".
  store.job_documents.length = 0;
  assertEquals(await refusal(getRestorationPlan(client, { job_id: RESTORATION_JOB }, STAFF)), ["restoration_quote_mismatch", 409]);
});

Deno.test("restoration quote: a draft save interrupted between its two writes is put right by saving again", async () => {
  const store = baseStore();
  const client = makeFakeClient(store);
  await saveRestorationQuoteAction(client, { job_id: RESTORATION_JOB, lines: DRYING_LINES }, STAFF, deps());

  // The document write lands, then the job changes before the record does.
  let raced = false;
  const racing = makeFakeClient(store, {
    beforeUpdate: (table) => {
      if (table === "jobs" && !raced) {
        raced = true;
        store.jobs[0].updated_at = tick();
      }
    },
  });
  assertEquals(
    await refusal(saveRestorationQuoteAction(racing, { job_id: RESTORATION_JOB, lines: DRYING_LINES.slice(0, 2) }, STAFF, deps())),
    ["job_changed", 409],
  );
  // The record and the document now disagree: a read says so plainly.
  assertEquals(await refusal(getRestorationPlan(client, { job_id: RESTORATION_JOB }, STAFF)), ["restoration_quote_mismatch", 409]);
  // Saving again repairs it, as the same revision and the same one document.
  const repaired = await saveRestorationQuoteAction(client, { job_id: RESTORATION_JOB, lines: DRYING_LINES.slice(0, 2) }, STAFF, deps()) as any;
  assertEquals(repaired.quote.revision, 1);
  assertEquals(repaired.quote.subtotal_ex_gst, 1560);
  assertEquals(store.job_documents.length, 1);
  const read = await getRestorationPlan(client, { job_id: RESTORATION_JOB }, STAFF) as any;
  assertEquals(read.restoration.quote.subtotal_ex_gst, 1560);
});

Deno.test("restoration hand-off: before a docket it says so; with one it is the object the invoice path accepts", async () => {
  const store = baseStore();
  const client = makeFakeClient(store);
  await saveRestorationQuoteAction(client, { job_id: RESTORATION_JOB, lines: DRYING_LINES }, STAFF, deps());
  await decideRestorationQuoteAction(client, {
    job_id: RESTORATION_JOB,
    revision: 1,
    decision: "approved",
    decided_by: "Builder Coordinator",
    evidence_ref: "PO-60001 revised 13 Nov 2026",
    evidence_kind: "purchase_order",
  }, STAFF, deps());

  const early = await getRestorationPlan(client, { job_id: RESTORATION_JOB }, STAFF) as any;
  assertEquals(early.invoice_handoff.ready, false);
  assertEquals(early.invoice_handoff.code, "docket_not_prepared");

  // An older docket and the newest one: the newest committed revision is the
  // one prepare_ses_invoice_obligation would price from.
  store.makesafe_docket_revisions.push(
    {
      id: "docket-old",
      job_id: RESTORATION_JOB,
      stage: "pre_xero",
      committed_at: "2026-11-12T03:00:00.000Z",
      local_invoice_proposal: { line_items: [{ unit_price_ex_gst: 80 }], billable_hours_floor: 2, reported_hours_per_trade: 1, subtotal_ex_gst: 160 },
    },
    {
      id: "docket-new",
      job_id: RESTORATION_JOB,
      stage: "pre_xero",
      committed_at: "2026-11-14T03:00:00.000Z",
      local_invoice_proposal: {
        line_items: [{ description: "restoration attendance", quantity: 6, unit_price_ex_gst: 90 }],
        billable_hours_floor: 3,
        reported_hours_per_trade: 3,
        subtotal_ex_gst: 540,
      },
    },
  );
  const read = await getRestorationPlan(client, { job_id: RESTORATION_JOB, authorised_by: "Office Person" }, STAFF) as any;
  assertEquals(read.docket.docket_revision_id, "docket-new");
  assertEquals(read.docket.sealed_labour_rate_ex_gst, 90);
  assertEquals(read.invoice_handoff.ready, true);
  assertEquals(read.invoice_handoff.total_ex_gst, 1680);
  const override = read.invoice_handoff.commercial_quantity_override;
  assertEquals(override.authorised_by, "Office Person");
  assertEquals(override.trade_reported_hours_per_trade, 3);
  assertEquals(override.sealed_billable_hours_floor, 3);
  assertEquals(override.labour_rate_override.sealed_unit_price_ex_gst, 90);
  assertEquals(override.labour_rate_override.authorised_unit_price_ex_gst, 110);
  const built = buildCommercialQuantityOverrideLines({
    override,
    docket_revision_id: "docket-new",
    attendance_cycle_ids: ["cycle-2"],
    sealed_labour_unit_price_ex_gst: 90,
    builder_reference: "MLR-40001PO-60001",
  });
  assertEquals(built.lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0), 1680);

  // An unreadable docket is reported as unreadable, never as "no docket".
  const broken = makeFakeClient(store, { selectError: (table) => table === "makesafe_docket_revisions" ? { message: "timeout" } : null });
  const degraded = await getRestorationPlan(broken, { job_id: RESTORATION_JOB }, STAFF) as any;
  assertEquals(degraded.docket.read, "failed");
  assertEquals(degraded.invoice_handoff.ready, false);
});

Deno.test("restoration writes: a job that changed underneath is refused and nothing is half-written", async () => {
  const store = baseStore();
  let raced = false;
  const client = makeFakeClient(store, {
    beforeUpdate: (table) => {
      // Another writer touched the job between our read and our write.
      if (table === "jobs" && !raced) {
        raced = true;
        store.jobs[0].updated_at = tick();
      }
    },
  });
  assertEquals(
    await refusal(setRestorationPlanAction(client, { job_id: RESTORATION_JOB, mode: "do_and_charge" }, STAFF, deps())),
    ["job_changed", 409],
  );
  assertEquals(store.jobs[0].metadata.restoration, undefined);
  assertEquals(store.job_events.length, 0);
  // The retry succeeds.
  const retried = await setRestorationPlanAction(client, { job_id: RESTORATION_JOB, mode: "do_and_charge", authority_limit_ex_gst: 800 }, STAFF, deps()) as any;
  assertEquals(retried.restoration.mode, "do_and_charge");
  assertEquals(retried.restoration.phase, "attend_and_charge");
  assertEquals(store.jobs[0].metadata.restoration.authority_limit_ex_gst, 800);
  assertEquals(store.job_events.map((event) => event.event_type), ["restoration_plan_set"]);
});

Deno.test("restoration writes: a server caller must name a person; a failed PDF filing stores no quote", async () => {
  const store = baseStore();
  const client = makeFakeClient(store);
  const nameless = { label: null, userId: null, orgId: null };
  assertEquals(
    await refusal(setRestorationPlanAction(client, { job_id: RESTORATION_JOB, mode: "do_and_charge" }, nameless, deps())),
    ["operator_required", 400],
  );
  const named = await setRestorationPlanAction(client, { job_id: RESTORATION_JOB, mode: "do_and_charge", operator_email: "terminal for office person" }, nameless, deps()) as any;
  assertEquals(named.restoration.updated_by, "terminal for office person");

  const refusing = makeFakeClient(store, { insertError: (table) => table === "job_documents" ? { message: "insert refused" } : null });
  assertEquals(
    await refusal(saveRestorationQuoteAction(refusing, { job_id: RESTORATION_JOB, lines: DRYING_LINES }, STAFF, deps())),
    ["quote_document_write_failed", 503],
  );
  assertEquals(store.jobs[0].metadata.restoration.quotes.length, 0);

  // A failed audit row never fails a saved decision.
  const quietEvents = makeFakeClient(store, { insertError: (table) => table === "job_events" ? { message: "events down" } : null });
  const saved = await saveRestorationQuoteAction(quietEvents, { job_id: RESTORATION_JOB, lines: DRYING_LINES }, STAFF, deps()) as any;
  assertEquals(saved.success, true);
  assertEquals(store.jobs[0].metadata.restoration.quotes.length, 1);
});

Deno.test("restoration quote PDF: file name, header rows and money are plain and stable", async () => {
  assertEquals(restorationQuoteFileName("SWMS-261999-Q2", "MLR-40001"), "Restoration Quote - SWMS-261999-Q2 - MLR-40001.pdf");
  assertEquals(restorationQuoteFileName("SWMS-261999-Q1", null), "Restoration Quote - SWMS-261999-Q1.pdf");
  assertEquals(formatAud(1680), "$1,680.00");
  assertEquals(formatAud(0.5), "$0.50");
  assertEquals(formatQuoteDate("2026-11-12T02:00:00.000Z"), "12 November 2026");
  const store = baseStore();
  const saved = await saveRestorationQuoteAction(makeFakeClient(store), { job_id: RESTORATION_JOB, lines: DRYING_LINES }, STAFF, deps()) as any;
  const input = {
    quote: saved.quote,
    job_number: "SWMS-261999",
    builder_reference: "MLR-40001",
    builder_purchase_order: "PO-60001",
    builder_name: "ML Builders",
    attention: "Builder Coordinator",
    site_address: "1 Example Way, Lynwood",
    insured_name: "JORDAN EXAMPLE",
    quote_date: "2026-11-12",
  };
  assertEquals(restorationQuoteHeaderRows(input), [
    ["Quote number", "SWMS-261999-Q1"],
    ["Quote date", "12 November 2026"],
    ["Valid for", "30 days"],
    ["Prepared for", "Builder Coordinator, ML Builders"],
    ["Builder reference", "MLR-40001"],
    ["Purchase order", "PO-60001"],
    ["Our job number", "SWMS-261999"],
    ["Site address", "1 Example Way, Lynwood"],
    ["Insured", "JORDAN EXAMPLE"],
  ]);
  const rendered = await renderRestorationQuotePdf(input);
  assertEquals(new TextDecoder().decode(rendered.bytes.slice(0, 5)), "%PDF-");
  assertEquals(rendered.fileName, "Restoration Quote - SWMS-261999-Q1 - MLR-40001.pdf");
});

Deno.test("restoration doors: staff or the ops key; the routine reads only; trades and the agent key never", async () => {
  const actions = [
    "restoration_plan",
    "restoration_set_plan",
    "restoration_save_quote",
    "restoration_mark_quote_sent",
    "restoration_record_quote_decision",
  ];
  for (const action of actions) {
    const url = new URL(`https://example.invalid/ops-api?action=${action}`);
    // Every door needs a signed staff caller at the front door.
    assertEquals(_opsApiActionNeedsStaffRole(url), true, action);
    assertEquals(AGENT_READ_ALLOWED_ACTIONS.has(action), false, action);
    const trade = _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role: "lead_installer" } });
    assertEquals(trade.ok, false, action);
    if (!trade.ok) assertEquals(trade.status, 403);
    assertEquals(_authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role: "ops_manager" } }).ok, true, action);
    assertEquals(_authorizeOpsApiAction({ url, authMode: "none" }).ok, false, action);
  }

  const store = baseStore();
  const client = makeFakeClient(store);
  const read = await dispatchRestorationAction(client, "restoration_plan", "GET", new URLSearchParams({ job_id: RESTORATION_JOB }), {}, STAFF);
  assertEquals(read.status, 200);
  assertEquals((await read.json()).restoration.mode, "assess_and_quote");

  // A write sent as a GET, and a read sent as a POST, are both refused.
  assertEquals((await dispatchRestorationAction(client, "restoration_set_plan", "GET", new URLSearchParams(), {}, STAFF)).status, 405);
  assertEquals((await dispatchRestorationAction(client, "restoration_plan", "POST", new URLSearchParams(), {}, STAFF)).status, 405);

  // The module's own refusals come back with their code and status.
  const refused = await dispatchRestorationAction(client, "restoration_record_quote_decision", "POST", new URLSearchParams(), { job_id: RESTORATION_JOB, revision: 1, decision: "approved" }, STAFF);
  assertEquals(refused.status, 409);
  assertEquals((await refused.json()).code, "quote_missing");
});

Deno.test("restoration quote document: it can never be switched on for trades", async () => {
  const store = baseStore();
  const client = makeFakeClient(store);
  await saveRestorationQuoteAction(client, { job_id: RESTORATION_JOB, lines: DRYING_LINES }, STAFF, deps());
  store.job_documents.push({ id: "work-order-doc", job_id: RESTORATION_JOB, type: "work_order", metadata: {}, visible_to_trades: false });
  const quoteDocumentId = store.job_documents[0].id;

  const error = await assertRejects(() => _toggleDocumentVisibilityForTest(client, { document_id: quoteDocumentId, visible_to_trades: true }));
  assert(String((error as Error).message).includes("cannot be shown to trades"));
  assertEquals(store.job_documents[0].visible_to_trades, false);
  // Switching it off (it already is) and switching any other document on still work.
  assertEquals(await _toggleDocumentVisibilityForTest(client, { document_id: quoteDocumentId, visible_to_trades: false }), { success: true });
  assertEquals(await _toggleDocumentVisibilityForTest(client, { document_id: "work-order-doc", visible_to_trades: true }), { success: true });
  assertEquals(store.job_documents[1].visible_to_trades, true);
  // A document that cannot be read is not shown on a guess.
  const broken = makeFakeClient(store, { selectError: (table) => table === "job_documents" ? { message: "timeout" } : null });
  await assertRejects(() => _toggleDocumentVisibilityForTest(broken, { document_id: quoteDocumentId, visible_to_trades: true }));
  assertEquals(store.job_documents[0].visible_to_trades, false);
});

// ════════════════════════════════════════════════════════════
// MATERIALS ACTUALS — BILL INGESTION TESTS (U3)
//
// Pure-Deno, no network. Proves the money-path decision core: the regex
// unification (SWMS + division letters + the U1 test strings), tolerance/window
// matching, deterministic uniqueness (NO auto-match when a competitor exists),
// and the trade-mirror hard exclusion. This is what CP2's precision gate replays.
//
// RUN:
//   ~/.deno/bin/deno test --no-check --allow-none \
//     supabase/functions/xero-sync/materials_ingest_test.ts
// ════════════════════════════════════════════════════════════

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  amountWithinTolerance,
  type BillInput,
  buildMaterialsFactRow,
  buildQueueRow,
  dateWithinWindow,
  DEFAULT_MATCH_CONFIG,
  extractJobNumber,
  findUniquePOMatch,
  isOpenPO,
  matchBill,
  type POCandidate,
} from "./materials_ingest.ts";

// ── helpers ──────────────────────────────────────────────────
function bill(overrides: Partial<BillInput> = {}): BillInput {
  return {
    xero_invoice_id: "INV-1",
    invoice_number: "12345",
    xero_contact_id: "C-FWWA",
    contact_name: "Fencing Warehouse WA",
    reference: null,
    sub_total: 1000,
    total: 1100,
    invoice_date: "2026-07-01",
    status: "AUTHORISED",
    invoice_type: "ACCPAY",
    ...overrides,
  };
}
function po(overrides: Partial<POCandidate> = {}): POCandidate {
  return {
    id: "PO-1",
    po_number: "PO-1001",
    xero_contact_id: "C-FWWA",
    status: "authorised",
    subtotal: 1000,
    total: 1100,
    job_id: "JOB-A",
    job_number: "SWF-25010",
    po_date: "2026-06-20",
    xero_bill_id: null,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════
// 1. REGEX UNIFICATION — the U1 §3 proof table + division letters + guards
// ════════════════════════════════════════════════════════════
Deno.test("extractJobNumber — U1 test strings that MUST match", () => {
  assertEquals(extractJobNumber("SWF-25010"), "SWF-25010");
  assertEquals(extractJobNumber("SWP-25029"), "SWP-25029");
  assertEquals(extractJobNumber("PO-SWF-25010"), "SWF-25010");
  assertEquals(extractJobNumber("SWF-25010-PO1"), "SWF-25010");
  assertEquals(extractJobNumber("SWF-25010 Bunnings order"), "SWF-25010");
  assertEquals(extractJobNumber("Job SWF-25010"), "SWF-25010");
  // The UNIFICATION fix — these failed the old strict reconcile regex:
  assertEquals(extractJobNumber("SWMS-26878"), "SWMS-26878"); // make-safe
  assertEquals(extractJobNumber("SWB-26073"), "SWB-26073"); // division letter B (live data)
  assertEquals(extractJobNumber("SWD-26071"), "SWD-26071"); // division letter D
  // multi-order suffix still resolves to the embedded job
  assertEquals(extractJobNumber("SWF-25010-01"), "SWF-25010");
  // case-insensitive, normalised upper
  assertEquals(extractJobNumber("swf-25010"), "SWF-25010");
});

Deno.test("extractJobNumber — must NOT match (ambiguous/malformed)", () => {
  assertEquals(extractJobNumber("SW-25010"), null); // bare, no division letter (U1: avoid)
  assertEquals(extractJobNumber("SWF25010"), null); // no hyphen
  assertEquals(extractJobNumber("SWF-250100"), null); // 6 digits — (?!\d) guard, no silent truncation
  assertEquals(extractJobNumber("SW1615"), null); // legacy Tradify — routed via xero_projects, not here
  assertEquals(extractJobNumber(""), null);
  assertEquals(extractJobNumber(null), null);
  assertEquals(extractJobNumber(undefined), null);
  assertEquals(extractJobNumber("1721"), null); // Bunnings PowerPass order number, not a job
  assertEquals(extractJobNumber("just some free text"), null);
});

// ════════════════════════════════════════════════════════════
// 2. TOLERANCE (±2% or ±$5, whichever greater)
// ════════════════════════════════════════════════════════════
Deno.test("amountWithinTolerance — abs floor of $5 dominates on small amounts", () => {
  assert(amountWithinTolerance(100, 104, DEFAULT_MATCH_CONFIG)); // $4 <= $5
  assert(amountWithinTolerance(100, 105, DEFAULT_MATCH_CONFIG)); // $5 == $5 boundary
  assert(!amountWithinTolerance(100, 106, DEFAULT_MATCH_CONFIG)); // $6 > $5 and > 2%
});

Deno.test("amountWithinTolerance — 2% dominates on large amounts", () => {
  assert(amountWithinTolerance(10000, 10190, DEFAULT_MATCH_CONFIG)); // $190 <= 2% ($200)
  assert(amountWithinTolerance(10000, 10200, DEFAULT_MATCH_CONFIG)); // $200 == 2% boundary
  assert(!amountWithinTolerance(10000, 10250, DEFAULT_MATCH_CONFIG)); // $250 > 2%
});

Deno.test("amountWithinTolerance — null/NaN never matches", () => {
  assert(!amountWithinTolerance(null, 100));
  assert(!amountWithinTolerance(100, null));
  assert(!amountWithinTolerance(NaN, 100));
});

// ════════════════════════════════════════════════════════════
// 3. DATE WINDOW  [po_date - before, po_date + after]
// ════════════════════════════════════════════════════════════
Deno.test("dateWithinWindow — inside/boundary/outside", () => {
  const cfg = DEFAULT_MATCH_CONFIG; // before 2, after 45
  assert(dateWithinWindow("2026-06-20", "2026-06-20", cfg)); // same day
  assert(dateWithinWindow("2026-08-04", "2026-06-20", cfg)); // +45d exactly
  assert(!dateWithinWindow("2026-08-05", "2026-06-20", cfg)); // +46d
  assert(dateWithinWindow("2026-06-18", "2026-06-20", cfg)); // -2d grace
  assert(!dateWithinWindow("2026-06-17", "2026-06-20", cfg)); // -3d out
  assert(!dateWithinWindow(null, "2026-06-20", cfg));
  assert(!dateWithinWindow("2026-06-20", null, cfg));
});

// ════════════════════════════════════════════════════════════
// 4. OPEN PO predicate
// ════════════════════════════════════════════════════════════
Deno.test("isOpenPO — closed statuses and billed POs are not candidates", () => {
  assert(isOpenPO(po({ status: "authorised" })));
  assert(isOpenPO(po({ status: "draft" })));
  assert(isOpenPO(po({ status: "sent" })));
  assert(!isOpenPO(po({ status: "billed" })));
  assert(!isOpenPO(po({ status: "cancelled" })));
  assert(!isOpenPO(po({ status: "voided" })));
  assert(!isOpenPO(po({ xero_bill_id: "BILL-9" }))); // already consumed by a bill
});

// ════════════════════════════════════════════════════════════
// 5. matchBill — the decision core
// ════════════════════════════════════════════════════════════
Deno.test("matchBill — MIRROR is excluded even with a perfect reference", () => {
  const r = matchBill(
    bill({ reference: "SWF-25010" }),
    {
      isMirror: true,
      jobFromRef: { id: "JOB-A", job_number: "SWF-25010" },
      pos: [],
    },
  );
  assertEquals(r.outcome, "skip_mirror");
});

Deno.test("matchBill — non-ACCPAY is skipped", () => {
  const r = matchBill(
    bill({ invoice_type: "ACCREC" }),
    { isMirror: false, jobFromRef: null, pos: [] },
  );
  assertEquals(r.outcome, "skip_non_accpay");
});

Deno.test("matchBill — reference → job = HIGH fact (xero_ref_link)", () => {
  const r = matchBill(
    bill({ reference: "SWF-25010" }),
    {
      isMirror: false,
      jobFromRef: { id: "JOB-A", job_number: "SWF-25010" },
      pos: [],
    },
  );
  assertEquals(r.outcome, "fact");
  assertEquals(r.confidence, "high");
  assertEquals(r.automationSource, "xero_ref_link");
  assertEquals(r.jobId, "JOB-A");
});

Deno.test("matchBill — reference shaped but NO job on record → queue (ref_no_job), NEVER a fact", () => {
  const r = matchBill(
    bill({ reference: "SWF-99999" }),
    { isMirror: false, jobFromRef: null, refToken: "SWF-99999", pos: [] },
  );
  assertEquals(r.outcome, "queue");
  assertEquals(r.suggestionReason, "ref_no_job");
});

Deno.test("matchBill — deterministic UNIQUE open PO = MEDIUM fact (po_deterministic)", () => {
  const r = matchBill(
    bill({ reference: null, sub_total: 1000, invoice_date: "2026-07-01" }),
    { isMirror: false, jobFromRef: null, pos: [po()] },
  );
  assertEquals(r.outcome, "fact");
  assertEquals(r.confidence, "medium");
  assertEquals(r.automationSource, "po_deterministic");
  assertEquals(r.jobId, "JOB-A");
  assertEquals(r.matchedPoId, "PO-1");
});

// THE precision-critical case: two matching open POs → must NEVER auto-assign.
Deno.test("matchBill — TWO competing open POs = queue (ambiguous_po_competitor), no fact", () => {
  const p1 = po({ id: "PO-1", job_id: "JOB-A", subtotal: 1000 });
  const p2 = po({
    id: "PO-2",
    po_number: "PO-1002",
    job_id: "JOB-B",
    subtotal: 1005,
  });
  const r = matchBill(
    bill({ reference: null, sub_total: 1000 }),
    { isMirror: false, jobFromRef: null, pos: [p1, p2] },
  );
  assertEquals(r.outcome, "queue");
  assertEquals(r.suggestionReason, "ambiguous_po_competitor");
  assertEquals(r.suggestionConfidence, "medium");
  // and it never leaks a job assignment
  assertEquals(r.suggestedJobId ?? null, null);
});

Deno.test("matchBill — supplier PO exists but amount off → queue (no_po_match)", () => {
  const r = matchBill(
    bill({ reference: null, sub_total: 5000 }), // PO is 1000, way outside tolerance
    { isMirror: false, jobFromRef: null, pos: [po({ subtotal: 1000 })] },
  );
  assertEquals(r.outcome, "queue");
  assertEquals(r.suggestionReason, "no_po_match");
});

Deno.test("matchBill — PO for a DIFFERENT supplier is never matched", () => {
  const r = matchBill(
    bill({ xero_contact_id: "C-FWWA", reference: null, sub_total: 1000 }),
    {
      isMirror: false,
      jobFromRef: null,
      pos: [po({ xero_contact_id: "C-OTHER" })],
    },
  );
  assertEquals(r.outcome, "queue");
  assertEquals(r.suggestionReason, "no_ref_no_po");
});

Deno.test("matchBill — no ref, no PO → queue (no_ref_no_po) — the common case today", () => {
  const r = matchBill(
    bill({ reference: null }),
    { isMirror: false, jobFromRef: null, pos: [] },
  );
  assertEquals(r.outcome, "queue");
  assertEquals(r.suggestionReason, "no_ref_no_po");
});

Deno.test("matchBill — bill with no supplier id cannot PO-match → queue", () => {
  const r = matchBill(
    bill({ xero_contact_id: null, reference: null }),
    { isMirror: false, jobFromRef: null, pos: [po()] },
  );
  assertEquals(r.outcome, "queue");
});

Deno.test("matchBill — a PO with no job_id is never a candidate", () => {
  const r = matchBill(
    bill({ reference: null }),
    { isMirror: false, jobFromRef: null, pos: [po({ job_id: null })] },
  );
  assertEquals(r.outcome, "queue");
});

// ════════════════════════════════════════════════════════════
// 6. findUniquePOMatch directly
// ════════════════════════════════════════════════════════════
Deno.test("findUniquePOMatch — single match, competitors, none", () => {
  const single = findUniquePOMatch(bill({ sub_total: 1000 }), [po()]);
  assert(single && "po" in single);

  const comp = findUniquePOMatch(bill({ sub_total: 1000 }), [
    po({ id: "PO-1" }),
    po({ id: "PO-2", po_number: "X" }),
  ]);
  assert(comp && "competitors" in comp && comp.competitors === 2);

  const none = findUniquePOMatch(bill({ sub_total: 9999 }), [
    po({ subtotal: 100 }),
  ]);
  assertEquals(none, null);
});

// ════════════════════════════════════════════════════════════
// 7. Row builders — canonical adapter shape + suggestion boundary
// ════════════════════════════════════════════════════════════
Deno.test("buildMaterialsFactRow — canonical money-fact shape", () => {
  const m = matchBill(
    bill({
      reference: "SWF-25010",
      sub_total: 1000,
      total: 1100,
      invoice_date: "2026-07-01",
    }),
    {
      isMirror: false,
      jobFromRef: { id: "JOB-A", job_number: "SWF-25010" },
      pos: [],
    },
  );
  const row = buildMaterialsFactRow(
    bill({ sub_total: 1000, total: 1100 }),
    m,
    "ORG",
    { nowIso: "2026-07-05T00:00:00Z" },
  );
  assertEquals(row.lane, "materials");
  assertEquals(row.kind, "actual");
  assertEquals(row.amount_ex_gst, 1000);
  assertEquals(row.amount_inc_gst, 1100);
  assertEquals(row.confidence, "high");
  assertEquals(row.automation_source, "xero_ref_link");
  assertEquals(row.job_id, "JOB-A");
  assertEquals(row.xero_invoice_id, "INV-1");
  assertEquals(row.invoice_number, "12345"); // source_ref = xero_invoice_id + invoice_number
});

Deno.test("buildQueueRow — suggestion is never 'high'", () => {
  const m = matchBill(bill({ reference: null }), {
    isMirror: false,
    jobFromRef: null,
    pos: [],
  });
  const row = buildQueueRow(bill(), m, "ORG");
  assertEquals(row.status, "open");
  assert(
    row.suggestion_confidence === "low" ||
      row.suggestion_confidence === "medium",
  );
});

// ════════════════════════════════════════════════════════════
// 8. GOLD-SET REPLAY — a mixed batch, prove precision = 100%
//    (no auto-assignment is ever wrong; mirrors produce nothing)
// ════════════════════════════════════════════════════════════
Deno.test("gold-set replay — precision 100%, mirrors excluded", () => {
  type GoldBill = {
    bill: BillInput;
    isMirror: boolean;
    jobFromRef: { id: string; job_number: string } | null;
    pos: POCandidate[];
    truth: string | "not-job" | "ambiguous"; // hand label
  };
  const set: GoldBill[] = [
    // ref hit → JOB-A
    {
      bill: bill({ xero_invoice_id: "B1", reference: "SWF-25010" }),
      isMirror: false,
      jobFromRef: { id: "JOB-A", job_number: "SWF-25010" },
      pos: [],
      truth: "JOB-A",
    },
    // unique PO → JOB-B
    {
      bill: bill({
        xero_invoice_id: "B2",
        reference: null,
        xero_contact_id: "C-RNR",
        sub_total: 2000,
        invoice_date: "2026-07-02",
      }),
      isMirror: false,
      jobFromRef: null,
      pos: [
        po({
          id: "POB",
          xero_contact_id: "C-RNR",
          subtotal: 2000,
          job_id: "JOB-B",
          po_date: "2026-06-25",
        }),
      ],
      truth: "JOB-B",
    },
    // mirror — must yield NOTHING even though a ref is present
    {
      bill: bill({ xero_invoice_id: "B3", reference: "SWF-25010" }),
      isMirror: true,
      jobFromRef: { id: "JOB-A", job_number: "SWF-25010" },
      pos: [],
      truth: "not-job",
    },
    // ambiguous — 2 POs — must queue
    {
      bill: bill({
        xero_invoice_id: "B4",
        reference: null,
        xero_contact_id: "C-X",
        sub_total: 500,
      }),
      isMirror: false,
      jobFromRef: null,
      pos: [
        po({
          id: "P1",
          xero_contact_id: "C-X",
          subtotal: 500,
          job_id: "JOB-C",
        }),
        po({
          id: "P2",
          xero_contact_id: "C-X",
          subtotal: 502,
          job_id: "JOB-D",
        }),
      ],
      truth: "ambiguous",
    },
    // no ref no po — queue
    {
      bill: bill({
        xero_invoice_id: "B5",
        reference: null,
        xero_contact_id: "C-Z",
      }),
      isMirror: false,
      jobFromRef: null,
      pos: [],
      truth: "not-job",
    },
  ];

  let autoAssignments = 0;
  let correctAuto = 0;
  let factsFromMirrors = 0;

  for (const g of set) {
    const r = matchBill(g.bill, {
      isMirror: g.isMirror,
      jobFromRef: g.jobFromRef,
      pos: g.pos,
    });
    if (r.outcome === "fact") {
      autoAssignments++;
      if (g.isMirror) factsFromMirrors++;
      if (r.jobId === g.truth) correctAuto++;
    }
  }

  // Precision: every auto-assignment is correct.
  assertEquals(autoAssignments, 2); // B1 (ref) + B2 (PO) only
  assertEquals(correctAuto, autoAssignments); // 100%
  assertEquals(factsFromMirrors, 0); // mirror exclusion proven
});

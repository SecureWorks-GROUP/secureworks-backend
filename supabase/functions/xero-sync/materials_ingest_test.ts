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
  amountIsKnown,
  existingFactVerdict,
  HELD_QUEUE_REASONS,
  extractJobNumber,
  jobNumbersInText,
  newPlacementAllowed,
  findUniquePOMatch,
  isInstallerBill,
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
  assertEquals(extractJobNumber("SWP-261376-DEP20"), "SWP-261376"); // six-digit (2026)
  assertEquals(extractJobNumber("SWMS-261156"), "SWMS-261156");
  assertEquals(extractJobNumber("INV SWF-261151 balance"), "SWF-261151");
  assertEquals(extractJobNumber("SWD-26071"), "SWD-26071"); // division letter D
  // multi-order suffix still resolves to the embedded job
  assertEquals(extractJobNumber("SWF-25010-01"), "SWF-25010");
  // case-insensitive, normalised upper
  assertEquals(extractJobNumber("swf-25010"), "SWF-25010");
});

Deno.test("extractJobNumber — must NOT match (ambiguous/malformed)", () => {
  assertEquals(extractJobNumber("SW-25010"), null); // bare, no division letter (U1: avoid)
  assertEquals(extractJobNumber("SWF25010"), null); // no hyphen
  assertEquals(extractJobNumber("SWF-2501000"), null); // 7 digits — (?!\d) guard, no silent truncation
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

// Second-model review, 19 Oct 2026: a product code is no job reference.
Deno.test("extractJobNumber: a product code that starts like a job number is not one", () => {
  assertEquals(extractJobNumber("SWF-261009XL"), null);
  assertEquals(extractJobNumber("XSWF-261009"), null);
  assertEquals(extractJobNumber("Order SWF-261009-DEP50"), "SWF-261009");
});

// Fourth second-model review, 19 Oct 2026: the older path never moves a fact.
const T = (...xs: string[]) => new Set(xs);
Deno.test("existing fact: a PO fact whose bill now names two jobs is removed for a person", () => {
  assertEquals(existingFactVerdict({ source: "po_deterministic", factJobId: "A", factJobBlocked: false, refTokens: T("SWF-26535", "SWP-261060"), lineTokens: T(), jobFromRefId: null }), "remove");
});
Deno.test("existing fact: a billed PO dropping out of the candidates keeps its fact (never moved)", () => {
  assertEquals(existingFactVerdict({ source: "po_deterministic", factJobId: "A", factJobNumber: "SWF-26535", factJobBlocked: false, refTokens: T(), lineTokens: T(), jobFromRefId: null }), "keep");
});
Deno.test("existing fact: a reference fact whose reference is gone, refused or now names another job is removed", () => {
  const base = { source: "xero_ref_link", factJobId: "A", factJobNumber: "SWF-26535", factJobBlocked: false, lineTokens: T() };
  assertEquals(existingFactVerdict({ ...base, refTokens: T(), jobFromRefId: null }), "remove");
  assertEquals(existingFactVerdict({ ...base, refTokens: T("SWF-26535"), jobFromRefId: null }), "remove");
  assertEquals(existingFactVerdict({ ...base, refTokens: T("SWF-26999"), jobFromRefId: "B" }), "remove");
  assertEquals(existingFactVerdict({ ...base, refTokens: T("SWF-26535"), jobFromRefId: "A" }), "keep");
});
Deno.test("existing fact: lines naming a different job than the reference remove the fact", () => {
  assertEquals(existingFactVerdict({ source: "xero_ref_link", factJobId: "A", factJobNumber: "SWF-26535", factJobBlocked: false, refTokens: T("SWF-26535"), lineTokens: T("SWF-26999"), jobFromRefId: "A" }), "remove");
});
Deno.test("existing fact: a job that is no longer won or is a holding job loses this path's fact", () => {
  assertEquals(existingFactVerdict({ source: "po_deterministic", factJobId: "A", factJobBlocked: true, refTokens: T(), lineTokens: T(), jobFromRefId: null }), "remove");
});
Deno.test("existing fact: pre-match and human facts are never this path's to change", () => {
  for (const source of ["agent_prematch", "manual_queue"]) {
    assertEquals(existingFactVerdict({ source, factJobId: "A", factJobBlocked: true, refTokens: T("X", "Y"), lineTokens: T(), jobFromRefId: null }), "not_ours");
  }
});
Deno.test("new placement: only one consistent job number, and never the PO fallback once a job is named", () => {
  assertEquals(newPlacementAllowed({ refTokens: T("SWF-26535"), lineTokens: T("SWF-26999"), jobFromRefId: "A" }), { reference: false, poFallback: false });
  assertEquals(newPlacementAllowed({ refTokens: T(), lineTokens: T("SWF-26999"), jobFromRefId: null }), { reference: false, poFallback: false });
  assertEquals(newPlacementAllowed({ refTokens: T("SWF-26535"), lineTokens: T("SWF-26535"), jobFromRefId: "A" }), { reference: true, poFallback: false });
  assertEquals(newPlacementAllowed({ refTokens: T(), lineTokens: T(), jobFromRefId: null }), { reference: false, poFallback: true });
  assertEquals([...jobNumbersInText("SWF-26535 / swp-261060 and SWF-26535XL")], ["SWF-26535", "SWP-261060"]);
});

Deno.test("existing fact: a PO fact whose lines name a different job is removed for a person", () => {
  assertEquals(existingFactVerdict({ source: "po_deterministic", factJobId: "A", factJobNumber: "SWF-26535", factJobBlocked: false, refTokens: T(), lineTokens: T("SWF-26999"), jobFromRefId: null }), "remove");
  assertEquals(existingFactVerdict({ source: "po_deterministic", factJobId: "A", factJobNumber: "SWF-26535", factJobBlocked: false, refTokens: T(), lineTokens: T("SWF-26535"), jobFromRefId: null }), "keep");
});

// ── Review 6 (PR 1063): one grammar, Xero link conflicts, holds ──
Deno.test("jobNumbersInText sees a hyphenless job number in a line (same grammar as the pre-match)", () => {
  const lines = jobNumbersInText("Posts for SWF26999 site");
  assertEquals([...lines], ["SWF-26999"]);
  // Reference SWF-26535 + line SWF26999: two jobs, never placed whole.
  assertEquals(
    newPlacementAllowed({ refTokens: jobNumbersInText("SWF-26535"), lineTokens: lines, jobFromRefId: "a" }),
    { reference: false, poFallback: false },
  );
  // Still a whole token only.
  assertEquals(jobNumbersInText("SWF-261009XL").size, 0);
});

Deno.test("a Xero job link the reference does not back blocks every automatic placement", () => {
  const refTokens = jobNumbersInText("SWF-26535");
  assertEquals(
    newPlacementAllowed({ refTokens, lineTokens: new Set(), jobFromRefId: "b", xeroJobId: "a" }),
    { reference: false, poFallback: false },
  );
  assertEquals(
    newPlacementAllowed({ refTokens, lineTokens: new Set(), jobFromRefId: "a", xeroJobId: "a" }),
    { reference: true, poFallback: false },
  );
  // No job number on the bill: the PO fallback leaves a linked bill to the pre-match.
  assertEquals(
    newPlacementAllowed({ refTokens: new Set(), lineTokens: new Set(), jobFromRefId: null, xeroJobId: "a" }),
    { reference: false, poFallback: false },
  );
});

Deno.test("an existing automatic fact on another job than Xero's link is removed", () => {
  assertEquals(
    existingFactVerdict({
      source: "po_deterministic",
      factJobId: "a",
      factJobNumber: "SWF-26535",
      factJobBlocked: false,
      refTokens: new Set(),
      lineTokens: new Set(),
      jobFromRefId: null,
      xeroJobId: "b",
    }),
    "remove",
  );
});

Deno.test("a held queue row is never placed automatically", () => {
  assertEquals(
    newPlacementAllowed({ refTokens: jobNumbersInText("SWF-26535"), lineTokens: new Set(), jobFromRefId: "a", held: true }),
    { reference: false, poFallback: false },
  );
  assertEquals(HELD_QUEUE_REASONS.has("fact_contradicted"), true);
  assertEquals(HELD_QUEUE_REASONS.has("xero_link_conflict"), true);
  assertEquals(HELD_QUEUE_REASONS.has("no_ref_no_po"), false);
});

Deno.test("an unknown bill amount blocks every automatic placement", () => {
  assertEquals(
    newPlacementAllowed({ refTokens: jobNumbersInText("SWF-26535"), lineTokens: new Set(), jobFromRefId: "a", amountKnown: false }),
    { reference: false, poFallback: false },
  );
  assertEquals([amountIsKnown(null), amountIsKnown(""), amountIsKnown(0), amountIsKnown("12.5")], [false, false, true, true]);
});

Deno.test("a bill naming a PO on another job is never placed by its reference", () => {
  const refTokens = jobNumbersInText("SWF-26535");
  assertEquals(
    newPlacementAllowed({ refTokens, lineTokens: new Set(), jobFromRefId: "a", namedPoJobIds: ["b"] }),
    { reference: false, poFallback: false },
  );
  assertEquals(
    newPlacementAllowed({ refTokens, lineTokens: new Set(), jobFromRefId: "a", namedPoJobIds: [null] }),
    { reference: false, poFallback: false },
  );
  assertEquals(
    newPlacementAllowed({ refTokens, lineTokens: new Set(), jobFromRefId: "a", namedPoJobIds: ["a"] }),
    { reference: true, poFallback: false },
  );
  // No job number, but a PO named: the supplier+amount fallback leaves it to the pre-match.
  assertEquals(
    newPlacementAllowed({ refTokens: new Set(), lineTokens: new Set(), jobFromRefId: null, namedPoJobIds: ["a"] }),
    { reference: false, poFallback: false },
  );
});

Deno.test("an existing sync fact is removed for staff when the bill names a PO on another job", () => {
  const base = {
    source: "xero_ref_link", factJobId: "a", factJobNumber: "SWF-26535", factJobBlocked: false,
    refTokens: jobNumbersInText("SWF-26535"), lineTokens: new Set<string>(), jobFromRefId: "a",
  };
  assertEquals(existingFactVerdict({ ...base, namedPoJobIds: ["b"] }), "remove");
  assertEquals(existingFactVerdict({ ...base, namedPoJobIds: [null] }), "remove");
  assertEquals(existingFactVerdict({ ...base, namedPoJobIds: ["a"] }), "keep");
  // Staff and agent facts are never touched by this path.
  assertEquals(existingFactVerdict({ ...base, source: "agent_prematch", namedPoJobIds: ["b"] }), "not_ours");
});

Deno.test("an existing sync fact whose bill amount is now unknown goes to staff", () => {
  assertEquals(existingFactVerdict({
    source: "po_deterministic", factJobId: "a", factJobNumber: "SWF-26535", factJobBlocked: false,
    refTokens: new Set(), lineTokens: new Set(), jobFromRefId: null, amountKnown: false,
  }), "remove");
});

// ── JP-12: installer bills are never placed automatically ────
Deno.test("isInstallerBill — a money line on 306 or 301", () => {
  assert(isInstallerBill([{ AccountCode: "306", LineAmount: 500 }]));
  assert(isInstallerBill([{ AccountCode: "310", LineAmount: 50 }, { AccountCode: "301", LineAmount: 400 }]));
  assert(!isInstallerBill([{ AccountCode: "306", LineAmount: 0 }, { AccountCode: "310", LineAmount: 50 }]));
  assert(!isInstallerBill(null));
});

Deno.test("matchBill — an installer bill with a job reference waits for a person", () => {
  const m = matchBill(bill({ reference: "SWF-26824" }), {
    isMirror: false,
    installer: true,
    jobFromRef: { id: "J-1", job_number: "SWF-26824" },
    pos: [po()],
  });
  assertEquals(m.outcome, "queue");
  assertEquals(m.suggestionReason, "installer_confirm");
  assertEquals(m.suggestedJobId, "J-1");
  assert(HELD_QUEUE_REASONS.has("installer_confirm"));
});

Deno.test("matchBill — an installer bill is never placed by the PO fallback", () => {
  const m = matchBill(bill(), { isMirror: false, installer: true, jobFromRef: null, pos: [po()] });
  assertEquals(m.outcome, "queue");
  assertEquals(m.suggestionReason, "installer_confirm");
  assertEquals(m.suggestedJobId, null);
});

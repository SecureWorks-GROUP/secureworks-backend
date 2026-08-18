// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// A DRAFT invoice is not an invoice — the visible stage ladder must stop
// treating one as proof a card is finished.
//
// The defect: `invoiceDone` in `_deriveMakesafeBoardStage` used
// `hasActiveMakesafeInvoice`, which counts ANY non-VOIDED/DELETED ACCREC row —
// a Xero DRAFT included — as an invoice. A DRAFT invoice's OnlineInvoice link
// cannot take a card payment and a bank transfer against it lands unreconciled
// (CLAUDE.md, "Acceptance Deposit Invoice Invariant"), so a card carrying one
// has had no money go out. Reading it as `invoiceDone` did two visible things:
//
//   1. it short-circuited the card PAST every evidence branch into the close-out
//      doc gate, which then held it in `report_ready` for a missing invoice PDF.
//      Measured on production 2026-08-02: 15 of the 24 cards in the captain's
//      Docs Ready column arrived that way, with no pack, no report and no
//      payable invoice; and
//   2. on a report-only (roof / assessment) card, whose gate wants ONLY the
//      invoice PDF, attaching that one DRAFT PDF satisfied the gate and ARCHIVED
//      the card — work disappearing on the strength of an unsendable invoice.
//
// The fix: `_makesafeInvoiceIsRaised` (AUTHORISED / SUBMITTED / PAID) is the
// invoice term of `invoiceDone`. The captain's 2026-08-02 Docs Ready ruling
// makes a DRAFT invoice a PRE-condition of that column — the thing he reviews
// before approving — so `invoiceIsDraft` and the `readyForReview` path that
// reads it are deliberately UNCHANGED.
//
// Every assertion below is on the pure exported ladder. No network, no Supabase,
// no Xero, no money write. Nothing here touches `ses_money_sealed_at`.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _deriveMakesafeBoardStage,
  _deriveMakesafeSurfacing,
  _makesafeInvoiceIsRaised,
  MAKESAFE_STAGE_LADDER_VERSION,
} from "./index.ts";
import { buildCanonicalMakesafeRows } from "./makesafe_board_read_model.ts";

const NOW = "2026-08-02T12:00:00.000Z";
/** Inside the 7-day completed window relative to NOW. */
const RECENT = "2026-07-30T02:00:00.000Z";
/** Well outside it, so a closed card ages into archive. */
const STALE = "2026-05-01T02:00:00.000Z";

const ASSIGNMENT = [{ id: "a1", status: "scheduled" }];

/** job_documents booleans as `makesafeDocBooleans` produces them. */
const DOCS_WITH_INVOICE = {
  has_invoice_doc: true,
  has_report_doc: false,
  has_swms_doc: false,
};
const DOCS_WITHOUT_INVOICE = {
  has_invoice_doc: false,
  has_report_doc: false,
  has_swms_doc: false,
};

const invoice = (status: string, date = RECENT) => ({
  id: "inv-1",
  job_id: "job-1",
  status,
  invoice_type: "ACCREC",
  reference: "MLB-TEST-1",
  invoice_date: date,
});

/**
 * A live report-only roof card mid-flight: allocated to a trade, no service
 * report, no pack, no send record. The ONLY closure-shaped fact is whatever
 * invoice the caller hands it. This is the shape of the production cards the
 * audit found in Docs Ready.
 */
function roofCard() {
  return {
    job: {
      id: "job-1",
      job_number: "SWMS-TEST-1",
      status: "processing",
      metadata: { makesafe_job_family: "roof_report" },
    },
    detail: {
      substatus: "waiting_on_trade_report",
      external_ref: "MLB-TEST-1",
      report_type: "roof_report",
      cycle_number: 1,
      external_links: [{
        role: "roof_report",
        url: "https://portal.test/wo/1",
      }],
    },
  };
}

function stage(
  card: { job: any; detail: any },
  inv: any,
  docs: any,
  opts: { assignments?: any[]; report?: any; packSent?: boolean; pack?: any } =
    {},
): string {
  return _deriveMakesafeBoardStage(
    card.job,
    card.detail,
    opts.assignments ?? ASSIGNMENT,
    opts.report,
    inv,
    NOW,
    docs,
    opts.packSent,
    opts.pack ?? null,
  );
}

// ── The predicate itself ────────────────────────────────────────────────────

Deno.test("_makesafeInvoiceIsRaised: only an issued invoice counts", () => {
  for (const status of ["AUTHORISED", "SUBMITTED", "PAID"]) {
    assert(
      _makesafeInvoiceIsRaised(invoice(status)),
      `${status} is a raised invoice`,
    );
  }
  // Case-insensitive, because Xero mirrors are not consistently upper-cased.
  assert(_makesafeInvoiceIsRaised(invoice("authorised")));

  assert(
    !_makesafeInvoiceIsRaised(invoice("DRAFT")),
    "a DRAFT invoice has not been raised — it is unsendable and unpayable",
  );
  for (const status of ["VOIDED", "DELETED", "", "SOMETHING_NEW"]) {
    assert(
      !_makesafeInvoiceIsRaised(invoice(status)),
      `${status || "(blank)"} is not a raised invoice`,
    );
  }
  assert(!_makesafeInvoiceIsRaised(null));
  assert(!_makesafeInvoiceIsRaised(undefined));
});

// ── 1. The archive trap (the "known interaction" this must not widen) ───────

Deno.test("a DRAFT invoice + its attached PDF no longer archives a report card", () => {
  const card = roofCard();
  // OLD SHAPE: hasActiveMakesafeInvoice(DRAFT) => invoiceDone; the report-only
  // gate wants ONLY the invoice doc, which is attached; the invoice date is
  // stale => 'archive'. The card vanished off the live board.
  assertEquals(
    stage(card, invoice("DRAFT", STALE), DOCS_WITH_INVOICE),
    "allocated",
    "a card whose only closure evidence is a DRAFT invoice must stay on the board",
  );
  // Same card, recent draft: must not reach `completed` either.
  assertEquals(
    stage(card, invoice("DRAFT", RECENT), DOCS_WITH_INVOICE),
    "allocated",
  );
});

Deno.test(
  "SES U6R: packSent + AUTHORISED completes without substatus complete",
  () => {
    // AJBR-70488 class: closeout wrote MAKESAFE_PACK_SENT | main and left
    // substatus admin_to_send_report. Missing invoice PDF must soft-warn, not
    // hold the card in trade_report_in after a proved send.
    const card = {
      job: {
        id: "job-ajbr-70488",
        job_number: "SWMS-261130",
        status: "processing",
        type: "makesafe",
        completed_at: RECENT,
      },
      detail: {
        substatus: "admin_to_send_report",
        cycle_number: 1,
        report_received_at: RECENT,
      },
    };
    const docsMissingInvoice = {
      has_invoice_doc: false,
      has_report_doc: true,
      has_swms_doc: false,
    };
    assertEquals(
      stage(card, invoice("AUTHORISED", RECENT), docsMissingInvoice, {
        packSent: true,
        report: { id: "report-1" },
      }),
      "completed",
    );
    // Without packSent, AUTHORISED is not a pre-Xero Docs Ready positive — the
    // card stays Trade Report In until a qualifying current DRAFT or a proved
    // send softens close-out. (Attach/report alone cannot invent Docs Ready.)
    assertEquals(
      stage(card, invoice("AUTHORISED", RECENT), docsMissingInvoice, {
        packSent: false,
        report: { id: "report-1" },
      }),
      "trade_report_in",
    );
  },
);

Deno.test("a RAISED invoice + its attached PDF still closes a report card", () => {
  const card = roofCard();
  // Unchanged behaviour: real money went out, the gate is satisfied, and the
  // 7-day clock still decides completed vs archive.
  assertEquals(
    stage(card, invoice("AUTHORISED", RECENT), DOCS_WITH_INVOICE),
    "completed",
  );
  assertEquals(
    stage(card, invoice("AUTHORISED", STALE), DOCS_WITH_INVOICE),
    "archive",
  );
  assertEquals(
    stage(card, invoice("PAID", STALE), DOCS_WITH_INVOICE),
    "archive",
  );
});

// ── 2. The Docs Ready hold ──────────────────────────────────────────────────

Deno.test("a DRAFT invoice no longer parks an unsendable card in Docs Ready", () => {
  const card = roofCard();
  // OLD SHAPE: invoiceDone fired, the close-out gate found no invoice PDF, and
  // returned 'report_ready' — the captain's send queue — for a card with no
  // pack, no report and nothing payable.
  assertEquals(
    stage(card, invoice("DRAFT"), DOCS_WITHOUT_INVOICE),
    "allocated",
    "the card belongs with the trade it is allocated to, not in the send queue",
  );
  // The substatus `waiting_on_trade_report` is itself an Allocated signal, so
  // strip that too: with nothing on the card but a DRAFT invoice, it falls all
  // the way back to New rather than being invented into a later column.
  const bare = {
    job: card.job,
    detail: { ...card.detail, substatus: "company_contact_required" },
  };
  assertEquals(
    stage(bare, invoice("DRAFT"), DOCS_WITHOUT_INVOICE, { assignments: [] }),
    "new",
  );
  assertEquals(
    stage(bare, invoice("DRAFT"), DOCS_WITH_INVOICE, { assignments: [] }),
    "new",
    "attaching the DRAFT invoice PDF must not advance a card either",
  );
});

Deno.test("a RAISED invoice with no PDF is held below Docs Ready", () => {
  const card = roofCard();
  assertEquals(
    stage(card, invoice("AUTHORISED"), DOCS_WITHOUT_INVOICE),
    "allocated",
    "the hard doc gate remains, but AUTHORISED cannot claim pre-Xero Docs Ready",
  );
});

// ── 3. Docs Ready still works for the thing it is FOR ──────────────────────

Deno.test("a drafted-not-sent pack with a DRAFT invoice still surfaces in Docs Ready", () => {
  // The captain's ruling: Docs Ready REQUIRES a DRAFT invoice, so he can see
  // exactly what will go out before approving it. `readyForReview` reads
  // `invoiceIsDraft`, which this change deliberately leaves alone.
  const card = {
    job: {
      id: "job-1",
      job_number: "SWMS-TEST-1",
      status: "processing",
      metadata: { makesafe_job_family: "physical_makesafe" },
    },
    detail: {
      substatus: "admin_to_send_report",
      external_ref: "MLB-TEST-1",
      cycle_number: 1,
      report_received_at: RECENT,
    },
  };
  const pack = { id: "p1", status: "drafted", report_doc_id: "doc-report" };
  assertEquals(
    stage(card, invoice("DRAFT"), DOCS_WITHOUT_INVOICE, {
      report: { id: "r1", status: "submitted" },
      pack,
    }),
    "report_ready",
  );
  const surf = _deriveMakesafeSurfacing(
    card.job,
    card.detail,
    { id: "r1", status: "submitted" },
    invoice("DRAFT"),
    DOCS_WITHOUT_INVOICE,
    undefined,
    pack,
  );
  assert(surf.invoiceIsDraft, "invoiceIsDraft must still see a DRAFT invoice");
  assert(surf.readyForReview, "the drafted-not-sent pack must still surface");
  assert(
    !surf.invoiceAuthorisedLive,
    "a DRAFT invoice is never invoiceAuthorisedLive",
  );
});

Deno.test("the ladder reads the raw docket stamp, never the honesty-gated operator value", () => {
  // Pipeline honesty gates operator-facing pre_xero_docs_ready on portal
  // evidence it cannot load, so a portal-proven report-only card ships
  // pre_xero_docs_ready: false with the raw U4 stamp preserved on
  // docket_pre_xero_docs_ready. u4DocsReady must follow the raw stamp or the
  // card falls out of Docs Ready on the makesafe_pipeline fallback surface.
  const card = {
    job: {
      id: "job-1",
      job_number: "SWMS-TEST-1",
      status: "processing",
      metadata: { makesafe_job_family: "roof_report" },
    },
    detail: {
      substatus: "admin_to_send_report",
      external_ref: "MLB-TEST-1",
      report_type: "roof_report",
      cycle_number: 1,
      report_received_at: RECENT,
    },
  };
  const gatedPack = {
    id: "p1",
    status: "drafted",
    review_state: "U4_BLOCKED",
    report_doc_id: null,
    pre_xero_docs_ready: false,
    docket_pre_xero_docs_ready: true,
  };
  assertEquals(
    stage(card, invoice("DRAFT"), DOCS_WITHOUT_INVOICE, {
      report: { id: "r1", status: "submitted" },
      pack: gatedPack,
    }),
    "report_ready",
  );
  // Legacy packs never carried the split field: the raw stamp still lives on
  // pre_xero_docs_ready and must keep satisfying the ladder unchanged.
  const legacyPack = {
    id: "p1",
    status: "drafted",
    report_doc_id: null,
    pre_xero_docs_ready: true,
  };
  assertEquals(
    stage(card, invoice("DRAFT"), DOCS_WITHOUT_INVOICE, {
      report: { id: "r1", status: "submitted" },
      pack: legacyPack,
    }),
    "report_ready",
  );
  // A genuinely blocked docket (raw stamp false on both fields) still holds
  // the card in Trade Report In — the gate widens nothing.
  const blockedPack = {
    id: "p1",
    status: "drafted",
    report_doc_id: null,
    pre_xero_docs_ready: false,
    docket_pre_xero_docs_ready: false,
  };
  assertEquals(
    stage(card, invoice("DRAFT"), DOCS_WITHOUT_INVOICE, {
      report: { id: "r1", status: "submitted" },
      pack: blockedPack,
    }),
    "trade_report_in",
  );
});

// ── 4. The two terms deliberately NOT changed ──────────────────────────────

Deno.test("operator closure claims still close only with complete docs", () => {
  // `jobs.status = 'invoiced'` and substatus `complete` are OPERATOR
  // declarations, not claims about Xero invoice status, and neither is reachable
  // by merely creating a draft. Measured 2026-08-02: of the 19 board cards
  // carrying a DRAFT invoice, ZERO carry jobs.status='invoiced'.
  const invoicedJob = {
    job: {
      status: "invoiced",
      metadata: { makesafe_job_family: "roof_report" },
    },
    detail: {
      substatus: "waiting_on_trade_report",
      report_type: "roof_report",
      cycle_number: 1,
    },
  };
  assertEquals(stage(invoicedJob, null, DOCS_WITH_INVOICE), "completed");
  // ...and a missing PDF remains blocked, but below pre-Xero Docs Ready.
  assertEquals(stage(invoicedJob, null, DOCS_WITHOUT_INVOICE), "allocated");

  const completeSub = {
    job: {
      status: "processing",
      metadata: { makesafe_job_family: "roof_report" },
    },
    detail: {
      substatus: "complete",
      report_type: "roof_report",
      cycle_number: 1,
    },
  };
  assertEquals(stage(completeSub, null, DOCS_WITH_INVOICE), "completed");
});

Deno.test("a DRAFT invoice on an operator-closed card does not change its stage", () => {
  // Belt and braces: the DRAFT is simply ignored as a closure signal, so a card
  // already closed by an operator claim lands exactly where it did before.
  const card = {
    job: {
      status: "invoiced",
      metadata: { makesafe_job_family: "roof_report" },
    },
    detail: {
      substatus: "waiting_on_trade_report",
      report_type: "roof_report",
      cycle_number: 1,
    },
  };
  assertEquals(
    stage(card, invoice("DRAFT", STALE), DOCS_WITH_INVOICE),
    "archive",
  );
});

// ── 5. Nothing may be ARCHIVED by a DRAFT invoice, at any doc combination ───

Deno.test("no combination of a DRAFT invoice and close-out docs can archive a card", () => {
  const families: Array<{ label: string; card: { job: any; detail: any } }> = [
    { label: "roof (report-only)", card: roofCard() },
    {
      label: "physical make-safe",
      card: {
        job: {
          status: "processing",
          metadata: { makesafe_job_family: "physical_makesafe" },
        },
        detail: { substatus: "waiting_on_trade_report", cycle_number: 1 },
      },
    },
    {
      label: "assessment (report-only)",
      card: {
        job: {
          status: "accepted",
          metadata: { makesafe_job_family: "assessment_report" },
        },
        detail: {
          substatus: "waiting_on_trade_report",
          report_type: "assessment_report",
          cycle_number: 1,
        },
      },
    },
  ];
  const docCombos = [
    { has_invoice_doc: true, has_report_doc: true, has_swms_doc: true },
    { has_invoice_doc: true, has_report_doc: true, has_swms_doc: false },
    DOCS_WITH_INVOICE,
    DOCS_WITHOUT_INVOICE,
  ];
  for (const { label, card } of families) {
    for (const docs of docCombos) {
      for (const date of [RECENT, STALE]) {
        const derived = stage(card, invoice("DRAFT", date), docs);
        assert(
          derived !== "archive" && derived !== "completed",
          `${label} with docs ${
            JSON.stringify(docs)
          } and a ${date} DRAFT invoice derived ${derived}`,
        );
      }
    }
  }
});

// ── 6. The enrich-side copy of `invoiceDone` must not drift ────────────────

Deno.test("enrichMakesafeBoardJob's invoiceDone uses the same raised-invoice term", async () => {
  // `enrichMakesafeBoardJob` keeps its own copy of `invoiceDone` to compute the
  // board's `docs_missing` / `missing_docs` chip. If that copy still counted a
  // DRAFT, the board would advertise a hard doc hold on a card the ladder is no
  // longer holding for docs. It is not exported, so this is pinned at source.
  //
  // The ladder is handed its invoice as the `invoice` parameter; enrich resolves
  // the same row into `invoiceForStage` and passes THAT to the ladder. So the two
  // copies name different identifiers and still read the identical binding — a
  // pin on one spelling would force the enrich copy to re-read the raw row and
  // reintroduce exactly the drift this test exists to catch.
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const raised = (src.match(
    /invoiceDone = _makesafeInvoiceIsRaised\((?:invoice|invoiceForStage)\) \|\|/g,
  ) ?? []).length;
  assertEquals(
    raised,
    2,
    "both the ladder and the enrich copy of invoiceDone must open with the raised-invoice term",
  );
  assertEquals(
    (src.match(/invoiceDone = hasActiveMakesafeInvoice\(/g) ?? []).length,
    0,
    "no invoiceDone assignment may count a DRAFT invoice",
  );

  // `verifiedSent` is the OTHER copied term, and it drifted where `invoiceDone`
  // did not. v5 dropped `substatus === 'complete'` from the ladder because SES
  // U6R closeout never flips that substatus, but the enrich copy kept it — so
  // the ladder completed a pack-sent card while the same row published
  // `docs_missing: true`, a hard doc hold on a card nothing was holding. Both
  // copies must now read `(packSent === true && invoiceAuthorised)`.
  assertEquals(
    // `packSent` in the ladder, `scopedPackSent` in enrich — one pattern, both.
    (src.match(/[Pp]ackSent === true && invoiceAuthorised\) \|\|/g) ?? [])
      .length,
    2,
    "both verifiedSent copies must soften on packSent + a raised invoice alone",
  );
  assertEquals(
    (src.match(
      /invoiceAuthorised &&\s*\n\s*normalizeMakesafeSubstatus\(detail\?\.substatus\) === 'complete'/g,
    ) ?? []).length,
    0,
    "no verifiedSent copy may require substatus 'complete' (dropped at ladder v5)",
  );
});

// ── 7. The ladder now carries a version, and the board publishes it ─────────

Deno.test("the visible ladder's version is pinned and published", () => {
  // Sole pin of this literal, per CLAUDE.md: consumers import the constant.
  // Bumping the ladder is what makes a past measurement attributable to the
  // derivation that produced it, exactly as `SES_STAGE_ENGINE_V2_VERSION` does.
  assertEquals(
    MAKESAFE_STAGE_LADDER_VERSION,
    "makesafe-stage-ladder.v8-raw-docket-stamp",
  );
  // The read model republishes whatever enrich stamped, and null when a caller
  // built the base row without it — never a silent default that would attribute
  // a v1 reading to v2.
  const [stamped] = buildCanonicalMakesafeRows(
    [{
      id: "job-1",
      job_number: "SWMS-TEST-1",
      status: "processing",
      board_stage: "allocated",
      board_stage_engine_version: MAKESAFE_STAGE_LADDER_VERSION,
      makesafe_details: {
        substatus: "waiting_on_trade_report",
        cycle_number: 1,
      },
    }],
    {},
  );
  assertEquals(
    stamped.declared_stage_engine_version,
    MAKESAFE_STAGE_LADDER_VERSION,
  );
  const [unstamped] = buildCanonicalMakesafeRows(
    [{
      id: "job-2",
      job_number: "SWMS-TEST-2",
      status: "processing",
      board_stage: "allocated",
      makesafe_details: {
        substatus: "waiting_on_trade_report",
        cycle_number: 1,
      },
    }],
    {},
  );
  assertEquals(unstamped.declared_stage_engine_version, null);
});

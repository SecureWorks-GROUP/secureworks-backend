// Tests for card-unique unlinked-invoice matching.
//
// Two layers. The unit tests pin each guard on hand-built rows. The cohort
// tests re-run the matcher over `makesafe_invoice_reference_match_fixture.json`
// - the real production population captured read-only on 2026-08-01 - and
// assert the exact 51-card cohort and the exact 28 ambiguity exclusions. The
// fixture is the matcher's INPUT, so those tests re-derive the answer rather
// than comparing the committed output against itself.
//
// Context: `docs/evidence/ses-c3-invoice-link-seal-conflict-2026-08-01.md`.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  builderReferenceDigits,
  deriveSesUnlinkedInvoiceMatches,
  digitRuns,
  indexSesInvoiceMatches,
  invoiceNamesBuilderReference,
  isUnlinkedIssuedAccrec,
  SES_MIN_REFERENCE_DIGITS,
  type SesMatchInvoice,
  type SesMatchJob,
  sesUnlinkedInvoiceDetail,
} from "./makesafe_invoice_reference_match.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./makesafe_invoice_reference_match_fixture.json", import.meta.url),
  ),
) as { jobs: SesMatchJob[]; invoices: SesMatchInvoice[] };

function invoice(
  over: Partial<SesMatchInvoice> & { id: string },
): SesMatchInvoice {
  return {
    job_id: null,
    invoice_type: "ACCREC",
    status: "PAID",
    reference: "",
    invoice_number: over.id,
    total: "100.00",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Digit grammar
// ---------------------------------------------------------------------------

Deno.test("digitRuns splits on non-digits and keeps every run", () => {
  assertEquals(digitRuns("MLB-26344PO-57087"), ["26344", "57087"]);
  assertEquals(digitRuns("AJBR 66961 / SWMS-26420"), ["66961", "26420"]);
  assertEquals(digitRuns(null), []);
});

Deno.test("builderReferenceDigits drops runs shorter than the floor", () => {
  assertEquals(SES_MIN_REFERENCE_DIGITS, 5);
  // BWCWA-6760 carries a four-digit run: too short to be invoice identity.
  assertEquals(builderReferenceDigits("BWCWA-6760"), []);
  assertEquals(builderReferenceDigits("MLB-25244"), ["25244"]);
  // A reference embedding a PO contributes BOTH runs, so a match on the PO half
  // is visible in matched_digits rather than silent.
  assertEquals(builderReferenceDigits("MLB-26344PO-57087"), ["26344", "57087"]);
});

Deno.test("matching is whole-run, never substring", () => {
  // 6781 sits inside 67810 but is not a whole run: this is the tranche-2
  // failure mode that attached another builder's paperwork.
  assertEquals(invoiceNamesBuilderReference("INV 67810", ["6781"]), []);
  assertEquals(invoiceNamesBuilderReference("AJBR 67810", ["67810"]), [
    "67810",
  ]);
  assertEquals(invoiceNamesBuilderReference("anything", []), []);
});

Deno.test("only unlinked issued ACCREC rows are eligible", () => {
  assert(isUnlinkedIssuedAccrec(invoice({ id: "a" })));
  assert(!isUnlinkedIssuedAccrec(invoice({ id: "b", job_id: "job-1" })));
  assert(!isUnlinkedIssuedAccrec(invoice({ id: "c", status: "DRAFT" })));
  assert(!isUnlinkedIssuedAccrec(invoice({ id: "d", status: "VOIDED" })));
  assert(!isUnlinkedIssuedAccrec(invoice({ id: "e", invoice_type: "ACCPAY" })));
  assert(isUnlinkedIssuedAccrec(invoice({ id: "f", status: "authorised" })));
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

Deno.test("a card-unique candidate matches", () => {
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    [{ id: "job-1", job_number: "SWMS-1", external_ref: "MLB-25244" }],
    [invoice({ id: "inv-1", reference: "MLB-25244" })],
  );
  assertEquals(exclusions, []);
  assertEquals(matches.length, 1);
  assertEquals(matches[0].job_id, "job-1");
  assertEquals(matches[0].matched_digits, ["25244"]);
});

Deno.test("two candidate invoices exclude the card", () => {
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    [{ id: "job-1", job_number: "SWMS-1", external_ref: "MLB-25244" }],
    [
      invoice({ id: "inv-1", reference: "MLB-25244" }),
      invoice({ id: "inv-2", reference: "claim 25244 second" }),
    ],
  );
  assertEquals(matches, []);
  assertEquals(exclusions.length, 1);
  assertEquals(exclusions[0].reason, "multiple_invoice_candidates");
});

Deno.test("a shared builder reference excludes BOTH cards, symmetrically", () => {
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    [
      { id: "job-1", job_number: "SWMS-1", external_ref: "AJBR 67005" },
      { id: "job-2", job_number: "SWMS-2", external_ref: "AJBR 67005" },
    ],
    [invoice({ id: "inv-1", reference: "AJBR 67005" })],
  );
  assertEquals(matches, []);
  assertEquals(exclusions.length, 2);
  assertEquals(
    new Set(exclusions.map((e) => e.reason)),
    new Set(["builder_reference_shared_with_other_job"]),
  );
});

Deno.test("a NON-board job still contests a reference", () => {
  // Guard 2 must consult the full job population. A cancelled or non-board
  // sibling that shares the claim still makes ownership ambiguous; ignoring it
  // would manufacture false uniqueness.
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    [
      { id: "job-1", job_number: "SWMS-1", external_ref: "MLB-25244" },
      {
        id: "job-2",
        job_number: "OLD-1",
        external_ref: "MLB-25244",
        on_board: false,
      },
    ],
    [invoice({ id: "inv-1", reference: "MLB-25244" })],
  );
  assertEquals(matches, []);
  // Only the board card is reported; the off-board sibling is not a card.
  assertEquals(exclusions.length, 1);
  assertEquals(exclusions[0].job_id, "job-1");
  assertEquals(exclusions[0].reason, "builder_reference_shared_with_other_job");
});

Deno.test("one invoice claimed by two cards is dropped from both", () => {
  // Distinct references, so guard 2 passes, but both resolve to one invoice.
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    [
      { id: "job-1", job_number: "SWMS-1", external_ref: "MLB-25244" },
      { id: "job-2", job_number: "SWMS-2", external_ref: "MLB-25245" },
    ],
    [invoice({ id: "inv-1", reference: "MLB-25244 / MLB-25245" })],
  );
  assertEquals(matches, []);
  assertEquals(exclusions.length, 2);
  assertEquals(
    new Set(exclusions.map((e) => e.reason)),
    new Set(["invoice_claimed_by_multiple_cards"]),
  );
});

Deno.test("a card with no usable reference is silent, not an exclusion", () => {
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    [
      { id: "job-1", job_number: "SWMS-1", external_ref: null },
      { id: "job-2", job_number: "SWMS-2", external_ref: "BWCWA-6760" },
    ],
    [invoice({ id: "inv-1", reference: "6760" })],
  );
  assertEquals(matches, []);
  assertEquals(exclusions, []);
});

Deno.test("an already-linked invoice is never re-matched", () => {
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    [{ id: "job-1", job_number: "SWMS-1", external_ref: "MLB-25244" }],
    [invoice({ id: "inv-1", reference: "MLB-25244", job_id: "job-9" })],
  );
  assertEquals(matches, []);
  assertEquals(exclusions, []);
});

Deno.test("the reported detail names the invoice and why it is unlinked", () => {
  const { matches } = deriveSesUnlinkedInvoiceMatches(
    [{ id: "job-1", job_number: "SWMS-1", external_ref: "MLB-25244" }],
    [invoice({
      id: "inv-1",
      invoice_number: "INV-0551",
      reference: "MLB-25244",
    })],
  );
  const detail = sesUnlinkedInvoiceDetail(matches[0]);
  assert(detail.includes("INV-0551"));
  assert(detail.includes("25244"));
  assert(detail.includes("money seal"));
});

// ---------------------------------------------------------------------------
// The real production cohort
// ---------------------------------------------------------------------------

Deno.test("production fixture reproduces the 51-card cohort", () => {
  const { matches } = deriveSesUnlinkedInvoiceMatches(
    fixture.jobs,
    fixture.invoices,
  );
  assertEquals(matches.length, 51);

  const money = matches.reduce(
    (sum, m) => sum + Number(m.invoice.total ?? 0),
    0,
  );
  assertEquals(Number(money.toFixed(2)), 27782.70);

  // Every match is a distinct invoice funding a distinct card.
  assertEquals(new Set(matches.map((m) => m.invoice.id)).size, 51);
  assertEquals(new Set(matches.map((m) => m.job_id)).size, 51);

  // Every matched invoice is genuinely unlinked and issued.
  for (const match of matches) {
    assert(
      isUnlinkedIssuedAccrec(match.invoice),
      `${match.invoice.invoice_number} is not an unlinked issued ACCREC`,
    );
    assert(match.matched_digits.length > 0);
  }
});

Deno.test("production fixture reproduces the 28 ambiguity exclusions", () => {
  const { exclusions } = deriveSesUnlinkedInvoiceMatches(
    fixture.jobs,
    fixture.invoices,
  );
  assertEquals(exclusions.length, 28);

  const byReason: Record<string, number> = {};
  for (const row of exclusions) {
    byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
  }
  assertEquals(byReason, {
    builder_reference_shared_with_other_job: 26,
    multiple_invoice_candidates: 2,
  });

  // The pairs the adversarial verification named must all be excluded, and
  // excluded on BOTH sides - this is the guard Codex proved was missing.
  const excluded = new Set(exclusions.map((row) => row.job_number));
  for (
    const pair of [
      ["SWMS-26428", "SWMS-26663"],
      ["SWMS-261059", "SWMS-26606"],
      ["SWMS-261086", "SWMS-26448"],
      ["SWMS-261087", "SWMS-26447"],
      ["SWMS-261095", "SWMS-26440"],
    ]
  ) {
    for (const card of pair) {
      assert(excluded.has(card), `${card} should be excluded as ambiguous`);
    }
  }

  // SWMS-261024/261025 both match INV-1080 and INV-1081: two candidates each.
  for (const card of ["SWMS-261024", "SWMS-261025"]) {
    const row = exclusions.find((e) => e.job_number === card);
    assert(row, `${card} should be excluded`);
    assertEquals(row!.reason, "multiple_invoice_candidates");
  }
});

Deno.test("no excluded card also appears as a match", () => {
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    fixture.jobs,
    fixture.invoices,
  );
  const matched = new Set(matches.map((m) => m.job_id));
  for (const row of exclusions) {
    assert(
      !matched.has(row.job_id),
      `${row.job_number} is both matched and excluded`,
    );
  }
  assertEquals(indexSesInvoiceMatches(matches).size, matches.length);
});

Deno.test("the fixture carries no deposit-shaped reference", () => {
  // Linking is the switch for the daily-digest deposit chase SMS
  // (`daily-digest` gates it on job_id). The ruler-side fix writes nothing at
  // all, but a DEP-shaped reference entering this cohort is still worth
  // catching, since it would signal a card whose money path is a live chase.
  const { matches } = deriveSesUnlinkedInvoiceMatches(
    fixture.jobs,
    fixture.invoices,
  );
  const dep = matches.filter((m) => /dep/i.test(String(m.invoice.reference)));
  assertEquals(dep.map((m) => m.invoice.invoice_number), []);
});

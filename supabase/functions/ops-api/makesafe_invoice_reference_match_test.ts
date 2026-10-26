// deno-lint-ignore-file no-import-prefix
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
  sesMatchJobIdentityDigits,
  sesMatchJobPurchaseOrders,
  sesMatchPoRelation,
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

Deno.test("production fixture reproduces the 51-card cohort: 50 matches plus 1 manual review", () => {
  // Until DSP-T3-GAP-1 all 51 were matches. Guard 5 moves the one pair with
  // one-sided PO evidence (SWMS-26931, INV-1051 $1,980.00) to `manual_review`;
  // the other 50 are unchanged, and the union is still the 51-card cohort.
  const { matches, manual_review } = deriveSesUnlinkedInvoiceMatches(
    fixture.jobs,
    fixture.invoices,
  );
  assertEquals(matches.length, 50);
  assertEquals(manual_review.length, 1);
  assertEquals(manual_review[0].job_number, "SWMS-26931");
  assertEquals(manual_review[0].invoice.invoice_number, "INV-1051");
  assertEquals(manual_review[0].review_status, "manual_review");
  assertEquals(manual_review[0].reason, "po_indeterminate");

  const money = (rows: { invoice: SesMatchInvoice }[]) =>
    Number(
      rows.reduce((sum, m) => sum + Number(m.invoice.total ?? 0), 0).toFixed(
        2,
      ),
    );
  assertEquals(money(matches), 25802.70);
  assertEquals(money(manual_review), 1980.00);
  assertEquals(money([...matches, ...manual_review]), 27782.70);

  // Every match is a distinct invoice funding a distinct card.
  const cohort = [...matches, ...manual_review];
  assertEquals(new Set(cohort.map((m) => m.invoice.id)).size, 51);
  assertEquals(new Set(cohort.map((m) => m.job_id)).size, 51);

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
  const { matches, exclusions, manual_review } =
    deriveSesUnlinkedInvoiceMatches(
      fixture.jobs,
      fixture.invoices,
    );
  const matched = new Set(
    [...matches, ...manual_review].map((m) => m.job_id),
  );
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

// ---------------------------------------------------------------------------
// Card identity: claim reference AND the card's own purchase order
//
// `makesafe_docs_ready_invoice.ts` has always read
// `jobs.metadata.builder_po_number` as card identity. This module read only the
// claim reference, so the two disagreed about what identifies a card. These
// tests pin the corrected grammar and, just as importantly, pin that a caller
// which does NOT supply a purchase order keeps its previous answer exactly.
// ---------------------------------------------------------------------------

Deno.test("identity digits are the claim reference plus the card's own PO", () => {
  assertEquals(
    sesMatchJobIdentityDigits({ id: "j", external_ref: "MLB-27037" }),
    ["27037"],
  );
  assertEquals(
    sesMatchJobIdentityDigits({
      id: "j",
      external_ref: "MLB-27037",
      builder_po_number: "PO-56459",
    }),
    ["27037", "56459"],
  );
  // Claim digits first, PO after: an existing consumer's `matched_digits`
  // ordering cannot shift when the PO adds nothing.
  assertEquals(
    sesMatchJobIdentityDigits({ id: "j", builder_po_number: "PO-56459" }),
    ["56459"],
  );
  // The floor still applies to the PO half.
  assertEquals(
    sesMatchJobIdentityDigits({ id: "j", builder_po_number: "PO-6771" }),
    [],
  );
});

Deno.test("a card whose reference already embeds its own PO never contests itself", () => {
  // The regression this guards is real and was measured against production: the
  // naive concatenation yields the run "56387" twice, the ownership map counts
  // the card as two owners of its own digits, and guard 2 then destroys a
  // CORRECT match. Live shape, SWMS-261018 against its own AUTHORISED INV-1083.
  const job = {
    id: "job-1",
    job_number: "SWMS-261018",
    external_ref: "MLB-24881PO-56387",
    builder_po_number: "PO-56387",
  };
  assertEquals(sesMatchJobIdentityDigits(job), ["24881", "56387"]);

  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    [job],
    [invoice({ id: "inv-1", reference: "MLB-24881PO-56387" })],
  );
  assertEquals(exclusions, []);
  assertEquals(matches.length, 1);
  assertEquals(matches[0].matched_digits, ["24881", "56387"]);
});

Deno.test("a PO shared by two cards contests, exactly as a claim does", () => {
  // Live: SWMS-26929 and SWMS-26930 both declare PO-55622. Identity that is not
  // card-unique must exclude both sides, never pick a winner.
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    [
      { id: "job-1", job_number: "SWMS-1", builder_po_number: "PO-55622" },
      { id: "job-2", job_number: "SWMS-2", builder_po_number: "PO-55622" },
    ],
    [invoice({ id: "inv-1", reference: "MLB-26721PO-55622" })],
  );
  assertEquals(matches, []);
  assertEquals(exclusions.length, 2);
  assertEquals(
    new Set(exclusions.map((e) => e.reason)),
    new Set(["builder_reference_shared_with_other_job"]),
  );
});

Deno.test("siblings on one claim stay excluded when the PO cannot separate them", () => {
  // The three live Floreat cards share claim MLB-27037 and differ only by PO.
  // Adding the PO does NOT rescue them: the one eligible invoice still names
  // the shared claim, so it is a candidate for all three and no card owns it
  // uniquely. Withholding here is the correct answer, and this test exists so
  // nobody "fixes" it by preferring the PO-matching candidate - that would
  // attribute money to a card on evidence that does not single it out.
  const jobs: SesMatchJob[] = [
    {
      id: "job-1",
      job_number: "SWMS-261019",
      external_ref: "MLB-27037",
      builder_po_number: "PO-56395",
    },
    {
      id: "job-2",
      job_number: "SWMS-261020",
      external_ref: "MLB-27037",
      builder_po_number: "PO-56397",
    },
    {
      id: "job-3",
      job_number: "SWMS-261021",
      external_ref: "MLB-27037",
      builder_po_number: "PO-56459",
    },
  ];
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    jobs,
    [invoice({ id: "inv-1", reference: "MLB-27037" })],
  );
  assertEquals(matches, []);
  assertEquals(exclusions.length, 3);
});

// The two synthetic-PO cohort tests below give EVERY card a declared purchase
// order. That moves cards through the PO guards (DSP-T3-GAP-1), and only
// through them:
// - The one fixture card whose invoice names its own PO (SWMS-26931, INV-1051
//   `MLB-24664PO-55370`, a manual-review pair at base) now faces a declared PO
//   that differs from the invoice's, so it moves to a `po_mismatch` exclusion
//   (guard 4).
// - A card whose invoice names no PO now has one-sided PO evidence, so it
//   moves from `matches` to `manual_review` (guard 5). Only a card whose
//   invoice names the PO it declares stays a match.
// The candidate set itself (matches plus manual review) and every other
// exclusion stay byte-identical, which is what keeps these tests' original
// properties (unnamed identity contributes nothing; de-duplication) intact.
const PO_MISMATCH_FIXTURE_JOB = "1106dd9c-d459-4e2d-a73d-5df416363a7a";

function assertCohortMovedOnlyByPoGuards(
  base: ReturnType<typeof deriveSesUnlinkedInvoiceMatches>,
  moved: ReturnType<typeof deriveSesUnlinkedInvoiceMatches>,
) {
  const pairs = (r: ReturnType<typeof deriveSesUnlinkedInvoiceMatches>) =>
    [...r.matches, ...r.manual_review]
      .map((m) => `${m.job_id}:${m.invoice.id}`)
      .sort();
  assertEquals(
    base.manual_review.map((m) => [m.job_id, m.invoice.reference]),
    [[PO_MISMATCH_FIXTURE_JOB, "MLB-24664PO-55370"]],
  );
  assertEquals(
    pairs(moved),
    pairs(base).filter((p) => !p.startsWith(`${PO_MISMATCH_FIXTURE_JOB}:`)),
  );
  // A match can survive only where the invoice names a PO the card declares
  // (SWMS-261018's `MLB-24881PO-56387` in the redundant-PO case).
  for (const match of moved.matches) {
    assert(
      /po[-\s]?\d+/i.test(String(match.invoice.reference)),
      `${match.job_number} kept a match whose invoice names no PO`,
    );
  }
  for (const review of moved.manual_review) {
    assertEquals(review.reason, "po_indeterminate");
    assert(review.detail.includes("names no PO"));
  }
  assertEquals(
    moved.exclusions
      .filter((e) => e.reason !== "po_mismatch")
      .map((e) => `${e.job_id}:${e.reason}`),
    base.exclusions.map((e) => `${e.job_id}:${e.reason}`),
  );
  assertEquals(
    moved.exclusions
      .filter((e) => e.reason === "po_mismatch")
      .map((e) => e.job_id),
    [PO_MISMATCH_FIXTURE_JOB],
  );
}

Deno.test("identity no invoice names moves the cohort only through the PO guards", () => {
  // The C1 safety property: a consumer that cannot reach `jobs.metadata` and
  // supplies `external_ref` ALONE gets the same answer as the PO-aware
  // consumers, because identity no eligible invoice names contributes nothing.
  //
  // The fixture carries no `builder_po_number` at all, so stripping the field
  // would assert nothing. This adds one instead: every job gets a card-unique
  // synthetic purchase order whose digits no invoice reference names.
  //
  // The first cards get a DECOY - the leading `SES_MIN_REFERENCE_DIGITS` of a
  // LONGER invoice run, so a whole-run comparison never matches it while a
  // substring test would. That is what makes this test able to fail: leak PO
  // digits into candidate matching by substring and the decoys attach invoices,
  // moving both the cohort and the exclusions. (De-duplication is pinned by the
  // redundant-PO test below, which is the mutation-proof for that half.)
  const invoiceRuns = new Set(
    fixture.invoices.flatMap((inv) => digitRuns(inv.reference)),
  );
  const jobRuns = new Set(
    fixture.jobs.flatMap((job) => digitRuns(job.external_ref)),
  );
  const taken = new Set([...invoiceRuns, ...jobRuns]);
  const decoys = [
    ...new Set(
      [...invoiceRuns]
        .filter((run) => run.length > SES_MIN_REFERENCE_DIGITS)
        .map((run) => run.slice(0, SES_MIN_REFERENCE_DIGITS)),
    ),
  ].filter((run) => !taken.has(run));
  assert(decoys.length > 0, "the fixture must supply substring decoys");

  const syntheticPoDigits = fixture.jobs.map((_job, index) =>
    index < decoys.length ? decoys[index] : `7${String(index).padStart(6, "0")}`
  );
  assertEquals(
    new Set(syntheticPoDigits).size,
    syntheticPoDigits.length,
    "synthetic purchase orders must be card-unique",
  );
  for (const digits of syntheticPoDigits) {
    assert(
      !taken.has(digits),
      `synthetic ${digits} collides with real identity`,
    );
  }

  const base = deriveSesUnlinkedInvoiceMatches(fixture.jobs, fixture.invoices);
  const withUnnamedPo = deriveSesUnlinkedInvoiceMatches(
    fixture.jobs.map((job, index) => ({
      ...job,
      builder_po_number: `PO-${syntheticPoDigits[index]}`,
    })),
    fixture.invoices,
  );
  assertCohortMovedOnlyByPoGuards(base, withUnnamedPo);
});

Deno.test("a redundant PO moves the cohort only through the PO guards", () => {
  // The self-contest regression at COHORT scale, not just on one hand-built
  // row. The commonest live shape is a card whose `external_ref` already embeds
  // its own purchase order, so re-declaring that same PO on every fixture job
  // must move nothing. Without the de-duplication in
  // `sesMatchJobIdentityDigits` this fails loudly: every such card becomes its
  // own guard-2 rival and loses a correct match.
  const base = deriveSesUnlinkedInvoiceMatches(fixture.jobs, fixture.invoices);
  const redundantPo = deriveSesUnlinkedInvoiceMatches(
    fixture.jobs.map((job) => ({
      ...job,
      // The job's own longest identity run, restated as a PO token.
      builder_po_number: builderReferenceDigits(job.external_ref)
        .map((digits) => `PO-${digits}`)
        .join(" ") || null,
    })),
    fixture.invoices,
  );
  assertCohortMovedOnlyByPoGuards(base, redundantPo);
});

// ---------------------------------------------------------------------------
// Guard 4: po_mismatch (DSP-T3-GAP-1)
// ---------------------------------------------------------------------------

Deno.test("po_mismatch: same claim, different PO is excluded, not matched", () => {
  // The CFO-15 shape: the claim digits alone used to be enough, so an invoice
  // for another purchase order on the same claim attached to this card.
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    [{
      id: "job-1",
      job_number: "SWMS-1",
      external_ref: "MLB-27037PO-2222",
    }],
    [invoice({ id: "inv-1", reference: "MLB-27037PO-1111" })],
  );
  assertEquals(matches, []);
  assertEquals(exclusions.length, 1);
  assertEquals(exclusions[0].reason, "po_mismatch");
  assert(exclusions[0].detail.includes("1111"));
  assert(exclusions[0].detail.includes("2222"));
});

Deno.test("po_mismatch: a declared builder_po_number counts, token or bare digits", () => {
  for (const declared of ["PO-2222", "2222", "po 2222"]) {
    const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
      [{
        id: "job-1",
        job_number: "SWMS-1",
        external_ref: "MLB-27037",
        builder_po_number: declared,
      }],
      [invoice({ id: "inv-1", reference: "MLB-27037PO-1111" })],
    );
    assertEquals(matches, [], declared);
    assertEquals(exclusions.map((e) => e.reason), ["po_mismatch"], declared);
  }
});

Deno.test("po_mismatch: an equal PO still matches", () => {
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    [{
      id: "job-1",
      job_number: "SWMS-1",
      external_ref: "MLB-27037",
      builder_po_number: "PO-56395",
    }],
    [invoice({ id: "inv-1", reference: "MLB-27037PO-56395" })],
  );
  assertEquals(exclusions, []);
  assertEquals(matches.length, 1);
});

Deno.test("po_indeterminate: a one-sided PO is manual review, never a match", () => {
  // Keeping the candidate visible is not proof it is right (Codex, 19 Oct):
  // the pair is neither refused nor accepted, it is reported on
  // `manual_review` so a consumer reading `matches` can never take it as an
  // accepted match. Both directions: invoice-only PO and card-only PO.
  const job: SesMatchJob = {
    id: "job-1",
    job_number: "SWMS-1",
    external_ref: "MLB-24664",
  };
  const inv = invoice({ id: "inv-1", reference: "MLB-24664PO-55370" });
  const invoiceOnly = deriveSesUnlinkedInvoiceMatches([job], [inv]);
  assertEquals(invoiceOnly.matches, []);
  assertEquals(invoiceOnly.exclusions, []);
  assertEquals(invoiceOnly.manual_review.length, 1);
  assertEquals(invoiceOnly.manual_review[0].review_status, "manual_review");
  assertEquals(invoiceOnly.manual_review[0].reason, "po_indeterminate");
  assertEquals(invoiceOnly.manual_review[0].invoice.id, "inv-1");
  assert(invoiceOnly.manual_review[0].detail.includes("55370"));
  assertEquals(sesMatchPoRelation(job, inv), "po_indeterminate");

  const cardOnly = deriveSesUnlinkedInvoiceMatches(
    [{ ...job, external_ref: "MLB-24664PO-55370" }],
    [invoice({ id: "inv-2", reference: "MLB-24664" })],
  );
  assertEquals(cardOnly.matches, []);
  assertEquals(cardOnly.exclusions, []);
  assertEquals(cardOnly.manual_review.map((m) => m.reason), [
    "po_indeterminate",
  ]);
  assert(cardOnly.manual_review[0].detail.includes("names no PO"));
});

Deno.test("po_mismatch never creates a match: a refused card still contests its invoice", () => {
  // V's B1 on fad6a11. Card A's claim and invoice agree but the POs differ;
  // card B names the invoice's PO under a different claim. main refuses both
  // (two claimants). If guard 4 dropped A before guard 3 counted claimants, B
  // would win an invoice whose claim is A's.
  for (
    const cardB of [
      { id: "job-b", job_number: "SWMS-B", external_ref: "MLB-80000PO-55555" },
      {
        id: "job-b",
        job_number: "SWMS-B",
        external_ref: "MLB-80000",
        builder_po_number: "55555",
      },
    ] as SesMatchJob[]
  ) {
    const { matches, manual_review, exclusions } =
      deriveSesUnlinkedInvoiceMatches(
        [
          {
            id: "job-a",
            job_number: "SWMS-A",
            external_ref: "MLB-90001PO-22222",
          },
          cardB,
        ],
        [invoice({ id: "inv-1", reference: "MLB-90001PO-55555" })],
      );
    assertEquals(matches, [], JSON.stringify(cardB));
    assertEquals(manual_review, [], JSON.stringify(cardB));
    assertEquals(
      exclusions.map((e) => `${e.job_number}:${e.reason}`).sort(),
      [
        "SWMS-A:invoice_claimed_by_multiple_cards",
        "SWMS-B:invoice_claimed_by_multiple_cards",
      ],
    );
  }
});

Deno.test("po_indeterminate: a contested invoice is still excluded, not reviewed", () => {
  // Guard 3 runs before guard 5, so an invoice two cards claim is excluded on
  // both, whatever its PO evidence.
  const { matches, exclusions, manual_review } =
    deriveSesUnlinkedInvoiceMatches(
      [
        { id: "job-1", job_number: "SWMS-1", external_ref: "MLB-11111" },
        { id: "job-2", job_number: "SWMS-2", external_ref: "MLB-22222" },
      ],
      [invoice({ id: "inv-1", reference: "MLB-11111 MLB-22222 PO-55370" })],
    );
  assertEquals(matches, []);
  assertEquals(manual_review, []);
  assertEquals(exclusions.map((e) => e.reason), [
    "invoice_claimed_by_multiple_cards",
    "invoice_claimed_by_multiple_cards",
  ]);
});

Deno.test("po_mismatch: relation and declared POs read the deployed PO grammar", () => {
  assertEquals(
    sesMatchJobPurchaseOrders({
      id: "j",
      external_ref: "MLB-24881PO-56387",
      builder_po_number: "PO-56387",
    }),
    ["56387"],
  );
  assertEquals(
    sesMatchJobPurchaseOrders({
      id: "j",
      external_ref: "MLB-24881",
      builder_po_number: null,
    }),
    [],
  );
  assertEquals(
    sesMatchPoRelation(
      { id: "j", external_ref: "MLB-24881" },
      invoice({ id: "i", reference: "MLB-24881" }),
    ),
    "same_work",
  );
  assertEquals(
    sesMatchPoRelation(
      { id: "j", external_ref: "MLB-24881", builder_po_number: "PO-2" },
      invoice({ id: "i", reference: "MLB-24881 PO-1" }),
    ),
    "distinct_po",
  );
});

Deno.test("po guards: every production match agrees on the PO", () => {
  // Every accepted match is same_work; the one one-sided pair is on
  // manual_review; no fixture pair is distinct_po.
  const { matches, manual_review, exclusions } =
    deriveSesUnlinkedInvoiceMatches(fixture.jobs, fixture.invoices);
  const byId = new Map(fixture.jobs.map((job) => [job.id, job]));
  for (const m of matches) {
    assertEquals(
      sesMatchPoRelation(byId.get(m.job_id)!, m.invoice),
      "same_work",
    );
  }
  for (const m of manual_review) {
    assertEquals(
      sesMatchPoRelation(byId.get(m.job_id)!, m.invoice),
      "po_indeterminate",
    );
  }
  assertEquals(exclusions.filter((e) => e.reason === "po_mismatch"), []);
});

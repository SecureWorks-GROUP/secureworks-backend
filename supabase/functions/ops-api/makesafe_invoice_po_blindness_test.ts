// deno-lint-ignore-file no-import-prefix
//
// Regression suite for the Koondoola double-bill (2026-08-06).
//
// SWMS-261025 minted DRAFT INV-1140 (`MLB-27093`, $255 ex) on top of AUTHORISED INV-1080
// (`MLB-27093PO-56481`, $390 ex, 30 July) for the same work. Three guards let it through:
//
//   1. `resolveExistingInvoice` compared reference STRINGS and treated a claim-only reference beside
//      a PO-bearing one as "different PO, therefore different work".
//   2. `xero_invoices.job_id` was NULL on both authorised invoices, so the job_id tier saw nothing.
//   3. The card's own indexed probe recorded ambiguity `sibling_po` and still returned
//      `allows_create: true` — the ambiguity was a warning, not a refusal.
//
// Every case below is a REAL production pair, read from the live mirror on 2026-08-06, because the
// hard part of this defect is that the one-sided PO shape is BOTH a duplicate and a legitimate
// second job depending on the card. See docs/evidence/ses-duplicate-guard-po-blindness-2026-08-06.md.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveExistingInvoice } from "./makesafe_send_pack.ts";
import {
  resolveSesInvoiceDuplicates,
  type SesInvoiceIndexRow,
} from "./makesafe_invoice_duplicate_resolver.ts";
import { composeInvoiceReferenceWithPo } from "./ses_invoice_reference_grain.ts";

/** Koondoola SWMS-261025. */
const KOONDOOLA_JOB = "9d7e35ae-94b9-4142-a28b-61ea6c7dccb6";
/** SWMS-26938 Noranda, the card that legitimately carries its own PO on claim MLB-24732. */
const NORANDA_PO_JOB = "c903de5b-0101-4d06-8ed6-accc94a5dc42";
/** SWMS-26526 Noranda, the earlier claim-only card on that same claim. */
const NORANDA_BASE_JOB = "56ee7677-4e68-4c3d-b407-d82f87f1c1f9";

function indexRow(
  overrides: Partial<SesInvoiceIndexRow> = {},
): SesInvoiceIndexRow {
  return {
    job_id: null,
    xero_invoice_id: "xero-1080",
    invoice_number: "INV-1080",
    status: "AUTHORISED",
    reference: "MLB-27093PO-56481",
    invoice_type: "ACCREC",
    ...overrides,
  };
}

// ── 1. The exact live pair now matches and refuses ───────────────────────────────────────────────

Deno.test("live pair: MLB-27093 against unlinked AUTHORISED MLB-27093PO-56481 refuses the mint", () => {
  // The exact rows that produced the double bill. INV-1080 carries job_id NULL, which is precisely
  // why the card could not be told it already had an invoice.
  const rows = [{
    job_id: null,
    status: "AUTHORISED",
    invoice_number: "INV-1080",
    reference: "MLB-27093PO-56481",
    xero_invoice_id: "xero-1080",
    total: 429,
  }];
  const hit = resolveExistingInvoice(rows, KOONDOOLA_JOB, "MLB-27093");
  assert(hit, "the already-authorised invoice must block a second mint");
  assertEquals(hit.invoice_number, "INV-1080");
  assertEquals(hit.status, "AUTHORISED");
});

Deno.test("live pair: the reverse direction refuses too, whichever side carries the PO", () => {
  // After the reference composition below, OUR side is the longer string. The substring tier only
  // ever asks whether the CANDIDATE contains our reference, so this direction needs the claim-base
  // tier — the pair must not become permitted merely by improving our own reference grain.
  const rows = [{
    job_id: null,
    status: "AUTHORISED",
    invoice_number: "INV-1080",
    reference: "MLB-27093",
    xero_invoice_id: "xero-1080",
  }];
  const hit = resolveExistingInvoice(
    rows,
    KOONDOOLA_JOB,
    "MLB-27093PO-56481",
  );
  assert(
    hit,
    "a claim-only invoice must block a PO-bearing mint on the same claim",
  );
  assertEquals(hit.match_method, "reference_po_base");
});

Deno.test("live pair: composing the card's own PO makes it an EXACT reference match", () => {
  // Koondoola's intake case knew both halves all along: builder_wo_canonical MLB-27093 and
  // builder_po_canonical PO-56481. The adapter's builder_reference drops the PO.
  const composed = composeInvoiceReferenceWithPo("MLB-27093", "PO-56481");
  assertEquals(composed.reference, "MLB-27093PO-56481");
  assertEquals(composed.grain, "builder_reference_with_composed_po");
  assertEquals(composed.purchase_order, "56481");

  const rows = [{
    job_id: null,
    status: "AUTHORISED",
    invoice_number: "INV-1080",
    reference: "MLB-27093PO-56481",
    xero_invoice_id: "xero-1080",
  }];
  const hit = resolveExistingInvoice(rows, KOONDOOLA_JOB, composed.reference);
  assertEquals(hit?.match_method, "reference");
});

// ── 2. A sibling_po ambiguity refuses rather than warning ────────────────────────────────────────

Deno.test("sibling_po ambiguity REFUSES: the exact probe Koondoola recorded and ignored", () => {
  // The stored proposal on obligation revision 74c53b57 reads
  // {"ambiguity":"sibling_po","match_tier":null,"allows_create":true}. That combination is now
  // unreachable: the same evidence refuses.
  const [result] = resolveSesInvoiceDuplicates(
    [{ job_id: KOONDOOLA_JOB, external_ref: "MLB-27093" }],
    [
      indexRow(),
      indexRow({
        xero_invoice_id: "xero-1081",
        invoice_number: "INV-1081",
        reference: "MLB-27093PO-56479",
      }),
    ],
  );
  assertEquals(result.allows_create, false);
  assert(
    result.live_invoices.length > 0,
    "the refusal must name the invoices it is refusing on, not return an empty list",
  );
});

Deno.test("sibling_po refuses even when no reference tier claims the row first", () => {
  // A claim base below the tiers' digit-safety floor still reaches the ambiguity branch. This is the
  // second line of defence: the ambiguity alone stops the mint, so a tier regression cannot read as
  // a permission the way it did on 2026-08-05.
  const [result] = resolveSesInvoiceDuplicates(
    [{ job_id: KOONDOOLA_JOB, external_ref: "AB" }],
    [indexRow({ reference: "AB-PO-56481" })],
  );
  assertEquals(result.match_tier, null);
  assertEquals(result.ambiguity, "sibling_po");
  assertEquals(result.allows_create, false);
  assertEquals(result.reason_codes, [
    "po_indeterminate_sibling_blocks",
    "ambiguous_live_invoices",
  ]);
});

// ── 3. Genuinely distinct work is still permitted ────────────────────────────────────────────────

Deno.test("live pair: SWMS-26938 (MLB-24732PO-55712) still mints beside SWMS-26526's own invoice", () => {
  // The case that proves this is not "refuse everything". Claim MLB-24732 carries TWO real jobs,
  // both in Noranda and both already billed: SWMS-26526 (`MLB-24732`, PAID INV-0745 $1556.50) and
  // SWMS-26938 (`MLB-24732PO-55712`, AUTHORISED INV-0999 $929.50). Same one-sided PO shape as
  // Koondoola — and legitimate. What separates them is that INV-0745 is ATTRIBUTED to SWMS-26526's
  // job, so it is demonstrably another card's money.
  const rows = [{
    job_id: NORANDA_BASE_JOB,
    status: "PAID",
    invoice_number: "INV-0745",
    reference: "MLB-24732",
    xero_invoice_id: "xero-0745",
  }];
  assertEquals(
    resolveExistingInvoice(rows, NORANDA_PO_JOB, "MLB-24732PO-55712"),
    null,
  );

  const [probe] = resolveSesInvoiceDuplicates(
    [{ job_id: NORANDA_PO_JOB, external_ref: "MLB-24732PO-55712" }],
    [indexRow({
      job_id: NORANDA_BASE_JOB,
      xero_invoice_id: "xero-0745",
      invoice_number: "INV-0745",
      status: "PAID",
      reference: "MLB-24732",
    })],
  );
  assert(probe.allows_create, "another card's money must not block this card");
  assertEquals(probe.ambiguity, "none");
});

Deno.test("two different-PO siblings are a demonstrated distinction, not an ambiguity", () => {
  const [result] = resolveSesInvoiceDuplicates(
    [{ job_id: KOONDOOLA_JOB, external_ref: "MLB-25898PO-55547" }],
    [indexRow({ job_id: null, reference: "MLB-25898PO-54817" })],
  );
  assert(result.allows_create);
  assertEquals(result.ambiguity, "none");
  assertEquals(result.reason_codes, ["different_po_sibling_does_not_block"]);
  // Unattributed makes no difference here: the builder named two purchase orders, so the reference
  // evidence resolves the pair on its own and attribution is never consulted.
  assertEquals(
    resolveExistingInvoice(
      [{
        job_id: null,
        status: "AUTHORISED",
        invoice_number: "INV-0920",
        reference: "MLB-25898PO-54817",
        xero_invoice_id: "x920",
      }],
      KOONDOOLA_JOB,
      "MLB-25898PO-55547",
    ),
    null,
  );
});

Deno.test("an unrelated builder claim never blocks", () => {
  const [result] = resolveSesInvoiceDuplicates(
    [{ job_id: KOONDOOLA_JOB, external_ref: "AJBR-70271" }],
    [indexRow({ job_id: null, reference: "MLB-27093PO-56481" })],
  );
  assert(result.allows_create);
  assertEquals(result.ambiguity, "none");
  assertEquals(result.reason_codes, []);
});

Deno.test("a VOIDED sibling still never blocks", () => {
  const [result] = resolveSesInvoiceDuplicates(
    [{ job_id: KOONDOOLA_JOB, external_ref: "MLB-27093" }],
    [indexRow({ job_id: null, status: "VOIDED" })],
  );
  assert(result.allows_create);
  assertEquals(result.ambiguity, "void_only");
});

// ── 4. The F07 direction — the false REFUSAL — still refuses ─────────────────────────────────────

Deno.test("F07 direction: two claim-only cards on one claim still block each other", () => {
  // F07 (`MLB-27037` for two cards that are really PO-56397 and PO-56459) is the opposite failure:
  // both proposals emitted the SAME claim-only reference, so the second mint correctly refused. That
  // refusal is fail-closed money safety and must survive this change — the repair for F07 is the
  // reference composition below, never a weaker guard.
  const rows = [{
    job_id: null,
    status: "AUTHORISED",
    invoice_number: "INV-1101",
    reference: "MLB-27037",
    xero_invoice_id: "x1101",
  }];
  const hit = resolveExistingInvoice(rows, "job-second-card", "MLB-27037");
  assert(hit, "an identical claim-only reference must still refuse");
  assertEquals(hit.match_method, "reference");

  const [probe] = resolveSesInvoiceDuplicates(
    [{ job_id: "job-second-card", external_ref: "MLB-27037" }],
    [indexRow({
      job_id: null,
      invoice_number: "INV-1101",
      reference: "MLB-27037",
    })],
  );
  assertEquals(probe.allows_create, false);
});

Deno.test("F07 repair: composing each card's own PO lets the two siblings mint separately", () => {
  // With the PO carried onto the reference, the two F07 cards stop colliding: their references
  // become distinguishable, which is exactly the "fix the proposal reference grain" answer on file.
  const first = composeInvoiceReferenceWithPo("MLB-27037", "PO-56397");
  const second = composeInvoiceReferenceWithPo("MLB-27037", "PO-56459");
  assertEquals(first.reference, "MLB-27037PO-56397");
  assertEquals(second.reference, "MLB-27037PO-56459");

  const rows = [{
    job_id: null,
    status: "AUTHORISED",
    invoice_number: "INV-1101",
    reference: first.reference,
    xero_invoice_id: "x1101",
  }];
  assertEquals(
    resolveExistingInvoice(rows, "job-second-card", second.reference),
    null,
  );
});

Deno.test("F07 live trio: three Floreat cards on claim MLB-27037 separate once each carries its PO", () => {
  // The live F07 population, read 2026-08-06: SWMS-261019 (PO-56395), SWMS-261020 (PO-56397) and
  // SWMS-261021 (PO-56459) all carry builder_wo_canonical `MLB-27037`, so all three mint the same
  // claim-only reference and collide on SWMS-261020's AUTHORISED INV-1127 (`MLB-27037`, $374).
  const floreat = [
    { job: "job-261019", po: "PO-56395" },
    { job: "job-261020", po: "PO-56397" },
    { job: "job-261021", po: "PO-56459" },
  ].map((card) => ({
    ...card,
    reference: composeInvoiceReferenceWithPo("MLB-27037", card.po).reference,
  }));
  assertEquals(floreat.map((card) => card.reference), [
    "MLB-27037PO-56395",
    "MLB-27037PO-56397",
    "MLB-27037PO-56459",
  ]);

  // INV-1127 is SWMS-261020's own money. The other two are one-sided against it, and it is
  // attributed to a different card — so they mint. That is F07 repaired, not F07 re-broken.
  const inv1127 = {
    job_id: "job-261020",
    status: "AUTHORISED",
    invoice_number: "INV-1127",
    reference: "MLB-27037",
    xero_invoice_id: "x1127",
  };
  for (const card of floreat.filter((row) => row.job !== "job-261020")) {
    assertEquals(
      resolveExistingInvoice([inv1127], card.job, card.reference),
      null,
      `${card.reference} must not be blocked by another card's invoice`,
    );
  }

  // And SWMS-261021's own unlinked DRAFT INV-1116 (`MLB-27037PO-56459`) becomes an EXACT match once
  // the card's reference carries its PO — an invoice the claim-only grain could never recognise.
  const hit = resolveExistingInvoice(
    [{
      job_id: null,
      status: "DRAFT",
      invoice_number: "INV-1116",
      reference: "MLB-27037PO-56459",
      xero_invoice_id: "x1116",
    }],
    "job-261021",
    "MLB-27037PO-56459",
  );
  assertEquals(hit?.invoice_number, "INV-1116");
  assertEquals(hit?.match_method, "reference");
});

Deno.test("a card's own live invoice always blocks, whatever the PO grain", () => {
  // Tier 1 is untouched: a second invoice on the SAME card is a re-invoice regardless of reference.
  const rows = [{
    job_id: KOONDOOLA_JOB,
    status: "DRAFT",
    invoice_number: "INV-1140",
    reference: "MLB-27093",
    xero_invoice_id: "xero-1140",
  }];
  assertEquals(
    resolveExistingInvoice(rows, KOONDOOLA_JOB, "MLB-27093PO-56481")
      ?.match_method,
    "job_id",
  );
});

// ── 5. Reference composition never invents identity ──────────────────────────────────────────────

Deno.test("reference composition refuses to fabricate a purchase order", () => {
  // external_ref_canonical is frequently the CLAIM, not a PO. Reading its digit run as a purchase
  // order would compose the fabricated `MLB-27093PO-27093`.
  const fromClaim = composeInvoiceReferenceWithPo("MLB-27093", "MLB-27093");
  assertEquals(fromClaim.reference, "MLB-27093");
  assertEquals(fromClaim.grain, "builder_reference_without_known_po");
  assertEquals(fromClaim.purchase_order, null);

  for (const empty of [null, undefined, "", "   ", "PO-", "12"]) {
    assertEquals(
      composeInvoiceReferenceWithPo("MLB-27093", empty).reference,
      "MLB-27093",
    );
  }
});

Deno.test("reference composition never overwrites a PO the reference already names", () => {
  const already = composeInvoiceReferenceWithPo(
    "MLB-27093PO-56481",
    "PO-99999",
  );
  assertEquals(already.reference, "MLB-27093PO-56481");
  assertEquals(already.grain, "builder_reference_already_carries_po");
  assertEquals(already.purchase_order, "56481");
});

Deno.test("reference composition preserves the claim base it was given", () => {
  // A composed reference must stay the SAME work to the guard: same claim base, plus a PO.
  const composed = composeInvoiceReferenceWithPo("MLB-27093", "PO-56481");
  const rows = [{
    job_id: null,
    status: "AUTHORISED",
    invoice_number: "INV-1080",
    reference: "MLB-27093",
    xero_invoice_id: "xero-1080",
  }];
  assert(
    resolveExistingInvoice(rows, KOONDOOLA_JOB, composed.reference),
    "composing a PO must not detach the reference from its own claim",
  );
  assertEquals(composeInvoiceReferenceWithPo("", "PO-56481").reference, "");
});

// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// "Nothing is BOUND" is not "nothing EXISTS".
//
// Measured live 2026-08-06: all 16 Docs Ready cards with no bound invoice
// already had live money under their own reference (SEVEN PAID, six AUTHORISED,
// three unlinked DRAFTs), and the cockpit told the operator to mint on every
// one of them — SWMS-26841 offered a $561 proposal against INV-0850 already
// PAID at $882.20.
//
// The property these tests exist to pin is that the fix is ONE-WAY: it can add
// a refusal and it can never make a card more approvable.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyExistingCardMoney,
  describeExistingCardMoney,
  NO_EXISTING_CARD_MONEY,
  NOT_EVALUATED_CARD_MONEY,
  readSesExistingCardMoneyForJob,
  type SesExistingCardMoney,
} from "./ses_existing_card_money.ts";
import {
  approveInvoiceDisabledReason,
  canRecordSesApproval,
  existingCardMoneyRefusal,
  type SesMechanicalCleanResult,
  sesVerdictWithExistingMoney,
} from "./ses_review_cockpit.ts";

const JOB = "job-1";
const OTHER = "job-2";

const inv = (over: Record<string, unknown> = {}) => ({
  id: "x1",
  invoice_number: "INV-0850",
  reference: "MLB-26565 - Temp Fence Make-Safe",
  status: "PAID",
  invoice_type: "ACCREC",
  job_id: null,
  total: 882.2,
  ...over,
});

// ── classification ───────────────────────────────────────────────────────────

Deno.test("SWMS-26841: an invoice already PAID on this card is existing money", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ job_id: JOB })], null);
  assertEquals(money.exists, true);
  assertEquals(money.rows[0].attribution, "own_job");
  assertEquals(money.rows[0].status, "PAID");
  assertEquals(money.rows[0].total, 882.2);
});

Deno.test("SWMS-261015: an UNLINKED DRAFT under the card's own reference is existing money", () => {
  // The unique-match attribution matcher restricts to ISSUED statuses and would
  // miss this; a refusal must be inclusive, and a live DRAFT is exactly the
  // second-draft case being prevented.
  const money = classifyExistingCardMoney(
    JOB,
    "MLB-26658PO-56313",
    [inv({ id: "x2", invoice_number: "INV-1115", status: "DRAFT", reference: "MLB-26658PO-56313", job_id: null, total: 464.75 })],
    null,
  );
  assertEquals(money.exists, true);
  assertEquals(money.rows[0].attribution, "unlinked_reference_match");
  assertEquals(money.rows[0].status, "DRAFT");
});

Deno.test("a contested reference still REFUSES — inclusive, not unique", () => {
  // The attribution matcher correctly returns nothing when two cards share a
  // claim. For refusal that is the wrong answer: two candidates is more reason
  // to stop, not less.
  const money = classifyExistingCardMoney(
    JOB,
    "MLB-27037",
    [inv({ id: "a", invoice_number: "INV-1116", status: "DRAFT", reference: "MLB-27037PO-56459", job_id: null }),
     inv({ id: "b", invoice_number: "INV-1127", status: "AUTHORISED", reference: "MLB-27037", job_id: OTHER })],
    null,
  );
  assertEquals(money.exists, true);
  assertEquals(money.rows.length, 2);
});

Deno.test("the docket's OWN bound invoice is never reported as a surprise", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ id: "bound", job_id: JOB })], "bound");
  assertEquals(money.exists, false);
  assertEquals(money.rows.length, 0);
});

Deno.test("VOIDED/DELETED and non-ACCREC rows are not existing money", () => {
  const rows = [
    inv({ id: "v", status: "VOIDED", job_id: JOB }),
    inv({ id: "d", status: "DELETED", job_id: JOB }),
    inv({ id: "p", invoice_type: "ACCPAY", job_id: JOB }),
  ];
  assertEquals(classifyExistingCardMoney(JOB, "MLB-26565", rows, null).exists, false);
});

Deno.test("an unrelated reference on another card's invoice is not this card's money", () => {
  const money = classifyExistingCardMoney(
    JOB,
    "MLB-26565",
    [inv({ id: "z", reference: "MLB-99999", job_id: OTHER })],
    null,
  );
  assertEquals(money.exists, false);
});

Deno.test("a short reference cannot attach another builder's invoice by substring", () => {
  // SES_MIN_REFERENCE_DIGITS: a four-digit reference is a substring of
  // unrelated five- and six-digit numbers.
  const money = classifyExistingCardMoney(
    JOB,
    "BW-6771",
    [inv({ id: "z", reference: "MLB-267715", job_id: OTHER })],
    null,
  );
  assertEquals(money.exists, false);
});

// ── the refusal, and the one-way property ────────────────────────────────────

Deno.test("no bound invoice + existing money -> a refusal naming the invoice", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ job_id: JOB })], null);
  const refusal = existingCardMoneyRefusal(null, money);
  assert(refusal, "expected a refusal");
  assertEquals(refusal!.code, "invoice_exists_unbound");
  assertStringIncludes(refusal!.fact, "INV-0850");
  assertStringIncludes(refusal!.recovery_action, "Do not mint");
});

Deno.test("a BOUND card is never touched, however much other money exists", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ job_id: JOB })], null);
  assertEquals(existingCardMoneyRefusal("DRAFT", money), null);
  assertEquals(existingCardMoneyRefusal("AUTHORISED", money), null);
});

Deno.test("no existing money -> no refusal (it can only ADD a stop)", () => {
  assertEquals(existingCardMoneyRefusal(null, NO_EXISTING_CARD_MONEY), null);
  assertEquals(existingCardMoneyRefusal(null, null), null);
  assertEquals(existingCardMoneyRefusal(null, undefined), null);
});

Deno.test("an UNREADABLE Xero mirror refuses — it never reads as 'no money'", () => {
  const unreadable: SesExistingCardMoney = {
    exists: true,
    unreadable: true,
    evaluated: true,
    rows: [],
  };
  const refusal = existingCardMoneyRefusal(null, unreadable);
  assert(refusal, "expected a refusal");
  assertStringIncludes(refusal!.fact, "could not be read");
});

// ── the shared verdict producer, and the approve-path stop ───────────────────

const mechanical = (over: Partial<SesMechanicalCleanResult> = {}) => ({
  clean: true,
  checks: [],
  blockers: [],
  approval_band: "shaun_clean" as const,
  ...over,
}) as SesMechanicalCleanResult;

const someMoney = () =>
  classifyExistingCardMoney(JOB, "MLB-26565", [inv({ job_id: JOB })], null);

Deno.test("the shared producer forces clean false and names the money FIRST", () => {
  const other = existingCardMoneyRefusal(null, someMoney())!;
  const verdict = sesVerdictWithExistingMoney(
    mechanical({ blockers: [{ ...other, code: "xero_not_authorised" } as any] }),
    null,
    someMoney(),
  );
  assertEquals(verdict.clean, false);
  assertEquals(verdict.blockers.length, 2);
  // blockers[0] is what the approve actions report; it must be the money.
  assertEquals(verdict.blockers[0].code, "invoice_exists_unbound");
});

Deno.test("the shared producer leaves a BOUND card byte-identical", () => {
  const base = mechanical();
  assertEquals(sesVerdictWithExistingMoney(base, "DRAFT", someMoney()), base);
  assertEquals(sesVerdictWithExistingMoney(base, "AUTHORISED", someMoney()), base);
  assertEquals(
    sesVerdictWithExistingMoney(base, null, NO_EXISTING_CARD_MONEY),
    base,
  );
});

Deno.test("a non-clean verdict is captain-OVERRIDABLE — which is why the approve actions hard-stop", () => {
  // This pins the reason `refuseWhenCardMoneyExists` exists rather than relying
  // on the enriched verdict alone: forcing `clean` false hands a Captain an
  // override, i.e. it would make the card MORE approvable, not less.
  const authority = canRecordSesApproval(
    { mode: "jwt", user_id: "u", role: "admin", operator_class: "captain" },
    sesVerdictWithExistingMoney(mechanical(), null, someMoney()),
  );
  assertEquals(authority.allowed, true);
  assertEquals(authority.captain_override, true);
});

Deno.test("a member that mints nothing is outside the guard entirely", () => {
  // Not a weakening: a no-additional-charge release creates no invoice, so it
  // cannot double-bill, and refusing it would strand a supported document-only
  // path with no override. Applied in the one producer so the cockpit and both
  // approve actions cannot disagree about the scope.
  assertEquals(
    existingCardMoneyRefusal(null, someMoney(), "no_additional_charge"),
    null,
  );
  const base = mechanical();
  assertEquals(
    sesVerdictWithExistingMoney(base, null, someMoney(), "no_additional_charge"),
    base,
  );
  assert(existingCardMoneyRefusal(null, someMoney(), "priced_from_canon"));
});

Deno.test("PRIOR-cycle money is not this cycle's money; unknown still refuses", () => {
  const reattended = { reattend_count: 1, last_reattend_at: "2026-08-01T00:00:00.000Z" };
  const prior = classifyExistingCardMoney(
    JOB,
    "MLB-26565",
    [inv({ job_id: JOB, created_at: "2026-07-01T00:00:00.000Z" })],
    null,
    reattended,
  );
  assertEquals(prior.exists, false);

  const current = classifyExistingCardMoney(
    JOB,
    "MLB-26565",
    [inv({ job_id: JOB, created_at: "2026-08-02T00:00:00.000Z" })],
    null,
    reattended,
  );
  assertEquals(current.exists, true);
  assertEquals(current.rows[0].attendance_cycle, "current");

  const unknown = classifyExistingCardMoney(
    JOB,
    "MLB-26565",
    [inv({ job_id: JOB, created_at: null })],
    null,
    reattended,
  );
  assertEquals(unknown.exists, true);
  assertEquals(unknown.rows[0].attendance_cycle, "unknown");
});

Deno.test("a BOUND card publishes not_evaluated, which is never 'no money'", () => {
  assertEquals(NOT_EVALUATED_CARD_MONEY.evaluated, false);
  // Unbound + never asked is not a licence to mint: it refuses like an
  // unreadable mirror.
  const refusal = existingCardMoneyRefusal(null, NOT_EVALUATED_CARD_MONEY);
  assert(refusal, "an unanswered money question must refuse");
  assertStringIncludes(refusal!.fact, "not checked");
  // The state it actually occurs in — a bound card — is still untouched.
  assertEquals(
    existingCardMoneyRefusal("DRAFT", NOT_EVALUATED_CARD_MONEY),
    null,
  );
  const invited = approveInvoiceDisabledReason(
    { xero_binding: null },
    {
      stale: false,
      xeroAuthorised: false,
      noAdditionalCharge: false,
      existingMoney: NOT_EVALUATED_CARD_MONEY,
    },
  );
  assert(!invited.includes("Mint the draft first"), "must not invite a mint");
});

// ── the read fails CLOSED ────────────────────────────────────────────────────

function fakeClient(plan: Record<string, unknown>[]) {
  let call = -1;
  const builder = () => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      like: () => chain,
      limit: () => Promise.resolve(plan[call]),
      maybeSingle: () => Promise.resolve(plan[call]),
      then: (resolve: any) => Promise.resolve(plan[call]).then(resolve),
    };
    return chain;
  };
  return {
    from: () => {
      call += 1;
      return builder();
    },
  };
}

Deno.test("an unreadable detail row is UNREADABLE money, never 'no money'", async () => {
  const money = await readSesExistingCardMoneyForJob(
    fakeClient([{ data: null, error: { message: "42703" } }]),
    JOB,
    null,
  );
  assertEquals(money.exists, true);
  assertEquals(money.unreadable, true);
});

Deno.test("an ABSENT detail row is unreadable too — the reference half is the point", async () => {
  const money = await readSesExistingCardMoneyForJob(
    fakeClient([{ data: null, error: null }]),
    JOB,
    null,
  );
  assertEquals(money.unreadable, true);
});

Deno.test("a TRUNCATED reference page refuses rather than reading as no money", async () => {
  const full = Array.from({ length: 500 }, (_, i) => inv({ id: `f${i}`, reference: "MLB-99999" }));
  const money = await readSesExistingCardMoneyForJob(
    fakeClient([
      { data: { external_ref: "MLB-26565" }, error: null },
      { data: [], error: null },
      { data: full, error: null },
    ]),
    JOB,
    null,
  );
  assertEquals(money.exists, true);
  assertEquals(money.unreadable, true);
});

Deno.test("a readable card with no money still reads as no money", async () => {
  const money = await readSesExistingCardMoneyForJob(
    fakeClient([
      { data: { external_ref: "MLB-26565" }, error: null },
      { data: [], error: null },
      { data: [], error: null },
    ]),
    JOB,
    null,
  );
  assertEquals(money.exists, false);
  assertEquals(money.unreadable, false);
});

// ── the operator sentence ────────────────────────────────────────────────────

Deno.test("the mint invitation is REPLACED when money already exists", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ job_id: JOB })], null);
  const withMoney = approveInvoiceDisabledReason(
    { xero_binding: null },
    { stale: false, xeroAuthorised: false, noAdditionalCharge: false, existingMoney: money },
  );
  assertStringIncludes(withMoney, "INV-0850");
  assertStringIncludes(withMoney, "Do NOT mint");
  assert(!withMoney.includes("Mint the draft first"), "must not invite a mint");
});

Deno.test("the mint invitation SURVIVES for a card with genuinely no money", () => {
  const clean = approveInvoiceDisabledReason(
    { xero_binding: null },
    { stale: false, xeroAuthorised: false, noAdditionalCharge: false, existingMoney: NO_EXISTING_CARD_MONEY },
  );
  assertStringIncludes(clean, "Mint the draft first");
});

Deno.test("an omitted existingMoney behaves exactly as before (no silent change)", () => {
  const before = approveInvoiceDisabledReason(
    { xero_binding: null },
    { stale: false, xeroAuthorised: false, noAdditionalCharge: false },
  );
  assertStringIncludes(before, "Mint the draft first");
});

Deno.test("the already-authorised sentence still wins over everything", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ job_id: JOB })], null);
  const reason = approveInvoiceDisabledReason(
    { xero_binding: { invoice_number: "INV-9", status: "AUTHORISED" } },
    { stale: false, xeroAuthorised: true, noAdditionalCharge: false, existingMoney: money },
  );
  assertStringIncludes(reason, "already authorised");
});

Deno.test("describeExistingCardMoney names status and amount, and caps the list", () => {
  const many: SesExistingCardMoney = {
    exists: true,
    unreadable: false,
    evaluated: true,
    rows: Array.from({ length: 6 }, (_, i) => ({
      invoice_number: `INV-${i}`,
      xero_invoice_id: `x${i}`,
      status: "PAID",
      total: 100 + i,
      reference: "MLB-1",
      attribution: "own_job" as const,
      attendance_cycle: "current" as const,
    })),
  };
  const text = describeExistingCardMoney(many);
  assertStringIncludes(text, "INV-0 PAID $100.00");
  assertStringIncludes(text, "and 2 more");
});

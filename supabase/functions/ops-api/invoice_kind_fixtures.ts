// Same payer close (context T16 fix 2, migration 20261019130000): the ONE fixture
// table for an invoice's kind, shared by the Debt tab's reader (invoiceKindOf in
// debt_ws_rules.ts) and its SQL twin (context_ledger_invoice_kind_of). The
// migration contract's FIXTURES block
// (supabase/tests/migration-contracts/20261019130000_context_ledger_same_payer_close/contract.sql)
// must be exactly this table; invoice_kind_contract_rows_test.ts proves it and
// that invoiceKindOf answers every row. References and descriptions are
// synthetic (job numbers SWF-9xxxx), never a customer's.

export interface InvoiceKindFixture {
  label: string;
  reference: string | null;
  description: string | null;
  expected: { kind: "final" | "not_final" | null; stage: string | null };
}

const FINAL = { kind: "final" as const, stage: null };
const NONE = { kind: null, stage: null };
function notFinal(stage: string) {
  return { kind: "not_final" as const, stage };
}

export const INVOICE_KIND_FIXTURES: InvoiceKindFixture[] = [
  {
    label: "final FIN",
    reference: "SWF-90037-FIN",
    description: "Balance of the fence",
    expected: FINAL,
  },
  {
    label: "final FINBAL50",
    reference: "SWF-90037-FINBAL50",
    description: "Balance owing",
    expected: FINAL,
  },
  {
    label: "final BAL with digits",
    reference: "SWF-90037-BAL25",
    description: "Remaining 25%",
    expected: FINAL,
  },
  {
    label: "final FINAL",
    reference: "SWF-90037-FINAL",
    description: "Remainder of the job",
    expected: FINAL,
  },
  {
    label: "final PRIVATE",
    reference: "SWM-90037-PRIVATE",
    description: "Balance",
    expected: FINAL,
  },
  {
    label: "neighbour letter before the ending",
    reference: "SWF-90037-A-FINBAL",
    description: "Balance owing",
    expected: FINAL,
  },
  {
    label: "neighbour letter after the ending",
    reference: "SWF-90037-FINBAL-B",
    description: "Balance owing",
    expected: FINAL,
  },
  {
    label: "lower case and spaces",
    reference: " swf - 90037 - fin ",
    description: "  BALANCE of fence ",
    expected: FINAL,
  },
  {
    label: "ending with a trailing word",
    reference: "SWF-90037-FIN 2nd",
    description: "Balance",
    expected: FINAL,
  },
  {
    label: "punctuation stripped",
    reference: "SWF-90037-FIN.",
    description: "Balance",
    expected: FINAL,
  },
  {
    label: "final ending, other description",
    reference: "SWF-90037-FIN",
    description: "Deposit",
    expected: NONE,
  },
  {
    label: "four digits is not a final ending",
    reference: "SWF-90037-FIN1234",
    description: "Balance",
    expected: NONE,
  },
  {
    label: "deposit",
    reference: "SWF-90037-DEP",
    description: "Deposit 30%",
    expected: notFinal("deposit"),
  },
  {
    label: "deposit with digits",
    reference: "SWF-90037-DEP50",
    description: "deposit of half",
    expected: notFinal("deposit"),
  },
  {
    label: "deposit ending, other description",
    reference: "SWF-90037-DEP",
    description: "Balance",
    expected: NONE,
  },
  {
    label: "materials",
    reference: "SWP-90037-MAT",
    description: "Materials order",
    expected: notFinal("materials"),
  },
  {
    label: "progress",
    reference: "SWP-90037-PROG2",
    description: "Progress claim 2",
    expected: notFinal("progress"),
  },
  {
    label: "planning fee",
    reference: "SWP-90037-PLAN",
    description: "Planning fee for council",
    expected: notFinal("planning fee"),
  },
  {
    label: "planning ending with digits",
    reference: "SWP-90037-PLAN1",
    description: "Planning fee",
    expected: NONE,
  },
  {
    label: "variation",
    reference: "SWF-90038-VAR",
    description: "Extra labour for rock",
    expected: notFinal("extra labour"),
  },
  {
    label: "variation ending, other description",
    reference: "SWF-90038-VAR",
    description: "Variation",
    expected: NONE,
  },
  {
    label: "builder reference",
    reference: "MLB-77003PO-60001",
    description: "Make safe",
    expected: NONE,
  },
  {
    label: "only a letter",
    reference: "A",
    description: "Balance",
    expected: NONE,
  },
  {
    label: "letter as the first segment is the ending",
    reference: "A-FIN",
    description: "Balance",
    expected: FINAL,
  },
  {
    label: "no reference",
    reference: null,
    description: "Balance",
    expected: NONE,
  },
  {
    label: "empty reference",
    reference: "",
    description: "Balance",
    expected: NONE,
  },
  {
    label: "no description",
    reference: "SWF-90037-FIN",
    description: null,
    expected: NONE,
  },
  {
    label: "blank description",
    reference: "SWF-90037-FIN",
    description: "   ",
    expected: NONE,
  },
  {
    label: "only dashes",
    reference: "---",
    description: "Balance",
    expected: NONE,
  },
];

// deno-lint-ignore-file no-import-prefix
// The deposit advance rule (job_deposit_paid.ts): what counts as a deposit, when it is
// paid in full, where a paid deposit sends the job, and when a later void or refund is
// flagged for a person.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { CloseoutParty } from "./job_paid_closeout.ts";
import {
  DEPOSIT_RECEIVED_TEXT_TEMPLATE,
  depositCreditAllocations,
  depositFlagFor,
  depositFlagKey,
  type DepositInvoice,
  depositInvoicesSent,
  depositPaidTargetStatus,
  depositReceivedText,
  depositSentInXero,
  evaluateDepositPaid,
  isDepositAdvanceJobType,
  isDepositInvoice,
} from "./job_deposit_paid.ts";

function inv(over: Partial<DepositInvoice> = {}): DepositInvoice {
  return {
    xero_invoice_id: "x-1",
    invoice_number: "INV-1749",
    invoice_type: "ACCREC",
    status: "PAID",
    reference: "SWF-261369-DEP50",
    total: 2000,
    amount_due: 0,
    amount_paid: 2000,
    fully_paid_on: "2026-10-26",
    ...over,
  };
}

const job = { deposit_invoice_id: "x-1" };

Deno.test("deposit paid: one deposit paid in full is paid", () => {
  const v = evaluateDepositPaid({ parties: [], job, invoices: [inv()] });
  assertEquals(v.paid, true);
  assertEquals(v.reasons, []);
  assertEquals(v.last_paid_on, "2026-10-26");
});

Deno.test("deposit paid: a part payment never counts", () => {
  const authorisedPart = inv({
    status: "AUTHORISED",
    amount_due: 500,
    amount_paid: 1500,
  });
  assertEquals(
    evaluateDepositPaid({ parties: [], job, invoices: [authorisedPart] }),
    {
      paid: false,
      reasons: ["part_paid:INV-1749"],
      deposits: [{
        xero_invoice_id: "x-1",
        invoice_number: "INV-1749",
        status: "AUTHORISED",
        amount_due: 500,
      }],
      last_paid_on: "2026-10-26",
    },
  );
  // PAID in our copy with money still due is not paid in full either.
  const odd = inv({ amount_due: 10 });
  assertEquals(
    evaluateDepositPaid({ parties: [], job, invoices: [odd] }).reasons,
    ["part_paid:INV-1749"],
  );
  // Rounding inside half a cent is nothing due.
  assertEquals(
    evaluateDepositPaid({
      parties: [],
      job,
      invoices: [inv({ amount_due: 0.004 })],
    }).paid,
    true,
  );
});

Deno.test("deposit paid: unpaid, draft and no deposit are not paid", () => {
  assertEquals(
    evaluateDepositPaid({
      parties: [],
      job,
      invoices: [
        inv({ status: "AUTHORISED", amount_due: 2000, amount_paid: 0 }),
      ],
    }).reasons,
    ["unpaid_deposit:INV-1749"],
  );
  assertEquals(
    evaluateDepositPaid({
      parties: [],
      job,
      invoices: [inv({ status: "DRAFT", amount_due: 2000, amount_paid: 0 })],
    }).reasons,
    ["draft_deposit:INV-1749"],
  );
  assertEquals(
    evaluateDepositPaid({ parties: [], job, invoices: [] }).reasons,
    ["no_deposit_invoice"],
  );
  // A final invoice is not a deposit.
  const fin = inv({ xero_invoice_id: "x-9", reference: "SWF-261369-FINBAL" });
  assertEquals(
    evaluateDepositPaid({
      parties: [],
      job: { deposit_invoice_id: null },
      invoices: [fin],
    }).reasons,
    ["no_deposit_invoice"],
  );
});

Deno.test("deposit paid: a shared fence with one party unpaid is not paid", () => {
  const a = inv({
    xero_invoice_id: "x-a",
    invoice_number: "INV-1",
    reference: "SWF-26535-A-DEP50",
  });
  const b = inv({
    xero_invoice_id: "x-b",
    invoice_number: "INV-2",
    reference: "SWF-26535-B-DEP50",
    status: "AUTHORISED",
    amount_due: 900,
    amount_paid: 0,
    fully_paid_on: null,
  });
  const v = evaluateDepositPaid({
    parties: [],
    job: { deposit_invoice_id: "x-b" },
    invoices: [a, b],
  });
  assertEquals(v.paid, false);
  assertEquals(v.reasons, ["unpaid_deposit:INV-2"]);
  // Once party B pays, the job is paid.
  const bPaid = {
    ...b,
    status: "PAID",
    amount_due: 0,
    amount_paid: 900,
    fully_paid_on: "2026-10-27",
  };
  const paid = evaluateDepositPaid({
    parties: [],
    job: { deposit_invoice_id: "x-b" },
    invoices: [a, bPaid],
  });
  assertEquals(paid.paid, true);
  assertEquals(paid.last_paid_on, "2026-10-27");
});

function party(over: Partial<CloseoutParty> = {}): CloseoutParty {
  return {
    id: "jc-a",
    contact_label: "A",
    is_primary: true,
    share_percentage: 50,
    removed_at: null,
    status: "active",
    xero_contact_id: null,
    ...over,
  };
}

Deno.test("deposit paid: every paying party needs a deposit of its own", () => {
  const owner = party();
  const neighbour = party({
    id: "jc-b",
    contact_label: "B",
    is_primary: false,
  });
  const a = inv({
    xero_invoice_id: "x-a",
    invoice_number: "INV-1",
    reference: "SWF-26535-A-DEP50",
  });
  // The neighbour's deposit was never raised: the owner's paid deposit is not enough.
  const v = evaluateDepositPaid({
    job,
    invoices: [a],
    parties: [owner, neighbour],
  });
  assertEquals(v.paid, false);
  assertEquals(v.reasons, ["party_without_deposit:B"]);
  // Raised but unpaid: still not paid.
  const b = inv({
    xero_invoice_id: "x-b",
    invoice_number: "INV-2",
    reference: "SWF-26535-B-DEP50",
    status: "AUTHORISED",
    amount_due: 900,
    amount_paid: 0,
  });
  assertEquals(
    evaluateDepositPaid({ job, invoices: [a, b], parties: [owner, neighbour] })
      .reasons,
    ["unpaid_deposit:INV-2"],
  );
  // Paid by both parties: paid.
  const bPaid = { ...b, status: "PAID", amount_due: 0, amount_paid: 900 };
  assertEquals(
    evaluateDepositPaid({
      job,
      invoices: [a, bPaid],
      parties: [owner, neighbour],
    }).paid,
    true,
  );
  // A deposit names its party by job_contact_id too, whatever its reference says.
  const byContact = {
    ...bPaid,
    reference: "SWF-26535-DEP50",
    job_contact_id: "jc-b",
  };
  assertEquals(
    evaluateDepositPaid({
      job,
      invoices: [a, byContact],
      parties: [owner, neighbour],
    }).paid,
    true,
  );
  // A removed party or one with an explicit 0 share pays nothing, so holds nothing back.
  for (
    const gone of [{ removed_at: "2026-10-20T00:00:00Z" }, {
      status: "removed",
    }, { share_percentage: 0 }]
  ) {
    assertEquals(
      evaluateDepositPaid({
        job,
        invoices: [a],
        parties: [owner, { ...neighbour, ...gone }],
      }).paid,
      true,
    );
  }
});

Deno.test("deposit flag: a neighbour's deposit voided after the move is flagged", () => {
  const moved = { deposit_invoice_id: "x-a", status: "order_materials" };
  const parties = [
    party(),
    party({ id: "jc-b", contact_label: "B", is_primary: false }),
  ];
  const a = inv({
    xero_invoice_id: "x-a",
    invoice_number: "INV-1",
    reference: "SWF-26535-A-DEP50",
  });
  const b = inv({
    xero_invoice_id: "x-b",
    invoice_number: "INV-2",
    reference: "SWF-26535-B-DEP50",
    status: "VOIDED",
  });
  assertEquals(
    depositFlagFor({
      job: moved,
      invoices: [a, b],
      parties,
      countedIds: ["x-a", "x-b"],
    })?.reason,
    "deposit_voided",
  );
});

Deno.test("deposit flag: a replaced void is not flagged because another party has no deposit", () => {
  // A shared fence moved on party A's deposit: the neighbour has no deposit now.
  const moved = { deposit_invoice_id: "x-c", status: "scheduled" };
  const parties = [
    party(),
    party({
      id: "jc-b",
      contact_label: "B",
      is_primary: false,
      share_percentage: null,
    }),
  ];
  const voidedA = inv({
    xero_invoice_id: "x-a",
    invoice_number: "INV-1",
    reference: "SWF-26535-A-DEP50",
    status: "VOIDED",
  });
  const replacementA = inv({
    xero_invoice_id: "x-c",
    invoice_number: "INV-3",
    reference: "SWF-26535-A-DEP50",
  });
  assertEquals(
    depositFlagFor({
      job: moved,
      invoices: [voidedA, replacementA],
      parties,
      countedIds: ["x-a"],
    }),
    null,
  );
  // Without the replacement, the void is flagged.
  assertEquals(
    depositFlagFor({
      job: moved,
      invoices: [voidedA],
      parties,
      countedIds: ["x-a"],
    })?.reason,
    "deposit_voided",
  );
});

Deno.test("deposit flag: a cleared flag is never raised again, another one still is", () => {
  const moved = { deposit_invoice_id: "x-1", status: "order_materials" };
  const voided1 = inv({ status: "VOIDED" });
  const voided2 = inv({
    xero_invoice_id: "x-2",
    invoice_number: "INV-2",
    reference: "SWF-261369-DEP2",
    status: "VOIDED",
  });
  const counted = ["x-1", "x-2"];
  const cleared = [depositFlagKey("deposit_voided", "x-1")];
  assertEquals(
    depositFlagFor({
      job: moved,
      invoices: [voided1, voided2],
      parties: [],
      countedIds: counted,
      cleared,
    })?.xero_invoice_id,
    "x-2",
  );
  cleared.push(depositFlagKey("deposit_voided", "x-2"));
  assertEquals(
    depositFlagFor({
      job: moved,
      invoices: [voided1, voided2],
      parties: [],
      countedIds: counted,
      cleared,
    }),
    null,
  );
});

Deno.test("deposit paid: a hand-made Xero deposit that is not the pointer still counts", () => {
  const pointer = inv({ xero_invoice_id: "x-1" });
  const handMade = inv({
    xero_invoice_id: "x-hand",
    invoice_number: "INV-1800",
    reference: "SWF-261369-DEP",
    status: "AUTHORISED",
    amount_due: 300,
    amount_paid: 0,
  });
  assert(isDepositInvoice(handMade, "x-1"));
  assertEquals(
    evaluateDepositPaid({ parties: [], job, invoices: [pointer, handMade] })
      .reasons,
    ["unpaid_deposit:INV-1800"],
  );
  // A hand-made deposit paid, with no pointer at all, is paid.
  assertEquals(
    evaluateDepositPaid({
      parties: [],
      job: { deposit_invoice_id: null },
      invoices: [{ ...handMade, status: "PAID", amount_due: 0 }],
    }).paid,
    true,
  );
});

Deno.test("deposit paid: voided deposits do not count, a bill is never a deposit", () => {
  const voided = inv({
    xero_invoice_id: "x-old",
    status: "VOIDED",
    amount_due: 0,
  });
  const replacement = inv({
    xero_invoice_id: "x-new",
    invoice_number: "INV-2000",
  });
  assertEquals(
    evaluateDepositPaid({ parties: [], job, invoices: [voided, replacement] })
      .paid,
    true,
  );
  assertEquals(
    evaluateDepositPaid({ parties: [], job, invoices: [voided] }).reasons,
    ["no_deposit_invoice"],
  );
  assertEquals(isDepositInvoice(inv({ invoice_type: "ACCPAY" }), "x-1"), false);
  // The pointer counts even without a DEP reference.
  assert(isDepositInvoice(inv({ reference: "SWF-261369" }), "x-1"));
  assertEquals(isDepositInvoice(inv({ reference: "SWF-261369" }), null), false);
});

Deno.test("deposit sent: a live sent deposit lands, a draft or none does not", () => {
  assertEquals(
    depositInvoicesSent({
      job,
      invoices: [inv({ status: "AUTHORISED", amount_due: 2000 })],
    }).sent,
    true,
  );
  assertEquals(
    depositInvoicesSent({ job, invoices: [inv({ status: "DRAFT" })] }).sent,
    false,
  );
  assertEquals(depositInvoicesSent({ job, invoices: [] }).reasons, [
    "no_deposit_invoice",
  ]);
});

Deno.test("deposit sent in Xero: only Xero's own true flag on a live deposit lands", () => {
  const sent = inv({
    status: "AUTHORISED",
    amount_due: 2000,
    sent_to_contact: true,
  });
  assertEquals(depositSentInXero({ job, invoices: [sent] }), {
    sent: true,
    reasons: [],
    sent_invoices: ["INV-1749"],
  });
  // Not known (null or absent) and false are never sent; status alone is never sent.
  for (const flag of [null, undefined, false]) {
    assertEquals(
      depositSentInXero({
        job,
        invoices: [{ ...sent, sent_to_contact: flag }],
      }),
      { sent: false, reasons: ["not_sent_in_xero"], sent_invoices: [] },
    );
  }
  // A voided deposit marked sent, or a draft beside the sent one, does not land.
  assertEquals(
    depositSentInXero({ job, invoices: [{ ...sent, status: "VOIDED" }] })
      .reasons,
    ["no_deposit_invoice"],
  );
  assertEquals(
    depositSentInXero({
      job,
      invoices: [
        sent,
        inv({
          xero_invoice_id: "x-2",
          invoice_number: "INV-1750",
          reference: "SWF-261369-B-DEP50",
          status: "DRAFT",
        }),
      ],
    }),
    { sent: false, reasons: ["draft_deposit:INV-1750"], sent_invoices: [] },
  );
  // A sent invoice that is not a deposit does not land the job.
  assertEquals(
    depositSentInXero({
      job: { deposit_invoice_id: null },
      invoices: [{ ...sent, reference: "SWF-261369-FINBAL" }],
    }).sent,
    false,
  );
});

Deno.test("deposit target: fencing to order materials, patio by council", () => {
  assertEquals(
    depositPaidTargetStatus({ type: "fencing", council_required: null }),
    "order_materials",
  );
  assertEquals(
    depositPaidTargetStatus({ type: "patio", council_required: true }),
    "approvals",
  );
  assertEquals(
    depositPaidTargetStatus({ type: "patio", council_required: null }),
    "approvals",
  );
  assertEquals(depositPaidTargetStatus({ type: "patio" }), "approvals");
  assertEquals(
    depositPaidTargetStatus({ type: "patio", council_required: false }),
    "order_materials",
  );
  assertEquals(
    depositPaidTargetStatus({ type: "makesafe", council_required: false }),
    null,
  );
  assert(isDepositAdvanceJobType("Fencing"));
  assertEquals(isDepositAdvanceJobType("repair"), false);
});

Deno.test("deposit flag: a voided counted deposit after the move is flagged", () => {
  const moved = { deposit_invoice_id: "x-1", status: "order_materials" };
  const voided = inv({ status: "VOIDED" });
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [voided],
      countedIds: ["x-1"],
    }),
    {
      reason: "deposit_voided",
      xero_invoice_id: "x-1",
      invoice_number: "INV-1749",
      invoice_status: "VOIDED",
    },
  );
  // A replacement deposit paid in full flags nothing.
  const replacement = inv({ xero_invoice_id: "x-2", invoice_number: "INV-2" });
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [voided, replacement],
      countedIds: ["x-1"],
    }),
    null,
  );
  // A job a person moved on (nothing counted) is never flagged, even on a void.
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [voided],
      countedIds: [],
    }),
    null,
  );
  // Still in the deposit columns: never a flag.
  assertEquals(
    depositFlagFor({
      parties: [],
      job: { ...moved, status: "awaiting_deposit" },
      invoices: [voided],
      countedIds: ["x-1"],
    }),
    null,
  );
});

Deno.test("deposit flag: a counted deposit no longer paid in full is flagged", () => {
  const moved = { deposit_invoice_id: "x-1", status: "scheduled" };
  const refunded = inv({
    status: "AUTHORISED",
    amount_due: 2000,
    amount_paid: 0,
  });
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [refunded],
      countedIds: ["x-1"],
    })?.reason,
    "deposit_unpaid",
  );
  // Without a counted record, nothing is flagged.
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [refunded],
      countedIds: [],
    }),
    null,
  );
  // Still paid: nothing.
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [inv()],
      countedIds: ["x-1"],
    }),
    null,
  );
});

// Xero's CreditNotes on an invoice, as our copy keeps them (raw_json->CreditNotes).
function creditNote(id: string, number: string, applied: number) {
  return {
    ID: id,
    Date: "/Date(1793059200000+0000)/",
    Total: applied,
    HasErrors: false,
    LineItems: [],
    DateString: "2026-10-28T00:00:00",
    CreditNoteID: id,
    AppliedAmount: applied,
    CreditNoteNumber: number,
    InvoiceAddresses: [],
  };
}

Deno.test("deposit credit: the credit notes allocated against an invoice", () => {
  assertEquals(depositCreditAllocations(inv()), []);
  assertEquals(depositCreditAllocations(inv({ credit_notes: null })), []);
  assertEquals(depositCreditAllocations(inv({ credit_notes: "x" })), []);
  assertEquals(
    depositCreditAllocations(inv({
      credit_notes: [
        creditNote("cn-1", "CN-0500", 2000),
        // An allocation of nothing is not one; a row with no id is unreadable.
        creditNote("cn-2", "CN-0501", 0),
        { CreditNoteNumber: "CN-0502", AppliedAmount: 5 },
        // No applied amount: counted at its total, never dropped.
        { CreditNoteID: "cn-3", Total: 40 },
      ],
    })),
    [
      { credit_note_id: "cn-1", credit_note_number: "CN-0500", amount: 2000 },
      { credit_note_id: "cn-3", credit_note_number: null, amount: 40 },
    ],
  );
});

Deno.test("deposit flag: a credit note allocated against a counted deposit after the move is flagged", () => {
  const moved = { deposit_invoice_id: "x-1", status: "order_materials" };
  // The usual Xero refund: payment taken off, credit note allocated and refunded, the
  // invoice reads PAID with nothing due again.
  const refunded = inv({
    amount_paid: 0,
    credit_notes: [creditNote("cn-1", "CN-0500", 2000)],
  });
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [refunded],
      countedIds: ["x-1"],
      countedCreditNoteIds: [],
    }),
    {
      reason: "deposit_credited",
      xero_invoice_id: "x-1",
      invoice_number: "INV-1749",
      invoice_status: "PAID",
      credit_note_numbers: ["CN-0500"],
    },
  );
  // A part refund by credit note is flagged too.
  const part = inv({
    amount_paid: 1500,
    credit_notes: [creditNote("cn-1", "CN-0500", 500)],
  });
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [part],
      countedIds: ["x-1"],
    })?.reason,
    "deposit_credited",
  );
  // A credit note that was there at the move (a rounding credit that closed the invoice)
  // is part of how it was paid: never a flag. A later one still is.
  const rounding = inv({
    amount_paid: 1999.82,
    credit_notes: [creditNote("cn-r", "CN-0499", 0.18)],
  });
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [rounding],
      countedIds: ["x-1"],
      countedCreditNoteIds: ["cn-r"],
    }),
    null,
  );
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [inv({
        amount_paid: 0,
        credit_notes: [
          creditNote("cn-r", "CN-0499", 0.18),
          creditNote("cn-1", "CN-0500", 1999.82),
        ],
      })],
      countedIds: ["x-1"],
      countedCreditNoteIds: ["cn-r"],
    })?.credit_note_numbers,
    ["CN-0500"],
  );
  // Only a counted deposit: a job a person moved on, or another invoice, never flags.
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [refunded],
      countedIds: [],
    }),
    null,
  );
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [
        inv(),
        inv({
          xero_invoice_id: "x-9",
          reference: "SWF-261369-FINBAL",
          credit_notes: [creditNote("cn-9", "CN-0600", 300)],
        }),
      ],
      countedIds: ["x-1", "x-9"],
    }),
    null,
  );
  // Still in the deposit columns: never a flag.
  assertEquals(
    depositFlagFor({
      parties: [],
      job: { ...moved, status: "awaiting_deposit" },
      invoices: [refunded],
      countedIds: ["x-1"],
    }),
    null,
  );
  // Cleared by a person: never raised again for the same invoice.
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [refunded],
      countedIds: ["x-1"],
      cleared: [depositFlagKey("deposit_credited", "x-1")],
    }),
    null,
  );
  // A void or a payment still off is the stronger reason and is named first.
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [{ ...refunded, status: "VOIDED" }],
      countedIds: ["x-1"],
    })?.reason,
    "deposit_voided",
  );
  assertEquals(
    depositFlagFor({
      parties: [],
      job: moved,
      invoices: [{
        ...refunded,
        status: "AUTHORISED",
        amount_due: 1000,
        credit_notes: [creditNote("cn-1", "CN-0500", 1000)],
      }],
      countedIds: ["x-1"],
    })?.reason,
    "deposit_unpaid",
  );
});

Deno.test("deposit text: the template has no em dash and names the client's first name", () => {
  assertEquals(DEPOSIT_RECEIVED_TEXT_TEMPLATE.includes("—"), false);
  assertEquals(DEPOSIT_RECEIVED_TEXT_TEMPLATE.includes("–"), false);
  const t = depositReceivedText("Vicky Zhang");
  assert(t.startsWith("Hi Vicky,\n"));
  assert(t.includes("received your deposit"));
  assert(t.includes("ordering your materials"));
  assert(depositReceivedText(null).startsWith("Hi there,"));
});

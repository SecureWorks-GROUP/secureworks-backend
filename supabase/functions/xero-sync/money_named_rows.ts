// Recorded fixtures of the named real rows for money slice MN1 (money.md §9:
// M1, M5, M6, M17, M18, M19). Invoice ids, numbers, statuses, balances and
// references as the design and the 24 Sep 2026 production read recorded
// them (production read 24 Sep 2026, cached copy fields); contact names are
// replaced by labels. M17 and M18 are the design's
// named classes (a deposit invoice closed only by the closure read; an
// invoice deleted in Xero while open here), built on synthetic ids.

export const ORG = "00000000-0000-0000-0000-000000000001";

// deno-lint-ignore no-explicit-any
export function xeroInvoice(fields: Record<string, any>): Record<string, any> {
  return {
    Type: "ACCREC",
    CurrencyCode: "AUD",
    LineItems: [],
    ...fields,
  };
}

// M1 INV-0034: our copy DELETED (synced 10 May); Xero AUTHORISED, owed
// $734.48, last edited 4 Nov 2025. Missing from the debt book.
export const M1 = {
  id: "925f4829-ae21-4df2-b2a6-4f1e5e63edff",
  number: "INV-0034",
  job_id: "ec868c0e-cc7d-4dd4-8730-8db7d3e0ad9e",
  cached: {
    status: "DELETED",
    total: 734.48,
    amount_due: 0,
    amount_paid: 0,
    reference: null as string | null,
    xero_contact_id: "e2104f97-237a-4c35-ba84-d2553c4efb6a",
    synced_at: "2026-05-10T00:00:00.000Z",
  },
  xero: {
    Status: "AUTHORISED",
    Total: 734.48,
    AmountDue: 734.48,
    AmountPaid: 0,
    UpdatedDateUTC: "/Date(1762214400000+0000)/", // 4 Nov 2025
  },
};

// M5 INV-1434 (SWF-261009): the verify patch never copied the Xero contact,
// so a contact edit with no other change never reached our copy. Production
// (24 Sep) now agrees with Xero after a later edit, so the recorded contact
// is the "after" and the "before" is a labelled stand-in: the regression case.
export const M5 = {
  id: "dbd5425b-74d3-46e6-ad39-a0ce188576bf",
  number: "INV-1434",
  job_id: "a911d5a1-507b-4653-9182-397b14cfcccd",
  contact_before: "c0000000-0000-4000-8000-00000000c5b0",
  contact_after: "39e31788-25bc-4ce2-9aa1-b273e2b94410",
  total: 10095.8,
  reference: "SWF-261009-FINBAL50",
};

// M6 INV-1436 (SWF-26378): our reference SWF-26378-FINBAL; Xero 24-119-0155.
export const M6 = {
  id: "fa9b71a4-d626-4823-9510-c2d7cef0e08f",
  number: "INV-1436",
  job_id: "25414ad0-6785-4695-a337-ccdefedcc20a",
  reference_before: "SWF-26378-FINBAL",
  reference_after: "24-119-0155",
  total: 4372.5,
  contact: "ac11b974-7ea0-40ef-87a1-595be4d3d2b8",
};

// M19 INV-1435 (SWF-261010; audit B X2, sites S10): a stale payer. The
// recorded copy's contact is the "before"; the live Xero contact was not read
// (no provider call in this build), so the "after" is a labelled stand-in.
export const M19 = {
  id: "6d3b369c-f300-43cd-962c-00fd979efb58",
  number: "INV-1435",
  job_id: "9bffcdeb-8371-4d22-9fcb-83377f3afa5b",
  contact_before: "39e31788-25bc-4ce2-9aa1-b273e2b94410",
  contact_after: "c0000000-0000-4000-8000-0000000019a0",
  total: 1056.55,
  reference: "SWF-261010-FINBAL50",
};

// M17: a deposit invoice that turns PAID only through the closure read.
export const M17 = {
  id: "17000000-0000-4000-8000-000000000017",
  number: "INV-9017",
  job_id: "17000000-0000-4000-8000-0000000000a1",
  paid_on: "/Date(1790121600000+0000)/", // 23 Sep 2026
};

// M18: an ACCREC invoice deleted in Xero while open here. Xero's list reads
// omit deleted drafts; only the single-record read returns DELETED.
export const M18 = {
  id: "18000000-0000-4000-8000-000000000018",
  number: "INV-9018",
};

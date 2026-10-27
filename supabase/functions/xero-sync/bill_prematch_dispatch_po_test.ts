// Bill pre-match gold set: bills quoting a Dispatch PO number (INT-25.1, 26 Oct 2026).
//
// A Dispatch order is written by dispatch_commit_order (20261014150000) with
// subtotal 0, no xero_contact_id and a number from PO-1000001 on; it is `draft`
// until it is sent, then `sent`. Its supplier_name is the suppliers row's name.
// main's matchBill never sees such a PO (it reads PO candidates only where
// xero_contact_id is set), so these cases prove the pre-match path alone.
//
// Each case is a business outcome. The replay at the end counts wrong
// assignments: a placement on a job other than the expected one, or any
// placement where a person should decide. It must be 0.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAddressIndex,
  buildJobMaps,
  decideBillPrematch,
  type PrematchBill,
  type PrematchJob,
  type PrematchPO,
} from "./bill_prematch.ts";
import { runBillPrematch } from "./bill_prematch_run.ts";
import { baseSeed, makeFakeClient, ORG } from "../ops-api/materials_recon_test_support.ts";

const JOBS: PrematchJob[] = [
  { id: "j-fence", job_number: "SWF-261060", status: "scheduled", created_at: "2026-10-01", site_address: "9 Tuart Drive, Joondalup WA", holding: false },
  { id: "j-patio", job_number: "SWP-261290", status: "in_progress", created_at: "2026-10-02", site_address: "21 Jarrah Road, Kelmscott WA", holding: false },
  { id: "j-lost", job_number: "SWF-261070", status: "lost", created_at: "2026-10-03", site_address: null, holding: false },
];

// A sent Dispatch order, exactly as dispatch_commit_order and the send leave it.
const DISPATCH_PO: PrematchPO = {
  id: "po-d123", po_number: "PO-1000123", job_id: "j-fence", xero_contact_id: null,
  supplier_name: "Fencing Wholesalers WA", subtotal: 0, status: "sent", xero_bill_id: null,
};

function ctx(pos: PrematchPO[]) {
  return { ...buildJobMaps(JOBS), addressIndex: buildAddressIndex(JOBS), pos, emailJobIds: [] };
}

function bill(over: Partial<PrematchBill> & { line?: string; account?: string; amount?: number } = {}): PrematchBill {
  const { line, account, amount, ...rest } = over;
  const amt = amount ?? 1840.5;
  return {
    xero_invoice_id: "xb-1",
    invoice_number: "INV-552301",
    xero_contact_id: "c-fww", // the bill's Xero contact; the Dispatch PO has none
    contact_name: "Fencing Wholesalers WA",
    reference: null,
    sub_total: amt,
    invoice_date: "2026-10-20",
    xero_job_id: null,
    lines: [{ description: line ?? "Colorbond panels 2400", account_code: account ?? "305", amount: amt, business_unit: "SW - FENCING" }],
    ...rest,
  };
}

type Expect = { kind: "job"; job: string; po: string | null } | { kind: "review" | "excluded" | "none" };
type GoldCase = { name: string; bill: PrematchBill; pos: PrematchPO[]; expect: Expect };

const GOLD: GoldCase[] = [
  // ── Placed with no person: our PO number, issued, this supplier, one live job.
  { name: "PO-1000123 on the reference", bill: bill({ reference: "PO-1000123" }), pos: [DISPATCH_PO], expect: { kind: "job", job: "SWF-261060", po: "po-d123" } },
  { name: "PO1000123 on the reference", bill: bill({ reference: "PO1000123" }), pos: [DISPATCH_PO], expect: { kind: "job", job: "SWF-261060", po: "po-d123" } },
  { name: "PO 1000123 on the reference", bill: bill({ reference: "PO 1000123" }), pos: [DISPATCH_PO], expect: { kind: "job", job: "SWF-261060", po: "po-d123" } },
  { name: "PO-1000123 on a line", bill: bill({ line: "Order PO-1000123 Colorbond panels" }), pos: [DISPATCH_PO], expect: { kind: "job", job: "SWF-261060", po: "po-d123" } },
  { name: "PO1000123 on a line", bill: bill({ line: "Your ref PO1000123" }), pos: [DISPATCH_PO], expect: { kind: "job", job: "SWF-261060", po: "po-d123" } },
  { name: "PO 1000123 on a line", bill: bill({ line: "Cust order: PO 1000123 / rails" }), pos: [DISPATCH_PO], expect: { kind: "job", job: "SWF-261060", po: "po-d123" } },
  { name: "lower case po1000123", bill: bill({ reference: "po1000123" }), pos: [DISPATCH_PO], expect: { kind: "job", job: "SWF-261060", po: "po-d123" } },
  { name: "PO#1000123", bill: bill({ reference: "PO#1000123" }), pos: [DISPATCH_PO], expect: { kind: "job", job: "SWF-261060", po: "po-d123" } },
  {
    name: "our PO number and the same job number agree",
    bill: bill({ reference: "PO-1000123 SWF-261060" }), pos: [DISPATCH_PO], expect: { kind: "job", job: "SWF-261060", po: "po-d123" },
  },

  // ── Never placed: a person decides.
  { name: "a Dispatch PO still in draft (never sent)", bill: bill({ reference: "PO-1000123" }), pos: [{ ...DISPATCH_PO, status: "draft" }], expect: { kind: "review" } },
  {
    name: "another supplier's Dispatch PO",
    bill: bill({ reference: "PO-1000123", xero_contact_id: "c-other", contact_name: "Steel Supplies Perth" }),
    pos: [DISPATCH_PO], expect: { kind: "review" },
  },
  {
    // "Fencing Wholesalers WA Pty Ltd" in Xero, "Fencing Wholesalers WA" on the
    // suppliers row: the PO has no contact id to prove it, so a person confirms.
    name: "a Dispatch PO whose supplier name differs from the bill's contact name",
    bill: bill({ reference: "PO-1000123", contact_name: "Fencing Wholesalers WA Pty Ltd" }),
    pos: [DISPATCH_PO], expect: { kind: "review" },
  },
  {
    name: "our PO number but a different job number on the bill",
    bill: bill({ reference: "PO-1000123", line: "Delivery SWP-261290" }), pos: [DISPATCH_PO], expect: { kind: "review" },
  },
  { name: "a Dispatch PO on a lost job", bill: bill({ reference: "PO-1000123" }), pos: [{ ...DISPATCH_PO, job_id: "j-lost" }], expect: { kind: "review" } },
  {
    name: "a Dispatch PO another bill is already linked to",
    bill: bill({ reference: "PO-1000123" }), pos: [{ ...DISPATCH_PO, xero_bill_id: "xb-other" }], expect: { kind: "review" },
  },
  {
    name: "two of our Dispatch POs on one bill, one job",
    bill: bill({ reference: "PO-1000123 PO-1000124" }),
    pos: [DISPATCH_PO, { ...DISPATCH_PO, id: "po-d124", po_number: "PO-1000124" }], expect: { kind: "review" },
  },
  {
    name: "two of our Dispatch POs on one bill, two jobs (a split)",
    bill: bill({ reference: "PO-1000123 PO-1000124" }),
    pos: [DISPATCH_PO, { ...DISPATCH_PO, id: "po-d124", po_number: "PO-1000124", job_id: "j-patio" }], expect: { kind: "review" },
  },

  // ── Left out: the crew-bill mirror (subcontractor labour) even with our PO number.
  { name: "a crew bill on 306 quoting a Dispatch PO", bill: bill({ reference: "PO-1000123", account: "306", amount: 900 }), pos: [DISPATCH_PO], expect: { kind: "excluded" } },
  { name: "a crew bill on 301 quoting a Dispatch PO", bill: bill({ line: "Install PO1000123", account: "301", amount: 900 }), pos: [DISPATCH_PO], expect: { kind: "excluded" } },

  // ── Not our PO number: a longer or shorter number, or no prefix, names nothing.
  { name: "a longer number PO-10001234", bill: bill({ reference: "PO-10001234" }), pos: [DISPATCH_PO], expect: { kind: "none" } },
  { name: "a shorter number PO-100012", bill: bill({ reference: "PO-100012" }), pos: [DISPATCH_PO], expect: { kind: "none" } },
  { name: "the digits inside a product code XPO1000123", bill: bill({ line: "Item XPO1000123 bracket" }), pos: [DISPATCH_PO], expect: { kind: "none" } },
  { name: "the bare digits 1000123 with no PO prefix", bill: bill({ reference: "1000123" }), pos: [DISPATCH_PO], expect: { kind: "none" } },

  // ── An unpriced Dispatch PO is not a $0 price: a small bill is not "the same amount".
  { name: "a $3.20 bill from the PO's supplier naming no PO", bill: bill({ amount: 3.2, line: "Freight surcharge" }), pos: [DISPATCH_PO], expect: { kind: "none" } },
];

for (const c of GOLD) {
  Deno.test(`Dispatch PO gold set: ${c.name}`, () => {
    const d = decideBillPrematch(c.bill, ctx(c.pos));
    if (c.expect.kind === "job") {
      assertEquals(
        d.kind === "job" ? { kind: d.kind, confidence: d.confidence, job: d.job_number, po: d.po_id } : { kind: d.kind, reason: d.reason },
        { kind: "job", confidence: "high", job: c.expect.job, po: c.expect.po },
      );
    } else {
      assertEquals({ kind: d.kind, why: d.kind === "job" ? d.reason : "" }, { kind: c.expect.kind, why: "" });
    }
  });
}

Deno.test("Dispatch PO gold-set replay: 0 wrong assignments", () => {
  let wrong = 0;
  let placed = 0;
  for (const c of GOLD) {
    const d = decideBillPrematch(c.bill, ctx(c.pos));
    if (d.kind !== "job" || d.confidence !== "high") continue;
    placed++;
    if (c.expect.kind !== "job" || c.expect.job !== d.job_number || c.expect.po !== d.po_id) wrong++;
  }
  assertEquals({ wrong, placed }, { wrong: 0, placed: GOLD.filter((c) => c.expect.kind === "job").length });
});

Deno.test("a nightly run places a bill quoting a sent Dispatch PO on its job, matched to that PO, with no person", async () => {
  const seed = baseSeed();
  seed.materials_reconciliation_queue = seed.materials_reconciliation_queue
    .filter((q) => q.id === "q-open-noref")
    .map((q) => ({ ...q, xero_contact_id: "c-fww", contact_name: "Fencing Wholesalers WA" }));
  seed.jobs = [{ id: "j-fence", job_number: "SWF-261060", status: "scheduled", created_at: "2026-06-01", site_address: null, org_id: ORG }];
  seed.purchase_orders = [{ ...DISPATCH_PO }];
  seed.xero_invoices = [{
    xero_invoice_id: "xinv-001", invoice_number: "INV-552301", status: "AUTHORISED", reference: "PO1000123",
    line_items: [{ Description: "Colorbond panels 2400", AccountCode: "305", LineAmount: 1000 }], job_id: null,
  }];
  seed.context_email_attachments = [];
  seed.materials_bill_proposals = [];
  const { client, store } = makeFakeClient(seed);

  const out = await runBillPrematch(client, { orgId: ORG, nowIso: "2026-07-05T06:00:00.000Z" });
  assertEquals([out.ran, out.assigned], [true, 1]);
  const fact = store.job_materials_facts.find((f) => f.xero_invoice_id === "xinv-001")!;
  assertEquals([fact.job_id, fact.matched_po_id, fact.automation_source, fact.confidence], ["j-fence", "po-d123", "agent_prematch", "high"]);
  assertEquals(store.materials_reconciliation_queue.find((q) => q.id === "q-open-noref")!.status, "assigned");
});

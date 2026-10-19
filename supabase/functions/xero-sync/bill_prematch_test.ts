// Bill pre-match: the owner's rules on bills shaped like the live Bills to place
// list (JP-06, 15 Oct 2026). Each case is a business outcome: which bills the agent
// may place on its own, which wait for a staff press, and which it never touches.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAddressIndex,
  buildJobMaps,
  decideBillPrematch,
  type PrematchBill,
  type PrematchJob,
  type PrematchPO,
} from "./bill_prematch.ts";
import { emailJobsByBill, runBillPrematch } from "./bill_prematch_run.ts";
import { assignReconRow } from "../ops-api/materials_recon.ts";
import { baseSeed, makeFakeClient, ORG } from "../ops-api/materials_recon_test_support.ts";

const JOBS: PrematchJob[] = [
  { id: "j1", job_number: "SWF-26535", status: "complete", created_at: "2026-05-01", site_address: "12 Banksia Street, Wanneroo WA", holding: false },
  { id: "j2", job_number: "SWF-261009", status: "scheduled", created_at: "2026-08-01", site_address: "7 Acacia Road, Morley WA", holding: false },
  { id: "j3", job_number: "SWF-26100", status: "cancelled", created_at: "2026-04-01", site_address: "3 Wattle Way, Duncraig WA", holding: false },
  { id: "j4", job_number: "SWF-PDF-BUCKET", status: "accepted", created_at: "2026-01-01", site_address: null, holding: true },
  { id: "j5", job_number: "SWP-261283", status: "in_progress", created_at: "2026-08-20", site_address: "40 Marri Crescent, Ellenbrook WA", holding: false },
];

function ctx(over: { emailJobIds?: string[]; pos?: PrematchPO[] } = {}) {
  return {
    ...buildJobMaps(JOBS),
    addressIndex: buildAddressIndex(JOBS),
    pos: over.pos ?? [],
    emailJobIds: over.emailJobIds ?? [],
  };
}

function bill(lines: Array<[string | null, string, number, string?]>, over: Partial<PrematchBill> = {}): PrematchBill {
  return {
    xero_invoice_id: "x-1",
    invoice_number: "INV-83831",
    xero_contact_id: "c-1",
    contact_name: "Supplier",
    reference: null,
    sub_total: lines.reduce((s, l) => s + l[2], 0),
    invoice_date: "2026-09-01",
    xero_job_id: null,
    lines: lines.map(([description, account_code, amount, business_unit]) => ({
      description,
      account_code,
      amount,
      business_unit: business_unit ?? "SW - FENCING",
    })),
    ...over,
  };
}

Deno.test("a job number on a line naming one live job is placed automatically", () => {
  const d = decideBillPrematch(bill([["Fencing Material SWF-26535", "305", 1027.27]]), ctx());
  assertEquals(d.kind, "job");
  if (d.kind === "job") {
    assertEquals([d.confidence, d.job_number, d.rule], ["high", "SWF-26535", "job_number"]);
  }
});

Deno.test("the job on the purchase order the bill names is placed automatically", () => {
  const po: PrematchPO = { id: "p1", po_number: "PO-302382", job_id: "j2", xero_contact_id: "c-9", supplier_name: null, subtotal: 9000, status: "sent", xero_bill_id: null };
  const d = decideBillPrematch(bill([["Your order PO-302382", "305", 410]]), ctx({ pos: [po] }));
  assertEquals(d.kind === "job" && [d.confidence, d.job_number, d.rule], ["high", "SWF-261009", "po_job_number"]);
});

Deno.test("a split bill naming two jobs is never placed and picks nothing", () => {
  const d = decideBillPrematch(bill([["SWF-26535 posts", "305", 300], ["SWF-261009 rails", "305", 200]]), ctx());
  assertEquals(d.kind, "review");
  if (d.kind === "review") assertEquals([d.rule, d.candidates.map((c) => c.job_number)], ["split_bill", ["SWF-261009", "SWF-26535"]]);
});

Deno.test("a job number that disagrees with where the invoice email was filed waits for staff", () => {
  const d = decideBillPrematch(bill([["SWF-26535", "305", 100]]), ctx({ emailJobIds: ["j5"] }));
  assertEquals(d.kind === "review" && d.rule, "job_disagrees");
});

Deno.test("a cancelled job is never proposed, and a holding job is never evidence", () => {
  const cancelled = decideBillPrematch(bill([["SWF-26100 materials", "305", 34.54]]), ctx());
  assertEquals(cancelled.kind === "review" && cancelled.rule, "job_number_not_live");
  const holding = decideBillPrematch(bill([["materials", "305", 50]], { xero_job_id: "j4" }), ctx());
  assertEquals(holding.kind, "none");
});

Deno.test("a bill dated well before its job existed waits for staff", () => {
  const d = decideBillPrematch(bill([["SWP-261283 roof", "305", 900]], { invoice_date: "2026-06-01" }), ctx());
  assertEquals(d.kind === "review" && d.rule, "job_disagrees");
});

Deno.test("context signals alone are a proposal for one press, never a placement", () => {
  const email = decideBillPrematch(bill([["Colorbond sheets", "305", 8970.2]]), ctx({ emailJobIds: ["j5"] }));
  assertEquals(email.kind === "job" && [email.confidence, email.job_number], ["medium", "SWP-261283"]);
  const address = decideBillPrematch(bill([["Deliver to 7 Acacia Rd", "305", 7411.65]]), ctx());
  assertEquals(address.kind === "job" && [address.confidence, address.rule], ["medium", "street_address"]);
  const po: PrematchPO = { id: "p2", po_number: "PO-1", job_id: "j1", xero_contact_id: "c-1", supplier_name: null, subtotal: 1600, status: "sent", xero_bill_id: null };
  const amount = decideBillPrematch(bill([["posts", "305", 1593.64]]), ctx({ pos: [po] }));
  assertEquals(amount.kind === "job" && [amount.confidence, amount.rule], ["medium", "supplier_amount_po"]);
});

Deno.test("subcontractor labour (306, 301) is left out even with a job number", () => {
  const d = decideBillPrematch(bill([["Fence Installation - SWF-26535", "306", 338]]), ctx());
  assertEquals(d.kind, "excluded");
});

Deno.test("overhead accounts and SW - GROUP lines are proposed not job related", () => {
  const vehicle = decideBillPrematch(bill([["Engine oil", "449", 5672.73]]), ctx());
  assertEquals(vehicle.kind === "not_job_related" && vehicle.rule, "overhead_account");
  const group = decideBillPrematch(bill([["Stationery", "305", 80, "SW - GROUP"]]), ctx());
  assertEquals(group.kind === "not_job_related" && group.rule, "group_business_unit");
  const materials = decideBillPrematch(bill([["Post caps", "305", 43.45]]), ctx());
  assertEquals(materials.kind, "none");
});

Deno.test("an invoice email counts only when the file name carries the whole invoice number", () => {
  const bills = [bill([], { xero_invoice_id: "x-1", invoice_number: "1459061" }), bill([], { xero_invoice_id: "x-2", invoice_number: "INV-79502" })];
  const got = emailJobsByBill(bills, [
    { file_name: "Tax Invoice 1459061.pdf", job_id: "j5" },
    { file_name: "Invoice INV-795020.pdf", job_id: "j1" }, // a longer number is a different invoice
  ]);
  assertEquals([...got.entries()], [["x-1", ["j5"]]]);
});

Deno.test("a bill placed through the PO it names is matched to that PO, and a PO another bill holds waits for staff", async () => {
  const jobs: PrematchJob[] = [
    { id: "job-fence-1", job_number: "SWF-25010", status: "scheduled", created_at: "2026-06-01", site_address: null, holding: false },
  ];
  const po: PrematchPO = { id: "po-9", po_number: "PO-302382", job_id: "job-fence-1", xero_contact_id: "c-9", supplier_name: null, subtotal: 9000, status: "sent", xero_bill_id: null };
  const place = (poFactBills?: Map<string, string[]>, linked: string | null = null) =>
    decideBillPrematch(
      bill([["Your order PO-302382", "305", 1000]], { xero_invoice_id: "xinv-001", invoice_date: "2026-07-02" }),
      { ...buildJobMaps(jobs), addressIndex: buildAddressIndex(jobs), pos: [{ ...po, xero_bill_id: linked }], emailJobIds: [], poFactBills },
    );

  const d = place();
  if (d.kind !== "job" || d.confidence !== "high") throw new Error(`expected a placement, got ${d.kind}`);
  assertEquals(d.po_id, "po-9");
  const { client, store } = makeFakeClient(baseSeed());
  await assignReconRow(client, {
    queueId: "q-open-noref", jobId: d.job_id, actor: "agent_prematch", orgId: ORG,
    agent: { matchReason: `${d.rule}: ${d.reason}`, matchedPoId: d.po_id },
  });
  const fact = store.job_materials_facts.find((f) => f.xero_invoice_id === "xinv-001")!;
  assertEquals([fact.job_id, fact.matched_po_id, fact.kind], ["job-fence-1", "po-9", "actual"]);

  const factTaken = place(new Map([["po-9", ["xinv-other"]]]));
  assertEquals(factTaken.kind === "review" && [factTaken.rule, factTaken.candidates.map((c) => c.job_number)], [
    "po_already_matched", ["SWF-25010"],
  ]);
  const linkedTaken = place(undefined, "xinv-other");
  assertEquals(linkedTaken.kind === "review" && linkedTaken.rule, "po_already_matched");
});

Deno.test("two bills naming one purchase order in one sync: the first is placed on it, the second waits for staff", async () => {
  const seed = baseSeed();
  seed.materials_reconciliation_queue = seed.materials_reconciliation_queue.filter((q) => q.id === "q-open-noref" || q.id === "q-open-refnojob");
  seed.jobs = [{ id: "job-fence-1", job_number: "SWF-25010", status: "scheduled", created_at: "2026-06-01", site_address: null, org_id: ORG }];
  seed.purchase_orders = [{ id: "po-9", po_number: "PO-302382", job_id: "job-fence-1", xero_contact_id: "c-9", supplier_name: null, subtotal: 9000, status: "sent", xero_bill_id: null }];
  const line = (amount: number) => [{ Description: "Your order PO-302382", AccountCode: "305", LineAmount: amount }];
  seed.xero_invoices = [
    { xero_invoice_id: "xinv-001", invoice_number: "12345678", status: "AUTHORISED", reference: null, line_items: line(1000), job_id: null },
    { xero_invoice_id: "xinv-003", invoice_number: "BD-7777", status: "AUTHORISED", reference: null, line_items: line(250), job_id: null },
  ];
  seed.context_email_attachments = [];
  seed.materials_bill_proposals = [];
  const { client, store } = makeFakeClient(seed);

  const out = await runBillPrematch(client, { orgId: ORG, nowIso: "2026-07-05T06:00:00.000Z" });
  assertEquals([out.ran, out.assigned], [true, 1]);
  const facts = store.job_materials_facts;
  assertEquals(facts.map((f) => [f.xero_invoice_id, f.matched_po_id]), [["xinv-001", "po-9"]]);
  const second = store.materials_bill_proposals.find((p) => p.xero_invoice_id === "xinv-003")!;
  assertEquals([second.proposal_kind, second.rule, second.outcome], ["review", "po_already_matched", "queued_for_review"]);
  assertEquals(store.materials_reconciliation_queue.find((q) => q.id === "q-open-refnojob")!.status, "open");
});

Deno.test("a proposal past the first 1,000 rows of a bill's history still counts: an undone placement is not placed again", async () => {
  const seed = baseSeed();
  seed.materials_reconciliation_queue = seed.materials_reconciliation_queue.filter((q) => q.id === "q-open-noref");
  seed.jobs = [{ id: "job-fence-1", job_number: "SWF-25010", status: "scheduled", created_at: "2026-06-01", site_address: null, org_id: ORG }];
  seed.purchase_orders = [];
  seed.xero_invoices = [
    { xero_invoice_id: "xinv-001", invoice_number: "12345678", status: "AUTHORISED", reference: null, line_items: [{ Description: "Job SWF-25010 posts", AccountCode: "305", LineAmount: 1000 }], job_id: null },
  ];
  seed.context_email_attachments = [];
  seed.materials_bill_proposals = Array.from({ length: 1001 }, (_, i) => ({
    id: `p-${String(i).padStart(4, "0")}`,
    xero_invoice_id: "xinv-001",
    outcome: "superseded",
    outcome_reason: "bill changed",
    input_hash: `h-${i}`,
    // The one earlier agent placement, undone by staff, sorts last.
    auto_assigned_at: i === 1000 ? "2026-07-01T00:00:00.000Z" : null,
  }));
  const { client, store } = makeFakeClient(seed);

  const out = await runBillPrematch(client, { orgId: ORG, nowIso: "2026-07-05T06:00:00.000Z" });
  assertEquals([out.ran, out.assigned], [true, 0]);
  assertEquals(store.job_materials_facts ?? [], []);
  assertEquals(store.materials_reconciliation_queue[0].status, "open");
});

// Live cases, 19 Oct 2026 (Projects/job-profit/verify/evidence/20261019-guarded-placement).
Deno.test("a job number written without its hyphen still names the job (R&R 85228, SWF261060)", () => {
  const d = decideBillPrematch(bill([["INV-85228 Tax Invoice (SWF261009) Delivery", "305", 930.27]]), ctx());
  assertEquals(d.kind, "job");
  if (d.kind === "job") assertEquals([d.confidence, d.job_number], ["high", "SWF-261009"]);
});

Deno.test("a longer job number never names the shorter one (SWF-261009 is not SWF-26100)", () => {
  const d = decideBillPrematch(bill([["Panels for SWF-261009", "305", 500]]), ctx());
  assertEquals(d.kind === "job" ? d.job_number : null, "SWF-261009");
});

Deno.test("a bill naming a job that was never won goes to a person, not onto the job", () => {
  const jobs: PrematchJob[] = [...JOBS, { id: "j6", job_number: "SWF-26958", status: "draft", created_at: "2026-07-01", site_address: null, holding: false }];
  const d = decideBillPrematch(bill([["SWF26958 caps", "305", 40.91]]), { ...buildJobMaps(jobs), addressIndex: buildAddressIndex(jobs), pos: [], emailJobIds: [] });
  assertEquals([d.kind, d.rule], ["review", "job_number_not_live"]);
});

Deno.test("the same digits on two prefixes go to a person (SWF-26328 and SWP-26328)", () => {
  const jobs: PrematchJob[] = [
    ...JOBS,
    { id: "j7", job_number: "SWF-26328", status: "archived", created_at: "2026-04-01", site_address: null, holding: false },
    { id: "j8", job_number: "SWP-26328", status: "in_progress", created_at: "2026-05-01", site_address: null, holding: false },
  ];
  const d = decideBillPrematch(bill([["Metroll order SWP-26328", "305", 355.54]]), { ...buildJobMaps(jobs), addressIndex: buildAddressIndex(jobs), pos: [], emailJobIds: [] });
  assertEquals(d.kind, "review");
});

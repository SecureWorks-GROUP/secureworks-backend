import assert from "node:assert/strict";
import { myPayYearSummaryPdf } from "./trade_year_summary_pdf.ts";
import { TRADE_PREVIEW_READS } from "./trade_owner_preview.ts";

type Row = Record<string, any>;
const caller = { id: "trade-a", role: "crew" };
const query = () => new URLSearchParams({ fy: "2027" });
const invoice = (id: string, week: string): Row => ({
  id, invoice_number: id, week_end: week, week_start: null, user_id: caller.id, status: "approved",
  gross_earned: 112.01, super_rate: 0.12, super_basis: "inclusive_12_112_v1", super_amount: 12,
  subtotal_ex: 112.01, total_inc: 112.01, net_pay: 100.01, amount_paid: 0, gst_on: false,
  gst: 0, reimbursements: [], recurring_deduction_label: null, recurring_deduction_amount: null,
});
function store() {
  const rows = [invoice("ZZTEST-01", "2026-07-01"), invoice("ZZTEST-02", "2027-06-30")];
  const profile = { id: caller.id, name: "ZZTEST Trade", abn: "ZZTEST ABN" };
  const faults = new Set<string>();
  const reads: string[] = [];
  const client = { from(table: string) {
    reads.push(table);
    let selected = table === "users" ? [profile] as Row[] : [...rows];
    let limit = 0;
    return {
      select() { return this; },
      eq(key: string, val: string) {
        if (key !== "reimbursements.line_type") selected = selected.filter(r => r[key] === val);
        return this;
      },
      not() { return this; },
      or(range: string) {
        assert.equal(range, "and(week_end.gte.2026-07-01,week_end.lte.2027-06-30),and(week_end.is.null,created_at.gte.2026-07-01,created_at.lt.2027-07-01)");
        selected = selected.filter(r => {
          const day = r.week_end || r.created_at?.slice(0, 10);
          return day >= "2026-07-01" && day <= "2027-06-30";
        });
        return this;
      },
      order() { selected.sort((a, b) => a.id.localeCompare(b.id)); return this; },
      limit(n: number) { limit = n; return this; },
      gt(key: string, value: string) { selected = selected.filter(r => r[key] > value); return this; },
      maybeSingle() { return { data: selected[0], error: faults.has(table) }; },
      then(resolve: (v: unknown) => void) { resolve({ data: selected.slice(0, limit), error: faults.has(table) }); },
    };
  } };
  const read = () => myPayYearSummaryPdf(client, caller, "GET", query());
  return { client, reads, profile, rows, faults, read };
}

// Extract the WinAnsi text operands from the generated PDF content stream.
async function contents(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="pay-summary-2027.pdf"');
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const pdf = await response.text();
  assert.match(pdf, /\/Count 1\b/);
  return Array.from(pdf.matchAll(/<([0-9a-f]+)> Tj/g), match =>
    new TextDecoder("windows-1252").decode(Uint8Array.fromHex(match[1])));
}

export async function sample() { return new Uint8Array(await (await store().read()).arrayBuffer()); }

Deno.test("own financial year reconciles and excludes another trade, adjacent years and voids", async () => {
  const { rows, read } = store();
  rows.push({ ...rows[0], id: "other", user_id: "trade-b", invoice_number: "private" },
    invoice("previous", "2026-06-30"), invoice("next", "2027-07-01"),
    { ...rows[0], invoice_number: "void", xero_bill_status: "VOIDED" });
  assert.deepEqual(await contents(await read()), [
    "Pay summary, 1 July 2026 to 30 June 2027", "ZZTEST Trade", "ABN ZZTEST ABN",
    "Total (includes super)", "$224.02", "Paid to your super fund", "$24.00", "Paid to you", "$200.02",
    "Reimbursements", "$0.00", "GST", "$0.00", "Repayments", "$0.00",
    "Invoice number", "Week starting", "Total", "Super", "Paid to you",
    "ZZTEST-01", "2026-06-29", "$112.01", "$12.00", "$100.01",
    "ZZTEST-02", "2027-06-28", "$112.01", "$12.00", "$100.01",
    "Built from your SecureWorks invoices. A summary, not tax advice. Give it to your accountant.",
  ]);
});

Deno.test("office, foreign identity, preview and invalid year are refused before pay reads", async () => {
  const { client, reads } = store();
  assert.equal(TRADE_PREVIEW_READS.has("my_pay_year_summary_pdf"), false);
  for (const role of ["owner", "admin", "ops_manager", "sales", "unknown"]) {
    assert.equal((await myPayYearSummaryPdf(client, { ...caller, role }, "GET", query())).status, 403);
  }
  assert.equal((await myPayYearSummaryPdf(client, caller, "GET", new URLSearchParams("fy=2027&user_id=trade-b"))).status, 403);
  for (const input of ["", "fy=0", "fy=27", "fy=2026-07-01", "fy=2027&fy=2028"]) {
    const res = await myPayYearSummaryPdf(client, caller, "GET", new URLSearchParams(input));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { code: "fy_invalid" });
  }
  assert.deepEqual(reads, []);
});

Deno.test("empty year is 404; missing profile, figures or unreadable rows refuse and can be retried", async () => {
  const { profile, rows, faults, read } = store();
  for (const table of ["users", "trade_invoices"]) {
    faults.add(table);
    assert.equal((await read()).status, 503);
    faults.clear();
  }
  profile.abn = "";
  assert.equal((await read()).status, 503);
  profile.abn = "ZZTEST UPDATED";
  rows[1].amount_paid = null;
  assert.equal((await read()).status, 503);
  rows[1].amount_paid = 17;
  rows[1].recurring_deduction_label = "repayment";
  rows[1].recurring_deduction_amount = 2.03;
  const text = await contents(await read());
  assert.ok(text.includes("ABN ZZTEST UPDATED"));
  assert.equal(text[text.indexOf("Repayments") + 1], "$2.03");
  rows.length = 0;
  const res = await read();
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { code: "no_invoices_that_year" });
});

Deno.test("a full invoice page continues and all rows fit on one PDF page", async () => {
  const { rows, read } = store();
  rows.length = 0;
  for (let n = 0; n < 251; n++) rows.push(invoice("ZZTEST-" + n, "2026-08-01"));
  const text = await contents(await read());
  assert.equal(text.filter(v => v.startsWith("ZZTEST-")).length, 251);
  assert.equal(text[text.indexOf("Total (includes super)") + 1], "$28114.51");
});

Deno.test("mixed invoices total recorded super and identify every missing split", async () => {
  const { rows, read } = store();
  const legacy = { ...invoice("ZZTEST-03", "2026-08-01"), super_basis: null,
    super_amount: null, net_pay: null, total_inc: 47.23 };
  rows.push(legacy, { ...legacy, id: "ZZTEST-04", invoice_number: "ZZTEST-04" });
  const text = await contents(await read());
  assert.ok(text.includes("Super not recorded on 2 invoices"));
  assert.equal(text[text.indexOf("Paid to your super fund") + 1], "$24.00");
  assert.equal(text[text.indexOf("Total (includes super)") + 1], "$318.48");
  assert.equal(text[text.indexOf("Paid to you") + 1], "$294.48");
  for (const number of ["ZZTEST-03", "ZZTEST-04"]) {
    const index = text.indexOf(number);
    assert.deepEqual(text.slice(index + 2, index + 5), ["$47.23", "Not recorded", "$47.23"]);
  }
  rows[0].super_amount = null;
  assert.equal((await read()).status, 503);
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { invoiceContext } from "./invoice_context.ts";
import { isCurrentContextFact } from "./context_visibility.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "aa000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-09-13T05:00:00.000Z");

function fakeClient(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const q: any = {};
      const chain = (fn: (...a: any[]) => void) => (...args: any[]) => {
        fn(...args);
        return q;
      };
      q.select = chain(() => {});
      q.eq = chain((c: string, v: any) => filters.push((r) => r[c] === v));
      q.neq = chain((c: string, v: any) => filters.push((r) => r[c] !== v));
      q.gt = chain((c: string, v: any) => filters.push((r) => r[c] > v));
      q.in = chain((c: string, v: any[]) => filters.push((r) => v.includes(r[c])));
      q.ilike = chain((c: string, v: string) => filters.push((r) => String(r[c] ?? "").toLowerCase() === String(v).replace(/%/g, "").toLowerCase()));
      q.order = chain(() => {});
      q.limit = chain(() => {});
      q.range = chain(() => {});
      const run = () => ({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
      q.maybeSingle = async () => {
        const r = run();
        return { data: r.data[0] ?? null, error: null };
      };
      q.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej);
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

function deps(tables: Record<string, any[]>) {
  return {
    client: fakeClient(tables),
    orgId: ORG,
    getJobConversation: async () => ({ messages: [] }),
    isCurrentContextFact,
    now: () => NOW,
  };
}

function invoiceRow(number: string, extra: Record<string, unknown> = {}) {
  return {
    org_id: ORG,
    invoice_type: "ACCREC",
    xero_invoice_id: "bb000000-0000-4000-8000-0000000000aa",
    invoice_number: number,
    status: "AUTHORISED",
    amount_due: 500,
    amount_paid: 0,
    total: 500,
    job_id: JOB,
    synced_at: "2026-09-13T04:00:00.000Z",
    raw_json: { Payments: [] },
    ...extra,
  };
}

Deno.test("CLIENT-DEPOSIT-001: two deposit facts do not invent extra cash", async () => {
  const out = await invoiceContext(new URLSearchParams({ invoice: "INV-SAMPLE-DEP" }), deps({
    xero_invoices: [invoiceRow("INV-SAMPLE-DEP", { amount_paid: 500, raw_json: { Payments: [{ Amount: 500 }] } })],
    jobs: [{ id: JOB, job_number: "CLIENT-DEPOSIT-001", type: "fencing", status: "invoiced", ghl_contact_id: "ghl-d" }],
    current_job_context_facts: [
      { id: "f1", job_id: JOB, kind: "note", value: { text: "deposit 500 on 1 Sep" }, provenance: {}, updated_at: "2026-09-01T00:00:00.000Z" },
      { id: "f2", job_id: JOB, kind: "note", value: { text: "deposit 500 on 8 Sep" }, provenance: {}, updated_at: "2026-09-08T00:00:00.000Z" },
    ],
    contact_matches: [],
    job_variations: [],
    work_orders: [],
    council_submissions: [],
    extraction_jobs: [],
    payment_chase_logs: [],
    ghl_conversation_cache: [],
    inbox_events: [],
    job_events: [],
    business_events: [],
  }));
  assertEquals(out.facts.length, 2);
  assertEquals(JSON.stringify(out.facts).includes("1500"), false);
  assertEquals(out.bank.xero_payments.length, 1);
});

Deno.test("INV-SAMPLE-001: cash claim without a Xero payment is not received money", async () => {
  const out = await invoiceContext(new URLSearchParams({ invoice: "INV-SAMPLE-001" }), deps({
    xero_invoices: [invoiceRow("INV-SAMPLE-001")],
    jobs: [{ id: JOB, job_number: "SWF-SAMPLE", type: "fencing", status: "invoiced", ghl_contact_id: "ghl-c" }],
    current_job_context_facts: [
      { id: "f-cash", job_id: JOB, kind: "note", value: { text: "client paid cash 800" }, provenance: {}, updated_at: "2026-09-10T00:00:00.000Z" },
    ],
    contact_matches: [],
    job_variations: [],
    work_orders: [],
    council_submissions: [],
    extraction_jobs: [],
    payment_chase_logs: [],
    ghl_conversation_cache: [],
    inbox_events: [],
    job_events: [],
    business_events: [],
  }));
  assertEquals(out.invoice.amount_paid, 0);
  assertEquals(out.bank.xero_payments.length, 0);
  assertEquals(out.facts[0].value.text.includes("paid cash"), true);
});

Deno.test("CLIENT-CHASE-001: no stored client message is conversation_missing, not a completed chase", async () => {
  const out = await invoiceContext(new URLSearchParams({ invoice: "INV-SAMPLE-CHASE" }), deps({
    xero_invoices: [invoiceRow("INV-SAMPLE-CHASE")],
    jobs: [{ id: JOB, job_number: "CLIENT-CHASE-001", type: "patio", status: "invoiced", ghl_contact_id: null }],
    current_job_context_facts: [],
    contact_matches: [],
    job_variations: [],
    work_orders: [],
    council_submissions: [],
    extraction_jobs: [],
    payment_chase_logs: [],
    ghl_conversation_cache: [],
    inbox_events: [],
    job_events: [],
    business_events: [],
  }));
  assertEquals(out.coverage.conversation_present, false);
  assertEquals(out.blockers.some((b: { code: string }) => b.code === "conversation_missing" || b.code === "no_ghl_contact"), true);
});

// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readBillsInWindow } from "./bills_window_read.ts";

// A PostgREST stand-in over `rows`: applies eq / gte / not-in, the two orders
// and range, and logs every call so the test can see the filters and order.
function fakeSb(rows: any[], failOnPage: number | null = null) {
  const calls: Array<Array<[string, unknown[]]>> = [];
  return {
    calls,
    from(table: string) {
      assertEquals(table, "xero_invoices");
      const ops: Array<[string, unknown[]]> = [];
      calls.push(ops);
      const q: any = {};
      for (const m of ["select", "eq", "gte", "not", "order", "or"]) {
        q[m] = (...args: unknown[]) => {
          ops.push([m, args]);
          return q;
        };
      }
      q.limit = (n: number) => {
        ops.push(["limit", [n]]);
        if (failOnPage !== null && calls.length === failOnPage) {
          return Promise.resolve({ data: null, error: { message: "boom" } });
        }
        let out = rows.slice();
        for (const [m, a] of ops) {
          if (m === "eq") out = out.filter((r) => r[a[0] as string] === a[1]);
          if (m === "gte") out = out.filter((r) => r[a[0] as string] >= (a[1] as string));
          if (m === "not") out = out.filter((r) => !["VOIDED", "DELETED"].includes(r.status));
          if (m === "or") {
            const mm = String(a[0]).match(/^invoice_date\.lt\.([^,]+),and\(invoice_date\.eq\.([^,]+),xero_invoice_id\.gt\.([^)]+)\)$/)!;
            out = out.filter((r) => r.invoice_date < mm[1] || (r.invoice_date === mm[2] && r.xero_invoice_id > mm[3]));
          }
        }
        out.sort((x, y) =>
          x.invoice_date !== y.invoice_date
            ? (x.invoice_date < y.invoice_date ? 1 : -1)
            : (x.xero_invoice_id < y.xero_invoice_id ? -1 : 1)
        );
        return Promise.resolve({ data: out.slice(0, n), error: null });
      };
      return q;
    },
  };
}

function bills(n: number, extra: Partial<any> = {}) {
  return Array.from({ length: n }, (_, i) => ({
    xero_invoice_id: `b${String(i).padStart(4, "0")}`,
    org_id: "org",
    invoice_type: "ACCPAY",
    status: "AUTHORISED",
    invoice_date: `2026-${String(8 + (i % 3)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
    ...extra,
  }));
}

Deno.test("bills window: all 802 bills are read, none twice (19 Oct had 802 vs the old 500 limit)", async () => {
  const rows = bills(802);
  const sb = fakeSb(rows);
  const r = await readBillsInWindow(sb, { orgId: "org", cutoff: "2026-07-21" });
  assert(r);
  assertEquals(r.bills.length, 802);
  assertEquals(new Set(r.bills.map((b) => b.xero_invoice_id)).size, 802);
  assertEquals(r.pages, 2);
  // fixed order: newest invoice first, then id, so page boundaries are stable
  for (const ops of sb.calls) {
    const orders = ops.filter(([m]) => m === "order").map(([, a]) => a);
    assertEquals(orders, [
      ["invoice_date", { ascending: false }],
      ["xero_invoice_id", { ascending: true }],
    ]);
  }
  assertEquals(sb.calls[0].find(([m]) => m === "limit")![1], [500]);
  assert(!sb.calls[0].some(([m]) => m === "or"));
  assert(sb.calls[1].some(([m]) => m === "or"));
});

Deno.test("bills window: an exact multiple of the page size reads one empty page and stops", async () => {
  const sb = fakeSb(bills(1000));
  const r = await readBillsInWindow(sb, { orgId: "org", cutoff: "2026-07-21" });
  assert(r);
  assertEquals(r.bills.length, 1000);
  assertEquals(r.pages, 3);
});

Deno.test("bills window: the filters are the ingest's (org, ACCPAY, cutoff, not void/deleted)", async () => {
  const rows = [
    ...bills(3),
    { xero_invoice_id: "void", org_id: "org", invoice_type: "ACCPAY", status: "VOIDED", invoice_date: "2026-09-01" },
    { xero_invoice_id: "old", org_id: "org", invoice_type: "ACCPAY", status: "PAID", invoice_date: "2026-01-01" },
    { xero_invoice_id: "sale", org_id: "org", invoice_type: "ACCREC", status: "PAID", invoice_date: "2026-09-01" },
    { xero_invoice_id: "other", org_id: "org2", invoice_type: "ACCPAY", status: "PAID", invoice_date: "2026-09-01" },
  ];
  const sb = fakeSb(rows);
  const r = await readBillsInWindow(sb, { orgId: "org", cutoff: "2026-07-21" });
  assert(r);
  assertEquals(r.bills.map((b) => b.xero_invoice_id).sort(), ["b0000", "b0001", "b0002"]);
  const ops = sb.calls[0];
  assert(ops.some(([m, a]) => m === "eq" && a[0] === "org_id" && a[1] === "org"));
  assert(ops.some(([m, a]) => m === "eq" && a[0] === "invoice_type" && a[1] === "ACCPAY"));
  assert(ops.some(([m, a]) => m === "gte" && a[0] === "invoice_date" && a[1] === "2026-07-21"));
  assert(ops.some(([m, a]) => m === "not" && a[0] === "status" && a[2] === '("VOIDED","DELETED")'));
});

Deno.test("bills window: a failed page fails the whole read, never a partial window", async () => {
  const sb = fakeSb(bills(802), 2);
  const r = await readBillsInWindow(sb, { orgId: "org", cutoff: "2026-07-21" });
  assertEquals(r, null);
});

Deno.test("bills window: a manual cap stops at the cap", async () => {
  const sb = fakeSb(bills(802));
  const r = await readBillsInWindow(sb, { orgId: "org", cutoff: "2026-07-21", cap: 600 });
  assert(r);
  assertEquals(r.bills.length, 600);
  assertEquals(sb.calls[1].find(([m]) => m === "limit")![1], [100]);
});

Deno.test("bills window: a bill voided between pages cannot push another bill out of the read", async () => {
  const rows = bills(802);
  const sb = fakeSb(rows);
  // Wrap: after the first page is read, void one bill already read.
  const realFrom = sb.from.bind(sb);
  let n = 0;
  (sb as any).from = (t: string) => {
    // Void a bill that page one returned (the newest-first order puts the
    // latest invoice_date first), so later pages would shift under offsets.
    if (n++ === 1) {
      const firstPage = rows.filter((r) => r.status === "AUTHORISED").sort((x, y) =>
        x.invoice_date !== y.invoice_date
          ? (x.invoice_date < y.invoice_date ? 1 : -1)
          : (x.xero_invoice_id < y.xero_invoice_id ? -1 : 1)
      ).slice(0, 500);
      firstPage[0].status = "VOIDED";
    }
    return realFrom(t);
  };
  const r = await readBillsInWindow(sb, { orgId: "org", cutoff: "2026-07-21" });
  assert(r);
  // Every bill still in the window after the change was read.
  const still = rows.filter((x) => x.status !== "VOIDED").map((x) => x.xero_invoice_id);
  const got = new Set(r.bills.map((b) => b.xero_invoice_id));
  for (const id of still) assert(got.has(id), id);
});

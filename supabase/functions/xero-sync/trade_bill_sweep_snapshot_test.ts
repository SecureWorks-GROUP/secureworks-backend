// The trade bill PDF sweep stores status, raw_json, line_items, sub_total and
// total from ONE Xero read, or nothing (director ruling 18 Nov). Made-up bills
// only.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tradeBillSweepSnapshotPatch } from "./trade_bill_status.ts";

const NOW = "2026-11-18T00:00:00.000Z";

// What the cache held when the bill was pushed as a draft.
const cachedRow = () => ({
  xero_invoice_id: "bill-1",
  status: "DRAFT",
  line_items: [{ LineItemID: "l-1", Description: "Labour week 1", LineAmount: 100 }],
  sub_total: 100,
  total: 100,
  raw_json: { InvoiceID: "bill-1", Status: "DRAFT", HasAttachments: null },
  synced_at: "2026-11-01T00:00:00.000Z",
});

// The office then edited it in Xero: approved, and a line changed and added.
const editedInXero = {
  InvoiceID: "bill-1",
  Type: "ACCPAY",
  Status: "AUTHORISED",
  HasAttachments: true,
  LineItems: [
    { LineItemID: "l-1", Description: "Labour week 1", LineAmount: 90 },
    { LineItemID: "l-2", Description: "Office adjustment", LineAmount: -10 },
  ],
  SubTotal: 80,
  Total: 80,
};

function apply(row: Record<string, unknown>, patch: Record<string, unknown> | null) {
  return patch ? { ...row, ...patch } : row;
}

Deno.test("an edited bill whose lines changed stores the new lines beside the new status", () => {
  const stored = apply(cachedRow(), tradeBillSweepSnapshotPatch(editedInXero, NOW));
  assertEquals(stored.status, "AUTHORISED");
  assertEquals(stored.line_items, editedInXero.LineItems);
  assertEquals(stored.raw_json, editedInXero);
  // One snapshot: the status and lines read back out of raw_json match the columns.
  const raw = stored.raw_json as typeof editedInXero;
  assertEquals(raw.Status, stored.status);
  assertEquals(raw.LineItems, stored.line_items);
  assertEquals(stored.sub_total, 80);
  assertEquals(stored.total, 80);
  assertEquals(stored.synced_at, NOW);
});

Deno.test("the attach path records HasAttachments on the same read and keeps its lines", () => {
  const read = { ...editedInXero, HasAttachments: false };
  const stored = apply(cachedRow(), tradeBillSweepSnapshotPatch(read, NOW, { ...read, HasAttachments: true }));
  assertEquals(stored.status, "AUTHORISED");
  assertEquals(stored.line_items, read.LineItems);
  assertEquals((stored.raw_json as any).HasAttachments, true);
  assertEquals((stored.raw_json as any).LineItems, stored.line_items);
  assertEquals(stored.sub_total, 80);
  assertEquals(stored.total, 80);
});

// The held case (director 08:06): a 100 draft the office reduced to 80 and
// approved in Xero, then the sweep attached its PDF. The cache must count 80,
// never the old 100, beside the new status and lines.
Deno.test("attach path: a 100 draft reduced to 80 in Xero stores 80, not 100", () => {
  const read = {
    InvoiceID: "bill-1",
    Type: "ACCPAY",
    Status: "AUTHORISED",
    HasAttachments: false,
    LineItems: [{ LineItemID: "l-1", Description: "Labour week 1", LineAmount: 80 }],
    SubTotal: 80,
    Total: 80,
  };
  const stored = apply(cachedRow(), tradeBillSweepSnapshotPatch(read, NOW, { ...read, HasAttachments: true }));
  assertEquals(stored.status, "AUTHORISED");
  assertEquals(stored.line_items, read.LineItems);
  assertEquals(stored.sub_total, 80);
  assertEquals(stored.total, 80);
  assertEquals((stored.raw_json as any).SubTotal, stored.sub_total);
  assertEquals((stored.raw_json as any).Total, stored.total);
  assertEquals((stored.raw_json as any).HasAttachments, true);
});

Deno.test("an explicit zero amount is stored as zero, not skipped", () => {
  const read = { ...editedInXero, LineItems: [], SubTotal: 0, Total: 0 };
  const stored = apply(cachedRow(), tradeBillSweepSnapshotPatch(read, NOW));
  assertEquals(stored.sub_total, 0);
  assertEquals(stored.total, 0);
  assertEquals(stored.status, "AUTHORISED");
});

Deno.test("a read missing SubTotal or Total writes nothing: the old amount is not kept beside new lines", () => {
  const { SubTotal: _s, ...noSub } = editedInXero;
  const { Total: _t, ...noTotal } = editedInXero;
  assertEquals(tradeBillSweepSnapshotPatch(noSub, NOW), null);
  assertEquals(tradeBillSweepSnapshotPatch(noTotal, NOW), null);
  assertEquals(tradeBillSweepSnapshotPatch({ ...editedInXero, SubTotal: null }, NOW), null);
  assertEquals(tradeBillSweepSnapshotPatch({ ...editedInXero, Total: "" }, NOW), null);
  assertEquals(tradeBillSweepSnapshotPatch({ ...editedInXero, Total: "not a number" }, NOW), null);
  assertEquals(apply(cachedRow(), tradeBillSweepSnapshotPatch(noSub, NOW)), cachedRow());
});

Deno.test("an edit that removed every line stores the empty list, not the old lines", () => {
  const read = { ...editedInXero, LineItems: [], SubTotal: 0, Total: 0 };
  const stored = apply(cachedRow(), tradeBillSweepSnapshotPatch(read, NOW));
  assertEquals(stored.line_items, []);
  assertEquals(stored.status, "AUTHORISED");
});

Deno.test("a read with no line list writes nothing: the row keeps its earlier snapshot", () => {
  const { LineItems: _omit, ...noLines } = editedInXero;
  assertEquals(tradeBillSweepSnapshotPatch(noLines, NOW), null);
  assertEquals(tradeBillSweepSnapshotPatch({ ...editedInXero, LineItems: null }, NOW), null);
  assertEquals(apply(cachedRow(), tradeBillSweepSnapshotPatch(noLines, NOW)), cachedRow());
});

Deno.test("a read with no invoice id writes nothing", () => {
  assertEquals(tradeBillSweepSnapshotPatch({ ...editedInXero, InvoiceID: "" }, NOW), null);
  assertEquals(tradeBillSweepSnapshotPatch(null, NOW), null);
});

Deno.test("every cached-bill write in the PDF sweep goes through the one snapshot patch", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = src.indexOf("async function sweepTradeBillPdfs(");
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);
  const writes = [...body.matchAll(/from\('xero_invoices'\)\.update\(([^)]*)\)/g)].map((m) => m[1]);
  assertEquals(writes.length, 2);
  assertEquals(writes.every((arg) => arg === "snapshot"), true);
  assertEquals((body.match(/tradeBillSweepSnapshotPatch\(/g) || []).length, 2);
});

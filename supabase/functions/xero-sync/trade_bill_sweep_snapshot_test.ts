// The trade bill PDF sweep stores status, raw_json and line_items from ONE
// Xero read, or nothing (director ruling 18 Nov). Made-up bills only.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tradeBillSweepSnapshotPatch } from "./trade_bill_status.ts";

const NOW = "2026-11-18T00:00:00.000Z";

// What the cache held when the bill was pushed as a draft.
const cachedRow = () => ({
  xero_invoice_id: "bill-1",
  status: "DRAFT",
  line_items: [{ LineItemID: "l-1", Description: "Labour week 1", LineAmount: 100 }],
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
  assertEquals(stored.synced_at, NOW);
});

Deno.test("the attach path records HasAttachments on the same read and keeps its lines", () => {
  const read = { ...editedInXero, HasAttachments: false };
  const stored = apply(cachedRow(), tradeBillSweepSnapshotPatch(read, NOW, { ...read, HasAttachments: true }));
  assertEquals(stored.status, "AUTHORISED");
  assertEquals(stored.line_items, read.LineItems);
  assertEquals((stored.raw_json as any).HasAttachments, true);
  assertEquals((stored.raw_json as any).LineItems, stored.line_items);
});

Deno.test("an edit that removed every line stores the empty list, not the old lines", () => {
  const read = { ...editedInXero, LineItems: [] };
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

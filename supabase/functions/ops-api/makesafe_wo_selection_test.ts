// ════════════════════════════════════════════════════════════
// MAKE-SAFE WO PDF SELECTION TESTS
// Mission: makesafe-wo-capture-recovery-2026-06-17 (AC1, AC2)
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Exercises:
//   - scoreWorkOrder: strong / weak / combined / no-signal cases
//   - selectWorkOrderPdf: n=0 / n=1 / report+WO / two-WO tiebreak / combined name
//   - attachmentKeyComponent: uniqueness + fallback
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_wo_selection_test.ts

import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachmentKeyComponent,
  scoreWorkOrder,
  selectWorkOrderPdf,
  WoAttachmentInput,
} from "./makesafe_wo_selection.ts";

// ── scoreWorkOrder tests ─────────────────────────────────────────────────────────

Deno.test("scoreWorkOrder: 'work order' strong signal (100)", () => {
  assertEquals(scoreWorkOrder("work_order_MLB-25096.pdf"), 100);
  assertEquals(scoreWorkOrder("work order report.pdf"), 100);
  assertEquals(scoreWorkOrder("WORK ORDER - AJBR 67998.pdf"), 100);
});

Deno.test("scoreWorkOrder: 'works order' strong signal (100)", () => {
  assertEquals(scoreWorkOrder("works_order_123.pdf"), 100);
  assertEquals(scoreWorkOrder("works order report.pdf"), 100);
});

Deno.test("scoreWorkOrder: standalone \\bWO\\b strong signal (100)", () => {
  assertEquals(scoreWorkOrder("WO-12345.pdf"), 100);
  assertEquals(scoreWorkOrder("site WO attachment.pdf"), 100);
});

Deno.test("scoreWorkOrder: \\bWO\\b must be whole-word — WOrksheet is not strong", () => {
  // "WOrksheet" should NOT match \bWO\b (b is a word boundary)
  // But "WO" at the END of a word boundary: SWOMETHING - actually let's check the real regex
  // \bWO\b requires both word boundaries; "WOrksheet" does NOT qualify.
  const score = scoreWorkOrder("WOrksheet.pdf");
  // "WOrksheet" contains "WO" but NOT as \bWO\b (because 'r' follows and is \w)
  assertEquals(score, 0);
});

Deno.test("scoreWorkOrder: 'PO' weak signal (10)", () => {
  assertEquals(scoreWorkOrder("PO_53582.pdf"), 10);
  assertEquals(scoreWorkOrder("purchase order 123.pdf"), 10);
});

Deno.test("scoreWorkOrder: name containing BOTH 'work order' AND 'PO' scores STRONG (100)", () => {
  // Real MLB WO filename: work_order_MLB-25096PO-53582_Secureworks_Group_Pty_Ltd.pdf
  // Work-order signal MUST dominate over PO signal.
  assertEquals(scoreWorkOrder("work_order_MLB-25096PO-53582_Secureworks_Group_Pty_Ltd.pdf"), 100);
  assertEquals(scoreWorkOrder("work order PO-123.pdf"), 100);
});

Deno.test("scoreWorkOrder: no signal returns 0", () => {
  assertEquals(scoreWorkOrder("asbestos_report_site.pdf"), 0);
  assertEquals(scoreWorkOrder("photo_evidence_001.pdf"), 0);
  assertEquals(scoreWorkOrder("site_plan.pdf"), 0);
  assertEquals(scoreWorkOrder(null), 0);
  assertEquals(scoreWorkOrder(undefined), 0);
  assertEquals(scoreWorkOrder(""), 0);
});

// ── selectWorkOrderPdf tests ──────────────────────────────────────────────────────

Deno.test("selectWorkOrderPdf: n=0 returns null + empty array", () => {
  const result = selectWorkOrderPdf([]);
  assertEquals(result.selected, null);
  assertEquals(result.ordered, []);
});

Deno.test("selectWorkOrderPdf: n=1 returns that attachment unchanged (no reorder side effect)", () => {
  const single: WoAttachmentInput = {
    id: "uuid-1",
    name: "asbestos_report.pdf",
    size_bytes: 50000,
  };
  const result = selectWorkOrderPdf([single]);
  assertEquals(result.selected, single);
  assertEquals(result.ordered.length, 1);
  assertEquals(result.ordered[0], single);
  // Verify it is truly the same object reference (not a copy with mutations)
  assert(result.ordered[0] === single);
});

Deno.test("selectWorkOrderPdf: report PDF + WO PDF — WO is designated", () => {
  const report: WoAttachmentInput = {
    id: "uuid-1",
    name: "asbestos_report_balcatta.pdf",
    size_bytes: 500000,
  };
  const wo: WoAttachmentInput = {
    id: "uuid-2",
    name: "work_order_MLB-25096PO-53582_Secureworks_Group_Pty_Ltd.pdf",
    size_bytes: 150981,
  };
  // Even though report is larger, WO filename signal wins.
  const result = selectWorkOrderPdf([report, wo]);
  assertEquals(result.selected, wo, "WO PDF must be designated even when smaller");
  assertEquals(result.ordered[0], wo, "WO must be first in ordered list");
  assertEquals(result.ordered[1], report);
});

Deno.test("selectWorkOrderPdf: two 'work order' PDFs — tiebreak by size (larger wins)", () => {
  const woSmall: WoAttachmentInput = {
    id: "uuid-a",
    name: "work_order_AJBR67998_v1.pdf",
    size_bytes: 100000,
  };
  const woLarge: WoAttachmentInput = {
    id: "uuid-b",
    name: "work_order_AJBR67998_v2.pdf",
    size_bytes: 200000,
  };
  const result = selectWorkOrderPdf([woSmall, woLarge]);
  assertEquals(result.selected, woLarge, "larger work-order PDF wins tiebreak");
  assertEquals(result.ordered[0], woLarge);
  assertEquals(result.ordered[1], woSmall);
});

Deno.test("selectWorkOrderPdf: two 'work order' PDFs same size — tiebreak by original order", () => {
  const wo1: WoAttachmentInput = {
    id: "uuid-c",
    name: "work_order_first.pdf",
    size_bytes: 150000,
  };
  const wo2: WoAttachmentInput = {
    id: "uuid-d",
    name: "work_order_second.pdf",
    size_bytes: 150000,
  };
  const result = selectWorkOrderPdf([wo1, wo2]);
  assertEquals(result.selected, wo1, "first (original order) wins equal-size tiebreak");
  assertEquals(result.ordered[0], wo1);
});

Deno.test("selectWorkOrderPdf: WO name containing BOTH work-order AND PO beats bare PO PDF", () => {
  const barePoFile: WoAttachmentInput = {
    id: "uuid-po",
    name: "PO_53582.pdf",
    size_bytes: 400000, // larger, to test score dominates over size
  };
  const realWo: WoAttachmentInput = {
    id: "uuid-wo",
    name: "work_order_MLB-25096PO-53582_Secureworks_Group_Pty_Ltd.pdf",
    size_bytes: 150981,
  };
  const result = selectWorkOrderPdf([barePoFile, realWo]);
  assertEquals(result.selected, realWo, "WO+PO combined name must beat bare PO even when smaller");
  assertEquals(result.ordered[0], realWo);
});

Deno.test("selectWorkOrderPdf: three PDFs — no signal, WO, PO — WO wins, rest in original order", () => {
  const report: WoAttachmentInput = { id: "r1", name: "site_report.pdf", size_bytes: 300000 };
  const wo: WoAttachmentInput = { id: "w1", name: "work_order_site.pdf", size_bytes: 120000 };
  const po: WoAttachmentInput = { id: "p1", name: "PO_99999.pdf", size_bytes: 80000 };
  const result = selectWorkOrderPdf([report, wo, po]);
  assertEquals(result.selected, wo);
  assertEquals(result.ordered[0], wo);
  // rest: report, po — their relative order from input is preserved
  assertEquals(result.ordered[1], report);
  assertEquals(result.ordered[2], po);
});

// ── attachmentKeyComponent tests ─────────────────────────────────────────────────

Deno.test("attachmentKeyComponent: two atts with different ids produce different keys", () => {
  const att1: WoAttachmentInput = { id: "123e4567-e89b-12d3-a456-426614174000" };
  const att2: WoAttachmentInput = { id: "987fcdeb-51a2-43f7-b6d8-123456789abc" };
  const key1 = attachmentKeyComponent(att1);
  const key2 = attachmentKeyComponent(att2);
  assertNotEquals(key1, key2, "different ids must produce different key components");
});

Deno.test("attachmentKeyComponent: falls back to graph_attachment_id when id is absent", () => {
  const att: WoAttachmentInput = {
    id: null,
    graph_attachment_id: "AQMkADA3OWRlMzg2LTA2YjEtNDJiMy04MzdmLTBlNjE1NzUzZmM1MABGAAADgwcJr_example==",
  };
  const key = attachmentKeyComponent(att);
  assert(key.length > 0, "key must be non-empty");
  assert(/^[a-zA-Z0-9]+$/.test(key), "key must be alphanumeric only");
});

Deno.test("attachmentKeyComponent: two atts with different graph_attachment_ids produce different keys", () => {
  const att1: WoAttachmentInput = {
    id: null,
    graph_attachment_id: "AQMkADA3OWRlMzg2LTA2YjEtNDJiMy04MzdmLTBlNjE1NzUzZmM1MABGAAADid1==",
  };
  const att2: WoAttachmentInput = {
    id: null,
    graph_attachment_id: "AQMkADA3OWRlMzg2LTA2YjEtNDJiMy04MzdmLTBlNjE1NzUzZmM1MABGAAADid2==",
  };
  assertNotEquals(attachmentKeyComponent(att1), attachmentKeyComponent(att2));
});

Deno.test("attachmentKeyComponent: fallback (no id, no graph_attachment_id) still gives non-empty key", () => {
  const att: WoAttachmentInput = {
    id: null,
    graph_attachment_id: null,
    name: "work_order.pdf",
    size_bytes: 150000,
  };
  const key = attachmentKeyComponent(att);
  assert(key.length > 0, "fallback key must be non-empty");
  assert(/^[a-zA-Z0-9]+$/.test(key), "fallback key must be alphanumeric only");
});

Deno.test("attachmentKeyComponent: two atts with same name but different ids produce different keys (AC2 collision guard)", () => {
  // Two PDFs in one email with identical filename trailing chars (the old collision case).
  const att1: WoAttachmentInput = {
    id: "aaaaaaaa-bbbb-cccc-dddd-111111111111",
    name: "work_order.pdf",
    size_bytes: 100000,
  };
  const att2: WoAttachmentInput = {
    id: "aaaaaaaa-bbbb-cccc-dddd-222222222222",
    name: "work_order.pdf",
    size_bytes: 200000,
  };
  assertNotEquals(
    attachmentKeyComponent(att1),
    attachmentKeyComponent(att2),
    "same filename, different ids => different storage key components",
  );
});

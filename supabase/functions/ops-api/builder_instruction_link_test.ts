// deno-lint-ignore-file no-import-prefix
// W4 preparation (W4-3 option C): made-up references, no client data.
import { assertEquals } from "jsr:@std/assert@1";
import {
  linkTradeLineToBuilderInstruction,
  listBuilderInstructions,
} from "./builder_instruction_link.ts";
import { summariseBuilderInstructionLinks } from "./builder_instruction_link_summary.ts";

const JOB = "00000000-0000-4000-8000-000000000001";
const OTHER_JOB = "00000000-0000-4000-8000-000000000002";
const line = (assignment_ids: string[] = ["a1"]) => ({
  line: { job_id: JOB, assignment_ids },
  assignments: [
    { id: "a1", job_id: JOB },
    { id: "a2", job_id: OTHER_JOB },
  ],
});
const mlb = { requesting_company_slug: "mlb" };

Deno.test("MLB: one declared purchase order with its PDF links", () => {
  const set = listBuilderInstructions({
    job: { type: "makesafe", metadata: { builder_po_number: "PO-56236" } },
    makesafe_details: { ...mlb, external_ref: "MLB-25147" },
    work_order_documents: [
      { id: "d1", file_name: "work_order_PO56236_Secure_Works_WA.pdf" },
    ],
  });
  assertEquals(
    set.orders.map((o) => [o.key, o.purchase_order, o.document_ids]),
    [
      ["MLB:PO-56236", "PO-56236", ["d1"]],
    ],
  );
  const link = linkTradeLineToBuilderInstruction(line(), set);
  assertEquals([link.state, link.order?.key, link.assignment_linked], [
    "linked",
    "MLB:PO-56236",
    true,
  ]);
});

Deno.test("AJ keys on its job number, so an AJ work order PDF links", () => {
  const set = listBuilderInstructions({
    job: { type: "makesafe", metadata: {} },
    makesafe_details: {
      requesting_company_slug: "aj",
      external_ref: "AJBR-70271",
    },
    work_order_documents: [{
      id: "d1",
      file_name: "AJBR-70271 Work Order.pdf",
    }],
  });
  assertEquals(
    set.orders.map((o) => [o.key, o.purchase_order, o.document_ids]),
    [
      ["AJ:JOB-70271", null, ["d1"]],
    ],
  );
  assertEquals(linkTradeLineToBuilderInstruction(line(), set).state, "linked");
});

Deno.test("an AJ PDF for a different job number does not attach", () => {
  const set = listBuilderInstructions({
    job: { type: "makesafe", metadata: {} },
    makesafe_details: {
      requesting_company_slug: "aj",
      external_ref: "AJBR-70271",
    },
    work_order_documents: [{
      id: "d1",
      file_name: "AJBR-70272 Work Order.pdf",
    }],
  });
  assertEquals(set.orders[0].document_ids, []);
  assertEquals(set.unmatched_document_ids, ["d1"]);
});

Deno.test("a repair with no purchase order keys on its work order", () => {
  const set = listBuilderInstructions({
    job: {
      type: "repair",
      metadata: { builder_work_order_number: "MLB-24645" },
    },
    makesafe_details: mlb,
  });
  assertEquals(set.orders.map((o) => o.key), ["MLB:WO-24645"]);
});

Deno.test("a repair's work order collapses into its declared purchase order", () => {
  const set = listBuilderInstructions({
    job: {
      type: "repair",
      metadata: {
        builder_po_number: "PO-59875",
        builder_claim_ref: "MLB-24645",
      },
    },
    makesafe_details: { ...mlb, external_ref: "MLB-24645" },
  });
  assertEquals(set.orders.map((o) => o.key), ["MLB:PO-59875"]);
});

Deno.test("PO read from the detail row's fused reference when metadata has none", () => {
  const set = listBuilderInstructions({
    job: { type: "makesafe", metadata: {} },
    makesafe_details: { external_ref: "MLB-25147PO-56236" },
  });
  assertEquals(set.orders.map((o) => o.key), ["MLB:PO-56236"]);
});

Deno.test("a declared PO with no readable scope is still this job's order", () => {
  const set = listBuilderInstructions({
    job: { type: "makesafe", metadata: { builder_po_number: "PO-56236" } },
    makesafe_details: { requesting_company_slug: "unknown-builder" },
    work_order_documents: [{ id: "d1", file_name: "work_order_PO56236.pdf" }],
  });
  assertEquals(set.orders.map((o) => [o.key, o.document_ids]), [
    ["UNSCOPED:PO-56236", ["d1"]],
  ]);
});

Deno.test("several orders: candidates listed, none chosen", () => {
  const set = listBuilderInstructions({
    job: {
      type: "repair",
      metadata: {
        builder_po_number: "PO-56236",
        builder_claim_ref: "MLB-25147",
        builder_additional_work_orders: [
          {
            purchase_order: "PO-56300",
            claim_ref: "MLB-25147",
            received_at: "2026-10-02T01:00:00Z",
          },
          { purchase_order: "PO-56236", claim_ref: "MLB-25147" }, // repeat
        ],
      },
    },
    makesafe_details: mlb,
    work_order_documents: [
      { id: "d1", file_name: "work_order_PO56236.pdf" },
      { id: "d2", file_name: "work_order_PO56300.pdf" },
    ],
  });
  assertEquals(set.orders.map((o) => [o.key, o.source, o.document_ids]), [
    ["MLB:PO-56236", "job_declared", ["d1"]],
    ["MLB:PO-56300", "additional_order", ["d2"]],
  ]);
  const link = linkTradeLineToBuilderInstruction(line(), set);
  assertEquals([link.state, link.order, link.candidates.length], [
    "several_orders",
    null,
    2,
  ]);
});

Deno.test("a sibling's PDF on the card never creates an order", () => {
  const set = listBuilderInstructions({
    job: { type: "makesafe", metadata: { builder_po_number: "PO-56236" } },
    makesafe_details: { ...mlb, external_ref: "MLB-25147" },
    work_order_documents: [
      { id: "d1", file_name: "work_order_PO56236.pdf" },
      { id: "d2", file_name: "MLB-25147PO-56301 Work Order.pdf" },
    ],
  });
  assertEquals(set.orders.map((o) => o.key), ["MLB:PO-56236"]);
  assertEquals(set.unmatched_document_ids, ["d2"]);
  assertEquals(linkTradeLineToBuilderInstruction(line(), set).state, "linked");
});

Deno.test("PO matched on digit boundaries, never as a substring", () => {
  const set = listBuilderInstructions({
    job: { type: "makesafe", metadata: { builder_po_number: "PO-5623" } },
    makesafe_details: mlb,
    work_order_documents: [{ id: "d1", file_name: "work_order_PO56236.pdf" }],
  });
  assertEquals(set.orders[0].document_ids, []);
  assertEquals(set.unmatched_document_ids, ["d1"]);
});

Deno.test("self-generated SWMS work orders and unnamed PDFs never become an order", () => {
  const set = listBuilderInstructions({
    job: { type: "makesafe", metadata: {} },
    makesafe_details: mlb,
    work_order_documents: [
      { id: "d1", file_name: "work-order-SWMS-261100.pdf" },
      { id: "d2", file_name: "Purchase Order.pdf" },
    ],
  });
  assertEquals(set.orders, []);
  const link = linkTradeLineToBuilderInstruction(line(), set);
  assertEquals(link.state, "document_only");
  assertEquals(link.unmatched_document_ids, ["d1", "d2"]);
});

Deno.test("no order and no PDF: no_instruction", () => {
  const set = listBuilderInstructions({ job: { metadata: {} } });
  assertEquals(
    linkTradeLineToBuilderInstruction(line(), set).state,
    "no_instruction",
  );
});

Deno.test("an assignment from another job, or one not supplied, is a mismatch", () => {
  const set = listBuilderInstructions({
    job: { type: "makesafe", metadata: { builder_po_number: "PO-56236" } },
    makesafe_details: mlb,
  });
  for (const ids of [["a1", "a2"], ["a9"]]) {
    const link = linkTradeLineToBuilderInstruction(line(ids), set);
    assertEquals([link.state, link.order], ["assignment_mismatch", null]);
  }
});

Deno.test("a line with no assignment still links by job, flagged unlinked", () => {
  const set = listBuilderInstructions({
    job: { type: "makesafe", metadata: { builder_po_number: "PO-56236" } },
    makesafe_details: mlb,
  });
  const link = linkTradeLineToBuilderInstruction(line([]), set);
  assertEquals([link.state, link.assignment_linked], ["linked", false]);
});

Deno.test("summary: states, dollars and job numbers only", () => {
  const rows = [
    {
      line: { job_id: JOB, assignment_ids: [], line_total_ex: 120.1 },
      job: {
        job_number: "SWMS-T1",
        metadata: { builder_po_number: "PO-56111" },
      },
      makesafe_details: mlb,
      work_order_documents: [{ id: "d1", file_name: "work_order_PO56111.pdf" }],
    },
    {
      line: { job_id: JOB, assignment_ids: [], line_total_ex: 0.2 },
      job: {
        job_number: "SWMS-T1",
        metadata: { builder_po_number: "PO-56111" },
      },
      makesafe_details: mlb,
      work_order_documents: [{ id: "d1", file_name: "work_order_PO56111.pdf" }],
    },
    {
      line: { job_id: JOB, assignment_ids: [], line_total_ex: 50 },
      job: {
        job_number: "SWR-T2",
        metadata: { builder_po_number: "PO-56222" },
      },
      makesafe_details: mlb,
    },
  ];
  const summary = summariseBuilderInstructionLinks(rows);
  assertEquals(summary, [
    {
      state: "linked",
      lines: 2,
      line_total_ex: 120.3,
      job_numbers: ["SWMS-T1"],
    },
    {
      state: "linked_no_pdf",
      lines: 1,
      line_total_ex: 50,
      job_numbers: ["SWR-T2"],
    },
  ]);
  assertEquals(JSON.stringify(summary).includes(".pdf"), false);
});

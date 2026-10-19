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

Deno.test("one order with its PDF: the line links to it", () => {
  const set = listBuilderInstructions({
    job: { metadata: { builder_po_number: "PO-56236" } },
    makesafe_details: {
      external_ref: "MLB-25147",
      requesting_company_slug: "mlb",
    },
    work_order_documents: [
      { id: "d1", file_name: "work_order_PO56236_Secure_Works_WA.pdf" },
    ],
  });
  assertEquals(set.orders.length, 1);
  assertEquals(set.orders[0].document_ids, ["d1"]);
  assertEquals(set.orders[0].claim_ref, "MLB-25147");
  const link = linkTradeLineToBuilderInstruction(line(), set);
  assertEquals(
    [link.state, link.order?.purchase_order, link.assignment_linked],
    [
      "linked",
      "PO-56236",
      true,
    ],
  );
});

Deno.test("PO read from the detail row's fused reference when metadata has none", () => {
  const set = listBuilderInstructions({
    job: { metadata: {} },
    makesafe_details: { external_ref: "MLB-25147PO-56236" },
  });
  assertEquals(set.orders.map((o) => o.purchase_order), ["PO-56236"]);
  assertEquals(set.orders[0].work_order_number, "MLB-25147PO-56236");
});

Deno.test("a fused stored PO still matches its own PDF", () => {
  const set = listBuilderInstructions({
    job: { metadata: { builder_po_number: "MLB-25147PO-56236" } },
    work_order_documents: [{
      id: "d1",
      file_name: "MLB-25147PO-56236 Work Order.pdf",
    }],
  });
  assertEquals(set.orders[0].document_ids, ["d1"]);
});

Deno.test("several orders: candidates listed, none chosen", () => {
  const set = listBuilderInstructions({
    job: {
      metadata: {
        builder_po_number: "PO-56236",
        builder_additional_work_orders: [
          { purchase_order: "PO-56300", received_at: "2026-10-02T01:00:00Z" },
          { purchase_order: "PO-56236" }, // repeat of the first: listed once
        ],
      },
    },
    work_order_documents: [
      { id: "d1", file_name: "work_order_PO56236.pdf" },
      { id: "d2", file_name: "work_order_PO56300.pdf" },
    ],
  });
  assertEquals(
    set.orders.map((o) => [o.purchase_order, o.source, o.document_ids]),
    [
      ["PO-56236", "job_first_order", ["d1"]],
      ["PO-56300", "additional_order", ["d2"]],
    ],
  );
  const link = linkTradeLineToBuilderInstruction(line(), set);
  assertEquals([link.state, link.order, link.candidates.length], [
    "several_orders",
    null,
    2,
  ]);
});

Deno.test("PO matched on digit boundaries, never as a substring", () => {
  const set = listBuilderInstructions({
    job: { metadata: { builder_po_number: "PO-5623" } },
    work_order_documents: [{ id: "d1", file_name: "work_order_PO56236.pdf" }],
  });
  assertEquals(set.orders[0].document_ids, []);
  assertEquals(set.unmatched_document_ids, ["d1"]);
});

Deno.test("self-generated SWMS work orders and unnamed PDFs never become an order", () => {
  const set = listBuilderInstructions({
    job: { metadata: {} },
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
    job: { metadata: { builder_po_number: "PO-56236" } },
  });
  for (const ids of [["a1", "a2"], ["a9"]]) {
    const link = linkTradeLineToBuilderInstruction(line(ids), set);
    assertEquals([link.state, link.order], ["assignment_mismatch", null]);
  }
});

Deno.test("a line with no assignment still links by job, flagged unlinked", () => {
  const set = listBuilderInstructions({
    job: { metadata: { builder_po_number: "PO-56236" } },
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
      work_order_documents: [{ id: "d1", file_name: "work_order_PO56111.pdf" }],
    },
    {
      line: { job_id: JOB, assignment_ids: [], line_total_ex: 0.2 },
      job: {
        job_number: "SWMS-T1",
        metadata: { builder_po_number: "PO-56111" },
      },
      work_order_documents: [{ id: "d1", file_name: "work_order_PO56111.pdf" }],
    },
    {
      line: { job_id: JOB, assignment_ids: [], line_total_ex: 50 },
      job: {
        job_number: "SWR-T2",
        metadata: { builder_po_number: "PO-56222" },
      },
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

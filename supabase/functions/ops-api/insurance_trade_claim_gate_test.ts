// deno-lint-ignore-file no-import-prefix
// W4 proposal gate: fixtures carry made-up records and no client data.
import { assertEquals } from "jsr:@std/assert@1";
import { workOrderIsInvoiceReady } from "./trade_invoice_weekly.ts";
import {
  insuranceClaimDecision,
  insuranceClaimFamily,
  insuranceTradeClaimGate,
} from "./insurance_trade_claim_gate.ts";

const submitted = [{
  status: "submitted",
  submitted_at: "2026-10-10T02:00:00Z",
}];

Deno.test("homeowner jobs are out of scope: DSP-11 client sign-off governs them", () => {
  for (const type of ["fencing", "patio", "decking"]) {
    const gate = insuranceTradeClaimGate({ job: { type, status: "complete" } });
    assertEquals(gate, {
      applies: false,
      family: null,
      released: false,
      reason: "not_insurance",
    });
  }
});

Deno.test("family: repair tag wins over type=makesafe; insurance is restoration", () => {
  assertEquals(insuranceClaimFamily({ job: { type: "makesafe" } }), "makesafe");
  assertEquals(
    insuranceClaimFamily({
      job: { type: "makesafe", metadata: { ses_family: "repair" } },
    }),
    "repair",
  );
  assertEquals(
    insuranceClaimFamily({
      job: { type: "makesafe" },
      makesafe_details: { report_type: "repair" },
    }),
    "repair",
  );
  assertEquals(insuranceClaimFamily({ job: { type: "repair" } }), "repair");
  assertEquals(
    insuranceClaimFamily({ job: { type: "insurance" } }),
    "restoration",
  );
});

Deno.test("make-safe at accepted with no report is held", () => {
  const gate = insuranceTradeClaimGate({
    job: { type: "makesafe", status: "accepted" },
    makesafe_details: { substatus: "waiting_on_trade_report" },
  });
  assertEquals([gate.released, gate.reason], [false, "no_completion_evidence"]);
});

Deno.test("make-safe releases on a submitted trade report", () => {
  const gate = insuranceTradeClaimGate({
    job: { type: "makesafe", status: "accepted" },
    makesafe_details: { substatus: "waiting_on_trade_report" },
    service_reports: submitted,
  });
  assertEquals([gate.released, gate.reason], [true, "trade_report_submitted"]);
});

Deno.test("a draft report, or one with no submitted_at, is not evidence", () => {
  for (
    const report of [
      { status: "draft", submitted_at: "2026-10-10T02:00:00Z" },
      { status: "submitted", submitted_at: null },
    ]
  ) {
    const gate = insuranceTradeClaimGate({
      job: { type: "makesafe", status: "accepted" },
      makesafe_details: { substatus: "company_contact_done" },
      service_reports: [report],
    });
    assertEquals(gate.released, false);
  }
});

Deno.test("make-safe releases once the card is past the report", () => {
  for (
    const substatus of ["admin_to_send_report", "ready_to_invoice", "complete"]
  ) {
    const gate = insuranceTradeClaimGate({
      job: { type: "makesafe", status: "accepted" },
      makesafe_details: { substatus },
    });
    assertEquals([gate.released, gate.reason], [true, "report_stage_reached"]);
  }
});

Deno.test("report-only waiting state does not release", () => {
  const gate = insuranceTradeClaimGate({
    job: { type: "makesafe", status: "accepted" },
    makesafe_details: { substatus: "awaiting_portal_completion" },
  });
  assertEquals(gate.released, false);
});

Deno.test("repair releases at Repairs stage complete, not before", () => {
  const stages = [
    "wo_in",
    "scoping",
    "quoted",
    "variation",
    "approved",
    "materials",
    "scheduled",
    "on_site",
  ];
  for (const repair_stage of stages) {
    const gate = insuranceTradeClaimGate({
      job: { type: "repair", status: "accepted", metadata: { repair_stage } },
    });
    assertEquals([repair_stage, gate.released], [repair_stage, false]);
  }
  const done = insuranceTradeClaimGate({
    job: {
      type: "repair",
      status: "accepted",
      metadata: { repair_stage: "complete" },
    },
  });
  assertEquals([done.released, done.reason], [true, "repair_complete"]);
});

Deno.test("repair-family make-safe card reads its repair stage", () => {
  const gate = insuranceTradeClaimGate({
    job: {
      type: "makesafe",
      status: "accepted",
      metadata: { ses_family: "repair", repair_stage: "complete" },
    },
  });
  assertEquals([gate.family, gate.released], ["repair", true]);
});

Deno.test("repair with a submitted report releases even before the board moves", () => {
  const gate = insuranceTradeClaimGate({
    job: {
      type: "repair",
      status: "accepted",
      metadata: { repair_stage: "on_site" },
    },
    service_reports: submitted,
  });
  assertEquals([gate.released, gate.reason], [true, "trade_report_submitted"]);
});

Deno.test("cancelled and restoration jobs never release", () => {
  assertEquals(
    insuranceTradeClaimGate({
      job: { type: "makesafe", status: "cancelled" },
      service_reports: submitted,
    }).reason,
    "cancelled",
  );
  assertEquals(
    insuranceTradeClaimGate({
      job: { type: "insurance", status: "accepted" },
      service_reports: submitted,
    }).reason,
    "restoration_no_rule",
  );
});

// Characterises today's gap the gate is meant to close: a sent crew work order
// on a finished make-safe never becomes invoice-ready, because the job's
// status stays `accepted` while its card moves through substatus.
Deno.test("today: sent crew WO on a reported make-safe is not invoice-ready", () => {
  const workOrder = {
    status: "sent",
    jobs: { type: "makesafe", status: "accepted" },
  };
  assertEquals(workOrderIsInvoiceReady(workOrder), false);
  const gate = insuranceTradeClaimGate({
    job: workOrder.jobs,
    makesafe_details: { substatus: "ready_to_invoice" },
  });
  assertEquals(gate.released, true);
});

// W4-1 slot-in: each owner option is one named rule.

const reported = {
  job: { type: "makesafe", status: "accepted" },
  makesafe_details: { substatus: "waiting_on_trade_report" },
  service_reports: submitted,
};

Deno.test("rule C (and an unreadable rule) holds nothing: today's behaviour", () => {
  const bare = { job: { type: "makesafe", status: "accepted" } };
  assertEquals(insuranceClaimDecision("C_unchanged", bare).hold, false);
  const unknown = insuranceClaimDecision("yes please", bare);
  assertEquals([unknown.rule, unknown.hold, unknown.reason], [
    "C_unchanged",
    false,
    "unknown_rule",
  ]);
});

Deno.test("rule A holds until the completion evidence the gate reads", () => {
  assertEquals(
    insuranceClaimDecision("A_completion_report", {
      job: { type: "makesafe", status: "accepted" },
    }).hold,
    true,
  );
  assertEquals(
    insuranceClaimDecision("A_completion_report", reported).hold,
    false,
  );
});

Deno.test("rule B releases on a raised builder invoice, never on a draft", () => {
  const withInvoice = (status: string, type = "ACCREC") => ({
    ...reported,
    sales_invoices: [{ type, status }],
  });
  for (const status of ["DRAFT", "VOIDED", "DELETED"]) {
    assertEquals(
      insuranceClaimDecision("B_builder_invoice", withInvoice(status)).hold,
      true,
    );
  }
  assertEquals(
    insuranceClaimDecision("B_builder_invoice", withInvoice("PAID", "ACCPAY"))
      .hold,
    true,
  );
  for (const status of ["AUTHORISED", "submitted", "PAID"]) {
    const d = insuranceClaimDecision("B_builder_invoice", withInvoice(status));
    assertEquals([d.hold, d.reason], [false, "builder_invoice_raised"]);
  }
});

Deno.test("no rule ever holds a homeowner job", () => {
  for (
    const rule of ["A_completion_report", "B_builder_invoice", "C_unchanged"]
  ) {
    const d = insuranceClaimDecision(rule, {
      job: { type: "patio", status: "accepted" },
    });
    assertEquals([d.applies, d.hold, d.reason], [
      false,
      false,
      "not_insurance",
    ]);
  }
});

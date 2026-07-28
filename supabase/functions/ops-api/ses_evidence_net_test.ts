// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSesEvidenceReferenceKeys,
  matchedSesEvidenceReferenceKey,
  normalizeSesEvidenceReference,
  resolveSesOperationalEvidence,
  type SesEvidenceNetRows,
} from "./ses_evidence_net.ts";

function rows(
  overrides: Partial<SesEvidenceNetRows> = {},
): SesEvidenceNetRows {
  return {
    job: {
      id: "job-current",
      job_number: "SWMS-26583",
      created_at: "2026-07-28T00:00:00.000Z",
    },
    source: {
      builder_reference: "AJBR-67045",
      po_or_external_ref: "PO-88012",
    },
    emails: [],
    email_attachments: [],
    xero_invoices: [],
    trade_invoice_lines: [],
    twin_details: [],
    twin_jobs: [],
    ...overrides,
  };
}

Deno.test("builder references match separator-insensitively, including AJ Job No aliases", () => {
  const keys = buildSesEvidenceReferenceKeys(rows().source);
  assertEquals(normalizeSesEvidenceReference("AJBR 67045"), "AJBR67045");
  assert(
    matchedSesEvidenceReferenceKey(
      {
        subject: "Our Ref: AJBR 67045",
        body_content: "",
      },
      [],
      keys,
    ),
  );
  assert(
    matchedSesEvidenceReferenceKey(
      {
        subject: "Job No 67045 - report",
        body_content: "",
      },
      [],
      keys,
    ),
  );
  assert(
    matchedSesEvidenceReferenceKey(
      {
        subject: "Purchase Order 88012",
        body_content: "",
      },
      [],
      keys,
    ),
  );
});

Deno.test("outbound SecureWorks report and invoice mail becomes provenance-bound delivery evidence", () => {
  const evidence = resolveSesOperationalEvidence(rows({
    emails: [
      {
        post_id: "mail-outbound",
        from_email: "ops@secureworkswa.com.au",
        to_recipients: "reports@example-builder.test; ses@secureworkswa.com.au",
        subject: "AJBR 67045 report and invoice",
        has_attachments: true,
        received_at: "2026-07-27T06:00:00.000Z",
      },
      {
        post_id: "mail-inbound",
        from_email: "builder@example.test",
        subject: "AJBR-67045 report and invoice",
        received_at: "2026-07-27T05:00:00.000Z",
      },
      {
        post_id: "mail-booking-not-delivery",
        from_email: "Hugo <hugo@secureworkswa.com.au>",
        subject: "AJBR-67045 report scheduled for today",
        received_at: "2026-07-27T04:00:00.000Z",
      },
    ],
  }));
  assertEquals(evidence.triage.disposition, "already_delivered");
  assertEquals(evidence.facts.length, 1);
  assertEquals(evidence.facts[0].kind, "outbound_delivery");
  assertEquals(evidence.facts[0].provenance, {
    store: "emails",
    row_id: "mail-outbound",
    matched_key: "builder_reference:AJBR67045",
  });
});

Deno.test("address-only mail and near-address traps never bind", () => {
  const evidence = resolveSesOperationalEvidence(rows({
    emails: [
      {
        post_id: "mail-murchison-trap",
        from_email: "ops@secureworkswa.com.au",
        subject: "Report and invoice - 9 Murchison Street",
      },
      {
        post_id: "mail-havenvale-trap",
        from_email: "ops@secureworkswa.com.au",
        subject: "Report and invoice - Havenvale Crescent",
      },
    ],
  }));
  assertEquals(evidence.facts, []);
  assertEquals(evidence.triage.disposition, "evidence_inconclusive");
  assertEquals(evidence.triage.staff_action_allowed, false);
});

Deno.test("paid subcontractor bill line proves attendance with exact card-token boundaries", () => {
  const evidence = resolveSesOperationalEvidence(rows({
    xero_invoices: [
      {
        id: "bill-match",
        invoice_number: "BILL-100",
        invoice_type: "ACCPAY",
        status: "PAID",
        contact_name: "Real Crew",
        fully_paid_on: "2026-07-27",
        line_items: [{
          LineItemID: "line-match",
          Description: "Attendance and make-safe works SWMS-26583 completed",
        }],
      },
      {
        id: "bill-near-token",
        invoice_type: "ACCPAY",
        status: "PAID",
        contact_name: "Real Crew",
        line_items: [{
          Description: "Attendance for SWMS-265830",
        }],
      },
      {
        id: "bill-qa",
        invoice_type: "ACCPAY",
        status: "PAID",
        contact_name: "marnin test22",
        line_items: [{
          Description: "QA TEST - delete SWMS-26583",
        }],
      },
    ],
  }));
  assertEquals(evidence.triage.disposition, "attendance_evidenced");
  assertEquals(evidence.facts.length, 1);
  assertEquals(evidence.facts[0].kind, "crew_bill_attendance");
  assertEquals(evidence.facts[0].provenance.row_id, "bill-match");
  assertEquals(
    evidence.facts[0].provenance.matched_key,
    "job_number:SWMS26583",
  );
});

Deno.test("pushed-to-Xero relational crew bill is surfaced as a typed attendance claim", () => {
  const evidence = resolveSesOperationalEvidence(rows({
    trade_invoice_lines: [
      {
        id: "trade-line-pushed",
        trade_invoice_id: "trade-invoice-pushed",
        job_number: "SWMS-26583",
        total_hours: 4,
        trade_invoices: {
          id: "trade-invoice-pushed",
          status: "pushed_to_xero",
          xero_pushed_at: "2026-07-27T08:00:00.000Z",
          users: { name: "Hugo" },
        },
      },
      {
        id: "trade-line-not-settled",
        trade_invoice_id: "trade-invoice-approved",
        job_number: "SWMS-26583",
        trade_invoices: {
          id: "trade-invoice-approved",
          status: "approved",
          users: { name: "Real Crew" },
        },
      },
    ],
  }));
  assertEquals(evidence.triage.disposition, "attendance_evidenced");
  assertEquals(evidence.facts.length, 1);
  assertEquals(evidence.facts[0].kind, "crew_bill_claim");
  assertEquals(evidence.facts[0].provenance, {
    store: "trade_invoice_lines",
    row_id: "trade-line-pushed",
    matched_key: "job_number:SWMS26583",
  });
});

Deno.test("whole-thread reading finds cancellation and forward booking outside the work-order email", () => {
  const evidence = resolveSesOperationalEvidence(rows({
    emails: [
      {
        post_id: "thread-seed",
        conversation_id: "conversation-1",
        from_email: "builder@example.test",
        subject: "NEW WORK ORDER - AJBR-67045",
        received_at: "2026-07-20T01:00:00.000Z",
      },
      {
        post_id: "thread-booking",
        conversation_id: "conversation-1",
        from_email: "ops@secureworkswa.com.au",
        subject: "RE: Our Ref:",
        body_content: "We have organised to attend tomorrow.",
        received_at: "2026-07-21T02:00:00.000Z",
      },
      {
        post_id: "thread-cancel",
        conversation_id: "conversation-1",
        from_email: "builder@example.test",
        subject: "RE: Our Ref:",
        body_content: "Please cancel the work order.",
        received_at: "2026-07-22T03:00:00.000Z",
      },
      {
        post_id: "thread-handback",
        conversation_id: "conversation-1",
        from_email: "marnin@secureworkswa.com.au",
        subject: "RE: Our Ref:",
        body_content: "This one is too far for us.",
        received_at: "2026-07-21T04:00:00.000Z",
      },
      {
        post_id: "thread-handback-refused",
        conversation_id: "conversation-1",
        from_email: "builder@example.test",
        subject: "RE: Our Ref:",
        body_content:
          "These have been booked and we cant keep taking work back.",
        received_at: "2026-07-21T05:00:00.000Z",
      },
    ],
  }));
  assert(
    evidence.facts.some((fact) =>
      fact.kind === "booked_forward" &&
      fact.provenance.matched_key ===
        "builder_reference:AJBR67045/conversation_id:conversation-1"
    ),
  );
  assert(
    evidence.facts.some((fact) => fact.kind === "builder_cancellation"),
  );
  assertEquals(
    evidence.facts.filter((fact) => fact.kind === "work_handed_back").length,
    1,
  );
  assertEquals(evidence.triage.disposition, "cancelled_or_handed_back");
});

Deno.test("replay-aged work order binds only an exact-reference closed twin, never an address twin", () => {
  const evidence = resolveSesOperationalEvidence(rows({
    emails: [{
      post_id: "old-work-order",
      from_email: "builder@example.test",
      subject: "NEW WORK ORDER - AJBR 67045 - PO 88012",
      received_at: "2026-07-20T00:00:00.000Z",
    }],
    twin_details: [
      {
        job_id: "job-closed-match",
        external_ref: "AJBR 67045",
      },
      {
        job_id: "job-address-trap",
        external_ref: "AJBR-99999",
      },
    ],
    twin_jobs: [
      {
        id: "job-closed-match",
        job_number: "SWMS-26001",
        status: "complete",
        metadata: {
          builder_po_number: "PO-88012",
        },
        site_address: "7 Murchison Street",
      },
      {
        id: "job-address-trap",
        job_number: "SWMS-26002",
        status: "cancelled",
        metadata: {
          builder_po_number: "PO-88012",
        },
        site_address: "7 Murchison Street",
      },
    ],
  }));
  assertEquals(evidence.triage.disposition, "duplicate_of_closed");
  const duplicates = evidence.facts.filter((fact) =>
    fact.kind === "duplicate_of_closed"
  );
  assertEquals(duplicates.length, 1);
  assertEquals(duplicates[0].provenance.row_id, "job-closed-match");
  assertEquals(
    duplicates[0].provenance.matched_key,
    "builder_reference:AJBR67045/po:PO88012",
  );
});

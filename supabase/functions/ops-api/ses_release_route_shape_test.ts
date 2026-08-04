import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ajsPackCc,
  ajsPackRecipients,
  AJS_WORK_ORDERS_MAILBOX,
  clientSendGateKindForRoute,
  isAjsBuilderKey,
  SES_AJS_ROUTE_ORDER,
  SES_UNIVERSAL_ROUTE_ORDER,
  sesReleaseRouteOrder,
} from "./ses_release_route_shape.ts";
import {
  checkAjsPhotoClientSendGate,
  checkAjsReportInvoiceClientSendGate,
  checkSesReleaseClientSendGate,
  MAKESAFE_ADMIN_FROM,
  MAKESAFE_CC,
} from "./makesafe_send_pack.ts";
import { resolveDocketRoutes } from "./ses_reporting_actions.ts";

Deno.test("AJS builder keys select the two-route order only", () => {
  assertEquals(isAjsBuilderKey("AJS"), true);
  assertEquals(isAjsBuilderKey("ajbr"), true);
  assertEquals(isAjsBuilderKey("MLB"), false);
  assertEquals(sesReleaseRouteOrder("AJS"), SES_AJS_ROUTE_ORDER);
  assertEquals(sesReleaseRouteOrder("MLB"), SES_UNIVERSAL_ROUTE_ORDER);
  assertEquals(sesReleaseRouteOrder("AJS"), ["report", "photo"]);
});

Deno.test("AJS pack recipients always include workorders@ and ses@ cc", () => {
  assertEquals(
    ajsPackRecipients({
      workOrderSender: "site.manager@ajs.build",
      threadParticipants: ["other@ajs.build", "workorders@ajs.build"],
    }),
    [
      AJS_WORK_ORDERS_MAILBOX,
      "site.manager@ajs.build",
      "other@ajs.build",
    ],
  );
  assertEquals(ajsPackCc(), [MAKESAFE_CC]);
});

Deno.test("client-send gate kinds map AJS report to combined report+invoice", () => {
  assertEquals(
    clientSendGateKindForRoute({ routeKind: "report", builderKey: "AJS" }),
    "ajs_report_invoice",
  );
  assertEquals(
    clientSendGateKindForRoute({ routeKind: "photo", builderKey: "AJBR" }),
    "ajs_photo",
  );
  assertEquals(
    clientSendGateKindForRoute({ routeKind: "invoice", builderKey: "MLB" }),
    "universal_invoice",
  );
});

const AJS_COMBINED_PAYLOAD = {
  from: MAKESAFE_ADMIN_FROM,
  to: AJS_WORK_ORDERS_MAILBOX,
  cc: MAKESAFE_CC,
  subject: "AJBR-70000 - report and invoice",
  htmlBody: "<p>Pack</p>",
  attachments: [
    { name: "Make Safe Report - SWMS-261000.pdf" },
    { name: "Xero Invoice INV-100.pdf" },
  ],
};

Deno.test("AJS report+invoice client-send gate passes the combined shape", () => {
  assertEquals(checkAjsReportInvoiceClientSendGate(AJS_COMBINED_PAYLOAD), []);
  assertEquals(
    checkSesReleaseClientSendGate("ajs_report_invoice", AJS_COMBINED_PAYLOAD),
    [],
  );
});

Deno.test("AJS report+invoice gate refuses missing Xero invoice PDF", () => {
  const failures = checkAjsReportInvoiceClientSendGate({
    ...AJS_COMBINED_PAYLOAD,
    attachments: [{ name: "Make Safe Report - SWMS-261000.pdf" }],
  });
  assertEquals(
    failures.some((f) => f.toLowerCase().includes("xero invoice")),
    true,
  );
});

Deno.test("AJS photo gate accepts images and refuses PDF pack smuggling", () => {
  assertEquals(
    checkAjsPhotoClientSendGate({
      from: MAKESAFE_ADMIN_FROM,
      to: AJS_WORK_ORDERS_MAILBOX,
      cc: MAKESAFE_CC,
      subject: "Photo Evidence - AJBR-70000",
      htmlBody: "<p>Photos</p>",
      attachments: [
        { name: "site-1.jpg" },
        { name: "site-2.PNG" },
      ],
    }),
    [],
  );
  const smuggled = checkAjsPhotoClientSendGate({
    from: MAKESAFE_ADMIN_FROM,
    to: AJS_WORK_ORDERS_MAILBOX,
    cc: MAKESAFE_CC,
    subject: "Photo Evidence - AJBR-70000",
    htmlBody: "<p>Photos</p>",
    attachments: [
      { name: "site-1.jpg" },
      { name: "Xero Invoice INV-100.pdf" },
    ],
  });
  assertEquals(smuggled.some((f) => f.includes("PDF")), true);
});

function ajsDocket(stage: string, xero: Record<string, unknown> | null) {
  return {
    id: "docket-ajs",
    stage,
    envelope: {
      v2: {
        classification: { builder_key: "AJS", family: "physical_makesafe" },
        routing: {
          report_to: "site.manager@ajs.build",
          photo_to: "site.manager@ajs.build",
          invoice_to: AJS_WORK_ORDERS_MAILBOX,
        },
      },
    },
    local_invoice_proposal: { builder_reference: "AJBR-70100" },
    xero_binding: xero,
    email_drafts: {
      REPORT_EMAIL_DRAFT: [
        "To: site.manager@ajs.build",
        "Cc:",
        "Subject: AJBR-70100 - physical makesafe",
        "Attachments: ARTIFACTS/report.pdf",
        "",
        "Report body",
      ].join("\n"),
      PHOTO_EMAIL_DRAFT: [
        "To: site.manager@ajs.build",
        "Cc:",
        "Subject: Photo Evidence - AJBR-70100",
        "Attachments: ARTIFACTS/photo1.jpg",
        "",
        "Photos body",
      ].join("\n"),
      INVOICE_EMAIL_DRAFT: [
        "To: workorders@ajs.build",
        "Cc: finance@secureworkswa.com.au",
        "Subject: AJBR-70100 - invoice",
        "Attachments: ARTIFACTS/invoice_proposal.json, ARTIFACTS/report.pdf",
        "",
        "Invoice body",
      ].join("\n"),
    },
  };
}

const AJS_ARTIFACTS = [
  {
    role: "supporting_report_pdf",
    object_key: "bucket/docket-ajs/ARTIFACTS/report.pdf",
    media_type: "application/pdf",
    content_hash: "report-hash",
  },
  {
    role: "xero_invoice_pdf",
    object_key: "bucket/docket-ajs/ARTIFACTS/xero-invoice.pdf",
    media_type: "application/pdf",
    content_hash: "xero-hash",
    metadata: {
      xero_invoice_id: "xero-1",
      invoice_number: "INV-1",
    },
  },
  {
    role: "invoice_proposal",
    object_key: "bucket/docket-ajs/ARTIFACTS/invoice_proposal.json",
    media_type: "application/json",
    content_hash: "proposal-hash",
  },
];

Deno.test("AJS resolveDocketRoutes collapses to report+photo with invoice PDF on report", () => {
  const routes = resolveDocketRoutes(
    ajsDocket("invoice_bound", {
      status: "AUTHORISED",
      xero_invoice_id: "xero-1",
      invoice_number: "INV-1",
    }),
    AJS_ARTIFACTS,
    null,
  );
  assertEquals(routes.map((r) => r.route_kind), ["report", "photo"]);
  const report = routes[0];
  assertEquals(report.recipients[0], AJS_WORK_ORDERS_MAILBOX);
  assertEquals(report.cc, [MAKESAFE_CC]);
  assertEquals(report.attachment_hashes.includes("xero-hash"), true);
  assertEquals(report.attachment_hashes.includes("report-hash"), true);
  assertEquals(report.ready, true);
  assertEquals(routes[1].cc, [MAKESAFE_CC]);
});

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ajsPackCc,
  ajsPackRecipients,
  AJS_MANDI_CC,
  AJS_VANESSA_CC,
  AJS_WORK_ORDERS_MAILBOX,
  clientSendGateKindForRoute,
  isAjsBuilderKey,
  SES_AJS_ROUTE_ORDER,
  SES_UNIVERSAL_ROUTE_ORDER,
  sesReleaseRouteOrder,
} from "./ses_release_route_shape.ts";
import {
  AJS_INVOICE_TO,
  checkMlbInvoiceClientSendGate,
  checkMlbReportClientSendGate,
  checkPhotoRouteClientSendGate,
  checkReportInvoiceClientSendGate,
  checkSesClientSendRouteGate,
  checkSesReleaseClientSendGate,
  isRawPhotoDumpName,
  MAKESAFE_ADMIN_FROM,
  MAKESAFE_CC,
  MAKESAFE_FINANCE_CC,
} from "./makesafe_send_pack.ts";
import { resolveDocketRoutes } from "./ses_reporting_actions.ts";

const MAVERICK_HTML =
  '<p>Body</p><div data-secureworks-signature="maverick">Maverick</div>';

/** Permanent AJS pack CC set (ses@ + vanessa@ + mandi@). Domain always ajs.build. */
const AJS_PACK_CC = [MAKESAFE_CC, AJS_VANESSA_CC, AJS_MANDI_CC];

Deno.test("AJS builder keys select report_invoice + photo only", () => {
  assertEquals(isAjsBuilderKey("AJS"), true);
  assertEquals(isAjsBuilderKey("ajbr"), true);
  assertEquals(isAjsBuilderKey("MLB"), false);
  assertEquals(sesReleaseRouteOrder("AJS"), SES_AJS_ROUTE_ORDER);
  assertEquals(sesReleaseRouteOrder("MLB"), SES_UNIVERSAL_ROUTE_ORDER);
  assertEquals(sesReleaseRouteOrder("AJS"), ["report_invoice", "photo"]);
});

Deno.test("AJS pack recipients always include workorders@ and permanent CCs", () => {
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
  assertEquals(ajsPackCc(), AJS_PACK_CC);
  // Spelling pin: never ajsbuild / ajsbuid.
  for (const addr of ajsPackCc()) {
    if (addr.endsWith("@ajs.build") || addr.includes("@ajs.")) {
      assertEquals(addr.endsWith("@ajs.build"), true);
      assertEquals(addr.includes("ajsbuild"), false);
      assertEquals(addr.includes("ajsbuid"), false);
    }
  }
});

Deno.test("gate kinds match skill contract names exactly", () => {
  assertEquals(
    clientSendGateKindForRoute({
      routeKind: "report_invoice",
      builderKey: "AJS",
    }),
    "report_invoice",
  );
  assertEquals(
    clientSendGateKindForRoute({ routeKind: "photo", builderKey: "AJBR" }),
    "photo",
  );
  assertEquals(
    clientSendGateKindForRoute({ routeKind: "report", builderKey: "MLB" }),
    "report",
  );
  assertEquals(
    clientSendGateKindForRoute({ routeKind: "invoice", builderKey: "MLB" }),
    "invoice",
  );
  // Legacy AJS stored as report still maps to report_invoice gate.
  assertEquals(
    clientSendGateKindForRoute({ routeKind: "report", builderKey: "AJS" }),
    "report_invoice",
  );
});

const AJS_COMBINED_PAYLOAD = {
  from: MAKESAFE_ADMIN_FROM,
  to: AJS_INVOICE_TO,
  cc: AJS_PACK_CC,
  subject: "AJBR-70000 - report and invoice",
  htmlBody: MAVERICK_HTML,
  attachments: [
    { name: "Make Safe Report - SWMS-261000.pdf" },
    { name: "Xero Invoice INV-100.pdf" },
  ],
};

Deno.test("report_invoice gate passes AJS combined shape", () => {
  assertEquals(
    checkReportInvoiceClientSendGate(AJS_COMBINED_PAYLOAD, {
      configuredInvoiceTo: AJS_INVOICE_TO,
    }),
    [],
  );
  assertEquals(
    checkSesClientSendRouteGate(AJS_COMBINED_PAYLOAD, {
      kind: "report_invoice",
      configuredInvoiceTo: AJS_INVOICE_TO,
    }),
    [],
  );
  // Alias still works.
  assertEquals(
    checkSesReleaseClientSendGate("ajs_report_invoice", AJS_COMBINED_PAYLOAD),
    [],
  );
});

Deno.test("report_invoice refuses missing invoice_to, summary PDF, photo bleed, no ses@", () => {
  assertEquals(
    checkReportInvoiceClientSendGate(
      { ...AJS_COMBINED_PAYLOAD, to: "someone@elsewhere.com" },
      { configuredInvoiceTo: AJS_INVOICE_TO },
    ).some((f) => f.includes("invoice_to")),
    true,
  );
  assertEquals(
    checkReportInvoiceClientSendGate(
      { ...AJS_COMBINED_PAYLOAD, cc: "" },
      { configuredInvoiceTo: AJS_INVOICE_TO },
    ).some((f) => f.includes(MAKESAFE_CC)),
    true,
  );
  assertEquals(
    checkReportInvoiceClientSendGate({
      ...AJS_COMBINED_PAYLOAD,
      attachments: [
        { name: "Make Safe Report - SWMS-261000.pdf" },
        { name: "Invoice Line Review.pdf" }, // summary, not Xero
      ],
    }, { configuredInvoiceTo: AJS_INVOICE_TO }).some((f) =>
      f.toLowerCase().includes("xero")
    ),
    true,
  );
  assertEquals(
    checkReportInvoiceClientSendGate({
      ...AJS_COMBINED_PAYLOAD,
      attachments: [
        ...AJS_COMBINED_PAYLOAD.attachments,
        { name: "site.jpg" },
      ],
    }, { configuredInvoiceTo: AJS_INVOICE_TO }).some((f) =>
      f.includes("photo")
    ),
    true,
  );
});

Deno.test("MLB report gate refuses any cc and invoice/photo bleed", () => {
  const ok = {
    from: MAKESAFE_ADMIN_FROM,
    to: "builder@mlb.example",
    cc: "",
    subject: "MLB report",
    htmlBody: MAVERICK_HTML,
    attachments: [{ name: "Make Safe Report - SWMS-1.pdf" }],
  };
  assertEquals(checkMlbReportClientSendGate(ok), []);
  assertEquals(
    checkMlbReportClientSendGate({ ...ok, cc: MAKESAFE_CC }).some((f) =>
      f.includes("no cc")
    ),
    true,
  );
  assertEquals(
    checkMlbReportClientSendGate({
      ...ok,
      attachments: [
        { name: "Make Safe Report - SWMS-1.pdf" },
        { name: "Xero Invoice INV-1.pdf" },
      ],
    }).some((f) => f.includes("invoice")),
    true,
  );
});

Deno.test("photo gate: AJS requires permanent pack CCs; MLB forbids cc; raw photoNN refused", () => {
  assertEquals(isRawPhotoDumpName("photo12.jpg"), true);
  assertEquals(isRawPhotoDumpName("Front elevation.jpg"), false);

  const base = {
    from: MAKESAFE_ADMIN_FROM,
    to: "workorders@ajs.build",
    subject: "Photo Evidence",
    htmlBody: MAVERICK_HTML,
    attachments: [{ name: "Front elevation.jpg" }],
  };
  assertEquals(
    checkPhotoRouteClientSendGate({ ...base, cc: AJS_PACK_CC }, {
      builderKey: "AJS",
    }),
    [],
  );
  // ses@ alone is no longer enough for AJS — vanessa and mandi are permanent.
  assertEquals(
    checkPhotoRouteClientSendGate({ ...base, cc: MAKESAFE_CC }, {
      builderKey: "AJS",
    }).some((f) => f.includes(AJS_VANESSA_CC) || f.includes(AJS_MANDI_CC)),
    true,
  );
  assertEquals(
    checkPhotoRouteClientSendGate({ ...base, cc: "" }, { builderKey: "AJS" })
      .some((f) => f.includes(MAKESAFE_CC)),
    true,
  );
  assertEquals(
    checkPhotoRouteClientSendGate({ ...base, cc: "" }, { builderKey: "MLB" }),
    [],
  );
  assertEquals(
    checkPhotoRouteClientSendGate({ ...base, cc: MAKESAFE_CC }, {
      builderKey: "MLB",
    }).some((f) => f.includes("no cc")),
    true,
  );
  assertEquals(
    checkPhotoRouteClientSendGate({
      ...base,
      cc: MAKESAFE_CC,
      attachments: [{ name: "photo3.jpg" }],
    }, { builderKey: "AJS" }).some((f) => f.includes("raw dump")),
    true,
  );
  assertEquals(
    checkPhotoRouteClientSendGate({
      ...base,
      cc: MAKESAFE_CC,
      attachments: [
        { name: "Front.jpg" },
        { name: "Xero Invoice INV-1.pdf" },
      ],
    }, { builderKey: "AJS" }).some((f) => f.includes("PDF")),
    true,
  );
});

Deno.test("MLB invoice gate requires finance@, forbids ses@, needs explicit invoice_to", () => {
  const ok = {
    from: MAKESAFE_ADMIN_FROM,
    to: "makesafes@mlb.example",
    cc: MAKESAFE_FINANCE_CC,
    subject: "Invoice",
    htmlBody: MAVERICK_HTML,
    attachments: [{ name: "Xero Invoice INV-9.pdf" }],
  };
  assertEquals(
    checkMlbInvoiceClientSendGate(ok, {
      configuredInvoiceTo: "makesafes@mlb.example",
    }),
    [],
  );
  assertEquals(
    checkMlbInvoiceClientSendGate(ok, { configuredInvoiceTo: "" }).some((f) =>
      f.includes("invoice_to")
    ),
    true,
  );
  assertEquals(
    checkMlbInvoiceClientSendGate({
      ...ok,
      cc: `${MAKESAFE_FINANCE_CC},${MAKESAFE_CC}`,
    }, { configuredInvoiceTo: "makesafes@mlb.example" }).some((f) =>
      f.includes(MAKESAFE_CC)
    ),
    true,
  );
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
  {
    role: "completion_photo",
    object_key: "bucket/docket-ajs/ARTIFACTS/photo1.jpg",
    media_type: "image/jpeg",
    content_hash: "photo-hash-1",
  },
];

Deno.test("AJS resolveDocketRoutes emits report_invoice + photo with Xero PDF on route 1", () => {
  const routes = resolveDocketRoutes(
    ajsDocket("invoice_bound", {
      status: "AUTHORISED",
      xero_invoice_id: "xero-1",
      invoice_number: "INV-1",
    }),
    AJS_ARTIFACTS,
    null,
  );
  assertEquals(routes.map((r) => r.route_kind), ["report_invoice", "photo"]);
  const pack = routes[0];
  assertEquals(pack.recipients[0], AJS_WORK_ORDERS_MAILBOX);
  assertEquals(pack.cc, AJS_PACK_CC);
  assertEquals(pack.attachment_hashes.includes("xero-hash"), true);
  assertEquals(pack.attachment_hashes.includes("report-hash"), true);
  assertEquals(pack.ready, true);
  assertEquals(routes[1].route_kind, "photo");
  assertEquals(routes[1].cc, AJS_PACK_CC);
  assertEquals(routes[1].attachment_hashes, ["photo-hash-1"]);
  assertEquals(routes[1].ready, true);
});

/** Builder-facing AJS bodies: what is attached, job ref, thanks. No internal jargon. */
const AJS_INTERNAL_BODY_TERMS = [
  "Draft only",
  "docket",
  "pack",
  "route",
  "cycle",
  "revision",
  "fully bound",
  "AUTHORISED",
  "Mail.Send",
];

Deno.test("AJS release email bodies are plain professional English with job ref", () => {
  // Stored draft bodies deliberately carry the old internal jargon so the
  // release resolver must rewrite them rather than inherit them.
  const docket = {
    ...ajsDocket("invoice_bound", {
      status: "AUTHORISED",
      xero_invoice_id: "xero-1",
      invoice_number: "INV-1",
    }),
    email_drafts: {
      REPORT_EMAIL_DRAFT: [
        "To: workorders@ajs.build",
        "Cc:",
        "Subject: AJBR-70100 - report and invoice",
        "Attachments: ARTIFACTS/report.pdf",
        "",
        "Draft only. The combined report and invoice pack is not yet fully bound.",
      ].join("\n"),
      PHOTO_EMAIL_DRAFT: [
        "To: workorders@ajs.build",
        "Cc:",
        "Subject: Photo Evidence - AJBR-70100",
        "Attachments: ARTIFACTS/photo1.jpg",
        "",
        "Draft only. The complete, ordered original photo set is listed on the docket.",
      ].join("\n"),
    },
  };
  const routes = resolveDocketRoutes(docket, AJS_ARTIFACTS, null);
  const pack = routes.find((r) => r.route_kind === "report_invoice")!;
  const photo = routes.find((r) => r.route_kind === "photo")!;
  assertEquals(
    pack.body,
    "Please find attached the report and invoice for AJBR-70100.\n\nThank you.",
  );
  assertEquals(
    photo.body,
    "Please find attached site photos for AJBR-70100.\n\nThank you.",
  );
  for (const body of [pack.body, photo.body]) {
    for (const term of AJS_INTERNAL_BODY_TERMS) {
      assertEquals(
        body.toLowerCase().includes(term.toLowerCase()),
        false,
        `AJS body must not contain internal term "${term}": ${body}`,
      );
    }
  }
});

/**
 * Live Bertram shape (SWMS-261109 / INV-1102 bind): the invoice_bound docket
 * copies pre_xero completion photos and keeps the PARENT revision id in
 * object_key (`…/{based_on}/ARTIFACTS/photos/001-….jpg`). Draft Attachments
 * still say `ARTIFACTS/photos/…`. The old `/${docket.id}/` + last-two-segments
 * fallback resolved that to `photos/001-….jpg` and dropped every attachment.
 */
Deno.test(
  "invoice_bound docket resolves nested photo paths when object_key still names based_on revision",
  () => {
    const boundId = "ecfcbd8e-81d5-55d8-a9d4-9d5ad89f8916";
    const parentId = "6a55da20-1624-5096-ae29-5549c7f9dc66";
    const jobId = "208450c0-7161-4b30-9514-66226b054609";
    const photoName = "001-049f6631-0e74-45f8-aa18-845760ffae1a.jpg";
    const docket = {
      ...ajsDocket("invoice_bound", {
        status: "AUTHORISED",
        xero_invoice_id: "xero-1",
        invoice_number: "INV-1102",
      }),
      id: boundId,
      based_on_revision_id: parentId,
      email_drafts: {
        REPORT_EMAIL_DRAFT: [
          "To: workorders@ajs.build",
          "Cc:",
          "Subject: AJBR-70271 - physical makesafe",
          "Attachments: ARTIFACTS/Make-Safe-Report.pdf",
          "",
          "Report body",
        ].join("\n"),
        PHOTO_EMAIL_DRAFT: [
          "To: workorders@ajs.build",
          "Cc:",
          "Subject: Photo Evidence - AJBR-70271",
          `Attachments: ARTIFACTS/photos/${photoName}`,
          "",
          "Photos body",
        ].join("\n"),
        INVOICE_EMAIL_DRAFT: [
          "To: workorders@ajs.build",
          "Cc: finance@secureworkswa.com.au",
          "Subject: AJBR-70271 - invoice",
          "Attachments: ARTIFACTS/invoice_proposal.json, ARTIFACTS/Make-Safe-Report.pdf",
          "",
          "Invoice body",
        ].join("\n"),
      },
    };
    const artifacts = [
      {
        role: "supporting_report_pdf",
        object_key:
          `makesafe-docket-artifacts/${jobId}/${parentId}/ARTIFACTS/Make-Safe-Report.pdf`,
        media_type: "application/pdf",
        content_hash: "report-hash",
      },
      {
        role: "completion_photo",
        object_key:
          `makesafe-docket-artifacts/${jobId}/${parentId}/ARTIFACTS/photos/${photoName}`,
        media_type: "image/jpeg",
        content_hash: "photo-hash-bertram",
      },
      {
        role: "xero_invoice_pdf",
        object_key:
          `makesafe-docket-artifacts/${jobId}/${boundId}/ARTIFACTS/Xero Invoice - INV-1102.pdf`,
        media_type: "application/pdf",
        content_hash: "xero-hash",
        metadata: {
          xero_invoice_id: "xero-1",
          invoice_number: "INV-1102",
        },
      },
    ];
    const routes = resolveDocketRoutes(docket, artifacts, null);
    assertEquals(routes.map((r) => r.route_kind), ["report_invoice", "photo"]);
    const photo = routes.find((r) => r.route_kind === "photo");
    assertEquals(photo?.attachment_hashes, ["photo-hash-bertram"]);
    assertEquals(photo?.ready, true);
    const pack = routes.find((r) => r.route_kind === "report_invoice");
    assertEquals(pack?.ready, true);
    assertEquals(pack?.attachment_hashes.includes("xero-hash"), true);
    assertEquals(pack?.attachment_hashes.includes("report-hash"), true);
  },
);

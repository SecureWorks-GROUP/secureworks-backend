import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AJS_MANDI_CC,
  AJS_VANESSA_CC,
  AJS_WORK_ORDERS_MAILBOX,
  ajsPackCc,
  ajsPackRecipients,
  clientSendGateKindForRoute,
  isAjsBuilderKey,
  isMlbPrimeMailerRouteKind,
  MLB_PRIME_MAILER,
  mlbPhysicalRouteRecipients,
  mlbPrimeMailerRouteCarriesInvoice,
  SES_AJS_ROUTE_ORDER,
  SES_UNIVERSAL_ROUTE_ORDER,
  sesBodyCarriesInternalAnnotation,
  sesBuilderRouteBody,
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
import { SES_SAMPLE_DESTINATION_ENV } from "./ses_sample_destination.ts";

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

Deno.test("AJS DRAFT report_invoice is review-ready when the draft PDF hash is present", () => {
  const draftArtifacts = AJS_ARTIFACTS.filter((a) =>
    a.role !== "xero_invoice_pdf"
  );
  const routes = resolveDocketRoutes(
    ajsDocket("invoice_bound", {
      status: "DRAFT",
      xero_invoice_id: "xero-1",
      invoice_number: "INV-1",
      pdf_content_hash: "draft-pdf-hash",
    }),
    draftArtifacts,
    null,
  );
  const pack = routes[0];
  assertEquals(pack.route_kind, "report_invoice");
  assertEquals(pack.ready, true);
  assertEquals(pack.attachment_hashes.includes("draft-pdf-hash"), true);
  assertEquals(pack.attachment_hashes.includes("report-hash"), true);
  assertEquals(pack.subject.includes("Xero draft INV-1"), true);
});

Deno.test("AJS DRAFT report_invoice stays unready without a draft PDF", () => {
  const draftArtifacts = AJS_ARTIFACTS.filter((a) =>
    a.role !== "xero_invoice_pdf"
  );
  const routes = resolveDocketRoutes(
    ajsDocket("invoice_bound", {
      status: "DRAFT",
      xero_invoice_id: "xero-1",
      invoice_number: "INV-1",
    }),
    draftArtifacts,
    null,
  );
  assertEquals(routes[0].route_kind, "report_invoice");
  assertEquals(routes[0].ready, false);
});

Deno.test("SAMPLE AJS resolve blanks builder mailboxes when override env is unset", () => {
  const previous = Deno.env.get(SES_SAMPLE_DESTINATION_ENV);
  Deno.env.delete(SES_SAMPLE_DESTINATION_ENV);
  try {
    const docket = {
      ...ajsDocket("invoice_bound", {
        status: "AUTHORISED",
        xero_invoice_id: "xero-1",
        invoice_number: "INV-1",
      }),
      job_number: "SAMPLE-AJS-0001",
    };
    const routes = resolveDocketRoutes(docket, AJS_ARTIFACTS, null);
    assertEquals(routes.map((r) => r.recipients), [[], []]);
    assertEquals(routes.every((r) => r.ready === false), true);
  } finally {
    if (previous === undefined) Deno.env.delete(SES_SAMPLE_DESTINATION_ENV);
    else Deno.env.set(SES_SAMPLE_DESTINATION_ENV, previous);
  }
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

// ---------------------------------------------------------------------------
// MLB physical three-route destinations (Captain 2026-08-06).
//
// These are pure-producer proofs. The mail gateway is mocked everywhere in this
// suite, so nothing here proves a message ARRIVES at either mailbox — only that
// one producer resolves the three destinations and that the boundary holds.
// ---------------------------------------------------------------------------

Deno.test(
  "MLB physical routes: billing pack to the matrix mailbox, report and photo to the Prime mailer",
  () => {
    assertEquals(MLB_PRIME_MAILER, "mlb.mailer@primeeco.tech");
    assertEquals(
      mlbPhysicalRouteRecipients("invoice", "makesafes@mlbuilders.com.au"),
      ["makesafes@mlbuilders.com.au"],
    );
    assertEquals(
      mlbPhysicalRouteRecipients("report", "makesafes@mlbuilders.com.au"),
      [MLB_PRIME_MAILER],
    );
    assertEquals(
      mlbPhysicalRouteRecipients("photo", "makesafes@mlbuilders.com.au"),
      [MLB_PRIME_MAILER],
    );
    assertEquals(isMlbPrimeMailerRouteKind("report"), true);
    assertEquals(isMlbPrimeMailerRouteKind("photo"), true);
    assertEquals(isMlbPrimeMailerRouteKind("invoice"), false);
  },
);

Deno.test(
  "MLB billing mailbox stays the sealed matrix value, so the south-west row still routes to bunbury@",
  () => {
    // The matrix picks Perth vs south-west; this producer must never re-decide.
    assertEquals(
      mlbPhysicalRouteRecipients("invoice", "bunbury@mlbuilders.com.au"),
      ["bunbury@mlbuilders.com.au"],
    );
    // …and the mailer routes are unaffected by which billing mailbox applies.
    assertEquals(
      mlbPhysicalRouteRecipients("report", "bunbury@mlbuilders.com.au"),
      [MLB_PRIME_MAILER],
    );
    // A legacy envelope with no declared billing mailbox yields nothing rather
    // than inventing one — the caller keeps the route as prepared.
    assertEquals(mlbPhysicalRouteRecipients("invoice", ""), []);
    assertEquals(mlbPhysicalRouteRecipients("invoice", null), []);
  },
);

Deno.test(
  "no invoice on either Prime mailer route: the guard fires on the bound Xero PDF only",
  () => {
    const invoiceHash = "xero-hash";
    for (const routeKind of ["report", "photo"] as const) {
      assertEquals(
        mlbPrimeMailerRouteCarriesInvoice({
          routeKind,
          attachmentHashes: ["report-hash", invoiceHash],
          invoicePdfContentHash: invoiceHash,
        }),
        true,
      );
      assertEquals(
        mlbPrimeMailerRouteCarriesInvoice({
          routeKind,
          attachmentHashes: ["report-hash", "photo-hash-1"],
          invoicePdfContentHash: invoiceHash,
        }),
        false,
      );
    }
    // The billing pack is SUPPOSED to carry the invoice — never refuse it.
    assertEquals(
      mlbPrimeMailerRouteCarriesInvoice({
        routeKind: "invoice",
        attachmentHashes: ["report-hash", "swms-hash", invoiceHash],
        invoicePdfContentHash: invoiceHash,
      }),
      false,
    );
    // No bound invoice PDF means there is nothing to leak.
    assertEquals(
      mlbPrimeMailerRouteCarriesInvoice({
        routeKind: "report",
        attachmentHashes: ["report-hash"],
        invoicePdfContentHash: null,
      }),
      false,
    );
  },
);

// ---------------------------------------------------------------------------
// Builder-facing bodies on the MLB physical and universal shapes.
//
// Live leak (SWMS-261161 Mosman Park 2026-08-10, SWMS-261158 Northam
// 2026-08-13): resolveDocketRoutes set bodies for the AJS shape only, so the
// MLB physical and universal shapes inherited the stored draft ANNOTATIONS
// ("Draft only. Report pack … Ordinary Mail.Send …") and mailed them to the
// builder verbatim. These tests pin the producer for every non-AJS shape,
// ordinary-mail exception included.
// ---------------------------------------------------------------------------

/** The exact annotation bodies that shipped live — must never resolve again. */
const LEAKED_ANNOTATION_BODIES = [
  "Draft only. Report pack for 63 Chidlow St, Northam. Ordinary Mail.Send (group-thread reply is Application: Not supported); subject matches the original work-order email for inbox grouping only — not real threading. Photos and the billing pack travel on separate routes.",
  "Draft only. Photo pack. Ordinary Mail.Send; subject matches the original work-order email for inbox grouping only — not real threading. The complete, ordered original photo set is listed on the docket.",
  "Draft only. Billing pack for makesafes@: make-safe report, SWMS, and the authorised Xero invoice. No release is approved until the invoice is AUTHORISED.",
];

const MLB_CLEAN_BODIES: Record<string, string> = {
  report: "Please find attached the report for MLB-27516.\n\nThank you.",
  photo: "Please find attached site photos for MLB-27516.\n\nThank you.",
  invoice:
    "Please find attached the invoice and supporting documents for MLB-27516.\n\nThank you.",
};

function mlbDocket(
  stage: string,
  xero: Record<string, unknown> | null,
  builderKey = "MLB",
) {
  return {
    id: "docket-mlb",
    stage,
    envelope: {
      v2: {
        classification: {
          builder_key: builderKey,
          family: "physical_makesafe",
        },
        routing: {
          report_to: "makesafes@mlbuilders.com.au",
          photo_to: "makesafes@mlbuilders.com.au",
          invoice_to: "makesafes@mlbuilders.com.au",
        },
      },
    },
    local_invoice_proposal: { builder_reference: "MLB-27516" },
    xero_binding: xero,
    email_drafts: {
      REPORT_EMAIL_DRAFT: [
        "To: mlb.mailer@primeeco.tech",
        "Cc:",
        "Subject: NEW WORK ORDER - MLB-27516 63 Chidlow St E, Northam, WA 6401",
        "Attachments: ARTIFACTS/report.pdf",
        "",
        LEAKED_ANNOTATION_BODIES[0],
      ].join("\n"),
      PHOTO_EMAIL_DRAFT: [
        "To: mlb.mailer@primeeco.tech",
        "Cc:",
        "Subject: NEW WORK ORDER - MLB-27516 63 Chidlow St E, Northam, WA 6401",
        "Attachments: ARTIFACTS/photo1.jpg",
        "",
        LEAKED_ANNOTATION_BODIES[1],
      ].join("\n"),
      INVOICE_EMAIL_DRAFT: [
        "To: makesafes@mlbuilders.com.au",
        "Cc: finance@secureworkswa.com.au",
        "Subject: MLB-27516 - billing pack (report, SWMS, invoice)",
        "Attachments: ARTIFACTS/report.pdf, ARTIFACTS/swms.pdf",
        "",
        LEAKED_ANNOTATION_BODIES[2],
      ].join("\n"),
    },
  };
}

const MLB_ARTIFACTS = [
  {
    role: "supporting_report_pdf",
    object_key: "bucket/docket-mlb/ARTIFACTS/report.pdf",
    media_type: "application/pdf",
    content_hash: "report-hash",
  },
  {
    role: "swms_artifact",
    object_key: "bucket/docket-mlb/ARTIFACTS/swms.pdf",
    media_type: "application/pdf",
    content_hash: "swms-hash",
  },
  {
    role: "completion_photo",
    object_key: "bucket/docket-mlb/ARTIFACTS/photo1.jpg",
    media_type: "image/jpeg",
    content_hash: "photo-hash-1",
  },
  {
    role: "xero_invoice_pdf",
    object_key: "bucket/docket-mlb/ARTIFACTS/xero-invoice.pdf",
    media_type: "application/pdf",
    content_hash: "xero-hash",
    metadata: { xero_invoice_id: "xero-1", invoice_number: "INV-1179" },
  },
];

const MLB_AUTHORISED_BINDING = {
  status: "AUTHORISED",
  xero_invoice_id: "xero-1",
  invoice_number: "INV-1179",
};

Deno.test("sesBuilderRouteBody produces the pinned plain-English bodies", () => {
  assertEquals(
    sesBuilderRouteBody("report", "MLB-27516"),
    MLB_CLEAN_BODIES.report,
  );
  assertEquals(
    sesBuilderRouteBody("photo", "MLB-27516"),
    MLB_CLEAN_BODIES.photo,
  );
  assertEquals(
    sesBuilderRouteBody("invoice", "MLB-27516"),
    MLB_CLEAN_BODIES.invoice,
  );
  assertEquals(
    sesBuilderRouteBody("invoice", "MLB-27516", { noAdditionalCharge: true }),
    "Please find attached the supporting documents for MLB-27516. There is no additional charge for this attendance.\n\nThank you.",
  );
  // Missing reference still yields client English, never an empty slot.
  assertEquals(
    sesBuilderRouteBody("report", ""),
    "Please find attached the report for this job.\n\nThank you.",
  );
});

Deno.test("sesBodyCarriesInternalAnnotation catches every leaked body and passes every producer body", () => {
  for (const leaked of LEAKED_ANNOTATION_BODIES) {
    assertEquals(sesBodyCarriesInternalAnnotation(leaked), true, leaked);
  }
  // The pre-fix authorised invoice wording carried "current-cycle".
  assertEquals(
    sesBodyCarriesInternalAnnotation(
      "Please find the authorised SecureWorks Xero invoice and the supporting current-cycle documents attached.",
    ),
    true,
  );
  const producerBodies = [
    sesBuilderRouteBody("report", "MLB-27516"),
    sesBuilderRouteBody("photo", "MLB-27516"),
    sesBuilderRouteBody("invoice", "MLB-27516"),
    sesBuilderRouteBody("invoice", "MLB-27516", { noAdditionalCharge: true }),
    // Pinned AJS bodies stay clean under the same detector.
    "Please find attached the report and invoice for AJBR-70100.\n\nThank you.",
    "Please find attached site photos for AJBR-70100.\n\nThank you.",
    "Please find attached the report for AJBR-70100. There is no additional charge for this attendance.\n\nThank you.",
  ];
  for (const body of producerBodies) {
    assertEquals(sesBodyCarriesInternalAnnotation(body), false, body);
  }
});

Deno.test("MLB physical bodies are SET plain English on the ordinary-mail exception path", () => {
  const routes = resolveDocketRoutes(
    mlbDocket("invoice_bound", MLB_AUTHORISED_BINDING),
    MLB_ARTIFACTS,
    null,
    { mlbOrdinaryMailSendFallback: true },
  );
  assertEquals(routes.map((r) => r.route_kind), ["report", "photo", "invoice"]);
  for (const route of routes) {
    assertEquals(
      route.body,
      MLB_CLEAN_BODIES[route.route_kind],
      route.route_kind,
    );
    assertEquals(sesBodyCarriesInternalAnnotation(route.body), false);
    assertEquals(route.ready, true, `${route.route_kind} must stay sendable`);
  }
  // Body fix must not move destinations, subjects, or transport stamps.
  const [report, photo, invoice] = routes;
  assertEquals(report.recipients, [MLB_PRIME_MAILER]);
  assertEquals(photo.recipients, [MLB_PRIME_MAILER]);
  assertEquals(invoice.recipients, ["makesafes@mlbuilders.com.au"]);
  assertEquals(
    report.subject,
    "NEW WORK ORDER - MLB-27516 63 Chidlow St E, Northam, WA 6401",
  );
  assertEquals(
    (report as any).mlb_transport,
    "ordinary_mail_send_captain_exception_v1",
  );
  assertEquals((invoice as any).mlb_transport, null);
  assertEquals(invoice.attachment_hashes.includes("xero-hash"), true);
});

Deno.test("MLB physical bodies stay plain English on the locked intake-thread shape", () => {
  const routes = resolveDocketRoutes(
    mlbDocket("invoice_bound", MLB_AUTHORISED_BINDING),
    MLB_ARTIFACTS,
    null,
    { mlbOrdinaryMailSendFallback: false },
  );
  for (const route of routes) {
    assertEquals(
      route.body,
      MLB_CLEAN_BODIES[route.route_kind],
      route.route_kind,
    );
  }
  // No intake thread id on this envelope: the locked shape refuses readiness,
  // but the refusal never re-inherits the stored annotation body.
  const report = routes.find((r) => r.route_kind === "report")!;
  assertEquals((report as any).requires_thread_reply, true);
  assertEquals(report.ready, false);
});

Deno.test("MLB pre-authorise routes already carry clean bodies (Northam ships without a docket re-prepare)", () => {
  const routes = resolveDocketRoutes(
    mlbDocket("pre_xero", null),
    MLB_ARTIFACTS,
    null,
    { mlbOrdinaryMailSendFallback: true },
  );
  for (const route of routes) {
    assertEquals(
      route.body,
      MLB_CLEAN_BODIES[route.route_kind],
      route.route_kind,
    );
    assertEquals(sesBodyCarriesInternalAnnotation(route.body), false);
  }
  const invoice = routes.find((r) => r.route_kind === "invoice")!;
  assertEquals(invoice.ready, false);
});

Deno.test("universal three-route shape also sets plain-English bodies", () => {
  const routes = resolveDocketRoutes(
    mlbDocket("invoice_bound", MLB_AUTHORISED_BINDING, "WESTERN"),
    MLB_ARTIFACTS,
    null,
  );
  assertEquals(routes.map((r) => r.route_kind), ["report", "photo", "invoice"]);
  for (const route of routes) {
    assertEquals(
      route.body,
      MLB_CLEAN_BODIES[route.route_kind],
      route.route_kind,
    );
    assertEquals(sesBodyCarriesInternalAnnotation(route.body), false);
  }
});

Deno.test("AJS/AJBR destinations are untouched by the MLB ruling", () => {
  const recipients = ajsPackRecipients({ workOrderSender: null });
  assertEquals(recipients, [AJS_WORK_ORDERS_MAILBOX]);
  assertEquals(ajsPackCc(), AJS_PACK_CC);
  assertEquals(recipients.includes(MLB_PRIME_MAILER), false);
  assertEquals(ajsPackCc().includes(MLB_PRIME_MAILER), false);
});

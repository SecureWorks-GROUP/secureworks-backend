// Anonymised Ambrose Construct Group purchase-order fixtures.
//
// The SHAPE is copied from Ambrose's live purchase-order mail (subject grammar,
// body sentences, PDF label layout and the order those labels arrive in after
// text extraction). Every person, address, phone number, email address, job
// number and dollar figure is invented. Never paste a real Ambrose PO here.
import type {
  DeterministicAttachment,
  DeterministicPdfDocument,
  DeterministicSourceItem,
} from "./makesafe_deterministic_intake.ts";

export const AMBROSE_TEST_COMPANY_ID = "77777777-7777-7777-7777-777777777777";
export const AMBROSE_TEST_SENDER = "sam.supervisor@ambrose.test";

export interface AmbrosePurchaseOrderFixture {
  job: string;
  sequence: string;
  address: string;
  kind: "make_safe" | "repair";
  updated?: boolean;
}

export function ambroseSubject(fixture: AmbrosePurchaseOrderFixture): string {
  const po = `${fixture.job}-${fixture.sequence}`;
  const label = fixture.kind === "make_safe"
    ? "Purchase Order Make Safe"
    : "Purchase Order";
  return `${
    fixture.updated ? "Updated:" : ""
  }Ambrose Construct Group ${label}: ${po} -  ${fixture.address}  is attached`;
}

export function ambroseBody(fixture: AmbrosePurchaseOrderFixture): string {
  const po = `${fixture.job}-${fixture.sequence}`;
  return fixture.kind === "make_safe"
    ? [
      "Hello SECUREWORKS WA,",
      "",
      `Please see attached PO #${po} regarding Make Safe required at the above address. When completing a make safe for Ambrose Construct Group we require that you complete a make safe report and pictures via the Ambrose portal.`,
      "",
      "Kind regards,",
    ].join("\n")
    : [
      "Hello SECUREWORKS WA,",
      "",
      `Please see ${
        fixture.updated ? "updated and " : ""
      }attached schedule and PO #${po} regarding repairs required at the above address.`,
      "",
      "View Repair Schedule - Repair Schedule",
      "",
      "View Site Images - Images",
      "",
      "Notes:",
    ].join("\n");
}

export function ambrosePdfText(fixture: AmbrosePurchaseOrderFixture): string {
  const po = `${fixture.job}-${fixture.sequence}`;
  const notes = fixture.kind === "make_safe"
    ? [
      "Notes:**NEW MAKE SAFE WORK ORDER**",
      "Hi Team,",
      "Please contact the insured on 0400 000 001 to confirm your arrival day/time to site to",
      "complete roof make safe.",
      "Please note: Work order is a DO AND CHARGE and your costs will be approved over the allocation, as long as fair and",
      "reasonable.",
    ]
    : [
      "Notes:Please complete the carpentry repairs per the attached repair schedule.",
    ];
  const works = fixture.kind === "make_safe"
    ? [
      "Kitchen Dining Open Plan 8.00L x 6.00W x H",
      "Please make tiled roof water tight and secure, check internal linings, remove",
      "any wet insulation from ceiling space. Complete report and images.",
      "1 EA",
      "TOTAL Purchase Order Price (ex GST) $100.00",
      "Trade Type Labour / Materials Value",
      "Roof Tiler Labour $100.00",
    ]
    : [
      "Front Verandah 4.00L x 2.00W x H",
      "Replace the damaged fascia board and repaint to match.",
      "1 EA",
      "TOTAL Purchase Order Price (ex GST) $200.00",
      "Trade Type Labour / Materials Value",
      "Carpentry Labour Labour $200.00",
    ];
  return [
    `Purchase Order P.O. No: ${po}`,
    " SAFETY ALERT INCLUDED. SEE BELOW.",
    "This Purchase Order, together with the General Conditions and Supplier Manual, sets out the",
    "Subcontract agreement between the Builder and Subcontractor.",
    `Site Address: ${fixture.address}`,
    "Commencement date: Oct 9, 2026, 10:00:00 AM Completion date: Oct 9, 2026, 11:00:00 AM",
    ...notes,
    "Kind regards,",
    "Sam Supervisor",
    "AMBROSE CONSTRUCT GROUP",
    "Contact number: 07 0000 0000",
    "Commercial-in-confidence Page 1 of 7",
    "SUBCONTRACTOR DETAILS",
    "Trading Name: SECUREWORKS WA",
    "Address: 1 Depot Place Testvale WA 6999",
    "Phone: 0499999999",
    "Email: office@secureworkswa.com.au",
    "SUPERVISOR DETAILS",
    "Name: Sam Supervisor",
    "Mobile: 0700000000",
    "Work: 0700000000",
    "Email:",
    AMBROSE_TEST_SENDER,
    "BEST CONTACT DETAILS",
    "Decision Maker: Alex Example",
    "Contact Type: Insured Owner 1",
    "Email: alex.example@example.test",
    "Mobile: 0400000001",
    "Site Contact: Jordan Example",
    "Contact Type: Authorised Contact",
    "Mobile: 0400000002",
    "JOB DETAILS",
    `Job Number: ${fixture.job}`,
    "Job Type: Residential",
    "PO Sent Date: Oct 8, 2026, 4:31:06 PM",
    "Payment Terms: 14 days from submission of Invoice subject to",
    "approval.",
    `Site Address: ${fixture.address}`,
    "Insurer: Example Insurance",
    "Insured Owner: Alex Example",
    "Authorised Contact: Jordan Example",
    "Occupant Contact:",
    "Property Manager:",
    "Real Estate Contact Details:",
    "Description of the Works Quantity Unit",
    ...works,
    "Commercial-in-confidence Page 2 of 7",
    "Issued by: Sam Supervisor (W) 0700000000 (M) 0700000000",
    "Please submit the Subcontractor's Progress Claim (Invoice) via Tradies Admin.",
    "Please refer to the Extra Documents page of this PO which provides details of any additional documents.",
    "Ambrose Construct Group Pty Ltd",
    "Commercial-in-confidence Page 7 of 7",
  ].join("\n");
}

export function ambroseSource(
  postId: string,
  fixture: AmbrosePurchaseOrderFixture,
  overrides: Partial<DeterministicSourceItem> = {},
): DeterministicSourceItem {
  const attachment: DeterministicAttachment = {
    id: `${postId}-pdf`,
    sourcePostId: postId,
    name: "Purchase Order.pdf",
    contentType: "application/pdf",
    storagePath: `${postId}/purchase-order.pdf`,
    status: "uploaded",
    sizeBytes: 300_000,
    sha256: `sha-${postId}`,
  };
  const document: DeterministicPdfDocument = {
    sourcePostId: postId,
    attachmentId: attachment.id,
    attachmentName: attachment.name,
    status: "extracted",
    text: ambrosePdfText(fixture),
    charCount: ambrosePdfText(fixture).length,
    pageCount: 7,
    extractor: "fixture",
    truncated: false,
    reason: null,
    sha256: attachment.sha256,
  };
  return {
    postId,
    fromEmail: AMBROSE_TEST_SENDER,
    fromName: AMBROSE_TEST_SENDER,
    subject: ambroseSubject(fixture),
    body: ambroseBody(fixture),
    receivedAt: "2026-10-08T06:31:45.000Z",
    attachments: [attachment],
    links: [],
    pdfDocuments: [document],
    conversationId: `conversation-${postId}`,
    threadId: null,
    replyToPostId: null,
    relatedPostIds: [],
    siblingPostIds: [],
    direction: "inbound",
    syntheticLivefireMarker: null,
    ...overrides,
  };
}

/** The pre-acceptance prompt: PO number, trade and suburb, no PDF. */
export function ambroseAcceptancePrompt(
  postId: string,
  fixture: AmbrosePurchaseOrderFixture,
): DeterministicSourceItem {
  const po = `${fixture.job}-${fixture.sequence}`;
  return {
    ...ambroseSource(postId, fixture),
    subject:
      `Ambrose Construct Group Acceptance Required - Purchase Order: ${po}`,
    body: [
      "Hello SECUREWORKS WA PTY LTD,",
      "",
      `Ambrose Construct Group have allocated you PO #${po} which requires your acceptance.`,
      "",
      "Purchase Order Preliminary Details:",
      "",
      "Trade Group: Carpentry Labour",
      "",
      "Scheduled Start: 12/10/2026 10:00 AM",
    ].join("\n"),
    attachments: [],
    pdfDocuments: [],
  };
}

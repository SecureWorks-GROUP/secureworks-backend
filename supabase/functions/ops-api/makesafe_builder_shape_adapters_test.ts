import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adaptDeterministicSource,
  buildDeterministicIntakePlan,
  type DeterministicCompanyProfile,
  type DeterministicSourceItem,
} from "./makesafe_deterministic_intake.ts";

const PROFILES: DeterministicCompanyProfile[] = [
  {
    id: "company-bw",
    slug: "bw",
    name: "BuilderWest",
    senderPatterns: ["primeeco.tech"],
    parsingRules: null,
  },
  {
    id: "company-western",
    slug: "wb",
    name: "Western",
    senderPatterns: ["western.mailer@primeeco.tech"],
    parsingRules: null,
  },
  {
    id: "company-mlb",
    slug: "mlb",
    name: "MLB",
    senderPatterns: ["mlb.example"],
    parsingRules: null,
  },
];

function source(
  postId: string,
  fromEmail: string,
  subject: string,
  body = "",
  withPdf = false,
): DeterministicSourceItem {
  return {
    postId,
    fromEmail,
    subject,
    body,
    receivedAt: `2026-07-2${postId.length % 8}T00:00:00.000Z`,
    attachments: withPdf
      ? [{
        id: `${postId}-pdf`,
        sourcePostId: postId,
        name: "work-order.pdf",
        contentType: "application/pdf",
        storagePath: `makesafe/${postId}.pdf`,
        status: "stored",
      }]
      : [],
    links: [],
    pdfDocuments: withPdf
      ? [{
        sourcePostId: postId,
        attachmentId: `${postId}-pdf`,
        attachmentName: "work-order.pdf",
        status: "extracted",
        text:
          "WORK ORDER BWCWA70001 Client: Example Resident Phone: 0400000000 Site Address: 1 Example Street Perth WA 6000 Scope: Make safe storm damage",
        charCount: 145,
        pageCount: 1,
        extractor: "fixture",
        truncated: false,
        reason: null,
      }]
      : [],
  };
}

Deno.test("shared PrimeEco transport is not sufficient to select BuilderWest", () => {
  const genericPrime = source(
    "prime-generic",
    "notifications@primeeco.tech",
    "Portal notification",
    "A portal item is available for review.",
  );

  assertEquals(
    adaptDeterministicSource(genericPrime, PROFILES).adapterId,
    "prime",
  );
});

Deno.test("seven independently catalogued BuilderWest, Western and MLB shapes enter a dedicated fate path", () => {
  const fixtures: Array<{
    shape: string;
    item: DeterministicSourceItem;
    adapter: "builderwest" | "western" | "mlb";
    intent: "work" | "revision";
  }> = [
    {
      shape: "BW-NEW-MS-WO-NO-PDF",
      item: source(
        "bw-no-pdf",
        "notifications@primeeco.tech",
        "New Make Safe Work Order BWCWA70001",
        "Client: Example Resident\nSite Address: 1 Example Street Perth WA 6000",
      ),
      adapter: "builderwest",
      intent: "work",
    },
    {
      shape: "MLB-INFO-REQUIRED-OUR-REF",
      item: source(
        "mlb-info",
        "workorders@mlb.example",
        "Info Required - Our Ref MLB-70002",
      ),
      adapter: "mlb",
      intent: "revision",
    },
    {
      shape: "BW-REPLY-THREAD",
      item: source(
        "bw-reply",
        "notifications@primeeco.tech",
        "RE: New Make Safe Work Order BWCWA70003",
      ),
      adapter: "builderwest",
      intent: "revision",
    },
    {
      shape: "BW-CLAIM-REF-ADDRESS",
      item: source(
        "bw-claim",
        "notifications@primeeco.tech",
        "123456 - BWCWA70004 - Example Resident - 4 Example Street Perth WA 6000",
      ),
      adapter: "builderwest",
      intent: "work",
    },
    {
      shape: "BW-MAKE-SAFE-AND-REPORT",
      item: source(
        "bw-report",
        "notifications@primeeco.tech",
        "Make Safe and Report BWCWA70005",
        "Client: Example Resident\nSite Address: 5 Example Street Perth WA 6000",
        true,
      ),
      adapter: "builderwest",
      intent: "work",
    },
    {
      shape: "WESTERN-MS-WO-SUBJECT",
      item: source(
        "western-subject",
        "western.mailer@primeeco.tech",
        "Make Safe Work Order: WB70006 | Example Resident | 6 Example Street Perth WA 6000",
        "Phone: 0400000000",
        true,
      ),
      adapter: "western",
      intent: "work",
    },
    {
      shape: "BW-NEW-MS-WO-PDF",
      item: source(
        "bw-pdf",
        "notifications@primeeco.tech",
        "New Make Safe Work Order BWCWA70007",
        "Client: Example Resident\nSite Address: 7 Example Street Perth WA 6000",
        true,
      ),
      adapter: "builderwest",
      intent: "work",
    },
  ];

  for (const fixture of fixtures) {
    const adapted = adaptDeterministicSource(fixture.item, PROFILES);
    assertEquals(adapted.adapterId, fixture.adapter, fixture.shape);
    assertEquals(adapted.intent, fixture.intent, fixture.shape);

    const plan = buildDeterministicIntakePlan([fixture.item], PROFILES);
    assertEquals(plan.sourceClassifications.length, 1, fixture.shape);
    assertEquals(plan.cases.length, 1, fixture.shape);
    const planned = plan.cases[0];
    assert(
      planned.reasonCode || planned.blockedReasons.length > 0 ||
        planned.state === "confirmed_live_job",
      `${fixture.shape} must close as a live, visibly blocked, or reason-coded deterministic fate`,
    );
  }
});

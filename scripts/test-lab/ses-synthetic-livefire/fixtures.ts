import {
  signSyntheticLivefireMarker,
  SYNTHETIC_LIVEFIRE_MAILBOX,
  SYNTHETIC_LIVEFIRE_SENDER,
} from "../../../supabase/functions/ops-api/makesafe_synthetic_livefire.ts";

export type FixtureKind =
  | "physical_makesafe"
  | "portal_roof_report"
  | "assessment_quote"
  | "temporary_fence"
  | "reattendance"
  | "correction"
  | "accounted_non_work";

export interface SyntheticFixture {
  id: string;
  kind: FixtureKind;
  ref: string;
  subject: string;
  htmlBody: string;
  attachment: {
    name: string;
    contentType: "application/pdf";
    bytes: Uint8Array;
  } | null;
  expected: {
    carded: boolean;
    relation: "root" | "reopen_of" | "revision_of" | "none";
    family: string | null;
    portalRoles: string[];
  };
}

export interface FixtureRun {
  runId: string;
  marker: string;
  sender: string;
  mailbox: string;
  expiresAtMs: number;
  fixtures: SyntheticFixture[];
}

interface Definition {
  id: string;
  kind: FixtureKind;
  sequence: number;
  subject: (ref: string) => string;
  body: (ref: string) => string[];
  pdf: boolean;
  expected: SyntheticFixture["expected"];
}

const DEFINITIONS: readonly Definition[] = [
  {
    id: "physical",
    kind: "physical_makesafe",
    sequence: 1,
    subject: (ref) =>
      `NEW WORK ORDER - ${ref} - 14 Test Pattern Avenue, Balcatta`,
    body: (ref) => [
      "A new make-safe work order has been assigned to SecureWorks.",
      `Work Order Number: ${ref}`,
      "Policyholder: Synthetic Homeowner Alpha",
      "Mobile: 0491 570 006",
      "Site Address: 14 Test Pattern Avenue, Balcatta WA 6021",
      "Scope of Works: Attend and make the damaged roof area weather-safe. Install a temporary tarp and photograph the completed make-safe.",
      "Reply To: ses@secureworkswa.com.au",
    ],
    pdf: true,
    expected: {
      carded: true,
      relation: "root",
      family: "general_makesafe",
      portalRoles: [],
    },
  },
  {
    id: "roof",
    kind: "portal_roof_report",
    sequence: 2,
    subject: (ref) => `Prime Ecosystem NEW WORK ORDER - ${ref} - Roof Report`,
    body: (ref) => [
      "Prime notification: a roof report work order has been assigned.",
      `Work Order Number: ${ref}`,
      "Client: Synthetic Homeowner Bravo",
      "Mobile: 0491 570 156",
      "Site Address: 28 Test Pattern Road, Osborne Park WA 6017",
      "Roof Report: https://synthetic.invalid/prime/roof-report",
      "Reply To: ses@secureworkswa.com.au",
    ],
    pdf: true,
    expected: {
      carded: true,
      relation: "root",
      family: "roof_report",
      portalRoles: ["roof_report"],
    },
  },
  {
    id: "assessment",
    kind: "assessment_quote",
    sequence: 3,
    subject: (ref) =>
      `Prime Ecosystem NEW WORK ORDER - ${ref} - Assessment Report and Quote`,
    body: (ref) => [
      "Prime notification: complete the assessment report and quotation.",
      `Work Order Number: ${ref}`,
      "Client: Synthetic Homeowner Charlie",
      "Mobile: 0491 570 157",
      "Site Address: 42 Test Pattern Street, Malaga WA 6090",
      "Assessment Report: https://synthetic.invalid/prime/assessment",
      "Photos: https://synthetic.invalid/prime/photos",
      "Quote: https://synthetic.invalid/prime/quote",
      "Reply To: ses@secureworkswa.com.au",
    ],
    pdf: true,
    expected: {
      carded: true,
      relation: "root",
      family: "assessment_report_quote",
      portalRoles: ["assessment", "photos", "scope"],
    },
  },
  {
    id: "fence",
    kind: "temporary_fence",
    sequence: 4,
    subject: (ref) => `NEW WORK ORDER - ${ref} - Temporary Fence Make Safe`,
    body: (ref) => [
      "A new temporary-fencing make-safe has been assigned.",
      `Work Order Number: ${ref}`,
      "Client: Synthetic Homeowner Delta",
      "Mobile: 0491 570 158",
      "Site Address: 56 Test Pattern Crescent, Wangara WA 6065",
      "Scope of Works: Supply and install temporary fencing to the damaged boundary. Photograph installation and leave the site secure.",
      "Reply To: ses@secureworkswa.com.au",
    ],
    pdf: true,
    expected: {
      carded: true,
      relation: "root",
      family: "temp_fence_makesafe",
      portalRoles: [],
    },
  },
  {
    id: "reattend",
    kind: "reattendance",
    sequence: 1,
    subject: (ref) => `RE-ATTEND REQUIRED - ${ref} - Access now available`,
    body: (ref) => [
      "Please re-attend the earlier synthetic work order.",
      `Work Order Number: ${ref}`,
      "Client: Synthetic Homeowner Alpha",
      "Mobile: 0491 570 006",
      "Site Address: 14 Test Pattern Avenue, Balcatta WA 6021",
      "Updated Scope of Works: Return to site and replace the temporary tarp after high winds.",
      "Reply To: ses@secureworkswa.com.au",
    ],
    pdf: true,
    expected: {
      carded: true,
      relation: "reopen_of",
      family: "general_makesafe",
      portalRoles: [],
    },
  },
  {
    id: "correction",
    kind: "correction",
    sequence: 2,
    subject: (ref) => `NEW WORK ORDER - ${ref} - Corrected Report`,
    body: (ref) => [
      "This corrected work order supersedes the earlier synthetic instruction.",
      `Work Order Number: ${ref}`,
      "Client: Synthetic Homeowner Bravo",
      "Mobile: 0491 570 156",
      "Site Address: 28 Test Pattern Road, Osborne Park WA 6017",
      "Updated Scope of Works: Use the corrected portal roof-report instruction.",
      "Roof Report: https://synthetic.invalid/prime/roof-report-revised",
      "Reply To: ses@secureworkswa.com.au",
    ],
    pdf: true,
    expected: {
      carded: true,
      relation: "revision_of",
      family: "roof_report",
      portalRoles: ["roof_report"],
    },
  },
  {
    id: "junk",
    kind: "accounted_non_work",
    sequence: 7,
    subject: (ref) => `RE: ${ref} - Thanks, noted`,
    body: (_ref) => [
      "Thanks, noted.",
      "No action is required and this message contains no new work instruction.",
      "Reply To: ses@secureworkswa.com.au",
    ],
    pdf: false,
    expected: {
      carded: false,
      relation: "none",
      family: null,
      portalRoles: [],
    },
  },
];

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(
    ")",
    "\\)",
  );
}

function wrapPdfLine(value: string, width = 78): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width || !current) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export function renderFixturePdf(lines: readonly string[]): Uint8Array {
  const wrapped = lines.flatMap((line) => wrapPdfLine(line));
  const body = wrapped.map((line, index) =>
    `${index ? "0 -18 Td " : ""}(${escapePdfText(line)}) Tj`
  ).join("\n");
  const stream = `BT\n/F1 11 Tf\n45 790 Td\n${body}\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${ascii(stream).byteLength} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n% SecureWorks synthetic live-fire\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(ascii(pdf).byteLength);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = ascii(pdf).byteLength;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return ascii(pdf);
}

function refFor(runId: string, sequence: number): string {
  const compact = runId.replaceAll("-", "").slice(0, 12).toUpperCase();
  return `SYNTHLIVE-${compact}-${String(sequence).padStart(3, "0")}`;
}

function html(lines: readonly string[], token: string, marker: string): string {
  return [
    `<p><strong>${marker}</strong></p>`,
    `<p>${token}</p>`,
    "<p>Builder: SYNTHETIC LIVE-FIRE BUILDER - TEST ONLY</p>",
    "<p>Builder identity domain: synthetic-livefire.invalid</p>",
    ...lines.map((line) => `<p>${line}</p>`),
    "<p><strong>TEST ONLY — NO REAL CLIENT, BUILDER, INSURER OR SITE.</strong></p>",
  ].join("\n");
}

export async function buildFixtureRun(input: {
  runId: string;
  expiresAtMs: number;
  secret: string;
}): Promise<FixtureRun> {
  const marker = `SWG-SES-LIVEFIRE-TEST-ONLY-${input.runId.toUpperCase()}`;
  const fixtures: SyntheticFixture[] = [];
  for (const definition of DEFINITIONS) {
    const ref = refFor(input.runId, definition.sequence);
    const token = await signSyntheticLivefireMarker({
      runId: input.runId,
      fixtureId: definition.id,
      ref,
      expiresAtMs: input.expiresAtMs,
      secret: input.secret,
    });
    const lines = definition.body(ref);
    const subject = `[${marker}] [FIXTURE:${definition.id}] ${
      definition.subject(ref)
    }`;
    fixtures.push({
      id: definition.id,
      kind: definition.kind,
      ref,
      subject,
      htmlBody: html(lines, token, marker),
      attachment: definition.pdf
        ? {
          name: `${marker}-${definition.id}.pdf`,
          contentType: "application/pdf",
          bytes: renderFixturePdf([
            marker,
            "SYNTHETIC LIVE-FIRE BUILDER WORK ORDER",
            `Fixture: ${definition.id}`,
            ...lines,
            "TEST ONLY - NO REAL CLIENT, BUILDER, INSURER OR SITE.",
          ]),
        }
        : null,
      expected: definition.expected,
    });
  }
  return {
    runId: input.runId,
    marker,
    sender: SYNTHETIC_LIVEFIRE_SENDER,
    mailbox: SYNTHETIC_LIVEFIRE_MAILBOX,
    expiresAtMs: input.expiresAtMs,
    fixtures,
  };
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

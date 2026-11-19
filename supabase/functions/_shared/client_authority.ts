// ════════════════════════════════════════════════════════════
// Client authority and acknowledgement for restoration works
//
// The office (ops-api client_authority_create) opens one on a job and gets a
// link; the link is texted to the property owner; the owner reads it on their
// phone, types their name and signs (client-authority edge function, public,
// token only). The signed copy is a PDF filed on the job with the signature,
// the wording version and its hash, the time, the IP address and the browser.
//
// Storage: one job_documents row, type 'other', office only, with
// metadata.client_authority 'pending' or 'signed'. The link token lives in
// metadata.authority_token, never in share_token (that column is the quote
// view's, and send-quote would answer it).
//
// WORDING_V1 is a DRAFT written by Claude from common restoration authorities.
// Marnin has not approved it and no lawyer has checked it. Change the text by
// adding a new version; never edit a version that has been signed.
// ════════════════════════════════════════════════════════════

export const CLIENT_AUTHORITY_DOC_KIND = "client_authority";
export const CLIENT_AUTHORITY_PAGE = "https://secureworks-group.github.io/secureworks-ux/authority.html";
export const CLIENT_AUTHORITY_LINK_DAYS = 30;

export interface AuthorityWording {
  version: string;
  title: string;
  intro: string;
  clauses: Array<{ heading: string; text: string }>;
  declaration: string;
}

export const WORDING_V1: AuthorityWording = {
  version: "restoration-authority-v1-draft",
  title: "Authority to proceed and acknowledgement: restoration works",
  intro:
    "SecureWorks Group Pty Ltd (ABN 64 689 223 416) has been engaged by your builder or insurer to carry out restoration works at the property named above. Please read this and sign it before we start.",
  clauses: [
    {
      heading: "1. Authority to start works",
      text:
        "I am the owner of the property, or I am authorised by the owner, and I give SecureWorks and its workers permission to enter the property and carry out the restoration works instructed by the builder or insurer. These may include moisture testing, moving furniture, lifting floor coverings, removing wall linings, skirting and other materials that are wet or damaged, setting up and checking drying equipment, and removing and disposing of waste.",
    },
    {
      heading: "2. Existing and hidden conditions",
      text:
        "I understand that removing linings, floor coverings and fixtures can reveal conditions that already existed or could not be seen before the works, such as mould, rot, rust, termite damage, earlier leaks, faulty plumbing or wiring, or asbestos. SecureWorks is not responsible for these conditions or for repairing them unless they are part of the approved works. If asbestos or another hazard is suspected, works in that area will stop until it has been tested and dealt with safely, which may cause delay and extra cost.",
    },
    {
      heading: "3. Removal of materials",
      text:
        "Materials that are wet, damaged or need to come out for drying may not be able to be reused. I understand that putting things back (reinstatement), such as new linings, painting, flooring and tiling, is not part of these works unless it is listed in the approved scope.",
    },
    {
      heading: "4. Drying equipment and power",
      text:
        "I agree to drying equipment being placed and run at the property for as long as is needed to dry it, and to it using the property's power supply at my cost. I will not switch off, move or cover the equipment unless SecureWorks agrees, and I will tell SecureWorks straight away if it stops, trips the power or causes a problem. I will give reasonable access for moisture check-ups and for collecting the equipment. I will take reasonable care of the equipment while it is at the property.",
    },
    {
      heading: "5. Excess and extra work",
      text:
        "I understand that any insurance excess is payable by me under my policy and is not part of these works. Any work I ask for that is outside the scope approved by the builder or insurer will be quoted separately and paid for by me before it is carried out.",
    },
    {
      heading: "6. Damage and responsibility",
      text:
        "SecureWorks will take reasonable care of the property and its contents during the works. SecureWorks is not responsible for loss or damage that was caused by the original event, that existed before the works, or that results from the conditions described in clause 2, except where caused by its own negligence. Nothing in this document limits any rights I have under the Australian Consumer Law.",
    },
    {
      heading: "7. Valuables and access",
      text:
        "I will remove or secure valuables, fragile items and personal belongings from the work areas, and keep children and pets away from the work areas and the drying equipment.",
    },
  ],
  declaration:
    "By typing my name and signing below, I confirm that I have read and understood this document, that I am the owner of the property or authorised to sign for the owner, and that I agree to it.",
};

export const AUTHORITY_WORDINGS: Record<string, AuthorityWording> = {
  [WORDING_V1.version]: WORDING_V1,
};
export const CURRENT_AUTHORITY_WORDING = WORDING_V1;

export function wordingText(w: AuthorityWording): string {
  return [w.title, w.intro, ...w.clauses.map((c) => `${c.heading}\n${c.text}`), w.declaration].join("\n\n");
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, URL safe. The only thing that unlocks a pending authority. */
export function newAuthorityToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function authorityLink(token: string): string {
  return `${CLIENT_AUTHORITY_PAGE}?t=${encodeURIComponent(token)}`;
}

const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;

export function decodeSignaturePng(dataUrl: unknown): Uint8Array | null {
  const m = typeof dataUrl === "string" ? PNG_DATA_URL.exec(dataUrl.trim()) : null;
  if (!m) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length < 200 || bytes.length > 600_000) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  return bytes;
}

export interface SignedAuthorityFacts {
  job_number: string;
  site_address: string;
  builder_reference: string | null;
  signer_name: string;
  signer_phone: string | null;
  signed_at_iso: string;
  signed_at_perth: string;
  ip: string | null;
  user_agent: string | null;
  wording: AuthorityWording;
  wording_sha256: string;
  signature_png: Uint8Array;
}

function perthTime(iso: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Perth", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso)) + " (Perth time)";
}

export function perthStamp(iso: string): string {
  return perthTime(iso);
}

/** The signed copy: the full wording, the signature, and the record of who signed, when and from where. */
export async function renderSignedAuthorityPdf(f: SignedAuthorityFacts): Promise<Uint8Array> {
  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const W = 210, M = 18, TW = W - 2 * M;
  let y = 18;
  const NAVY: [number, number, number] = [36, 51, 61];
  const ORANGE: [number, number, number] = [232, 100, 44];
  const ensure = (h: number) => {
    if (y + h > 280) { doc.addPage(); y = 18; }
  };
  doc.setFillColor(...NAVY); doc.rect(M, y, TW, 9, "F");
  doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  doc.text("SecureWorks Group", M + 3, y + 6);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8);
  doc.text("ABN 64 689 223 416  |  admin@secureworkswa.com.au", W - M - 3, y + 6, { align: "right" });
  doc.setFillColor(...ORANGE); doc.rect(M, y + 9, TW, 0.8, "F");
  y += 16;
  doc.setTextColor(...NAVY); doc.setFont("helvetica", "bold"); doc.setFontSize(13);
  for (const line of doc.splitTextToSize(f.wording.title, TW)) { doc.text(line, M, y); y += 6; }
  y += 1;
  doc.setFontSize(9); doc.setFont("helvetica", "normal"); doc.setTextColor(40, 40, 40);
  const facts: Array<[string, string]> = [
    ["Job", f.job_number],
    ["Property", f.site_address],
    ...(f.builder_reference ? [["Builder / claim reference", f.builder_reference] as [string, string]] : []),
  ];
  for (const [k, v] of facts) { doc.setFont("helvetica", "bold"); doc.text(`${k}:`, M, y); doc.setFont("helvetica", "normal"); doc.text(v, M + 45, y); y += 5; }
  y += 2;
  const para = (text: string, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    for (const line of doc.splitTextToSize(text, TW)) { ensure(5); doc.text(line, M, y); y += 4.4; }
  };
  para(f.wording.intro); y += 2;
  for (const c of f.wording.clauses) { ensure(10); para(c.heading, true); para(c.text); y += 2; }
  para(f.wording.declaration, true); y += 4;

  ensure(62);
  doc.setDrawColor(...NAVY); doc.setLineWidth(0.3); doc.rect(M, y, TW, 58);
  doc.setFont("helvetica", "bold"); doc.text("Signed", M + 3, y + 6);
  doc.setFont("helvetica", "normal");
  doc.text(`Name: ${f.signer_name}`, M + 3, y + 12);
  doc.text(`Signed: ${f.signed_at_perth}`, M + 3, y + 17);
  doc.addImage(f.signature_png, "PNG", M + 3, y + 20, 70, 26);
  doc.setFontSize(7); doc.setTextColor(110, 110, 110);
  const rec = [
    `Signed electronically at ${f.signed_at_iso} (UTC) from IP ${f.ip || "not recorded"}${f.signer_phone ? `, link sent to ${f.signer_phone}` : ""}.`,
    `Browser: ${(f.user_agent || "not recorded").slice(0, 160)}`,
    `Wording ${f.wording.version}, SHA-256 ${f.wording_sha256}`,
  ];
  let ry = y + 49;
  for (const r of rec) for (const line of doc.splitTextToSize(r, TW - 6)) { doc.text(line, M + 3, ry); ry += 3; }
  return new Uint8Array(doc.output("arraybuffer"));
}

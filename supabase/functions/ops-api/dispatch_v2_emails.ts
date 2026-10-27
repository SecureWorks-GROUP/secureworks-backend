// deno-lint-ignore-file no-explicit-any
// Dispatch v2 (slices 5 and 6): the rules for supplier order emails, with no
// database and no outside call, so every rule here is tested on its own.
// Contract: docs/dispatch-v2-emails-contract.md. The actions that use these
// rules: dispatch_v2_store.ts.
//
// The email is the wiki template
// (secureworks-wiki/harness/ops/skills/secureworks-material-ordering/
// references/material-order-template.md), exactly:
//
//   Hi Team, could we please order the following for delivery:
//
//   Date: 4 November 2026
//   Address: 12 Example Street, Clarkson
//   Contact: 0400 000 000 (Jeremy)
//
//   Materials Needed:
//
//   1. 14 x 1800H standard width panels with 2400H posts
//   Profile: Neetascreen
//   Colour: Monument
//
//   2. 4 x bags of quickset
//
//   3. Fixings, Post Caps and Screws as necessary
//
//
//   Please confirm when you can, thank you.
//
// Subject "Material Order Ref SWF-xxxxx". No sign-off, no PO number, no
// prices, no internal notes. The job number is in the subject only.

// Every supplier order email goes out from this mailbox, through Outlook.
export const DISPATCH_V2_FROM_MAILBOX = "admin@secureworkswa.com.au";
// A test send goes only here.
export const DISPATCH_V2_TEST_TO = "admin@secureworkswa.com.au";

// The team mailbox copied on every order, by job type (Shaun, 23 Oct 2026).
// Decking is not decided: it is treated like patio until Shaun says
// otherwise, and the answer says so (team_cc_open).
const TEAM_CC: Record<string, string> = {
  fencing: "fencing@secureworkswa.com.au",
  patio: "patios@secureworkswa.com.au",
  repair: "ses@secureworkswa.com.au",
  decking: "patios@secureworkswa.com.au",
};

export type DispatchV2TeamCc = {
  email: string | null;
  // Set when the rule for this job type is not decided yet.
  open_question: string | null;
};

export function dispatchV2TeamCc(workType: unknown): DispatchV2TeamCc {
  const type = String(workType ?? "");
  const email = TEAM_CC[type] ?? null;
  if (type === "decking") {
    return {
      email,
      open_question:
        "Decking orders copy patios@ for now. Shaun has not decided the decking team mailbox.",
    };
  }
  if (!email) {
    return {
      email: null,
      open_question:
        `No team mailbox is set for ${
          type || "this"
        } jobs. Add one to CC by hand if needed.`,
    };
  }
  return { email, open_question: null };
}

// The two fencing standing lines, last on the main supplier's email only.
export const DISPATCH_V2_STANDING_LINES = [
  "4 x bags of quickset",
  "Fixings, Post Caps and Screws as necessary",
] as const;

export function dispatchV2StandingLinesApply(
  workType: unknown,
  isMainSupplier: boolean,
): boolean {
  return workType === "fencing" && isMainSupplier === true;
}

// ── The main supplier ───────────────────────────────────────────────────────

// A box holds the panels when one of its lines names panels or sheets of
// fencing (the template's own panel line, or the scope's "Colorbond fence
// sheets").
const PANEL_RE = /\bpanels?\b|\bfence sheets?\b|\binfill sheets?\b/i;

export function dispatchV2LineIsPanel(line: any): boolean {
  return PANEL_RE.test(String(line?.description ?? ""));
}

// The job's main supplier: the ticked box if there is one, else the first box
// (by position) holding the panels, else the first box. Null with no box.
export function dispatchV2MainSupplierId(
  boxes: { supplier_id: string; position?: number; is_main_supplier?: boolean }[],
  lines: any[],
): string | null {
  const ordered = [...(Array.isArray(boxes) ? boxes : [])].sort((a, b) =>
    (Number(a.position) || 0) - (Number(b.position) || 0)
  );
  if (ordered.length === 0) return null;
  const ticked = ordered.find((box) => box.is_main_supplier === true);
  if (ticked) return String(ticked.supplier_id);
  const withPanels = ordered.find((box) =>
    (Array.isArray(lines) ? lines : []).some((line) =>
      String(line?.supplier_id ?? "") === String(box.supplier_id) &&
      dispatchV2LineIsPanel(line)
    )
  );
  return String((withPanels ?? ordered[0]).supplier_id);
}

// ── Text pieces ─────────────────────────────────────────────────────────────

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// "2026-11-04" -> "4 November 2026". Anything that is not a real calendar
// date answers null.
export function dispatchV2DeliveryDateText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function isDispatchV2Date(value: unknown): value is string {
  return dispatchV2DeliveryDateText(value) !== null;
}

// The site address as stored, with the suburb added when the address does not
// already name it.
export function dispatchV2AddressText(job: any): string {
  const address = cleanLine(job?.site_address);
  const suburb = cleanLine(job?.site_suburb);
  if (!address) return suburb;
  if (!suburb || address.toLowerCase().includes(suburb.toLowerCase())) {
    return address;
  }
  return `${address}, ${suburb}`;
}

// "phone (First name)", as the template asks. Either part may be missing.
export function dispatchV2ContactText(job: any): string {
  const phone = cleanLine(job?.client_phone);
  const firstName = cleanLine(job?.client_name).split(" ")[0] || "";
  if (phone && firstName) return `${phone} (${firstName})`;
  return phone || (firstName ? `(${firstName})` : "");
}

function cleanLine(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/\s+/g, " ").trim();
}

// No long dashes in supplier copy (the house rule): a long dash becomes a
// comma, as the scope suggestion already does.
export function dispatchV2NoLongDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ");
}

function formatQuantity(quantity: number): string {
  return String(Math.round(quantity * 1000) / 1000);
}

// One numbered item's text, without its number: the first line is
// "qty unit x description" (or the description alone with no quantity), then
// the detail, Profile and Colour lines when set.
export function dispatchV2LineText(line: any): string {
  const description = cleanLine(line?.description);
  const quantity = typeof line?.quantity === "number" &&
      Number.isFinite(line.quantity)
    ? line.quantity
    : null;
  const unit = cleanLine(line?.unit);
  const head = quantity === null
    ? description
    : `${formatQuantity(quantity)}${unit ? ` ${unit}` : ""} x ${description}`;
  const extra: string[] = [];
  const detail = typeof line?.detail === "string" ? line.detail : "";
  for (const part of detail.split(/\r?\n/)) {
    const text = cleanLine(part);
    if (text) extra.push(text);
  }
  const profile = cleanLine(line?.profile);
  const colour = cleanLine(line?.colour);
  if (profile) extra.push(`Profile: ${profile}`);
  if (colour) extra.push(`Colour: ${colour}`);
  return dispatchV2NoLongDashes([head, ...extra].join("\n"));
}

export function dispatchV2Subject(jobNumber: unknown): string {
  const number = cleanLine(jobNumber);
  return number ? `Material Order Ref ${number}` : "Material Order Ref";
}

// ── The body ────────────────────────────────────────────────────────────────

export type DispatchV2BuiltLine = {
  line_id: string | null;
  updated_at: string | null;
  text: string;
  standing: boolean;
};

export type DispatchV2Built = {
  subject: string;
  body_text: string;
  lines: DispatchV2BuiltLine[];
  standing_lines_included: boolean;
  // Which of Date / Address / Contact came out empty. A send is refused while
  // any is still empty in the body.
  missing: ("date" | "address" | "contact")[];
};

export function dispatchV2BuildEmail(input: {
  job: any;
  workType: string;
  isMainSupplier: boolean;
  lines: any[];
  deliveryDate: string | null;
}): DispatchV2Built {
  const dateText = dispatchV2DeliveryDateText(input.deliveryDate) ?? "";
  const address = dispatchV2AddressText(input.job);
  const contact = dispatchV2ContactText(input.job);
  const built: DispatchV2BuiltLine[] = (input.lines || []).map((line) => ({
    line_id: line?.id ? String(line.id) : null,
    updated_at: line?.updated_at ? String(line.updated_at) : null,
    text: dispatchV2LineText(line),
    standing: false,
  })).filter((line) => line.text);
  const standing = dispatchV2StandingLinesApply(
    input.workType,
    input.isMainSupplier,
  );
  if (standing) {
    for (const text of DISPATCH_V2_STANDING_LINES) {
      built.push({ line_id: null, updated_at: null, text, standing: true });
    }
  }
  const numbered = built.map((line, index) => `${index + 1}. ${line.text}`);
  const body = [
    "Hi Team, could we please order the following for delivery:",
    "",
    `Date: ${dateText}`.trimEnd(),
    `Address: ${address}`.trimEnd(),
    `Contact: ${contact}`.trimEnd(),
    "",
    "Materials Needed:",
    "",
    numbered.join("\n\n"),
    "",
    "",
    "Please confirm when you can, thank you.",
  ].join("\n");
  const missing: DispatchV2Built["missing"] = [];
  if (!dateText) missing.push("date");
  if (!address) missing.push("address");
  if (!contact) missing.push("contact");
  return {
    subject: dispatchV2Subject(input.job?.job_number),
    body_text: body,
    lines: built,
    standing_lines_included: standing,
    missing,
  };
}

// Which of the Date / Address / Contact lines are still empty in a body as
// it will be sent (after any edit by hand). A line that was removed by hand
// counts as filled: the person chose to leave it out.
export function dispatchV2EmptyDetailLines(bodyText: string): string[] {
  const empty: string[] = [];
  for (const label of ["Date", "Address", "Contact"]) {
    const re = new RegExp(`^${label}:[ \\t]*$`, "m");
    if (re.test(bodyText)) empty.push(label.toLowerCase());
  }
  return empty;
}

// The plain-text body as the HTML Outlook sends: every character escaped,
// every line break kept. Nothing is added (no signature: the template has no
// sign-off).
export function dispatchV2BodyHtml(bodyText: string): string {
  const escaped = String(bodyText)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${
    escaped.replace(/\r?\n/g, "<br>")
  }</div>`;
}

// A test copy: the same email, clearly marked, to admin@ only. The real To
// and CC are written at the top so the test shows where the order would go.
export function dispatchV2TestEmail(input: {
  subject: string;
  bodyText: string;
  to: string[];
  cc: string[];
}): { subject: string; body_text: string } {
  const header = [
    "TEST ONLY. This copy went only to admin@secureworkswa.com.au. Nothing was sent to the supplier.",
    `The real email goes to: ${input.to.join(", ") || "(no To address)"}`,
    `CC: ${input.cc.join(", ") || "(none)"}`,
    "",
    "----------",
    "",
  ].join("\n");
  return {
    subject: `TEST ONLY: ${input.subject}`,
    body_text: `${header}${input.bodyText}`,
  };
}

// ── Addresses ───────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export function isDispatchV2Email(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

// A list of addresses from the screen: an array of strings, each trimmed and
// lower-cased, repeats dropped. Anything that is not an address is refused,
// never silently dropped.
export function cleanDispatchV2EmailList(
  value: unknown,
  field: string,
  { min, max }: { min: number; max: number },
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${field} must be a list of email addresses` };
  }
  const out: string[] = [];
  for (const item of value) {
    if (!isDispatchV2Email(item)) {
      return {
        ok: false,
        error: `${field} has something that is not an email address: ${
          String(item).slice(0, 80)
        }`,
      };
    }
    const email = item.trim().toLowerCase();
    if (!out.includes(email)) out.push(email);
  }
  if (out.length < min || out.length > max) {
    return {
      ok: false,
      error: min > 0
        ? `${field} needs ${min} to ${max} addresses`
        : `${field} takes at most ${max} addresses`,
    };
  }
  return { ok: true, value: out };
}

// The CC a held email starts with: the supplier's own CC, then the team
// mailbox, repeats dropped, never an address already in To.
export function dispatchV2DefaultCc(
  supplierCc: string[],
  teamCc: string | null,
  to: string[],
): string[] {
  const out: string[] = [];
  for (const email of [...(supplierCc || []), ...(teamCc ? [teamCc] : [])]) {
    const clean = String(email).trim().toLowerCase();
    if (clean && !to.includes(clean) && !out.includes(clean)) out.push(clean);
  }
  return out;
}

// ── The scope suggestion for the draft list ─────────────────────────────────

// What never goes on supplier copy (the template's exclusions): calculated
// concrete, tek screws, removal, labour, delivery fees.
const EXCLUDED_SUGGESTION_RE =
  /^concrete (bags|footings)|tek screw|removal|labour|delivery/i;

export function dispatchV2SuggestionAllowed(description: unknown): boolean {
  return !EXCLUDED_SUGGESTION_RE.test(String(description ?? ""));
}

// The draft list can be filled from the scope on a fencing or patio job that
// has no line yet.
export function dispatchV2CanSuggest(
  workType: unknown,
  lineCount: number,
): boolean {
  return (workType === "fencing" || workType === "patio") && lineCount === 0;
}

// ── Photos ──────────────────────────────────────────────────────────────────

// Under Outlook's 3 MB per attachment, with room to spare.
export const DISPATCH_V2_PHOTO_MAX_BYTES = 3_000_000;
export const DISPATCH_V2_PHOTOS_PER_EMAIL_MAX = 3;
export const DISPATCH_V2_PHOTOS_PER_JOB_MAX = 20;
export const DISPATCH_V2_PHOTO_BUCKET = "dispatch-material-photos";
export const DISPATCH_V2_PHOTO_LINK_SECONDS = 600;

export type DispatchV2PhotoCheck =
  | { ok: true; bytes: Uint8Array; contentType: string; extension: string }
  | { ok: false; code: string; error: string; size_bytes?: number };

// The photo the screen sends: base64 bytes of a JPEG, PNG or WebP under
// 3,000,000 bytes. The kind is read from the bytes themselves, not the name.
// A bigger photo is refused with its size: the screen shrinks photos before
// upload, so a refusal here means the shrink did not run.
export function dispatchV2CheckPhoto(base64: unknown): DispatchV2PhotoCheck {
  if (typeof base64 !== "string" || !base64.trim()) {
    return { ok: false, code: "invalid_request", error: "data_base64 required" };
  }
  const clean = base64.trim().replace(/^data:[^;,]+;base64,/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    return {
      ok: false,
      code: "invalid_request",
      error: "data_base64 is not valid base64",
    };
  }
  // Size first, from the base64 length, so a huge upload is never decoded.
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const size = (clean.length / 4) * 3 - padding;
  if (size > DISPATCH_V2_PHOTO_MAX_BYTES) {
    return {
      ok: false,
      code: "photo_too_large",
      error: `This photo is ${
        (size / 1_000_000).toFixed(1)
      } MB. Photos must be under 3 MB to go with an Outlook email. Shrink it and try again.`,
      size_bytes: size,
    };
  }
  if (size < 1) {
    return { ok: false, code: "invalid_request", error: "The photo is empty" };
  }
  let bytes: Uint8Array;
  try {
    const raw = atob(clean);
    bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  } catch {
    return {
      ok: false,
      code: "invalid_request",
      error: "data_base64 is not valid base64",
    };
  }
  const kind = photoKind(bytes);
  if (!kind) {
    return {
      ok: false,
      code: "photo_type_not_allowed",
      error: "Only JPEG, PNG or WebP photos can be attached",
    };
  }
  return { ok: true, bytes, ...kind };
}

function photoKind(
  bytes: Uint8Array,
): { contentType: string; extension: string } | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { contentType: "image/png", extension: "png" };
  }
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.slice(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

// A file name safe to store and to attach: letters, digits, dot, dash and
// underscore, at most 120 characters, ending in the photo's real kind.
export function dispatchV2PhotoFileName(
  value: unknown,
  extension: string,
): string {
  const base = String(value ?? "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "photo";
  return `${base}.${extension}`;
}

export function dispatchV2BytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function dispatchV2Sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ── Lines on an email ───────────────────────────────────────────────────────

// The lines that go on a supplier box's email: under that supplier, not In
// stock, not already sent on an email, and not on a v1 purchase order.
export function dispatchV2OrderableLines(
  lines: any[],
  supplierId: string,
): any[] {
  return (Array.isArray(lines) ? lines : [])
    .filter((line) =>
      String(line?.supplier_id ?? "") === supplierId &&
      line?.status !== "in_stock" &&
      !line?.dispatch_order_email_id &&
      !line?.purchase_order_id
    )
    .sort((a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0));
}

// Do the box's lines still match the lines a held email was built from? Same
// ids, same order and the same updated_at on each.
export function dispatchV2SameLines(
  snapshot: any[],
  current: any[],
): boolean {
  const built = (Array.isArray(snapshot) ? snapshot : []).filter((line) =>
    line?.line_id
  );
  if (built.length !== current.length) return false;
  return built.every((line, index) =>
    String(line.line_id) === String(current[index]?.id) &&
    sameInstant(line.updated_at, current[index]?.updated_at)
  );
}

function sameInstant(a: unknown, b: unknown): boolean {
  const left = Date.parse(String(a ?? ""));
  const right = Date.parse(String(b ?? ""));
  return Number.isFinite(left) && left === right;
}

// A send left in `sending` this long with no answer is treated as unknown.
export const DISPATCH_V2_STALE_SENDING_MS = 2 * 60 * 1000;

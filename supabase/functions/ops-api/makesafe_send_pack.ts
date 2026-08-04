// MakeSafe Reporting Autopilot (Wave 2) -- pure, testable building blocks for
// the makesafe_send_pack resumable state machine. NO network, NO Supabase, NO
// Xero, NO jsPDF here. The orchestration (index.ts:makesafeSendPack) imports
// these and supplies the live clients.
//
// MONEY/COMMS critical. Every gate here FAILS CLOSED: an ambiguous or incomplete
// input yields "do not send / do not authorise".

// ── Privileged-caller auth gate (decision: scoped-routine-key-2026-06-17) ──
//
// send_pack authorises a Xero invoice and emails a builder. It is reachable by
// the PRIVILEGED caller classes only:
//   - authMode='api_key'  -> the master SW_API_KEY (the ops dashboard, which has
//                            NO per-user login) or the service-role key. PRIVILEGED.
//   - authMode='jwt'      -> a logged-in user; only role admin/owner is privileged.
//   - authMode='routine'  -> the LESSER MAKESAFE_ROUTINE_KEY held by the make-safe
//                            automation. Drafts-only. REJECTED here (and centrally,
//                            via Sentinel Wave 0's ROUTINE_FORBIDDEN_ACTIONS,
//                            branch origin/sentinel/makesafe-wave0-hardening PR #179).
//
// The 'routine' class falls through to false because it is neither 'api_key' nor
// jwt admin/owner. Under main (where authMode is only 'api_key'|'jwt' and there is
// no 'routine' class yet) this predicate is identical in behaviour: dashboard
// api_key + admin/owner jwt are allowed. Belt-and-braces with the central deny-list.
export function sendPackAllowed(
  authMode: "api_key" | "jwt" | "routine",
  authUser: { role?: string } | null | undefined,
): boolean {
  return authMode === "api_key" ||
    (authMode === "jwt" &&
      (authUser?.role === "admin" || authUser?.role === "owner"));
}

// ── Marker idempotency — THE single detector (index.ts imports these; it keeps
//    no private copy, so the two sides can never drift). buildPackSentMarkerText
//    below is likewise the single canonical WRITER (main pack) — no other code
//    may emit a MAKESAFE_PACK_SENT marker in a shape of its own. ──
export const MAKESAFE_PACK_SENT_MAIN_PREFIX = "MAKESAFE_PACK_SENT | main";
// The canonical prefix, normalised the same way _normalizeMarkerText normalises a
// candidate note, so the tolerant comparison below is prefix-against-prefix.
const _MAIN_PREFIX_NORM = "makesafe_pack_sent | main";

// Normalise a note body for tolerant marker matching: lowercase, collapse the
// whitespace around every "|" to " | ", and any other whitespace run to a single
// space. This makes the canonical detector tolerant to the separator / spacing /
// case drift seen in hand-written and backfilled markers
// ("MAKESAFE_PACK_SENT|main", "MAKESAFE_PACK_SENT |  Main | ...") WITHOUT widening
// it to a different kind — "| photo" still never matches the "| main" prefix.
function _normalizeMarkerText(text: string): string {
  return String(text || "").trim().toLowerCase()
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ");
}

// Pull the note text out of a job_events row (tolerant to a JSON-string or object
// detail_json). Returns null when the row is not a note or carries no text.
function _eventNoteText(ev: any): string | null {
  if (!ev || String(ev.event_type) !== "note") return null;
  let dj = ev.detail_json;
  if (typeof dj === "string") {
    try {
      dj = JSON.parse(dj);
    } catch (_) {
      dj = { text: dj };
    }
  }
  const text = dj && typeof dj === "object" ? dj.text : null;
  return typeof text === "string" ? text : null;
}

// True if a note body IS (starts with) the canonical main-pack sent marker,
// tolerant to separator/spacing/case drift. This is the STRICT predicate the
// irreversible-action gates (send idempotency, resume-close, reset) rely on —
// only the real send marker (in any spacing) is send-proof for a money/comms
// action, never a freeform note.
export function packSentMainTextMatches(text: string | null | undefined): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  return _normalizeMarkerText(text).startsWith(_MAIN_PREFIX_NORM);
}

export function isPackSentMainEvent(ev: any): boolean {
  return packSentMainTextMatches(_eventNoteText(ev));
}

// ── Documented legacy pack-sent variant (SWMS-26832) — BOARD TRIAGE ONLY ──────
// A genuine bundled send historically recorded the covered sibling's send as a
// FREEFORM note with NO canonical "MAKESAFE_PACK_SENT | main" prefix. The anchor
// case is SWMS-26832 (MLB-26393, 2026-06-30), whose real 2026-06-30 note read:
//   "BUNDLED into SWMS-26837 temp-fence make-safe (one WO) - no separate
//    invoice; labour+report+SWMS covered under INV-0835. Sent to bunbury@ ..."
// The canonical detector never matched it, so the covered card showed a permanent
// FALSE OUTSTANDING-TO-SEND until a manual marker backfill. The board-triage map
// (buildPackSentMap) tolerates this documented shape so a bundled-covered card no
// longer re-surfaces as unsent. It is DELIBERATELY NOT accepted by the
// irreversible-action gates above — a freeform note is triage evidence, never
// send-proof for authorising/emailing/closing/resetting. A match REQUIRES BOTH a
// bundle-coverage phrase AND a Xero invoice token (INV-####), so an in-planning
// "bundle" note with no invoice can never count.
export const LEGACY_BUNDLED_COVERAGE_PHRASES = [
  "bundled under inv",
  "bundled into",
  "covered under inv",
  "covered by bundle",
  "bundled with",
] as const;
const _INV_TOKEN = /\binv-?\d{3,}\b/i;

export function isBundledCoverageSendNote(text: string | null | undefined): boolean {
  const t = String(text || "").toLowerCase();
  if (!t || !_INV_TOKEN.test(t)) return false;
  return LEGACY_BUNDLED_COVERAGE_PHRASES.some((p) => t.includes(p));
}

// BOARD-TRIAGE predicate: a job counts as "pack sent" for OUTSTANDING-TO-SEND
// purposes if it carries the canonical main marker OR the documented legacy
// bundled-coverage note (SWMS-26832). Used ONLY by buildPackSentMap — never by an
// irreversible-action gate.
export function isPackSentTriageEvent(ev: any): boolean {
  if (isPackSentMainEvent(ev)) return true;
  return isBundledCoverageSendNote(_eventNoteText(ev));
}

// True if any note row in the set carries the verified main-pack marker.
export function hasPackSentMainMarker(
  events: any[] | null | undefined,
): boolean {
  return (events || []).some((ev) => isPackSentMainEvent(ev));
}

// Build the marker text the send writes on success. Bakes the live invoice
// number at send time (the board's M3 resolver never trusts this number for
// resolution; it is a triage breadcrumb only -- see makesafe_marker_integrity).
export function buildPackSentMarkerText(args: {
  invoiceNumber: string | null | undefined;
  to: string;
  nowIso: string;
  messageId?: string | null;
}): string {
  return [
    MAKESAFE_PACK_SENT_MAIN_PREFIX,
    args.invoiceNumber || "?",
    `to=${args.to}`,
    args.nowIso,
    `msgid=${args.messageId || ""}`,
  ].join(" | ");
}

// ── Duplicate-invoice 3-tier resolver (TS port of
// create_makesafe_draft_invoice.py resolve_existing_invoice) ──
//
// Returns the single existing LIVE invoice that maps to the job, or null. A
// VOIDED/DELETED invoice NEVER blocks creation (it is ignored). Tiers, highest
// trust first:
//   job_id            -- invoice.job_id === job.id
//   reference         -- norm(invoice.reference) === norm(external_ref)
//   reference_substr  -- norm(external_ref) is a substring of norm(reference),
//                        external_ref >= 5 chars (short tokens cannot false-match)
const VOID_STATUSES = ["VOIDED", "DELETED"];

// Strips case + ALL whitespace AND hyphens so spaced/dashed/compact variants of
// the same ref collapse to one key ('AJBR 67713' == 'AJBR-67713' == 'AJBR67713'
// -> 'ajbr67713'), making the dup-resolver robust to hyphen/space variants
// (BLOCKER B pt2). The >=5-char substring tier still works on this normalised form.
export function normRef(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "");
}

export function isVoidStatus(status: unknown): boolean {
  return VOID_STATUSES.includes(String(status ?? "").toUpperCase());
}

// ── Same-ref / new-PO scoping (W3-H, Marnin's rule stated 2026-07-08) ──
// A builder can raise MULTIPLE work orders under ONE claim ref, each with its own PO number
// ("MLB-24732" then a follow-up "MLB-24732PO-55712"; two siblings "MLB-25898PO-55547" vs
// "MLB-25898PO-54817"). Marnin's rule: same builder ref + a DIFFERENT PO number = a NEW, separately
// invoiceable piece of work, so a sibling card's invoice must NOT block it. Identical full refs
// (a true re-send) and refs where the base matches but NEITHER side carries a distinguishing PO
// keep the strict per-ref block. Mirror of invoice_utils.py split_ref_po / _same_work_ref.
const _PO_TOKEN_RE = /po[-\s]?(\d+)/i;

export function splitRefPo(raw: unknown): { base: string; po: string | null } {
  const s = String(raw ?? "").trim();
  const m = s.match(_PO_TOKEN_RE);
  if (!m || m.index === undefined) return { base: normRef(s), po: null };
  // base = the builder-ref prefix (everything before the PO token), normalised like any ref; the
  // PO token attaches directly to the base with no separator ("...732PO-55712"), so locate it by
  // pattern, not by a delimiter.
  return { base: normRef(s.slice(0, m.index)), po: m[1] };
}

// True when a reference-tier candidate is the SAME piece of work as our card (still blocks); false
// ONLY when both refs share a base builder-ref but carry DIFFERENT PO numbers. Fail-closed: anything
// not confidently a different-PO sibling stays a block, preserving the strict per-ref guard.
export function sameWorkRef(ourRef: unknown, candRef: unknown): boolean {
  const o = splitRefPo(ourRef);
  const c = splitRefPo(candRef);
  if (o.base && c.base && o.base === c.base && o.po !== c.po) return false;
  return true;
}

export interface ExistingInvoiceHit {
  invoice_number: string | null;
  status: string | null;
  xero_invoice_id: string | null;
  sub_total?: number | null;
  total?: number | null;
  total_tax?: number | null;
  line_items?: unknown;
  match_method: "job_id" | "reference" | "reference_substring";
}

/**
 * Full live ACCREC set for the mandatory duplicate-invoice guard.
 * Paginated to completion (page 500) — never a recent ~50-row window.
 * Semantic twin of invoice_utils.fetch_all_invoices (skill scripts).
 */
export async function fetchAllAccrecInvoices(client: {
  from: (table: string) => any;
}): Promise<any[]> {
  const rows: any[] = [];
  const page = 500;
  let offset = 0;
  // Bounded loop — never spin forever even if the table is huge.
  for (let guard = 0; guard < 40; guard++) {
    const { data, error } = await client.from("xero_invoices")
      .select(
        "xero_invoice_id, invoice_number, reference, status, job_id, invoice_type, invoice_date, sub_total, total, total_tax, line_items, invoice_obligation_revision_id, ses_external_token",
      )
      .eq("invoice_type", "ACCREC")
      .order("invoice_date", { ascending: false })
      .range(offset, offset + page - 1);
    if (error) {
      throw new Error("dup-guard: xero_invoices scan failed: " + error.message);
    }
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < page) break;
    offset += page;
  }
  return rows;
}

export function resolveExistingInvoice(
  rows: any[] | null | undefined,
  jobId: string | null | undefined,
  externalRef: string | null | undefined,
): ExistingInvoiceHit | null {
  const all = rows || [];
  const liveHit = (cands: any[]): any | null => {
    const live = cands.filter((c) => !isVoidStatus(c?.status));
    return live.length ? live[0] : null;
  };
  const toHit = (
    r: any,
    method: ExistingInvoiceHit["match_method"],
  ): ExistingInvoiceHit => ({
    invoice_number: r?.invoice_number ?? null,
    status: r?.status ?? null,
    xero_invoice_id: r?.xero_invoice_id ?? null,
    sub_total: r?.sub_total ?? null,
    total: r?.total ?? null,
    total_tax: r?.total_tax ?? null,
    line_items: r?.line_items ?? null,
    match_method: method,
  });

  // Tier 1 (job_id) is our OWN card: a live invoice already on this job always blocks — a second
  // invoice on the same card is a true re-invoice, whatever the PO suffix. Only the reference tiers
  // below (which reach OTHER jobs' invoices) get the same-ref-new-PO scoping via sameWorkRef.
  if (jobId) {
    const byJob = all.filter((r) => r?.job_id && r.job_id === jobId);
    const hit = liveHit(byJob);
    if (hit) return toHit(hit, "job_id");
  }

  const nref = normRef(externalRef);
  if (!nref) return null;

  // Tier 2: exact normalised reference (a different-PO sibling never exact-matches; sameWorkRef is a
  // no-op here, applied for symmetry so the reference tiers read uniformly).
  const exact = all.filter((r) =>
    normRef(r?.reference) === nref && normRef(r?.reference) !== "" &&
    sameWorkRef(externalRef, r?.reference)
  );
  const exactHit = liveHit(exact);
  if (exactHit) return toHit(exactHit, "reference");

  // Tier 3: reference substring (>= 5 chars). A base ref ("MLB-24732") is a substring of a
  // PO-suffixed sibling's reference ("MLB-24732PO-55712"); sameWorkRef scopes that sibling out so it
  // does not block a genuinely separate piece of work.
  if (nref.length >= 5) {
    const sub = all.filter((r) => {
      const ir = normRef(r?.reference);
      return ir !== "" && ir.includes(nref) && sameWorkRef(externalRef, r?.reference);
    });
    const subHit = liveHit(sub);
    if (subHit) return toHit(subHit, "reference_substring");
  }
  return null;
}

// ── Client-send gate (TS port of check_client_send_gate.py:validate) ──
//
// Stricter than a draft validator. Run immediately before any live builder send.
// Any failure -> do not send. The process-confirmation checklist (client_send_gate
// object) from the Python is NOT re-required here: in the autopilot the human
// approval is the admin/owner JWT on send_pack, and the structural facts below
// (sender/cc/subject/attachments) are what the backend can actually verify.
export const MAKESAFE_ADMIN_FROM = "admin@secureworkswa.com.au";
export const MAKESAFE_CC = "ses@secureworkswa.com.au";
export const REVIEW_MARKERS = [
  "TEST",
  "ROUND",
  "DRAFT",
  "REVIEW",
  "INTERNAL",
  "PREVIEW",
];

export function splitEmails(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => splitEmails(v));
  if (typeof value !== "string") return [];
  return value.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
}

export function attachmentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (item && typeof item === "object" && (item as any).name) {
      names.push(String((item as any).name));
    } else if (typeof item === "string") {
      names.push(item.split("/").pop() || item);
    }
  }
  return names;
}

// Marker present as a whole token (not a substring of an unrelated word).
export function hasReviewMarker(name: string): string | null {
  const upper = name.toUpperCase();
  for (const marker of REVIEW_MARKERS) {
    const re = new RegExp(`(^|[^A-Z0-9])${marker}([^A-Z0-9]|$)`);
    if (re.test(upper)) return marker;
  }
  return null;
}

export function isReportPdf(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".pdf") &&
    (lower.includes("make safe report") || lower.includes("makesafe report"));
}

export function isXeroInvoicePdf(name: string): boolean {
  const lower = name.toLowerCase();
  const rejected = [
    "invoice line review",
    "line review",
    "local price",
    "price summary",
    "invoice_lines",
  ];
  return lower.endsWith(".pdf") &&
    lower.includes("xero") &&
    lower.includes("invoice") &&
    !rejected.some((t) => lower.includes(t));
}

export interface ClientSendPayload {
  from?: string;
  from_email?: string;
  to?: unknown;
  cc?: unknown;
  subject?: string;
  htmlBody?: string;
  html_body?: string;
  attachments?: unknown;
}

// ── Exact-recipient gate (BLOCKER C — money/comms, FAIL CLOSED) ──
//
// The previous gate only required CC to INCLUDE ses@; it did not enforce the To
// and did not reject EXTRA CCs (e.g. vanessa@ajs.build via special_instructions).
// This gate enforces the EXACT recipient set, SERVER-DERIVED (never trusting the
// UI body alone):
//   - To MUST equal the configured work-orders inbox (report_recipient) for the
//     job's builder. If no report_recipient is configured -> REJECT (cannot send
//     to the right place). If the body's To != the configured inbox -> REJECT.
//   - CC MUST equal EXACTLY [ses@secureworkswa.com.au]. Any extra address
//     (vanessa, anyone) or a missing ses@ -> REJECT.
//
// Returns [] when the recipient set is exactly correct; otherwise a list of hard
// failures. The caller MUST treat any non-empty result as a do-not-send stop.
export function checkExactRecipientGate(args: {
  configuredReportRecipient: string | null | undefined;
  to: unknown;
  cc: unknown;
}): string[] {
  const failures: string[] = [];

  const configured = String(args.configuredReportRecipient ?? "").trim()
    .toLowerCase();
  if (!configured) {
    failures.push(
      "no work-order recipient (report_recipient) configured for this builder; cannot send",
    );
  }

  const toList = splitEmails(args.to);
  if (toList.length === 0) {
    failures.push("to recipient is missing");
  } else if (toList.length > 1) {
    failures.push(
      `to must be exactly the configured work-orders inbox; got ${toList.length} recipients: ${
        toList.join(", ")
      }`,
    );
  } else if (configured && toList[0] !== configured) {
    failures.push(
      `to must equal the configured work-orders inbox '${configured}'; got '${
        toList[0]
      }'`,
    );
  }

  // CC MUST equal exactly [ses@]. Reject any extra (vanessa, etc.) or a miss.
  const ccList = splitEmails(args.cc);
  const extras = ccList.filter((c) => c !== MAKESAFE_CC);
  if (!ccList.includes(MAKESAFE_CC)) {
    failures.push(
      `cc must be exactly ${MAKESAFE_CC}; got ${
        ccList.length ? ccList.join(", ") : "<missing>"
      }`,
    );
  }
  if (extras.length > 0) {
    failures.push(
      `cc must be EXACTLY ${MAKESAFE_CC} only; rejected extra cc(s): ${
        extras.join(", ")
      }`,
    );
  }

  return failures;
}

// Returns [] when the payload is safe to send; otherwise a list of failure
// strings. Empty == PASS. The caller MUST treat any non-empty result as a hard
// stop (no send, no authorise).
export function checkClientSendGate(payload: ClientSendPayload): string[] {
  const failures: string[] = [];

  const fromEmail = String(payload.from || payload.from_email || "").trim()
    .toLowerCase();
  if (fromEmail !== MAKESAFE_ADMIN_FROM) {
    failures.push(
      `sender must be ${MAKESAFE_ADMIN_FROM}; got ${fromEmail || "<missing>"}`,
    );
  }

  if (splitEmails(payload.to).length === 0) {
    failures.push("to recipient is missing");
  }

  const cc = splitEmails(payload.cc);
  if (!cc.includes(MAKESAFE_CC)) {
    failures.push(`cc must include ${MAKESAFE_CC}`);
  }

  const subject = String(payload.subject || "").trim();
  if (!subject) {
    failures.push("subject is missing");
  } else {
    const marker = hasReviewMarker(subject);
    if (marker) {
      failures.push(
        `client subject contains review/test marker '${marker}': ${subject}`,
      );
    }
  }

  const html = String(payload.htmlBody || payload.html_body || "");
  if (!html.trim()) failures.push("html body is missing");

  const names = attachmentNames(payload.attachments);
  if (names.length < 2) {
    failures.push(
      "client send requires at least two separate PDF attachments: report and Xero invoice",
    );
  }
  const reportNames = names.filter((n) => isReportPdf(n));
  const invoiceNames = names.filter((n) => isXeroInvoicePdf(n));
  if (reportNames.length !== 1) {
    failures.push(
      `expected exactly one final make-safe report PDF attachment; got ${reportNames.length}`,
    );
  }
  if (invoiceNames.length !== 1) {
    failures.push(
      `expected exactly one actual Xero invoice PDF attachment; got ${invoiceNames.length}`,
    );
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".pdf")) {
      failures.push(`attachment must be a PDF for formal client send: ${name}`);
    }
    const marker = hasReviewMarker(name);
    if (marker) {
      failures.push(
        `client attachment filename contains review/test marker '${marker}': ${name}`,
      );
    }
  }
  return failures;
}

export function checkApprovedPhotoFollowupGate(
  approvedPhotos: unknown[],
): string[] {
  return Array.isArray(approvedPhotos) && approvedPhotos.length > 0 ? [] : [
    "approved photos are required before MakeSafe email send because the JPEG photo follow-up is mandatory",
  ];
}

// Report-type jobs (`roof_report`, `assessment_report`, etc.) are invoice-only:
// the builder's report lives on their portal, so SecureWorks must not require or
// send a generated make-safe report PDF. This gate shares the same sender,
// recipient, CC, subject/body, filename-marker and PDF checks as the standard
// client gate, but requires exactly one attachment: the actual Xero invoice PDF.
export function checkReportJobClientSendGate(
  payload: ClientSendPayload,
): string[] {
  const failures: string[] = [];

  const fromEmail = String(payload.from || payload.from_email || "").trim()
    .toLowerCase();
  if (fromEmail !== MAKESAFE_ADMIN_FROM) {
    failures.push(
      `sender must be ${MAKESAFE_ADMIN_FROM}; got ${fromEmail || "<missing>"}`,
    );
  }

  if (splitEmails(payload.to).length === 0) {
    failures.push("to recipient is missing");
  }

  const cc = splitEmails(payload.cc);
  if (!cc.includes(MAKESAFE_CC)) {
    failures.push(`cc must include ${MAKESAFE_CC}`);
  }

  const subject = String(payload.subject || "").trim();
  if (!subject) {
    failures.push("subject is missing");
  } else {
    const marker = hasReviewMarker(subject);
    if (marker) {
      failures.push(
        `client subject contains review/test marker '${marker}': ${subject}`,
      );
    }
  }

  const html = String(payload.htmlBody || payload.html_body || "");
  if (!html.trim()) failures.push("html body is missing");

  const names = attachmentNames(payload.attachments);
  if (names.length !== 1) {
    failures.push(
      "report-job client send requires exactly one PDF attachment: Xero invoice only",
    );
  }
  const reportNames = names.filter((n) => isReportPdf(n));
  const invoiceNames = names.filter((n) => isXeroInvoicePdf(n));
  if (reportNames.length !== 0) {
    failures.push(
      `report-job send must not include a SecureWorks make-safe report PDF; got ${reportNames.length}`,
    );
  }
  if (invoiceNames.length !== 1) {
    failures.push(
      `expected exactly one actual Xero invoice PDF attachment; got ${invoiceNames.length}`,
    );
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".pdf")) {
      failures.push(`attachment must be a PDF for formal client send: ${name}`);
    }
    const marker = hasReviewMarker(name);
    if (marker) {
      failures.push(
        `client attachment filename contains review/test marker '${marker}': ${name}`,
      );
    }
  }
  return failures;
}

// ── Sealed-release client-send gate kinds ────────────────────────────────────
//
// Skill / Captain backend release contract (2026-08-04):
//   AJS/AJBR: report_invoice + photo (ses@ on both)
//   MLB/others: report + photo + invoice (report/photo no cc; invoice finance@ only)
// Kind names match the skill table exactly — do not invent parallel aliases.

export const MAKESAFE_FINANCE_CC = "finance@secureworkswa.com.au";
export const AJS_INVOICE_TO = "workorders@ajs.build";

/** Route kinds from the skill backend release contract. */
export type SesClientSendRouteKind =
  | "report_invoice"
  | "report"
  | "photo"
  | "invoice";

/** @deprecated Use SesClientSendRouteKind — kept for one release of callers. */
export type SesReleaseClientSendGateKind =
  | SesClientSendRouteKind
  | "ajs_report_invoice" // alias → report_invoice
  | "ajs_photo" // alias → photo (AJS builder)
  | "universal_pack"
  | "universal_pack_with_swms"
  | "report_job_invoice_only";

export interface SesClientSendRouteContext {
  kind: SesClientSendRouteKind;
  /** AJS | AJBR | MLB | … — required for photo (cc rules differ). */
  builderKey?: string | null;
  /**
   * Explicit processing mailbox for report_invoice / invoice.
   * Missing → refuse (never silent inherit of a top-level to).
   */
  configuredInvoiceTo?: string | null;
  /** Bound work-order / photo participant mailbox when known. */
  configuredReportTo?: string | null;
  configuredPhotoTo?: string | null;
}

export function isPhotoAttachmentName(name: string): boolean {
  return /\.(jpe?g|png|heic|webp)$/i.test(name);
}

/** Raw camera dump names the skill refuses on the photo route (photo1, photo12…). */
export function isRawPhotoDumpName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() || name;
  const stem = base.replace(/\.[^.]+$/, "");
  return /^photo\d+$/i.test(stem) || /^img[_\s-]?\d+$/i.test(stem);
}

function isAjsBuilder(builderKey: unknown): boolean {
  const key = String(builderKey || "").trim().toUpperCase();
  return key === "AJS" || key === "AJBR";
}

function sharedEnvelopeFailures(payload: ClientSendPayload): string[] {
  const failures: string[] = [];
  const fromEmail = String(payload.from || payload.from_email || "").trim()
    .toLowerCase();
  if (fromEmail !== MAKESAFE_ADMIN_FROM) {
    failures.push(
      `sender must be ${MAKESAFE_ADMIN_FROM}; got ${fromEmail || "<missing>"}`,
    );
  }
  if (splitEmails(payload.to).length === 0) {
    failures.push("to recipient is missing");
  }
  const subject = String(payload.subject || "").trim();
  if (!subject) {
    failures.push("subject is missing");
  } else {
    const marker = hasReviewMarker(subject);
    if (marker) {
      failures.push(
        `client subject contains review/test marker '${marker}': ${subject}`,
      );
    }
  }
  const html = String(payload.htmlBody || payload.html_body || "");
  if (!html.trim()) {
    failures.push("html body is missing");
  } else {
    // Maverick / admin signature (or explicit suppression marker for tests).
    const hasSignature = /maverick/i.test(html) ||
      /data-secureworks-signature\s*=\s*["']maverick["']/i.test(html) ||
      /secureworks-signature-maverick/i.test(html);
    if (!hasSignature) {
      failures.push(
        "html body must include the Maverick HTML signature (or explicit suppression marker)",
      );
    }
  }
  const textBlob = `${subject}\n${html}`;
  if (/\bminimum\b/i.test(textBlob)) {
    failures.push(
      'client-facing copy must not contain the word "minimum"',
    );
  }
  return failures;
}

function attachmentMarkerFailures(names: string[]): string[] {
  const failures: string[] = [];
  for (const name of names) {
    const marker = hasReviewMarker(name);
    if (marker) {
      failures.push(
        `client attachment filename contains review/test marker '${marker}': ${name}`,
      );
    }
  }
  return failures;
}

function toIncludesConfigured(
  to: unknown,
  configured: string,
): boolean {
  const want = configured.trim().toLowerCase();
  if (!want) return false;
  return splitEmails(to).includes(want);
}

/**
 * AJS/AJBR `report_invoice`: combined final report + real Xero invoice PDF.
 * TO must include explicit invoice_to (workorders@ajs.build); CC must include ses@.
 */
export function checkReportInvoiceClientSendGate(
  payload: ClientSendPayload,
  ctx: Pick<SesClientSendRouteContext, "configuredInvoiceTo"> = {},
): string[] {
  const failures = sharedEnvelopeFailures(payload);
  const configured = String(ctx.configuredInvoiceTo || AJS_INVOICE_TO).trim()
    .toLowerCase();
  if (!configured) {
    failures.push(
      "missing explicit invoice_to for report_invoice; cannot silent-inherit top-level to",
    );
  } else if (!toIncludesConfigured(payload.to, configured)) {
    failures.push(
      `report_invoice TO must include explicit invoice_to '${configured}'; got ${
        splitEmails(payload.to).join(", ") || "<missing>"
      }`,
    );
  }
  const cc = splitEmails(payload.cc);
  if (!cc.includes(MAKESAFE_CC)) {
    failures.push(`report_invoice cc must include ${MAKESAFE_CC}`);
  }
  const names = attachmentNames(payload.attachments);
  const reportNames = names.filter((n) => isReportPdf(n));
  const invoiceNames = names.filter((n) => isXeroInvoicePdf(n));
  const photoBleed = names.filter((n) => isPhotoAttachmentName(n));
  if (reportNames.length !== 1) {
    failures.push(
      `report_invoice expected exactly one make-safe report PDF; got ${reportNames.length}`,
    );
  }
  if (invoiceNames.length !== 1) {
    failures.push(
      `report_invoice expected exactly one real Xero invoice PDF (not a summary); got ${invoiceNames.length}`,
    );
  }
  if (photoBleed.length > 0) {
    failures.push(
      `report_invoice must not attach photo images: ${photoBleed.join(", ")}`,
    );
  }
  for (const name of names) {
    if (
      !name.toLowerCase().endsWith(".pdf") && !isPhotoAttachmentName(name)
    ) {
      failures.push(`report_invoice unexpected attachment type: ${name}`);
    }
  }
  failures.push(...attachmentMarkerFailures(names));
  return failures;
}

/** @deprecated alias */
export const checkAjsReportInvoiceClientSendGate =
  checkReportInvoiceClientSendGate;

/**
 * MLB/universal `report`: work-order sender TO, **no CC**, report PDF only.
 */
export function checkMlbReportClientSendGate(
  payload: ClientSendPayload,
): string[] {
  const failures = sharedEnvelopeFailures(payload);
  const cc = splitEmails(payload.cc);
  if (cc.length > 0) {
    failures.push(
      `report route must have no cc; got ${cc.join(", ")}`,
    );
  }
  const names = attachmentNames(payload.attachments);
  const reportNames = names.filter((n) => isReportPdf(n));
  const invoiceNames = names.filter((n) => isXeroInvoicePdf(n));
  const photoBleed = names.filter((n) => isPhotoAttachmentName(n));
  if (reportNames.length !== 1) {
    failures.push(
      `report route expected exactly one make-safe report PDF; got ${reportNames.length}`,
    );
  }
  if (invoiceNames.length > 0) {
    failures.push("report route must not attach invoice PDFs");
  }
  if (photoBleed.length > 0) {
    failures.push("report route must not attach photo images");
  }
  failures.push(...attachmentMarkerFailures(names));
  return failures;
}

/**
 * `photo` route — builder-aware CC:
 *   AJS/AJBR: must include ses@
 *   MLB/others: must have no cc
 * Attachments: labelled images only; refuse PDF pack bleed and raw photoNN names.
 */
export function checkPhotoRouteClientSendGate(
  payload: ClientSendPayload,
  ctx: Pick<SesClientSendRouteContext, "builderKey" | "configuredPhotoTo"> = {},
): string[] {
  const failures = sharedEnvelopeFailures(payload);
  const ajs = isAjsBuilder(ctx.builderKey);
  const cc = splitEmails(payload.cc);
  if (ajs) {
    if (!cc.includes(MAKESAFE_CC)) {
      failures.push(`AJS photo route cc must include ${MAKESAFE_CC}`);
    }
  } else if (cc.length > 0) {
    failures.push(
      `photo route must have no cc for non-AJS builders; got ${cc.join(", ")}`,
    );
  }
  const configuredPhoto = String(ctx.configuredPhotoTo || "").trim()
    .toLowerCase();
  if (configuredPhoto && !toIncludesConfigured(payload.to, configuredPhoto)) {
    failures.push(
      `photo TO must include bound photo_to '${configuredPhoto}'`,
    );
  }
  const names = attachmentNames(payload.attachments);
  if (names.length === 0) {
    failures.push("photo route requires at least one photo attachment");
  }
  const photos = names.filter((n) => isPhotoAttachmentName(n));
  if (photos.length === 0) {
    failures.push(
      "photo route expected at least one image attachment (jpeg/png/heic/webp)",
    );
  }
  for (const name of names) {
    if (name.toLowerCase().endsWith(".pdf") || isReportPdf(name) ||
      isXeroInvoicePdf(name)
    ) {
      failures.push(
        `photo route must not carry report/invoice PDF pack attachments: ${name}`,
      );
    }
    if (isRawPhotoDumpName(name)) {
      failures.push(
        `photo route refuses raw dump filename '${name}'; use labelled full-res names`,
      );
    }
  }
  failures.push(...attachmentMarkerFailures(names));
  return failures;
}

/** @deprecated alias for AJS photo (ses@ required via builderKey) */
export function checkAjsPhotoClientSendGate(
  payload: ClientSendPayload,
): string[] {
  return checkPhotoRouteClientSendGate(payload, { builderKey: "AJS" });
}

/**
 * MLB/universal `invoice`: explicit invoice_to, finance@ required, ses@ forbidden.
 */
export function checkMlbInvoiceClientSendGate(
  payload: ClientSendPayload,
  ctx: Pick<SesClientSendRouteContext, "configuredInvoiceTo"> = {},
): string[] {
  const failures = sharedEnvelopeFailures(payload);
  const configured = String(ctx.configuredInvoiceTo || "").trim().toLowerCase();
  if (!configured) {
    failures.push(
      "missing explicit invoice_to for invoice route; cannot silent-inherit top-level to",
    );
  } else if (!toIncludesConfigured(payload.to, configured)) {
    failures.push(
      `invoice TO must equal/include explicit invoice_to '${configured}'; got ${
        splitEmails(payload.to).join(", ") || "<missing>"
      }`,
    );
  }
  const cc = splitEmails(payload.cc);
  if (!cc.includes(MAKESAFE_FINANCE_CC)) {
    failures.push(`invoice cc must include ${MAKESAFE_FINANCE_CC}`);
  }
  if (cc.includes(MAKESAFE_CC)) {
    failures.push(
      `invoice route must not cc ${MAKESAFE_CC} (finance-only for MLB)`,
    );
  }
  const names = attachmentNames(payload.attachments);
  const invoiceNames = names.filter((n) => isXeroInvoicePdf(n));
  const photoBleed = names.filter((n) => isPhotoAttachmentName(n));
  if (invoiceNames.length !== 1) {
    failures.push(
      `invoice route expected exactly one real Xero invoice PDF; got ${invoiceNames.length}`,
    );
  }
  if (photoBleed.length > 0) {
    failures.push("invoice route must not attach photo images");
  }
  failures.push(...attachmentMarkerFailures(names));
  return failures;
}

/**
 * Dispatch a sealed-release route payload through the named contract gate kind.
 * Empty result == PASS.
 */
export function checkSesClientSendRouteGate(
  payload: ClientSendPayload,
  ctx: SesClientSendRouteContext,
): string[] {
  switch (ctx.kind) {
    case "report_invoice":
      return checkReportInvoiceClientSendGate(payload, ctx);
    case "report":
      return checkMlbReportClientSendGate(payload);
    case "photo":
      return checkPhotoRouteClientSendGate(payload, ctx);
    case "invoice":
      return checkMlbInvoiceClientSendGate(payload, ctx);
    default: {
      const _exhaustive: never = ctx.kind;
      return [`unknown client-send route kind: ${String(_exhaustive)}`];
    }
  }
}

/**
 * Back-compat dispatcher including legacy pack kinds.
 */
export function checkSesReleaseClientSendGate(
  kind: SesReleaseClientSendGateKind,
  payload: ClientSendPayload,
  ctx: Omit<SesClientSendRouteContext, "kind"> = {},
): string[] {
  if (kind === "ajs_report_invoice" || kind === "report_invoice") {
    return checkSesClientSendRouteGate(payload, {
      ...ctx,
      kind: "report_invoice",
      builderKey: ctx.builderKey || "AJS",
    });
  }
  if (kind === "ajs_photo") {
    return checkSesClientSendRouteGate(payload, {
      ...ctx,
      kind: "photo",
      builderKey: ctx.builderKey || "AJS",
    });
  }
  if (kind === "report" || kind === "photo" || kind === "invoice") {
    return checkSesClientSendRouteGate(payload, { ...ctx, kind });
  }
  if (kind === "universal_pack") return checkClientSendGate(payload);
  if (kind === "universal_pack_with_swms") {
    return checkClientSendGateWithSwms(payload);
  }
  if (kind === "report_job_invoice_only") {
    return checkReportJobClientSendGate(payload);
  }
  return [`unknown client-send gate kind: ${String(kind)}`];
}

// ── Atomic send-lock model (pure reference implementation) ──
//
// The live action takes the lock with a single conditional UPDATE:
//   UPDATE makesafe_report_packs
//      SET status='sending', send_started_at=now()
//    WHERE job_id=? AND pack_kind=? AND status IN (lockable)
//   RETURNING *
// Postgres serialises concurrent UPDATEs on the same row, so exactly one racer
// transitions a lockable row to 'sending'; the other sees 0 rows -> 409. This
// pure model proves that invariant for the tests without a database.
export const LOCKABLE_STATUSES = [
  "admin_to_send_report",
  "drafted",
  "authorised_not_sent",
];

export function canAcquireSendLock(
  currentStatus: string | null | undefined,
): boolean {
  return LOCKABLE_STATUSES.includes(String(currentStatus ?? ""));
}

// A 'sending' pack with failed_step='draft_pack' is NOT an email-send state. It is
// the draft generator's temporary lock. Normally the feed must hide it from email
// recovery; however an older draft run can crash after attaching the report and
// invoice docs, leaving a completed draft invisible and un-sendable. This helper
// is deliberately narrow: only a DRAFT invoice plus typed close-out docs can reset
// that stale draft-generation lock back to the ordinary drafted state.
export function canResetDraftPackGenerationLock(args: {
  packStatus: string | null | undefined;
  failedStep: string | null | undefined;
  invoiceStatus: string | null | undefined;
  hasInvoiceDoc: boolean;
  hasReportDoc: boolean;
  reportRequired?: boolean;
}): boolean {
  const status = String(args.packStatus ?? "");
  const failedStep = String(args.failedStep ?? "");
  const invoiceStatus = String(args.invoiceStatus ?? "").toUpperCase();
  const reportOk = args.reportRequired === false || args.hasReportDoc === true;
  return status === "sending" &&
    failedStep === "draft_pack" &&
    invoiceStatus === "DRAFT" &&
    args.hasInvoiceDoc === true &&
    reportOk;
}

// A tiny serialised lock cell: the FIRST acquire that finds a lockable status
// wins and flips to 'sending'; every subsequent acquire fails until released.
// Models the DB's conditional-UPDATE-RETURNING semantics exactly.
export class SendLockCell {
  status: string;
  constructor(initial: string) {
    this.status = initial;
  }
  // Returns true and flips to 'sending' iff the current status is lockable.
  tryAcquire(): boolean {
    if (canAcquireSendLock(this.status)) {
      this.status = "sending";
      return true;
    }
    return false;
  }
  set(status: string): void {
    this.status = status;
  }
}

// ── Post-send RESUME re-entry (C-1) — RECOVERY of a CONFIRMED send, never a
// re-send. ──
//
// The post-send failure states below are NOT lockable (the email ALREADY went
// out), so a normal retry would 409 forever and a confirmed-sent pack would be
// silently stuck. makesafeSendPack reads the pack row up front and, BEFORE the
// atomic lock, asks this pure function what recovery to apply. Each branch is
// idempotent (re-running is safe) and NEVER re-emails and NEVER re-authorises.
//
//   sent_marker_failed -> the email went out but the marker write failed.
//                         Recovery: write the marker (idempotent) + apply the
//                         make-safe close + status='sent'.   action='marker_and_close'
//   sent_not_closed     -> email out, marker written; only the close failed.
//   close_failed        -> (alias) email out, marker written; only the close failed.
//                         Recovery for both: apply the close ONLY + status='sent'.
//                                                                action='close'
// Anything else -> no recovery (null): the caller proceeds to the normal
// lock/authorise/send path (or, for 'sending', the explicit-resolution path P-1).
export type PostSendResumeAction = "marker_and_close" | "close";

export interface PostSendResumePlan {
  action: PostSendResumeAction;
  writeMarker: boolean; // marker_and_close writes it (idempotent); close does not
  applyClose: boolean; // both apply the make-safe close
  reEmail: false; // NEVER — the email already went out
  reAuthorise: false; // NEVER — the invoice is already authorised
  finalStatus: "sent";
}

export const POST_SEND_RECOVERABLE_STATUSES = [
  "sent_marker_failed",
  "sent_not_closed",
  "close_failed",
];

// Pure: given the current pack status, return the recovery plan for the post-send
// failure states, or null when no post-send recovery applies. Cross-ref
// index.ts:makesafeSendPack resume block (just after the pack-row load).
export function planPostSendResume(
  currentStatus: string | null | undefined,
): PostSendResumePlan | null {
  const s = String(currentStatus ?? "");
  if (s === "sent_marker_failed") {
    return {
      action: "marker_and_close",
      writeMarker: true,
      applyClose: true,
      reEmail: false,
      reAuthorise: false,
      finalStatus: "sent",
    };
  }
  if (s === "sent_not_closed" || s === "close_failed") {
    return {
      action: "close",
      writeMarker: false,
      applyClose: true,
      reEmail: false,
      reAuthorise: false,
      finalStatus: "sent",
    };
  }
  return null;
}

// ── Hard-crash 'sending' window (P-1) — human-visible signal + GUARDED resume. ──
//
// The kill-after-email-before-marker crash correctly leaves status='sending'.
// We do NOT auto-reclaim 'sending' (that would reintroduce double-send risk).
// Instead the read endpoint surfaces it as stale for an attention card, and a
// resume from 'sending' REQUIRES an explicit operator decision in the body.
export const SENDING_STALE_SECONDS = 120; // ~2 minutes

// Pure: is a 'sending' pack stale (send_started_at older than the threshold)?
// Non-'sending' packs are never "in-flight stale". Unparseable/absent timestamps
// are treated as stale so an in-flight pack with a lost timestamp still raises the
// attention card rather than hiding (fail-visible).
export function isSendingStale(
  status: string | null | undefined,
  sendStartedAt: string | null | undefined,
  nowMs: number,
  thresholdSeconds: number = SENDING_STALE_SECONDS,
): boolean {
  if (String(status ?? "") !== "sending") return false;
  if (!sendStartedAt) return true;
  const started = Date.parse(String(sendStartedAt));
  if (Number.isNaN(started)) return true;
  return (nowMs - started) >= thresholdSeconds * 1000;
}

// The two operator resolutions for a 'sending' pack (P-1). The cockpit's two
// buttons send body.sending_resolution = one of these. Any other value (or none)
// -> 409, instructing the operator to verify Sent Items first.
export type SendingResolution = "confirmed_sent" | "confirmed_not_sent";

export interface SendingResolutionPlan {
  resolution: SendingResolution;
  // confirmed_not_sent -> re-enter the send path (invoice already authorised, so
  //   skip re-authorise; re-run the gate + send exactly once).
  reEnterSend: boolean;
  // confirmed_sent -> write marker + close, status='sent', NO re-email.
  writeMarkerAndClose: boolean;
  reAuthorise: false; // NEVER from 'sending' (the invoice is already authorised)
}

// Pure: validate + plan a 'sending' resolution. Returns null for an absent/invalid
// value so the caller returns a 409 (verify Sent Items, resubmit with a resolution).
export function planSendingResolution(
  raw: unknown,
): SendingResolutionPlan | null {
  if (raw === "confirmed_not_sent") {
    return {
      resolution: "confirmed_not_sent",
      reEnterSend: true,
      writeMarkerAndClose: false,
      reAuthorise: false,
    };
  }
  if (raw === "confirmed_sent") {
    return {
      resolution: "confirmed_sent",
      reEnterSend: false,
      writeMarkerAndClose: true,
      reAuthorise: false,
    };
  }
  return null;
}

// ── Ambiguous-invoice guard (N-1) — money-safety, FAIL CLOSED. ──
//
// The live-invoice selection must resolve to EXACTLY ONE non-void (not
// VOIDED/DELETED) ACCREC invoice mapped to the job. If MORE THAN ONE maps, we do
// not guess: send_pack fails closed (412) and the read endpoint flags it so the
// cockpit shows the ambiguity rather than a wrong amount.
export function countLiveInvoices(
  invoiceRows: any[] | null | undefined,
): number {
  return (invoiceRows || []).filter((inv) => !isVoidStatus(inv?.status)).length;
}

// True when more than one non-void invoice maps to the job (ambiguous -> stop).
export function isInvoiceAmbiguous(
  invoiceRows: any[] | null | undefined,
): boolean {
  return countLiveInvoices(invoiceRows) > 1;
}

export function checkPositiveInvoiceTotalGate(invoice: any): string[] {
  const failures: string[] = [];
  const headerTotal = Number(invoice?.total ?? invoice?.Total ?? NaN);
  const headerSubTotal = Number(
    invoice?.sub_total ?? invoice?.subTotal ?? invoice?.SubTotal ?? NaN,
  );
  const rawLines = Array.isArray(invoice?.line_items)
    ? invoice.line_items
    : (Array.isArray(invoice?.LineItems) ? invoice.LineItems : []);
  const lineTotal = rawLines.reduce((sum: number, li: any) => {
    const explicit = li?.LineAmount ?? li?.line_total ?? li?.lineTotal;
    if (explicit != null && Number.isFinite(Number(explicit))) {
      return sum + Number(explicit);
    }
    const quantity = Number(li?.Quantity ?? li?.quantity ?? 1);
    const unit = Number(li?.UnitAmount ?? li?.unit_price ?? li?.unitPrice ?? 0);
    return sum + ((Number.isFinite(quantity) ? quantity : 1) *
      (Number.isFinite(unit) ? unit : 0));
  }, 0);
  const positive = (Number.isFinite(headerTotal) && headerTotal > 0) ||
    (Number.isFinite(headerSubTotal) && headerSubTotal > 0) ||
    lineTotal > 0;

  if (!positive) {
    failures.push(
      "invoice total must be greater than $0 before a make-safe pack can be authorised or sent",
    );
  }
  rawLines.forEach((li: any, idx: number) => {
    const quantity = Number(li?.Quantity ?? li?.quantity ?? 1);
    const unit = Number(li?.UnitAmount ?? li?.unit_price ?? li?.unitPrice ?? 0);
    const explicit = li?.LineAmount ?? li?.line_total ?? li?.lineTotal;
    const lineAmount = explicit != null && Number.isFinite(Number(explicit))
      ? Number(explicit)
      : ((Number.isFinite(quantity) ? quantity : 1) *
        (Number.isFinite(unit) ? unit : 0));
    const desc = String(li?.Description ?? li?.description ?? `line ${idx + 1}`)
      .trim();
    if (!Number.isFinite(quantity) || quantity <= 0) {
      failures.push(
        `invoice line ${idx + 1} has invalid quantity: ${desc}`.slice(0, 220),
      );
      return;
    }
    if (
      (!Number.isFinite(unit) || unit <= 0) ||
      (!Number.isFinite(lineAmount) || lineAmount <= 0)
    ) {
      failures.push(
        `invoice line ${idx + 1} has $0/invalid pricing: ${desc}`.slice(0, 220),
      );
    }
  });
  return failures;
}

// ── Resume-aware feed action mapping (TASK A — the Ferndale fix) ──────────────
//
// The cockpit feed (makesafeReportDrafts) must surface not just a fresh
// ready-to-send draft, but every RESUMABLE pack state, with an EXPLICIT
// per-state action so the UI offers the one safe operation. This is the SINGLE
// source of truth for that mapping. It is PURE: it reads the pack status, the
// derived surfacing flags and whether the MAKESAFE_PACK_SENT | main marker is
// present, and returns the resume_action — or null for a genuinely terminal /
// unrecoverable job (which the feed EXCLUDES, exactly as today).
//
// MONEY/COMMS-safety invariants baked into the mapping:
//   - A job that is sentClosed AND has no recoverable in-progress pack state is
//     EXCLUDED (null) — never re-surfaced as sendable. We NEVER relax sentClosed.
//   - 'finish_send' (re-email ONCE, no re-authorise) is offered ONLY when the
//     invoice is provably AUTHORISED and NO marker is present (no proof of a
//     prior send). The moment a marker exists, the only forward action is
//     close-out ('finish_close_out'), never another email.
//   - 'sent_not_closed' / 'close_failed' ALWAYS carry the marker (the send wrote
//     it), so the marker-stop in makesafeSendPack blocks the normal close path;
//     they are routed to the dedicated close-only resume ('finish_close_out').
//   - 'sending' is NEVER auto-resolved: with no marker the operator must decide
//     ('resolve_send_state'); once a marker exists the email demonstrably went
//     out and the only remaining step is the close ('finish_close_out').
//   - 'sending' + failed_step='draft_pack' is NOT an email-send state. It is a
//     draft-generation lock and must never surface as resolve_send_state.
export type ResumeAction =
  | "send" // a fresh ready-to-review draft: authorise + send (the normal flow)
  | "finish_send" // authorised, NOT sent, NO marker: re-email ONCE (no re-authorise)
  | "finish_close_out" // marker present, only the close remains: close-only, NO email
  | "resolve_send_state"; // 'sending' + NO marker: operator must confirm sent / not-sent

// The pack statuses the feed must ALSO surface beyond the
// substatus=admin_to_send_report outer filter, because a resume can move the
// substatus off admin_to_send_report (e.g. authorised_not_sent). The feed unions
// the job_ids of packs in these statuses into its detail fetch.
export const RESUMABLE_PACK_STATUSES = [
  "authorised_not_sent",
  "sent_marker_failed",
  "sent_not_closed",
  "close_failed",
  "sending",
];

export interface DeriveResumeActionArgs {
  // From _deriveMakesafeSurfacing (reused, never relaxed).
  readyForReview: boolean;
  invoiceAuthorisedLive: boolean;
  // The durable pack row status (makesafe_report_packs.status).
  packStatus: string | null | undefined;
  // Diagnostic step on the pack row. Used to keep Draft Pack in-flight locks out
  // of the irreversible email-send recovery path even though both currently use
  // the constrained DB status value 'sending'.
  failedStep?: string | null | undefined;
  // Whether the MAKESAFE_PACK_SENT | main marker note is present for the job.
  markerPresent: boolean;
}

// Pure: map a candidate job to its resume_action, or null to EXCLUDE it.
// Implements the contract mapping EXACTLY (cross-ref TASK A):
//   readyForReview                                              -> 'send'
//   authorised_not_sent && invoiceAuthorisedLive && NO marker   -> 'finish_send'
//   sent_marker_failed && NO marker                             -> 'finish_send'
//   (sent_not_closed || close_failed) && marker PRESENT         -> 'finish_close_out'
//   sending && NO marker                                        -> 'resolve_send_state'
//   sending && marker PRESENT                                   -> 'finish_close_out'
//   anything else (sent / terminal / marker-only)               -> null (EXCLUDE)
export function deriveResumeAction(
  args: DeriveResumeActionArgs,
): ResumeAction | null {
  const s = String(args.packStatus ?? "");
  const failedStep = String(args.failedStep ?? "");
  const marker = args.markerPresent === true;

  // A genuinely fresh drafted-not-sent pack — the normal authorise+send flow.
  // readyForReview already requires !sentClosed and a DRAFT invoice, so it can
  // never collide with a post-send state. It also safely recovers a stale
  // draft-generation lock when the typed docs and DRAFT invoice already prove the
  // draft is complete; that lock is not an email in-flight state.
  if (args.readyForReview) return "send";

  // A Draft Pack generator lock is not an email send. If it did not satisfy the
  // fresh readyForReview predicate above, keep it out of the email recovery UI.
  if (s === "sending" && failedStep === "draft_pack") return null;

  // Authorised but not sent, with NO proof of a prior send -> re-email ONCE.
  // The marker guard is the double-email firewall: if a marker is present the
  // email already went out and we must NOT offer another send.
  if (s === "authorised_not_sent" && args.invoiceAuthorisedLive && !marker) {
    return "finish_send";
  }

  // Email went out but the marker write failed AND the marker is still absent ->
  // 'finish_send' is the cockpit BUTTON, but it does NOT re-email for this state:
  // when the operator triggers it, makesafeSendPack's planPostSendResume sees
  // 'sent_marker_failed' and runs the 'marker_and_close' recovery (writes the
  // missing marker + applies the close, NO email, NO authorise) BEFORE any send
  // path is reached. So no double-email is possible. If the marker is now present
  // this instead falls through to exclude (a bare marker-only terminal) — the
  // marker-stop short-circuits any send regardless. (See planPostSendResume.)
  if (s === "sent_marker_failed" && !marker) return "finish_send";

  // Email out + marker written; only the close failed -> close-only, NO email.
  if ((s === "sent_not_closed" || s === "close_failed") && marker) {
    return "finish_close_out";
  }

  // Hard-crash 'sending' window. No marker -> the operator must verify Sent
  // Items and decide. Marker present -> the email demonstrably went out, so the
  // only remaining step is the close.
  if (s === "sending") {
    return marker ? "finish_close_out" : "resolve_send_state";
  }

  // sent / marker-only terminal / genuine closed -> EXCLUDE (null), as today.
  return null;
}

// ── Email-outcome classifier (D-d, TASK C — double-email firewall) ───────────
//
// MONEY/COMMS-safety. When send-outlook-email returns a NON-OK status, decide
// whether the failure PROVES the email was rejected BEFORE dispatch (safe to set
// authorised_not_sent and re-send later) or is AMBIGUOUS (it may have dispatched
// then errored -> must land in 'sending', NEVER re-offered as a send).
//
// Only a NARROW set of 4xx codes prove a pre-dispatch rejection: a malformed /
// unauthorised / unprocessable request the email fn rejects WITHOUT contacting
// the mail provider. A timeout / rate-limit / conflict / generic-or-unknown 4xx
// and ALL 5xx are AMBIGUOUS (the fn may have handed the message to Outlook then
// errored), so they are treated as unknown-outcome => 'sending'. FAIL CLOSED:
// anything not explicitly proven pre-dispatch is ambiguous.
const PROVABLY_PRE_DISPATCH_STATUSES = new Set([400, 401, 403, 404, 422]);

export function emailFailureIsProvablyPreDispatch(status: number): boolean {
  // Defensive: a 0/NaN/negative (e.g. a thrown fetch surfaced as status 0) is
  // NOT provably pre-dispatch -> ambiguous.
  if (!Number.isFinite(status) || status <= 0) return false;
  return PROVABLY_PRE_DISPATCH_STATUSES.has(status);
}

// ── makesafe_resume_close assertions (TASK B — close-only, fail-closed) ──────
//
// The close-only resume path is structurally incapable of emailing or
// authorising. Before it applies the close it MUST pass BOTH asserts:
//   1. the pack status is one of the close-recoverable states; and
//   2. the MAKESAFE_PACK_SENT | main marker is PRESENT (proof the email went
//      out). No marker == no proof of send == refuse (never close a pack that
//      may not have emailed; the operator routes it through send instead).
export const RESUME_CLOSE_ALLOWED_STATUSES = [
  "sent_not_closed",
  "close_failed",
];

export interface ResumeCloseGate {
  ok: boolean;
  // HTTP status for the failure (409 for a wrong-state pack, 409 for no marker —
  // both are conflict/precondition failures the operator must resolve first).
  httpStatus: number;
  reason: string | null;
}

// Pure: gate a makesafe_resume_close call. ok only when BOTH asserts pass.
export function checkResumeCloseGate(args: {
  packStatus: string | null | undefined;
  markerPresent: boolean;
}): ResumeCloseGate {
  const s = String(args.packStatus ?? "");
  if (!RESUME_CLOSE_ALLOWED_STATUSES.includes(s)) {
    return {
      ok: false,
      httpStatus: 409,
      reason: `makesafe_resume_close requires pack status in {${
        RESUME_CLOSE_ALLOWED_STATUSES.join(", ")
      }}; got '${s || "<none>"}'`,
    };
  }
  if (args.markerPresent !== true) {
    return {
      ok: false,
      httpStatus: 409,
      reason:
        "makesafe_resume_close refused: MAKESAFE_PACK_SENT marker absent (no proof the email was sent); resolve via send, not close",
    };
  }
  return { ok: true, httpStatus: 200, reason: null };
}

// ── makesafe_reset_failed_pack guards (TASK D — no permanent dead-ends) ──────
//
// A 'failed' pack is not lockable, so it 409s forever even after the underlying
// problem is fixed. This privileged reset puts it back into a lockable state so
// the normal send flow can re-run. It is FAIL-CLOSED: it only resets a pack that
// failed at a PRE-SEND step AND has NO MAKESAFE_PACK_SENT marker. A pack that may
// have emailed (post-email failed_step OR any marker present) is NEVER reset.
//
// PRE-SEND failed_steps are the steps that run BEFORE the email is dispatched:
//   recipient_gate, preflight_docs, preflight_invoice, preflight_invoice_ambiguous,
//   load_report_pdf, client_send_gate, draft_pack, unexpected (pre-authorise getToken etc.)
// POST-SEND/ambiguous failed_steps that must NEVER be reset by this path:
//   send (the email dispatch step — outcome may be unknown), marker, close.
export const RESET_FAILED_PRESEND_STEPS = [
  "recipient_gate",
  "preflight_docs",
  "preflight_invoice",
  "preflight_invoice_ambiguous",
  "load_report_pdf",
  "client_send_gate",
  "draft_pack",
  "unexpected",
];
// Steps at/after the actual email dispatch — a reset here could mask a real send.
export const RESET_FAILED_FORBIDDEN_STEPS = ["send", "marker", "close"];

export interface ResetFailedGate {
  ok: boolean;
  httpStatus: number;
  reason: string | null;
}

// Pure: gate a makesafe_reset_failed_pack call. ok only when the pack is 'failed',
// the failed_step is a recognised PRE-SEND step, and NO marker is present.
export function checkResetFailedGate(args: {
  packStatus: string | null | undefined;
  failedStep: string | null | undefined;
  markerPresent: boolean;
}): ResetFailedGate {
  const s = String(args.packStatus ?? "");
  const step = String(args.failedStep ?? "");
  if (s !== "failed") {
    return {
      ok: false,
      httpStatus: 409,
      reason: `makesafe_reset_failed_pack requires pack status 'failed'; got '${
        s || "<none>"
      }'`,
    };
  }
  // FAIL CLOSED on a marker: a marker means the email went out — never reset.
  if (args.markerPresent === true) {
    return {
      ok: false,
      httpStatus: 409,
      reason:
        "reset refused: MAKESAFE_PACK_SENT marker present (the email may have gone out); this pack cannot be reset",
    };
  }
  if (
    RESET_FAILED_FORBIDDEN_STEPS.includes(step) ||
    !RESET_FAILED_PRESEND_STEPS.includes(step)
  ) {
    return {
      ok: false,
      httpStatus: 409,
      reason: `reset refused: failed_step '${
        step || "<none>"
      }' is not a recognised PRE-SEND step; only ${
        RESET_FAILED_PRESEND_STEPS.join(", ")
      } are resettable`,
    };
  }
  return { ok: true, httpStatus: 200, reason: null };
}

// ── Stage 1-2a: Photo follow-up idempotency marker ──────────────────────────
//
// Email 2 for AJS/MLB: the approved site photos sent as individual attachments
// AFTER the main pack (email 1). Idempotent via the MAKESAFE_PACK_SENT | photo
// prefix in job_events. Independent of the main pack marker.
export const MAKESAFE_PACK_PHOTO_SENT_PREFIX = "MAKESAFE_PACK_SENT | photo";

export function isPackPhotoSentEvent(ev: any): boolean {
  if (!ev || String(ev.event_type) !== "note") return false;
  let dj = ev.detail_json;
  if (typeof dj === "string") {
    try {
      dj = JSON.parse(dj);
    } catch (_) {
      dj = { text: dj };
    }
  }
  const text = dj && typeof dj === "object" ? dj.text : null;
  return typeof text === "string" &&
    text.trim().startsWith(MAKESAFE_PACK_PHOTO_SENT_PREFIX);
}

export function hasPackPhotoSentMarker(
  events: any[] | null | undefined,
): boolean {
  return (events || []).some((ev) => isPackPhotoSentEvent(ev));
}

export function buildPhotoFollowUpMarkerText(args: {
  photoCount: number;
  to: string;
  nowIso: string;
  messageId?: string | null;
}): string {
  return [
    MAKESAFE_PACK_PHOTO_SENT_PREFIX,
    `photos=${args.photoCount}`,
    `to=${args.to}`,
    args.nowIso,
    `msgid=${args.messageId || ""}`,
  ].join(" | ");
}

// ── Stage 1-2a: Portal-prep idempotency marker ───────────────────────────────
//
// Western Building / Builderwest are portal-only builders: NO email is sent.
// We prep the doc list for manual portal submission and write this marker so
// the cockpit shows 'portal_ready' and a second prep call returns early.
export const MAKESAFE_PACK_PORTAL_READY_PREFIX = "MAKESAFE_PACK_PORTAL_READY";

export function isPackPortalReadyEvent(ev: any): boolean {
  if (!ev || String(ev.event_type) !== "note") return false;
  let dj = ev.detail_json;
  if (typeof dj === "string") {
    try {
      dj = JSON.parse(dj);
    } catch (_) {
      dj = { text: dj };
    }
  }
  const text = dj && typeof dj === "object" ? dj.text : null;
  return typeof text === "string" &&
    text.trim().startsWith(MAKESAFE_PACK_PORTAL_READY_PREFIX);
}

export function hasPackPortalReadyMarker(
  events: any[] | null | undefined,
): boolean {
  return (events || []).some((ev) => isPackPortalReadyEvent(ev));
}

export function buildPortalReadyMarkerText(args: { nowIso: string }): string {
  return [MAKESAFE_PACK_PORTAL_READY_PREFIX, args.nowIso].join(" | ");
}

// ── Stage 1-2a: isSwmsPdf — detect SWMS attachment filenames ─────────────────
//
// Used by checkClientSendGateWithSwms to identify the SWMS PDF among attachments.
export function isSwmsPdf(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.endsWith(".pdf")) return false;
  // Do not treat the MakeSafe job number prefix (for example SWMS-26642) as a
  // SWMS document. MLB report filenames include the SWMS job number, and the
  // client-send gate must count only the actual SWMS attachment.
  return /(^|[^a-z0-9])swms(?![-\s]?\d)(?=$|[^a-z0-9])/i.test(name);
}

// ── Stage 1-2a: checkClientSendGateWithSwms — 3-attachment gate for MLB ──────
//
// MLB email 1 requires THREE PDFs: report + Xero invoice + SWMS. This gate
// extends checkClientSendGate's logic with the additional SWMS requirement.
// Returns [] when the payload is safe to send; otherwise a list of failure
// strings. The caller MUST treat any non-empty result as a hard stop.
export function checkClientSendGateWithSwms(
  payload: ClientSendPayload,
): string[] {
  const failures: string[] = [];
  const fromEmail = String(payload.from || payload.from_email || "").trim()
    .toLowerCase();
  if (fromEmail !== MAKESAFE_ADMIN_FROM) {
    failures.push(
      `sender must be ${MAKESAFE_ADMIN_FROM}; got ${fromEmail || "<missing>"}`,
    );
  }
  if (splitEmails(payload.to).length === 0) {
    failures.push("to recipient is missing");
  }
  const cc = splitEmails(payload.cc);
  if (!cc.includes(MAKESAFE_CC)) {
    failures.push(`cc must include ${MAKESAFE_CC}`);
  }
  const subject = String(payload.subject || "").trim();
  if (!subject) {
    failures.push("subject is missing");
  } else {
    const marker = hasReviewMarker(subject);
    if (marker) {
      failures.push(
        `client subject contains review/test marker '${marker}': ${subject}`,
      );
    }
  }
  const html = String(payload.htmlBody || payload.html_body || "");
  if (!html.trim()) failures.push("html body is missing");
  const names = attachmentNames(payload.attachments);
  if (names.length < 3) {
    failures.push(
      "MLB client send requires at least three separate PDF attachments: report, Xero invoice, and SWMS",
    );
  }
  const reportNames = names.filter((n) => isReportPdf(n));
  const invoiceNames = names.filter((n) => isXeroInvoicePdf(n));
  const swmsNames = names.filter((n) => isSwmsPdf(n));
  if (reportNames.length !== 1) {
    failures.push(
      `expected exactly one final make-safe report PDF; got ${reportNames.length}`,
    );
  }
  if (invoiceNames.length !== 1) {
    failures.push(
      `expected exactly one actual Xero invoice PDF; got ${invoiceNames.length}`,
    );
  }
  if (swmsNames.length !== 1) {
    failures.push(`expected exactly one SWMS PDF; got ${swmsNames.length}`);
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".pdf")) {
      failures.push(`attachment must be a PDF for formal client send: ${name}`);
    }
    const marker = hasReviewMarker(name);
    if (marker) {
      failures.push(
        `client attachment filename contains review/test marker '${marker}': ${name}`,
      );
    }
  }
  return failures;
}

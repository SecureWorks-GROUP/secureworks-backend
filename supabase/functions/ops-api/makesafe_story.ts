// MakeSafe cheap-pass STORY ENGINE (W3-A hybrid loop, backend half).
//
// Pure verdict logic — no network, no Supabase, no live sends — so the cheap pass
// is unit-testable against fixtured card evidence. The DB-bound pass (reads the
// makesafe_audit partition + the admin@ Sent-Items mirror + the recheck queue,
// persists makesafe_card_story) lives in index.ts; this file is the decision logic
// it calls, and the send-attribution classifier over the mirrored Sent folder.
//
// SEMANTIC REFERENCE: the wiki reconciler build_job_story.py. This PORTS its
// verdict semantics (not its code) into the subset of legs the backend can reach:
//   * only ATTRIBUTION legs gate a send verdict — a builder-ref / invoice-number
//     match on the admin@ Sent mirror, the MAKESAFE_PACK_SENT|main marker, Xero by
//     job_id. A street-address (recall) hit is NEVER attribution.
//   * FAIL CLOSED: when the portal leg or a full live-mailbox sweep is required to
//     reach a confident verdict, the backend can NOT prove it, so the card fails
//     closed to UNVERIFIED-needs-agent (never a confident GENUINELY-UNSENT / DONE).
//   * the near-double-send guard (SENT-UNRECORDED) fires on POSITIVE send/settle
//     evidence the board has not closed on.
//
// The backend verdict vocabulary is deliberately a SUBSET of the wiki taxonomy —
// only what backend evidence honestly supports:
export type StoryVerdict =
  | "NOT-STARTED"
  | "CANCELLED"
  | "CANCELLED-CONFLICT"
  | "SENT-UNRECORDED"
  | "DECISION_NEEDED"
  | "UNVERIFIED-needs-agent";

// Our own domains: a recipient on any of these is INTERNAL and can never be a
// builder send (mirrors build_job_story.OUR_DOMAINS). An internal chase thread, a
// finance ledger email, or a Marnin/Shaun forward is not a pack send.
export const OUR_DOMAINS = ["secureworkswa.com.au", "secureworksgroup.app"] as const;

// The admin@ mailbox + folder the Sent-Items mirror writes (backend send-attribution).
export const ADMIN_SENT_MAILBOX = "admin@secureworkswa.com.au";
export const SENT_FOLDER = "sentitems";

// A pack-send subject: "Make Safe Report" (optionally "… and Invoice"). Mirrors
// build_job_story._PACK_SUBJECT_RE — deliberately does NOT match a "Make Safe WORK
// ORDER" or "NEW WORK ORDER" line (those are the false-SENT correspondence).
const PACK_SUBJECT_RE = /make\s*safe\s*report|makesafe\s*report/i;

// Substatuses that mean the card is past the not-started stage (attended / report
// in / ready). Reaching any of these means "something happened" backend-visibly.
const PAST_NOT_STARTED_SUBSTATUSES = new Set([
  "in_progress",
  "admin_to_send_report",
  "ready_to_invoice",
  "complete",
  "invoiced",
]);

// A closed substatus (the card is done). Only these can be "cleanly closed".
const CLOSED_SUBSTATUSES = new Set(["complete", "invoiced"]);

// ── the backend evidence for one active card ─────────────────────────────────
// Every field is derived from a BACKEND-reachable leg (makesafe_audit partition,
// the admin@ Sent mirror, job notes markers, Xero by job_id, the portal-verify
// state). Nothing here needs the live portal or a live multi-mailbox sweep — those
// legs are exactly what the backend CANNOT prove, and their absence fails closed.
export interface CardEvidence {
  jobStatus: string | null;
  substatus: string | null; // normalised
  cancelled: boolean;
  // ── send attribution (each an ATTRIBUTION leg) ──
  adminSentAttributed: boolean; // a real pack send in the admin@ Sent mirror, attributed to THIS job
  packSentMarker: boolean; // MAKESAFE_PACK_SENT|main on the job notes (audit.pack_sent)
  pipelineVerifiedSent: boolean; // pipeline_items.sent_status === 'verified_sent'
  // ── Xero (W2-D partition: STRICTLY by job_id) ──
  paid: boolean; // a job_id-linked live invoice is PAID
  invoiceBuilt: boolean; // a job_id-linked live invoice exists
  siblingBleed: boolean; // a live invoice under the builder ref NOT linked to this job (DECISION_NEEDED)
  // ── work / report (backend-visible only) ──
  attended: boolean;
  hasReportDoc: boolean;
  hasInvoiceDoc: boolean;
  woReceived: boolean;
  // ── portal-verify state (item-14) ──
  isReportType: boolean;
  portalVerifiedThisCycle: boolean;
  hasPortalLink: boolean;
}

export interface StoryResult {
  verdict: StoryVerdict;
  needs_agent: boolean;
  blockers: string[];
  evidence_gaps: string[];
}

// A card that is cleanly closed gets NO story row (the fix-list only carries cards
// with something to reconcile). Conservative: only when the board itself says the
// card is closed AND backend positively corroborates a send / settlement. A
// `complete` card WITHOUT corroboration is a discrepancy — NOT cleanly closed.
export function isCleanlyClosed(ev: CardEvidence): boolean {
  const closed = CLOSED_SUBSTATUSES.has(String(ev.substatus || "")) ||
    String(ev.jobStatus || "").toLowerCase() === "invoiced";
  return closed && (ev.paid || positiveSend(ev)) && !ev.cancelled && !ev.siblingBleed;
}

// A positive send is proven by ANY attribution leg: an attributed admin@ Sent
// message, the main pack-sent marker, or the sync-system verified_sent verdict.
function positiveSend(ev: CardEvidence): boolean {
  return ev.adminSentAttributed || ev.packSentMarker || ev.pipelineVerifiedSent;
}

function pastNotStarted(ev: CardEvidence): boolean {
  return ev.attended || ev.invoiceBuilt || ev.hasReportDoc ||
    PAST_NOT_STARTED_SUBSTATUSES.has(String(ev.substatus || ""));
}

// The backend-honest verdict (fail closed both directions). Callers should skip
// isCleanlyClosed(ev) cards before calling this (they get no story row); this
// function assumes the card is active-and-not-cleanly-closed and always returns a
// verdict from the 6-member vocabulary.
export function computeStoryVerdict(ev: CardEvidence): StoryResult {
  const blockers: string[] = [];
  const evidence_gaps: string[] = [];
  const sent = positiveSend(ev);

  // Non-gating context gaps (honest about which legs the backend could not run).
  if (ev.isReportType && !ev.portalVerifiedThisCycle && ev.hasPortalLink) {
    evidence_gaps.push(
      "portal-state-unverified: report-type card whose builder-portal form is not " +
        "verified this cycle — the locked/submitted proof needs an agent " +
        "capture_portal_evidence.py run (backend cannot fetch it).",
    );
  }
  if (pastNotStarted(ev) && !sent && !ev.paid) {
    evidence_gaps.push(
      "send-attribution-incomplete: no attributed admin@ Sent message, no " +
        "MAKESAFE_PACK_SENT marker, and no Xero settlement — proving GENUINELY-UNSENT " +
        "needs a full live mailbox sweep (Marnin/Shaun/ses@) only an agent can run.",
    );
  }
  if (ev.siblingBleed) {
    evidence_gaps.push(
      "invoice-bleed: a live invoice under the builder ref is not linked to this job " +
        "by job_id (possible sibling card / broken link).",
    );
  }

  // 1) job-vs-ref invoice mismatch (sibling / bleed) — decisive from the W2-D
  //    partition, mirrors build_job_story's decision_needed. Fail closed BEFORE any
  //    send reasoning: a bleed means we cannot trust the invoice picture yet.
  if (ev.siblingBleed) {
    blockers.push(
      "decision-needed: a live invoice found under the builder ref is not linked to " +
        "this job (possible sibling/bleed) — confirm per-job before any send.",
    );
    return { verdict: "DECISION_NEEDED", needs_agent: false, blockers, evidence_gaps };
  }

  // 2) cancelled on the board — decisive with a conflict cross-check.
  if (ev.cancelled) {
    if (sent || ev.paid || ev.invoiceBuilt || ev.attended) {
      blockers.push(
        "cancelled on the board but the evidence proves work/send/invoice happened — " +
          "reconcile the record before acting.",
      );
      return {
        verdict: "CANCELLED-CONFLICT",
        needs_agent: false,
        blockers,
        evidence_gaps,
      };
    }
    return { verdict: "CANCELLED", needs_agent: false, blockers, evidence_gaps };
  }

  // 3) positive send / settlement the board has NOT closed on — the near-double-send
  //    guard. Decisive (positive evidence), mirrors build_job_story SENT-UNRECORDED.
  if (sent || ev.paid) {
    blockers.push(
      "a send or paid invoice exists though the card is not in a closed/sent state — " +
        "record it, do NOT re-send.",
    );
    return { verdict: "SENT-UNRECORDED", needs_agent: false, blockers, evidence_gaps };
  }

  // 4) nothing has happened backend-visibly and the board is still early — honest
  //    NOT-STARTED (no send verdict is being asserted; the portal leg is not yet
  //    relevant on an unattended card).
  if (!pastNotStarted(ev)) {
    return { verdict: "NOT-STARTED", needs_agent: false, blockers, evidence_gaps };
  }

  // 5) FAIL CLOSED: the card is past not-started, no attribution leg proved a send,
  //    it is not cancelled and not a bleed — so a confident verdict needs the portal
  //    and/or a full live-mailbox sweep the backend cannot run. UNVERIFIED-needs-agent.
  blockers.push(
    "past not-started with no backend send proof — the portal and/or a full live " +
      "mailbox sweep are required to conclude; the backend cannot reach them.",
  );
  return { verdict: "UNVERIFIED-needs-agent", needs_agent: true, blockers, evidence_gaps };
}

// ── send-attribution classifier over the mirrored admin@ Sent folder ──────────
// A mirrored Sent row is an outbound message FROM us by construction (it lives in
// the admin@ Sent folder), so the only questions are (A6, the false-SENT guard):
//   * external recipient — at least one to/cc NOT on our own domains (else an
//     internal chase/forward, not a builder send);
//   * carries THIS job's attribution token — the builder ref number OR an invoice
//     number (a street-address match is recall, never attribution);
//   * real pack signal — an attachment OR a "Make Safe Report" subject (a bare
//     reply with no attachment and no pack subject is not the pack).
export interface SentRow {
  subject?: string | null;
  body_preview?: string | null;
  body_content?: string | null;
  to_recipients?: string | null; // comma/semicolon-joined recipient addresses
  has_attachments?: boolean | null;
}

function msgText(row: SentRow): string {
  return `${row.subject ?? ""} ${row.body_preview ?? ""} ${row.body_content ?? ""}`
    .toLowerCase();
}

function domainOf(addr: string): string {
  const a = addr.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  return at >= 0 ? a.slice(at + 1) : "";
}

function recipientList(row: SentRow): string[] {
  return String(row.to_recipients ?? "")
    .split(/[;,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function hasExternalRecipient(row: SentRow): boolean {
  for (const r of recipientList(row)) {
    const d = domainOf(r);
    if (d && !(OUR_DOMAINS as readonly string[]).includes(d)) return true;
  }
  return false;
}

// Does the row carry one of the job's attribution tokens (its ref number or an
// invoice number)? A pure-digit token is matched with DIGIT boundaries (not \b) so
// '6771' hits 'BWCWA6771' glued to letters yet never a longer number like '166771'.
// Mirrors build_job_story._msg_carries_token.
export function messageCarriesToken(text: string, tokens: string[]): boolean {
  for (const raw of tokens) {
    const t = String(raw || "").toLowerCase().trim();
    if (!t) continue;
    if (/^\d+$/.test(t)) {
      const re = new RegExp(`(?<!\\d)${t}(?!\\d)`);
      if (re.test(text)) return true;
    } else if (text.includes(t)) {
      return true;
    }
  }
  return false;
}

// The bare numeric core of a builder ref (AJBR 66949 -> '66949', MLB-25638 ->
// '25638'): our own sends carry this number in the subject. Mirrors
// build_job_story._job_ref_number (last run of >= 4 digits).
export function refNumberOf(externalRef: string | null | undefined): string {
  const nums = String(externalRef ?? "").match(/\d{4,}/g);
  return nums && nums.length ? nums[nums.length - 1] : "";
}

// Is this mirrored Sent row a real pack send attributed to THIS job? tokens = the
// job's ref number + its invoice numbers (job-linked only, never a compact-board
// value). Returns true only on external recipient + token + pack signal.
export function sentRowAttributesToJob(row: SentRow, tokens: string[]): boolean {
  if (!hasExternalRecipient(row)) return false;
  if (!messageCarriesToken(msgText(row), tokens)) return false;
  const packSignal = !!row.has_attachments ||
    PACK_SUBJECT_RE.test(String(row.subject ?? ""));
  return packSignal;
}

// ── delta fingerprint (the DESIGN delta rule) ─────────────────────────────────
// A stable digest of the CHEAP signals that can change a verdict. The pass
// recomputes a card only when this changes OR the stored verdict is > staleMs old.
export interface FingerprintInput {
  substatus: string | null;
  jobStatus: string | null;
  cancelled: boolean;
  positiveSend: boolean;
  paid: boolean;
  invoiceBuilt: boolean;
  siblingBleed: boolean;
  attended: boolean;
  hasReportDoc: boolean;
  woReceived: boolean;
  portalVerifiedThisCycle: boolean;
  // new-mail signal: count + freshest received_at of attributed Sent-mirror hits.
  sentHitCount: number;
  sentHitLatest: string | null;
  // new-invoice signal: the job-linked invoice number(s) + the resolved live status
  // (so a fresh invoice / a DRAFT->PAID move re-triggers a verdict).
  invoiceKey: string | null;
}

export function computeSignalFingerprint(f: FingerprintInput): string {
  return [
    f.substatus ?? "",
    (f.jobStatus ?? "").toLowerCase(),
    f.cancelled ? "1" : "0",
    f.positiveSend ? "1" : "0",
    f.paid ? "1" : "0",
    f.invoiceBuilt ? "1" : "0",
    f.siblingBleed ? "1" : "0",
    f.attended ? "1" : "0",
    f.hasReportDoc ? "1" : "0",
    f.woReceived ? "1" : "0",
    f.portalVerifiedThisCycle ? "1" : "0",
    String(f.sentHitCount),
    f.sentHitLatest ?? "",
    f.invoiceKey ?? "",
  ].join("|");
}

// Delta rule: recompute when there is no prior verdict, the cheap signals changed,
// or the prior verdict is older than the staleness bound (default 24h).
export function shouldRecompute(
  priorFingerprint: string | null | undefined,
  priorComputedAt: string | null | undefined,
  fingerprint: string,
  nowMs: number,
  staleMs: number,
): boolean {
  if (!priorFingerprint) return true;
  if (priorFingerprint !== fingerprint) return true;
  const prior = priorComputedAt ? Date.parse(priorComputedAt) : NaN;
  if (Number.isNaN(prior)) return true;
  return nowMs - prior > staleMs;
}

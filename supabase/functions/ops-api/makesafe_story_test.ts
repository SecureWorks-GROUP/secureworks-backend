// W3-A (M-E hybrid loop) — cheap-pass STORY ENGINE unit tests.
//
// Covers the backend-honest verdict tree (fail-closed), the admin@ Sent-mirror
// send-attribution classifier (the false-SENT guard), and the delta fingerprint.
// Verdict fixtures mirror the classes seen in the 2026-07-07 128-card recon
// (NOT-STARTED / SENT-UNRECORDED / CANCELLED / CANCELLED-CONFLICT / DECISION_NEEDED)
// plus the backend fail-closed case that the wiki reconciler would have called
// GENUINELY-UNSENT but the backend cannot prove (-> UNVERIFIED-needs-agent).
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CardEvidence,
  computeSignalFingerprint,
  computeStoryVerdict,
  type FingerprintInput,
  isCleanlyClosed,
  messageCarriesToken,
  refNumberOf,
  type SentRow,
  sentRowAttributesToJob,
  shouldRecompute,
} from "./makesafe_story.ts";

// A neutral, backend-blank active card (nothing has happened): the baseline every
// fixture overrides. Board is early, no send, no invoice, no report, not cancelled.
function blankCard(over: Partial<CardEvidence> = {}): CardEvidence {
  return {
    jobStatus: "accepted",
    substatus: "pending_allocation",
    cancelled: false,
    adminSentAttributed: false,
    packSentMarker: false,
    pipelineVerifiedSent: false,
    paid: false,
    invoiceBuilt: false,
    siblingBleed: false,
    attended: false,
    hasReportDoc: false,
    hasInvoiceDoc: false,
    woReceived: false,
    isReportType: false,
    portalVerifiedThisCycle: false,
    hasPortalLink: false,
    ...over,
  };
}

// ════════════════════ verdict tree ════════════════════

Deno.test("verdict: blank early card with a WO -> NOT-STARTED", () => {
  const r = computeStoryVerdict(blankCard({ woReceived: true }));
  assertEquals(r.verdict, "NOT-STARTED");
  assertFalse(r.needs_agent);
});

Deno.test("verdict: nothing at all -> NOT-STARTED (no send claim asserted)", () => {
  assertEquals(computeStoryVerdict(blankCard()).verdict, "NOT-STARTED");
});

Deno.test("verdict: attributed admin@ send on a not-closed card -> SENT-UNRECORDED (near-double-send)", () => {
  const r = computeStoryVerdict(blankCard({
    substatus: "admin_to_send_report",
    attended: true,
    adminSentAttributed: true,
  }));
  assertEquals(r.verdict, "SENT-UNRECORDED");
  assertFalse(r.needs_agent);
  assert(r.blockers.some((b) => b.includes("do NOT re-send")));
});

Deno.test("verdict: PAID by job_id but board not closed -> SENT-UNRECORDED", () => {
  const r = computeStoryVerdict(blankCard({
    substatus: "ready_to_invoice",
    attended: true,
    invoiceBuilt: true,
    paid: true,
  }));
  assertEquals(r.verdict, "SENT-UNRECORDED");
});

Deno.test("verdict: main pack-sent marker counts as a positive send", () => {
  const r = computeStoryVerdict(blankCard({
    substatus: "admin_to_send_report",
    attended: true,
    packSentMarker: true,
  }));
  assertEquals(r.verdict, "SENT-UNRECORDED");
});

Deno.test("verdict: cancelled with no evidence -> CANCELLED", () => {
  const r = computeStoryVerdict(blankCard({ jobStatus: "cancelled", cancelled: true }));
  assertEquals(r.verdict, "CANCELLED");
});

Deno.test("verdict: cancelled but PAID -> CANCELLED-CONFLICT", () => {
  const r = computeStoryVerdict(blankCard({
    jobStatus: "cancelled",
    cancelled: true,
    paid: true,
    invoiceBuilt: true,
  }));
  assertEquals(r.verdict, "CANCELLED-CONFLICT");
  assert(r.blockers.some((b) => b.includes("cancelled on the board")));
});

Deno.test("verdict: cancelled but an attributed send exists -> CANCELLED-CONFLICT", () => {
  const r = computeStoryVerdict(blankCard({
    jobStatus: "cancelled",
    cancelled: true,
    adminSentAttributed: true,
  }));
  assertEquals(r.verdict, "CANCELLED-CONFLICT");
});

Deno.test("verdict: sibling/bleed invoice mismatch -> DECISION_NEEDED (checked before send reasoning)", () => {
  // Even WITH an attributed send, the bleed is surfaced first (fail closed on the
  // invoice picture) — mirrors build_job_story.decision_needed precedence.
  const r = computeStoryVerdict(blankCard({
    substatus: "ready_to_invoice",
    attended: true,
    adminSentAttributed: true,
    siblingBleed: true,
  }));
  assertEquals(r.verdict, "DECISION_NEEDED");
  assert(r.evidence_gaps.some((g) => g.startsWith("invoice-bleed")));
});

Deno.test("verdict: report-type card attended, no send, portal unverified -> UNVERIFIED-needs-agent (fail closed)", () => {
  // This is the card the wiki reconciler could call GENUINELY-UNSENT only after a
  // proven-complete portal + full-mailbox search. The backend cannot prove those,
  // so it fails closed and flags the agent.
  const r = computeStoryVerdict(blankCard({
    substatus: "admin_to_send_report",
    attended: true,
    isReportType: true,
    hasPortalLink: true,
    portalVerifiedThisCycle: false,
  }));
  assertEquals(r.verdict, "UNVERIFIED-needs-agent");
  assert(r.needs_agent);
  assert(r.evidence_gaps.some((g) => g.startsWith("portal-state-unverified")));
  assert(r.evidence_gaps.some((g) => g.startsWith("send-attribution-incomplete")));
});

Deno.test("verdict: non-report attended card, no send -> UNVERIFIED-needs-agent (needs live mailbox sweep)", () => {
  const r = computeStoryVerdict(blankCard({
    substatus: "in_progress",
    attended: true,
    hasReportDoc: true,
  }));
  assertEquals(r.verdict, "UNVERIFIED-needs-agent");
  assert(r.needs_agent);
});

// ════════════════════ cleanly-closed skip ════════════════════

Deno.test("cleanly-closed: complete + paid -> skipped (no fix-list row)", () => {
  assert(isCleanlyClosed(blankCard({
    jobStatus: "invoiced",
    substatus: "complete",
    paid: true,
    invoiceBuilt: true,
    attended: true,
  })));
});

Deno.test("cleanly-closed: complete + attributed send (no paid) -> skipped", () => {
  assert(isCleanlyClosed(blankCard({
    substatus: "complete",
    adminSentAttributed: true,
    attended: true,
  })));
});

Deno.test("NOT cleanly-closed: complete but NO corroborating evidence -> a discrepancy, keep it", () => {
  // Board says complete but backend cannot corroborate any send/settlement — this is
  // exactly a graf-class discrepancy, must NOT be silently skipped.
  const ev = blankCard({ substatus: "complete", attended: true, isReportType: true, hasPortalLink: true });
  assertFalse(isCleanlyClosed(ev));
  assertEquals(computeStoryVerdict(ev).verdict, "UNVERIFIED-needs-agent");
});

Deno.test("NOT cleanly-closed: cancelled is never cleanly closed even if paid", () => {
  assertFalse(isCleanlyClosed(blankCard({ substatus: "complete", cancelled: true, paid: true })));
});

// ════════════════════ send-attribution classifier ════════════════════

const BUILDER_SENT: SentRow = {
  subject: "Make Safe Report and Invoice - Job No 66949",
  body_preview: "Please find attached the make safe report and invoice.",
  to_recipients: "workorders@ajs.build, accounts@ajs.build",
  has_attachments: true,
};

Deno.test("attribution: external builder recipient + ref# + pack attachment -> attributed", () => {
  assert(sentRowAttributesToJob(BUILDER_SENT, ["66949"]));
});

Deno.test("attribution: pack SUBJECT alone (no attachment) still attributes on ref#", () => {
  const row: SentRow = { ...BUILDER_SENT, has_attachments: false };
  assert(sentRowAttributesToJob(row, ["66949"]));
});

Deno.test("attribution: internal-only recipients (our domains) -> NOT a send", () => {
  const row: SentRow = {
    ...BUILDER_SENT,
    to_recipients: "marnin@secureworkswa.com.au, shaun@secureworkswa.com.au",
  };
  assertFalse(sentRowAttributesToJob(row, ["66949"]));
});

Deno.test("attribution: external + pack signal but WRONG ref -> not this job's send", () => {
  assertFalse(sentRowAttributesToJob(BUILDER_SENT, ["25638"]));
});

Deno.test("attribution: no pack signal (no attachment, chase-reply subject) -> not a send", () => {
  const row: SentRow = {
    subject: "RE: REPORTS PLEASE - 66949",
    body_preview: "chasing this one up",
    to_recipients: "joe@ajs.build",
    has_attachments: false,
  };
  assertFalse(sentRowAttributesToJob(row, ["66949"]));
});

Deno.test("attribution: invoice number token matches too", () => {
  const row: SentRow = {
    subject: "Make Safe Report",
    body_preview: "Invoice INV-0704 attached",
    to_recipients: "bunbury@mlbuilders.com.au",
    has_attachments: true,
  };
  assert(sentRowAttributesToJob(row, ["INV-0704"]));
});

Deno.test("messageCarriesToken: pure-digit token respects digit boundaries", () => {
  assert(messageCarriesToken("ref bwcwa6771 attached", ["6771"])); // glued to letters OK
  assertFalse(messageCarriesToken("ref 166771 attached", ["6771"])); // longer number NOT a hit
  assertFalse(messageCarriesToken("ref 67710 attached", ["6771"]));
});

Deno.test("refNumberOf: takes the last >=4-digit run of a builder ref", () => {
  assertEquals(refNumberOf("AJBR 66949"), "66949");
  assertEquals(refNumberOf("MLB-25638"), "25638");
  assertEquals(refNumberOf(""), "");
  assertEquals(refNumberOf(null), "");
});

// ════════════════════ delta fingerprint ════════════════════

function fp(over: Partial<FingerprintInput> = {}): FingerprintInput {
  return {
    substatus: "admin_to_send_report",
    jobStatus: "accepted",
    cancelled: false,
    positiveSend: false,
    paid: false,
    invoiceBuilt: false,
    siblingBleed: false,
    attended: true,
    hasReportDoc: false,
    woReceived: true,
    portalVerifiedThisCycle: false,
    sentHitCount: 0,
    sentHitLatest: null,
    invoiceKey: "",
    ...over,
  };
}

Deno.test("fingerprint: stable for identical signals, changes on any signal", () => {
  const base = computeSignalFingerprint(fp());
  assertEquals(base, computeSignalFingerprint(fp()));
  assert(base !== computeSignalFingerprint(fp({ substatus: "ready_to_invoice" })));
  assert(base !== computeSignalFingerprint(fp({ positiveSend: true })));
  assert(base !== computeSignalFingerprint(fp({ sentHitCount: 1 })));
  assert(base !== computeSignalFingerprint(fp({ invoiceKey: "INV-1~PAID" })));
});

Deno.test("shouldRecompute: no prior -> recompute", () => {
  assert(shouldRecompute(null, null, "x", Date.now(), 24 * 3600_000));
});

Deno.test("shouldRecompute: unchanged fingerprint within staleness -> skip", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  const recent = "2026-07-08T11:00:00Z";
  assertFalse(shouldRecompute("x", recent, "x", now, 24 * 3600_000));
});

Deno.test("shouldRecompute: changed fingerprint -> recompute even if fresh", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  assert(shouldRecompute("x", "2026-07-08T11:59:00Z", "y", now, 24 * 3600_000));
});

Deno.test("shouldRecompute: unchanged but stale (>24h) -> recompute", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  const old = "2026-07-07T00:00:00Z"; // 36h earlier
  assert(shouldRecompute("x", old, "x", now, 24 * 3600_000));
});

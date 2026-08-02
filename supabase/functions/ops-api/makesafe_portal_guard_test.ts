// W2-C (M-E1) — pure portal-truth guard + recheck-queue predicate tests.
//
// Fixtured against the REAL primeeco portal states captured 2026-07-07 (locked =
// submitted; unlocked / partial counter = not submitted). These pure helpers are
// the decision logic behind the item-14 guard and the honest-fallback recheck queue.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractPortalLinks,
  PORTAL_GUARDED_ADVANCE_SUBSTATUSES,
  portalRecheckDue,
  portalRecheckEligible,
  portalVerificationSatisfied,
  reportInSatisfied,
  substatusAdvanceNeedsPortalVerification,
  substatusAdvanceNeedsReportIn,
  validatePortalEvidenceForReportType,
} from "./makesafe_portal_guard.ts";

// ── portalVerificationSatisfied: cycle-scoped ──────────────────────────────
Deno.test("guard: non-report card is always satisfied (never gated)", () => {
  assertEquals(
    portalVerificationSatisfied({
      isReportType: false,
      currentCycle: 1,
      verifiedAt: null,
      verifiedCycle: null,
    }),
    true,
  );
});

Deno.test("guard: report card with no verification is NOT satisfied", () => {
  assertEquals(
    portalVerificationSatisfied({
      isReportType: true,
      currentCycle: 1,
      verifiedAt: null,
      verifiedCycle: null,
    }),
    false,
  );
});

Deno.test("guard: report card verified for the CURRENT cycle is satisfied", () => {
  assertEquals(
    portalVerificationSatisfied({
      isReportType: true,
      currentCycle: 2,
      verifiedAt: "2026-07-07T00:00:00Z",
      verifiedCycle: 2,
    }),
    true,
  );
});

Deno.test("guard: assessment verification requires stored triad proof", () => {
  assertEquals(
    portalVerificationSatisfied({
      isReportType: true,
      currentCycle: 2,
      verifiedAt: "2026-07-07T00:00:00Z",
      verifiedCycle: 2,
      requiresAssessmentProof: true,
      assessmentProofSatisfied: false,
    }),
    false,
  );
  assertEquals(
    portalVerificationSatisfied({
      isReportType: true,
      currentCycle: 2,
      verifiedAt: "2026-07-07T00:00:00Z",
      verifiedCycle: 2,
      requiresAssessmentProof: true,
      assessmentProofSatisfied: true,
    }),
    true,
  );
});

Deno.test("queue: assessment cards with legacy verification remain eligible without triad proof", () => {
  const card = {
    jobStatus: "accepted",
    isReportType: true,
    externalLinks: [{
      kind: "assessment_report",
      url: "https://primeeco.tech/share/assessment",
    }],
    currentCycle: 2,
    verifiedAt: "2026-07-07T00:00:00Z",
    verifiedCycle: 2,
    requiresAssessmentProof: true,
    assessmentProofSatisfied: false,
  };
  assertEquals(portalRecheckEligible(card), true);
  assertEquals(
    portalRecheckEligible({
      ...card,
      assessmentProofSatisfied: true,
    }),
    false,
  );
});

Deno.test("guard: a stale prior-cycle verification does NOT carry over after a reopen/re-attend", () => {
  // Verified in cycle 1, but the card was reopened/re-attended -> cycle 2. Must re-verify.
  assertEquals(
    portalVerificationSatisfied({
      isReportType: true,
      currentCycle: 2,
      verifiedAt: "2026-07-07T00:00:00Z",
      verifiedCycle: 1,
    }),
    false,
  );
});

// ── substatusAdvanceNeedsPortalVerification ────────────────────────────────
Deno.test("guard: only report-type advances to a report-complete substatus are gated", () => {
  for (const sub of PORTAL_GUARDED_ADVANCE_SUBSTATUSES) {
    assertEquals(
      substatusAdvanceNeedsPortalVerification(sub, true),
      true,
      `${sub} report`,
    );
    assertEquals(
      substatusAdvanceNeedsPortalVerification(sub, false),
      false,
      `${sub} non-report`,
    );
  }
  // Pre-report board moves are never gated (a card is free to move through these).
  for (
    const sub of [
      "company_contact_required",
      "company_contact_done",
      "waiting_on_trade_report",
    ]
  ) {
    assertEquals(
      substatusAdvanceNeedsPortalVerification(sub, true),
      false,
      sub,
    );
  }
});

// ── extractPortalLinks: shaped for capture_portal_evidence.py ──────────────
Deno.test("queue: extracts report/portal links, drops non-portal links, dedupes by URL", () => {
  const links = extractPortalLinks([
    {
      label: "Roof report link",
      url: "https://primeeco.tech/share/ace0a334-09b2-4c69-95fd-122719bff343",
      kind: "roof_report",
    },
    {
      label: "Assessment",
      url: "https://primeeco.tech/share/9861bb69-c556-46cf-9836-b483117db873",
      kind: "assessment_report",
    },
    // non-portal marketing link on an unknown kind + non-portal host -> dropped
    { label: "Our website", url: "https://example.com/about", kind: "website" },
    // duplicate URL (case-insensitive) -> deduped
    {
      label: "dup",
      url: "HTTPS://PRIMEECO.TECH/share/ace0a334-09b2-4c69-95fd-122719bff343",
      kind: "roof_report",
    },
  ]);
  assertEquals(links.length, 2);
  assertEquals(links[0].role, "roof_report");
  assertEquals(
    links[1].url,
    "https://primeeco.tech/share/9861bb69-c556-46cf-9836-b483117db873",
  );
});

Deno.test("queue: a bare share-path URL on any host counts as a portal link", () => {
  const links = extractPortalLinks(["https://any.host/share/abc123"]);
  assertEquals(links.length, 1);
  assertEquals(links[0].url, "https://any.host/share/abc123");
});

Deno.test("queue: no portal links -> empty", () => {
  assertEquals(
    extractPortalLinks([{ url: "https://example.com/x", kind: "website" }])
      .length,
    0,
  );
  assertEquals(extractPortalLinks(null).length, 0);
  assertEquals(extractPortalLinks(undefined).length, 0);
});

// F5 — declared kind=builder_portal no longer launders branding/tracker URLs
// into the capture queue / portal read path.
Deno.test("F5 queue: image and tracker URLs dropped even when kind=builder_portal", () => {
  const links = extractPortalLinks([
    {
      label: "Builder Portal",
      url:
        "https://documents.primeeco.tech/15276239/mlb_new_logo.png",
      kind: "builder_portal",
    },
    {
      label: "Builder Portal",
      url:
        "https://xw2vdtj6.r.ap-southeast-2.awstrack.me/I0/0108019e/1/1",
      kind: "builder_portal",
    },
    {
      label: "Roof report",
      url: "https://primeeco.tech/share/expired-but-still-a-portal",
      kind: "roof_report",
    },
  ]);
  assertEquals(links.length, 1);
  assertEquals(
    links[0].url,
    "https://primeeco.tech/share/expired-but-still-a-portal",
  );
  assertEquals(links[0].role, "roof_report");
});

Deno.test("assessment proof: scope is the quote member and all three headless captures are required", () => {
  const links = [
    {
      label: "Assessment report",
      url: "https://primeeco.tech/share/assessment",
      kind: "assessment_report",
    },
    {
      label: "Photos",
      url: "https://primeeco.tech/share/photos",
      kind: "photos",
    },
    {
      label: "Scope of Works",
      url: "https://primeeco.tech/share/scope",
      kind: "scope",
    },
  ];
  const evidence = extractPortalLinks(links).map((link) => ({
    role: link.role,
    url: link.url,
    status: "done",
    locked: true,
    signal: "form locked/submitted",
    screenshot: `/tmp/${link.role}.png`,
  }));
  const result = validatePortalEvidenceForReportType(
    "assessment_report",
    links,
    evidence,
  );
  assertEquals(result.ready, true);
  assertEquals(result.evidence.map((item) => item.role), [
    "assessment_report",
    "photos",
    "quote",
  ]);
  assertEquals(result.waiting_on, []);
});

Deno.test("assessment proof: expired and missing Prime members produce plain card sentences", () => {
  const assessmentUrl = "https://primeeco.tech/share/assessment";
  const result = validatePortalEvidenceForReportType(
    "assessment_report",
    [{
      label: "Assessment report",
      url: assessmentUrl,
      kind: "assessment_report",
    }],
    [{
      role: "assessment_report",
      url: assessmentUrl,
      status: "unreachable",
      locked: null,
      signal: "link expired",
      screenshot: "/tmp/assessment.png",
    }],
  );
  assertEquals(result.ready, false);
  assert(
    result.waiting_on.includes(
      "The builder's assessment link is expired - ask the builder to send a fresh assessment link.",
    ),
  );
  assert(
    result.waiting_on.includes(
      "The work order email contains no photos link - ask the builder to send it.",
    ),
  );
  assert(
    result.waiting_on.includes(
      "The work order email contains no quote/scope link - ask the builder to send it.",
    ),
  );
});

// ── portalRecheckEligible ──────────────────────────────────────────────────
const PORTAL_LINK = {
  label: "Roof report link",
  url: "https://primeeco.tech/share/942b7548-3065-4ad5-9528-8cb04d655b1e",
  kind: "roof_report",
};

Deno.test("queue: unverified report card with a portal link on an active job -> eligible", () => {
  assertEquals(
    portalRecheckEligible({
      jobStatus: "accepted",
      isReportType: true,
      externalLinks: [PORTAL_LINK],
      currentCycle: 1,
      verifiedAt: null,
      verifiedCycle: null,
    }),
    true,
  );
});

Deno.test("queue: a graf card at ready_to_invoice but UNVERIFIED is still in the queue (prime recheck case)", () => {
  assertEquals(
    portalRecheckEligible({
      jobStatus: "accepted",
      isReportType: true,
      externalLinks: [PORTAL_LINK],
      currentCycle: 1,
      verifiedAt: null,
      verifiedCycle: null,
    }),
    true,
  );
});

Deno.test("queue: verified-this-cycle card is NOT eligible", () => {
  assertEquals(
    portalRecheckEligible({
      jobStatus: "accepted",
      isReportType: true,
      externalLinks: [PORTAL_LINK],
      currentCycle: 1,
      verifiedAt: "2026-07-07T00:00:00Z",
      verifiedCycle: 1,
    }),
    false,
  );
});

Deno.test("queue: non-report card / no portal link / dead job -> NOT eligible", () => {
  assertEquals(
    portalRecheckEligible({
      jobStatus: "accepted",
      isReportType: false,
      externalLinks: [PORTAL_LINK],
      currentCycle: 1,
      verifiedAt: null,
      verifiedCycle: null,
    }),
    false,
  );
  assertEquals(
    portalRecheckEligible({
      jobStatus: "accepted",
      isReportType: true,
      externalLinks: [],
      currentCycle: 1,
      verifiedAt: null,
      verifiedCycle: null,
    }),
    false,
  );
  assertEquals(
    portalRecheckEligible({
      jobStatus: "cancelled",
      isReportType: true,
      externalLinks: [PORTAL_LINK],
      currentCycle: 1,
      verifiedAt: null,
      verifiedCycle: null,
    }),
    false,
  );
});

// ── portalRecheckDue: enqueue rate limit ───────────────────────────────────
Deno.test("queue: never-enqueued card is due; re-enqueue only after the cadence window", () => {
  const now = Date.parse("2026-07-07T12:00:00Z");
  const sixHours = 6 * 3600_000;
  assert(portalRecheckDue(null, now, sixHours), "never enqueued -> due");
  assert(
    portalRecheckDue("2026-07-07T05:00:00Z", now, sixHours),
    "7h ago -> due",
  );
  assertEquals(
    portalRecheckDue("2026-07-07T09:00:00Z", now, sixHours),
    false,
    "3h ago -> not due",
  );
  assert(
    portalRecheckDue("garbage-timestamp", now, sixHours),
    "unparseable -> treat as due (fail open on the marker only)",
  );
});

// ── M-G FIX 1: reportInSatisfied (physical make-safe report-in) ─────────────
Deno.test("reportIn: non-make-safe job is always satisfied (guard no-ops)", () => {
  assert(
    reportInSatisfied({
      isMakesafe: false,
      isReportType: false,
      currentCycle: 1,
      hasCurrentCycleReport: false,
      hasReportDoc: false,
    }),
    "no makesafe detail row -> never gated (ordinary patio/fence invoice)",
  );
});

Deno.test("reportIn: report-type card is satisfied here (portal guard owns it)", () => {
  assert(
    reportInSatisfied({
      isMakesafe: true,
      isReportType: true,
      currentCycle: 1,
      hasCurrentCycleReport: false,
      hasReportDoc: false,
    }),
  );
});

Deno.test("reportIn: physical make-safe with NO report is NOT satisfied", () => {
  assertEquals(
    reportInSatisfied({
      isMakesafe: true,
      isReportType: false,
      currentCycle: 2,
      hasCurrentCycleReport: false,
      hasReportDoc: false,
    }),
    false,
  );
});

Deno.test("reportIn: physical make-safe satisfied by a current-cycle service report", () => {
  assert(
    reportInSatisfied({
      isMakesafe: true,
      isReportType: false,
      currentCycle: 2,
      hasCurrentCycleReport: true,
      hasReportDoc: false,
    }),
  );
});

Deno.test("reportIn: physical make-safe satisfied by a typed makesafe_report doc", () => {
  assert(
    reportInSatisfied({
      isMakesafe: true,
      isReportType: false,
      currentCycle: 1,
      hasCurrentCycleReport: false,
      hasReportDoc: true,
    }),
    "the skill files the report as a typed doc, not a service-report row",
  );
});

// ── M-G FIX 1: substatusAdvanceNeedsReportIn ────────────────────────────────
Deno.test("reportIn: only PHYSICAL make-safe advances to a report-complete substatus are gated", () => {
  const physical = { isMakesafe: true, isReportType: false };
  for (const s of PORTAL_GUARDED_ADVANCE_SUBSTATUSES) {
    assert(
      substatusAdvanceNeedsReportIn(s, physical),
      `${s} on a physical card is gated`,
    );
  }
  // pre-report substatuses are free
  assertEquals(
    substatusAdvanceNeedsReportIn("waiting_on_trade_report", physical),
    false,
  );
  assertEquals(
    substatusAdvanceNeedsReportIn("company_contact_done", physical),
    false,
  );
  // report-type cards are owned by the portal guard, not this one
  assertEquals(
    substatusAdvanceNeedsReportIn("ready_to_invoice", {
      isMakesafe: true,
      isReportType: true,
    }),
    false,
  );
  // non-make-safe jobs are never gated
  assertEquals(
    substatusAdvanceNeedsReportIn("ready_to_invoice", {
      isMakesafe: false,
      isReportType: false,
    }),
    false,
  );
});

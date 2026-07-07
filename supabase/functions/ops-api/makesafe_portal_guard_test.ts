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
  substatusAdvanceNeedsPortalVerification,
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

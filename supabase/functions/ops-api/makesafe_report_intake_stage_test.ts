// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// F4 — a freshly approved report-only card must NOT be born in Report Ready.
//
// The defect: `approveIntakeDraft` wrote `substatus: 'ready_to_invoice'` for every
// report-only card, and the legacy ladder reads `ready_to_invoice` as
// submitted-report evidence (index.ts:13458) and derives `report_ready`
// (index.ts:13526). So a roof / assessment card claimed to be report-ready before
// anyone proved the builder's Prime portal report was completed.
//
// The fix: intake writes MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION, and BOTH
// stage engines place that state in Allocated — the destination the captain ruled
// on. These tests pin:
//
//   1. a fresh roof card and a fresh assessment card land in `allocated` under the
//      legacy ladder AND under M1 (`computeMakesafeStatus`), with and without a
//      builder portal link on the card;
//   2. nothing advances them without an explicit portal-completion evidence
//      event — link presence, a draft invoice, a pack row, and time all leave the
//      card exactly where it was;
//   3. the intake approval path no longer writes `ready_to_invoice`;
//   4. legacy `ready_to_invoice` semantics are UNCHANGED — this change is
//      forward-only and must not move a single existing card.
//
// The v2 state projection's own recognition of this substatus (canonical, so it
// can never raise `projection_input_error`, and expected stage Allocated) is
// pinned in makesafe_state_projection_test.ts, next to that module's fixture.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _deriveMakesafeBoardStage } from "./index.ts";
import {
  computeMakesafeStatus,
  MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION,
} from "./makesafe_computed_status.ts";
import { PORTAL_GUARDED_ADVANCE_SUBSTATUSES } from "./makesafe_portal_guard.ts";

const WAITING = MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION;

// A card exactly as `approveIntakeDraft` leaves it: jobs.status 'accepted' from
// createMakesafeJob, the persisted report_type, the report-only waiting substatus,
// and whatever builder links intake captured. No assignment, no report row, no
// pack, no invoice, no portal capture.
function freshReportCard(
  family: "roof_report" | "assessment_report",
  externalLinks: any[] = [],
) {
  return {
    job: {
      status: "accepted",
      metadata: { makesafe_job_family: family },
    },
    detail: {
      substatus: WAITING,
      report_type: family,
      cycle_number: 1,
      external_links: externalLinks,
    },
  };
}

const ROOF_LINK = [{
  role: "roof_report",
  kind: "roof_report",
  url: "https://portal.example.test/wo/roof",
}];
const ASSESSMENT_LINKS = [
  {
    role: "assessment_report",
    kind: "assessment_report",
    url: "https://portal.example.test/wo/assessment",
  },
  {
    role: "photos",
    kind: "photos",
    url: "https://portal.example.test/wo/pics",
  },
  { role: "quote", kind: "quote", url: "https://portal.example.test/wo/quote" },
];

function m1(card: ReturnType<typeof freshReportCard>, evidence: any = {}) {
  return computeMakesafeStatus({
    job: card.job,
    detail: card.detail,
    evidence: { assignments: [], ...evidence },
    nowIso: "2026-08-02T04:00:00Z",
  });
}

function legacy(card: ReturnType<typeof freshReportCard>) {
  return _deriveMakesafeBoardStage(card.job, card.detail, [], null, null);
}

// ── 1. Both engines agree: a freshly approved report card is Allocated ────────

Deno.test("F4: a freshly approved ROOF card lands in Allocated under both engines", () => {
  for (const links of [[], ROOF_LINK]) {
    const card = freshReportCard("roof_report", links);
    assertEquals(legacy(card), "allocated");
    const computed = m1(card);
    assertEquals(computed.status, "allocated");
    assertEquals(computed.job_type, "roof_report");
  }
});

Deno.test("F4: a freshly approved ASSESSMENT card lands in Allocated under both engines", () => {
  for (const links of [[], ASSESSMENT_LINKS]) {
    const card = freshReportCard("assessment_report", links);
    assertEquals(legacy(card), "allocated");
    const computed = m1(card);
    assertEquals(computed.status, "allocated");
    assertEquals(computed.job_type, "assessment_report_quote");
  }
});

Deno.test("F4: the waiting state alone carries Allocated in M1 — no assignment is faked", () => {
  // A link-less roof card would be M1 `new` on the pre-F4 code path (no
  // assignment row, and the portal-link branch has nothing to read). It is
  // `allocated` now because of the persisted waiting state, and the reason says
  // so — it never claims an assignment or a completed report.
  const card = freshReportCard("roof_report", []);
  const computed = m1(card);
  assertEquals(computed.status, "allocated");
  assert(
    computed.reasons.some((r) => r.includes("awaiting proof")),
    `expected a waiting-state reason, got ${JSON.stringify(computed.reasons)}`,
  );
  assert(
    !computed.reasons.some((r) => r.includes("assignment")),
    "the waiting state must not manufacture an assignment reason",
  );
  // The missing-evidence list still names the un-captured portal report.
  assert(
    computed.missing.length > 0,
    "portal evidence must still read missing",
  );
});

Deno.test("F4: the waiting state is NOT company_contact_done and NOT an assignment", () => {
  // Guard against the two shortcuts the brief forbids: reusing
  // `company_contact_done`, or minting a fake assignment to buy the mapping.
  assertEquals(String(WAITING) === "company_contact_done", false);
  const card = freshReportCard("roof_report", ROOF_LINK);
  assertEquals(card.detail.substatus, "awaiting_portal_completion");
  // Zero assignments in every fixture above; the legacy ladder still says
  // allocated purely from the substatus.
  assertEquals(
    _deriveMakesafeBoardStage(card.job, card.detail, []),
    "allocated",
  );
});

// ── 2. Nothing advances the card without an explicit completion event ─────────

Deno.test("F4: no non-completion signal advances a waiting report card", () => {
  const cases: Array<{ name: string; card: any; evidence: any }> = [
    {
      name: "portal links present but no capture",
      card: freshReportCard("roof_report", ROOF_LINK),
      evidence: {},
    },
    {
      name: "a portal capture that is NOT done",
      card: freshReportCard("roof_report", ROOF_LINK),
      evidence: {
        portalCaptures: [{
          role: "roof_report",
          status: "not_done",
          screenshot: "s.png",
          cycle_number: 1,
        }],
      },
    },
    {
      name: "a done capture with NO screenshot (an assertion, not proof)",
      card: freshReportCard("roof_report", ROOF_LINK),
      evidence: {
        portalCaptures: [{ role: "roof_report", status: "done" }],
      },
    },
    {
      name: "assessment with only one of three roles captured",
      card: freshReportCard("assessment_report", ASSESSMENT_LINKS),
      evidence: {
        portalCaptures: [{
          role: "photos",
          status: "done",
          screenshot: "s.png",
          locked: true,
          url: "https://portal.example.test/wo/pics",
          cycle_number: 1,
        }],
      },
    },
    {
      name: "a DRAFT invoice sitting on the card",
      card: freshReportCard("roof_report", ROOF_LINK),
      evidence: { invoiceStatus: "DRAFT" },
    },
    {
      name: "completion photos (a physical-family signal) on a report card",
      card: freshReportCard("roof_report", ROOF_LINK),
      evidence: { completionPhotoCount: 25 },
    },
  ];

  for (const { name, card, evidence } of cases) {
    assertEquals(
      m1(card, evidence).status,
      "allocated",
      `M1 moved on: ${name}`,
    );
    assertEquals(legacy(card), "allocated", `legacy moved on: ${name}`);
  }
});

Deno.test("F4: time alone never advances a waiting report card", () => {
  const card = freshReportCard("roof_report", ROOF_LINK);
  for (
    const nowIso of [
      "2026-08-02T04:00:00Z",
      "2026-09-02T04:00:00Z",
      "2027-08-02T04:00:00Z",
    ]
  ) {
    assertEquals(
      computeMakesafeStatus({
        job: card.job,
        detail: card.detail,
        evidence: { assignments: [] },
        nowIso,
      }).status,
      "allocated",
    );
    assertEquals(
      _deriveMakesafeBoardStage(card.job, card.detail, [], null, null, nowIso),
      "allocated",
    );
  }
});

Deno.test("F4: the ONLY way past Allocated stays the portal-verification-guarded advance", () => {
  // The waiting state is a PRE-report substatus, so it is deliberately not in the
  // guarded set (a card is free to sit here). Every substatus that would move the
  // card past Allocated IS guarded, which is what forces an explicit
  // portal-completion evidence event before any advance.
  //
  // SEAM: the future completion control hooks into
  // `markMakesafePortalReportDone` (ops-api/index.ts, action
  // `mark_makesafe_portal_report_done`). It records
  // makesafe_job_details.portal_verified_* for the current cycle and moves the
  // card to `admin_to_send_report`. That path already works from this state and
  // is intentionally NOT wired to anything automatic in this change.
  const guarded = PORTAL_GUARDED_ADVANCE_SUBSTATUSES as readonly string[];
  assert(
    !guarded.includes(WAITING),
    "the waiting state must not be portal-guarded on the way IN",
  );
  for (const next of ["admin_to_send_report", "ready_to_invoice", "complete"]) {
    assert(guarded.includes(next), `${next} must stay portal-guarded`);
  }

  // And the destination of that event does derive past Allocated, proving the
  // seam is live rather than a dead end.
  const advanced = freshReportCard("roof_report", ROOF_LINK);
  advanced.detail.substatus = "admin_to_send_report";
  (advanced.detail as any).report_received_at = "2026-08-02T05:00:00Z";
  assertEquals(legacy(advanced), "trade_report_in");
});

// ── 3. Intake no longer writes ready_to_invoice ───────────────────────────────
//
// (The v2 state projection's own recognition of this substatus is pinned in
// makesafe_state_projection_test.ts, next to that module's `baseInput()`.)

Deno.test("F4: approveIntakeDraft parks report-only cards in the waiting state, not ready_to_invoice", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  // The privileged opt-out flag survives (it still means "start unsubmitted").
  assert(source.includes("body?.report_unsubmitted === true"));
  // The old write is gone.
  assert(
    !source.includes("{ substatus: 'ready_to_invoice' }"),
    "intake must no longer write ready_to_invoice for report-only cards",
  );
  // The new write is present.
  assert(
    source.includes(
      "{ substatus: MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION }",
    ),
    "intake must park report-only cards in the waiting state",
  );
});

// ── 4. Existing cards consume the stricter deterministic gate ─────────────────

Deno.test("F4: legacy ready_to_invoice without a current DRAFT derives allocated", () => {
  assertEquals(
    _deriveMakesafeBoardStage({ status: "accepted" }, {
      substatus: "ready_to_invoice",
      report_type: "roof_report",
    }),
    "allocated",
  );
  // …and the other pre-existing mappings are unchanged.
  assertEquals(
    _deriveMakesafeBoardStage({ status: "accepted" }, {
      substatus: "company_contact_required",
    }),
    "new",
  );
  assertEquals(
    _deriveMakesafeBoardStage({ status: "accepted" }, {
      substatus: "company_contact_done",
    }),
    "allocated",
  );
  assertEquals(
    _deriveMakesafeBoardStage({ status: "accepted" }, {
      substatus: "waiting_on_trade_report",
    }),
    "allocated",
  );
});

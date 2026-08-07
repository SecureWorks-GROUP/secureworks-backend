// deno-lint-ignore-file no-import-prefix no-explicit-any
// Item-14 portal-truth guard — the ledger source.
//
// The guard used to read `makesafe_job_details.portal_verified_at` /
// `.portal_verified_cycle` and nothing else. Those two columns have exactly one
// writer (`mark_makesafe_portal_report_done`), while the portal observer and the
// trade attestation record their captures in the append-only
// `makesafe_portal_capture_revisions` ledger and stamp no column. So a card
// could hold a verified, current-cycle, compliant capture and still be refused
// for having "no portal-locked verification" — measured live 2026-08-07 on three
// roof cards (SWMS-261116 / SWMS-261079 / SWMS-261019).
//
// This change points the guard at the ledger. It makes cards MORE eligible,
// which is the opposite direction from a normal guard fix, so the negative cases
// carry the weight here: a card with NO capture, and a card with a PRIOR-CYCLE
// capture only, must both still be refused. Each disqualifying coordinate the
// board read model validates is exercised as its own refusal, so "the guard
// consults the ledger" can never quietly become "the guard trusts the ledger".
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assertMakesafePortalVerifiedForAdvance,
  _assertMakesafePortalVerifiedForDraftInvoice,
  _loadMakesafeLedgerPortalCaptureSatisfied,
  _loadMakesafePortalVerification,
} from "./index.ts";
import {
  ledgerPortalCapturesSatisfy,
  portalVerificationSatisfied,
  requiredPortalCaptureRoles,
} from "./makesafe_portal_guard.ts";

// ════════════════════════════════════════════════════════════
// Pure predicates
// ════════════════════════════════════════════════════════════

const doneRoof = {
  role: "roof_report",
  status: "done",
  locked: true,
  url: "https://primeeco.tech/share/aaaaaaaa-0000-0000-0000-000000000001",
};

Deno.test("requiredPortalCaptureRoles: roof floor, assessment triad, never empty", () => {
  assertEquals(requiredPortalCaptureRoles("roof_report"), ["roof_report"]);
  assertEquals(requiredPortalCaptureRoles("assessment_report"), [
    "assessment_report",
    "photos",
    "quote",
  ]);
  assertEquals(requiredPortalCaptureRoles("assessment_report_quote"), [
    "assessment_report",
    "photos",
    "quote",
  ]);
  // An unknown token falls to the roof floor, never to "nothing required" — a
  // report type nobody taught this function can only be gated, never waved on.
  assertEquals(requiredPortalCaptureRoles("something_new"), ["roof_report"]);
  assertEquals(requiredPortalCaptureRoles(null), ["roof_report"]);
});

Deno.test("ledgerPortalCapturesSatisfy: roof card is satisfied by one done+locked roof capture", () => {
  assert(ledgerPortalCapturesSatisfy("roof_report", [doneRoof]));
});

Deno.test("ledgerPortalCapturesSatisfy: NEGATIVE — no captures at all", () => {
  assertEquals(ledgerPortalCapturesSatisfy("roof_report", []), false);
  assertEquals(ledgerPortalCapturesSatisfy("roof_report", null), false);
  assertEquals(ledgerPortalCapturesSatisfy("roof_report", undefined), false);
});

Deno.test("ledgerPortalCapturesSatisfy: NEGATIVE — capture is not done / not locked / has no url", () => {
  assertEquals(
    ledgerPortalCapturesSatisfy("roof_report", [{
      ...doneRoof,
      status: "not_done",
    }]),
    false,
  );
  assertEquals(
    ledgerPortalCapturesSatisfy("roof_report", [{
      ...doneRoof,
      status: "unreachable",
    }]),
    false,
  );
  assertEquals(
    ledgerPortalCapturesSatisfy("roof_report", [{
      ...doneRoof,
      locked: false,
    }]),
    false,
  );
  assertEquals(
    ledgerPortalCapturesSatisfy("roof_report", [{
      ...doneRoof,
      locked: "yes",
    }]),
    false,
  );
  assertEquals(
    ledgerPortalCapturesSatisfy("roof_report", [{ ...doneRoof, url: "" }]),
    false,
  );
});

Deno.test("ledgerPortalCapturesSatisfy: NEGATIVE — a generic/unknown capture role never satisfies", () => {
  // canonicalizeKind buckets anything unrecognised as `builder_portal`, which is
  // never a required role. A capture the reader could not classify must fail to
  // satisfy rather than accidentally satisfy.
  assertEquals(
    ledgerPortalCapturesSatisfy("roof_report", [{
      ...doneRoof,
      role: "builder_portal",
    }]),
    false,
  );
  assertEquals(
    ledgerPortalCapturesSatisfy("roof_report", [{ ...doneRoof, role: "" }]),
    false,
  );
});

Deno.test("ledgerPortalCapturesSatisfy: assessment needs all three members, not the roof shortcut", () => {
  const member = (role: string, n: number) => ({
    role,
    status: "done",
    locked: true,
    url: `https://primeeco.tech/share/bbbbbbbb-0000-0000-0000-00000000000${n}`,
  });
  // The whole point of the short-circuit in portalVerificationSatisfied is that
  // it is NOT a shortcut: an assessment card proving only a roof capture stays
  // unsatisfied.
  assertEquals(
    ledgerPortalCapturesSatisfy("assessment_report", [doneRoof]),
    false,
  );
  assertEquals(
    ledgerPortalCapturesSatisfy("assessment_report", [
      member("assessment_report", 1),
      member("photos", 2),
    ]),
    false,
  );
  assert(
    ledgerPortalCapturesSatisfy("assessment_report", [
      member("assessment_report", 1),
      member("photos", 2),
      member("quote", 3),
    ]),
  );
});

Deno.test("portalVerificationSatisfied: ledger evidence satisfies with both columns NULL", () => {
  const nullColumns = {
    isReportType: true,
    currentCycle: 1,
    verifiedAt: null,
    verifiedCycle: null,
  };
  // The production shape of the three cards: columns NULL, ledger sound.
  assert(portalVerificationSatisfied({
    ...nullColumns,
    ledgerCaptureSatisfied: true,
  }));
  // Status quo preserved in every other direction.
  assertEquals(
    portalVerificationSatisfied({
      ...nullColumns,
      ledgerCaptureSatisfied: false,
    }),
    false,
  );
  assertEquals(portalVerificationSatisfied(nullColumns), false);
  // A non-report card was never this guard's concern.
  assert(portalVerificationSatisfied({
    ...nullColumns,
    isReportType: false,
  }));
  // The column path is untouched.
  assert(portalVerificationSatisfied({
    isReportType: true,
    currentCycle: 2,
    verifiedAt: "2026-08-01T00:00:00Z",
    verifiedCycle: 2,
  }));
  assertEquals(
    portalVerificationSatisfied({
      isReportType: true,
      currentCycle: 2,
      verifiedAt: "2026-08-01T00:00:00Z",
      verifiedCycle: 1, // prior cycle stamp, current cycle 2
    }),
    false,
  );
});

Deno.test("portalVerificationSatisfied: ledger evidence does not bypass the assessment triad", () => {
  // ledgerCaptureSatisfied can only be true when ledgerPortalCapturesSatisfy
  // proved the full required-role set, so it short-circuits the stored-signal
  // assessment re-check without lowering the assessment bar. The guarantee that
  // matters is the one above (roof-only ledger evidence on an assessment card is
  // NOT satisfied); this pins that an assessment card with NO ledger evidence and
  // an unsatisfied stored proof still refuses.
  assertEquals(
    portalVerificationSatisfied({
      isReportType: true,
      currentCycle: 1,
      verifiedAt: "2026-08-01T00:00:00Z",
      verifiedCycle: 1,
      requiresAssessmentProof: true,
      assessmentProofSatisfied: false,
      ledgerCaptureSatisfied: false,
    }),
    false,
  );
});

// ════════════════════════════════════════════════════════════
// Integration — the real loader + guards over a mock PostgREST
// ════════════════════════════════════════════════════════════

const JOB_ID = "b7abfb20-6ab3-41fb-b5af-d65491bca38c";
const CURRENT_CYCLE_ID = "49d49556-abbd-40e6-9b9b-b8e00b153abc";
const PRIOR_CYCLE_ID = "11111111-2222-3333-4444-555555555555";
const PORTAL_URL =
  "https://primeeco.tech/share/94315179-8e98-48e1-a586-b116f3120000";
const REF = "MLB-27387";

// The card as production carries it: roof report, cycle 1, BOTH verification
// columns NULL, and its genuine portal link tagged `builder_portal` rather than
// `roof_report` (a link-detection gap a separate ticket owns — recorded here
// because it is why an earlier sweep did not see these captures).
function detailRow(overrides: Record<string, unknown> = {}) {
  return {
    job_id: JOB_ID,
    report_type: "roof_report",
    cycle_number: 1,
    attendance_cycle_id: CURRENT_CYCLE_ID,
    external_ref: REF,
    external_links: [
      { label: "Builder Portal", url: PORTAL_URL, kind: "builder_portal" },
      // The CDN pollution that sits beside it live. urlIsBuilderPortalLink
      // rejects these structurally; they must never become a portal member.
      {
        label: "Builder Portal",
        url: "https://documents.primeeco.tech/15276239-d244/logo.png",
        kind: "builder_portal",
      },
    ],
    portal_verified_at: null,
    portal_verified_cycle: null,
    portal_verified_signal: null,
    ...overrides,
  };
}

// A ledger row exactly as the three production cards carry it.
function captureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "be4d6912-b300-44bd-b2df-23cde0952c2d",
    job_id: JOB_ID,
    attendance_cycle_id: CURRENT_CYCLE_ID,
    role: "roof_report",
    capture_result: "done",
    status: "verified",
    source_url: PORTAL_URL,
    source_content_hash: `sha256:${"a".repeat(64)}`,
    builder_reference: REF,
    capture_producer: "capture_portal_evidence.py/v1",
    captured_by: "maverick",
    captured_at: "2026-08-03T13:19:28.000Z",
    signal: "form locked/submitted",
    screenshot_object_key:
      `makesafe-docket-artifacts/portal-captures/${JOB_ID}/${CURRENT_CYCLE_ID}/roof_report/${
        "b".repeat(64)
      }.png`,
    screenshot_media_type: "image/png",
    screenshot_content_hash: `sha256:${"b".repeat(64)}`,
    screenshot_size_bytes: 301547,
    makesafe_fact_version: 1,
    ...overrides,
  };
}

type Tables = {
  makesafe_job_details?: any[];
  jobs?: any[];
  makesafe_portal_capture_revisions?: any[];
};

function makeClient(tables: Tables, opts: { ledgerError?: any } = {}) {
  const reads: Array<{ table: string; eqs: Record<string, any> }> = [];
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const matchRows = () =>
      (tables[table as keyof Tables] || []).filter((r: any) =>
        Object.entries(eqs).every(([k, v]) => r[k] === v)
      );
    const api: any = {
      select() {
        return api;
      },
      eq(k: string, v: any) {
        eqs[k] = v;
        return api;
      },
      maybeSingle() {
        reads.push({ table, eqs: { ...eqs } });
        return Promise.resolve({ data: matchRows()[0] ?? null, error: null });
      },
      // Bare await on the builder (the ledger read).
      then(resolve: any, reject: any) {
        reads.push({ table, eqs: { ...eqs } });
        const result =
          table === "makesafe_portal_capture_revisions" && opts.ledgerError
            ? { data: null, error: opts.ledgerError }
            : { data: matchRows(), error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return api;
  }
  return { from: (t: string) => builder(t), _reads: reads } as any;
}

function baseTables(
  captures: any[],
  detailOverrides: Record<string, unknown> = {},
): Tables {
  return {
    makesafe_job_details: [detailRow(detailOverrides)],
    jobs: [{ id: JOB_ID, metadata: {} }],
    makesafe_portal_capture_revisions: captures,
  };
}

Deno.test("draft-invoice guard: PASS — a verified current-cycle ledger capture satisfies portal truth with both columns NULL", async () => {
  const client = makeClient(baseTables([captureRow()]));
  // The production shape. Before this change it threw 409 "no portal-locked
  // verification recorded".
  await _assertMakesafePortalVerifiedForDraftInvoice(client, JOB_ID);
  const state = await _loadMakesafePortalVerification(client, JOB_ID);
  assertEquals(state.verifiedAt, null);
  assertEquals(state.verifiedCycle, null);
  assertEquals(state.ledgerCaptureSatisfied, true);
});

Deno.test("substatus-advance guard: PASS — the same ledger capture satisfies the twin entry point", async () => {
  // Both entry points ARE the item-14 portal-truth guard, over one predicate.
  // Teaching one about the ledger and not the other is the very disease this
  // change exists to cure.
  const client = makeClient(baseTables([captureRow()]));
  await _assertMakesafePortalVerifiedForAdvance(
    client,
    JOB_ID,
    "ready_to_invoice",
  );
});

Deno.test("draft-invoice guard: NEGATIVE — a card with NO capture is still refused", async () => {
  const client = makeClient(baseTables([]));
  const err = await assertRejects(
    () => _assertMakesafePortalVerifiedForDraftInvoice(client, JOB_ID),
  ) as any;
  assertEquals(err.status, 409);
  assert(String(err.message).includes("portal-truth guard (item 14)"));
  assertEquals(
    await _loadMakesafeLedgerPortalCaptureSatisfied(
      client,
      JOB_ID,
      detailRow(),
      "roof_report",
    ),
    false,
  );
});

Deno.test("draft-invoice guard: NEGATIVE — a PRIOR-CYCLE capture never satisfies the current cycle", async () => {
  // The invariant that has broken three separate times in this campaign. It is
  // enforced twice and independently: the read below is narrowed to the card's
  // own attendance_cycle_id, AND portalCapturesFromLedger drops any row whose
  // attendance_cycle_id differs. Both are asserted.
  const priorOnly = captureRow({
    id: "prior-cycle-capture",
    attendance_cycle_id: PRIOR_CYCLE_ID,
  });
  const client = makeClient(baseTables([priorOnly]));
  const err = await assertRejects(
    () => _assertMakesafePortalVerifiedForDraftInvoice(client, JOB_ID),
  ) as any;
  assertEquals(err.status, 409);

  // (1) the read is scoped to the CURRENT cycle id.
  const ledgerRead = client._reads.find((r: any) =>
    r.table === "makesafe_portal_capture_revisions"
  );
  assert(ledgerRead, "the guard reads the capture ledger");
  assertEquals(ledgerRead.eqs.job_id, JOB_ID);
  assertEquals(ledgerRead.eqs.attendance_cycle_id, CURRENT_CYCLE_ID);

  // (2) even handed the prior-cycle row directly, the projection refuses it.
  assertEquals(
    await _loadMakesafeLedgerPortalCaptureSatisfied(
      makeClient({
        ...baseTables([priorOnly]),
        // Defeat the query filter so only the projection can refuse.
        makesafe_portal_capture_revisions: [{
          ...priorOnly,
          attendance_cycle_id: CURRENT_CYCLE_ID,
          _real_cycle: PRIOR_CYCLE_ID,
        }],
      }),
      JOB_ID,
      // The card's detail says its current cycle is the PRIOR id's successor;
      // the projection compares the row's own attendance_cycle_id to it.
      detailRow({ attendance_cycle_id: PRIOR_CYCLE_ID }),
      "roof_report",
    ),
    false,
  );
});

Deno.test("draft-invoice guard: NEGATIVE — a re-attend that opens a new cycle re-refuses a card that passed on the old one", async () => {
  const capture = captureRow();
  // Cycle 1: satisfied.
  await _assertMakesafePortalVerifiedForDraftInvoice(
    makeClient(baseTables([capture])),
    JOB_ID,
  );
  // Re-attend opens cycle 2. The SAME capture row is now prior-cycle evidence
  // and must stop satisfying — no carry-over.
  const reattended = makeClient(
    baseTables([capture], {
      cycle_number: 2,
      attendance_cycle_id: "99999999-8888-7777-6666-555555555555",
    }),
  );
  const err = await assertRejects(
    () => _assertMakesafePortalVerifiedForDraftInvoice(reattended, JOB_ID),
  ) as any;
  assertEquals(err.status, 409);
});

Deno.test("draft-invoice guard: NEGATIVE — each disqualifying ledger coordinate still refuses", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    // Producer trust is the sealed seam — an unapproved producer is not evidence.
    ["untrusted producer", { capture_producer: "some_other_tool/v1" }],
    // The portal form is not submitted.
    ["capture_result not_done", {
      capture_result: "not_done",
      status: "captured",
    }],
    ["capture_result unreachable", {
      capture_result: "unreachable",
      status: "rejected",
    }],
    // Row status and result must agree — a rejected row is not a done capture.
    ["status disagrees with result", { status: "rejected" }],
    ["status captured on a done result", { status: "captured" }],
    // The capture must belong to THIS card's builder instruction.
    ["builder_reference mismatch", { builder_reference: "MLB-99999" }],
    ["builder_reference empty", { builder_reference: "" }],
    // The captured URL must be one of the card's own genuine portal links.
    ["source_url not on the card", {
      source_url:
        "https://primeeco.tech/share/deadbeef-0000-0000-0000-000000000000",
    }],
    // Asset/CDN pollution is not a portal, even tagged builder_portal.
    ["source_url is CDN pollution on the card", {
      source_url: "https://documents.primeeco.tech/15276239-d244/logo.png",
    }],
    // The source fingerprint must be a real digest.
    ["source_content_hash malformed", { source_content_hash: "not-a-digest" }],
    // The observer producer always renders a page, so it always carries a PNG.
    ["observer capture with no screenshot", { screenshot_object_key: null }],
    ["observer screenshot not a png", { screenshot_media_type: "image/jpeg" }],
    ["observer screenshot zero bytes", { screenshot_size_bytes: 0 }],
    ["observer screenshot outside the capture bucket path", {
      screenshot_object_key: "some-other-bucket/whatever.png",
    }],
    // A role this card does not require.
    ["wrong role for a roof card", { role: "photos" }],
    // The row belongs to another job.
    ["job_id mismatch", { job_id: "00000000-0000-0000-0000-000000000000" }],
  ];
  for (const [label, overrides] of cases) {
    const client = makeClient(baseTables([captureRow(overrides)]));
    const err = await assertRejects(
      () => _assertMakesafePortalVerifiedForDraftInvoice(client, JOB_ID),
      Error,
      "portal-truth guard (item 14)",
      `expected refusal: ${label}`,
    ) as any;
    assertEquals(err.status, 409, label);
  }
});

Deno.test("draft-invoice guard: NEGATIVE — an unreadable ledger fails CLOSED", async () => {
  // A read fault must never be the reason a card becomes invoiceable. This is
  // exactly the pre-change behaviour, which is the point.
  const client = makeClient(baseTables([captureRow()]), {
    ledgerError: { code: "42P01", message: "relation does not exist" },
  });
  const err = await assertRejects(
    () => _assertMakesafePortalVerifiedForDraftInvoice(client, JOB_ID),
  ) as any;
  assertEquals(err.status, 409);
});

Deno.test("draft-invoice guard: NEGATIVE — a card with no current attendance cycle reads no ledger evidence", async () => {
  const client = makeClient(baseTables([captureRow()], {
    attendance_cycle_id: null,
  }));
  const err = await assertRejects(
    () => _assertMakesafePortalVerifiedForDraftInvoice(client, JOB_ID),
  ) as any;
  assertEquals(err.status, 409);
});

Deno.test("draft-invoice guard: an assessment card is NOT satisfied by a roof-only ledger capture", async () => {
  const client = makeClient(
    baseTables([captureRow()], { report_type: "assessment_report" }),
  );
  const err = await assertRejects(
    () => _assertMakesafePortalVerifiedForDraftInvoice(client, JOB_ID),
  ) as any;
  assertEquals(err.status, 409);
});

Deno.test("draft-invoice guard: a non-report make-safe is untouched by the ledger path", async () => {
  const client = makeClient(
    baseTables([], {
      report_type: null,
      attendance_cycle_id: CURRENT_CYCLE_ID,
    }),
  );
  // Physical make-safes were never gated here and must not start reading the
  // ledger at all.
  await _assertMakesafePortalVerifiedForDraftInvoice(client, JOB_ID);
  assertEquals(
    client._reads.some((r: any) =>
      r.table === "makesafe_portal_capture_revisions"
    ),
    false,
  );
});

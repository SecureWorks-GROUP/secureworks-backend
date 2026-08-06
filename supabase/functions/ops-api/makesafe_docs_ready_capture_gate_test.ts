// deno-lint-ignore-file no-import-prefix no-explicit-any
/**
 * Docs Ready capture gate.
 *
 * Every assertion runs the REAL board read model, so the two halves the gate
 * exists for are proved together: a card the system's own computation calls
 * unready leaves the column, and it says what it is missing on the way out.
 *
 * The load-bearing ones, in the order a reviewer should read them:
 *   - the gate and `computed_status` cannot disagree (same shared functions),
 *   - placement is identical in card and full mode,
 *   - a family with no capture opinion and an unreadable ledger both move
 *     nothing, and neither reads as a failing verdict,
 *   - the gate can only subtract from Docs Ready, never add to it.
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCanonicalMakesafeRows,
  docsReadyCaptureGateJobIdsForBoard,
  OPS_MAKESAFE_STAGE_LABELS,
  OPS_MAKESAFE_STAGES,
  projectOpsMakesafeBoard,
} from "./makesafe_board_read_model.ts";
import {
  DOCS_READY_CAPTURE_BLOCKER_CODE,
  DOCS_READY_CAPTURE_GATE_REASONS,
  DOCS_READY_CAPTURE_GATE_VERSION,
  docsReadyCaptureGateBlockers,
  evaluateDocsReadyCaptureGate,
} from "./makesafe_docs_ready_capture_gate.ts";
import { computeMakesafeStatus } from "./makesafe_computed_status.ts";

const NOW = "2026-08-06T02:00:00Z";
const JOB_ID = "11111111-1111-4111-8111-111111111111";

const ASSESSMENT_LINKS = [
  { role: "assessment_report", url: "https://prime.example/a", status: "open" },
  { role: "photos", url: "https://prime.example/p", status: "open" },
  { role: "quote", url: "https://prime.example/q", status: "open" },
];

/**
 * A card the declared ladder has already placed in Docs Ready — the exact
 * shape production showed 11 of 13 times on 2026-08-06.
 */
function docsReadyCard(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    job_number: "SWMS-TEST-DR",
    type: "makesafe",
    status: "scheduled",
    board_stage: "report_ready",
    board_label: "Report Ready",
    site_suburb: "Testville",
    assignments: [{ id: "assign-1", status: "accepted" }],
    metadata: { makesafe_job_family: "assessment_report" },
    makesafe_details: {
      report_type: "assessment_report",
      cycle_number: 1,
      substatus: "awaiting_portal_completion",
      external_links: ASSESSMENT_LINKS,
    },
    invoice_qualifies_as_current_draft: true,
    invoice_raw_status: "DRAFT",
    ...over,
  } as any;
}

/** A locked, typed, screenshot-proven capture for one role of that card. */
function provenCapture(role: string) {
  return {
    role,
    kind: role,
    status: "done",
    locked: true,
    url: role === "assessment_report"
      ? "https://prime.example/a"
      : role === "photos"
      ? "https://prime.example/p"
      : "https://prime.example/q",
    screenshot: "stored",
    cycle_number: 1,
  };
}

/**
 * The genuinely-ready shape: all three captures proven AND a READY draft pack,
 * which is what `docsReady()` requires of an assessment card. Both halves are
 * needed — captures alone leave M1 at `trade_report_in`, and the gate consumes
 * M1's answer rather than second-guessing it.
 */
function allThreeProven() {
  return {
    ...docsReadyCard(),
    report_pack: { review_state: "READY", docket_revision_id: "docket-ok" },
    makesafe_details: {
      ...docsReadyCard().makesafe_details,
      portal_captures: [
        provenCapture("assessment_report"),
        provenCapture("photos"),
        provenCapture("quote"),
      ],
    },
  };
}

Deno.test("an assessment card short of its triad leaves Docs Ready and names every capture", () => {
  const [row] = buildCanonicalMakesafeRows([docsReadyCard()], {
    computedAt: NOW,
  });

  assertEquals(row.declared_stage, "report_ready");
  assertNotEquals(row.canonical_stage, "report_ready");
  assertEquals(row.docs_ready_capture_gate.applies, true);
  assertEquals(row.docs_ready_capture_gate.satisfied, false);
  assertEquals(
    row.docs_ready_capture_gate.reason,
    DOCS_READY_CAPTURE_GATE_REASONS.belowDocsReady,
  );
  assertEquals(
    row.docs_ready_capture_gate.computed_status,
    row.computed_status,
  );
  assertEquals(row.docs_ready_capture_gate.held_from_stage, "report_ready");
  assertEquals(
    row.docs_ready_capture_gate.held_to_stage,
    row.canonical_stage,
  );
  assertEquals(
    row.docs_ready_capture_gate.version,
    DOCS_READY_CAPTURE_GATE_VERSION,
  );

  // All three, each naming its own role rather than a generic count.
  assertEquals(row.docs_ready_capture_gate.missing.length, 3);
  for (const label of ["assessment", "photos", "quote/scope"]) {
    assert(
      row.docs_ready_capture_gate.missing.some((m: string) =>
        m.includes(label)
      ),
      `missing list never names ${label}: ${
        JSON.stringify(row.docs_ready_capture_gate.missing)
      }`,
    );
  }

  // The label follows the placement — a held card must not keep "Report Ready".
  assertEquals(
    row.canonical_stage_label,
    OPS_MAKESAFE_STAGE_LABELS[row.canonical_stage as never],
  );
  assertNotEquals(row.canonical_stage_label, "Report Ready");
});

Deno.test("a removed card carries its missing captures as operator blockers", () => {
  const [row] = buildCanonicalMakesafeRows([docsReadyCard()], {
    computedAt: NOW,
  });
  const capture = row.blockers.real.filter((b: any) =>
    b.code === DOCS_READY_CAPTURE_BLOCKER_CODE
  );
  assertEquals(capture.length, 3);
  assertEquals(row.blockers.blocked, true);
  for (const blocker of capture) {
    assert(blocker.fact.length > 0);
    assert(blocker.recovery_action.includes("Docs Ready"));
    assertEquals(blocker.held_from_stage, "report_ready");
    assertEquals(blocker.held_to_stage, row.canonical_stage);
  }
  // Every sentence on the card is a sentence from the gate — one wording.
  assertEquals(
    capture.map((b: any) => b.fact),
    row.docs_ready_capture_gate.missing,
  );
});

Deno.test("the gate's verdict and computed_status are the same reading", () => {
  // Short of captures: the held destination IS what M1 computes, because both
  // come from `deriveMakesafeEvidenceStage`.
  const [held] = buildCanonicalMakesafeRows([docsReadyCard()], {
    computedAt: NOW,
  });
  assertEquals(held.canonical_stage, held.computed_status);
  assertNotEquals(held.computed_status, "report_ready");
  assertEquals(
    held.docs_ready_capture_gate.missing,
    held.computed_status_missing,
  );

  // Captures proven: the gate is satisfied and stops mattering.
  const [ready] = buildCanonicalMakesafeRows([allThreeProven()], {
    computedAt: NOW,
  });
  assertEquals(ready.canonical_stage, "report_ready");
  assertEquals(ready.docs_ready_capture_gate.satisfied, true);
  assertEquals(ready.docs_ready_capture_gate.held_to_stage, null);
  assertEquals(ready.canonical_stage_label, "Report Ready");
});

Deno.test("placement is identical in card and full mode", () => {
  for (const card of [docsReadyCard(), allThreeProven()]) {
    const extras = {
      computedAt: NOW,
      portalCaptureRowsByJobId: {},
      portalCaptureEvidenceReadable: true,
    };
    const [full] = buildCanonicalMakesafeRows([card], extras, "full");
    const [slim] = buildCanonicalMakesafeRows([card], extras, "card");
    assertEquals(slim.canonical_stage, full.canonical_stage);
    assertEquals(slim.canonical_stage_label, full.canonical_stage_label);
    assertEquals(
      slim.docs_ready_capture_gate,
      full.docs_ready_capture_gate,
    );
    // Card mode carries the operator explanation too; it is not a full-mode
    // diagnostic. A card that vanishes must say why on the surface it vanished
    // from.
    assertEquals(slim.blockers.real, full.blockers.real);
  }
});

Deno.test("no computed verdict is never treated as not-ready", () => {
  // 1. A family the capture rule does not cover keeps today's placement, and
  //    says so structurally rather than silently passing.
  const physical = docsReadyCard({
    metadata: { makesafe_job_family: "physical_makesafe" },
    makesafe_details: {
      report_type: "physical_makesafe",
      cycle_number: 1,
      external_links: [],
    },
  });
  const [physicalRow] = buildCanonicalMakesafeRows([physical], {
    computedAt: NOW,
  });
  assertEquals(physicalRow.canonical_stage, "report_ready");
  assertEquals(physicalRow.docs_ready_capture_gate.applies, false);
  assertEquals(physicalRow.docs_ready_capture_gate.satisfied, null);
  assertEquals(physicalRow.docs_ready_capture_gate.missing, []);

  // 2. An unreadable capture ledger yields NO verdict, so it moves nothing.
  //    Identical inputs otherwise — only the readability flag differs, which is
  //    exactly the ambiguity an empty capture list cannot resolve.
  const [unreadable] = buildCanonicalMakesafeRows([docsReadyCard()], {
    computedAt: NOW,
    portalCaptureEvidenceReadable: false,
  });
  assertEquals(unreadable.canonical_stage, "report_ready");
  assertEquals(unreadable.docs_ready_capture_gate.applies, true);
  assertEquals(unreadable.docs_ready_capture_gate.satisfied, null);
  assertEquals(
    unreadable.docs_ready_capture_gate.reason,
    DOCS_READY_CAPTURE_GATE_REASONS.unreadable,
  );
  assertEquals(unreadable.docs_ready_capture_gate.missing, []);
  assertEquals(
    docsReadyCaptureGateBlockers(unreadable.docs_ready_capture_gate),
    [],
  );
});

Deno.test("the gate only ever subtracts from Docs Ready", () => {
  for (const stage of OPS_MAKESAFE_STAGES) {
    if (stage === "report_ready") continue;
    const card = docsReadyCard({ board_stage: stage, board_label: stage });
    const [row] = buildCanonicalMakesafeRows([card], { computedAt: NOW });
    assertEquals(row.docs_ready_capture_gate.applies, false);
    assertEquals(row.docs_ready_capture_gate.held_to_stage, null);
    assertNotEquals(row.canonical_stage, "report_ready");
    // Label untouched for every stage the gate has no opinion on.
    assertEquals(row.canonical_stage_label, stage);
  }
});

Deno.test("the column census and the ops projection both follow the gate", () => {
  const board = projectOpsMakesafeBoard(
    buildCanonicalMakesafeRows(
      [
        docsReadyCard(),
        {
          ...allThreeProven(),
          id: "22222222-2222-4222-8222-222222222222",
          job_number: "SWMS-TEST-OK",
        },
      ],
      { computedAt: NOW },
    ),
  );
  assertEquals(board.columns.report_ready.length, 1);
  assertEquals(board.columns.report_ready[0].job_number, "SWMS-TEST-OK");
  const held = [
    ...board.columns.allocated,
    ...board.columns.trade_report_in,
    ...board.columns.new,
  ];
  assertEquals(held.length, 1);
  assertEquals(held[0].job_number, "SWMS-TEST-DR");
});

Deno.test("the loader reads captures for exactly the cards the gate can move", () => {
  const overlayId = "33333333-3333-4333-8333-333333333333";
  const rows = [
    docsReadyCard(),
    // Physical family in Docs Ready — no capture opinion, so no read.
    docsReadyCard({
      id: "44444444-4444-4444-8444-444444444444",
      metadata: { makesafe_job_family: "physical_makesafe" },
      makesafe_details: { report_type: "physical_makesafe", cycle_number: 1 },
    }),
    // Report family somewhere else on the board — not a candidate.
    docsReadyCard({
      id: "55555555-5555-4555-8555-555555555555",
      board_stage: "allocated",
    }),
    // Report family an overlay is moving INTO Docs Ready — is a candidate.
    docsReadyCard({ id: overlayId, board_stage: "allocated" }),
  ];
  const ids = docsReadyCaptureGateJobIdsForBoard(rows, {
    [overlayId]: { after_status: "report_ready" },
  });
  assertEquals(ids, [JOB_ID, overlayId]);
  // An empty Docs Ready column issues no read at all.
  assertEquals(
    docsReadyCaptureGateJobIdsForBoard(
      [docsReadyCard({ board_stage: "allocated" })],
      {},
    ),
    [],
  );
});

function roofCard(over: Record<string, unknown> = {}) {
  return docsReadyCard({
    metadata: { makesafe_job_family: "roof_report" },
    makesafe_details: {
      report_type: "roof_report",
      cycle_number: 1,
      substatus: "awaiting_portal_completion",
      external_links: [{
        role: "roof_report",
        url: "https://prime.example/r",
        status: "open",
      }],
    },
    ...over,
  });
}

Deno.test("a roof card needs its one capture; the pure gate agrees with M1", () => {
  const roof = roofCard();
  const [row] = buildCanonicalMakesafeRows([roof], { computedAt: NOW });
  assertEquals(row.docs_ready_capture_gate.satisfied, false);
  assertEquals(row.docs_ready_capture_gate.missing.length, 1);
  assert(row.docs_ready_capture_gate.missing[0].includes("roof report"));
  assertNotEquals(row.canonical_stage, "report_ready");

  // Called directly, off the same input M1 consumes, both agree — the gate is
  // not a second engine with its own opinion.
  const input = {
    job: roof,
    detail: roof.makesafe_details,
    evidence: {
      assignments: roof.assignments,
      portalCaptures: [],
      invoiceQualifiesAsCurrentDraft: true,
      invoiceStatus: "DRAFT",
    },
  };
  const gateResult = evaluateDocsReadyCaptureGate({
    displayStage: "report_ready",
    input,
    captureEvidenceReadable: true,
  });
  const m1 = computeMakesafeStatus({ ...input, nowIso: NOW });
  assertEquals(gateResult.held_to_stage, m1.status);
  assertEquals(gateResult.missing, m1.missing);
});

Deno.test("the gate defers to M1's roof pack shortcut instead of out-stricting it", () => {
  // `docsReady()` accepts a roof card whose draft-pack record is READY without
  // re-checking its portal capture. Two live cards sat on exactly this branch
  // on 2026-08-06 (SWMS-261114, SWMS-261081): `computed_status: report_ready`
  // with no proven capture. Reading the capture evidence directly here would
  // evict them under a rule stricter than the system computes; the roof
  // question belongs to the roof-exemption work, not to this gate.
  const roof = roofCard({
    report_pack: { review_state: "READY", docket_revision_id: "docket-1" },
  });
  const [row] = buildCanonicalMakesafeRows([roof], { computedAt: NOW });

  assertEquals(row.computed_status, "report_ready");
  // The engine itself has no capture proof for this card...
  assertEquals(
    row.computed_status_evidence.has_current_portal_capture,
    false,
  );
  // ...and the gate still leaves it in Docs Ready, because the engine did.
  assertEquals(row.canonical_stage, "report_ready");
  assertEquals(row.docs_ready_capture_gate.satisfied, true);
  assertEquals(row.docs_ready_capture_gate.computed_status, "report_ready");
  assertEquals(row.docs_ready_capture_gate.missing, []);
});

Deno.test("a card the engine puts PAST Docs Ready is not a card short of it", () => {
  // Completed / archived / cancelled are ahead of ready, not behind it. The
  // gate records no verdict rather than dragging such a card backwards.
  const settled = roofCard({ status: "completed" });
  const [row] = buildCanonicalMakesafeRows([settled], { computedAt: NOW });
  assertEquals(row.computed_status, "completed");
  assertEquals(row.canonical_stage, "report_ready");
  assertEquals(row.docs_ready_capture_gate.applies, true);
  assertEquals(row.docs_ready_capture_gate.satisfied, null);
  assertEquals(
    row.docs_ready_capture_gate.reason,
    DOCS_READY_CAPTURE_GATE_REASONS.ahead,
  );
  assertEquals(row.docs_ready_capture_gate.missing, []);
});

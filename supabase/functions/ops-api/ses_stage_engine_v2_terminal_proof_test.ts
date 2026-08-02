// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// R7 — the `makesafe_terminal_proofs` evidence contract, read by the corrected
// shadow stage engine.
//
// The fixture is SWMS-261059's real shape: `jobs.status = 'complete'`, no
// LINKED issued invoice, no current-cycle service report, no completion photos,
// no assignment. That card was the sole `decision_required` blocker on the
// cutover gate, and the captain answered it by signing the job off on
// 2026-08-02. These tests pin BOTH halves: the card is still refused with no
// proof, and a bound proof — not a hand-written stage — is what places it.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeMakesafeStatus } from "./makesafe_computed_status.ts";
import {
  bindingMakesafeTerminalProof,
  makesafeAttendanceCycleSetHash,
  makesafeTerminalProofCoversCycleSet,
} from "./makesafe_terminal_proof.ts";
import {
  deriveSesStageV2,
  SES_STAGE_DECISION_REQUIRED,
  sesStageBindingTerminalProof,
  sesStageCutoverGate,
} from "./ses_stage_engine_v2.ts";

const NOW = "2026-08-02T00:00:00.000Z";
const daysAgo = (days: number) =>
  new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

const CYCLE_1 = "cycle-0000-0000-0000-000000000001";
const CYCLE_2 = "cycle-0000-0000-0000-000000000002";

/** SWMS-261059's shape: a raw terminal claim with nothing corroborating it. */
function manuallyCompletedCard(over: Record<string, any> = {}): any {
  return {
    job: {
      status: "complete",
      completed_at: daysAgo(2),
      metadata: { makesafe_job_family: "physical_makesafe" },
    },
    detail: { cycle_number: 1, attendance_cycle_id: CYCLE_1 },
    evidence: {
      assignments: [],
      serviceReports: [],
      completionPhotoCount: 0,
      // No LINKED `xero_invoices` row — the invoice exists in Xero and its PDF
      // is attached to the card, but the local mirror is unlinked, which is
      // what the money seal enforces.
      invoiceStatus: null,
      attendanceCycleIds: [CYCLE_1],
      currentAttendanceCycleId: CYCLE_1,
      ...(over.evidence || {}),
    },
    nowIso: NOW,
  };
}

function signoffProof(over: Record<string, any> = {}): any {
  return {
    id: "proof-1",
    kind: "verified_historical_closeout",
    attendance_cycle_ids: [CYCLE_1],
    evidence_refs: [
      "job_documents:work_order",
      "job_documents:makesafe_report",
      "job_documents:swms",
      "job_documents:invoice",
    ],
    proven_by: "captain-signoff",
    proven_at: daysAgo(2),
    ...over,
  };
}

Deno.test("no terminal proof: the card is still refused, on both conflicts", () => {
  const result = deriveSesStageV2(manuallyCompletedCard());
  assertEquals(result.stage, SES_STAGE_DECISION_REQUIRED);
  assertEquals(result.conflicts, [
    "terminal_without_issued_invoice",
    "terminal_without_supporting_evidence",
  ]);
});

Deno.test("a bound terminal proof places the card, and the engine derives it", () => {
  const result = deriveSesStageV2(
    manuallyCompletedCard({ evidence: { terminalProofs: [signoffProof()] } }),
  );
  assertEquals(result.stage, "completed");
  // The invoice-corroboration conflict is never raised: the proof branch runs
  // above the raw-status branch, so the missing LOCAL mirror row is not the
  // question any more.
  assertEquals(result.conflicts, []);
  assert(
    result.reasons.some((reason) =>
      reason.includes("verified_historical_closeout")
    ),
  );
  assert(
    result.reasons.some((reason) =>
      reason.includes("terminal_proof.proven_at")
    ),
    "the proof's own timestamp is the completion clock it is aged against",
  );
});

Deno.test("the proof ages on the one common clock, seven days to Archive", () => {
  const eightDays = deriveSesStageV2(
    manuallyCompletedCard({
      evidence: { terminalProofs: [signoffProof({ proven_at: daysAgo(8) })] },
    }),
  );
  assertEquals(eightDays.stage, "archive");
  // The boundary matches the rest of the engine: exactly 168 hours is Archive.
  const exactlySeven = deriveSesStageV2(
    manuallyCompletedCard({
      evidence: { terminalProofs: [signoffProof({ proven_at: daysAgo(7) })] },
    }),
  );
  assertEquals(exactlySeven.stage, "archive");
});

Deno.test("a re-attendance unbinds the proof without revoking it", () => {
  // Cycle 2 opened. The proof still names cycle 1 only, so it no longer covers
  // the card's cycle SET and stops binding — nothing had to withdraw it.
  const card = manuallyCompletedCard({
    evidence: {
      terminalProofs: [signoffProof()],
      attendanceCycleIds: [CYCLE_1, CYCLE_2],
      currentAttendanceCycleId: CYCLE_2,
    },
  });
  card.detail = { cycle_number: 2, attendance_cycle_id: CYCLE_2 };
  const result = deriveSesStageV2(card);
  assertEquals(result.stage, SES_STAGE_DECISION_REQUIRED);
  assertEquals(sesStageBindingTerminalProof(card), null);
});

Deno.test("a malformed proof is ignored rather than downgraded", () => {
  const cases: Array<[string, Record<string, any>]> = [
    ["no evidence refs", { evidence_refs: [] }],
    ["unrecognised kind", { kind: "captain_said_so" }],
    ["unusable proven_at", { proven_at: "not a date" }],
    ["revision-bound proof is not accepted without the validated view", {
      readiness_revision: "sha256:stale",
      validatedReadinessRevision: false,
    }],
    ["covers a cycle this card does not have", {
      attendance_cycle_ids: [CYCLE_2],
    }],
    ["covers more than this card's cycles", {
      attendance_cycle_ids: [CYCLE_1, CYCLE_2],
    }],
  ];
  for (const [label, over] of cases) {
    const result = deriveSesStageV2(
      manuallyCompletedCard({
        evidence: { terminalProofs: [signoffProof(over)] },
      }),
    );
    assertEquals(
      result.stage,
      SES_STAGE_DECISION_REQUIRED,
      `${label} must not place the card`,
    );
  }
});

Deno.test("a proof does not revive a cancelled or archived job", () => {
  for (const status of ["cancelled", "archived"]) {
    const card = manuallyCompletedCard({
      evidence: { terminalProofs: [signoffProof()] },
    });
    card.job.status = status;
    const result = deriveSesStageV2(card);
    assertEquals(
      result.stage,
      status === "cancelled" ? "cancelled" : "archive",
    );
    assertEquals(result.reasons, [`job is ${status}`]);
  }
});

Deno.test("M1's published value is byte-identical with and without the proof", () => {
  const withoutProof = manuallyCompletedCard();
  const withProof = manuallyCompletedCard({
    evidence: { terminalProofs: [signoffProof()] },
  });
  assertEquals(
    JSON.stringify(computeMakesafeStatus(withProof)),
    JSON.stringify(computeMakesafeStatus(withoutProof)),
  );
});

Deno.test("the cutover gate clears for this card only once the proof exists", () => {
  const before = deriveSesStageV2(manuallyCompletedCard());
  const after = deriveSesStageV2(
    manuallyCompletedCard({ evidence: { terminalProofs: [signoffProof()] } }),
  );
  const row = (stage: unknown, conflicts: string[]) => ({
    id: "b88809b7",
    job_number: "SWMS-261059",
    canonical_stage: "report_ready",
    derived_stage_v2: stage,
    derived_stage_v2_conflicts: conflicts,
    derived_stage_v2_reasons: [],
  });
  const blocked = sesStageCutoverGate([row(before.stage, before.conflicts)]);
  assertEquals(blocked.ok, false);
  assertEquals(blocked.blocked[0].job_ref, "SWMS-261059");
  assertEquals(
    sesStageCutoverGate([row(after.stage, after.conflicts)]).ok,
    true,
  );
});

Deno.test("cycle-set coverage is exact, in the one place both consumers read", () => {
  assert(makesafeTerminalProofCoversCycleSet([CYCLE_1], [CYCLE_1]));
  assert(makesafeTerminalProofCoversCycleSet([CYCLE_2, CYCLE_1], [
    CYCLE_1,
    CYCLE_2,
  ]));
  // The card's ids are de-duplicated; the proof's are not, so a proof carrying
  // a duplicate fails on length rather than passing by accident.
  assert(makesafeTerminalProofCoversCycleSet([CYCLE_1], [CYCLE_1, CYCLE_1]));
  assert(!makesafeTerminalProofCoversCycleSet([CYCLE_1, CYCLE_1], [CYCLE_1]));
  assert(!makesafeTerminalProofCoversCycleSet([CYCLE_1], [CYCLE_1, CYCLE_2]));
  assert(!makesafeTerminalProofCoversCycleSet([], []));
  // A card whose current cycle is not inside its own set is not a card this
  // contract can speak about.
  assertEquals(
    bindingMakesafeTerminalProof([signoffProof()], [CYCLE_1], CYCLE_2),
    null,
  );
});

Deno.test("attendance-cycle hash matches the production vector", async () => {
  assertEquals(
    await makesafeAttendanceCycleSetHash([
      "20828ff2-6699-4f59-a71f-6c47194444aa",
    ]),
    "sha256:84c308706bc740b06366f4da38475a9559d0b5ad8ca1d57bda4ff2f434c27dfb",
  );
  assertEquals(
    await makesafeAttendanceCycleSetHash([
      "20828ff2-6699-4f59-a71f-6c47194444aa",
      "00000000-0000-0000-0000-000000000001",
    ]),
    "sha256:1811538a3d382def3eb72ff59e7050ba4d431b4a2db84e511d6de01bebe003c3",
  );
});

Deno.test("validated raw proof facts preserve revision-bound proofs", () => {
  const proof = signoffProof({
    readiness_revision: "sha256:revision",
    validatedCycleSetHash: true,
    validatedReadinessRevision: true,
  });
  assertEquals(
    bindingMakesafeTerminalProof([proof], [CYCLE_1], CYCLE_1),
    proof,
  );
  assertEquals(
    bindingMakesafeTerminalProof([{
      ...proof,
      validatedReadinessRevision: false,
    }], [CYCLE_1], CYCLE_1),
    null,
  );
  assertEquals(
    bindingMakesafeTerminalProof([{
      ...proof,
      validatedCycleSetHash: false,
    }], [CYCLE_1], CYCLE_1),
    null,
  );
});

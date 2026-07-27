// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  EMPTY_CANCELLATION,
  EMPTY_TERMINAL_PROOF,
  type MakesafeStateInput,
  projectMakesafeStateV2,
  type VersionedCycleFact,
} from "./makesafe_state_projection.ts";

const SHA_A =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const SHA_B =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const NOW = "2026-07-27T04:00:00.000Z";
const CYCLE = "00000000-0000-0000-0000-000000000101";

function fact(
  id: string,
  status: string | null = null,
  role: string | null = null,
  cycle = CYCLE,
): VersionedCycleFact {
  return {
    id,
    attendance_cycle_id: cycle,
    version: 1,
    content_hash: SHA_A,
    status,
    role,
  };
}

function baseInput(): MakesafeStateInput {
  return {
    computed_at: NOW,
    projection_input_errors: [],
    identity: {
      source_instruction_id: "instruction-1",
      lineage_id: "lineage-1",
      case_id: "case-1",
      job_id: "job-1",
      job_number: "SWMS-1",
      property_id: null,
      attendance_cycle_ids: [CYCLE],
      current_attendance_cycle_id: CYCLE,
    },
    current_attendance_cycle_set_hash: SHA_B,
    source_version: 1,
    source_content_hash: SHA_A,
    lineage_version: 1,
    lineage_correction_hash: SHA_A,
    lineage_supersession_hash: SHA_A,
    substatus_raw: "company_contact_required",
    job_created_at: "2026-07-27T01:00:00.000Z",
    company_contact_present: true,
    intake_exception: false,
    cycle_attribution_error: null,
    family_rule: {
      code: "physical_makesafe",
      kind: "physical",
      matrix_revision: "family-1",
      matrix_content_hash: SHA_A,
      completion_photo_floor: 5,
    },
    attendance_cycles: [fact(CYCLE, "open")],
    assignments: [],
    service_reports: [],
    documents: [],
    completion_photos: [],
    portal_captures: [],
    readiness: {
      state: "absent",
      ready: false,
      readiness_revision: null,
      dependency_generation: 0,
      attendance_cycle_set_hash: null,
      invalidated_at: null,
      invalidation_reason: null,
    },
    operator_blockers: [],
    cancellation: EMPTY_CANCELLATION(),
    terminal_proof: EMPTY_TERMINAL_PROOF(),
    workflow: {
      pricing_disposition_revision: "pricing-1",
      invoice_obligation_id: null,
      invoice_obligation_revision: null,
      docket_revision_id: null,
      docket_artifact_hash: null,
      draft_assembled: false,
      docs_reviewed: false,
      invoice_approved: false,
      release_approved: false,
      released: false,
      money_review_required: false,
      stale_approval: false,
    },
  };
}

Deno.test("v2 derives all six stages from facts, never from substatus", () => {
  const fresh = baseInput();
  assertEquals(projectMakesafeStateV2(fresh).ops_stage, "new");

  const allocated = baseInput();
  allocated.assignments = [fact("assignment-1", "scheduled")];
  assertEquals(projectMakesafeStateV2(allocated).ops_stage, "allocated");

  const handedOff = structuredClone(allocated);
  handedOff.service_reports = [fact("report-1", "submitted")];
  handedOff.completion_photos = Array.from(
    { length: 5 },
    (_, index) => fact(`photo-${index}`),
  );
  assertEquals(projectMakesafeStateV2(handedOff).ops_stage, "trade_report_in");

  const ready = structuredClone(handedOff);
  ready.readiness = {
    state: "ready",
    ready: true,
    readiness_revision:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    dependency_generation: 7,
    attendance_cycle_set_hash: SHA_B,
    invalidated_at: null,
    invalidation_reason: null,
  };
  assertEquals(projectMakesafeStateV2(ready).ops_stage, "report_ready");
  assertEquals(projectMakesafeStateV2(ready).ops_label, "Docs Ready");

  const completed = structuredClone(ready);
  completed.terminal_proof = {
    state: "valid",
    proof_id: "proof-1",
    kind: "release_closeout",
    attendance_cycle_ids: [CYCLE],
    readiness_revision: ready.readiness.readiness_revision,
    release_revision_id: "release-1",
    closeout_revision_id: "closeout-1",
    proven_at: "2026-07-26T04:00:00.000Z",
    evidence_refs: ["proof:1"],
  };
  assertEquals(projectMakesafeStateV2(completed).ops_stage, "completed");
  completed.terminal_proof.proven_at = "2026-07-01T04:00:00.000Z";
  assertEquals(projectMakesafeStateV2(completed).ops_stage, "archive");
});

Deno.test("ready_to_invoice without immutable report/readiness stays out of Docs Ready", () => {
  const input = baseInput();
  input.substatus_raw = "ready_to_invoice";
  const state = projectMakesafeStateV2(input);
  assertEquals(state.ops_stage, "new");
  assert(
    state.diagnostics.some((item) => item.code === "substatus_ahead_of_facts"),
  );
  assertEquals(state.readiness.ready, false);
});

Deno.test("current report without readiness stops at Trade Report In and prepares docket", () => {
  const input = baseInput();
  input.assignments = [fact("assignment-1", "in_progress")];
  input.service_reports = [fact("report-1", "approved")];
  input.completion_photos = Array.from(
    { length: 5 },
    (_, index) => fact(`photo-${index}`),
  );
  const state = projectMakesafeStateV2(input);
  assertEquals(state.ops_stage, "trade_report_in");
  assertEquals(state.next_action.code, "prepare_docket");
});

Deno.test("reattendance supersedes prior-cycle readiness and terminal proof", () => {
  const input = baseInput();
  const priorCycle = "00000000-0000-0000-0000-000000000100";
  input.identity.attendance_cycle_ids = [priorCycle, CYCLE];
  input.attendance_cycles = [
    fact(priorCycle, "closed", null, priorCycle),
    fact(CYCLE, "open"),
  ];
  input.terminal_proof = {
    state: "valid",
    proof_id: "prior-proof",
    kind: "release_closeout",
    attendance_cycle_ids: [priorCycle],
    readiness_revision: SHA_A,
    release_revision_id: "release-old",
    closeout_revision_id: "closeout-old",
    proven_at: "2026-07-26T04:00:00.000Z",
    evidence_refs: ["prior"],
  };
  const state = projectMakesafeStateV2(input);
  assertEquals(state.ops_stage, "new");
  assertEquals(state.terminal_proof.state, "superseded");
});

Deno.test("cancellation is a typed overlay, never a seventh stage", () => {
  const input = baseInput();
  input.assignments = [fact("assignment-1", "scheduled")];
  input.cancellation = {
    state: "confirmed",
    reason_code: "builder_cancelled",
    note: null,
    decided_by: "captain",
    decided_at: NOW,
    decision_id: "cancel-1",
  };
  const state = projectMakesafeStateV2(input);
  assertEquals(state.ops_stage, "allocated");
  assertEquals(state.trade_column, "Archive");
  assertEquals(state.next_action.code, "none");
});

Deno.test("confirmed cancellation still suppresses actions after readiness invalidation", () => {
  const input = baseInput();
  input.readiness = {
    state: "invalid",
    ready: false,
    readiness_revision: null,
    dependency_generation: 8,
    attendance_cycle_set_hash: null,
    invalidated_at: NOW,
    invalidation_reason: "dependency changed",
  };
  input.cancellation = {
    state: "confirmed",
    reason_code: "builder_cancelled",
    note: null,
    decided_by: "captain",
    decided_at: NOW,
    decision_id: "cancel-invalidated-1",
  };
  const state = projectMakesafeStateV2(input);
  assertEquals(state.trade_column, "Archive");
  assertEquals(state.next_action.code, "none");
});

Deno.test("terminal proof is accepted only for the exact current cycle set", () => {
  const input = baseInput();
  input.terminal_proof = {
    state: "valid",
    proof_id: "proof-exact-1",
    kind: "release_closeout",
    attendance_cycle_ids: [CYCLE],
    readiness_revision: null,
    release_revision_id: "release-1",
    closeout_revision_id: "closeout-1",
    proven_at: NOW,
    evidence_refs: ["proof:exact"],
  };
  assertEquals(projectMakesafeStateV2(input).terminal_proof.state, "valid");
  input.identity.attendance_cycle_ids = [
    CYCLE,
    "00000000-0000-0000-0000-000000000100",
  ];
  assertEquals(
    projectMakesafeStateV2(input).terminal_proof.state,
    "superseded",
  );
});

Deno.test("partial and unknown inputs fail closed with visible typed alarms", () => {
  const input = baseInput();
  input.source_content_hash = null;
  input.substatus_raw = "mystery";
  input.assignments = [{
    ...fact("assignment-1", "scheduled"),
    version: null,
  }];
  const state = projectMakesafeStateV2(input);
  assertEquals(state.ops_stage, "new");
  assert(
    state.diagnostics.some((item) =>
      item.code === "projection_input_error" && item.severity === "hard"
    ),
  );
  assertEquals(state.blocker.primary?.code, "projection_input_error");
});

Deno.test("a stored ready pointer cannot outrun malformed dependency facts", () => {
  const input = baseInput();
  input.source_content_hash = null;
  input.readiness = {
    state: "ready",
    ready: true,
    readiness_revision:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    dependency_generation: 7,
    attendance_cycle_set_hash: SHA_B,
    invalidated_at: null,
    invalidation_reason: null,
  };
  const state = projectMakesafeStateV2(input);
  assertEquals(state.ops_stage, "new");
  assertEquals(state.readiness.state, "invalid");
  assertEquals(state.readiness.ready, false);
  assertEquals(state.blocker.primary?.code, "projection_input_error");
});

Deno.test("portal family uses its typed current-cycle capture recipe", () => {
  const input = baseInput();
  input.family_rule = {
    code: "roof_report",
    kind: "portal",
    matrix_revision: "family-2",
    matrix_content_hash: SHA_A,
    required_portal_roles: ["roof_report", "builder_portal"],
  };
  input.assignments = [fact("assignment-1", "scheduled")];
  input.portal_captures = [
    fact("capture-1", "verified", "roof_report"),
    fact("capture-2", "verified", "builder_portal"),
  ];
  assertEquals(
    projectMakesafeStateV2(input).ops_stage,
    "trade_report_in",
  );
});

Deno.test("next action follows the closed precedence chain", () => {
  const next = (input: MakesafeStateInput) =>
    projectMakesafeStateV2(input).next_action.code;

  const intake = baseInput();
  intake.intake_exception = true;
  assertEquals(next(intake), "resolve_intake_exception");

  const cancellation = baseInput();
  cancellation.cancellation = {
    state: "requested",
    reason_code: "builder_request",
    note: null,
    decided_by: "ops",
    decided_at: NOW,
    decision_id: "cancel-1",
  };
  assertEquals(next(cancellation), "review_cancellation");

  const held = baseInput();
  held.operator_blockers = [{
    code: "money_review_required",
    source: "operator",
    severity: "hard",
    attendance_cycle_id: CYCLE,
    reason: "Captain review is required.",
    held_since: NOW,
    owner_role: "captain",
    recovery_action: "resolve_blocker",
    recovery_instruction: "Review the current commercial evidence.",
    evidence_refs: ["hold-1"],
  }];
  assertEquals(next(held), "resolve_blocker");

  const contact = baseInput();
  contact.company_contact_present = false;
  assertEquals(next(contact), "contact_company");
  assertEquals(next(baseInput()), "allocate_trade");

  const assigned = baseInput();
  assigned.assignments = [fact("assignment-1", "scheduled")];
  assertEquals(next(assigned), "submit_trade_report");

  const unattributed = structuredClone(assigned);
  unattributed.cycle_attribution_error = "Evidence is not exactly bound.";
  assertEquals(next(unattributed), "bind_cycle_evidence");

  const handedOff = structuredClone(assigned);
  handedOff.service_reports = [fact("report-1", "submitted")];
  handedOff.completion_photos = Array.from(
    { length: 5 },
    (_, index) => fact(`photo-${index}`),
  );
  assertEquals(next(handedOff), "prepare_docket");

  const docket = structuredClone(handedOff);
  docket.workflow.docket_revision_id = "docket-1";
  docket.workflow.docket_artifact_hash = SHA_A;
  docket.workflow.draft_assembled = true;
  assertEquals(next(docket), "review_docs");

  docket.workflow.docs_reviewed = true;
  assertEquals(next(docket), "approve_invoice");
  docket.workflow.invoice_approved = true;
  assertEquals(next(docket), "approve_release");
  docket.workflow.release_approved = true;
  assertEquals(next(docket), "execute_release");
  docket.workflow.released = true;
  assertEquals(next(docket), "verify_closeout");

  docket.terminal_proof = {
    state: "valid",
    proof_id: "proof-1",
    kind: "release_closeout",
    attendance_cycle_ids: [CYCLE],
    readiness_revision: null,
    release_revision_id: "release-1",
    closeout_revision_id: "closeout-1",
    proven_at: NOW,
    evidence_refs: ["proof:1"],
  };
  assertEquals(next(docket), "none");
});

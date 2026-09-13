// deno-lint-ignore-file no-import-prefix
//
// SES pack-build admission gate (CIO, ses-workflow-completion-20260913).
//
// Every case the backlog item names, against no live provider: duplicate
// triggers, overlapping triggers, interrupted artifact creation, stale
// evidence, existing invoice reuse, unsupported family, missing photos,
// cross-job and cross-tenant refusal.
//
// Pins:
//   1. Duplicate trigger on a complete pack REUSES it: no rebuild, no second
//      docket, nothing handed to prepare, so no second invoice is possible.
//   2. Overlapping trigger joins the live attempt instead of starting a second.
//      An EXPIRED lease is not a live holder.
//   3. Interrupted artifact creation (pack present, owed pointer missing) HOLDS
//      with the missing pointer and the bound invoice both named.
//   4. Stale evidence (a closed attendance cycle) holds and never builds.
//   5. An existing bound invoice is named in the recovery action and never
//      re-minted; mints_allowed / sends_allowed are structurally false.
//   6. Unsupported family (requirements unresolved) holds rather than treating
//      "nothing owed" as complete.
//   7. Missing photos surface as the pack path's own refusal, unchanged.
//   8. Cross-job and cross-tenant requests refuse before any pack fact is used.
//   9. A sent pack is held, never rebuilt: Docs Ready stays distinct from sent.
//  10. An unreadable pack read fails CLOSED, never as "no pack".
//  11. A done sibling with an incomplete pack keeps the pre-existing
//      refused_conflict contract.
//  12. The attempt key grammar matches the SQL producer byte for byte.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  admitSesPackBuild,
  sesPackBuildAdmissionReceipt,
  sesPackBuildAdmissionRunState,
  sesPackBuildAttemptKey,
  sesMissingPackPointers,
  sesPackTruthFromInspection,
  type SesPackBuildAdmissionInput,
  type SesPackBuildPackTruth,
  type SesPackBuildSiblingRun,
} from "./ses_pack_build_admission.ts";

const JOB = "70000000-0000-4000-8000-000000000001";
const OTHER_JOB = "70000000-0000-4000-8000-000000000009";
const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000002";
const CYCLE1 = "72000000-0000-4000-8000-000000000001";
const CYCLE2 = "72000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-13T03:00:00.000Z");

function packTruth(over: Partial<SesPackBuildPackTruth> = {}): SesPackBuildPackTruth {
  return {
    job_id: JOB,
    org_id: ORG,
    required_documents_resolved: true,
    required_documents: { report: true, invoice: true, swms: false },
    pack: {
      exists: false,
      status: null,
      report_doc_id: null,
      invoice_doc_id: null,
      swms_doc_id: null,
      sent_at: null,
      send_started_at: null,
    },
    docket: null,
    docket_actor_identity: null,
    invoice: null,
    ...over,
  };
}

/** The AJBR-72221 shape measured in production 2026-09-13: complete pack, live DRAFT. */
function completePack(): SesPackBuildPackTruth {
  return packTruth({
    pack: {
      exists: true,
      status: "drafted",
      report_doc_id: "1e9c69aa-f0fa-404e-ba36-43282359b77b",
      invoice_doc_id: "1604ec27-f145-4398-8504-3b6f91f50a3c",
      swms_doc_id: null,
      sent_at: null,
      send_started_at: null,
    },
    docket: {
      docket_revision_id: "9983309a-e8d6-5f64-8515-6104b5631297",
      output_content_hash: "sha256:d60c7589",
    },
    docket_actor_identity: "makesafe-reporting-routine",
    invoice: {
      xero_invoice_id: "9b7a6ecd-b7c3-4a22-9882-88d55ff30dc3",
      number: "INV-1517",
      status: "DRAFT",
    },
  });
}

function sibling(over: Partial<SesPackBuildSiblingRun> = {}): SesPackBuildSiblingRun {
  return {
    id: "75000000-0000-4000-8000-000000000002",
    dedupe_key: `${JOB}:${CYCLE1}:report:other`,
    state: "pending",
    attendance_cycle_id: CYCLE1,
    docket_revision_id: null,
    lease_expires_at: null,
    ...over,
  };
}

function input(over: Partial<SesPackBuildAdmissionInput> = {}): SesPackBuildAdmissionInput {
  return {
    requested: {
      job_id: JOB,
      attendance_cycle_id: CYCLE1,
      source_identity: "report:r1",
      org_id: ORG,
    },
    current_cycle: { id: CYCLE1, cycle_number: 1 },
    pack: packTruth(),
    sibling_runs: [],
    now: NOW,
    ...over,
  };
}

/** No decision this gate can return may authorise Xero or a send. */
function assertNeverMintsOrSends(admission: ReturnType<typeof admitSesPackBuild>) {
  assertEquals(admission.mints_allowed, false);
  assertEquals(admission.sends_allowed, false);
}

Deno.test("1. duplicate trigger on a complete pack reuses it; nothing is rebuilt or re-minted", () => {
  const first = admitSesPackBuild(input());
  assertEquals(first.decision, "admit");
  assertEquals(first.builds_allowed, true);

  // The same card once the pack exists — this is the second trigger.
  const second = admitSesPackBuild(input({ pack: completePack() }));
  assertEquals(second.decision, "reuse");
  assertEquals(second.builds_allowed, false, "reuse must never hand the card to prepare");
  assertEquals(second.adopt_docket_revision_id, "9983309a-e8d6-5f64-8515-6104b5631297");
  assertEquals(second.adopt_output_content_hash, "sha256:d60c7589");
  assertEquals(second.pointers_complete, true);
  assertEquals(second.pack_built_outside_ledger, true);
  assertStringIncludes(second.reason, "makesafe-reporting-routine");
  assertNeverMintsOrSends(second);

  // A third and fourth identical trigger are byte-identical decisions: the
  // gate is a pure function of the card, so repetition cannot drift.
  assertEquals(
    JSON.stringify(sesPackBuildAdmissionReceipt(admitSesPackBuild(input({ pack: completePack() })))),
    JSON.stringify(sesPackBuildAdmissionReceipt(second)),
  );
  assertEquals(sesPackBuildAdmissionRunState("reuse"), "done");
});

Deno.test("2. overlapping trigger joins the live attempt; an expired lease is not a holder", () => {
  const live = admitSesPackBuild(input({
    sibling_runs: [sibling({
      state: "claimed",
      lease_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    })],
  }));
  assertEquals(live.decision, "join");
  assertEquals(live.builds_allowed, false);
  assertEquals(live.join_run_id, "75000000-0000-4000-8000-000000000002");
  // Joining is not a terminal state: the run stays re-runnable.
  assertEquals(sesPackBuildAdmissionRunState("join"), null);

  const expired = admitSesPackBuild(input({
    sibling_runs: [sibling({
      state: "claimed",
      lease_expires_at: new Date(NOW.getTime() - 1_000).toISOString(),
    })],
  }));
  assertEquals(expired.decision, "admit", "an expired lease must not block the next attempt");

  // A pending sibling is a live attempt too; two producers on one cycle must
  // converge on one build.
  assertEquals(admitSesPackBuild(input({ sibling_runs: [sibling()] })).decision, "join");

  // A sibling on ANOTHER cycle is not this cycle's holder.
  assertEquals(
    admitSesPackBuild(input({ sibling_runs: [sibling({ attendance_cycle_id: CYCLE2 })] })).decision,
    "admit",
  );
});

Deno.test("3. interrupted artifact creation holds with the missing pointer named, never a silent rebuild", () => {
  // The SWMS-261399 shape measured in production: invoice pointer bound,
  // report pointer absent. Rebuilding here would cut a new docket revision
  // over bound money and drop any Docs Ready signoff.
  const halfBuilt = completePack();
  halfBuilt.pack.report_doc_id = null;

  const admission = admitSesPackBuild(input({ pack: halfBuilt }));
  assertEquals(admission.decision, "hold_divergent_pack");
  assertEquals(admission.builds_allowed, false);
  assertEquals(admission.pointers_complete, false);
  assertEquals(admission.missing_pointers, ["the make-safe report document"]);
  assertStringIncludes(admission.reason, "the make-safe report document");
  assert(admission.recovery_action, "a hold must always name the next step");
  assertNeverMintsOrSends(admission);
  assertEquals(sesPackBuildAdmissionRunState("hold_divergent_pack"), "refused_conflict");

  // Owed SWMS is a pointer, not an attach tick.
  const noSwms = completePack();
  noSwms.required_documents = { report: true, invoice: true, swms: true };
  assertEquals(
    sesMissingPackPointers(noSwms),
    ["the SWMS this family requires"],
  );
});

Deno.test("4. stale evidence: a closed attendance cycle holds and never builds", () => {
  const stale = admitSesPackBuild(input({
    requested: {
      job_id: JOB,
      attendance_cycle_id: CYCLE1,
      source_identity: "report:r1",
      org_id: ORG,
    },
    current_cycle: { id: CYCLE2, cycle_number: 2 },
  }));
  assertEquals(stale.decision, "hold_stale_cycle");
  assertEquals(stale.builds_allowed, false);
  assertStringIncludes(stale.reason, CYCLE1);
  assertStringIncludes(stale.reason, CYCLE2);
  assertEquals(sesPackBuildAdmissionRunState("hold_stale_cycle"), "refused_stale");

  // No cycle at all is its own answer, not a stale one.
  const none = admitSesPackBuild(input({ current_cycle: null }));
  assertEquals(none.decision, "hold_no_cycle");
  assertStringIncludes(String(none.recovery_action), "attendance cycle");
});

Deno.test("5. an existing bound invoice is named and never re-minted", () => {
  const halfBuilt = completePack();
  halfBuilt.pack.report_doc_id = null;
  const admission = admitSesPackBuild(input({ pack: halfBuilt }));
  assertStringIncludes(String(admission.recovery_action), "INV-1517");
  assertStringIncludes(String(admission.recovery_action), "DRAFT");
  assertStringIncludes(String(admission.recovery_action), "Nothing was rebuilt");
  assertNeverMintsOrSends(admission);

  // Reuse adopts the same invoice rather than proposing another.
  const reuse = admitSesPackBuild(input({ pack: completePack() }));
  assertEquals(reuse.decision, "reuse");
  assertNeverMintsOrSends(reuse);

  // Every decision the gate can produce is mint-free and send-free.
  for (const pack of [null, packTruth(), completePack(), halfBuilt]) {
    for (const cycle of [null, { id: CYCLE1, cycle_number: 1 }]) {
      assertNeverMintsOrSends(admitSesPackBuild(input({ pack, current_cycle: cycle })));
    }
  }
});

Deno.test("6. unsupported family: unresolved requirements hold, never 'nothing owed'", () => {
  const unresolved = packTruth({
    required_documents_resolved: false,
    required_documents: null,
    pack: {
      exists: true,
      status: "drafted",
      report_doc_id: null,
      invoice_doc_id: null,
      swms_doc_id: null,
      sent_at: null,
      send_started_at: null,
    },
  });
  const admission = admitSesPackBuild(input({ pack: unresolved }));
  assertEquals(admission.decision, "hold_requirements_unresolved");
  assertEquals(admission.builds_allowed, false);
  assertEquals(sesPackBuildAdmissionRunState("hold_requirements_unresolved"), "refused_gate");

  // The projection must not invent a requirement map for an unresolved family.
  const projected = sesPackTruthFromInspection({
    job_id: JOB,
    required_documents_resolved: false,
    required_documents: { report: true, invoice: true, swms: false },
    pack: {
      exists: false, status: null, report_doc_id: null, invoice_doc_id: null,
      swms_doc_id: null, sent_at: null, send_started_at: null,
    },
  }, ORG);
  assertEquals(projected.required_documents, null);
  assertEquals(sesMissingPackPointers(projected), []);
});

Deno.test("7. missing photos stay the pack path's own refusal; admission does not pre-empt it", () => {
  // A card with no pack yet is admitted. The photo floor lives in the
  // assembler, and admission must not duplicate it or hide it behind a
  // generic hold — a second copy of that rule is exactly the duplicate
  // engine this slice must not build.
  const admission = admitSesPackBuild(input());
  assertEquals(admission.decision, "admit");
  assertEquals(admission.builds_allowed, true);
  assertEquals(admission.missing_pointers, [
    "the make-safe report document",
    "the invoice document",
  ], "admission reports owed pointers without refusing on them");
});

Deno.test("8. cross-job and cross-tenant refuse before any pack fact is consulted", () => {
  const crossJob = admitSesPackBuild(input({
    pack: packTruth({ job_id: OTHER_JOB }),
  }));
  assertEquals(crossJob.decision, "refuse_cross_job");
  assertEquals(crossJob.builds_allowed, false);
  assertStringIncludes(crossJob.reason, OTHER_JOB);
  assertEquals(sesPackBuildAdmissionRunState("refuse_cross_job"), "refused_gate");

  const crossTenant = admitSesPackBuild(input({
    pack: packTruth({ org_id: OTHER_ORG }),
  }));
  assertEquals(crossTenant.decision, "refuse_cross_tenant");
  assertEquals(crossTenant.builds_allowed, false);
  assertStringIncludes(crossTenant.reason, OTHER_ORG);

  // Identity is checked FIRST: a cross-job request on a card that is also
  // stale still refuses on identity, so the operator is told the real fault.
  const both = admitSesPackBuild(input({
    pack: packTruth({ job_id: OTHER_JOB }),
    current_cycle: { id: CYCLE2, cycle_number: 2 },
  }));
  assertEquals(both.decision, "refuse_cross_job");

  // An org the caller could not state is NOT treated as a match either way.
  const unknownOrg = admitSesPackBuild(input({
    requested: { job_id: JOB, attendance_cycle_id: CYCLE1, source_identity: "report:r1", org_id: null },
    pack: packTruth({ org_id: OTHER_ORG }),
  }));
  assertEquals(unknownOrg.decision, "admit", "an unstated org cannot manufacture a tenant refusal");
});

Deno.test("9. a sent pack is held, never rebuilt: Docs Ready stays distinct from sent", () => {
  for (
    const sentShape of [
      { sent_at: "2026-09-12T01:00:00.000Z", status: "sent" },
      { sent_at: null, status: "sent_not_closed" },
      { sent_at: null, status: "close_failed" },
    ]
  ) {
    const pack = completePack();
    pack.pack.sent_at = sentShape.sent_at;
    pack.pack.status = sentShape.status;
    const admission = admitSesPackBuild(input({ pack }));
    assertEquals(admission.decision, "hold_pack_sent", `sent shape ${sentShape.status}`);
    assertEquals(admission.builds_allowed, false);
    assertNeverMintsOrSends(admission);
  }

  // send_started_at alone is enough: a half-dispatched pack is never rebuilt.
  const starting = completePack();
  starting.pack.send_started_at = "2026-09-12T01:00:00.000Z";
  assertEquals(admitSesPackBuild(input({ pack: starting })).decision, "hold_pack_sent");
});

Deno.test("10. an unreadable pack read fails closed, never as 'no pack'", () => {
  const admission = admitSesPackBuild(input({ pack: null }));
  assertEquals(admission.decision, "hold_divergent_pack");
  assertEquals(admission.builds_allowed, false);
  assertStringIncludes(admission.reason, "could not be read");
  assertStringIncludes(String(admission.recovery_action), "inspect_ses_pack");
});

Deno.test("11. a done sibling with an incomplete pack keeps the refused_conflict contract", () => {
  const done = sibling({ state: "done", docket_revision_id: "d-1" });
  const admission = admitSesPackBuild(input({ sibling_runs: [done] }));
  assertEquals(admission.decision, "hold_already_built");
  assertEquals(admission.builds_allowed, false);
  assertEquals(admission.join_run_id, done.id);
  assertStringIncludes(admission.reason, "d-1");
  assertStringIncludes(String(admission.recovery_action), "INSURANCE");
  assertEquals(sesPackBuildAdmissionRunState("hold_already_built"), "refused_conflict");

  // But a done sibling whose pack IS complete reuses rather than parking a
  // human: the work is genuinely finished.
  assertEquals(
    admitSesPackBuild(input({ pack: completePack(), sibling_runs: [done] })).decision,
    "reuse",
  );
});

Deno.test("12. the attempt key grammar matches the SQL producer byte for byte", () => {
  // enqueue_ses_report_trigger_run(): job || ':' || coalesce(cycle,'cycle?') || ':' || identity
  assertEquals(
    sesPackBuildAttemptKey(JOB, CYCLE1, "report:r1"),
    `${JOB}:${CYCLE1}:report:r1`,
  );
  assertEquals(
    sesPackBuildAttemptKey(JOB, null, "report:r1"),
    `${JOB}:cycle?:report:r1`,
  );
  assertEquals(
    sesPackBuildAttemptKey(` ${JOB} `, "  ", " report:r1 "),
    `${JOB}:cycle?:report:r1`,
  );
});

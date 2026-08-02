// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCanonicalMakesafeRows,
  ownTemplateRoofJobIdsForBoard,
  projectOpsMakesafeBoard,
  projectTradeMakesafeBoard,
} from "./makesafe_board_read_model.ts";
import {
  computeMakesafeStatus,
  deriveMakesafeEvidenceStage,
  docsReady,
} from "./makesafe_computed_status.ts";
import {
  deriveSesStageV2,
  resolveSesStageV2Family,
  SES_STAGE_ENGINE_V2_VERSION,
  sesStageCutoverGate,
  sesStageDocsReady,
  type SesStageGateRow,
  sesStageOwnRoofReportIn,
  sesStagePortalReportIn,
  sesStagePortalRoleObservation,
  sesStageV2OverlayCandidate,
} from "./ses_stage_engine_v2.ts";

const NOW = "2026-08-02T00:00:00.000Z";
const daysAgo = (days: number) =>
  new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

function input(over: Record<string, any> = {}): any {
  return {
    // R4 — these fixtures are physical make-safes, and a real one carries its
    // family on the job. Before R4 the engine guessed physical for anything it
    // did not recognise, so an undeclared family was invisible here; now an
    // unidentifiable family is refused, so the fixture has to say what it is.
    // Overridable: `job.metadata` in `over` replaces this wholesale.
    job: {
      status: "in_progress",
      metadata: { makesafe_job_family: "physical_makesafe" },
      ...(over.job || {}),
    },
    detail: { cycle_number: 1, ...(over.detail || {}) },
    evidence: {
      assignments: [],
      serviceReports: [],
      completionPhotoCount: 0,
      ...(over.evidence || {}),
    },
    // R4 — present only when a case explicitly supplies it, so the "derive the
    // family from the card" path stays reachable in these fixtures.
    ...(over.ses_family === undefined ? {} : { ses_family: over.ses_family }),
    nowIso: over.nowIso ?? NOW,
  };
}

function baseRow(over: Record<string, any> = {}): any {
  return {
    id: over.id ?? "job-1",
    job_number: over.job_number ?? "SWMS-1",
    status: over.status ?? "in_progress",
    type: "makesafe",
    created_at: daysAgo(3),
    // R4 — see the note in `input()`. A real card declares its family.
    metadata: {
      makesafe_job_family: "physical_makesafe",
      ...(over.metadata || {}),
    },
    makesafe_details: { cycle_number: 1, ...(over.makesafe_details || {}) },
    board_stage: over.board_stage ?? "allocated",
    assignments: over.assignments ?? [{ id: "a1", user_id: "u1" }],
    report: over.report ?? null,
    report_pack: over.report_pack ?? null,
    ...over,
  };
}

// ── The authority boundary ──────────────────────────────────────────────────

Deno.test("shadow: the corrected engine cannot see the displayed stage", () => {
  // The read model feeds M1 the stage the board is already displaying, which
  // is why M1's published value short-circuits on terminal display state. The
  // v2 engine must be immune to it — that circularity is what it exists to end.
  const facts = input({ evidence: { assignments: [{ id: "a1" }] } });
  const derived = deriveSesStageV2(facts);
  for (const displayed of ["archive", "completed", "cancelled", "new"]) {
    const contaminated = deriveSesStageV2(
      { ...facts, displayedStatus: displayed } as any,
    );
    assertEquals(contaminated.stage, derived.stage);
  }
  assertEquals(derived.stage, "allocated");

  // ...and M1 fed the same displayed stage genuinely does short-circuit, so
  // the assertion above is testing a real difference, not a vacuous one.
  assertEquals(
    computeMakesafeStatus({ ...facts, displayedStatus: "archive" }).status,
    "archive",
  );
});

Deno.test("shadow: canonical_stage stays legacy-authoritative when v2 disagrees", () => {
  // A card the legacy ladder places in report_ready while the evidence proves
  // only allocation — the G2/G3 shape, 23 live cards at the 2026-08-02 snapshot.
  const rows = buildCanonicalMakesafeRows([
    baseRow({ board_stage: "report_ready" }),
  ], { computedAt: NOW });
  assertEquals(rows[0].canonical_stage, "report_ready");
  assertEquals(rows[0].declared_stage, "report_ready");
  assertEquals(rows[0].derived_stage_v2, "allocated");
  assertEquals(rows[0].derived_stage_v2_agrees_with_canonical, false);
  // The column the card is actually rendered into is the legacy one.
  const ops = projectOpsMakesafeBoard(rows);
  assertEquals(ops.columns.report_ready.length, 1);
  assertEquals(ops.columns.allocated.length, 0);
});

Deno.test("shadow: the advisory fields never reach the trade projection", () => {
  const rows = buildCanonicalMakesafeRows([baseRow()], { computedAt: NOW });
  const trade = projectTradeMakesafeBoard(rows, {
    userId: "u1",
    role: "ops_manager",
    managedVerticals: ["makesafe"],
  });
  const projected = trade.rows[0] as Record<string, unknown>;
  assert(Object.keys(projected).length > 0);
  for (const key of Object.keys(projected)) {
    assert(
      !key.startsWith("derived_stage_v2"),
      `trade projection leaked advisory key ${key}`,
    );
  }
  // The trade column still comes from the legacy canonical stage.
  assertEquals(projected.canonical_stage, "allocated");
  assertEquals(projected.column, "Allocated");
});

Deno.test("shadow: the ops projection buckets on canonical_stage, never on the advisory value", () => {
  const rows = buildCanonicalMakesafeRows([
    // Legacy says archive; the evidence-only derivation says new. Two of these
    // exist live (G6) and both must stay in Archive until Release 9 re-anchors.
    baseRow({ id: "j1", board_stage: "archive", assignments: [] }),
  ], { computedAt: NOW });
  assertEquals(rows[0].derived_stage_v2, "new");
  assertEquals(rows[0].canonical_stage, "archive");
  const ops = projectOpsMakesafeBoard(rows);
  assertEquals(ops.columns.archive.length, 1);
  assertEquals(ops.columns.new.length, 0);
  assertEquals(ops.unmapped_stage_job_ids.length, 0);
});

Deno.test("shadow: every advisory key is published and version-stamped", () => {
  const rows = buildCanonicalMakesafeRows([baseRow()], { computedAt: NOW });
  const row = rows[0];
  for (
    const key of [
      "derived_stage_v2",
      "derived_stage_v2_post_overlay",
      "derived_stage_v2_overlay_binds",
      "derived_stage_v2_agrees_with_canonical",
      "derived_stage_v2_reasons",
      "derived_stage_v2_missing",
      "derived_stage_v2_conflicts",
      "derived_stage_v2_engine_version",
    ]
  ) {
    assert(key in row, `missing advisory key ${key}`);
  }
  assertEquals(
    row.derived_stage_v2_engine_version,
    SES_STAGE_ENGINE_V2_VERSION,
  );
  assert(Array.isArray(row.derived_stage_v2_reasons));
  assert(row.derived_stage_v2_reasons.length > 0);
});

// ── The overlay candidate is a simulation, not a binding ─────────────────────

Deno.test("overlay candidate: real overlay binding is untouched by the advisory value", () => {
  // The overlay's source_status is the LEGACY stage, so it binds today. Under
  // the v2 derivation its source no longer matches, which is exactly the
  // 9-row unbind risk Release 9 re-anchors — and the harness must see it.
  const application = {
    run_key: "r1",
    source_status: "allocated",
    before_status: "allocated",
    after_status: "archive",
    evidence_ref: "captain-ruling",
    applied_by: "captain",
    applied_at: daysAgo(10),
  };
  const rows = buildCanonicalMakesafeRows([
    baseRow({ id: "j1", board_stage: "allocated", assignments: [] }),
  ], {
    computedAt: NOW,
    statusApplicationsByJobId: { "j1": application },
  });
  // Real binding: legacy declared_stage === source_status, so it applies.
  assertEquals(rows[0].declared_stage, "allocated");
  assertEquals(rows[0].canonical_stage, "archive");
  assert(rows[0].status_application !== null);
  // Simulated binding under v2: the derivation is `new`, so it would UNBIND.
  assertEquals(rows[0].derived_stage_v2, "new");
  assertEquals(rows[0].derived_stage_v2_overlay_binds, false);
  assertEquals(rows[0].derived_stage_v2_post_overlay, "new");
});

Deno.test("overlay candidate: a matching source binds in the simulation too", () => {
  const candidate = sesStageV2OverlayCandidate(
    "allocated",
    { source_status: "allocated", after_status: "archive" },
    "in_progress",
  );
  assertEquals(candidate, { stage: "archive", binds: true });
});

Deno.test("overlay candidate: terminal guards are not relaxed in the simulation", () => {
  // Terminal DERIVED stage: an archive->archive attestation can never be an
  // override. This is the SWMS-26845 trap in the design's section 5.1.
  assertEquals(
    sesStageV2OverlayCandidate(
      "archive",
      { source_status: "archive", after_status: "archive" },
      "in_progress",
    ),
    { stage: "archive", binds: false },
  );
  // Terminal RAW job state: a stale decision cannot reattach after real
  // movement.
  assertEquals(
    sesStageV2OverlayCandidate(
      "allocated",
      { source_status: "allocated", after_status: "archive" },
      "cancelled",
    ),
    { stage: "allocated", binds: false },
  );
});

// ── One shared evidence definition, two consumers ───────────────────────────

Deno.test("the evidence half is shared, not copied", () => {
  // Same input, same evidence verdict from both engines. If someone forks a
  // second copy of the evidence ladder into the v2 module, this fails.
  for (
    const facts of [
      input({ evidence: { assignments: [{ id: "a1" }] } }),
      input({
        evidence: {
          serviceReports: [{ status: "submitted", cycle_number: 1 }],
          completionPhotoCount: 6,
        },
      }),
      // NOTE: `packState: READY` alone deliberately no longer agrees — R7
      // makes Docs Ready per-family and stricter. The divergence is asserted
      // explicitly in the R7 tests below rather than removed from view here.
      input(),
    ]
  ) {
    assertEquals(
      deriveSesStageV2(facts).stage,
      deriveMakesafeEvidenceStage(facts).status,
    );
    assertEquals(
      deriveSesStageV2(facts).stage,
      computeMakesafeStatus(facts).status,
    );
  }
});

Deno.test("the close-out path keeps the clock the newer engine already had", () => {
  // Release 2 makes the clock COMMON; it does not invent one here. This path
  // aged correctly before and must still agree with M1 afterwards, so the
  // 34-card blast stays attributable to the shortcut branch alone.
  const closedOut = input({
    evidence: {
      packSent: true,
      invoiceStatus: "PAID",
      invoiceDate: daysAgo(30),
      documents: { report: true, invoice: true },
    },
  });
  assertEquals(deriveSesStageV2(closedOut).stage, "archive");
  assertEquals(computeMakesafeStatus(closedOut).status, "archive");
});

Deno.test("raw cancelled and archived job state outrank every evidence fact", () => {
  const loaded = {
    assignments: [{ id: "a1" }],
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    completionPhotoCount: 9,
    packState: "READY",
  };
  assertEquals(
    deriveSesStageV2(input({ job: { status: "cancelled" }, evidence: loaded }))
      .stage,
    "cancelled",
  );
  assertEquals(
    deriveSesStageV2(input({ job: { status: "archived" }, evidence: loaded }))
      .stage,
    "archive",
  );
});

// ── Release 2 — one common clock on every terminal path ─────────────────────

Deno.test("clock: the raw terminal shortcut is aged, not waved through", () => {
  // The newer engine returns `completed` here with no clock at all, which is
  // why 34 jobs finished months ago would read as this week's work. The issued
  // invoice is what makes this a CLOCK case rather than a corroboration one
  // (Release 3) — the two corrections must stay separately exercised.
  const stale = input({
    job: { status: "complete", completed_at: daysAgo(200) },
    evidence: { invoiceStatus: "PAID" },
  });
  assertEquals(deriveSesStageV2(stale).stage, "archive");
  assertEquals(computeMakesafeStatus(stale).status, "completed");
});

Deno.test("clock: the 168-hour boundary is strict on both terminal paths", () => {
  const paths = [
    // raw terminal shortcut, corroborated by an issued invoice
    (age: number) =>
      input({
        job: { status: "complete", completed_at: daysAgo(age) },
        evidence: { invoiceStatus: "AUTHORISED" },
      }),
    // durable close-out
    (age: number) =>
      input({
        evidence: {
          packSent: true,
          invoiceStatus: "PAID",
          invoiceDate: daysAgo(age),
          documents: { report: true, invoice: true },
        },
      }),
  ];
  for (const build of paths) {
    // Under seven days.
    assertEquals(deriveSesStageV2(build(6.5)).stage, "completed");
    // EXACTLY seven days archives — matching the legacy rolling-window helper.
    assertEquals(deriveSesStageV2(build(7)).stage, "archive");
    // Over seven days.
    assertEquals(deriveSesStageV2(build(7.5)).stage, "archive");
  }
});

Deno.test("clock: a missing trusted completion time is refused, not guessed", () => {
  // Issued invoice, so the terminal claim IS corroborated — but no pack send,
  // no invoice date, no completed_at and no report send, so there is no time to
  // age it against.
  const noTime = input({
    job: { status: "closed" },
    evidence: { invoiceStatus: "PAID" },
  });
  const result = deriveSesStageV2(noTime);
  assertEquals(result.stage, "decision_required");
  assertEquals(result.conflicts, ["completion_timestamp_missing"]);
  // The newer engine parks exactly this card in Completed forever.
  assertEquals(computeMakesafeStatus(noTime).status, "completed");
});

Deno.test("clock: generic row-touch and readiness markers are not completion proof", () => {
  // `jobs.updated_at` is any write at all; `invoice_ready_at` is a readiness
  // marker. The newer engine ages cards against both.
  const weak = input({
    job: { status: "complete", updated_at: daysAgo(1) },
    detail: { cycle_number: 1, invoice_ready_at: daysAgo(1) },
    evidence: { invoiceStatus: "PAID" },
  });
  assertEquals(deriveSesStageV2(weak).stage, "decision_required");
  assertEquals(
    deriveSesStageV2(weak).conflicts,
    ["completion_timestamp_missing"],
  );
});

Deno.test("clock: each trusted source is used, in priority order, and named", () => {
  const cases: Array<[string, any, string]> = [
    [
      "pack.sent_at",
      { evidence: { invoiceStatus: "PAID", pack: { sent_at: daysAgo(1) } } },
      "completed",
    ],
    [
      "invoice.invoice_date",
      { evidence: { invoiceStatus: "PAID", invoiceDate: daysAgo(1) } },
      "completed",
    ],
    [
      "invoice.created_at",
      { evidence: { invoiceStatus: "PAID", invoiceCreatedAt: daysAgo(1) } },
      "completed",
    ],
    [
      "jobs.completed_at",
      {
        job: { completed_at: daysAgo(1) },
        evidence: { invoiceStatus: "PAID" },
      },
      "completed",
    ],
    [
      "detail.report_sent_at",
      {
        detail: { cycle_number: 1, report_sent_at: daysAgo(1) },
        evidence: { invoiceStatus: "PAID" },
      },
      "completed",
    ],
  ];
  for (const [source, over, expected] of cases) {
    const facts = input({
      ...over,
      job: { status: "complete", ...(over.job || {}) },
    });
    const result = deriveSesStageV2(facts);
    assertEquals(result.stage, expected, source);
    assert(
      result.reasons.some((r: string) => r.includes(source)),
      `${source} must be named in the reason, got ${result.reasons.join("; ")}`,
    );
  }

  // Priority: a durable send wins over a much older invoice date.
  const both = input({
    job: { status: "complete" },
    evidence: {
      invoiceStatus: "PAID",
      pack: { sent_at: daysAgo(1) },
      invoiceDate: daysAgo(300),
    },
  });
  assertEquals(deriveSesStageV2(both).stage, "completed");
});

Deno.test("clock: a refused terminal card still places no card and still shows as decision_required", () => {
  const rows = buildCanonicalMakesafeRows([
    baseRow({
      id: "j1",
      status: "closed",
      board_stage: "archive",
      assignments: [],
      // Corroborated by an issued invoice, but carrying no trusted timestamp.
      invoice_raw_status: "PAID",
    }),
  ], { computedAt: NOW });
  assertEquals(rows[0].derived_stage_v2, "decision_required");
  assertEquals(rows[0].derived_stage_v2_conflicts, [
    "completion_timestamp_missing",
  ]);
  // Still archived on the board. The advisory value places nothing.
  assertEquals(rows[0].canonical_stage, "archive");
  assertEquals(projectOpsMakesafeBoard(rows).columns.archive.length, 1);
  assertEquals(projectOpsMakesafeBoard(rows).unmapped_stage_job_ids.length, 0);
});

// ── Release 3 — corroborate the terminal shortcut ───────────────────────────

Deno.test("terminal: an issued invoice corroborates the raw terminal claim", () => {
  for (const status of ["AUTHORISED", "SUBMITTED", "PAID"]) {
    const facts = input({
      job: { status: "complete" },
      evidence: { invoiceStatus: status, invoiceDate: daysAgo(1) },
    });
    const result = deriveSesStageV2(facts);
    assertEquals(result.stage, "completed", status);
    assertEquals(result.conflicts, [], status);
  }
});

Deno.test("terminal: a DRAFT invoice does not corroborate anything", () => {
  // The captain ruled DRAFT is not terminal evidence, and a draft invoice's
  // online link cannot take payment at all.
  const facts = input({
    job: { status: "complete" },
    evidence: {
      invoiceStatus: "DRAFT",
      invoiceDate: daysAgo(1),
      assignments: [{ id: "a1" }],
    },
  });
  const result = deriveSesStageV2(facts);
  assertEquals(result.stage, "allocated");
  assertEquals(result.conflicts, ["terminal_without_issued_invoice"]);
  // The newer engine closes this card outright.
  assertEquals(computeMakesafeStatus(facts).status, "completed");
});

Deno.test("terminal: no invoice at all does not pre-empt stronger evidence on the card", () => {
  // The two live cards this resolves (SWMS-261024, SWMS-261025): a submitted
  // current-cycle report and the photo floor, buried in Completed by the
  // shortcut. The corrected engine surfaces the report instead.
  const facts = input({
    job: { status: "complete" },
    evidence: {
      serviceReports: [{ status: "submitted", cycle_number: 1 }],
      completionPhotoCount: 6,
    },
  });
  const result = deriveSesStageV2(facts);
  assertEquals(result.stage, "trade_report_in");
  assertEquals(result.conflicts, ["terminal_without_issued_invoice"]);
  // The conflict is recorded but the column IS proved, so the gate is clear.
  assertEquals(
    sesStageCutoverGate([{ derived_stage_v2: result.stage }]).ok,
    true,
  );
});

Deno.test("terminal: a raw terminal claim with no evidence at all proves NOTHING", () => {
  // The SWMS-261059 shape: raw state says completed, no issued invoice, no
  // current-cycle report, no live assignment. A mechanical fall-through returns
  // New — but that is not evidence the job is new, and its true column is a
  // captain question. The engine must refuse rather than pick.
  const facts = input({ job: { status: "complete" } });
  const result = deriveSesStageV2(facts);
  assertEquals(result.stage, "decision_required");
  assertEquals(result.conflicts, [
    "terminal_without_issued_invoice",
    "terminal_without_supporting_evidence",
  ]);
  // Explicitly NOT any of the four columns it could have been dropped into.
  for (const wrong of ["new", "report_ready", "completed", "archive"]) {
    assert(result.stage !== wrong);
  }
});

Deno.test("terminal: an unproved card STOPS the cutover gate, and stays where it is", () => {
  const rows = buildCanonicalMakesafeRows([
    baseRow({
      id: "j1",
      job_number: "SWMS-261059",
      status: "complete",
      board_stage: "report_ready",
      assignments: [],
    }),
  ], { computedAt: NOW });

  // Unresolved, and visibly so.
  assertEquals(rows[0].derived_stage_v2, "decision_required");
  assertEquals(rows[0].derived_stage_v2_post_overlay, "decision_required");

  // The gate refuses.
  const gate = sesStageCutoverGate(rows);
  assertEquals(gate.ok, false);
  assertEquals(gate.checked, 1);
  assertEquals(gate.blocked.length, 1);
  assertEquals(gate.blocked[0].job_ref, "SWMS-261059");
  assert(
    gate.blocked[0].conflicts.includes("terminal_without_supporting_evidence"),
  );

  // ...and the board is unaffected: the card is still rendered where it was.
  assertEquals(rows[0].canonical_stage, "report_ready");
  const ops = projectOpsMakesafeBoard(rows);
  assertEquals(ops.columns.report_ready.length, 1);
  // `decision_required` is not an ops column and must never become one here.
  assertEquals(ops.unmapped_stage_job_ids.length, 0);
});

Deno.test("gate: a fully proved board passes, and passing is not an authorisation", () => {
  const rows = buildCanonicalMakesafeRows([
    baseRow({ id: "j1" }),
    baseRow({ id: "j2", board_stage: "archive", status: "archived" }),
  ], { computedAt: NOW });
  const gate = sesStageCutoverGate(rows);
  assertEquals(gate.ok, true);
  assertEquals(gate.blocked, []);
  assertEquals(gate.engine_version, SES_STAGE_ENGINE_V2_VERSION);
  // Still no authority: both cards sit exactly where the legacy ladder put them.
  assertEquals(rows[0].canonical_stage, "allocated");
  assertEquals(rows[1].canonical_stage, "archive");
});

Deno.test("gate: a missing advisory stage blocks cutover distinctly", () => {
  // `42` is deliberately off-type: the gate must block a row whose advisory
  // stage arrived as a non-string, which is exactly what a drifted upstream
  // projection would send. The cast keeps that hostile case compiling without
  // widening `SesStageGateRow` to accept a shape the gate should reject.
  for (const derived_stage_v2 of [null, undefined, "", "   ", 42]) {
    const gate = sesStageCutoverGate([{
      id: "j-missing",
      job_number: "SWMS-MISSING",
      canonical_stage: "allocated",
      derived_stage_v2,
    } as SesStageGateRow]);
    assertEquals(gate.ok, false);
    assertEquals(gate.checked, 1);
    assertEquals(gate.blocked, [{
      job_id: "j-missing",
      job_ref: "SWMS-MISSING",
      canonical_stage: "allocated",
      conflicts: ["advisory_stage_missing"],
      reasons: [
        "advisory stage missing - the corrected engine did not place this row, so a cutover cannot be proved",
      ],
    }]);
  }
});

Deno.test("terminal: raw archived and cancelled never need corroboration", () => {
  // Only complete/completed/closed is a claim about work finishing. An archived
  // or cancelled job state is the operational record itself.
  assertEquals(
    deriveSesStageV2(input({ job: { status: "archived" } })).stage,
    "archive",
  );
  assertEquals(
    deriveSesStageV2(input({ job: { status: "cancelled" } })).stage,
    "cancelled",
  );
});

// ── R4 — canonical family is an input, not a three-kind guess ───────────────

Deno.test("family: every canonical family resolves to an explicit evidence path", () => {
  // Exhaustive over SesFamilyId. `kind` is the evidence path the family
  // delegates to; it is deliberately NOT the family, because temporary
  // fencing, repair and restoration all prove their stage the physical way
  // while keeping their own identity.
  const expected: Record<string, { kind: string | null; recipe: string }> = {
    physical_makesafe: { kind: "physical_makesafe", recipe: "sealed" },
    ordinary_roof_portal: { kind: "roof_report", recipe: "sealed" },
    own_template_roof: { kind: "roof_report", recipe: "sealed" },
    assessment_quote: { kind: "assessment_report_quote", recipe: "sealed" },
    temporary_fencing: { kind: "physical_makesafe", recipe: "sealed" },
    // Captain-sealed 2026-08-02: both match the existing system.
    repair: { kind: "physical_makesafe", recipe: "sealed" },
    restoration: { kind: "physical_makesafe", recipe: "sealed" },
    unknown: { kind: null, recipe: "unknown" },
  };
  for (const [family, want] of Object.entries(expected)) {
    const got = resolveSesStageV2Family(input({ ses_family: family }) as any);
    assertEquals(got.family, family);
    assertEquals(got.kind, want.kind as any);
    assertEquals(got.recipe_state, want.recipe as any);
  }
  assertEquals(Object.keys(expected).length, 8);
});

Deno.test("family: repair and restoration take the standard path, not a blocker", () => {
  // The captain's 2026-08-02 ruling closed both. A blocker here would move the
  // one live restoration card, which Release 4 must not do.
  for (const family of ["repair", "restoration"]) {
    const r = deriveSesStageV2(input({
      ses_family: family,
      evidence: { assignments: [{ id: "a1" }] },
    }));
    assertEquals(r.stage, "allocated");
    assertEquals(r.ses_family, family as any);
    assertEquals(r.family_recipe_state, "sealed");
    assertEquals(r.conflicts, []);
  }
});

Deno.test("family: temporary fencing keeps its identity while proving physically", () => {
  const r = deriveSesStageV2(input({
    ses_family: "temporary_fencing",
    evidence: { assignments: [{ id: "a1" }] },
  }));
  assertEquals(r.stage, "allocated");
  assertEquals(r.ses_family, "temporary_fencing");
  // Identity retained, evidence path delegated.
  assertEquals(r.job_type, "physical_makesafe");
  assertEquals(r.family_kind, "physical_makesafe");
});

Deno.test("family: an unknown family refuses advancement instead of reading as physical", () => {
  const r = deriveSesStageV2(input({
    ses_family: "unknown",
    evidence: { assignments: [{ id: "a1" }] },
  }));
  // Before R4 this card had an assignment and would have been called allocated.
  assertEquals(r.stage, "decision_required");
  assertEquals(r.conflicts, ["family_unknown"]);
  assertEquals(r.family_kind, null);
  assertEquals(r.family_recipe_state, "unknown");
});

Deno.test("family: unknown never overrides an explicit raw terminal state", () => {
  // The design is explicit: preserve raw Archive/Cancelled. Those are facts
  // about the job that hold whatever the family is.
  for (
    const [status, stage] of [
      ["cancelled", "cancelled"],
      ["archived", "archive"],
    ]
  ) {
    const r = deriveSesStageV2(
      input({ ses_family: "unknown", job: { status } }),
    );
    assertEquals(r.stage, stage);
    assertEquals(r.conflicts, []);
  }
});

Deno.test("family: a supplied family beats re-deriving one from the card", () => {
  // The read model already computed the canonical family; the engine must use
  // it rather than re-guessing from metadata.
  const r = deriveSesStageV2(input({
    ses_family: "assessment_quote",
    job: {
      status: "in_progress",
      metadata: { makesafe_job_family: "physical_makesafe" },
    },
  }));
  assertEquals(r.ses_family, "assessment_quote");
  assertEquals(r.family_kind, "assessment_report_quote");
});

Deno.test("family: with no supplied family the engine derives one from the card", () => {
  const r = deriveSesStageV2({
    job: {
      status: "in_progress",
      metadata: { makesafe_job_family: "roof_report" },
    },
    detail: { cycle_number: 1 },
    evidence: { assignments: [], serviceReports: [], completionPhotoCount: 0 },
    nowIso: NOW,
  } as any);
  assertEquals(r.ses_family, "ordinary_roof_portal");
  assertEquals(r.family_kind, "roof_report");
});

Deno.test("family: M1's published output is untouched by the family input", () => {
  // R4 changes the SHADOW engine only. M1 keeps its own three-kind guess so
  // every existing certificate keeps grading against the same value.
  for (const family of ["temporary_fencing", "restoration", "unknown"]) {
    const withFamily = computeMakesafeStatus({
      ...input({
        ses_family: family,
        evidence: { assignments: [{ id: "a1" }] },
      }),
      displayedStatus: "allocated",
    });
    const without = computeMakesafeStatus({
      ...input({ evidence: { assignments: [{ id: "a1" }] } }),
      displayedStatus: "allocated",
    });
    assertEquals(withFamily.status, without.status);
    assertEquals(withFamily.job_type, without.job_type);
    assertEquals(withFamily.job_type, "physical_makesafe");
  }
});

// ── R5 — own-template roof reads its own submitted draft ────────────────────

const OWN_ROOF = {
  ses_family: "own_template_roof",
  job: {
    status: "in_progress",
    metadata: {
      makesafe_job_family: "roof_report",
      own_template_requested: true,
    },
  },
};

function ownRoofInput(draft: any, over: Record<string, any> = {}) {
  return input({
    ...OWN_ROOF,
    ...over,
    evidence: {
      assignments: [{ id: "a1" }],
      ownRoofDraft: draft,
      documents: {
        report: false,
        ownRoofReportDocumentIds: new Set(
          draft?.report_doc_id ? [String(draft.report_doc_id)] : [],
        ),
      },
      ...(over.evidence || {}),
    },
  });
}

Deno.test("own roof: a submitted current-cycle draft with its attached document proves report-in", () => {
  const r = deriveSesStageV2(ownRoofInput({
    status: "submitted",
    cycle_number: 1,
    report_doc_id: "doc-1",
  }));
  assertEquals(r.stage, "trade_report_in");
  assertEquals(r.ses_family, "own_template_roof");
  assertEquals(r.missing, []);
});

Deno.test("own roof: every one of the three facts is required", () => {
  const cases: Array<[string, any, Record<string, any>]> = [
    ["no draft at all", null, {}],
    [
      "still a draft",
      { status: "draft", cycle_number: 1, report_doc_id: "d" },
      {},
    ],
    ["a prior cycle", {
      status: "submitted",
      cycle_number: 1,
      report_doc_id: "d",
    }, { detail: { cycle_number: 2 } }],
    ["no rendered document", {
      status: "submitted",
      cycle_number: 1,
      report_doc_id: null,
    }, {}],
    // The draft names a document that never became an attached roof_report row.
    ["document never attached", {
      status: "submitted",
      cycle_number: 1,
      report_doc_id: "d",
    }, {
      evidence: {
        assignments: [{ id: "a1" }],
        ownRoofDraft: {
          status: "submitted",
          cycle_number: 1,
          report_doc_id: "d",
        },
        documents: {
          report: false,
          ownRoofReportDocumentIds: new Set(["different-document"]),
        },
      },
    }],
  ];
  for (const [label, draft, over] of cases) {
    const r = deriveSesStageV2(ownRoofInput(draft, over));
    assertEquals(r.stage, "allocated", `${label} should not prove report-in`);
    assert(r.missing.length > 0, `${label} should say what is missing`);
  }
});

Deno.test("own roof: the reader is why the family is not stuck at Allocated", () => {
  // An own-template roof renders OUR PDF; there is no Prime form, so a typed
  // portal capture can never arrive. Before R5 this card could only ever be
  // Allocated. This asserts the gap is real, not hypothetical.
  const proved = ownRoofInput({
    status: "submitted",
    cycle_number: 1,
    report_doc_id: "doc-1",
  });
  assertEquals(deriveSesStageV2(proved).stage, "trade_report_in");
  // The same card judged the ordinary-roof way, with zero portal captures.
  assertEquals(
    deriveMakesafeEvidenceStage(proved as any).status,
    "allocated",
  );
});

Deno.test("own roof: no other family consults the own-roof draft", () => {
  // A stray draft on a physical or ordinary-roof card must change nothing.
  for (
    const family of [
      "physical_makesafe",
      "ordinary_roof_portal",
      "assessment_quote",
    ]
  ) {
    const withDraft = deriveSesStageV2(input({
      ses_family: family,
      evidence: {
        assignments: [{ id: "a1" }],
        ownRoofDraft: {
          status: "submitted",
          cycle_number: 1,
          report_doc_id: "d",
        },
        documents: { report: true },
      },
    }));
    const without = deriveSesStageV2(input({
      ses_family: family,
      evidence: { assignments: [{ id: "a1" }], documents: { report: true } },
    }));
    assertEquals(withDraft.stage, without.stage);
    assertEquals(withDraft.stage, "allocated");
  }
});

Deno.test("own roof: M1's published output is untouched by the own-roof draft", () => {
  // R5 is a shadow-engine change. M1 proves a roof card by portal capture only.
  const facts = ownRoofInput({
    status: "submitted",
    cycle_number: 1,
    report_doc_id: "doc-1",
  });
  const m1 = computeMakesafeStatus({ ...facts, displayedStatus: "allocated" });
  const bare = computeMakesafeStatus({
    ...input({
      ...OWN_ROOF,
      evidence: { assignments: [{ id: "a1" }], documents: { report: true } },
    }),
    displayedStatus: "allocated",
  });
  assertEquals(m1.status, bare.status);
  assertEquals(m1.status, "allocated");
});

Deno.test("own roof: the loader only asks for drafts when such a card exists", () => {
  // The read is conditional, which is what makes this release free at 0 cards.
  const physicalOnly = [baseRow({ id: "j1" }), baseRow({ id: "j2" })];
  assertEquals(ownTemplateRoofJobIdsForBoard(physicalOnly), []);
  const withOwnRoof = [
    baseRow({ id: "j1" }),
    baseRow({
      id: "j2",
      metadata: {
        makesafe_job_family: "roof_report",
        own_template_requested: true,
      },
    }),
  ];
  assertEquals(ownTemplateRoofJobIdsForBoard(withOwnRoof), ["j2"]);
});

Deno.test("own roof: the reader names what is missing, per fact", () => {
  const r = sesStageOwnRoofReportIn(
    ownRoofInput({ status: "draft", cycle_number: 2, report_doc_id: null }, {
      detail: { cycle_number: 1 },
    }) as any,
  );
  assertEquals(r.satisfied, false);
  assertEquals(r.missing.length, 3);
});

// ── R6 — the deterministic portal capture reader ────────────────────────────

const ROOF_LINK = {
  role: "roof_report",
  url: "https://portal.primeeco.tech/s/abc",
};

function portalInput(captures: any[], over: Record<string, any> = {}) {
  return input({
    ses_family: "ordinary_roof_portal",
    job: {
      status: "in_progress",
      metadata: { makesafe_job_family: "roof_report" },
    },
    detail: {
      cycle_number: 1,
      external_links: [ROOF_LINK],
      ...(over.detail || {}),
    },
    evidence: {
      assignments: [{ id: "a1" }],
      portalCaptures: captures,
      ...(over.evidence || {}),
    },
  });
}

const ACCEPTED = {
  status: "done",
  role: "roof_report",
  url: ROOF_LINK.url,
  locked: true,
  screenshot: "makesafe-docket-artifacts/portal-captures/x.png",
  cycle_number: 1,
};

Deno.test("portal: an accepted capture revision proves roof report-in", () => {
  const r = deriveSesStageV2(portalInput([ACCEPTED]));
  assertEquals(r.stage, "trade_report_in");
  assertEquals(r.missing, []);
});

Deno.test("portal: cannot-observe is not not-done", () => {
  // The distinction this release exists for. Neither proves report-in, but the
  // engine must never say the trade has not done the work when the truth is
  // that WE could not see the portal.
  const notDone = deriveSesStageV2(
    portalInput([{
      ...ACCEPTED,
      status: "not_done",
      locked: false,
      screenshot: "s.png",
    }]),
  );
  const unreachable = deriveSesStageV2(
    portalInput([{
      ...ACCEPTED,
      status: "unreachable",
      locked: false,
      screenshot: null,
    }]),
  );
  assertEquals(notDone.stage, "allocated");
  assertEquals(unreachable.stage, "allocated");
  assert(
    notDone.missing[0].includes("submitted and locked"),
    `observed-not-done should blame the form: ${notDone.missing[0]}`,
  );
  assert(
    unreachable.missing[0].includes("could not observe"),
    `cannot-observe should blame the capture: ${unreachable.missing[0]}`,
  );
  // And they must not be the same sentence.
  assert(notDone.missing[0] !== unreachable.missing[0]);
});

Deno.test("portal: role observation uses the latest dated capture", () => {
  const olderNotDone = {
    ...ACCEPTED,
    status: "not_done",
    locked: false,
    screenshot: "old.png",
    captured_at: "2026-08-02T08:00:00.000Z",
    revision_id: "revision-old",
  };
  const newerUnreachable = {
    ...ACCEPTED,
    status: "unreachable",
    locked: false,
    screenshot: null,
    captured_at: "2026-08-02T09:00:00.000Z",
    revision_id: "revision-new",
  };
  const newerNotDone = {
    ...olderNotDone,
    captured_at: newerUnreachable.captured_at,
    revision_id: newerUnreachable.revision_id,
  };
  const olderUnreachable = {
    ...newerUnreachable,
    captured_at: olderNotDone.captured_at,
    revision_id: olderNotDone.revision_id,
  };

  const latestUnreachable = deriveSesStageV2(
    portalInput([olderNotDone, newerUnreachable]),
  );
  assertEquals(
    sesStagePortalRoleObservation(
      portalInput([olderNotDone, newerUnreachable]),
      "roof_report",
    ),
    "cannot_observe",
  );
  assert(latestUnreachable.missing[0].includes("could not observe"));

  const latestNotDone = deriveSesStageV2(
    portalInput([olderUnreachable, newerNotDone]),
  );
  assertEquals(
    sesStagePortalRoleObservation(
      portalInput([olderUnreachable, newerNotDone]),
      "roof_report",
    ),
    "observed_not_done",
  );
  assert(latestNotDone.missing[0].includes("submitted and locked"));
});

Deno.test("portal: the four observations are distinguished", () => {
  const cases: Array<[any[], string]> = [
    [[ACCEPTED], "proved"],
    [[{ ...ACCEPTED, status: "not_done", locked: false }], "observed_not_done"],
    [
      [{ ...ACCEPTED, status: "unreachable", locked: false, screenshot: null }],
      "cannot_observe",
    ],
    [[], "no_capture"],
  ];
  for (const [captures, want] of cases) {
    assertEquals(
      sesStagePortalRoleObservation(portalInput(captures), "roof_report"),
      want as any,
    );
  }
});

Deno.test("portal: evidence failing the contract is rejected, not accepted", () => {
  // The read model is the acceptance authority; this engine consumes its
  // decision. Anything that would not survive that contract must not prove.
  const bad: Array<[string, any]> = [
    ["wrong cycle", { ...ACCEPTED, cycle_number: 2 }],
    ["wrong role", { ...ACCEPTED, role: "photos" }],
    ["no screenshot", { ...ACCEPTED, screenshot: null }],
  ];
  for (const [label, capture] of bad) {
    const r = deriveSesStageV2(
      portalInput([capture], { detail: { cycle_number: 1 } }),
    );
    assertEquals(r.stage, "allocated", `${label} must not prove report-in`);
  }
});

Deno.test("portal: assessment needs all three typed roles", () => {
  const links = [
    { role: "assessment_report", url: "https://portal.primeeco.tech/s/a" },
    { role: "photos", url: "https://portal.primeeco.tech/s/p" },
    { role: "quote", url: "https://portal.primeeco.tech/s/q" },
  ];
  const cap = (role: string, url: string) => ({ ...ACCEPTED, role, url });
  const all = input({
    ses_family: "assessment_quote",
    job: {
      status: "in_progress",
      metadata: { makesafe_job_family: "assessment_report_quote" },
    },
    detail: { cycle_number: 1, external_links: links },
    evidence: {
      assignments: [{ id: "a1" }],
      portalCaptures: links.map((l) => cap(l.role, l.url)),
    },
  });
  assertEquals(deriveSesStageV2(all).stage, "trade_report_in");
  const twoOfThree = input({
    ses_family: "assessment_quote",
    job: {
      status: "in_progress",
      metadata: { makesafe_job_family: "assessment_report_quote" },
    },
    detail: { cycle_number: 1, external_links: links },
    evidence: {
      assignments: [{ id: "a1" }],
      portalCaptures: links.slice(0, 2).map((l) => cap(l.role, l.url)),
    },
  });
  assertEquals(deriveSesStageV2(twoOfThree).stage, "allocated");
  assertEquals(
    sesStagePortalReportIn(twoOfThree, "assessment_quote").observations.quote,
    "no_capture",
  );
});

Deno.test("portal: a physical card never consults portal captures", () => {
  const r = deriveSesStageV2(input({
    ses_family: "physical_makesafe",
    evidence: { assignments: [{ id: "a1" }], portalCaptures: [ACCEPTED] },
  }));
  assertEquals(r.stage, "allocated");
});

Deno.test("portal: M1's published output is untouched by the R6 reader", () => {
  const facts = portalInput([{
    ...ACCEPTED,
    status: "unreachable",
    locked: false,
    screenshot: null,
  }]);
  const m1 = computeMakesafeStatus({ ...facts, displayedStatus: "allocated" });
  assertEquals(m1.status, "allocated");
});

Deno.test("portal: ROOF acceptance does not require URL identity - a live asymmetry", () => {
  // FINDING, recorded rather than silently corrected. The design's contract is
  // "exact current-cycle typed capture rows with done, a screenshot, and the
  // required role/URL identity". The running acceptance path applies the URL
  // identity and locked checks ONLY to assessment cards
  // (`requiresTypedAssessmentIdentity` in makesafe_computed_status.ts), so a
  // roof card accepts a done+screenshot capture pointing at ANY url.
  //
  // Release 6 deliberately does NOT tighten this. Changing acceptance could
  // move roof cards, and this release measures zero blast only because there
  // are no capture rows - a change whose blast cannot be measured must not ride
  // along inside it. The ledger path is unaffected either way:
  // `portalCapturesFromLedger` already enforces exact role + URL + screenshot +
  // hash before projecting, so no ACCEPTED REVISION can reach here without
  // identity. This test pins the asymmetry so it stays visible until ruled on.
  const strayUrl = deriveSesStageV2(
    portalInput([{ ...ACCEPTED, url: "https://portal.primeeco.tech/s/OTHER" }]),
  );
  assertEquals(strayUrl.stage, "trade_report_in");

  // Assessment, by contrast, refuses exactly the same shape.
  const links = [
    { role: "assessment_report", url: "https://portal.primeeco.tech/s/a" },
    { role: "photos", url: "https://portal.primeeco.tech/s/p" },
    { role: "quote", url: "https://portal.primeeco.tech/s/q" },
  ];
  const assessmentStray = input({
    ses_family: "assessment_quote",
    job: {
      status: "in_progress",
      metadata: { makesafe_job_family: "assessment_report_quote" },
    },
    detail: { cycle_number: 1, external_links: links },
    evidence: {
      assignments: [{ id: "a1" }],
      portalCaptures: links.map((l) => ({
        ...ACCEPTED,
        role: l.role,
        url: "https://portal.primeeco.tech/s/OTHER",
      })),
    },
  });
  assertEquals(deriveSesStageV2(assessmentStray).stage, "allocated");
});

// ── R7 — Docs Ready means one click from sending ────────────────────────────

Deno.test("docs ready: a READY pack alone is no longer one click from sending", () => {
  // The captain's definition is that the skill has run, everything is
  // assembled, and one button sends it. A pack STATE is the skill asserting it
  // finished; the artifacts are the state of actually being sendable.
  const packOnly = input({ evidence: { packState: "READY" } });
  // M1 keeps its old answer - unchanged, as every certificate grades on it.
  assertEquals(deriveMakesafeEvidenceStage(packOnly).status, "report_ready");
  // The corrected engine refuses: no report, no invoice.
  assertEquals(deriveSesStageV2(packOnly).stage, "new");
});

Deno.test("docs ready: a physical card needs report, SWMS when required, and draft invoice", () => {
  const base = {
    packState: "READY",
    assignments: [{ id: "a1" }],
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    completionPhotoCount: 6,
    documents: { report: true, invoice: true, swms: true },
    swmsRequired: true,
    invoiceStatus: "DRAFT",
  };
  assertEquals(
    deriveSesStageV2(input({ evidence: base })).stage,
    "report_ready",
  );
  // Remove each required artifact in turn; none may be optional.
  for (const drop of ["report", "invoice", "swms"]) {
    const documents = { ...base.documents, [drop]: false };
    const r = deriveSesStageV2(input({ evidence: { ...base, documents } }));
    assert(r.stage !== "report_ready", `${drop} must be required`);
  }
  // SWMS is required only where the docket requires it.
  const noSwmsNeeded = deriveSesStageV2(input({
    evidence: {
      ...base,
      swmsRequired: false,
      documents: { report: true, invoice: true, swms: false },
    },
  }));
  assertEquals(noSwmsNeeded.stage, "report_ready");
});

Deno.test("docs ready: READY_TO_BUILD is not a sendable pack", () => {
  const base = {
    assignments: [{ id: "a1" }],
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    completionPhotoCount: 6,
    documents: { report: true, invoice: true, swms: false },
    swmsRequired: false,
    invoiceStatus: "DRAFT",
  };
  assert(
    deriveSesStageV2(input({
      evidence: { ...base, packState: "READY_TO_BUILD" },
    })).stage !== "report_ready",
  );
  assertEquals(
    deriveSesStageV2(input({
      evidence: { ...base, packState: "READY" },
    })).stage,
    "report_ready",
  );
});

Deno.test("docs ready: a physical card needs a draft invoice status", () => {
  const base = {
    packState: "READY",
    assignments: [{ id: "a1" }],
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    completionPhotoCount: 6,
    documents: { report: true, invoice: true, swms: false },
    swmsRequired: false,
  };
  assertEquals(
    deriveSesStageV2(input({ evidence: { ...base, invoiceStatus: "draft" } }))
      .stage,
    "report_ready",
  );
  for (const invoiceStatus of ["AUTHORISED", "PAID", "SUBMITTED"]) {
    assert(
      deriveSesStageV2(input({ evidence: { ...base, invoiceStatus } }))
        .stage !==
        "report_ready",
      `${invoiceStatus} invoice must not be Docs Ready`,
    );
  }
});

Deno.test("docs ready: a roof card is never asked for a SecureWorks report", () => {
  // The ruling rules out the five-artifact shorthand board-wide: a roof job
  // produces no SecureWorks report, so demanding one would permanently block
  // the family. What one click needs is the builder's report PROVED complete.
  const proved = portalInput([ACCEPTED], {
    evidence: {
      assignments: [{ id: "a1" }],
      portalCaptures: [ACCEPTED],
      packState: "READY",
    },
  });
  assertEquals(deriveSesStageV2(proved).stage, "report_ready");
  // Same card, capture not proved: READY pack alone does not carry it.
  const unproved = portalInput([], {
    evidence: {
      assignments: [{ id: "a1" }],
      portalCaptures: [],
      packState: "READY",
    },
  });
  assert(deriveSesStageV2(unproved).stage !== "report_ready");
});

Deno.test("docs ready: an already-sent pack is not one click from sending", () => {
  const baseEvidence = {
    packState: "READY",
    assignments: [{ id: "a1" }],
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    completionPhotoCount: 6,
    documents: { report: true, invoice: true, swms: false },
    swmsRequired: false,
    invoiceStatus: "DRAFT",
  };
  const positive = input({
    evidence: { ...baseEvidence, pack: { status: "draft" } },
  });
  assertEquals(deriveSesStageV2(positive).stage, "report_ready");

  for (
    const status of [
      "sent",
      "sent_marker_failed",
      "sent_not_closed",
      "close_failed",
    ]
  ) {
    const sent = input({
      evidence: { ...baseEvidence, pack: { status } },
    });
    assert(
      deriveSesStageV2(sent).stage !== "report_ready",
      `${status} pack must not be one click from sending`,
    );
  }
});

Deno.test("docs ready: the corrected rule is never LOOSER than the existing one", () => {
  // The minimum negative rule is retained: no READY pack means no Docs Ready.
  // This asserts the containment directly - anything the corrected rule calls
  // Docs Ready, the existing rule must also call Docs Ready.
  const fixtures = [
    input({ evidence: { packState: "READY" } }),
    input({
      evidence: {
        packState: "READY",
        documents: { report: true, invoice: true },
      },
    }),
    input({ evidence: {} }),
    input({ evidence: { pack: { status: "sent" }, packState: "READY" } }),
    portalInput([ACCEPTED], {
      evidence: {
        assignments: [{ id: "a1" }],
        portalCaptures: [ACCEPTED],
        packState: "READY",
      },
    }),
  ];
  for (const facts of fixtures) {
    const family = resolveSesStageV2Family(facts);
    if (sesStageDocsReady(facts, family).satisfied) {
      assert(
        docsReady(facts),
        "corrected Docs Ready accepted a card the existing rule refuses",
      );
    }
  }
});

Deno.test("docs ready: repair and restoration take the standard path", () => {
  // Captain-sealed: repair matches the existing system, restoration behaves
  // exactly like any other job. Neither gets a bespoke Docs Ready contract.
  for (const family of ["repair", "restoration", "temporary_fencing"]) {
    const r = deriveSesStageV2(input({
      ses_family: family,
      evidence: {
        packState: "READY",
        assignments: [{ id: "a1" }],
        serviceReports: [{ status: "submitted", cycle_number: 1 }],
        completionPhotoCount: 6,
        documents: { report: true, invoice: true, swms: false },
        swmsRequired: false,
        invoiceStatus: "DRAFT",
      },
    }));
    assertEquals(r.stage, "report_ready");
    assertEquals(r.ses_family, family as any);
  }
});

Deno.test("docs ready: M1's published output is untouched", () => {
  const facts = input({ evidence: { packState: "READY" } });
  assertEquals(
    computeMakesafeStatus({ ...facts, displayedStatus: "allocated" }).status,
    "report_ready",
  );
});

// ── R8 — overlay re-anchor metadata and the no-op attestation read path ─────

const CAPTAIN_ARCHIVE = {
  run_key: "captain-archive-1",
  source_status: "allocated",
  before_status: "allocated",
  after_status: "archive",
  evidence_ref: "captain-ruling",
  applied_by: "captain",
  applied_at: "2026-07-23T00:00:00.000Z",
};

Deno.test("reanchor: a legacy row with no decision_kind still binds exactly as before", () => {
  // Every row in the ledger today has no decision_kind. This release must be
  // a no-op for all of them, which is why the blast is zero.
  const rows = buildCanonicalMakesafeRows([
    baseRow({ id: "j1", board_stage: "allocated", assignments: [] }),
  ], { computedAt: NOW, statusApplicationsByJobId: { j1: CAPTAIN_ARCHIVE } });
  assertEquals(rows[0].canonical_stage, "archive");
  assertEquals(rows[0].status_application?.effect, "override");
  assertEquals(rows[0].status_application?.applies_to_display, true);
  assertEquals(rows[0].status_application?.decision_kind, "display_override");
});

Deno.test("reanchor: a stage attestation NEVER changes a column", () => {
  // The load-bearing guarantee of this release. Even with a source that
  // matches the declared stage exactly — the shape that WOULD bind as an
  // override — an attestation must leave the column alone.
  const attestation = {
    ...CAPTAIN_ARCHIVE,
    decision_kind: "stage_attestation",
    after_status: "archive",
  };
  const rows = buildCanonicalMakesafeRows([
    baseRow({ id: "j1", board_stage: "allocated", assignments: [] }),
  ], { computedAt: NOW, statusApplicationsByJobId: { j1: attestation } });
  // Column is the legacy declared stage, NOT the attestation's after_status.
  assertEquals(rows[0].canonical_stage, "allocated");
  assertEquals(rows[0].declared_stage, "allocated");
  const ops = projectOpsMakesafeBoard(rows);
  assertEquals(ops.columns.allocated.length, 1);
  assertEquals(ops.columns.archive.length, 0);
});

Deno.test("reanchor: a same-column attestation keeps its provenance instead of vanishing", () => {
  // Four of the nine re-anchor rows are this shape. Before R8 a same-column
  // decision nulled status_application and erased the Captain's authority
  // from the card; the column was right and the history was gone.
  const attestation = {
    ...CAPTAIN_ARCHIVE,
    decision_kind: "stage_attestation",
    source_status: "archive",
    before_status: "archive",
    after_status: "archive",
  };
  const rows = buildCanonicalMakesafeRows([
    baseRow({ id: "j1", board_stage: "archive", assignments: [] }),
  ], { computedAt: NOW, statusApplicationsByJobId: { j1: attestation } });
  assertEquals(rows[0].canonical_stage, "archive");
  assert(rows[0].status_application !== null, "provenance must survive");
  assertEquals(rows[0].status_application?.effect, "attestation");
  assertEquals(rows[0].status_application?.applies_to_display, false);
  assertEquals(rows[0].status_application?.applied_by, "captain");
  assertEquals(rows[0].status_application?.evidence_ref, "captain-ruling");
});

Deno.test("reanchor: an attestation on a TERMINAL card attaches without moving it", () => {
  // SWMS-26845's shape: corrected derivation is already Archive, and Archive
  // is terminal so it can never be a display override. It must be an
  // attestation, which is exactly why the two kinds exist.
  const attestation = {
    ...CAPTAIN_ARCHIVE,
    decision_kind: "stage_attestation",
    source_status: "archive",
    after_status: "archive",
  };
  const rows = buildCanonicalMakesafeRows([
    baseRow({
      id: "j1",
      board_stage: "archive",
      status: "archived",
      assignments: [],
    }),
  ], { computedAt: NOW, statusApplicationsByJobId: { j1: attestation } });
  assertEquals(rows[0].canonical_stage, "archive");
  assertEquals(rows[0].status_application?.effect, "attestation");
});

Deno.test("reanchor: a stale override still does not attach", () => {
  // The existing guard must not be relaxed by this release. A decision whose
  // source no longer matches the card's stage is stale and stays detached.
  const rows = buildCanonicalMakesafeRows([
    baseRow({ id: "j1", board_stage: "trade_report_in", assignments: [] }),
  ], { computedAt: NOW, statusApplicationsByJobId: { j1: CAPTAIN_ARCHIVE } });
  assertEquals(rows[0].canonical_stage, "trade_report_in");
  assertEquals(rows[0].status_application, null);
});

Deno.test("reanchor: a stale ATTESTATION also does not attach", () => {
  // An attestation may only describe where the card actually is. One whose
  // source has moved on says nothing true and must not attach provenance.
  const stale = {
    ...CAPTAIN_ARCHIVE,
    decision_kind: "stage_attestation",
    source_status: "allocated",
    after_status: "allocated",
  };
  const rows = buildCanonicalMakesafeRows([
    baseRow({ id: "j1", board_stage: "trade_report_in", assignments: [] }),
  ], { computedAt: NOW, statusApplicationsByJobId: { j1: stale } });
  assertEquals(rows[0].canonical_stage, "trade_report_in");
  assertEquals(rows[0].status_application, null);
});

Deno.test("reanchor: an attestation cannot revive a terminal card", () => {
  // The regression the design names: a terminal attestation must not move a
  // card. Even pointing at a live column, it cannot pull the card out.
  const revive = {
    ...CAPTAIN_ARCHIVE,
    decision_kind: "stage_attestation",
    source_status: "archive",
    after_status: "allocated",
  };
  const rows = buildCanonicalMakesafeRows([
    baseRow({
      id: "j1",
      board_stage: "archive",
      status: "archived",
      assignments: [],
    }),
  ], { computedAt: NOW, statusApplicationsByJobId: { j1: revive } });
  assertEquals(rows[0].canonical_stage, "archive");
  // after_status !== declared_stage, so it does not even attach provenance.
  assertEquals(rows[0].status_application, null);
});

Deno.test("reanchor: the advisory overlay candidate is unchanged by decision_kind", () => {
  const attestation = sesStageV2OverlayCandidate(
    "new",
    {
      ...CAPTAIN_ARCHIVE,
      source_status: "new",
      decision_kind: "stage_attestation",
    } as any,
    "in_progress",
  );
  assertEquals(attestation.binds, false);
  assertEquals(attestation.stage, "new");

  const displayOverride = sesStageV2OverlayCandidate(
    "new",
    {
      ...CAPTAIN_ARCHIVE,
      source_status: "new",
      decision_kind: "display_override",
    } as any,
    "in_progress",
  );
  assertEquals(displayOverride.binds, true);
  assertEquals(displayOverride.stage, "archive");
});

Deno.test("reanchor: decision_kind projections are guarded when Release 9 arrives", async () => {
  let migrationIntroducesDecisionKind = false;
  for await (
    const entry of Deno.readDir(new URL("../../migrations/", import.meta.url))
  ) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const text = await Deno.readTextFile(
      new URL(`../../migrations/${entry.name}`, import.meta.url),
    );
    if (/\bdecision_kind\b/i.test(text)) {
      migrationIntroducesDecisionKind = true;
      break;
    }
  }
  if (!migrationIntroducesDecisionKind) {
    // The display_override default is safe only while no attestation row can exist.
    return;
  }

  const indexSource = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const boardRead = indexSource.match(
    /_fetchAllByJobIdChunked\(\s*client,\s*['"]makesafe_board_status_current['"],\s*['"]([^'"]+)['"]/,
  )?.[1] || "";
  const runRead = indexSource.match(
    /from\('makesafe_board_status_applications'\)[\s\S]{0,180}?\.select\('([^']+)'\)/,
  )?.[1] || "";
  if (!boardRead || !runRead) {
    throw new Error(
      "Release 9 projection guard could not locate both projections: expected the makesafe_board_status_current argument at index.ts:15356 and the makesafe_board_status_applications select at index.ts:15608.",
    );
  }
  const boardHasDecisionKind = /\bdecision_kind\b/.test(boardRead);
  const runHasDecisionKind = /\bdecision_kind\b/.test(runRead);
  if (
    !migrationIntroducesDecisionKind &&
    (boardHasDecisionKind || runHasDecisionKind)
  ) {
    throw new Error(
      "The current code selects decision_kind before Release 9 introduces its migration; keep both index.ts:15356 and index.ts:15608 projections unchanged until the discriminator exists.",
    );
  }
  if (
    migrationIntroducesDecisionKind &&
    (!boardHasDecisionKind || !runHasDecisionKind)
  ) {
    throw new Error(
      "Release 9 added decision_kind, but the projections at index.ts:15356 (makesafe_board_status_current) and index.ts:15608 (makesafe_board_status_applications) do not both select it. A projection that drops the discriminator silently downgrades an attestation to display_override, which can move a column and defeat Release 8.",
    );
  }
});

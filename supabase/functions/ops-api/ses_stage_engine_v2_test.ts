// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCanonicalMakesafeRows,
  projectOpsMakesafeBoard,
  projectTradeMakesafeBoard,
} from "./makesafe_board_read_model.ts";
import {
  computeMakesafeStatus,
  deriveMakesafeEvidenceStage,
} from "./makesafe_computed_status.ts";
import {
  deriveSesStageV2,
  SES_STAGE_ENGINE_V2_VERSION,
  sesStageV2OverlayCandidate,
} from "./ses_stage_engine_v2.ts";

const NOW = "2026-08-02T00:00:00.000Z";
const daysAgo = (days: number) =>
  new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

function input(over: Record<string, any> = {}): any {
  return {
    job: { status: "in_progress", ...(over.job || {}) },
    detail: { cycle_number: 1, ...(over.detail || {}) },
    evidence: {
      assignments: [],
      serviceReports: [],
      completionPhotoCount: 0,
      ...(over.evidence || {}),
    },
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
    metadata: {},
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
      input({ evidence: { packState: "READY" } }),
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
  // why 34 jobs finished months ago would read as this week's work.
  const stale = input({
    job: { status: "complete", completed_at: daysAgo(200) },
  });
  assertEquals(deriveSesStageV2(stale).stage, "archive");
  assertEquals(computeMakesafeStatus(stale).status, "completed");
});

Deno.test("clock: the 168-hour boundary is strict on both terminal paths", () => {
  const paths = [
    // raw terminal shortcut
    (age: number) =>
      input({ job: { status: "complete", completed_at: daysAgo(age) } }),
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
  // No pack send, no invoice, no completed_at, no report send.
  const noTime = input({ job: { status: "closed" } });
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
      { evidence: { pack: { sent_at: daysAgo(1) } } },
      "completed",
    ],
    [
      "invoice.invoice_date",
      { evidence: { invoiceDate: daysAgo(1) } },
      "completed",
    ],
    [
      "invoice.created_at",
      { evidence: { invoiceCreatedAt: daysAgo(1) } },
      "completed",
    ],
    ["jobs.completed_at", { job: { completed_at: daysAgo(1) } }, "completed"],
    [
      "detail.report_sent_at",
      { detail: { cycle_number: 1, report_sent_at: daysAgo(1) } },
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
    evidence: { pack: { sent_at: daysAgo(1) }, invoiceDate: daysAgo(300) },
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

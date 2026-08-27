// Replay proof for fencing stage-truth v1.
//
// Imports the REAL shipped recipe/engine (not a copy). Frozen fixtures
// represent the 38 active fencing jobs plus boundary and perturbation
// controls. A perturbation that does not move the answer fails this file.

import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveFencingStageV1,
  fencingStageTruthFields,
} from "./fencing_stage_engine_v1.ts";
import {
  FENCING_CANONICAL_STAGES,
  FENCING_STAGE_PIPELINE_FIELDS,
  FENCING_STAGE_RECIPE_VERSION,
  isFencingMaterialsOrLater,
  isFencingStageTruthRequested,
} from "./fencing_stage_recipe_v1.ts";
import { emptyFencingExecutionEvidence } from "./fencing_stage_evidence.ts";
import {
  FENCING_STAGE_TRUTH_BOUNDARY,
  FENCING_STAGE_TRUTH_COHORT,
  FENCING_STAGE_TRUTH_EMPTY_COMPLETE,
  FENCING_STAGE_TRUTH_FIXTURE_VERSION,
  FENCING_STAGE_TRUTH_PERTURBATIONS,
  FENCING_STAGE_TRUTH_PINNED_NOW,
  FENCING_STAGE_TRUTH_PLANTED_LIE,
  type FencingStageTruthFixture,
} from "./fixtures/fencing_stage_truth_cohort_v1.ts";
import { _pipelineForTest } from "./index.ts";

const NOW = new Date(FENCING_STAGE_TRUTH_PINNED_NOW);

const ENGINE_SRC = await Deno.readTextFile(
  new URL("./fencing_stage_engine_v1.ts", import.meta.url),
);
const RECIPE_SRC = await Deno.readTextFile(
  new URL("./fencing_stage_recipe_v1.ts", import.meta.url),
);
const EVIDENCE_SRC = await Deno.readTextFile(
  new URL("./fencing_stage_evidence.ts", import.meta.url),
);
const INDEX_SRC = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

function derive(fixture: FencingStageTruthFixture) {
  return deriveFencingStageV1(fixture.evidence, { now: NOW });
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

Deno.test("fencing stage truth: 38/38 cohort accounted once into a named bucket or unknown", () => {
  assertEquals(FENCING_STAGE_TRUTH_COHORT.length, 38);
  const ids = FENCING_STAGE_TRUTH_COHORT.map((row) => row.id);
  assertEquals(new Set(ids).size, 38);
  assertEquals(ids[0], "fence-001");
  assertEquals(ids[37], "fence-038");

  const declared = new Map<string, number>();
  for (const row of FENCING_STAGE_TRUTH_COHORT) {
    declared.set(
      row.declared_stage,
      (declared.get(row.declared_stage) || 0) + 1,
    );
  }
  assertEquals(declared.get("accepted"), 2);
  assertEquals(declared.get("order_materials"), 4);
  assertEquals(declared.get("awaiting_supplier"), 3);
  assertEquals(declared.get("schedule_install"), 2);
  assertEquals(declared.get("scheduled"), 17);
  assertEquals(declared.get("in_progress"), 5);
  assertEquals(declared.get("rectification"), 5);

  let unknown = 0;
  for (const row of FENCING_STAGE_TRUTH_COHORT) {
    const got = derive(row);
    assert(
      (FENCING_CANONICAL_STAGES as readonly string[]).includes(
        got.canonical_stage,
      ),
      `${row.id} emitted unnamed stage ${got.canonical_stage}`,
    );
    assertEquals(
      got.canonical_stage,
      row.expected_canonical,
      `${row.id} declared=${row.declared_stage} group=${row.group}`,
    );
    assertEquals(got.stage_recipe_version, FENCING_STAGE_RECIPE_VERSION);
    if (got.canonical_stage === "unknown") unknown += 1;
  }
  assert(
    unknown <= Math.floor(38 * 0.25),
    `unknown ${unknown}/38 exceeds 25% — name the missing capture, do not invent a status`,
  );
});

Deno.test("fencing stage truth: 0 materials-or-later without a paid deposit fact", () => {
  for (
    const row of [
      ...FENCING_STAGE_TRUTH_COHORT,
      ...FENCING_STAGE_TRUTH_BOUNDARY,
    ]
  ) {
    const got = derive(row);
    if (!isFencingMaterialsOrLater(got.canonical_stage)) continue;
    assert(
      got.facts.deposit_paid,
      `${row.id} at ${got.canonical_stage} without deposit_paid`,
    );
  }
});

Deno.test("fencing stage truth: 14/14 boundary fixtures match the frozen expected stage", () => {
  assertEquals(FENCING_STAGE_TRUTH_BOUNDARY.length, 14);
  for (const row of FENCING_STAGE_TRUTH_BOUNDARY) {
    assertEquals(
      derive(row).canonical_stage,
      row.expected_canonical,
      `${row.id} ${row.group}`,
    );
  }
});

Deno.test("fencing stage truth: every planted perturbation fails the unperturbed answer", () => {
  const byId = new Map(
    [...FENCING_STAGE_TRUTH_COHORT, ...FENCING_STAGE_TRUTH_BOUNDARY].map((
      row,
    ) => [row.id, row]),
  );
  assertEquals(FENCING_STAGE_TRUTH_PERTURBATIONS.length >= 4, true);
  for (const pert of FENCING_STAGE_TRUTH_PERTURBATIONS) {
    const base = byId.get(pert.base_id);
    assert(base, `missing base fixture ${pert.base_id}`);
    const before = deriveFencingStageV1(base.evidence, { now: NOW });
    const after = deriveFencingStageV1(pert.mutate(base.evidence), {
      now: NOW,
    });
    assertNotEquals(
      after.canonical_stage,
      pert.must_not_remain,
      `${pert.id} still ${after.canonical_stage} — perturbation is a broken proof`,
    );
    assertEquals(
      after.canonical_stage,
      pert.expected_canonical,
      `${pert.id}: ${before.canonical_stage} -> ${after.canonical_stage}`,
    );
  }
});

Deno.test("fencing stage truth: claimed complete with empty evidence is unknown, never an echo", () => {
  const got = derive(FENCING_STAGE_TRUTH_EMPTY_COMPLETE);
  assertEquals(FENCING_STAGE_TRUTH_EMPTY_COMPLETE.declared_stage, "complete");
  assertEquals(got.canonical_stage, "unknown");
  assertEquals(got.facts.deposit_paid, false);
  assertEquals(got.facts.work_complete, false);
});

Deno.test("fencing stage truth: declared-status perturbation leaves canonical unchanged", () => {
  for (const row of FENCING_STAGE_TRUTH_COHORT) {
    const a = derive(row);
    const b = derive({ ...row, declared_stage: "complete" });
    assertEquals(
      a.canonical_stage,
      b.canonical_stage,
      `${row.id} moved when declared_stage was perturbed`,
    );
    const fieldsA = fencingStageTruthFields("scheduled", a);
    const fieldsB = fencingStageTruthFields("in_progress", a);
    assertEquals(fieldsA.canonical_stage, fieldsB.canonical_stage);
    assertEquals(fieldsA.declared_stage, "scheduled");
    assertEquals(fieldsB.declared_stage, "in_progress");
  }
});

Deno.test("fencing stage truth: same fixtures twice are byte-identical", () => {
  for (const row of FENCING_STAGE_TRUTH_COHORT) {
    const first = derive(row);
    const second = derive(row);
    assertEquals(stable(first), stable(second), row.id);
  }
});

Deno.test("fencing stage truth: planted lie exits nonzero (comparison detects the false expected)", () => {
  const row = FENCING_STAGE_TRUTH_COHORT.find((item) =>
    item.id === FENCING_STAGE_TRUTH_PLANTED_LIE.id
  );
  assert(row);
  const got = derive(row).canonical_stage;
  assertEquals(got, FENCING_STAGE_TRUTH_PLANTED_LIE.true_expected);
  assertNotEquals(got, FENCING_STAGE_TRUTH_PLANTED_LIE.false_expected);
});

Deno.test("fencing stage truth: evidence type and engine never take claimed status as a fact", () => {
  assertEquals(/\bclaimed_status\b/.test(EVIDENCE_SRC), false);
  assertEquals(/\bdeclared_stage\s*[?:]/.test(EVIDENCE_SRC), false);
  assertEquals(
    /\b(accepted_at|deposit_at|processing_at)\b/.test(EVIDENCE_SRC),
    false,
  );
  assert(
    !/\bclaimed_status\b|\bevidence\.declared_stage\b|\bjobs\.status\b/.test(
      ENGINE_SRC,
    ),
    "engine must not read a claimed status as a positive term",
  );
  assertEquals(
    RECIPE_SRC.includes("stage-gate/engine"),
    false,
    "recipe must not ship the Cap 1 gate engine as placement",
  );
  assertEquals(ENGINE_SRC.includes("stage-gate/engine"), false);
  assertEquals(ENGINE_SRC.includes("deriveSesStageV2"), false);
  assertEquals(RECIPE_SRC.includes("deriveSesStageV2"), false);
  const empty = deriveFencingStageV1(emptyFencingExecutionEvidence("x"), {
    now: NOW,
  });
  assertEquals(empty.canonical_stage, "unknown");
});

Deno.test("fencing stage truth: draft PO plus outbound email is still order_materials", () => {
  const got = deriveFencingStageV1({
    job_id: "draft-po",
    deposit_invoice_id: "dep-1",
    invoices: [{
      id: "dep-1",
      status: "PAID",
      invoice_type: "ACCREC",
      reference: "DEP",
      amount_paid: 1,
      fully_paid_on: "2026-07-01",
    }],
    purchase_orders: [{
      id: "po-1",
      status: "draft",
      xero_po_id: null,
      confirmed_delivery_date: null,
      delivery_confirmed_at: null,
      delivery_date: null,
    }],
    po_communications: [{
      id: "email-1",
      direction: "outbound",
      created_at: "2026-08-10T00:00:00.000Z",
      sent_at: "2026-08-10T00:00:00.000Z",
      received_at: null,
    }],
    assignments: [],
    service_reports: [],
    unreadable: [],
  }, { now: NOW });
  assertEquals(got.canonical_stage, "order_materials");
  assertEquals(got.facts.material_order_sent, false);
});

Deno.test("fencing stage truth: flag parser is strict stage_truth=1", () => {
  assertEquals(
    isFencingStageTruthRequested(new URLSearchParams("type=fencing")),
    false,
  );
  assertEquals(
    isFencingStageTruthRequested(new URLSearchParams("stage_truth=true")),
    false,
  );
  assertEquals(
    isFencingStageTruthRequested(new URLSearchParams("stage_truth=1")),
    true,
  );
});

const ORG_ID = "00000000-0000-0000-0000-000000000001";

function pipelineJob(id: string, status: string) {
  return {
    id,
    org_id: ORG_ID,
    type: "fencing",
    status,
    client_name: "Customer",
    client_phone: null,
    site_address: "1 Example Street",
    site_suburb: "Balcatta",
    pj_total_inc: 1000,
    pj_total: null,
    pj_split_neighbours: null,
    pj_job_neighbours: null,
    ghl_contact_id: null,
    ghl_opportunity_id: null,
    job_number: "SWF-26003",
    accepted_at: null,
    approvals_at: null,
    deposit_at: null,
    processing_at: null,
    scheduled_at: null,
    completed_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    deposit_invoice_id: "dep-1",
    deposit_amount: 1500,
    council_required: false,
  };
}

function makeClient(
  tables: Record<string, Array<Record<string, unknown>>>,
  selectLog: Array<{ table: string; columns: string }> = [],
) {
  function from(table: string) {
    const eqFilters: Array<[string, unknown]> = [];
    const neqFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    let selectSpec = "";
    let rowLimit: number | null = null;
    const apply = () => {
      if (table === "jobs" && selectSpec === "id, pricing_json") return [];
      let rows = [...(tables[table] || [])];
      for (const [column, value] of eqFilters) {
        rows = rows.filter((row) => row[column] === value);
      }
      for (const [column, value] of neqFilters) {
        rows = rows.filter((row) => row[column] !== value);
      }
      for (const [column, values] of inFilters) {
        rows = rows.filter((row) => values.includes(row[column] as never));
      }
      return rowLimit == null ? rows : rows.slice(0, rowLimit);
    };
    const result = () => ({ data: apply(), error: null });
    const builder: Record<string, unknown> = {
      select: (columns: string) => {
        selectSpec = columns;
        selectLog.push({ table, columns });
        return builder;
      },
      eq: (column: string, value: unknown) => {
        eqFilters.push([column, value]);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        neqFilters.push([column, value]);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        inFilters.push([column, values]);
        return builder;
      },
      not: () => builder,
      or: () => builder,
      is: () => builder,
      order: () => builder,
      limit: (value: number) => {
        rowLimit = value;
        return builder;
      },
      range: async (fromIdx: number, to: number) => {
        const resolved = result();
        return {
          data: (resolved.data || []).slice(fromIdx, to + 1),
          error: null,
        };
      },
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  }
  return { from };
}

const PIPELINE_TABLES = {
  jobs: [pipelineJob("job-1", "order_materials")],
  job_assignments: [],
  purchase_orders: [],
  work_orders: [],
  council_submissions: [],
  po_communications: [],
  xero_invoices: [{
    id: "dep-1",
    job_id: "job-1",
    status: "PAID",
    invoice_type: "ACCREC",
    reference: "DEP",
    amount_paid: 1500,
    fully_paid_on: "2026-07-15",
  }],
  ops_notes: [],
  job_contacts: [],
  job_events: [],
  job_service_reports: [],
};

Deno.test("pipeline default path: no stage-truth keys and PO select stays job_id only", async () => {
  const selectLog: Array<{ table: string; columns: string }> = [];
  const off = await _pipelineForTest(
    makeClient(PIPELINE_TABLES, selectLog),
    new URLSearchParams("type=fencing"),
  );
  assertEquals(off.total, 1);
  const card = off.columns.order_materials[0];
  for (const field of FENCING_STAGE_PIPELINE_FIELDS) {
    assertEquals(
      Object.prototype.hasOwnProperty.call(card, field),
      false,
      `default pipeline leaked ${field}`,
    );
  }
  const poSelects = selectLog.filter((entry) =>
    entry.table === "purchase_orders"
  );
  assert(
    poSelects.every((entry) => entry.columns === "job_id"),
    `default PO select was ${JSON.stringify(poSelects)}`,
  );
  assertEquals(
    selectLog.some((entry) => entry.table === "job_service_reports"),
    false,
    "default path must not read job_service_reports",
  );
});

Deno.test("pipeline stage_truth=1: attaches diagnostic fields from the real engine", async () => {
  const on = await _pipelineForTest(
    makeClient(PIPELINE_TABLES),
    new URLSearchParams("type=fencing&stage_truth=1"),
  );
  const card = on.columns.order_materials[0];
  assertEquals(card.declared_stage, "order_materials");
  assertEquals(card.canonical_stage, "order_materials");
  assertEquals(card.stage_recipe_version, FENCING_STAGE_RECIPE_VERSION);
  assertEquals(Array.isArray(card.reasons), true);
  assertEquals(Array.isArray(card.missing), true);
  assertEquals(Array.isArray(card.conflicts), true);
  assertEquals(Array.isArray(card.evidence_refs), true);
  assertEquals(card.status, "order_materials");
});

Deno.test("pipeline default vs stage_truth=1: default keys stay, truth keys are additive", async () => {
  const off = await _pipelineForTest(
    makeClient(PIPELINE_TABLES),
    new URLSearchParams("type=fencing"),
  );
  const on = await _pipelineForTest(
    makeClient(PIPELINE_TABLES),
    new URLSearchParams("type=fencing&stage_truth=1"),
  );
  const offCard = { ...off.columns.order_materials[0] };
  const onCard = { ...on.columns.order_materials[0] };
  for (const field of FENCING_STAGE_PIPELINE_FIELDS) {
    delete onCard[field];
  }
  assertEquals(stable(offCard), stable(onCard));
});

Deno.test("pipeline wiring calls the shipped engine only behind the flag", () => {
  assert(INDEX_SRC.includes("deriveFencingStageV1("));
  assert(INDEX_SRC.includes("isFencingStageTruthRequested(params)"));
  assert(INDEX_SRC.includes("if (stageTruth && stageTruthRows)"));
  assertEquals(INDEX_SRC.includes("evaluateStageGates"), true);
  const pipelineStart = INDEX_SRC.indexOf("async function pipeline(");
  const pipelineEnd = INDEX_SRC.indexOf("export const _pipelineForTest");
  const body = INDEX_SRC.slice(pipelineStart, pipelineEnd);
  assert(body.includes("stageTruth"));
  assert(
    !body.includes("evaluateStageGates"),
    "pipeline must not place via Cap 1 evaluateStageGates",
  );
});

Deno.test("fencing stage truth fixture contract version is pinned", () => {
  assertEquals(
    FENCING_STAGE_TRUTH_FIXTURE_VERSION,
    "fencing-stage-truth-fixtures/v1",
  );
  assertEquals(FENCING_STAGE_TRUTH_PINNED_NOW, "2026-08-27T00:00:00.000Z");
});

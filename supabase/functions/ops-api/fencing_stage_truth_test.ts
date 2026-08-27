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
import {
  emptyFencingExecutionEvidence,
  fencingExecutionEvidenceFromPipelineRows,
} from "./fencing_stage_evidence.ts";
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

  const unknown: Array<{ id: string; missing: string[] }> = [];
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
    if (got.canonical_stage === "unknown") {
      unknown.push({ id: row.id, missing: got.missing });
    }
  }
  assertEquals(unknown, [
    { id: "fence-001", missing: ["deposit_invoice_issued"] },
    { id: "fence-002", missing: ["deposit_invoice_issued"] },
    { id: "fence-006", missing: ["deposit_invoice_issued"] },
    { id: "fence-029", missing: ["deposit_invoice_issued"] },
    { id: "fence-030", missing: ["deposit_invoice_issued"] },
    { id: "fence-031", missing: ["deposit_invoice_issued"] },
  ]);
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

Deno.test("fencing stage truth: empty execution evidence remains unknown", () => {
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
      id: "local-dep-1",
      xero_invoice_id: "dep-1",
      status: "PAID",
      invoice_type: "ACCREC",
      reference: "DEP",
      amount_paid: 1,
      fully_paid_on: "2026-07-01",
    }],
    purchase_orders: [{
      id: "po-1",
      po_type: "material",
      status: "draft",
      xero_po_id: null,
      confirmed_delivery_date: null,
      delivery_confirmed_at: null,
      delivery_date: null,
    }],
    po_communications: [{
      id: "email-1",
      po_id: "po-1",
      direction: "outbound",
      created_at: "2026-08-10T00:00:00.000Z",
      sent_at: "2026-08-10T00:00:00.000Z",
      message_id: "resend-1",
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
      const limited = rowLimit == null ? rows : rows.slice(0, rowLimit);
      if (
        ![
          "job_assignments",
          "purchase_orders",
          "po_communications",
          "xero_invoices",
          "job_service_reports",
        ].includes(table)
      ) {
        return limited;
      }
      const columns = selectSpec.split(",").map((column) => column.trim());
      return limited.map((row) =>
        Object.fromEntries(columns.map((column) => {
          const [alias, source] = column.includes(":")
            ? column.split(":").map((part) => part.trim())
            : [column, column];
          return [alias, row[source]];
        }))
      );
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
    id: "local-dep-1",
    xero_invoice_id: "dep-1",
    job_id: "job-1",
    status: "PAID",
    invoice_type: "ACCREC",
    reference: "SWF-26003",
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

Deno.test("pipeline stage_truth=1: claimed draft rows load execution evidence", async () => {
  const tables = {
    ...PIPELINE_TABLES,
    jobs: [pipelineJob("job-1", "draft")],
    purchase_orders: [{
      id: "po-1",
      job_id: "job-1",
      po_type: "material",
      status: "sent",
      xero_po_id: "xero-po-1",
      confirmed_delivery_date: null,
      delivery_confirmed_at: null,
      delivery_date: null,
    }],
  };
  const result = await _pipelineForTest(
    makeClient(tables),
    new URLSearchParams("type=fencing&stage_truth=1"),
  );
  assertEquals(result.columns.draft[0].declared_stage, "draft");
  assertEquals(result.columns.draft[0].canonical_stage, "awaiting_supplier");
});

Deno.test("fencing evidence: only typed material POs can advance ordering", () => {
  const baseRows = {
    invoices: [{
      id: "local-dep",
      xero_invoice_id: "xero-dep",
      job_id: "job-1",
      status: "PAID",
      invoice_type: "ACCREC",
      reference: "SWF-26003",
      amount_paid: 100,
      fully_paid_on: "2026-08-01",
    }],
    poCommunications: [{
      id: "comm-1",
      job_id: "job-1",
      po_id: "po-material",
      direction: "outbound",
      created_at: "2026-08-02",
      sent_at: "2026-08-02",
      received_at: null,
    }],
    assignments: [],
    serviceReports: [],
    unreadable: [],
  };
  for (const poType of ["labour", "subcontract", null]) {
    const evidence = fencingExecutionEvidenceFromPipelineRows(
      "job-1",
      "xero-dep",
      {
        ...baseRows,
        purchaseOrders: [{
          id: `po-${poType}`,
          job_id: "job-1",
          po_type: poType,
          status: "sent",
        }],
      },
    );
    const got = deriveFencingStageV1(evidence, { now: NOW });
    assertEquals(got.canonical_stage, "order_materials");
    assertEquals(got.facts.material_order_sent, false);
  }
});

Deno.test("fencing evidence: tentative delivery date is not confirmation", () => {
  const evidence = fencingExecutionEvidenceFromPipelineRows(
    "job-1",
    "xero-dep",
    {
      invoices: [{
        id: "local-dep",
        xero_invoice_id: "xero-dep",
        job_id: "job-1",
        status: "PAID",
        invoice_type: "ACCREC",
        reference: "SWF-26003",
        amount_paid: 100,
        fully_paid_on: "2026-08-01",
      }],
      purchaseOrders: [{
        id: "po-1",
        job_id: "job-1",
        po_type: "material",
        status: "sent",
        confirmed_delivery_date: "2026-08-20",
        delivery_confirmed_at: null,
      }],
      poCommunications: [],
      assignments: [],
      serviceReports: [],
      unreadable: [],
    },
  );
  const got = deriveFencingStageV1(evidence, { now: NOW });
  assertEquals(got.canonical_stage, "awaiting_supplier");
  assertEquals(got.facts.order_confirmed, false);
});

Deno.test("fencing evidence: unsent outbound row is not dispatch proof", () => {
  const evidence = fencingExecutionEvidenceFromPipelineRows(
    "job-1",
    "xero-dep",
    {
      invoices: [{
        id: "local-dep",
        xero_invoice_id: "xero-dep",
        job_id: "job-1",
        status: "PAID",
        invoice_type: "ACCREC",
        reference: "SWF-26003",
        amount_paid: 100,
        fully_paid_on: "2026-08-01",
      }],
      purchaseOrders: [{
        id: "po-1",
        job_id: "job-1",
        po_type: "material",
        status: null,
      }],
      poCommunications: [{
        id: "comm-1",
        job_id: "job-1",
        po_id: "po-1",
        direction: "outbound",
        created_at: "2026-08-02",
        sent_at: null,
        message_id: "resend-1",
        received_at: null,
      }],
      assignments: [],
      serviceReports: [],
      unreadable: [],
    },
  );
  const got = deriveFencingStageV1(evidence, { now: NOW });
  assertEquals(got.canonical_stage, "order_materials");
  assertEquals(got.facts.material_order_sent, false);
});

Deno.test("fencing evidence: dry-run communication row is not dispatch proof", () => {
  const rows = {
    invoices: [{
      id: "local-dep",
      xero_invoice_id: "xero-dep",
      job_id: "job-1",
      status: "PAID",
      invoice_type: "ACCREC",
      reference: "SWF-26003",
      amount_paid: 100,
      fully_paid_on: "2026-08-01",
    }],
    purchaseOrders: [{
      id: "po-1",
      job_id: "job-1",
      po_type: "material",
      status: null,
    }],
    poCommunications: [{
      id: "comm-1",
      job_id: "job-1",
      po_id: "po-1",
      direction: "outbound",
      created_at: "2026-08-02",
      sent_at: "2026-08-02",
      message_id: null,
      received_at: null,
    }],
    assignments: [],
    serviceReports: [],
    unreadable: [],
  };
  const dryRunEvidence = fencingExecutionEvidenceFromPipelineRows(
    "job-1",
    "xero-dep",
    rows,
  );
  const dryRun = deriveFencingStageV1(dryRunEvidence, { now: NOW });
  assertEquals(dryRun.canonical_stage, "order_materials");
  assertEquals(dryRun.facts.material_order_sent, false);

  const dispatchedEvidence = fencingExecutionEvidenceFromPipelineRows(
    "job-1",
    "xero-dep",
    {
      ...rows,
      poCommunications: [{
        ...rows.poCommunications[0],
        message_id: "resend-1",
      }],
    },
  );
  const dispatched = deriveFencingStageV1(dispatchedEvidence, { now: NOW });
  assertEquals(dispatched.canonical_stage, "awaiting_supplier");
  assertEquals(dispatched.facts.material_order_sent, true);
});

Deno.test("fencing evidence: cancelled material PO cannot advance ordering", () => {
  const evidence = fencingExecutionEvidenceFromPipelineRows(
    "job-1",
    "xero-dep",
    {
      invoices: [{
        id: "local-dep",
        xero_invoice_id: "xero-dep",
        job_id: "job-1",
        status: "PAID",
        invoice_type: "ACCREC",
        reference: "SWF-26003",
        amount_paid: 100,
        fully_paid_on: "2026-08-01",
      }],
      purchaseOrders: [{
        id: "po-1",
        job_id: "job-1",
        po_type: "material",
        status: "cancelled",
      }],
      poCommunications: [{
        id: "comm-1",
        job_id: "job-1",
        po_id: "po-1",
        direction: "outbound",
        created_at: "2026-08-02",
        sent_at: "2026-08-02",
        message_id: "resend-1",
        received_at: null,
      }],
      assignments: [],
      serviceReports: [],
      unreadable: [],
    },
  );
  const got = deriveFencingStageV1(evidence, { now: NOW });
  assertEquals(evidence.purchase_orders, []);
  assertEquals(got.canonical_stage, "order_materials");
  assertEquals(got.facts.material_order_sent, false);
});

Deno.test("fencing stage truth: scheduling waits only for a dated assignment", () => {
  const waiting = FENCING_STAGE_TRUTH_BOUNDARY.find((row) =>
    row.id === "fence-105"
  );
  const dated = FENCING_STAGE_TRUTH_BOUNDARY.find((row) =>
    row.id === "fence-107"
  );
  assert(waiting);
  assert(dated);
  assertEquals(derive(waiting).canonical_stage, "schedule_install");
  assertEquals(derive(dated).canonical_stage, "scheduled");
});

Deno.test("fencing stage truth: rectification is an overlay, not a ladder rung", () => {
  const row = FENCING_STAGE_TRUTH_BOUNDARY.find((item) =>
    item.id === "fence-112"
  );
  assert(row);
  const got = derive(row);
  assertEquals(got.canonical_stage, "order_materials");
  assertEquals(got.rectification_pending?.assignment_id, "asg-fence-112");
});

Deno.test("fencing stage truth: completed install with pending rectification never archives", () => {
  const row = FENCING_STAGE_TRUTH_BOUNDARY.find((item) =>
    item.id === "fence-113"
  );
  assert(row);
  const evidence = structuredClone(row.evidence);
  evidence.assignments.push({
    id: "asg-rectify",
    status: "scheduled",
    assignment_type: "rectification",
    scheduled_date: "2026-08-28",
    started_at: null,
    completed_at: null,
    is_ghost: false,
    role: null,
  });
  const got = deriveFencingStageV1(evidence, { now: NOW });
  assertEquals(got.canonical_stage, "get_review");
  assertNotEquals(got.canonical_stage, "archived");
  assertEquals(got.rectification_pending?.assignment_id, "asg-rectify");
  const withoutOverlay = derive(row);
  assertEquals(withoutOverlay.canonical_stage, "archived");
});

Deno.test("fencing stage truth: ghost watcher rows are not field-work evidence", () => {
  const row = FENCING_STAGE_TRUTH_BOUNDARY.find((item) =>
    item.id === "fence-105"
  );
  assert(row);
  const evidence = structuredClone(row.evidence);
  evidence.assignments = [{
    id: "asg-ghost",
    status: "scheduled",
    assignment_type: "install",
    scheduled_date: "2026-09-15",
    started_at: null,
    completed_at: null,
    is_ghost: true,
    role: "observer",
  }];
  const got = deriveFencingStageV1(evidence, { now: NOW });
  assertEquals(got.canonical_stage, "schedule_install");
  assertEquals(got.facts.assignment_dated, false);
});

Deno.test("fencing stage truth: dated submitted assignment keeps scheduling evidence", () => {
  const row = FENCING_STAGE_TRUTH_BOUNDARY.find((item) =>
    item.id === "fence-106"
  );
  assert(row);
  const evidence = structuredClone(row.evidence);
  evidence.assignments = evidence.assignments.map((assignment) => ({
    ...assignment,
    status: "submitted",
  }));
  const got = deriveFencingStageV1(evidence, { now: NOW });
  assertEquals(got.canonical_stage, "scheduled");
  assertEquals(got.facts.assignment_dated, true);
});

Deno.test("fencing stage truth: archive clock uses latest completion proof", () => {
  const row = FENCING_STAGE_TRUTH_BOUNDARY.find((item) =>
    item.id === "fence-113"
  );
  assert(row);
  const evidence = structuredClone(row.evidence);
  evidence.service_reports.push({
    id: "report-newer",
    status: "submitted",
    submitted_at: "2026-08-25T16:00:00.000Z",
  });
  const got = deriveFencingStageV1(evidence, { now: NOW });
  assertEquals(got.canonical_stage, "get_review");
});

Deno.test("fencing stage truth fixture contract version is pinned", () => {
  assertEquals(
    FENCING_STAGE_TRUTH_FIXTURE_VERSION,
    "fencing-stage-truth-fixtures/v1",
  );
  assertEquals(FENCING_STAGE_TRUTH_PINNED_NOW, "2026-08-27T00:00:00.000Z");
});

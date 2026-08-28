// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
//
// The Repairs board becomes a real pipeline: update_repair_stage persists a
// stage move, pipeline?type=repair projects it top level where the UX reads it,
// and repair rows stay off the MakeSafe boards and out of private-roofing Xero.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _accountCodeForJob,
  _pipelineForTest,
  _trackingCategoryForJob,
  _updateRepairStage,
} from "./index.ts";
import {
  excludeInsuranceRepairs,
  INSURANCE_REPAIR_STAGES,
} from "./insurance_repairs_board.ts";
import {
  getStagesForType,
  isLegalForType,
} from "../_shared/stage-gate/job-state-machine.ts";

type Row = Record<string, any>;

const REPAIR_JOB_ID = "11111111-1111-4111-8111-111111111111";
const PATIO_JOB_ID = "22222222-2222-4222-8222-222222222222";

function makeStageClient(input: {
  jobs?: Row[];
  details?: Row[];
  updateError?: { message: string };
  /**
   * Fires ONCE, immediately after the handler's first read of `jobs`, so a test
   * can model somebody else committing in the window between the read and the
   * write. Nothing else can reproduce a lost update honestly.
   */
  concurrentWriteAfterJobRead?: (row: Row) => void;
} = {}) {
  const tables: Record<string, Row[]> = {
    jobs: input.jobs ? structuredClone(input.jobs) : [],
    makesafe_job_details: input.details ? structuredClone(input.details) : [],
    job_events: [],
  };
  let jobReadsSeen = 0;

  function builder(table: string) {
    let operation: "select" | "insert" | "update" = "select";
    let insertValue: Row | null = null;
    let updateValue: Row | null = null;
    const filters: Array<(row: Row) => boolean> = [];
    let executed: Promise<{ data: any; error: any }> | null = null;

    const matching = () =>
      (tables[table] || []).filter((row) => filters.every((f) => f(row)));

    const execute = () => {
      if (executed) return executed;
      executed = Promise.resolve().then(() => {
        if (operation === "select") {
          const rows = matching().map((row) => ({ ...row }));
          if (table === "jobs") {
            jobReadsSeen += 1;
            if (jobReadsSeen === 1 && input.concurrentWriteAfterJobRead) {
              for (const live of tables.jobs) input.concurrentWriteAfterJobRead(live);
            }
          }
          return { data: rows, error: null };
        }
        if (operation === "insert") {
          const row = { ...(insertValue || {}) };
          tables[table] = tables[table] || [];
          tables[table].push(row);
          return { data: [row], error: null };
        }
        if (input.updateError && table === "jobs") {
          return { data: null, error: input.updateError };
        }
        const updated: Row[] = [];
        for (const row of matching()) {
          Object.assign(row, updateValue || {});
          updated.push({ ...row });
        }
        return { data: updated, error: null };
      });
      return executed;
    };

    const chain: any = {
      select: () => chain,
      insert: (value: Row) => {
        operation = "insert";
        insertValue = value;
        return chain;
      },
      update: (value: Row) => {
        operation = "update";
        updateValue = value;
        return chain;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return chain;
      },
      maybeSingle: async () => {
        const result = await execute();
        const rows = Array.isArray(result.data) ? result.data : [];
        return { data: rows[0] || null, error: result.error };
      },
      then: (resolve: any, reject: any) => execute().then(resolve, reject),
      catch: (reject: any) => execute().catch(reject),
    };
    return chain;
  }

  return { tables, from: (table: string) => builder(table) };
}

function typedRepairJob(extra: Row = {}): Row {
  return {
    id: REPAIR_JOB_ID,
    org_id: "00000000-0000-0000-0000-000000000001",
    type: "repair",
    status: "accepted",
    job_number: "SWR-261400",
    updated_at: "2026-08-26T00:00:00Z",
    metadata: {
      repair_stage: "wo_in",
      makesafe_job_family: "repair",
      intake_mint_id: "mint-1",
    },
    ...extra,
  };
}

Deno.test("a repair stage move persists, keeps the rest of metadata, and is audited", async () => {
  const client = makeStageClient({ jobs: [typedRepairJob()] });

  const result: any = await _updateRepairStage(client, {
    jobId: REPAIR_JOB_ID,
    stage: "scoping",
    operator_email: "admin@secureworkswa.com.au",
  });

  assertEquals(result.success, true);
  assertEquals(result.job.id, REPAIR_JOB_ID);
  assertEquals(result.job.repair_stage, "scoping");
  assertEquals(result.job.previous_repair_stage, "wo_in");
  assertEquals(result.job.job_number, "SWR-261400");

  const job = client.tables.jobs[0];
  assertEquals(job.metadata.repair_stage, "scoping");
  // jobs.status is the money/lifecycle spine and a board move must never touch it.
  assertEquals(job.status, "accepted");
  // Nothing else in metadata may be clobbered by the merge.
  assertEquals(job.metadata.intake_mint_id, "mint-1");
  assertEquals(job.metadata.makesafe_job_family, "repair");

  const audit = client.tables.job_events.find((row) =>
    row.event_type === "repair_stage_changed"
  );
  assert(audit, "a stage move must leave an audit trail");
  assertEquals(audit.job_id, REPAIR_JOB_ID);
  assertEquals(audit.detail_json.from_stage, "wo_in");
  assertEquals(audit.detail_json.to_stage, "scoping");
  assertEquals(audit.detail_json.operator_email, "admin@secureworkswa.com.au");
});

Deno.test("every one of the nine board stages is accepted, and nothing else is", async () => {
  for (const stage of INSURANCE_REPAIR_STAGES) {
    const client = makeStageClient({ jobs: [typedRepairJob()] });
    const result: any = await _updateRepairStage(client, {
      jobId: REPAIR_JOB_ID,
      stage,
    });
    assertEquals(result.job.repair_stage, stage);
  }

  for (const rejected of ["", "wip", "on site", "awaiting_scope", "invoiced"]) {
    const client = makeStageClient({ jobs: [typedRepairJob()] });
    await assertRejects(
      () => _updateRepairStage(client, { jobId: REPAIR_JOB_ID, stage: rejected }),
      Error,
    );
    // A refused stage must leave the card exactly where it was.
    assertEquals(client.tables.jobs[0].metadata.repair_stage, "wo_in");
    assertEquals(client.tables.job_events.length, 0);
  }
});

Deno.test("the stage writer refuses a job it cannot identify as repair work", async () => {
  const patio = {
    id: PATIO_JOB_ID,
    org_id: "00000000-0000-0000-0000-000000000001",
    type: "patio",
    status: "processing",
    job_number: "SWP-26100",
    metadata: {},
  };
  const client = makeStageClient({ jobs: [patio] });

  const error = await assertRejects(
    () => _updateRepairStage(client, { jobId: PATIO_JOB_ID, stage: "scoping" }),
    Error,
  );
  assertStringIncludes(String(error.message), "not a repair-family job");
  assertEquals(client.tables.jobs[0].metadata.repair_stage, undefined);
  assertEquals(client.tables.job_events.length, 0);
});

Deno.test("a missing job and a missing bound are refused before any write", async () => {
  const empty = makeStageClient({ jobs: [] });
  await assertRejects(
    () => _updateRepairStage(empty, { jobId: REPAIR_JOB_ID, stage: "scoping" }),
    Error,
  );

  const client = makeStageClient({ jobs: [typedRepairJob()] });
  await assertRejects(() => _updateRepairStage(client, { stage: "scoping" }), Error);
  await assertRejects(
    () => _updateRepairStage(client, { jobId: REPAIR_JOB_ID }),
    Error,
  );
  assertEquals(client.tables.job_events.length, 0);
});

Deno.test("a concurrent write to the job is refused, not silently clobbered", async () => {
  // jobs.metadata is one jsonb blob and PostgREST has no partial-object patch, so
  // the stage move is a read-modify-write. On these cards that blob is busy —
  // intake_mint_id, makesafe_job_family, ses_family, builder_work_order_number,
  // builder_po_number — and the dashboard fires optimistic moves, so two writes
  // racing is plausible. The update carries the row version it read, so a race
  // writes nothing and says so instead of discarding the other write.
  const client = makeStageClient({
    jobs: [typedRepairJob()],
    // Somebody else commits in the window between our read and our write.
    concurrentWriteAfterJobRead: (row) => {
      row.updated_at = "2026-08-26T00:05:00Z";
      row.metadata.builder_po_number = "PO-WRITTEN-BY-SOMEONE-ELSE";
    },
  });

  const error = await assertRejects(
    () => _updateRepairStage(client, { jobId: REPAIR_JOB_ID, stage: "quoted" }),
    Error,
  );
  assertStringIncludes(String(error.message), "changed while its stage was being moved");

  // The other party's write survives untouched and ours did not land.
  assertEquals(
    client.tables.jobs[0].metadata.builder_po_number,
    "PO-WRITTEN-BY-SOMEONE-ELSE",
  );
  assertEquals(client.tables.jobs[0].metadata.repair_stage, "wo_in");
  assertEquals(client.tables.job_events.length, 0);
});

Deno.test("the stage move is scoped to the org on the read and on the write", async () => {
  // Every sibling read scopes by org. This is the one WRITE, so it matters most.
  const foreign = typedRepairJob({
    org_id: "00000000-0000-0000-0000-0000000000ff",
  });
  const client = makeStageClient({ jobs: [foreign] });

  await assertRejects(
    () => _updateRepairStage(client, { jobId: REPAIR_JOB_ID, stage: "quoted" }),
    Error,
    "not found",
  );
  assertEquals(client.tables.jobs[0].metadata.repair_stage, "wo_in");
});

Deno.test("the three legacy repair vintages can be moved without being retyped", async () => {
  // The live repair cards predate jobs.type='repair': one carries
  // metadata.makesafe_job_family, two carry metadata.ses_family, and two are
  // only identifiable through makesafe_job_details.report_type. The board reads
  // all of those additively and the writer must accept exactly the same set,
  // otherwise the historic cards become undraggable the day the type ships.
  const vintages: Array<{ label: string; job: Row; details?: Row[] }> = [
    {
      label: "metadata.makesafe_job_family",
      job: {
        id: REPAIR_JOB_ID,
        org_id: "00000000-0000-0000-0000-000000000001",
        type: "makesafe",
        status: "processing",
        job_number: "SWMS-261029",
        metadata: { makesafe_job_family: "repair" },
      },
    },
    {
      label: "metadata.ses_family",
      job: {
        id: REPAIR_JOB_ID,
        org_id: "00000000-0000-0000-0000-000000000001",
        type: "makesafe",
        status: "processing",
        job_number: "SWMS-261192",
        metadata: { ses_family: "repair" },
      },
    },
    {
      label: "makesafe_job_details.report_type",
      job: {
        id: REPAIR_JOB_ID,
        org_id: "00000000-0000-0000-0000-000000000001",
        type: "makesafe",
        status: "processing",
        job_number: "SWMS-261163",
        metadata: { makesafe_job_family: "general_makesafe" },
      },
      details: [{ job_id: REPAIR_JOB_ID, report_type: "repair" }],
    },
  ];

  for (const vintage of vintages) {
    const client = makeStageClient({
      jobs: [vintage.job],
      details: vintage.details,
    });
    const result: any = await _updateRepairStage(client, {
      jobId: REPAIR_JOB_ID,
      stage: "quoted",
    });
    assertEquals(result.job.repair_stage, "quoted", vintage.label);
    // These cards are all status 'processing', which the board maps to on_site.
    assertEquals(result.job.previous_repair_stage, "on_site", vintage.label);
    assertEquals(client.tables.jobs[0].type, "makesafe", vintage.label);
  }
});

// ── pipeline?type=repair — the API contract the UX board reads ────────────────

function repairPipelineClient(rows: Row[]) {
  const repairIds = rows.map((row) => row.id);
  return {
    from(table: string) {
      const call: any = { table, select: "", filters: [] as any[] };
      const query: any = {};
      query.select = (columns: string) => {
        call.select = columns;
        return query;
      };
      for (const method of ["eq", "in", "not", "or", "is", "neq"]) {
        query[method] = (column: string, value: unknown) => {
          call.filters.push({ method, column, value });
          return query;
        };
      }
      query.order = () => query;
      query.limit = () => query;
      query.range = () => query;
      query.then = (resolve: any, reject: any) =>
        Promise.resolve(resultFor()).then(resolve, reject);

      function resultFor() {
        if (call.table === "makesafe_job_details") return { data: [], error: null };
        if (call.table === "jobs" && call.select === "id") {
          const typed = call.filters.find((f: any) => f.column === "type");
          return { data: typed ? repairIds.map((id) => ({ id })) : [], error: null };
        }
        if (call.table === "jobs" && call.select.startsWith("id, type, status")) {
          return { data: rows.map((row) => ({ ...row })), error: null };
        }
        return { data: [], error: null };
      }

      return query;
    },
  };
}

function pipelineRow(extra: Row = {}): Row {
  return {
    id: REPAIR_JOB_ID,
    type: "repair",
    status: "accepted",
    client_name: "Storm Damage Client",
    client_phone: null,
    site_address: "12 Example Street",
    site_suburb: "Midland",
    pj_total_inc: null,
    pj_total: null,
    pj_split_neighbours: null,
    pj_job_neighbours: null,
    ghl_contact_id: null,
    ghl_opportunity_id: null,
    job_number: "SWR-261400",
    accepted_at: "2026-08-26T00:00:00Z",
    approvals_at: null,
    deposit_at: null,
    processing_at: null,
    scheduled_at: null,
    completed_at: null,
    created_at: "2026-08-26T00:00:00Z",
    updated_at: "2026-08-26T00:00:00Z",
    deposit_invoice_id: null,
    deposit_amount: null,
    council_required: null,
    metadata: { repair_stage: "wo_in", makesafe_job_family: "repair" },
    ...extra,
  };
}

Deno.test("pipeline?type=repair lifts the persisted stage to the top level the UX reads", async () => {
  // The dashboard's repairStageOf reads j.repair_stage / j.board_stage and never
  // touches j.metadata. A stage persisted only in metadata would therefore be
  // invisible and every card would silently fall through to the status map —
  // which maps 'accepted' to APPROVED, not WO In.
  const result: any = await _pipelineForTest(
    repairPipelineClient([pipelineRow()]),
    new URLSearchParams("type=repair"),
  );

  assertEquals(result.total, 1);
  const row = result.columns.accepted[0];
  assertEquals(row.repair_stage, "wo_in");
  assertEquals(row.job_number, "SWR-261400");
  assertEquals(row.site_suburb, "Midland");
  assertEquals(row.type, "repair");
  assertEquals(row.source_type, "repair");
  // metadata never leaves the API on this projection.
  assertEquals("metadata" in row, false);
});

Deno.test("pipeline?type=repair still maps a legacy card with no stamp off its status", async () => {
  const legacy = pipelineRow({
    type: "makesafe",
    status: "processing",
    job_number: "SWMS-261029",
    metadata: { makesafe_job_family: "repair" },
  });
  const result: any = await _pipelineForTest(
    repairPipelineClient([legacy]),
    new URLSearchParams("type=repair"),
  );
  const row = result.columns.processing[0];
  assertEquals(row.repair_stage, "on_site");
  assertEquals(row.source_type, "makesafe");
  assertEquals(row.type, "repair");
});

Deno.test("a persisted stage beats the status map on the very same row", async () => {
  const moved = pipelineRow({
    status: "processing",
    metadata: { repair_stage: "materials", makesafe_job_family: "repair" },
  });
  const result: any = await _pipelineForTest(
    repairPipelineClient([moved]),
    new URLSearchParams("type=repair"),
  );
  // status 'processing' would map to on_site; the operator moved it to materials.
  assertEquals(result.columns.processing[0].repair_stage, "materials");
});

Deno.test("a true repair job is filtered off the external MakeSafe boards", async () => {
  const rows = [
    { id: "a", type: "repair", job_number: "SWR-261400" },
    { id: "b", type: "makesafe", job_number: "SWMS-261400" },
    { id: "c", type: "makesafe", metadata: { makesafe_job_family: "repair" } },
  ];
  assertEquals(excludeInsuranceRepairs(rows).map((row: any) => row.id), ["b"]);
});

Deno.test("the stage gate stops offering a repair job the patio money ladder", async () => {
  // Diagnosis blocker B12. 'repair' was not in the JobType union, so
  // getStagesForType fell through to its patio default and a repair job was
  // judged legal for approvals / awaiting_deposit / get_review — a patio money
  // ladder on an insurance work order.
  const repair = getStagesForType("repair");
  const patio = getStagesForType("patio");
  assertEquals(repair === patio, false);
  assertEquals(isLegalForType("accepted", "repair"), true);
  assertEquals(isLegalForType("processing", "repair"), true);
  assertEquals(isLegalForType("complete", "repair"), true);
  assertEquals(isLegalForType("approvals", "repair"), false);
  assertEquals(isLegalForType("get_review", "repair"), false);
  assertEquals(isLegalForType("awaiting_deposit", "repair"), false);

  // CONTROLS: every other type is exactly as it was.
  assertEquals(isLegalForType("approvals", "patio"), true);
  assertEquals(isLegalForType("order_confirmed", "fencing"), true);
  assertEquals(isLegalForType("accepted", "makesafe"), true);
  assertEquals(isLegalForType("approvals", "makesafe"), false);
  // An unknown type still gets the safe patio default.
  assertEquals(getStagesForType("something_new"), patio);
});

// ── Xero — repair revenue is SES insurance work, not private roofing ──────────

Deno.test("a SWR- repair job books to make-safe tracking, never private roofing", () => {
  assertEquals(_trackingCategoryForJob("SWR-261400", "repair"), "SW - MAKESAFE");
  assertEquals(_accountCodeForJob("repair"), "210");

  // A repair job that has not been numbered yet still books correctly: the
  // explicit type is checked before the number, and it is the better answer.
  assertEquals(_trackingCategoryForJob("", "repair"), "SW - MAKESAFE");

  // The SWR- PREFIX no longer decides anything on its own. It is shared by
  // renovation, roofing and repair, so a bare number now gets NO category rather
  // than a wrong one — every caller already handles the empty answer (skip
  // Tracking, or fall back to 'Construction' in a description), whereas a wrong
  // one misfiles revenue and nobody notices until month end.
  assertEquals(_trackingCategoryForJob("SWR-261400"), "");
  // Told the type, it answers exactly — including for the prefix's two prior owners.
  assertEquals(
    _trackingCategoryForJob("SWR-261400", "roofing"),
    "SW - PRIVATE ROOFING",
  );
  assertEquals(
    _trackingCategoryForJob("SWR-261400", "renovation"),
    "SW - PRIVATE ROOFING",
  );

  // CONTROLS: every other prefix answers from the number exactly as before,
  // with or without a type.
  assertEquals(_trackingCategoryForJob("SWMS-261400"), "SW - MAKESAFE");
  assertEquals(_trackingCategoryForJob("SWMS-261400", "makesafe"), "SW - MAKESAFE");
  assertEquals(_trackingCategoryForJob("AJBR-1234"), "SW - MAKESAFE");
  assertEquals(_trackingCategoryForJob("SWP-26100"), "SW - PATIOS");
  assertEquals(_trackingCategoryForJob("SWP-26100", "patio"), "SW - PATIOS");
  assertEquals(_trackingCategoryForJob("SWF-26100"), "SW - FENCING");
  assertEquals(_trackingCategoryForJob("SWF-26100", "fencing"), "SW - FENCING");
  assertEquals(_trackingCategoryForJob("SWD-26100"), "SW - DECKING");
  assertEquals(_trackingCategoryForJob("SWI-26100"), "SW - INSURANCE WORK");
  assertEquals(_trackingCategoryForJob(""), "");
  assertEquals(_trackingCategoryForJob("", "patio"), "");
  assertEquals(_accountCodeForJob("makesafe"), "210");
  assertEquals(_accountCodeForJob("patio"), "208");
  assertEquals(_accountCodeForJob("fencing"), "207");
  assertEquals(_accountCodeForJob("roofing"), "209");
  assertEquals(_accountCodeForJob("renovation"), "201");
  assertEquals(_accountCodeForJob("something_new"), "200");
});

Deno.test("the client-revenue invoice paths resolve their category by job type", async () => {
  // createInvoice and the invoice-update path both derived Tracking from the
  // Xero REFERENCE alone, which for a repair job is an SWR- number. That is the
  // ACCREC path — real client revenue — so both now read the bound job's type.
  const source = (await Deno.readTextFile(new URL("./index.ts", import.meta.url)))
    .split("\r\n").join("\n");
  assertStringIncludes(source, "trackingCategoryForJob(ref, invoiceJobType)");
  assertStringIncludes(source, "trackingCategoryForJob(updateRef, updateJobType)");
  // No ACCREC site may still resolve from a bare reference.
  assertEquals(source.includes("trackingCategoryForJob(ref)"), false);
  assertEquals(source.includes("trackingCategoryForJob(updateRef)"), false);
});

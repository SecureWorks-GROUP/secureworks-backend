// deno-lint-ignore-file no-import-prefix no-explicit-any
// Automatic repair intake: the pure rules. The scan-level replays (the Ambrose
// repair orders, the Kinross order, the Halls Head collection order) live in
// makesafe_deterministic_intake_runtime_test.ts. Fixtures are synthetic.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDeterministicIntakePlan,
  type DeterministicCasePlan,
} from "./makesafe_deterministic_intake.ts";
import {
  AMBROSE_TEST_COMPANY_ID,
  ambroseSource,
} from "./makesafe_ambrose_intake_fixtures.ts";
import {
  builderDeclaredRepair,
  decideRepairAutoIntake,
  landWorkOrderOnRepairJob,
  MAKE_SAFE_RAISED_ON_REPAIR_CLAIM_EVENT,
  matchOpenRepairJob,
  noteMakeSafeRaisedOnRepairClaim,
  openRepairJobsOnClaim,
  orphanLifecycleOrderOpensReviewDraft,
  readWorkOrderValueExGst,
  REPAIR_AUTO_INTAKE_VERSION,
  REPAIR_WORK_ORDER_LANDED_EVENT,
  repairAutoIntakeMintStamp,
  repairIntakeAutoEnabled,
  withoutBuilderOrderValue,
} from "./repair_intake_auto.ts";

const PREFIXES = ["MLB", "AJBR", "ACG"];

function ambrosePlan(kind: "repair" | "make_safe"): DeterministicCasePlan {
  const plan = buildDeterministicIntakePlan(
    [ambroseSource("post-1", {
      job: "20999202",
      sequence: "05",
      address: "7 Sample Road Demoville WA 6010",
      kind,
    })],
    [{
      id: AMBROSE_TEST_COMPANY_ID,
      slug: "acg",
      name: "Ambrose Construct Group",
      senderPatterns: ["ambrose.test"],
    }],
  ).cases[0];
  assertEquals(plan.state, "confirmed_live_job");
  return plan;
}

Deno.test("the flag reads off when it is missing, off, unreadable or the read throws", async () => {
  const client = (result: any) => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () =>
            result instanceof Error
              ? Promise.reject(result)
              : Promise.resolve(result),
        }),
      }),
    }),
  });
  assertEquals(
    await repairIntakeAutoEnabled(client({ data: [], error: null })),
    false,
  );
  assertEquals(
    await repairIntakeAutoEnabled(
      client({ data: [{ enabled: false }], error: null }),
    ),
    false,
  );
  assertEquals(
    await repairIntakeAutoEnabled(
      client({ data: null, error: { message: "boom" } }),
    ),
    false,
  );
  assertEquals(await repairIntakeAutoEnabled(client(new Error("net"))), false);
  assertEquals(
    await repairIntakeAutoEnabled(
      client({ data: [{ enabled: true }], error: null }),
    ),
    true,
  );
});

Deno.test("a work order value is read only when the PDF states exactly one", () => {
  assertEquals(
    readWorkOrderValueExGst(
      "TOTAL Purchase Order Price (ex GST) $2,529.00\nTrade Type",
    ),
    2529,
  );
  assertEquals(
    readWorkOrderValueExGst(
      "Totals Totals\nSubtotal $1,080.00\nGST $108.00\nTotal $1,188.00\n",
    ),
    1080,
  );
  // A subtotal and GST that do not make the total is not a value we read.
  assertEquals(
    readWorkOrderValueExGst("Subtotal $1,080.00\nGST $108.00\nTotal $1,500.00"),
    null,
  );
  // Two different totals in one PDF is conflicting detail.
  assertEquals(
    readWorkOrderValueExGst(
      "TOTAL Purchase Order Price (ex GST) $100.00\nTOTAL Purchase Order Price (ex GST) $250.00",
    ),
    null,
  );
  assertEquals(readWorkOrderValueExGst("no totals here"), null);
  assertEquals(readWorkOrderValueExGst(null), null);
});

Deno.test("a builder-declared Ambrose repair with nothing missing may be approved automatically", () => {
  const plan = ambrosePlan("repair");
  assertEquals(plan.familyEvidence, ["ambrose_declared_repair"]);
  const decision = decideRepairAutoIntake(plan);
  assertEquals(decision, {
    auto: true,
    stamp: {
      version: REPAIR_AUTO_INTAKE_VERSION,
      builder: "acg",
      family_evidence: ["ambrose_declared_repair"],
      work_order_value_ex_gst: 200,
    },
  });
});

Deno.test("anything that does not read cleanly keeps its person", () => {
  const plan = ambrosePlan("repair");
  const reason = (override: Partial<DeterministicCasePlan>) => {
    const decision = decideRepairAutoIntake({ ...plan, ...override });
    return decision.auto ? "auto" : decision.reason;
  };
  // CONTROL: the same plan untouched is automatic.
  assertEquals(reason({}), "auto");
  assertEquals(
    reason({ identity: { ...plan.identity, jobFamily: "general_makesafe" } }),
    "not_repair_family",
  );
  // A repair read off scope words or by elimination is an inference.
  assertEquals(
    reason({ familyEvidence: ["repair_replacement_scope"] }),
    "repair_not_declared_by_builder",
  );
  assertEquals(
    reason({ familyEvidence: ["ambiguous_scope"] }),
    "repair_not_declared_by_builder",
  );
  assertEquals(
    reason({ familyEvidence: [] }),
    "repair_not_declared_by_builder",
  );
  assertEquals(
    reason({ familyEvidence: ["identified_wo_repair_complement"] }),
    "repair_not_declared_by_builder",
  );
  // Two emails that disagree about what the work is.
  assertEquals(
    reason({
      familyEvidence: ["ambrose_declared_repair", "physical_makesafe"],
    }),
    "repair_not_declared_by_builder",
  );
  // The builder's declaration decides: replacement wording on another email
  // of the same order agrees with it and holds nothing back.
  assertEquals(
    reason({
      familyEvidence: ["ambrose_declared_repair", "repair_replacement_scope"],
    }),
    "auto",
  );
  // A builder the owner did not name.
  assertEquals(
    reason({ identity: { ...plan.identity, builderSlug: "aj" } }),
    "builder_not_named",
  );
  assertEquals(
    reason({ identity: { ...plan.identity, companyId: null } }),
    "builder_not_named",
  );
  assertEquals(
    reason({ identity: { ...plan.identity, siteAddress: null } }),
    "client_or_site_missing",
  );
  assertEquals(
    reason({ identity: { ...plan.identity, builderPoCanonical: null } }),
    "builder_reference_or_purchase_order_missing",
  );
  assertEquals(
    reason({ conflictingFields: { site_address: ["a", "b"] } }),
    "conflicting_fields",
  );
  assertEquals(reason({ state: "exception" }), "plan_not_live");
  assertEquals(reason({ missingFields: ["client_name"] }), "missing_fields");
  assertEquals(
    reason({ blockedReasons: ["missing:portal_capture"] }),
    "missing_fields",
  );
  // A missing customer phone alone does not hold a make-safe today, and does
  // not hold a repair either.
  assertEquals(
    reason({
      state: "blocked_live_job",
      blockedReasons: ["missing:client_phone"],
      missingFields: ["client_phone"],
    }),
    "auto",
  );
  // A value that cannot be read never holds the order: it is automatic, with
  // the value left empty.
  const unread = decideRepairAutoIntake({
    ...plan,
    pdfDocuments: plan.pdfDocuments.map((document) => ({
      ...document,
      text: String(document.text).replace(
        /TOTAL Purchase Order Price \(ex GST\) \$[\d.,]+/,
        "TOTAL Purchase Order Price (ex GST) see schedule",
      ),
    })),
  });
  assertEquals(unread.auto && unread.stamp.work_order_value_ex_gst, null);
  // An amended order is a change to work a person already knows about.
  assertEquals(
    reason({ parentRelation: "revision_of" }),
    "not_a_first_issue_order",
  );
});

Deno.test("a repair is declared by the builder's own statement, never by scope wording alone", () => {
  assertEquals(builderDeclaredRepair(["rapid_repair_signal"]), true);
  assertEquals(builderDeclaredRepair(["pdf_declared_type_header"]), true);
  assertEquals(
    builderDeclaredRepair(["rapid_repair_signal", "repair_replacement_scope"]),
    true,
  );
  assertEquals(builderDeclaredRepair(["repair_replacement_scope"]), false);
  assertEquals(
    builderDeclaredRepair(["identified_wo_repair_complement"]),
    false,
  );
  assertEquals(
    builderDeclaredRepair(["rapid_repair_signal", "physical_makesafe"]),
    false,
  );
  assertEquals(builderDeclaredRepair([]), false);
});

Deno.test("a make-safe plan is never an automatic repair", () => {
  const decision = decideRepairAutoIntake(ambrosePlan("make_safe"));
  assertEquals(decision, { auto: false, reason: "not_repair_family" });
});

Deno.test("the mint-time stamp is judged on the draft, not on the caller", () => {
  const extraction = {
    deterministic_intake: true,
    makesafe_job_family: "repair",
    builder_po_number: "PO-2099920205",
    repair_auto_intake: {
      version: REPAIR_AUTO_INTAKE_VERSION,
      builder: "acg",
      family_evidence: ["ambrose_declared_repair"],
      work_order_value_ex_gst: 200,
    },
  };
  const stamp = (override: Record<string, any>, slug = "acg", fam = "repair") =>
    repairAutoIntakeMintStamp({
      extraction: { ...extraction, ...override },
      requestingCompanySlug: slug,
      reviewedFamily: fam,
    });
  assertEquals(stamp({})?.work_order_value_ex_gst, 200);
  // A draft that was waiting before the flag was on carries no stamp.
  assertEquals(stamp({ repair_auto_intake: undefined }), null);
  assertEquals(stamp({ deterministic_intake: false }), null);
  assertEquals(stamp({ makesafe_job_family: "general_makesafe" }), null);
  assertEquals(stamp({ builder_po_number: null }), null);
  assertEquals(stamp({}, "aj"), null);
  // The stamp names one builder; it cannot be carried to another.
  assertEquals(stamp({}, "mlb"), null);
  assertEquals(stamp({}, "acg", "general_makesafe"), null);
  assertEquals(
    stamp({
      repair_auto_intake: {
        ...extraction.repair_auto_intake,
        family_evidence: ["identified_wo_repair_complement"],
      },
    }),
    null,
  );
  // A stamp resting on scope wording alone is no stamp either.
  assertEquals(
    stamp({
      repair_auto_intake: {
        ...extraction.repair_auto_intake,
        family_evidence: ["repair_replacement_scope"],
      },
    }),
    null,
  );
  // A value that was not read, or is not a usable figure, leaves the stamp
  // standing with the value empty: it never decides whether a job is made.
  for (const unread of [null, 0, -5, "200", undefined]) {
    const result = stamp({
      repair_auto_intake: {
        ...extraction.repair_auto_intake,
        work_order_value_ex_gst: unread,
      },
    });
    assertEquals(result?.builder, "acg");
    assertEquals(result?.work_order_value_ex_gst, null);
  }
});

function repairRow(input: {
  jobId: string;
  jobNumber?: string;
  ref?: string | null;
  slug?: string | null;
  type?: string;
  status?: string;
  metadata?: Record<string, any>;
}) {
  return {
    job_id: input.jobId,
    external_ref: input.ref === undefined ? "MLB-49502" : input.ref,
    requesting_company_slug: input.slug === undefined ? "mlb" : input.slug,
    requesting_company_name: null,
    jobs: {
      job_number: input.jobNumber || `SWR-${input.jobId}`,
      type: input.type || "repair",
      status: input.status || "accepted",
      metadata: {
        repair_stage: "scoping",
        builder_claim_ref: input.ref === undefined ? "MLB-49502" : input.ref,
        ...(input.metadata || {}),
      },
    },
  };
}

const ORDER = {
  builderSlug: "mlb",
  externalRefCanonical: "MLB-49502",
  builderWoCanonical: "MLB-49502PO-69815",
  builderPoCanonical: "PO-69815",
};

Deno.test("an order finds the open repair job on its builder and claim", () => {
  const match = (rows: any[], order = ORDER) =>
    matchOpenRepairJob(order, rows, PREFIXES);
  assertEquals(match([]), { kind: "none" });
  // The quote-stage card: claim only, no purchase order yet.
  assertEquals(match([repairRow({ jobId: "a" })]), {
    kind: "one",
    jobId: "a",
    jobNumber: "SWR-a",
    relation: "empty",
    externalRef: "MLB-49502",
  });
  // The job already holds this purchase order (a re-send).
  assertEquals(
    match([
      repairRow({
        jobId: "a",
        ref: "MLB-49502PO-69815",
        metadata: { builder_po_number: "PO-69815" },
      }),
    ]),
    {
      kind: "one",
      jobId: "a",
      jobNumber: "SWR-a",
      relation: "same",
      externalRef: "MLB-49502PO-69815",
    },
  );
  // The job holds another purchase order on the same claim.
  assertEquals(
    match([
      repairRow({ jobId: "a", metadata: { builder_po_number: "PO-11111" } }),
    ]),
    {
      kind: "one",
      jobId: "a",
      jobNumber: "SWR-a",
      relation: "different",
      externalRef: "MLB-49502",
    },
  );
  // The job's own purchase order sits only in its detail row's reference.
  assertEquals(
    match([repairRow({ jobId: "a", ref: "MLB-49502PO-11111" })]),
    {
      kind: "one",
      jobId: "a",
      jobNumber: "SWR-a",
      relation: "different",
      externalRef: "MLB-49502PO-11111",
    },
  );
  // An additional work order recorded earlier counts as held.
  assertEquals(
    match([
      repairRow({
        jobId: "a",
        metadata: {
          builder_po_number: "PO-11111",
          builder_additional_work_orders: [{ purchase_order: "PO-69815" }],
        },
      }),
    ]),
    {
      kind: "one",
      jobId: "a",
      jobNumber: "SWR-a",
      relation: "same",
      externalRef: "MLB-49502",
    },
  );
});

Deno.test("only an open repair job of the same builder and claim matches", () => {
  const none = (row: any) =>
    assertEquals(matchOpenRepairJob(ORDER, [row], PREFIXES), { kind: "none" });
  none(repairRow({ jobId: "a", ref: "MLB-40000" }));
  none(repairRow({ jobId: "a", slug: "acg" }));
  none(repairRow({ jobId: "a", type: "makesafe" }));
  none(repairRow({ jobId: "a", type: "fencing" }));
  none(repairRow({ jobId: "a", status: "cancelled" }));
  none(repairRow({ jobId: "a", metadata: { repair_stage: "complete" } }));
  // The board stage decides open, not a status that went stale behind it.
  assertEquals(
    matchOpenRepairJob(
      ORDER,
      [repairRow({
        jobId: "a",
        status: "archived",
        metadata: { repair_stage: "scheduled" },
      })],
      PREFIXES,
    ).kind,
    "one",
  );
  // An order with no purchase order of its own never matches.
  assertEquals(
    matchOpenRepairJob(
      { ...ORDER, builderPoCanonical: null },
      [repairRow({ jobId: "a" })],
      PREFIXES,
    ),
    { kind: "none" },
  );
});

Deno.test("several open repair jobs on one claim are a person's call, unless one holds this purchase order", () => {
  const rows = [
    repairRow({ jobId: "a", metadata: { builder_po_number: "PO-11111" } }),
    repairRow({ jobId: "b", metadata: { builder_po_number: "PO-22222" } }),
  ];
  assertEquals(matchOpenRepairJob(ORDER, rows, PREFIXES), {
    kind: "many",
    jobIds: ["a", "b"],
    jobNumbers: ["SWR-a", "SWR-b"],
  });
  rows.push(
    repairRow({ jobId: "c", metadata: { builder_po_number: "PO-69815" } }),
  );
  assertEquals(matchOpenRepairJob(ORDER, rows, PREFIXES), {
    kind: "one",
    jobId: "c",
    jobNumber: "SWR-c",
    relation: "same",
    externalRef: "MLB-49502",
  });
});

function landingClient(job: Record<string, any>) {
  const events: any[] = [];
  const writes: any[] = [];
  return {
    events,
    writes,
    job,
    client: {
      from(table: string) {
        const filters: Record<string, any> = {};
        let insert: any = null;
        let update: any = null;
        const query: any = {
          select: () => query,
          eq: (column: string, value: any) => {
            filters[column] = value;
            if (update && table === "jobs" && column === "id") {
              writes.push(update);
              Object.assign(job, update);
            }
            return query;
          },
          update: (payload: any) => {
            update = payload;
            return query;
          },
          insert: (payload: any) => {
            insert = payload;
            if (table === "job_events") events.push(payload);
            return Promise.resolve({ data: null, error: null });
          },
          maybeSingle: () =>
            Promise.resolve({
              data: table === "jobs" ? { ...job } : null,
              error: null,
            }),
          then: (resolve: (value: any) => unknown) =>
            resolve({
              data: table === "job_events"
                ? events.filter((event) =>
                  event.event_type === filters.event_type
                )
                : [],
              error: insert ? null : null,
            }),
        };
        return query;
      },
    } as any,
  };
}

const LANDING = {
  jobId: "job-1",
  jobExternalRef: "MLB-49502",
  caseId: "case-1",
  instructionKey: "key/cycle:1",
  claimRef: "MLB-49502",
  workOrderNumber: "MLB-49502PO-69815",
  purchaseOrder: "PO-69815",
  jobFamily: "repair",
  valueExGst: 1080,
  sourcePostIds: ["post-1"],
  receivedAt: "2026-07-20T01:00:00.000Z",
  attachments: [{ file_name: "work_order.pdf", storage_url: "a/b.pdf" }],
};

Deno.test("landing records the purchase order on a job that has none, once", async () => {
  const db = landingClient({
    id: "job-1",
    job_number: "SWR-1",
    type: "repair",
    status: "accepted",
    metadata: { repair_stage: "scoping", builder_claim_ref: "MLB-49502" },
  });
  const attached: any[] = [];
  const deps = {
    attachEvidence: (
      _c: any,
      jobIds: readonly string[],
      atts: readonly any[],
    ) => {
      attached.push([jobIds, atts]);
      return Promise.resolve();
    },
  };
  const first = await landWorkOrderOnRepairJob(db.client, LANDING, deps);
  assertEquals(first, { relation: "empty", eventCreated: true });
  assertEquals(db.job.metadata.builder_po_number, "PO-69815");
  assertEquals(db.job.metadata.builder_work_order_number, "MLB-49502PO-69815");
  assertEquals(db.job.metadata.builder_work_order_value_ex_gst, 1080);
  assertEquals(
    db.job.metadata.builder_work_order_value_source,
    "builder_work_order_pdf_not_our_quote",
  );
  // The board stage and the job status are never moved.
  assertEquals(db.job.metadata.repair_stage, "scoping");
  assertEquals(db.job.status, "accepted");
  assertEquals(attached.length, 1);
  assertEquals(db.events.length, 1);
  assertEquals(db.events[0].event_type, REPAIR_WORK_ORDER_LANDED_EVENT);
  assertEquals(
    db.events[0].detail_json.notice,
    "new_work_order_on_existing_job",
  );

  // The same order again changes nothing and writes no second event.
  const second = await landWorkOrderOnRepairJob(db.client, LANDING, deps);
  assertEquals(second, { relation: "same", eventCreated: false });
  assertEquals(db.writes.length, 1);
  assertEquals(db.events.length, 1);
});

Deno.test("a second purchase order on the claim is listed, never written over the first", async () => {
  const db = landingClient({
    id: "job-1",
    job_number: "SWR-1",
    type: "repair",
    status: "accepted",
    metadata: {
      repair_stage: "materials",
      builder_claim_ref: "MLB-49502",
      builder_po_number: "PO-11111",
      builder_work_order_value_ex_gst: 500,
    },
  });
  const result = await landWorkOrderOnRepairJob(db.client, LANDING, {
    attachEvidence: () => Promise.resolve(),
  });
  assertEquals(result.relation, "different");
  assertEquals(db.job.metadata.builder_po_number, "PO-11111");
  assertEquals(db.job.metadata.builder_work_order_value_ex_gst, 500);
  assertEquals(db.job.metadata.builder_additional_work_orders.length, 1);
  assertEquals(
    db.job.metadata.builder_additional_work_orders[0].purchase_order,
    "PO-69815",
  );
  assertEquals(
    db.job.metadata.builder_additional_work_orders[0].value_ex_gst,
    1080,
  );
});

Deno.test("a job whose own purchase order sits only in its detail row keeps it: the new order is listed", async () => {
  const job = () => ({
    id: "job-1",
    job_number: "SWR-1",
    type: "repair",
    status: "accepted",
    metadata: { repair_stage: "materials", builder_claim_ref: "MLB-49502" },
  });
  const deps = { attachEvidence: () => Promise.resolve() };
  const db = landingClient(job());
  const landing = { ...LANDING, jobExternalRef: "MLB-49502PO-11111" };
  const result = await landWorkOrderOnRepairJob(db.client, landing, deps);
  // The landing counts the purchase order the match counted, so the new one
  // is never written into the job's own purchase order slot.
  assertEquals(result.relation, "different");
  assertEquals("builder_po_number" in db.job.metadata, false);
  assertEquals("builder_work_order_number" in db.job.metadata, false);
  assertEquals(
    db.job.metadata.builder_additional_work_orders.map((entry: any) =>
      entry.purchase_order
    ),
    ["PO-69815"],
  );
  assertEquals(db.events[0].detail_json.purchase_order_relation, "different");
  // Landing it again lists nothing twice.
  const again = await landWorkOrderOnRepairJob(db.client, landing, deps);
  assertEquals(again, { relation: "same", eventCreated: false });
  assertEquals(db.job.metadata.builder_additional_work_orders.length, 1);

  // The detail row holding this very order is a re-send: nothing is written.
  const resend = landingClient(job());
  assertEquals(
    (await landWorkOrderOnRepairJob(resend.client, {
      ...LANDING,
      jobExternalRef: "MLB-49502PO-69815",
    }, deps)).relation,
    "same",
  );
  assertEquals(resend.writes.length, 0);

  // CONTROL: a detail row holding the claim only leaves the slot empty, and
  // the order becomes the job's own.
  const empty = landingClient(job());
  assertEquals(
    (await landWorkOrderOnRepairJob(empty.client, LANDING, deps)).relation,
    "empty",
  );
  assertEquals(empty.job.metadata.builder_po_number, "PO-69815");
});

Deno.test("job metadata as a trade reads it carries no builder order value", () => {
  const metadata = {
    repair_stage: "scheduled",
    builder_claim_ref: "MLB-49502",
    builder_po_number: "PO-11111",
    builder_work_order_value_ex_gst: 1080,
    builder_work_order_value_source: "builder_work_order_pdf_not_our_quote",
    builder_additional_work_orders: [
      { purchase_order: "PO-69815", claim_ref: "MLB-49502", value_ex_gst: 500 },
      { purchase_order: "PO-70001", value_ex_gst: null },
    ],
  };
  const before = JSON.stringify(metadata);
  assertEquals(withoutBuilderOrderValue(metadata), {
    repair_stage: "scheduled",
    builder_claim_ref: "MLB-49502",
    builder_po_number: "PO-11111",
    builder_work_order_value_source: "builder_work_order_pdf_not_our_quote",
    builder_additional_work_orders: [
      { purchase_order: "PO-69815", claim_ref: "MLB-49502" },
      { purchase_order: "PO-70001" },
    ],
  } as any);
  // The stored metadata is not changed.
  assertEquals(JSON.stringify(metadata), before);
  // A value that was looked for and not read is stripped too.
  assertEquals(
    withoutBuilderOrderValue({
      builder_po_number: "PO-1",
      builder_work_order_value_ex_gst: null,
    }),
    { builder_po_number: "PO-1" } as any,
  );
  // Metadata carrying neither is returned as it is.
  const plain = { repair_stage: "wo_in", builder_po_number: "PO-1" };
  assertEquals(withoutBuilderOrderValue(plain), plain);
  assertEquals(withoutBuilderOrderValue(null), null);
  assertEquals(withoutBuilderOrderValue(undefined), undefined);
});

Deno.test("landing refuses a job that is not a repair job", async () => {
  const db = landingClient({
    id: "job-1",
    type: "makesafe",
    metadata: {},
  });
  await assertRejects(
    () =>
      landWorkOrderOnRepairJob(db.client, LANDING, {
        attachEvidence: () => Promise.resolve(),
      }),
    Error,
    "not a repair job",
  );
  assertEquals(db.writes.length, 0);
});

Deno.test("an orphan collection order opens a draft only as a first-issue purchase order", () => {
  const plan = ambrosePlan("make_safe");
  assert(orphanLifecycleOrderOpensReviewDraft(plan));
  assertEquals(
    orphanLifecycleOrderOpensReviewDraft({
      ...plan,
      identity: { ...plan.identity, builderPoCanonical: null },
    }),
    false,
  );
  // An amendment is not a first issue.
  assertEquals(
    orphanLifecycleOrderOpensReviewDraft({
      ...plan,
      story: plan.story.map((event) =>
        event.kind === "instruction"
          ? { ...event, kind: "revision" as const }
          : event
      ),
    }),
    false,
  );
});

Deno.test("the claim's open repair jobs are found without a purchase order, for the make-safe notice", () => {
  const jobs = openRepairJobsOnClaim(
    { ...ORDER, builderPoCanonical: null } as any,
    [
      repairRow({ jobId: "b" }),
      repairRow({ jobId: "a" }),
      repairRow({ jobId: "c", status: "cancelled" }),
      repairRow({ jobId: "d", type: "makesafe" }),
    ],
    PREFIXES,
  );
  assertEquals(jobs.map((job) => job.jobId), ["a", "b"]);
});

Deno.test("the make-safe notice is one event per instruction and changes nothing on the repair job", async () => {
  const db = landingClient({
    id: "job-1",
    type: "repair",
    status: "accepted",
    metadata: { repair_stage: "materials", builder_po_number: "PO-11111" },
  });
  const before = JSON.stringify(db.job);
  const note = {
    repairJobId: "job-1",
    makeSafeJobId: "job-makesafe",
    caseId: "case-1",
    instructionKey: "key/cycle:1",
    claimRef: "MLB-49502",
    purchaseOrder: "PO-69815",
    jobFamily: "general_makesafe",
    sourcePostIds: ["post-1"],
    receivedAt: "2026-07-20T01:00:00.000Z",
  };
  assertEquals(await noteMakeSafeRaisedOnRepairClaim(db.client, note), {
    eventCreated: true,
  });
  assertEquals(await noteMakeSafeRaisedOnRepairClaim(db.client, note), {
    eventCreated: false,
  });
  assertEquals(db.events.length, 1);
  assertEquals(db.events[0].event_type, MAKE_SAFE_RAISED_ON_REPAIR_CLAIM_EVENT);
  assertEquals(db.events[0].detail_json.make_safe_job_id, "job-makesafe");
  assertEquals(db.writes.length, 0);
  assertEquals(JSON.stringify(db.job), before);
});

// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
//
// Repair intake routing — the SES 'repair' family mints a TRUE repair job.
//
// Every test here is paired with a control that proves a NON-repair family
// still produces exactly what it produced before. The whole risk of this change
// is a silent behaviour shift on the five families nobody asked to change, so
// those controls are the point of the file, not decoration.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _approveIntakeDraftForTest,
  _createMakesafeJob,
  _makesafeJobRouteForFamily,
  _requestedMakesafeJobRoute,
  _unattendedIntakeApprovalMarkerForTest,
} from "./index.ts";

type Row = Record<string, any>;

type Store = {
  tables: Record<string, Row[]>;
  nextJobNumber: (jobType: string) => string;
  failDetailsInsert?: boolean;
};

const ORG_ID = "00000000-0000-0000-0000-000000000001";

function makeStore(input: Partial<Store> = {}): Store {
  return {
    tables: {
      jobs: [],
      makesafe_job_details: [],
      makesafe_companies: [],
      makesafe_attendance_cycles: [],
      makesafe_intake_cases: [],
      job_events: [],
      job_documents: [],
      ...(input.tables || {}),
    },
    nextJobNumber: input.nextJobNumber ?? ((jobType: string) =>
      jobType === "repair" ? "SWR-261400" : "SWMS-261400"),
    failDetailsInsert: input.failDetailsInsert,
  };
}

function makeClient(store: Store) {
  function builder(table: string) {
    let operation: "select" | "insert" | "update" | "delete" = "select";
    let insertValue: Row | Row[] | null = null;
    let updateValue: Row | null = null;
    const filters: Array<(row: Row) => boolean> = [];
    let executed: Promise<{ data: any; error: any }> | null = null;

    const matching = () =>
      (store.tables[table] || []).filter((row) =>
        filters.every((filter) => filter(row))
      );

    const execute = () => {
      if (executed) return executed;
      executed = Promise.resolve().then(() => {
        if (operation === "select") {
          return { data: matching().map((row) => ({ ...row })), error: null };
        }
        if (operation === "insert") {
          if (table === "makesafe_job_details" && store.failDetailsInsert) {
            return {
              data: null,
              error: {
                message:
                  "makesafe_job_details rows require jobs.type = makesafe or repair",
              },
            };
          }
          const values = Array.isArray(insertValue)
            ? insertValue
            : [insertValue || {}];
          const inserted = values.map((value, index) => {
            const row = { ...value };
            if (!row.id) {
              row.id = `${table}-${
                (store.tables[table] || []).length + index + 1
              }`;
            }
            store.tables[table] = store.tables[table] || [];
            store.tables[table].push(row);
            return { ...row };
          });
          return { data: inserted, error: null };
        }
        if (operation === "update") {
          const updated: Row[] = [];
          for (const row of matching()) {
            Object.assign(row, updateValue || {});
            updated.push({ ...row });
          }
          return { data: updated, error: null };
        }
        const removed = matching();
        store.tables[table] = (store.tables[table] || []).filter((row) =>
          !removed.includes(row)
        );
        return { data: removed, error: null };
      });
      return executed;
    };

    const chain: any = {
      select: () => chain,
      insert: (value: Row | Row[]) => {
        operation = "insert";
        insertValue = value;
        return chain;
      },
      update: (value: Row) => {
        operation = "update";
        updateValue = value;
        return chain;
      },
      delete: () => {
        operation = "delete";
        return chain;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return chain;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => row[column] == value);
        return chain;
      },
      ilike: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        const result = await execute();
        const rows = Array.isArray(result.data) ? result.data : [];
        return { data: rows[0] || null, error: result.error };
      },
      single: async () => {
        const result = await execute();
        const rows = Array.isArray(result.data) ? result.data : [];
        return { data: rows[0] || null, error: result.error };
      },
      then: (resolve: any, reject: any) => execute().then(resolve, reject),
      catch: (reject: any) => execute().catch(reject),
    };
    return chain;
  }

  return {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Row = {}) => {
      if (name === "next_job_number") {
        return { data: store.nextJobNumber(String(args.job_type || "")), error: null };
      }
      if (name === "bind_makesafe_roof_initial_cycle_v1") {
        // Only the roof_report control needs this; it mirrors the stub in
        // makesafe_roof_intake_cycle_binding_test.ts so the control exercises the
        // real roof path instead of its refusal.
        const detail = store.tables.makesafe_job_details.find((row) =>
          row.job_id === args.p_job_id
        );
        if (!detail) return { data: null, error: { message: "detail missing" } };
        const cycle = {
          id: `cycle-${args.p_job_id}-1`,
          job_id: args.p_job_id,
          cycle_number: 1,
          open_reason: args.p_open_reason,
        };
        store.tables.makesafe_attendance_cycles =
          store.tables.makesafe_attendance_cycles || [];
        store.tables.makesafe_attendance_cycles.push(cycle);
        detail.attendance_cycle_id = cycle.id;
        detail.cycle_attribution = "bound";
        return {
          data: {
            attendance_cycle_id: cycle.id,
            cycle_number: 1,
            cycle_created: true,
            cycle_bound: true,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
}

const MINT_ID = "00000000-0000-4000-8000-0000000009a1";

/** Multi-line source anchors must match on a CRLF checkout as well as LF. */
function normaliseLineEndings(source: string): string {
  return source.split("\r\n").join("\n");
}

function workOrderBody(family: string) {
  return {
    client_name: "Storm Damage Client",
    site_address: "12 Example Street",
    suburb: "Midland",
    phone: "0400000000",
    external_ref: "WO-REPAIR-0001",
    description: "Rectify storm-damaged eaves and gutter run.",
    makesafe_job_family: family,
    makesafe_job_family_label: family,
    builder_work_order_number: "WO-REPAIR-0001",
    builder_po_number: "PO-REPAIR-0001",
    builder_claim_ref: "CLAIM-0001",
    builder_email_subject: "Allocation Work Order",
    intake_mint_id: MINT_ID,
    suppress_manager_notification: true,
  };
}

Deno.test("a repair work order mints a true SWR- repair job that opens in WO In", async () => {
  const store = makeStore();
  const client = makeClient(store);

  const result: any = await _createMakesafeJob(
    client,
    workOrderBody("repair"),
    { jobRoute: "repair", suppressGeocoding: true },
  );

  assertEquals(result.ok, true);
  assertEquals(store.tables.jobs.length, 1);
  const job = store.tables.jobs[0];

  assertEquals(job.type, "repair");
  assertEquals(job.status, "accepted");
  assertEquals(job.job_number, "SWR-261400");
  assertEquals(job.org_id, ORG_ID);

  // The Repairs board entry column. Without this stamp status='accepted' maps to
  // the APPROVED column and a brand new work order opens three columns in.
  assertEquals(job.metadata.repair_stage, "wo_in");
  // Belt and braces board authority: jobs.type alone is enough, but the
  // additive markers keep the card identifiable if the type is ever migrated.
  assertEquals(job.metadata.makesafe_job_family, "repair");
  assertEquals(job.metadata.ses_family, "repair");

  // The retry-recovery precondition. recoverIntakeMintJob finds an orphaned job
  // by .contains('metadata', { intake_mint_id }); dropping it would silently
  // break idempotent re-approval and mint a duplicate card.
  assertEquals(job.metadata.intake_mint_id, MINT_ID);

  // Duplicate-guard inputs must survive the route change: the fuzzy guard reads
  // these two keys straight off jobs.metadata.
  assertEquals(job.metadata.builder_work_order_number, "WO-REPAIR-0001");
  assertEquals(job.metadata.builder_po_number, "PO-REPAIR-0001");

  // The SES overlay row is what keeps a repair card inside the MakeSafe board
  // population (and therefore inside every evidence/pack/report reader).
  assertEquals(store.tables.makesafe_job_details.length, 1);
  assertEquals(store.tables.makesafe_job_details[0].job_id, job.id);
  assertEquals(store.tables.makesafe_job_details[0].external_ref, "WO-REPAIR-0001");
  assertEquals(
    store.tables.makesafe_job_details[0].substatus,
    "company_contact_required",
  );
  assertEquals("makesafe_details_error" in result, false);

  // Audit parity: the event TYPE is unchanged so every existing reader still
  // sees the mint; the route is recorded inside the detail.
  const created = store.tables.job_events.find((row) =>
    row.event_type === "makesafe_created"
  );
  assert(created, "a repair mint must still write the makesafe_created event");
  assertEquals(created.detail_json.job_route, "repair");
  assertEquals(created.detail_json.repair_stage, "wo_in");
  assertEquals(created.detail_json.job_number, "SWR-261400");
});

Deno.test("repair numbering fails closed when the repair migration is not applied", async () => {
  // Without 20260826000001, next_job_number('repair') falls to the ELSE arm and
  // returns SW-26xxx. Minting that would either collide with nothing meaningful
  // or mask the missing migration behind a job the CHECK constraint refuses two
  // statements later. Refuse first, and say which migration is missing.
  const store = makeStore({ nextJobNumber: () => "SW-261400" });
  const client = makeClient(store);

  const error = await assertRejects(
    () =>
      _createMakesafeJob(client, workOrderBody("repair"), {
        jobRoute: "repair",
        suppressGeocoding: true,
      }),
    Error,
  );
  assertStringIncludes(String(error.message), "SWR-");
  assertStringIncludes(String(error.message), "migration is not applied");
  assertEquals(store.tables.jobs.length, 0);
});

Deno.test("a repair job that loses its SES overlay row says so instead of going quiet", async () => {
  // Diagnosis blocker B5. On the make-safe route this failure is a console.log
  // and nothing else. A detail-less repair job leaves the MakeSafe board
  // population entirely and becomes invisible to the duplicate guard, so the
  // repair route must hand the caller a machine-readable fact.
  const store = makeStore({ failDetailsInsert: true });
  const client = makeClient(store);

  const result: any = await _createMakesafeJob(
    client,
    workOrderBody("repair"),
    { jobRoute: "repair", suppressGeocoding: true },
  );

  assertEquals(result.ok, true);
  assertEquals(store.tables.jobs.length, 1);
  assertEquals(store.tables.makesafe_job_details.length, 0);
  assertStringIncludes(
    String(result.makesafe_details_error),
    "makesafe_job_details",
  );
});

Deno.test("CONTROL: the make-safe route swallows an overlay failure exactly as before", async () => {
  const store = makeStore({ failDetailsInsert: true });
  const client = makeClient(store);

  const result: any = await _createMakesafeJob(
    client,
    workOrderBody("general_makesafe"),
    { suppressGeocoding: true },
  );

  // Same return shape as a clean make-safe creation: { ok, job } and nothing else.
  assertEquals(Object.keys(result).sort(), ["job", "ok"]);
  assertEquals(store.tables.jobs[0].type, "makesafe");
});

Deno.test("CONTROL: every non-repair family still mints an unchanged SWMS- make-safe", async () => {
  // The five families this slice must not touch. Each is driven through the
  // creator with NO route option — precisely what approveIntakeDraft does for
  // them — and asserted field by field against the pre-change shape.
  for (
    const family of [
      "general_makesafe",
      "temp_fence_makesafe",
      "roof_report",
      "assessment_report_quote",
      "restoration",
    ]
  ) {
    const store = makeStore();
    const client = makeClient(store);

    // roof_report additionally requires canonical intake authority; supply it so
    // the control exercises the real path rather than the refusal.
    const internalOptions: any = { suppressGeocoding: true };
    if (family === "roof_report") {
      store.tables.makesafe_intake_cases = [{
        id: "case-roof-1",
        org_id: ORG_ID,
        job_id: null,
        target_job_id: null,
        instruction_key: "builder:generic/po:roof-one",
        builder_wo_canonical: "WO-REPAIR-0001",
        builder_po_canonical: "PO-REPAIR-0001",
        external_ref_canonical: "WO-REPAIR-0001",
      }];
      internalOptions.canonicalIntakeAuthority = {
        case_id: "case-roof-1",
        mint_id: MINT_ID,
      };
    }

    const result: any = await _createMakesafeJob(
      client,
      workOrderBody(family),
      internalOptions,
    );

    const job = store.tables.jobs[0];
    assertEquals(job.type, "makesafe", `${family} must stay a make-safe`);
    assertEquals(
      job.job_number,
      "SWMS-261400",
      `${family} must keep its SWMS- number`,
    );
    assertEquals(
      job.metadata.makesafe_job_family,
      family,
      `${family} must keep its family stamp`,
    );
    // The two keys the repair route adds must be entirely absent elsewhere.
    assertEquals(
      "repair_stage" in job.metadata,
      false,
      `${family} must not gain a repair_stage`,
    );
    assertEquals(
      "ses_family" in job.metadata,
      false,
      `${family} must not gain an ses_family`,
    );
    assertEquals("makesafe_details_error" in result, false);

    const created = store.tables.job_events.find((row) =>
      row.event_type === "makesafe_created"
    );
    assert(created, `${family} must still write makesafe_created`);
    assertEquals(
      "job_route" in created.detail_json,
      false,
      `${family} must not gain a job_route marker`,
    );
  }
});

Deno.test("CONTROL: an explicit make-safe route is identical to no route at all", async () => {
  const withoutOption = makeStore();
  const withOption = makeStore();
  await _createMakesafeJob(
    makeClient(withoutOption),
    workOrderBody("general_makesafe"),
    { suppressGeocoding: true },
  );
  await _createMakesafeJob(
    makeClient(withOption),
    workOrderBody("general_makesafe"),
    { suppressGeocoding: true, jobRoute: "makesafe" },
  );
  assertEquals(withOption.tables.jobs[0], withoutOption.tables.jobs[0]);
  assertEquals(
    withOption.tables.makesafe_job_details[0],
    withoutOption.tables.makesafe_job_details[0],
  );
});

Deno.test("the approval seam routes to repair on the family and on nothing else", () => {
  // EXECUTED, not grepped. The whole business outcome rests on this decision, so
  // it lives in its own pure function and is driven with every value the
  // classifier can produce rather than asserted as a string in the source.
  assertEquals(_makesafeJobRouteForFamily("repair"), "repair");

  for (
    const family of [
      "general_makesafe",
      "temp_fence_makesafe",
      "roof_report",
      "assessment_report_quote",
      "restoration",
      null,
      undefined,
      "",
    ]
  ) {
    assertEquals(
      _makesafeJobRouteForFamily(family),
      "makesafe",
      `${family} must keep the make-safe route`,
    );
  }

  // Near-misses take the SAFE route rather than minting a repair on a typo.
  for (const near of ["repairs", "Repair Quote", "rapid_repair", "repair_quote_stage"]) {
    assertEquals(
      _makesafeJobRouteForFamily(near),
      "makesafe",
      `'${near}' is not the repair family and must not mint a repair job`,
    );
  }

  // Case and whitespace are the classifier's business, not ours.
  assertEquals(_makesafeJobRouteForFamily("  REPAIR "), "repair");
});

Deno.test("the approval seam has exactly one route decision, and it is that function", async () => {
  // Belt to the executed test above: prove the seam actually calls it, and that
  // no second site quietly selects the repair route on its own.
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

  assertStringIncludes(
    source,
    "jobRoute: _makesafeJobRouteForFamily(approvedJobFamily),",
    "the approval seam must take its route from the tested decision function",
  );
  assertEquals(
    (source.match(/jobRoute:\s*'repair'/g) || []).length,
    0,
    "no site may hard-code the repair route; the decision belongs to one function",
  );
});

Deno.test("a quote-stage repair parks as an exception and never reaches a creator", async () => {
  // The fate ladder is upstream of everything this branch touches and is byte
  // unchanged by it. The assertion is scoped to the repair arm itself — an
  // earlier version asserted `state = "exception"` on its own, which every
  // exception fate in that file satisfies and which therefore proved nothing.
  // Normalised so the multi-line anchors below match on a CRLF checkout too.
  const intakeSource = normaliseLineEndings(
    await Deno.readTextFile(
      new URL("./makesafe_deterministic_intake.ts", import.meta.url),
    ),
  );
  assertStringIncludes(
    intakeSource,
    [
      "} else if (quoteStageRequest) {",
      '        state = "exception";',
      '        reasonCode = "repair_quote_stage";',
    ].join("\n"),
    "the quote-stage arm must set the exception state and its own reason code together",
  );

  // And an exception state cannot mint: the runtime creates a job for exactly
  // two live states, neither of which is `exception`.
  const runtimeSource = normaliseLineEndings(
    await Deno.readTextFile(
      new URL("./makesafe_deterministic_intake_runtime.ts", import.meta.url),
    ),
  );
  assertStringIncludes(
    runtimeSource,
    [
      "const wantsJob = !jobId && !lifecycleReopen &&",
      '        (effectivePlan.state === "confirmed_live_job" ||',
      '          effectivePlan.state === "blocked_live_job");',
    ].join("\n"),
    "only confirmed/blocked live-job states may mint, so an exception mints nothing",
  );
});

Deno.test("an operator can raise a repair job by hand, and a typo cannot", () => {
  // Without this the intake-draft approval seam was the ONLY way a true repair
  // job could exist. The classifier abstains on generic repair prose, work orders
  // arrive by routes that produce no draft, and repairs sometimes simply have to
  // be raised — so the operator's only option was to create a make-safe and
  // reclassify it, permanently manufacturing the second class of repair card
  // (type='makesafe' + SWMS- number + repair board stage) that this pipeline
  // exists to stop creating.
  assertEquals(_requestedMakesafeJobRoute({ job_route: "repair" }), "repair");
  assertEquals(_requestedMakesafeJobRoute({ job_type: "repair" }), "repair");
  assertEquals(_requestedMakesafeJobRoute({ job_route: " REPAIR " }), "repair");
  assertEquals(_requestedMakesafeJobRoute({ job_route: "makesafe" }), "makesafe");

  // CONTROL: no parameter is today's behaviour, exactly.
  assertEquals(_requestedMakesafeJobRoute({}), "makesafe");
  assertEquals(_requestedMakesafeJobRoute({ job_route: "" }), "makesafe");
  assertEquals(_requestedMakesafeJobRoute(null), "makesafe");
  assertEquals(_requestedMakesafeJobRoute({ client_name: "Someone" }), "makesafe");

  // A typo is REFUSED, not quietly defaulted: minting a make-safe here would
  // look to the operator exactly like the repair they asked for.
  for (const typo of ["repairs", "Repair Job", "swr", "insurance"]) {
    assertThrows(
      () => _requestedMakesafeJobRoute({ job_route: typo }),
      Error,
      "unknown job_route",
    );
  }
});

Deno.test("create_makesafe_job takes its route from the caller, and the routine cannot", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertStringIncludes(
    source,
    "jobRoute: _requestedMakesafeJobRoute(body),",
    "the manual creation action must honour an explicit route",
  );
  // The routine key still cannot reach the live creator at all — it is diverted
  // to a needs_review draft before any route is considered.
  assertStringIncludes(source, "if (authMode === 'routine') {");
});

Deno.test("a hand-raised repair is a repair in its metadata too, not just its type", async () => {
  // A manual caller supplies free text, and the family classifier abstains on
  // generic repair prose or reads it as general_makesafe. A card that is
  // type='repair' while its metadata says general_makesafe has two board-authority
  // markers disagreeing with each other, so the ROUTE settles the family.
  const store = makeStore();
  const client = makeClient(store);

  const body: any = workOrderBody("repair");
  delete body.makesafe_job_family;
  delete body.makesafe_job_family_label;

  await _createMakesafeJob(client, body, {
    jobRoute: "repair",
    suppressGeocoding: true,
  });

  const job = store.tables.jobs[0];
  assertEquals(job.type, "repair");
  assertEquals(job.job_number, "SWR-261400");
  assertEquals(job.metadata.makesafe_job_family, "repair");
  assertEquals(job.metadata.ses_family, "repair");
  assertEquals(job.metadata.repair_stage, "wo_in");

  // CONTROL: the very same body with no route is still classified the old way.
  const controlStore = makeStore();
  await _createMakesafeJob(makeClient(controlStore), body, {
    suppressGeocoding: true,
  });
  assertEquals(controlStore.tables.jobs[0].type, "makesafe");
  assertEquals(controlStore.tables.jobs[0].job_number, "SWMS-261400");
  assertEquals("repair_stage" in controlStore.tables.jobs[0].metadata, false);
});

// ── The final-family brake: no unattended lane may mint a repair card ────────
//
// Ruled 2026-08-28: every SWR- mint is a human tick. The upstream sweep brake
// reads `resolvedIntakeDraftFamily` (subject + preview + stored family), while
// approval derives its own family from the full instruction text and then
// applies the 2026-08-31 identified-work-order complement — so a legacy-vintage
// draft can pass the sweep as one family and resolve to `repair` only at the
// moment of minting. Judging the family that will ACTUALLY be created is the
// only check that cannot be outflanked upstream.

const LEGACY_REPAIR_SCOPE =
  "Repaint the hallway ceiling and patch minor plaster cracking.";

const LEGACY_REPAIR_WO_TEXT = `Work Order Number
MLB-27150PO-61000
Policyholders Name
Neutral Client
Mobile: 0422 000 111
Site Address
30 Neutral Street, Perth, WA 6000
Scope of Works
Repaint the hallway ceiling and patch minor plaster cracking.
Totals
Subtotal $1,000.00`;

function legacyRepairDraftRow(): Row {
  return {
    id: "draft-legacy-repair",
    org_id: ORG_ID,
    status: "needs_review",
    // Legacy vintage: NOT deterministic_intake, and no stored family — so
    // `deterministicDraftFamilyForApproval` yields null and approval takes the
    // fallback classifier plus the complement.
    graph_message_id: "legacy-graph-message-1",
    subject: "MLB-27150",
    body_preview: LEGACY_REPAIR_SCOPE,
    requesting_company_slug: "mlb",
    requesting_company_name: "MLB",
    external_ref: "MLB-27150",
    client_name: "Neutral Client",
    client_phone: "0422 000 111",
    client_email: null,
    site_address: "30 Neutral Street, Perth",
    site_suburb: "Perth",
    description: LEGACY_REPAIR_SCOPE,
    report_type: null,
    confidence: "high",
    missing_fields: [],
    approved_job_id: null,
    attachments_json: [{
      id: "legacy-repair-attachment",
      file_name: "MLB Work Order.pdf",
      is_work_order: true,
      storage_url: "storage/legacy-repair-wo.pdf",
      pdf_url: "storage/legacy-repair-wo.pdf",
    }],
    extraction_json: {
      builder_claim_ref: "MLB-27150",
      builder_po_number: "PO-61000",
      builder_email_text_for_trade: LEGACY_REPAIR_SCOPE,
      work_order_pdf_text: [{
        attachment_id: "legacy-repair-attachment",
        attachment_name: "MLB Work Order.pdf",
        status: "extracted",
        text: LEGACY_REPAIR_WO_TEXT,
      }],
    },
  };
}

function approvalClient(draft: Row) {
  const drafts = [draft];
  const rpcCalls: string[] = [];
  return {
    drafts,
    rpcCalls,
    client: {
      rpc(name: string) {
        rpcCalls.push(name);
        return Promise.resolve({ data: null, error: null });
      },
      from(table: string) {
        if (table === "makesafe_intake_drafts") {
          const query: any = {
            select: () => query,
            eq: () => query,
            in: () => query,
            update: (payload: Row) => {
              Object.assign(drafts[0], payload);
              return query;
            },
            single: () => Promise.resolve({ data: drafts[0], error: null }),
            maybeSingle: () =>
              Promise.resolve({ data: drafts[0], error: null }),
            then: (resolve: (value: any) => unknown) =>
              resolve({ data: drafts, error: null }),
          };
          return query;
        }
        if (table === "makesafe_intake_job_mints") {
          const query: any = {
            select: () => query,
            eq: () => query,
            order: () => Promise.resolve({ data: [], error: null }),
          };
          return query;
        }
        const empty: any = {
          select: () => empty,
          eq: () => empty,
          in: () => empty,
          is: () => empty,
          not: () => empty,
          ilike: () => empty,
          or: () => empty,
          gte: () => empty,
          lte: () => empty,
          contains: () => empty,
          neq: () => empty,
          order: () => empty,
          limit: () => empty,
          range: () => Promise.resolve({ data: [], error: null }),
          single: () => Promise.resolve({ data: null, error: null }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          then: (resolve: (value: any) => unknown) =>
            resolve({ data: [], error: null }),
        };
        return empty;
      },
    },
  };
}

Deno.test("an unattended lane may not mint a card that resolves to repair only at approval", async () => {
  const db = approvalClient(legacyRepairDraftRow());

  const error = await assertRejects(
    () =>
      _approveIntakeDraftForTest(db.client, {
        ..._unattendedIntakeApprovalMarkerForTest,
        draft_id: "draft-legacy-repair",
        approved_by: "auto-intake",
      }),
    Error,
    "Repair intake requires a human tick",
  );
  assertEquals((error as any).status, 409);
  // Nothing written: the draft is still reviewable for an operator.
  assertEquals(db.drafts[0].status, "needs_review");
  assertEquals(db.drafts[0].approved_job_id, null);
});

Deno.test("CONTROL: the same draft approved by an identified operator passes the brake", async () => {
  const db = approvalClient(legacyRepairDraftRow());

  // Identical client and draft; the ONLY difference is the absent unattended
  // marker. The operator path must get past the supervision brake — it stops
  // later, at a different gate, on this deliberately thin fixture.
  const error = await assertRejects(
    () =>
      _approveIntakeDraftForTest(db.client, {
        draft_id: "draft-legacy-repair",
        approved_by: "captain@secureworkswa.com.au",
      }),
    Error,
  );
  assert(
    !String((error as Error).message).includes(
      "Repair intake requires a human tick",
    ),
    `operator approval must not hit the unattended brake, got: ${
      (error as Error).message
    }`,
  );
});

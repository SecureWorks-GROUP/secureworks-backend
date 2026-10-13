// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createQuoteBuilderPrivateJob,
  decideQuoteBuilderVariation,
  getQuoteBuilderJob,
  issueQuoteBuilderVersion,
  listQuoteBuilderJobs,
  loadQuoteBuilderSettings,
  makeQuoteBuilderPurchaseOrders,
  makeQuoteBuilderWorkOrder,
  normaliseChargeLines,
  normaliseCostLines,
  QUOTE_BUILDER_ACTIONS,
  QuoteBuilderError,
  quoteBuilderMayWriteJobValue,
  quoteBuilderPdfUploadUrl,
  quoteBuilderPhotoRegister,
  quoteBuilderPhotoUploadUrl,
  quoteBuilderPurchaseOrderGroups,
  quoteBuilderQuoteNumber,
  quoteBuilderTotals,
  quoteBuilderWorkOrderItems,
  repairStageMoveDecision,
  saveQuoteBuilderVersion,
  writeQuoteBuilderJobValue,
} from "./quote_builder.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  _pushPOToXero,
  _updateJobStatus,
  AGENT_READ_ALLOWED_ACTIONS,
  ApiError,
  dispatchQuoteBuilderAction,
  redactTradeWorkOrdersForAllocated,
} from "./index.ts";

type Row = Record<string, any>;
type Store = Record<string, Row[]>;

const ORG = "00000000-0000-0000-0000-000000000001";
const REPAIR_JOB = "11111111-1111-4111-8111-111111111111";
const LATE_REPAIR_JOB = "22222222-2222-4222-8222-222222222222";
const MAKESAFE_JOB = "33333333-3333-4333-8333-333333333333";
const PHOTO_ON_JOB = "44444444-4444-4444-8444-444444444444";
const PHOTO_ELSEWHERE = "55555555-5555-4555-8555-555555555555";
const TRADE_PHOTO_ON_JOB = "77777777-7777-4777-8777-777777777777";
const ACTOR = {
  id: "66666666-6666-4666-8666-666666666666",
  email: "hugo@example.invalid",
  orgId: ORG,
};

let clock = Date.parse("2026-10-09T00:00:00Z");
function tick() {
  clock += 1000;
  return new Date(clock).toISOString();
}

function pathValue(row: Row, key: string): any {
  if (!key.includes("->")) return row[key];
  const parts = key.split(/->>?/);
  let value: any = row[parts[0]];
  for (const part of parts.slice(1)) value = value?.[part];
  return value;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// ux_job_docs_live_unsent_quote (20260701000001),
// ux_jobs_quote_builder_request_id (20261009120000) and the three indexes of
// 20261013160000: one extra document per version and kind, one live work order
// per version, one live purchase order per version and supplier.
function uniqueKey(table: string, r: Row): string | null {
  if (table === "work_orders") {
    return r.quote_builder_version_id && r.status !== "cancelled"
      ? r.quote_builder_version_id
      : null;
  }
  if (table === "purchase_orders") {
    return r.quote_builder_version_id &&
        !["cancelled", "deleted"].includes(r.status)
      ? [
        r.quote_builder_version_id,
        String(r.supplier_name ?? "").toLowerCase(),
      ].join("|")
      : null;
  }
  if (table === "job_documents" && r.type === "other") {
    return r.metadata?.quote_builder_document
      ? [
        "extra",
        r.job_id,
        r.metadata.quote_builder_version_id,
        r.metadata.quote_builder_document,
      ].join("|")
      : null;
  }
  if (table === "job_documents") {
    const live = r.type === "quote" && r.sent_to_client !== true &&
      r.superseded_at == null && r.accepted_at == null &&
      r.declined_at == null;
    return live
      ? [r.job_id, r.job_contact_id ?? ZERO_UUID, r.run_label ?? ""].join("|")
      : null;
  }
  if (table === "jobs") {
    const requestId = r.metadata?.quote_builder?.request_id;
    return r.type === "miscellaneous" && requestId != null ? requestId : null;
  }
  return null;
}

function makeFakeClient(
  store: Store,
  hooks: {
    afterInsert?: (table: string, rows: Row[]) => void;
    updateError?: (table: string, payload: Row) => Row | null;
  } = {},
) {
  const uploads = new Set<string>();
  function from(table: string) {
    store[table] = store[table] || [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    const preds: Array<(r: Row) => boolean> = [];
    let orderKey: string | null = null;
    let asc = true;
    let limitN: number | null = null;

    function exec(): { data: any; error: any } {
      if (mode === "insert") {
        const rows: Row[] = (Array.isArray(payload) ? payload : [payload]).map((
          r: Row,
        ) => ({
          id: r.id ?? crypto.randomUUID(),
          created_at: tick(),
          updated_at: tick(),
          ...r,
        }));
        for (const r of rows) {
          const clash = table === "quote_builder_versions"
            ? store[table].some((o) =>
              o.job_id === r.job_id && o.chain_id === r.chain_id &&
              o.version === r.version
            )
            : uniqueKey(table, r) !== null &&
              store[table].some((o) =>
                uniqueKey(table, o) === uniqueKey(table, r)
              );
          if (clash) {
            return {
              data: null,
              error: { code: "23505", message: "duplicate" },
            };
          }
        }
        store[table].push(...rows);
        hooks.afterInsert?.(table, rows);
        return { data: rows.map((r: Row) => ({ ...r })), error: null };
      }
      const matched = store[table].filter((r) => preds.every((p) => p(r)));
      if (mode === "delete") {
        store[table] = store[table].filter((r) => !matched.includes(r));
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      if (mode === "update") {
        const refused = hooks.updateError?.(table, payload);
        if (refused) return { data: null, error: refused };
        for (const r of matched) {
          if (table === "quote_builder_versions" && r.status === "issued") {
            return {
              data: null,
              error: { code: "23514", message: "issued version is frozen" },
            };
          }
        }
        for (const r of matched) {
          Object.assign(r, payload);
          if (table === "quote_builder_versions" || table === "jobs") {
            r.updated_at = tick();
          }
        }
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      let rows = matched.slice();
      if (orderKey) {
        const k = orderKey;
        rows.sort((
          a,
          b,
        ) => (a[k] < b[k] ? (asc ? -1 : 1) : a[k] > b[k] ? (asc ? 1 : -1) : 0));
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows.map((r) => ({ ...r })), error: null };
    }

    const b: any = {
      select: () => b,
      insert: (r: any) => {
        mode = "insert";
        payload = r;
        return b;
      },
      update: (r: any) => {
        mode = "update";
        payload = r;
        return b;
      },
      delete: () => {
        mode = "delete";
        return b;
      },
      eq: (k: string, v: any) => {
        preds.push((r) => pathValue(r, k) === v);
        return b;
      },
      neq: (k: string, v: any) => {
        preds.push((r) => pathValue(r, k) != null && pathValue(r, k) !== v);
        return b;
      },
      in: (k: string, vs: any[]) => {
        preds.push((r) => vs.includes(r[k]));
        return b;
      },
      is: (k: string, v: any) => {
        preds.push((r) => v === null ? r[k] == null : r[k] === v);
        return b;
      },
      not: (k: string, _op: string, v: any) => {
        preds.push((r) => v === null ? r[k] != null : r[k] !== v);
        return b;
      },
      order: (k: string, opts?: { ascending?: boolean }) => {
        orderKey = k;
        asc = opts?.ascending !== false;
        return b;
      },
      limit: (n: number) => {
        limitN = n;
        return b;
      },
      maybeSingle: () => {
        const { data, error } = exec();
        return Promise.resolve({
          data: error ? null : (data[0] ?? null),
          error,
        });
      },
      single: () => {
        const { data, error } = exec();
        if (error) return Promise.resolve({ data: null, error });
        if (data.length !== 1) {
          return Promise.resolve({
            data: null,
            error: { message: "not one row" },
          });
        }
        return Promise.resolve({ data: data[0], error: null });
      },
      then: (res: any, rej: any) => Promise.resolve(exec()).then(res, rej),
    };
    return b;
  }
  const storage = {
    from: (bucket: string) => ({
      createSignedUploadUrl: (path: string) =>
        Promise.resolve({
          data: {
            signedUrl: `https://upload.invalid/${bucket}/${path}`,
            token: "t",
          },
          error: null,
        }),
      getPublicUrl: (path: string) => ({
        data: { publicUrl: `https://cdn.invalid/${bucket}/${path}` },
      }),
      list: (dir: string, opts: { search: string }) =>
        Promise.resolve({
          data: uploads.has(`${bucket}/${dir}/${opts.search}`)
            ? [{ name: opts.search }]
            : [],
          error: null,
        }),
    }),
  };
  return {
    client: { from, storage },
    upload: (bucket: string, path: string) => uploads.add(`${bucket}/${path}`),
  };
}

function seed(): Store {
  return {
    jobs: [
      {
        id: REPAIR_JOB,
        org_id: ORG,
        job_number: "SWR-26101",
        type: "repair",
        status: "processing",
        client_name: "J Smith",
        metadata: { repair_stage: "scoping", builder_po_number: "PO-1" },
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
      },
      {
        id: LATE_REPAIR_JOB,
        org_id: ORG,
        job_number: "SWR-26102",
        type: "repair",
        status: "processing",
        client_name: "K Lee",
        metadata: { repair_stage: "scheduled" },
        created_at: "2026-10-02T00:00:00Z",
        updated_at: "2026-10-02T00:00:00Z",
      },
      {
        id: MAKESAFE_JOB,
        org_id: ORG,
        job_number: "SWMS-26100",
        type: "makesafe",
        status: "accepted",
        metadata: {},
        created_at: "2026-10-03T00:00:00Z",
        updated_at: "2026-10-03T00:00:00Z",
      },
    ],
    makesafe_job_details: [],
    job_media: [
      {
        id: PHOTO_ON_JOB,
        job_id: REPAIR_JOB,
        phase: "quote_builder",
        type: "photo",
        storage_url: "https://cdn.invalid/a.jpg",
      },
      {
        id: PHOTO_ELSEWHERE,
        job_id: LATE_REPAIR_JOB,
        phase: "quote_builder",
        type: "photo",
        storage_url: "https://cdn.invalid/b.jpg",
      },
      {
        id: TRADE_PHOTO_ON_JOB,
        job_id: REPAIR_JOB,
        phase: "scope",
        type: "photo",
        storage_url: "https://cdn.invalid/trade.jpg",
      },
    ],
    quote_builder_versions: [],
    job_documents: [],
    job_variations: [],
    job_events: [],
  };
}

function stageMover(store: Store, calls: any[]) {
  return (
    { jobId, stage }: {
      jobId: string;
      stage: string;
      operatorEmail: string | null;
    },
  ) => {
    calls.push({ jobId, stage });
    const job = store.jobs.find((j) => j.id === jobId)!;
    job.metadata = { ...job.metadata, repair_stage: stage };
    return Promise.resolve({ success: true });
  };
}

const COST = [{
  line_id: "c-1",
  description: "Fascia board",
  qty: 12.5,
  unit: "m",
  unit_cost_ex_gst: 18,
  supplier_or_trade: "Bunnings",
}];
const CHARGE = [{
  line_id: "q-1",
  description: "Replace fascia",
  qty: 1,
  unit: "item",
  unit_price_ex_gst: 650,
}];

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof QuoteBuilderError) return e.code;
    throw e;
  }
  return "no_error";
}

Deno.test("quote builder: line maths are recomputed server-side, GST 10%, margin over charge", () => {
  const cost = normaliseCostLines([{ ...COST[0], line_total_ex_gst: 1 }]);
  const charge = normaliseChargeLines([...CHARGE, {
    description: "Disposal",
    qty: 1,
    unit_price_ex_gst: 100,
    gst_applies: false,
  }]);
  assertEquals(cost[0].line_total_ex_gst, 225);
  assertEquals(charge[0].gst_ex, 65);
  assertEquals(charge[0].line_total_inc_gst, 715);
  assertEquals(charge[1].gst_ex, 0);
  assert(charge[1].line_id.startsWith("q-"));
  assertEquals(quoteBuilderTotals(cost, charge), {
    cost_total_ex_gst: 225,
    charge_total_ex_gst: 750,
    charge_gst: 65,
    charge_total_inc_gst: 815,
    margin_ex_gst: 525,
    margin_pct: 70,
  });
  assertEquals(quoteBuilderTotals([], []).margin_pct, null);
});

Deno.test("quote builder: bad lines are refused, never repaired", async () => {
  assertEquals(
    await code(
      Promise.resolve().then(() =>
        normaliseCostLines([{ description: "", qty: 1 }])
      ),
    ),
    "invalid_line",
  );
  assertEquals(
    await code(
      Promise.resolve().then(() =>
        normaliseChargeLines([{ description: "x", unit_price_ex_gst: -5 }])
      ),
    ),
    "invalid_line",
  );
  assertEquals(
    await code(
      Promise.resolve().then(() =>
        normaliseChargeLines([{ description: "x", qty: "abc" }])
      ),
    ),
    "invalid_line",
  );
  assertEquals(
    await code(
      Promise.resolve().then(() =>
        normaliseCostLines([{ line_id: "a", description: "x" }, {
          line_id: "a",
          description: "y",
        }])
      ),
    ),
    "invalid_line",
  );
});

Deno.test("quote builder: quote numbers and forward-only stage moves", () => {
  assertEquals(
    quoteBuilderQuoteNumber("SWR-26101", "scope", 2),
    "SWR-26101-Q2",
  );
  assertEquals(
    quoteBuilderQuoteNumber("SWR-26101", "variation", 3, 1),
    "SWR-26101-V1.3",
  );
  assertEquals(repairStageMoveDecision("scoping", "quoted").move, true);
  assertEquals(repairStageMoveDecision("wo_in", "quoted").move, true);
  assertEquals(repairStageMoveDecision("quoted", "quoted"), {
    move: false,
    reason: "already_past_stage",
  });
  assertEquals(repairStageMoveDecision("scheduled", "variation"), {
    move: false,
    reason: "already_past_stage",
  });
  assertEquals(repairStageMoveDecision("variation", "approved").move, true);
});

Deno.test("quote builder: save drafts in place, refuses a stale base, versions after issue", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const v1 = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    base_version_id: null,
    title: "Storm repairs",
    cost_lines: COST,
    charge_lines: CHARGE,
    photo_media_ids: [PHOTO_ON_JOB],
  }, ACTOR)).version;
  assertEquals(v1.version, 1);
  assertEquals(v1.chain_id, REPAIR_JOB);
  assertEquals(v1.charge_total_inc_gst, 715);
  assertEquals(v1.client_snapshot.builder_purchase_order, "PO-1");

  const again = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    base_version_id: v1.id,
    cost_lines: COST,
    charge_lines: [],
  }, ACTOR)).version;
  assertEquals(again.id, v1.id);
  assertEquals(store.quote_builder_versions.length, 1);

  assertEquals(
    await code(
      saveQuoteBuilderVersion(client, {
        job_id: REPAIR_JOB,
        kind: "scope",
        base_version_id: null,
      }, ACTOR),
    ),
    "stale_version",
  );
  assertEquals(store.quote_builder_versions.length, 1);

  // Issue v1, then the next save is version 2 on the same chain.
  await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    base_version_id: v1.id,
    charge_lines: CHARGE,
  }, ACTOR);
  const slot = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: v1.id },
    ACTOR,
  );
  upload("job-pdfs", slot.path);
  await issueQuoteBuilderVersion(
    client,
    { version_id: v1.id, pdf_path: slot.path },
    ACTOR,
    {
      moveRepairStage: stageMover(store, []),
    },
  );
  const v2 = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    base_version_id: v1.id,
    charge_lines: CHARGE,
  }, ACTOR)).version;
  assertEquals(v2.version, 2);
  assertEquals(
    store.quote_builder_versions.find((v) => v.id === v1.id)!.status,
    "issued",
  );
});

Deno.test("quote builder: a newer scope version and a variation each issue beside the job's own quote draft", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const moveRepairStage = stageMover(store, []);
  // The job-wide live unsent draft ghl-proxy prepare_quote reuses.
  store.job_documents.push({
    id: "99999999-0000-4000-8000-000000000001",
    job_id: REPAIR_JOB,
    type: "quote",
    job_contact_id: null,
    run_label: null,
    sent_to_client: false,
    superseded_at: null,
  });
  const issue = async (versionId: string) => {
    const slot = await quoteBuilderPdfUploadUrl(
      client,
      { version_id: versionId },
      ACTOR,
    );
    upload("job-pdfs", slot.path);
    return await issueQuoteBuilderVersion(
      client,
      { version_id: versionId, pdf_path: slot.path },
      ACTOR,
      { moveRepairStage },
    );
  };

  const v1 = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    charge_lines: CHARGE,
  }, ACTOR)).version;
  const first = await issue(v1.id);
  const v2 = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    base_version_id: v1.id,
    charge_lines: [{ ...CHARGE[0], unit_price_ex_gst: 700 }],
  }, ACTOR)).version;
  const second = await issue(v2.id);
  assertEquals(second.document.quote_number, "SWR-26101-Q2");
  const variation = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "variation",
    charge_lines: CHARGE,
  }, ACTOR)).version;
  const third = await issue(variation.id);

  const docById = (id: string) => store.job_documents.find((d) => d.id === id)!;
  assert(docById(first.document.id).superseded_at);
  assertEquals(docById(second.document.id).superseded_at, undefined);
  assertEquals(docById(second.document.id).run_label, `qb:${REPAIR_JOB}`);
  assertEquals(docById(third.document.id).superseded_at, undefined);
  assertEquals(
    docById(third.document.id).run_label,
    `qb:${variation.chain_id}`,
  );
  const prepared = docById("99999999-0000-4000-8000-000000000001");
  assertEquals(prepared.superseded_at, null);
  assertEquals(prepared.quote_number, undefined);
  for (const id of [first, second, third].map((r) => r.document.id)) {
    assertEquals(docById(id).sent_at, undefined);
  }
});

Deno.test("quote builder: make-safe cards and foreign photos are refused", async () => {
  const store = seed();
  const { client } = makeFakeClient(store);
  assertEquals(
    await code(
      saveQuoteBuilderVersion(
        client,
        { job_id: MAKESAFE_JOB, kind: "scope" },
        ACTOR,
      ),
    ),
    "job_not_quotable",
  );
  assertEquals(
    await code(
      saveQuoteBuilderVersion(client, {
        job_id: REPAIR_JOB,
        kind: "scope",
        photo_media_ids: [PHOTO_ELSEWHERE],
      }, ACTOR),
    ),
    "photo_not_on_job",
  );
  assertEquals(
    await code(
      saveQuoteBuilderVersion(client, {
        job_id: REPAIR_JOB,
        kind: "scope",
        photo_media_ids: [TRADE_PHOTO_ON_JOB],
      }, ACTOR),
    ),
    "photo_not_on_job",
  );
  assertEquals(
    await code(
      saveQuoteBuilderVersion(client, { job_id: REPAIR_JOB, kind: "scope" }, {
        ...ACTOR,
        orgId: "other-org",
      }),
    ),
    "job_not_found",
  );
  assertEquals(store.quote_builder_versions.length, 0);
});

Deno.test("quote builder: issue files the PDF, freezes, moves scoping to quoted once", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const calls: any[] = [];
  const v1 = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    charge_lines: CHARGE,
    cost_lines: COST,
  }, ACTOR)).version;

  assertEquals(
    await code(
      issueQuoteBuilderVersion(
        client,
        { version_id: v1.id, pdf_path: "x" },
        ACTOR,
        { moveRepairStage: stageMover(store, calls) },
      ),
    ),
    "pdf_not_prepared",
  );
  const slot = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: v1.id },
    ACTOR,
  );
  assertEquals(slot.quote_number, "SWR-26101-Q1");
  assertEquals(
    await code(
      issueQuoteBuilderVersion(
        client,
        { version_id: v1.id, pdf_path: slot.path },
        ACTOR,
        { moveRepairStage: stageMover(store, calls) },
      ),
    ),
    "upload_missing",
  );
  assertEquals(store.job_documents.length, 0);

  upload("job-pdfs", slot.path);
  const issued = await issueQuoteBuilderVersion(
    client,
    { version_id: v1.id, pdf_path: slot.path },
    ACTOR,
    {
      moveRepairStage: stageMover(store, calls),
    },
  );
  assertEquals(issued.version.status, "issued");
  assertEquals(issued.document.quote_number, "SWR-26101-Q1");
  assertEquals(issued.stage, { moved: true, from: "scoping", to: "quoted" });
  assertEquals(calls, [{ jobId: REPAIR_JOB, stage: "quoted" }]);
  const doc = store.job_documents[0];
  assertEquals(doc.type, "quote");
  assertEquals(doc.visible_to_trades, false);
  assertEquals(doc.sent_at, undefined);
  assertEquals("cost_lines" in doc.data_snapshot_json, false);
  assertEquals(
    await code(
      issueQuoteBuilderVersion(
        client,
        { version_id: v1.id, pdf_path: slot.path },
        ACTOR,
        { moveRepairStage: stageMover(store, calls) },
      ),
    ),
    "version_frozen",
  );
});

Deno.test("quote builder: a card already past quoted is not dragged back", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const calls: any[] = [];
  const v1 = (await saveQuoteBuilderVersion(client, {
    job_id: LATE_REPAIR_JOB,
    kind: "scope",
    charge_lines: CHARGE,
  }, ACTOR)).version;
  const slot = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: v1.id },
    ACTOR,
  );
  upload("job-pdfs", slot.path);
  const issued = await issueQuoteBuilderVersion(
    client,
    { version_id: v1.id, pdf_path: slot.path },
    ACTOR,
    {
      moveRepairStage: stageMover(store, calls),
    },
  );
  assertEquals(issued.stage.moved, false);
  assertEquals(issued.stage.reason, "already_past_stage");
  assertEquals(calls.length, 0);
});

Deno.test("quote builder: variation issue, re-issue, decision and stage moves", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const calls: any[] = [];
  const moveRepairStage = stageMover(store, calls);
  store.jobs[0].metadata.repair_stage = "quoted";

  const d1 = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "variation",
    title: "Extra rafter",
    charge_lines: CHARGE,
    cost_lines: COST,
  }, ACTOR)).version;
  assert(d1.chain_id !== REPAIR_JOB);
  const slot1 = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: d1.id },
    ACTOR,
  );
  assertEquals(slot1.quote_number, "SWR-26101-V1.1");
  upload("job-pdfs", slot1.path);
  const first = await issueQuoteBuilderVersion(
    client,
    { version_id: d1.id, pdf_path: slot1.path },
    ACTOR,
    { moveRepairStage },
  );
  assertEquals(first.variation.status, "pending_approval");
  assertEquals(store.job_variations[0].amount, 715);
  assertEquals(store.job_variations[0].cost_estimate, 225);
  assertEquals(first.stage, { moved: true, from: "quoted", to: "variation" });

  const d2 = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "variation",
    chain_id: d1.chain_id,
    base_version_id: d1.id,
    charge_lines: [{ ...CHARGE[0], unit_price_ex_gst: 700 }],
  }, ACTOR)).version;
  const slot2 = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: d2.id },
    ACTOR,
  );
  assertEquals(slot2.quote_number, "SWR-26101-V1.2");
  upload("job-pdfs", slot2.path);
  await issueQuoteBuilderVersion(
    client,
    { version_id: d2.id, pdf_path: slot2.path },
    ACTOR,
    { moveRepairStage },
  );
  assertEquals(store.job_variations.length, 1);
  assertEquals(store.job_variations[0].amount, 770);
  const liveVariationDocs = store.job_documents.filter((d) =>
    d.run_label === `qb:${d1.chain_id}` && d.superseded_at == null
  );
  assertEquals(liveVariationDocs.map((d) => d.quote_number), [
    "SWR-26101-V1.2",
  ]);

  const lostWrite = () => Promise.resolve({});
  const stagesBefore = calls.length;
  assertEquals(
    await code(
      decideQuoteBuilderVariation(
        client,
        { variation_id: store.job_variations[0].id, approved: true },
        ACTOR,
        { decideVariation: lostWrite, moveRepairStage },
      ),
    ),
    "variation_decision_not_recorded",
  );
  assertEquals(calls.length, stagesBefore);
  assertEquals(
    store.jobs.find((j) => j.id === REPAIR_JOB)!.metadata.repair_stage,
    "variation",
  );

  const decisions: any[] = [];
  const decideVariation = (input: any) => {
    decisions.push(input);
    store.job_variations[0].status = input.approved ? "approved" : "rejected";
    return Promise.resolve({});
  };
  const decided = await decideQuoteBuilderVariation(
    client,
    { variation_id: store.job_variations[0].id, approved: true, notes: "ok" },
    ACTOR,
    { decideVariation, moveRepairStage },
  );
  assertEquals(decisions[0].userId, ACTOR.id);
  assertEquals(decided.stage, {
    moved: true,
    from: "variation",
    to: "approved",
  });
  assertEquals(
    await code(
      decideQuoteBuilderVariation(
        client,
        { variation_id: store.job_variations[0].id, approved: false },
        ACTOR,
        { decideVariation, moveRepairStage },
      ),
    ),
    "variation_decided",
  );

  // A decided variation cannot be re-issued; nothing new is filed.
  const d3 = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "variation",
    chain_id: d1.chain_id,
    base_version_id: d2.id,
    charge_lines: CHARGE,
  }, ACTOR)).version;
  const slot3 = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: d3.id },
    ACTOR,
  );
  upload("job-pdfs", slot3.path);
  const docsBefore = store.job_documents.length;
  assertEquals(
    await code(
      issueQuoteBuilderVersion(
        client,
        { version_id: d3.id, pdf_path: slot3.path },
        ACTOR,
        { moveRepairStage },
      ),
    ),
    "variation_decided",
  );
  assertEquals(store.job_documents.length, docsBefore);
});

Deno.test("quote builder: a retried issue reuses the filed PDF document", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const v1 = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    charge_lines: CHARGE,
  }, ACTOR)).version;
  const slot = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: v1.id },
    ACTOR,
  );
  upload("job-pdfs", slot.path);
  // Simulate the first attempt dying after the document was filed.
  store.job_documents.push({
    id: "77777777-7777-4777-8777-777777777777",
    job_id: REPAIR_JOB,
    type: "quote",
    quote_number: "SWR-26101-Q1",
    pdf_url: "https://cdn.invalid/x.pdf",
    metadata: { quote_builder_version_id: v1.id },
  });
  const issued = await issueQuoteBuilderVersion(
    client,
    { version_id: v1.id, pdf_path: slot.path },
    ACTOR,
    {
      moveRepairStage: stageMover(store, []),
    },
  );
  assertEquals(issued.document.id, "77777777-7777-4777-8777-777777777777");
  assertEquals(store.job_documents.length, 1);
});

Deno.test("quote builder: a save landing mid-issue leaves no unlinked variation behind", async () => {
  const store = seed();
  let raced = false;
  const { client, upload } = makeFakeClient(store, {
    afterInsert: (table) => {
      if (table !== "job_variations" || raced) return;
      raced = true;
      const draft = store.quote_builder_versions[0];
      Object.assign(draft, { quote_number: null, updated_at: tick() });
    },
  });
  const moveRepairStage = stageMover(store, []);
  const d1 = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "variation",
    charge_lines: CHARGE,
  }, ACTOR)).version;
  const slot1 = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: d1.id },
    ACTOR,
  );
  upload("job-pdfs", slot1.path);
  assertEquals(
    await code(
      issueQuoteBuilderVersion(
        client,
        { version_id: d1.id, pdf_path: slot1.path },
        ACTOR,
        { moveRepairStage },
      ),
    ),
    "stale_version",
  );
  assertEquals(store.job_variations.length, 0);

  const slot2 = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: d1.id },
    ACTOR,
  );
  assertEquals(slot2.quote_number, "SWR-26101-V1.1");
  upload("job-pdfs", slot2.path);
  const issued = await issueQuoteBuilderVersion(
    client,
    { version_id: d1.id, pdf_path: slot2.path },
    ACTOR,
    { moveRepairStage },
  );
  assertEquals(store.job_variations.length, 1);
  assertEquals(store.job_variations[0].variation_number, 1);
  assertEquals(issued.variation.id, store.job_variations[0].id);
  assertEquals(store.job_documents.length, 1);
  assertEquals(issued.document.quote_number, "SWR-26101-V1.1");
});

Deno.test("quote builder: a double-submitted private job mints one job", async () => {
  const store = seed();
  const { client } = makeFakeClient(store);
  const body = {
    request_id: "88888888-8888-4888-8888-888888888889",
    client_name: "Jane Citizen",
  };
  const [a, b] = await Promise.all([
    createQuoteBuilderPrivateJob(client, body, ACTOR),
    createQuoteBuilderPrivateJob(client, body, ACTOR),
  ]);
  assertEquals(a.job.id, b.job.id);
  assertEquals([a.created, b.created].sort(), [false, true]);
  assertEquals(
    store.jobs.filter((j) => j.type === "miscellaneous").length,
    1,
  );
});

Deno.test("quote builder: private job is SWM miscellaneous, idempotent, never stage-moved", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const requestId = "88888888-8888-4888-8888-888888888888";
  const made = await createQuoteBuilderPrivateJob(client, {
    request_id: requestId,
    client_name: "Jane Citizen",
  }, ACTOR);
  assertEquals(made.created, true);
  assertEquals(made.job.type, "miscellaneous");
  assertEquals(made.job.category, "private_renovation");
  assertEquals(store.jobs.at(-1)!.status, "draft");
  const again = await createQuoteBuilderPrivateJob(client, {
    request_id: requestId,
    client_name: "Jane Citizen",
  }, ACTOR);
  assertEquals(again.created, false);
  assertEquals(again.job.id, made.job.id);
  assertEquals(
    await code(
      createQuoteBuilderPrivateJob(client, { request_id: requestId }, ACTOR),
    ),
    "invalid_input",
  );

  const listed = await listQuoteBuilderJobs(
    client,
    new URLSearchParams("lane=private"),
    ACTOR,
  );
  assertEquals(listed.jobs.map((j: any) => j.id), [made.job.id]);

  const v1 = (await saveQuoteBuilderVersion(client, {
    job_id: made.job.id,
    kind: "scope",
    charge_lines: CHARGE,
  }, ACTOR)).version;
  const slot = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: v1.id },
    ACTOR,
  );
  upload("job-pdfs", slot.path);
  const calls: any[] = [];
  const issued = await issueQuoteBuilderVersion(
    client,
    { version_id: v1.id, pdf_path: slot.path },
    ACTOR,
    {
      moveRepairStage: stageMover(store, calls),
    },
  );
  assertEquals(issued.stage, { moved: false, reason: "not_a_repair_job" });
  assertEquals(calls.length, 0);
});

Deno.test("quote builder: repair lane lists scoping-stage repair cards only", async () => {
  const store = seed();
  store.jobs.push({
    id: "99999999-9999-4999-8999-999999999999",
    org_id: ORG,
    job_number: "SWR-26103",
    type: "repair",
    status: "cancelled",
    metadata: { repair_stage: "scoping" },
    created_at: "2026-10-04T00:00:00Z",
  });
  const { client } = makeFakeClient(store);
  const listed = await listQuoteBuilderJobs(
    client,
    new URLSearchParams(),
    ACTOR,
  );
  assertEquals(listed.jobs.map((j: any) => j.job_number), ["SWR-26101"]);
  const wide = await listQuoteBuilderJobs(
    client,
    new URLSearchParams("stages=scoping,scheduled"),
    ACTOR,
  );
  assertEquals(wide.jobs.map((j: any) => j.job_number).sort(), [
    "SWR-26101",
    "SWR-26102",
  ]);
  assertEquals(
    await code(
      listQuoteBuilderJobs(client, new URLSearchParams("stages=nope"), ACTOR),
    ),
    "invalid_input",
  );
});

Deno.test("quote builder: photos register only after the upload lands, on the quote builder phase", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  assertEquals(
    await code(
      quoteBuilderPhotoUploadUrl(client, {
        job_id: REPAIR_JOB,
        content_type: "image/heic",
      }, ACTOR),
    ),
    "invalid_input",
  );
  const slot = await quoteBuilderPhotoUploadUrl(client, {
    job_id: REPAIR_JOB,
    content_type: "image/jpeg",
  }, ACTOR);
  assertEquals(
    await code(
      quoteBuilderPhotoRegister(
        client,
        { job_id: REPAIR_JOB, path: slot.path },
        ACTOR,
      ),
    ),
    "upload_missing",
  );
  assertEquals(
    await code(
      quoteBuilderPhotoRegister(client, {
        job_id: REPAIR_JOB,
        path: `${LATE_REPAIR_JOB}/quote-builder/x.jpg`,
      }, ACTOR),
    ),
    "invalid_input",
  );
  upload("job-photos", slot.path);
  const registered = await quoteBuilderPhotoRegister(client, {
    job_id: REPAIR_JOB,
    path: slot.path,
    caption: "Rear eave",
  }, ACTOR);
  const again = await quoteBuilderPhotoRegister(client, {
    job_id: REPAIR_JOB,
    path: slot.path,
    caption: "Rear eave",
  }, ACTOR);
  assertEquals(again.photo.id, registered.photo.id);
  const row = store.job_media.find((m) => m.id === registered.photo.id)!;
  assertEquals([row.phase, row.type, row.label], [
    "quote_builder",
    "photo",
    "Rear eave",
  ]);

  const opened = await getQuoteBuilderJob(
    client,
    new URLSearchParams(`job_id=${REPAIR_JOB}`),
    ACTOR,
  );
  assertEquals(opened.photos.length, 2);
  assertEquals(opened.job.repair_stage, "scoping");
});

Deno.test("quote builder: every action needs a staff session at the front door", () => {
  for (const action of QUOTE_BUILDER_ACTIONS) {
    const url = new URL(`https://x.invalid/ops-api?action=${action}`);
    assert(
      _opsApiActionNeedsStaffRole(url),
      `${action} must need a staff role`,
    );
    assert(
      !AGENT_READ_ALLOWED_ACTIONS.has(action),
      `${action} must not be agent-readable`,
    );
    const trade = _authorizeOpsApiAction({
      url,
      authMode: "jwt",
      authUser: { role: "installer" },
    });
    assertEquals(trade.ok, false);
    if (!trade.ok) assertEquals(trade.status, 403);
    const anonymous = _authorizeOpsApiAction({ url, authMode: "none" });
    assertEquals(anonymous.ok, false);
    if (!anonymous.ok) assertEquals(anonymous.status, 401);
    assertEquals(
      _authorizeOpsApiAction({
        url,
        authMode: "jwt",
        authUser: { role: "ops_manager" },
      }).ok,
      true,
    );
  }
});

Deno.test("quote builder: a non-uuid job id is refused before any read", async () => {
  const { client } = makeFakeClient(seed());
  await assertRejects(
    () =>
      getQuoteBuilderJob(client, new URLSearchParams("job_id=SWR-1"), ACTOR),
    QuoteBuilderError,
  );
});

// ── Pricing settings, line types, the job's value, extra documents and the
// ── work order and purchase orders made from an issued quote (13 Oct 2026).

const FENCE_REPAIR_JOB = "88888888-8888-4888-8888-888888888888";
const PRIVATE_JOB = "99999999-9999-4999-8999-999999999999";
const UNPRICED_FENCE_JOB = "abababab-abab-4bab-8bab-abababababab";
const FENCE_TOOL_PRICING = {
  totalIncGST: 6420.5,
  totalExGST: 5836.82,
  job_description: "42 m Colorbond fence",
  neighbour_splits: { neighbours: [{ name: "N1", share: 0.5 }] },
};
const TYPED_COST = [
  {
    line_id: "c-lab-1",
    line_type: "labour",
    description: "Carpenter on site",
    qty: 8,
    unit: "hr",
    unit_cost_ex_gst: 55,
    supplier_or_trade: "Dave",
  },
  {
    line_id: "c-lab-2",
    line_type: "labour",
    description: "Labourer",
    qty: 4.5,
    unit: "hr",
    unit_cost_ex_gst: 41,
  },
  {
    line_id: "c-mat-1",
    line_type: "material",
    description: "Fascia board 190 mm",
    qty: 12,
    unit: "m",
    unit_cost_ex_gst: 17,
    supplier_or_trade: "Bunnings",
  },
  {
    line_id: "c-mat-2",
    line_type: "material",
    description: "Gutter brackets",
    qty: 20,
    unit: "ea",
    unit_cost_ex_gst: 3,
    supplier_or_trade: "bunnings",
  },
  {
    line_id: "c-mat-3",
    line_type: "material",
    description: "Colorbond gutter",
    qty: 6,
    unit: "m",
    unit_cost_ex_gst: 23,
    supplier_or_trade: "Stratco",
  },
  {
    line_id: "c-mat-4",
    line_type: "material",
    description: "Sealant",
    qty: 2,
    unit: "ea",
    unit_cost_ex_gst: 9,
  },
  {
    line_id: "c-oth-1",
    line_type: "other",
    description: "Skip bin",
    qty: 1,
    unit: "item",
    unit_cost_ex_gst: 310,
    supplier_or_trade: "Bin hire co",
  },
  {
    line_id: "c-old-1",
    description: "Untyped legacy line",
    qty: 1,
    unit: "item",
    unit_cost_ex_gst: 77,
    supplier_or_trade: "Bunnings",
  },
];

/** Saves a draft on the job's scope chain and issues it, with any extras. */
async function issueScope(
  store: Store,
  client: any,
  upload: (bucket: string, path: string) => void,
  jobId: string,
  input: {
    baseVersionId?: string | null;
    costLines?: any[];
    chargeLines?: any[];
    narrative?: string;
    extras?: string[];
  } = {},
) {
  const draft = (await saveQuoteBuilderVersion(client, {
    job_id: jobId,
    kind: "scope",
    base_version_id: input.baseVersionId ?? null,
    narrative: input.narrative ?? "Replace the storm damaged fascia and gutter",
    charge_lines: input.chargeLines ?? CHARGE,
    cost_lines: input.costLines ?? COST,
  }, ACTOR)).version;
  const slot = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: draft.id },
    ACTOR,
  );
  upload("job-pdfs", slot.path);
  const extraDocuments = [];
  for (const document of input.extras ?? []) {
    const extra = await quoteBuilderPdfUploadUrl(
      client,
      { version_id: draft.id, document },
      ACTOR,
    );
    upload("job-pdfs", extra.path);
    extraDocuments.push({ document, pdf_path: extra.path });
  }
  return await issueQuoteBuilderVersion(
    client,
    {
      version_id: draft.id,
      pdf_path: slot.path,
      extra_documents: extraDocuments,
    },
    ACTOR,
    { moveRepairStage: stageMover(store, []) },
  );
}

Deno.test("quote builder: a cost line keeps a valid type and drops any other without failing", async () => {
  const lines = normaliseCostLines([
    { description: "a", line_type: "material" },
    { description: "b", line_type: "labour", unit: "hr" },
    { description: "c", line_type: "other" },
    { description: "d", line_type: "banana" },
    { description: "e", line_type: "Labour" },
    { description: "f", line_type: 7 },
    { description: "g" },
  ]);
  assertEquals(lines.map((l) => l.line_type), [
    "material",
    "labour",
    "other",
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  for (const line of lines.slice(3)) assertEquals("line_type" in line, false);

  // Saved and read back on the version; totals are untouched by the type.
  const store = seed();
  const { client } = makeFakeClient(store);
  const saved = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    cost_lines: [
      { ...COST[0], line_type: "banana" },
      { ...COST[0], line_id: "c-2", line_type: "labour", unit: "hr" },
    ],
    charge_lines: CHARGE,
  }, ACTOR)).version;
  assertEquals("line_type" in saved.cost_lines[0], false);
  assertEquals(saved.cost_lines[1].line_type, "labour");
  assertEquals(saved.cost_total_ex_gst, 450);
  const opened = await getQuoteBuilderJob(
    client,
    new URLSearchParams(`job_id=${REPAIR_JOB}`),
    ACTOR,
  );
  assertEquals(opened.scope.versions[0].cost_lines[1].line_type, "labour");
});

Deno.test("quote builder: settings come from the settings table, null when a row is missing or not a number", async () => {
  const store = seed();
  const { client } = makeFakeClient(store);
  const open = () =>
    getQuoteBuilderJob(
      client,
      new URLSearchParams(`job_id=${REPAIR_JOB}`),
      ACTOR,
    );

  // No rows at all: every setting is null, and the key is still sent, because
  // the app switches line types on from the presence of `settings`.
  assertEquals((await open()).settings, {
    labour_rate_ex_gst: null,
    materials_multiplier: null,
    target_margin_pct: null,
  });
  assertEquals((await open()).can_edit_settings, false);

  store.quote_builder_settings = [
    { org_id: ORG, setting_key: "insurance_labour_rate_ex_gst", amount: 95 },
    {
      org_id: ORG,
      setting_key: "insurance_materials_multiplier",
      amount: "1.4",
    },
    { org_id: ORG, setting_key: "target_margin_pct", amount: "not a number" },
    {
      org_id: "00000000-0000-0000-0000-0000000000ff",
      setting_key: "target_margin_pct",
      amount: 33,
    },
  ];
  assertEquals(await loadQuoteBuilderSettings(client), {
    labour_rate_ex_gst: 95,
    materials_multiplier: 1.4,
    target_margin_pct: null,
  });
  assertEquals((await open()).settings.labour_rate_ex_gst, 95);
});

Deno.test("quote builder: the scope of works is filed on the job beside the quote, and carries no cost figure", async () => {
  const store = seed();
  store.quote_builder_settings = [
    { org_id: ORG, setting_key: "insurance_labour_rate_ex_gst", amount: 95 },
    { org_id: ORG, setting_key: "insurance_materials_multiplier", amount: 1.4 },
    { org_id: ORG, setting_key: "target_margin_pct", amount: 33 },
  ];
  const { client, upload } = makeFakeClient(store);
  const draft = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    charge_lines: CHARGE,
    cost_lines: TYPED_COST,
  }, ACTOR)).version;
  const quoteSlot = await quoteBuilderPdfUploadUrl(client, {
    version_id: draft.id,
  }, ACTOR);
  assertEquals(quoteSlot.document, "quote");
  upload("job-pdfs", quoteSlot.path);
  const scopeSlot = await quoteBuilderPdfUploadUrl(client, {
    version_id: draft.id,
    document: "scope_of_works",
  }, ACTOR);
  assert(scopeSlot.path !== quoteSlot.path);
  assertEquals(scopeSlot.quote_number, "SWR-26101-Q1");
  // An extra slot writes nothing on the version: the quote number stamp stands.
  assertEquals(store.quote_builder_versions[0].quote_number, "SWR-26101-Q1");
  assertEquals(
    await code(
      quoteBuilderPdfUploadUrl(client, {
        version_id: draft.id,
        document: "invoice",
      }, ACTOR),
    ),
    "invalid_input",
  );
  assertEquals(
    await code(
      quoteBuilderPdfUploadUrl(client, {
        version_id: draft.id,
        document: "toString",
      }, ACTOR),
    ),
    "invalid_input",
  );

  const issue = (extra_documents: any) =>
    issueQuoteBuilderVersion(
      client,
      { version_id: draft.id, pdf_path: quoteSlot.path, extra_documents },
      ACTOR,
      { moveRepairStage: stageMover(store, []) },
    );
  const scope = { document: "scope_of_works", pdf_path: scopeSlot.path };
  // Every refusal leaves nothing written and the version a draft.
  assertEquals(await code(issue([scope])), "upload_missing");
  assertEquals(
    await code(
      issue([{ document: "scope_of_works", pdf_path: quoteSlot.path }]),
    ),
    "invalid_input",
  );
  assertEquals(await code(issue([scope, scope])), "invalid_input");
  assertEquals(
    await code(issue([{ document: "other", pdf_path: scopeSlot.path }])),
    "invalid_input",
  );
  assertEquals(store.job_documents.length, 0);
  assertEquals(store.quote_builder_versions[0].status, "draft");

  upload("job-pdfs", scopeSlot.path);
  const issued = await issue([scope]);
  assertEquals(issued.extra_documents.map((d: any) => d.document), [
    "scope_of_works",
  ]);
  const extras = store.job_documents.filter((d) => d.type === "other");
  assertEquals(extras.length, 1);
  const doc = extras[0];
  assertEquals(doc.job_id, REPAIR_JOB);
  assertEquals(doc.visible_to_trades, false);
  assertEquals(doc.run_label, `qb:${REPAIR_JOB}`);
  assertEquals(doc.metadata.quote_builder_version_id, draft.id);
  assertEquals(doc.metadata.quote_builder_document, "scope_of_works");
  // quote_number is unique on job_documents and belongs to the quote row.
  assertEquals(doc.quote_number, undefined);
  assertEquals(doc.sent_at, undefined);
  assertEquals(
    store.job_documents.filter((d) => d.type === "quote").length,
    1,
  );

  // The filed row sits beside the client quote, so it holds no cost, rate,
  // multiplier, margin or total: its only number is the version number, and no
  // field is named for money.
  const keys: string[] = [];
  const numbers: number[] = [];
  const texts: string[] = [];
  const walk = (value: any) => {
    if (typeof value === "number") numbers.push(value);
    else if (typeof value === "string") texts.push(value);
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        keys.push(key);
        walk(inner);
      }
    }
  };
  walk(doc);
  assertEquals(numbers, [1]);
  assertEquals(
    keys.filter((key) =>
      /cost|price|rate|multiplier|margin|total|charge|gst|line|snapshot/i
        .test(key)
    ),
    [],
  );
  assertEquals(texts.filter((value) => value.includes("$")), []);

  const opened = await getQuoteBuilderJob(
    client,
    new URLSearchParams(`job_id=${REPAIR_JOB}`),
    ACTOR,
  );
  // The client quote list stays the quote alone; the extra has its own key.
  assertEquals(opened.documents.length, 1);
  assertEquals(
    opened.extra_documents.map((d: any) => [d.document, d.superseded]),
    [["scope_of_works", false]],
  );

  // A re-issue retires the earlier version's scope of works, with or without a new one.
  const second = await issueScope(store, client, upload, REPAIR_JOB, {
    baseVersionId: draft.id,
    extras: ["scope_of_works"],
  });
  const third = await issueScope(store, client, upload, REPAIR_JOB, {
    baseVersionId: second.version.id,
  });
  assertEquals(third.extra_documents, []);
  const filed = store.job_documents.filter((d) => d.type === "other");
  assertEquals(filed.map((d) => d.metadata.quote_builder_version_id), [
    draft.id,
    second.version.id,
  ]);
  assertEquals(filed.filter((d) => d.superseded_at == null), []);
});

Deno.test("quote builder: the material order list is never given a slot or filed", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const draft = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    charge_lines: CHARGE,
    cost_lines: TYPED_COST,
  }, ACTOR)).version;
  const quoteSlot = await quoteBuilderPdfUploadUrl(client, {
    version_id: draft.id,
  }, ACTOR);
  upload("job-pdfs", quoteSlot.path);

  // No upload slot, so nothing of the cost list can reach the public bucket.
  assertEquals(
    await code(
      quoteBuilderPdfUploadUrl(client, {
        version_id: draft.id,
        document: "material_order_list",
      }, ACTOR),
    ),
    "invalid_input",
  );
  // And an issue naming one is refused whole, whatever path it gives.
  const listPath = quoteSlot.path.replace(".pdf", "-material-order-list.pdf");
  upload("job-pdfs", listPath);
  assertEquals(
    await code(
      issueQuoteBuilderVersion(
        client,
        {
          version_id: draft.id,
          pdf_path: quoteSlot.path,
          extra_documents: [{
            document: "material_order_list",
            pdf_path: listPath,
          }],
        },
        ACTOR,
        { moveRepairStage: stageMover(store, []) },
      ),
    ),
    "invalid_input",
  );
  assertEquals(store.job_documents.length, 0);
  assertEquals(store.quote_builder_versions[0].status, "draft");
});

Deno.test("quote builder: an issue with no extra documents files the quote alone, as before", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const issued = await issueScope(store, client, upload, REPAIR_JOB);
  assertEquals(issued.extra_documents, []);
  assertEquals(store.job_documents.map((d) => d.type), ["quote"]);
});

Deno.test("quote builder: issuing a scope writes the job's value, and only on a job it may price", async () => {
  const store = seed();
  store.jobs.push(
    {
      // The shape of SWF-261314 Woodvale and SWF-261343 Pingelly: a repair card
      // typed fencing and priced in full by the fence tool.
      id: FENCE_REPAIR_JOB,
      org_id: ORG,
      job_number: "SWF-26150",
      type: "fencing",
      status: "accepted",
      metadata: { ses_family: "repair", repair_stage: "scoping" },
      pricing_json: structuredClone(FENCE_TOOL_PRICING),
      created_at: "2026-10-04T00:00:00Z",
      updated_at: "2026-10-04T00:00:00Z",
    },
    {
      id: PRIVATE_JOB,
      org_id: ORG,
      job_number: "SWM-26160",
      type: "miscellaneous",
      status: "draft",
      metadata: {},
      pricing_json: {},
      created_at: "2026-10-05T00:00:00Z",
      updated_at: "2026-10-05T00:00:00Z",
    },
    {
      id: UNPRICED_FENCE_JOB,
      org_id: ORG,
      job_number: "SWF-26170",
      type: "fencing",
      status: "accepted",
      metadata: { ses_family: "repair", repair_stage: "scoping" },
      pricing_json: {},
      created_at: "2026-10-06T00:00:00Z",
      updated_at: "2026-10-06T00:00:00Z",
    },
  );
  const { client, upload } = makeFakeClient(store);
  const job = (id: string) => store.jobs.find((j) => j.id === id)!;

  const repair = await issueScope(store, client, upload, REPAIR_JOB);
  assertEquals(repair.job_value, { written: true, total_inc_gst: 715 });
  const written = job(REPAIR_JOB).pricing_json;
  assertEquals(
    [written.totalIncGST, written.totalExGST, written.gst, written.source],
    [715, 650, 65, "quote_builder"],
  );
  assertEquals(written.quote_builder.scope_version_id, repair.version.id);
  assertEquals(written.quote_builder.quote_number, "SWR-26101-Q1");
  // Nothing an invoice reader would mistake for line items.
  assertEquals("items" in written || "line_items" in written, false);
  // The value landed before the stage move, and the stage still moved.
  assertEquals(repair.stage, { moved: true, from: "scoping", to: "quoted" });

  const fence = await issueScope(store, client, upload, FENCE_REPAIR_JOB);
  assertEquals(fence.job_value, {
    written: false,
    reason: "priced_by_another_tool",
  });
  assertEquals(job(FENCE_REPAIR_JOB).pricing_json, FENCE_TOOL_PRICING);
  assertEquals(job(FENCE_REPAIR_JOB).updated_at, "2026-10-04T00:00:00Z");
  assertEquals(fence.version.status, "issued");

  // A repair card typed fencing with no pricing at all is not priced by
  // another tool, and the reply does not say it is.
  const unpriced = await issueScope(store, client, upload, UNPRICED_FENCE_JOB);
  assertEquals(unpriced.job_value, {
    written: false,
    reason: "job_type_not_valued_here",
  });
  assertEquals(job(UNPRICED_FENCE_JOB).pricing_json, {});
  assertEquals(job(UNPRICED_FENCE_JOB).updated_at, "2026-10-06T00:00:00Z");
  assertEquals(unpriced.version.status, "issued");

  const privateQuote = await issueScope(store, client, upload, PRIVATE_JOB);
  assertEquals(privateQuote.job_value, { written: true, total_inc_gst: 715 });

  // A re-issued scope replaces the scope part of the value.
  const reissued = await issueScope(store, client, upload, REPAIR_JOB, {
    baseVersionId: repair.version.id,
    chargeLines: [{ ...CHARGE[0], unit_price_ex_gst: 900 }],
  });
  assertEquals(reissued.job_value, { written: true, total_inc_gst: 990 });
  assertEquals(job(REPAIR_JOB).pricing_json.totalExGST, 900);
  assertEquals(
    job(REPAIR_JOB).pricing_json.quote_builder.quote_number,
    "SWR-26101-Q2",
  );
});

Deno.test("quote builder: the value guard admits only an empty or builder-written pricing on a repair or private job", () => {
  const may = (type: string, pricing_json: unknown) =>
    quoteBuilderMayWriteJobValue({ type, pricing_json });
  assertEquals(may("repair", null), true);
  assertEquals(may("repair", undefined), true);
  assertEquals(may("repair", {}), true);
  assertEquals(may("miscellaneous", {}), true);
  assertEquals(
    may("repair", { source: "quote_builder", totalIncGST: 1 }),
    true,
  );
  assertEquals(may("repair", FENCE_TOOL_PRICING), false);
  assertEquals(
    may("repair", { totalIncGST: 5000, source: "ghl_opportunity" }),
    false,
  );
  // A double-encoded blob is somebody else's, never an empty one.
  assertEquals(may("repair", "{}"), false);
  assertEquals(may("repair", []), false);
  // Repair cards typed fencing or makesafe are priced elsewhere, even when empty.
  assertEquals(may("fencing", {}), false);
  assertEquals(may("fencing", { source: "quote_builder" }), false);
  assertEquals(may("makesafe", null), false);
  assertEquals(may("patio", {}), false);
});

Deno.test("quote builder: an approved variation adds to the job's value and a rejected one does not", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const moveRepairStage = stageMover(store, []);
  const job = () => store.jobs.find((j) => j.id === REPAIR_JOB)!;
  await issueScope(store, client, upload, REPAIR_JOB);
  assertEquals(job().pricing_json.totalIncGST, 715);

  const issueVariation = async (price: number) => {
    const draft = (await saveQuoteBuilderVersion(client, {
      job_id: REPAIR_JOB,
      kind: "variation",
      title: "Extra",
      charge_lines: [{ ...CHARGE[0], unit_price_ex_gst: price }],
    }, ACTOR)).version;
    const slot = await quoteBuilderPdfUploadUrl(client, {
      version_id: draft.id,
    }, ACTOR);
    upload("job-pdfs", slot.path);
    return await issueQuoteBuilderVersion(
      client,
      { version_id: draft.id, pdf_path: slot.path },
      ACTOR,
      { moveRepairStage },
    );
  };
  const decide = (variationId: string, approved: boolean) =>
    decideQuoteBuilderVariation(
      client,
      { variation_id: variationId, approved },
      ACTOR,
      {
        moveRepairStage,
        decideVariation: ({ variationId: id, approved: yes }) => {
          store.job_variations.find((v) => v.id === id)!.status = yes
            ? "approved"
            : "rejected";
          return Promise.resolve({});
        },
      },
    );

  // Issuing a variation changes nothing: it is not approved yet.
  const first = await issueVariation(200);
  assertEquals("job_value" in first, false);
  assertEquals(job().pricing_json.totalIncGST, 715);

  const approved = await decide(first.variation.id, true);
  assertEquals(approved.job_value, { written: true, total_inc_gst: 935 });
  assertEquals(job().pricing_json.totalExGST, 850);
  assertEquals(job().pricing_json.quote_builder.variation_ids, [
    first.variation.id,
  ]);

  const second = await issueVariation(1000);
  const rejected = await decide(second.variation.id, false);
  assertEquals("job_value" in rejected, false);
  assertEquals(job().pricing_json.totalIncGST, 935);
});

Deno.test("quote builder: a failed value write is reported and the quote is still issued", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store, {
    updateError: (table, payload) =>
      table === "jobs" && "pricing_json" in payload
        ? { code: "57014", message: "statement timeout" }
        : null,
  });
  const issued = await issueScope(store, client, upload, REPAIR_JOB);
  assertEquals(issued.job_value, { written: false, reason: "write_failed" });
  assertEquals(issued.version.status, "issued");
  assertEquals(issued.stage, { moved: true, from: "scoping", to: "quoted" });
  assertEquals(store.jobs[0].pricing_json, undefined);

  // With no issued scope there is nothing to value.
  assertEquals(await writeQuoteBuilderJobValue(client, LATE_REPAIR_JOB), {
    written: false,
    reason: "nothing_issued",
  });
});

Deno.test("quote builder: a work order from an issued quote carries the scope and labour hours, never money", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const createdWith: any[] = [];
  const createWorkOrder = (input: any) => {
    createdWith.push(input);
    return client.from("work_orders").insert({
      org_id: ORG,
      job_id: input.jobId,
      wo_number: `WO-${createdWith.length}`,
      scope_items: input.scopeItems,
      special_instructions: input.specialInstructions,
      status: "draft",
      quote_builder_version_id: input.quoteBuilderVersionId,
    }).select().single().then(({ data, error }: any) => {
      if (error) throw error;
      return { work_order: data };
    });
  };
  const make = (body: any) =>
    makeQuoteBuilderWorkOrder(client, body, ACTOR, { createWorkOrder });

  const draft = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    charge_lines: CHARGE,
    cost_lines: TYPED_COST,
  }, ACTOR)).version;
  assertEquals(
    await code(make({ version_id: draft.id })),
    "version_not_issued",
  );
  assertEquals(await code(make({ version_id: "nope" })), "invalid_input");
  assertEquals(
    await code(make({ version_id: crypto.randomUUID() })),
    "version_not_found",
  );
  assertEquals(store.work_orders ?? [], []);

  const issued = await issueScope(store, client, upload, REPAIR_JOB, {
    baseVersionId: draft.id,
    costLines: TYPED_COST,
    chargeLines: [{ ...CHARGE[0], unit_price_ex_gst: 1234.56 }],
  });
  // The request names another job; the work order still lands on the version's.
  const first = await make({
    version_id: issued.version.id,
    job_id: LATE_REPAIR_JOB,
    jobId: LATE_REPAIR_JOB,
  });
  assertEquals(first.created, true);
  assertEquals(store.work_orders.length, 1);
  const row = store.work_orders[0];
  assertEquals(row.job_id, REPAIR_JOB);
  assertEquals(row.status, "draft");
  assertEquals(row.kind, undefined);
  assertEquals(row.origin, undefined);
  assertEquals(row.scope_items, [
    {
      description: "Scope of works",
      notes: "Replace the storm damaged fascia and gutter",
    },
    { description: "Carpenter on site", qty: 8, unit: "hr" },
    { description: "Labourer", qty: 4.5, unit: "hr" },
  ]);
  // What an allocated trade reads: the real trade redaction keeps every key,
  // so the scope text and the labour hours reach the crew.
  assertEquals(
    redactTradeWorkOrdersForAllocated([structuredClone(row)])[0].scope_items,
    row.scope_items,
  );
  assertEquals(row.special_instructions, "From quote SWR-26101-Q1");
  // No dollar sign, and none of the version's unit costs, prices or totals.
  const printed = JSON.stringify([row.scope_items, row.special_instructions]);
  assertEquals(printed.includes("$"), false);
  const money = [
    ...issued.version.cost_lines.flatMap((l: any) => [
      l.unit_cost_ex_gst,
      l.line_total_ex_gst,
    ]),
    ...issued.version.charge_lines.flatMap((l: any) => [
      l.unit_price_ex_gst,
      l.line_total_inc_gst,
    ]),
    issued.version.cost_total_ex_gst,
    issued.version.charge_total_inc_gst,
  ];
  for (const figure of money) {
    assertEquals(
      new RegExp(`(^|[^0-9.])${String(figure).replace(".", "\\.")}([^0-9.]|$)`)
        .test(printed.replace("SWR-26101-Q1", "")),
      false,
      `work order text carries the figure ${figure}`,
    );
  }

  // A second press makes nothing and returns the first.
  const second = await make({ version_id: issued.version.id });
  assertEquals(second, { created: false, work_order: first.work_order });
  assertEquals(store.work_orders.length, 1);
  assertEquals(createdWith.length, 1);

  // Two presses at once: the unique index refuses the loser, which reads back
  // the winner's.
  const racing = (input: any) => {
    store.work_orders.push({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      job_id: input.jobId,
      wo_number: "WO-WON",
      status: "draft",
      quote_builder_version_id: input.quoteBuilderVersionId,
      created_at: tick(),
    });
    return createWorkOrder(input);
  };
  const other = await issueScope(store, client, upload, LATE_REPAIR_JOB, {
    costLines: TYPED_COST,
  });
  const lost = await makeQuoteBuilderWorkOrder(
    client,
    {
      version_id: other.version.id,
    },
    ACTOR,
    { createWorkOrder: racing },
  );
  assertEquals(lost, {
    created: false,
    work_order: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      wo_number: "WO-WON",
      status: "draft",
    },
  });

  // The app sees what was made on the version it came from.
  const opened = await getQuoteBuilderJob(
    client,
    new URLSearchParams(`job_id=${REPAIR_JOB}`),
    ACTOR,
  );
  assertEquals(
    opened.scope.versions.map((v: any) => v.work_order),
    [first.work_order],
  );
});

Deno.test("quote builder: a dollar amount in the scope text or a labour line refuses the work order", () => {
  const items = (version: any) =>
    code(Promise.resolve().then(() => quoteBuilderWorkOrderItems(version)));
  return Promise.all([
    items({ narrative: "Allow $500 for tapware", cost_lines: [] }),
    items({
      narrative: "Fix the gutter",
      cost_lines: [{
        line_type: "labour",
        description: "Carpenter @ $ 55 an hour",
        qty: 8,
        unit: "hr",
      }],
    }),
    items({
      narrative: "Fix the gutter",
      cost_lines: [{
        line_type: "labour",
        description: "Carpenter",
        qty: 8,
        unit: "$55/hr",
      }],
    }),
    items({ narrative: null, cost_lines: [TYPED_COST[2], TYPED_COST[7]] }),
    // A material line's wording never reaches the work order, so it cannot refuse it.
    items({
      narrative: "Fix the gutter",
      cost_lines: [{ ...TYPED_COST[2], description: "Board at $17 a metre" }],
    }),
  ]).then((codes) =>
    assertEquals(codes, [
      "work_order_text_has_money",
      "work_order_text_has_money",
      "work_order_text_has_money",
      "nothing_for_work_order",
      "no_error",
    ])
  );
});

Deno.test("quote builder: purchase orders from an issued quote, one draft per supplier from the Material lines", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const createdWith: any[] = [];
  const createPurchaseOrder = (input: any) => {
    createdWith.push(input);
    const subtotal = input.lineItems.reduce(
      (sum: number, li: any) => sum + li.quantity * li.unit_price,
      0,
    );
    return client.from("purchase_orders").insert({
      org_id: ORG,
      job_id: input.jobId,
      po_number: `PO-${createdWith.length}`,
      supplier_name: input.supplierName,
      reference: input.reference,
      line_items: input.lineItems,
      subtotal,
      notes: input.notes,
      status: "draft",
      quote_builder_version_id: input.quoteBuilderVersionId,
    }).select().single().then(({ data, error }: any) => {
      if (error) throw error;
      return { purchase_order: data };
    });
  };
  const make = (body: any) =>
    makeQuoteBuilderPurchaseOrders(client, body, ACTOR, {
      createPurchaseOrder,
    });

  const issued = await issueScope(store, client, upload, REPAIR_JOB, {
    costLines: TYPED_COST,
  });
  const first = await make({
    version_id: issued.version.id,
    job_id: LATE_REPAIR_JOB,
  });
  assertEquals(first.created, 3);
  assertEquals(
    store.purchase_orders.map((po) => [
      po.supplier_name,
      po.job_id,
      po.status,
      po.reference,
      po.subtotal,
      po.notes,
      po.xero_po_id,
    ]),
    [
      // "Bunnings" and "bunnings" are one supplier: 12 x 17 + 20 x 3.
      ["Bunnings", REPAIR_JOB, "draft", "SWR-26101", 264, null, undefined],
      ["Stratco", REPAIR_JOB, "draft", "SWR-26101", 138, null, undefined],
      [
        "No supplier named",
        REPAIR_JOB,
        "draft",
        "SWR-26101",
        18,
        "Supplier not named on the scope",
        undefined,
      ],
    ],
  );
  assertEquals(store.purchase_orders[0].line_items, [
    {
      description: "Fascia board 190 mm",
      quantity: 12,
      unit: "m",
      unit_price: 17,
    },
    { description: "Gutter brackets", quantity: 20, unit: "ea", unit_price: 3 },
  ]);
  // Labour, Other and untyped lines are on no purchase order.
  const ordered = store.purchase_orders.flatMap((po) =>
    po.line_items.map((li: any) => li.description)
  );
  for (
    const absent of ["Carpenter on site", "Skip bin", "Untyped legacy line"]
  ) {
    assertEquals(ordered.includes(absent), false);
  }
  assertEquals(first.purchase_orders.map((po: any) => po.supplier_name), [
    "Bunnings",
    "Stratco",
    "No supplier named",
  ]);

  assertEquals("message" in first, false);

  // A second press makes nothing, returns the same three and names them.
  const second = await make({ version_id: issued.version.id });
  assertEquals(second.created, 0);
  assertEquals(second.purchase_orders, first.purchase_orders);
  assert(
    String(second.message).includes(
      "PO-1 (Bunnings), PO-2 (Stratco), PO-3 (No supplier named)",
    ),
    second.message,
  );
  assertEquals(store.purchase_orders.length, 3);
  assertEquals(createdWith.length, 3);

  // Staff fill in the unnamed order's supplier. A further press still makes
  // nothing: the renamed order is not made a second time.
  store.purchase_orders[2].supplier_name = "Reece";
  const afterRename = await make({ version_id: issued.version.id });
  assertEquals(afterRename.created, 0);
  assert(
    String(afterRename.message).includes("PO-3 (Reece)"),
    afterRename.message,
  );
  assertEquals(store.purchase_orders.length, 3);

  // While any order is live a cancelled one is not topped up either.
  store.purchase_orders[1].status = "cancelled";
  const partial = await make({ version_id: issued.version.id });
  assertEquals(partial.created, 0);
  assertEquals(
    partial.purchase_orders.map((po: any) => po.supplier_name),
    ["Bunnings", "Reece"],
  );
  assertEquals(store.purchase_orders.length, 3);
  assertEquals(createdWith.length, 3);

  const opened = await getQuoteBuilderJob(
    client,
    new URLSearchParams(`job_id=${REPAIR_JOB}`),
    ACTOR,
  );
  assertEquals(opened.scope.versions[0].purchase_orders.length, 2);
  assertEquals(opened.scope.versions[0].work_order, null);

  // With every order cancelled, a press makes the full set again.
  for (const po of store.purchase_orders) po.status = "cancelled";
  const again = await make({ version_id: issued.version.id });
  assertEquals(again.created, 3);
  assertEquals("message" in again, false);
  assertEquals(
    again.purchase_orders.map((po: any) => po.supplier_name),
    ["Bunnings", "Stratco", "No supplier named"],
  );
  assertEquals(store.purchase_orders.length, 6);

  // Nothing to order, and a draft, are both refused with nothing made.
  const labourOnly = await issueScope(store, client, upload, LATE_REPAIR_JOB, {
    costLines: [TYPED_COST[0], TYPED_COST[7]],
  });
  assertEquals(
    await code(make({ version_id: labourOnly.version.id })),
    "no_material_lines",
  );
  assertEquals(quoteBuilderPurchaseOrderGroups({ cost_lines: COST }), []);
  assertEquals(store.purchase_orders.length, 6);
});

Deno.test("quote builder: the dispatch makes a real draft crew work order and real draft purchase orders", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const issued = await issueScope(store, client, upload, REPAIR_JOB, {
    costLines: TYPED_COST,
  });
  const realFetch = globalThis.fetch;
  // createPO pings reporting-api to recompute job intelligence; keep the test offline.
  globalThis.fetch = () => Promise.resolve(new Response("{}"));
  try {
    const call = async (action: string) => {
      const response = await dispatchQuoteBuilderAction(
        client,
        action,
        new URLSearchParams(),
        // A caller cannot aim the order at another job or version through the body.
        {
          version_id: issued.version.id,
          job_id: LATE_REPAIR_JOB,
          quote_builder_version_id: crypto.randomUUID(),
          kind: "job",
          status: "approved",
        },
        ACTOR,
      );
      return { status: response.status, body: await response.json() };
    };

    const workOrder = await call("quote_builder_make_work_order");
    assertEquals(workOrder.status, 200);
    assertEquals(workOrder.body.created, true);
    assertEquals(store.work_orders.length, 1);
    const wo = store.work_orders[0];
    assertEquals(
      [wo.job_id, wo.status, wo.quote_builder_version_id, wo.kind, wo.origin],
      [REPAIR_JOB, "draft", issued.version.id, undefined, undefined],
    );
    assertEquals(wo.scope_items.length, 3);
    // The order records who pressed: the user's id (created_by is a uuid
    // column), never the email.
    assertEquals(wo.created_by, ACTOR.id);
    // An allocated trade reads the scope text and the labour hours.
    assertEquals(
      redactTradeWorkOrdersForAllocated([structuredClone(wo)])[0].scope_items,
      [
        {
          description: "Scope of works",
          notes: "Replace the storm damaged fascia and gutter",
        },
        { description: "Carpenter on site", qty: 8, unit: "hr" },
        { description: "Labourer", qty: 4.5, unit: "hr" },
      ],
    );
    assertEquals((await call("quote_builder_make_work_order")).body, {
      created: false,
      work_order: workOrder.body.work_order,
    });
    assertEquals(store.work_orders.length, 1);

    const orders = await call("quote_builder_make_purchase_orders");
    assertEquals(orders.status, 200);
    assertEquals(orders.body.created, 3);
    assertEquals(
      store.purchase_orders.map((po) => [
        po.job_id,
        po.status,
        po.quote_builder_version_id,
        po.subtotal,
      ]),
      [
        [REPAIR_JOB, "draft", issued.version.id, 264],
        [REPAIR_JOB, "draft", issued.version.id, 138],
        [REPAIR_JOB, "draft", issued.version.id, 18],
      ],
    );
    for (const order of [wo, ...store.purchase_orders]) {
      assertEquals(order.created_by, ACTOR.id);
      assertEquals(String(order.created_by).includes("@"), false);
    }
    assertEquals(
      (await call("quote_builder_make_purchase_orders")).body.created,
      0,
    );
    assertEquals(store.purchase_orders.length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("quote builder: job acceptance leaves quote builder orders alone, and an unnamed supplier is never pushed to Xero", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const issued = await issueScope(store, client, upload, REPAIR_JOB, {
    costLines: TYPED_COST,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("{}"));
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    for (
      const action of [
        "quote_builder_make_work_order",
        "quote_builder_make_purchase_orders",
      ]
    ) {
      const response = await dispatchQuoteBuilderAction(
        client,
        action,
        new URLSearchParams(),
        { version_id: issued.version.id },
        ACTOR,
      );
      assertEquals(response.status, 200);
      await response.json();
    }
    // work_orders.kind defaults to 'crew' in the database; the fake has no defaults.
    const builderWorkOrder = store.work_orders[0];
    builderWorkOrder.kind = "crew";
    const ORDINARY_WO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const ORDINARY_PO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    store.work_orders.push({
      id: ORDINARY_WO,
      job_id: REPAIR_JOB,
      wo_number: "WO-ORDINARY",
      kind: "crew",
      status: "draft",
    });
    store.purchase_orders.push({
      id: ORDINARY_PO,
      job_id: REPAIR_JOB,
      po_number: "PO-ORDINARY",
      supplier_name: "Stratco",
      status: "draft",
      line_items: [],
    });

    // Which purchase orders a push to Xero was started for, and how often a
    // push got as far as asking for the Xero token.
    const pushStartedFor: string[] = [];
    let xeroTokenReads = 0;
    const watched = {
      ...client,
      from: (table: string) => {
        const builder = client.from(table);
        if (table === "xero_tokens") xeroTokenReads += 1;
        if (table === "purchase_orders") {
          const eq = builder.eq;
          builder.eq = (key: string, value: any) => {
            if (key === "id") pushStartedFor.push(value);
            return eq(key, value);
          };
        }
        return builder;
      },
    };

    const accepted = await _updateJobStatus(watched, {
      job_id: REPAIR_JOB,
      status: "accepted",
    });
    assertEquals(accepted.success, true);
    await flush();
    await flush();

    // Every other order moves exactly as before; the quote builder's stay drafts.
    const status = (id: string) =>
      store.work_orders.find((w) => w.id === id)!.status;
    assertEquals(status(ORDINARY_WO), "approved");
    assertEquals(status(builderWorkOrder.id), "draft");
    assertEquals(pushStartedFor, [ORDINARY_PO]);
    assertEquals(xeroTokenReads, 1);
    const builderOrders = store.purchase_orders.filter((po) =>
      po.quote_builder_version_id === issued.version.id
    );
    assertEquals(builderOrders.length, 3);
    for (const po of builderOrders) {
      assertEquals([po.status, po.xero_po_id], ["draft", undefined]);
    }

    // A person's own push: the unnamed draft is refused before Xero is asked
    // for anything, so no Xero contact of that name can be made.
    const unnamed = builderOrders.find((po) =>
      po.supplier_name === "No supplier named"
    )!;
    const refused = await assertRejects(
      () => _pushPOToXero(watched, { id: unnamed.id }),
      ApiError,
    );
    assertEquals(refused.status, 409);
    assertEquals((refused.body as any).code, "po_supplier_not_named");
    assertEquals(unnamed.xero_po_id, undefined);
    assertEquals(xeroTokenReads, 1);

    // Once a real supplier is set the same push goes on to Xero (which this
    // test does not have: it stops at the missing token, past the refusal).
    unnamed.supplier_name = "Reece";
    await assertRejects(
      () => _pushPOToXero(watched, { id: unnamed.id }),
      Error,
      "No Xero token available",
    );
    assertEquals(xeroTokenReads, 2);
    // A named quote builder order was never refused.
    const named = builderOrders.find((po) => po.supplier_name === "Bunnings")!;
    await assertRejects(
      () => _pushPOToXero(watched, { id: named.id }),
      Error,
      "No Xero token available",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

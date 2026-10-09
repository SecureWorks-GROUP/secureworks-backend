// deno-lint-ignore-file no-explicit-any
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
  normaliseChargeLines,
  normaliseCostLines,
  QUOTE_BUILDER_ACTIONS,
  QuoteBuilderError,
  quoteBuilderPdfUploadUrl,
  quoteBuilderPhotoRegister,
  quoteBuilderPhotoUploadUrl,
  quoteBuilderQuoteNumber,
  quoteBuilderTotals,
  repairStageMoveDecision,
  saveQuoteBuilderVersion,
} from "./quote_builder.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

type Row = Record<string, any>;
type Store = Record<string, Row[]>;

const ORG = "00000000-0000-0000-0000-000000000001";
const REPAIR_JOB = "11111111-1111-4111-8111-111111111111";
const LATE_REPAIR_JOB = "22222222-2222-4222-8222-222222222222";
const MAKESAFE_JOB = "33333333-3333-4333-8333-333333333333";
const PHOTO_ON_JOB = "44444444-4444-4444-8444-444444444444";
const PHOTO_ELSEWHERE = "55555555-5555-4555-8555-555555555555";
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

// ux_job_docs_live_unsent_quote (20260701000001) and
// ux_jobs_quote_builder_request_id (20261009120000).
function uniqueKey(table: string, r: Row): string | null {
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
  hooks: { afterInsert?: (table: string, rows: Row[]) => void } = {},
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
        phase: "scope",
        type: "photo",
        storage_url: "https://cdn.invalid/a.jpg",
      },
      {
        id: PHOTO_ELSEWHERE,
        job_id: LATE_REPAIR_JOB,
        phase: "scope",
        type: "photo",
        storage_url: "https://cdn.invalid/b.jpg",
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

Deno.test("quote builder: photos register only after the upload lands, on the scope phase", async () => {
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
    "scope",
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

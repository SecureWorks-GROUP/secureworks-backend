// deno-lint-ignore-file no-import-prefix no-explicit-any
import "./trade_app_visibility_rules_test_env.ts";
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
  loadQuoteBuilderCardValues,
  loadQuoteBuilderSettings,
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
  _opsApiRequestHandlerForTest,
  _pipelineForTest,
  AGENT_READ_ALLOWED_ACTIONS,
  dispatchQuoteBuilderAction,
} from "./index.ts";
import { _setDefaultLegacyKeyProbeForTest } from "../_shared/service_credential.ts";

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
// ux_jobs_quote_builder_request_id (20261009120000) and the extra document
// index of 20261013160000: one filed copy per version and document.
function uniqueKey(table: string, r: Row): string | null {
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
    insertError?: (table: string, payload: Row) => Row | null;
    selectError?: (table: string) => Row | null;
  } = {},
) {
  const uploads = new Set<string>();
  function from(table: string) {
    store[table] = store[table] || [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    const preds: Array<(r: Row) => boolean> = [];
    const orders: Array<{ key: string; asc: boolean }> = [];
    let limitN: number | null = null;
    let window: [number, number] | null = null;
    // `alias:column->path` entries of a select, as PostgREST projects them.
    let aliases: Array<[string, string]> = [];

    function exec(): { data: any; error: any } {
      if (mode === "insert") {
        const insertRefused = hooks.insertError?.(table, payload);
        if (insertRefused) return { data: null, error: insertRefused };
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
      const selectRefused = hooks.selectError?.(table);
      if (selectRefused) return { data: null, error: selectRefused };
      let rows = matched.slice();
      rows.sort((a, b) => {
        for (const { key, asc } of orders) {
          if (a[key] < b[key]) return asc ? -1 : 1;
          if (a[key] > b[key]) return asc ? 1 : -1;
        }
        return 0;
      });
      if (limitN != null) rows = rows.slice(0, limitN);
      if (window) rows = rows.slice(window[0], window[1] + 1);
      return {
        data: rows.map((r) => ({
          ...r,
          ...Object.fromEntries(
            aliases.map(([alias, path]) => [alias, pathValue(r, path) ?? null]),
          ),
        })),
        error: null,
      };
    }

    const b: any = {
      select: (columns?: string) => {
        aliases = String(columns || "").split(",").map((c) => c.trim())
          .map((c) => /^(\w+):(\w+(?:->>?\w+)+)$/.exec(c))
          .filter((m) => m !== null)
          .map((m) => [m![1], m![2]] as [string, string]);
        return b;
      },
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
        preds.push((r) =>
          v === null ? pathValue(r, k) == null : pathValue(r, k) === v
        );
        return b;
      },
      not: (k: string, op: string, v: any) => {
        preds.push((r) => {
          if (v === null) return r[k] != null;
          // A jsonb column against its text form, as in `not.eq.{}`.
          if (op === "eq" && r[k] !== null && typeof r[k] === "object") {
            return JSON.stringify(r[k]) !== v;
          }
          return r[k] !== v;
        });
        return b;
      },
      // The board read's `or` filters only widen over rows these stores never hold.
      or: () => b,
      order: (k: string, opts?: { ascending?: boolean }) => {
        orders.push({ key: k, asc: opts?.ascending !== false });
        return b;
      },
      range: (from: number, to: number) => {
        window = [from, to];
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

// ── Pricing settings, line types, the job's value and the filed scope of
// ── works (13 Oct 2026).

const FENCE_REPAIR_JOB = "88888888-8888-4888-8888-888888888888";
const PRIVATE_JOB = "99999999-9999-4999-8999-999999999999";
const UNPRICED_FENCE_JOB = "abababab-abab-4bab-8bab-abababababab";
const TOTAL_LESS_JOB = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
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

  // No rows at all: every setting is null, and a repair job's key is still
  // sent, because the app switches line types on from the presence of `settings`.
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
  assertEquals((await open()).settings?.labour_rate_ex_gst, 95);
});

Deno.test("quote builder: a private job opens with no settings keys and no settings read, and still keeps line types", async () => {
  const store = seed();
  store.quote_builder_settings = [
    { org_id: ORG, setting_key: "insurance_labour_rate_ex_gst", amount: 95 },
    { org_id: ORG, setting_key: "insurance_materials_multiplier", amount: 1.4 },
    { org_id: ORG, setting_key: "target_margin_pct", amount: 33 },
  ];
  const reads: string[] = [];
  const { client } = makeFakeClient(store, {
    selectError: (table) => {
      reads.push(table);
      return null;
    },
  });
  const made = await createQuoteBuilderPrivateJob(client, {
    request_id: "88888888-8888-4888-8888-88888888888a",
    client_name: "Jane Citizen",
  }, ACTOR);
  await saveQuoteBuilderVersion(client, {
    job_id: made.job.id,
    kind: "scope",
    cost_lines: [{ ...COST[0], line_type: "labour", unit: "hr" }],
    charge_lines: CHARGE,
  }, ACTOR);

  reads.length = 0;
  const opened = await getQuoteBuilderJob(
    client,
    new URLSearchParams(`job_id=${made.job.id}`),
    ACTOR,
  );
  assertEquals(opened.job.lane, "private");
  // Key for key the reply a private job had before this change.
  assertEquals(Object.keys(opened), [
    "job",
    "scope",
    "variations",
    "photos",
    "documents",
  ]);
  assertEquals(reads.includes("quote_builder_settings"), false);
  assertEquals(opened.scope.versions[0].cost_lines[0].line_type, "labour");

  // The insurance repair lane is told the goal, from the same table.
  reads.length = 0;
  const repair = await getQuoteBuilderJob(
    client,
    new URLSearchParams(`job_id=${REPAIR_JOB}`),
    ACTOR,
  );
  assertEquals(repair.job.lane, "repair");
  assertEquals(repair.settings, {
    labour_rate_ex_gst: 95,
    materials_multiplier: 1.4,
    target_margin_pct: 33,
  });
  assertEquals(repair.can_edit_settings, false);
  assertEquals(reads.includes("quote_builder_settings"), true);
});

Deno.test("quote builder: a private job files the quote alone, and its slot and issue replies are what they were", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const made = await createQuoteBuilderPrivateJob(client, {
    request_id: "88888888-8888-4888-8888-88888888888b",
    client_name: "Jane Citizen",
  }, ACTOR);
  const draft = (await saveQuoteBuilderVersion(client, {
    job_id: made.job.id,
    kind: "scope",
    charge_lines: CHARGE,
  }, ACTOR)).version;

  // No scope of works slot, and no material order list slot, on a private job.
  for (const document of ["scope_of_works", "material_order_list"]) {
    assertEquals(
      await code(
        quoteBuilderPdfUploadUrl(
          client,
          { version_id: draft.id, document },
          ACTOR,
        ),
      ),
      "invalid_input",
    );
  }
  const slot = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: draft.id },
    ACTOR,
  );
  assertEquals(Object.keys(slot), [
    "path",
    "signed_url",
    "token",
    "public_url",
    "quote_number",
  ]);
  upload("job-pdfs", slot.path);

  // Whatever an issue sends as extra_documents, a private job does not read
  // it: nothing is refused, nothing extra is filed and the reply gains no key.
  const scopePath = slot.path.replace(".pdf", "-scope-of-works.pdf");
  upload("job-pdfs", scopePath);
  const issued = await issueQuoteBuilderVersion(
    client,
    {
      version_id: draft.id,
      pdf_path: slot.path,
      extra_documents: [
        { document: "scope_of_works", pdf_path: scopePath },
        { document: "material_order_list" },
        { document: "invoice" },
      ],
    },
    ACTOR,
    { moveRepairStage: stageMover(store, []) },
  );
  assertEquals(Object.keys(issued), [
    "version",
    "document",
    "variation",
    "stage",
  ]);
  assertEquals(issued.version.status, "issued");
  assertEquals(store.job_documents.map((d) => d.type), ["quote"]);

  const next = (await saveQuoteBuilderVersion(client, {
    job_id: made.job.id,
    kind: "scope",
    base_version_id: draft.id,
    charge_lines: CHARGE,
  }, ACTOR)).version;
  const nextSlot = await quoteBuilderPdfUploadUrl(
    client,
    { version_id: next.id },
    ACTOR,
  );
  upload("job-pdfs", nextSlot.path);
  const reissued = await issueQuoteBuilderVersion(
    client,
    { version_id: next.id, pdf_path: nextSlot.path, extra_documents: "junk" },
    ACTOR,
    { moveRepairStage: stageMover(store, []) },
  );
  assertEquals(Object.keys(reissued), [
    "version",
    "document",
    "variation",
    "stage",
  ]);
  assertEquals(store.job_documents.map((d) => d.type), ["quote", "quote"]);
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
  // The reply lists no filed extra documents; the row on the job is the record.
  assertEquals(Object.keys(issued), [
    "version",
    "document",
    "variation",
    "stage",
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
  // The client quote list stays the quote alone, and no other list is sent.
  assertEquals(opened.documents.length, 1);
  assertEquals("extra_documents" in opened, false);
  assertEquals(doc.superseded_at, undefined);

  // A re-issue retires the earlier version's scope of works, with or without a new one.
  const second = await issueScope(store, client, upload, REPAIR_JOB, {
    baseVersionId: draft.id,
    extras: ["scope_of_works"],
  });
  const third = await issueScope(store, client, upload, REPAIR_JOB, {
    baseVersionId: second.version.id,
  });
  assertEquals(third.version.status, "issued");
  const filed = store.job_documents.filter((d) => d.type === "other");
  assertEquals(filed.map((d) => d.metadata.quote_builder_version_id), [
    draft.id,
    second.version.id,
  ]);
  assertEquals(filed.filter((d) => d.superseded_at == null), []);
});

Deno.test("quote builder: a retried variation issue refiles the scope of works under the number it is issued with", async () => {
  const store = seed();
  let failVariationInsert = true;
  const { client, upload } = makeFakeClient(store, {
    insertError: (table) => {
      if (table !== "job_variations" || !failVariationInsert) return null;
      failVariationInsert = false;
      return { message: "statement timeout" };
    },
  });
  const moveRepairStage = stageMover(store, []);
  const draft = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "variation",
    charge_lines: CHARGE,
  }, ACTOR)).version;
  const attempt = async () => {
    const quote = await quoteBuilderPdfUploadUrl(client, {
      version_id: draft.id,
    }, ACTOR);
    upload("job-pdfs", quote.path);
    const scope = await quoteBuilderPdfUploadUrl(client, {
      version_id: draft.id,
      document: "scope_of_works",
    }, ACTOR);
    upload("job-pdfs", scope.path);
    return {
      quoteNumber: quote.quote_number,
      issue: () =>
        issueQuoteBuilderVersion(
          client,
          {
            version_id: draft.id,
            pdf_path: quote.path,
            extra_documents: [{
              document: "scope_of_works",
              pdf_path: scope.path,
            }],
          },
          ACTOR,
          { moveRepairStage },
        ),
    };
  };
  const filedScope = () =>
    store.job_documents.filter((d) => d.type === "other");

  // The first attempt files both PDFs, then dies creating the variation.
  const first = await attempt();
  assertEquals(first.quoteNumber, "SWR-26101-V1.1");
  let died = false;
  await first.issue().catch(() => {
    died = true;
  });
  assert(died, "the first issue was meant to fail at the variation insert");
  assertEquals(store.job_variations.length, 0);
  assertEquals(store.quote_builder_versions[0].status, "draft");
  assertEquals(filedScope().length, 1);
  assertEquals(filedScope()[0].metadata.quote_number, "SWR-26101-V1.1");
  const firstFileName = filedScope()[0].file_name;

  // Another variation on the job takes number 1 before the retry.
  store.job_variations.push({
    id: "66666666-6666-4666-8666-666666666666",
    job_id: REPAIR_JOB,
    variation_number: 1,
    status: "pending_approval",
  });
  assertEquals(await code(first.issue()), "quote_number_changed");

  const second = await attempt();
  assertEquals(second.quoteNumber, "SWR-26101-V2.1");
  const issued = await second.issue();
  assertEquals(issued.version.status, "issued");
  assertEquals(issued.document.quote_number, "SWR-26101-V2.1");

  // One scope of works row, reused, now reading the number it was issued under.
  assertEquals(filedScope().length, 1);
  const doc = filedScope()[0];
  assertEquals(doc.metadata.quote_number, "SWR-26101-V2.1");
  assertEquals(doc.metadata.quote_builder_version_id, draft.id);
  assertEquals(doc.metadata.quote_builder_document, "scope_of_works");
  assert(doc.file_name !== firstFileName);
  assert(String(doc.file_name).includes("V2.1"), doc.file_name);
  assert(String(doc.pdf_url).endsWith(doc.file_name), doc.pdf_url);
});

Deno.test("quote builder: the material order list is never given a slot or filed, and never fails an issue", async () => {
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
  const scopeSlot = await quoteBuilderPdfUploadUrl(client, {
    version_id: draft.id,
    document: "scope_of_works",
  }, ACTOR);
  upload("job-pdfs", scopeSlot.path);

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

  // The app may still list it at issue. The quote issues as normal, nothing is
  // filed for the list whatever path it gives, and the reply says so.
  const listPath = quoteSlot.path.replace(".pdf", "-material-order-list.pdf");
  upload("job-pdfs", listPath);
  const issued = await issueQuoteBuilderVersion(
    client,
    {
      version_id: draft.id,
      pdf_path: quoteSlot.path,
      extra_documents: [
        { document: "material_order_list", pdf_path: listPath },
        { document: "scope_of_works", pdf_path: scopeSlot.path },
        { document: "material_order_list" },
      ],
    },
    ACTOR,
    { moveRepairStage: stageMover(store, []) },
  );
  assertEquals(issued.version.status, "issued");
  assertEquals(issued.stage, { moved: true, from: "scoping", to: "quoted" });
  assertEquals(Object.keys(issued), [
    "version",
    "document",
    "variation",
    "stage",
    "extra_documents_not_filed",
  ]);
  assertEquals(issued.extra_documents_not_filed, [
    { document: "material_order_list", reason: "internal_costs_not_filed" },
  ]);
  assertEquals(
    store.job_documents.map((d) => [
      d.type,
      d.metadata.quote_builder_document ?? null,
    ]),
    [["quote", null], ["other", "scope_of_works"]],
  );
  for (const doc of store.job_documents) {
    assertEquals(
      JSON.stringify(doc).includes("material-order-list"),
      false,
    );
  }

  // An issue that names no cost list says nothing about one.
  const again = await issueScope(store, client, upload, REPAIR_JOB, {
    baseVersionId: draft.id,
    extras: ["scope_of_works"],
  });
  assertEquals("extra_documents_not_filed" in again, false);
});

Deno.test("quote builder: an issue with no extra documents files the quote alone, as before", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const issued = await issueScope(store, client, upload, REPAIR_JOB);
  assertEquals(Object.keys(issued), [
    "version",
    "document",
    "variation",
    "stage",
  ]);
  assertEquals(store.job_documents.map((d) => d.type), ["quote"]);
});

/** The Repairs board as the `pipeline` read serves it, and one job's card. */
async function repairsBoard(client: any) {
  const board: any = await _pipelineForTest(
    client,
    new URLSearchParams("type=repair"),
  );
  const cards = Object.values(board.columns).flat() as any[];
  return { board, card: (jobId: string) => cards.find((c) => c.id === jobId) };
}

/** The money on one job's Repairs card, read fresh from the board. */
async function cardValue(client: any, jobId = REPAIR_JOB) {
  const { board, card } = await repairsBoard(client);
  assertEquals(board.degraded, undefined);
  return card(jobId).value;
}

/** A variation draft on the repair job, issued. */
async function issueVariationOn(
  store: Store,
  client: any,
  upload: (bucket: string, path: string) => void,
  price: number,
  base?: { id: string; chain_id: string },
) {
  const draft = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "variation",
    title: "Extra",
    ...(base ? { chain_id: base.chain_id, base_version_id: base.id } : {}),
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
    { moveRepairStage: stageMover(store, []) },
  );
}

/**
 * A decision through the real dispatch, so the real approval path stamps the
 * row and writes its decision event.
 */
async function decideThroughDispatch(
  client: any,
  variationId: string,
  approved: boolean,
) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("{}"));
  try {
    const response = await dispatchQuoteBuilderAction(
      client,
      "quote_builder_decide_variation",
      new URLSearchParams(),
      { variation_id: variationId, approved },
      ACTOR,
    );
    assertEquals(response.status, 200);
    return await response.json();
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test("quote builder: issuing never writes the job's pricing, and the Repairs card shows the issued total at read time", async () => {
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
      client_name: "Woodvale Resident",
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
      client_name: "Private Client",
      metadata: {},
      pricing_json: {},
      created_at: "2026-10-05T00:00:00Z",
      updated_at: "2026-10-05T00:00:00Z",
    },
    {
      // A repair card typed fencing that no tool has priced.
      id: UNPRICED_FENCE_JOB,
      org_id: ORG,
      job_number: "SWF-26170",
      type: "fencing",
      status: "accepted",
      client_name: "Unpriced Resident",
      metadata: { ses_family: "repair", repair_stage: "scoping" },
      pricing_json: {},
      created_at: "2026-10-06T00:00:00Z",
      updated_at: "2026-10-06T00:00:00Z",
    },
    {
      // Pricing of its own that carries no total: still somebody else's.
      id: TOTAL_LESS_JOB,
      org_id: ORG,
      job_number: "SWR-26180",
      type: "repair",
      status: "accepted",
      client_name: "Terms Only Resident",
      metadata: { repair_stage: "scoping" },
      pricing_json: { payment_terms: "on completion" },
      created_at: "2026-10-07T00:00:00Z",
      updated_at: "2026-10-07T00:00:00Z",
    },
  );
  const pricingWrites: Row[] = [];
  const reads: string[] = [];
  const { client, upload } = makeFakeClient(store, {
    updateError: (table, payload) => {
      if (table === "jobs" && "pricing_json" in payload) {
        pricingWrites.push(payload);
      }
      return null;
    },
    selectError: (table) => {
      reads.push(table);
      return null;
    },
  });
  const job = (id: string) => store.jobs.find((j) => j.id === id)!;
  const pricingBefore = structuredClone(
    store.jobs.map((j) => [j.id, j.pricing_json]),
  );

  const before = await repairsBoard(client);
  assertEquals(before.card(REPAIR_JOB).value, 0);
  const fenceBefore = before.card(FENCE_REPAIR_JOB);
  assertEquals(fenceBefore.value, 6420.5);

  const repair = await issueScope(store, client, upload, REPAIR_JOB);
  const fence = await issueScope(store, client, upload, FENCE_REPAIR_JOB);
  await issueScope(store, client, upload, UNPRICED_FENCE_JOB);
  await issueScope(store, client, upload, TOTAL_LESS_JOB);
  await issueScope(store, client, upload, PRIVATE_JOB);
  assertEquals(repair.version.status, "issued");
  assertEquals(fence.version.status, "issued");
  assertEquals(repair.stage, { moved: true, from: "scoping", to: "quoted" });
  // The reply reports no stored value: there is none.
  assertEquals("job_value" in repair, false);

  // The job's own pricing is exactly what it was on every job, so every path
  // that prices an invoice or gates a quote send from it answers as before.
  assertEquals(pricingWrites, []);
  assertEquals(
    store.jobs.map((j) => [j.id, j.pricing_json]),
    pricingBefore,
  );
  assertEquals(job(REPAIR_JOB).pricing_json, undefined);
  assertEquals(job(FENCE_REPAIR_JOB).updated_at, "2026-10-04T00:00:00Z");

  const after = await repairsBoard(client);
  assertEquals(after.board.degraded, undefined);
  const card = after.card(REPAIR_JOB);
  assertEquals(card.value, 715);
  // The figure is all the builder puts on a card: it gains no field.
  assertEquals(Object.keys(card), Object.keys(before.card(REPAIR_JOB)));
  assertEquals(JSON.stringify(card).includes("cost"), false);

  // A repair card nobody priced takes the builder's figure whatever its type.
  assertEquals(after.card(UNPRICED_FENCE_JOB).value, 715);

  // A card priced by another tool keeps its own figure, keys and all.
  const fenceAfter = after.card(FENCE_REPAIR_JOB);
  assertEquals(fenceAfter.value, 6420.5);
  assertEquals(Object.keys(fenceAfter), Object.keys(fenceBefore));
  assertEquals(after.card(TOTAL_LESS_JOB).value, 0);
  // A job with nothing issued, and a private quote, show nothing from this.
  assertEquals(after.card(LATE_REPAIR_JOB).value, 0);
  assertEquals(after.card(PRIVATE_JOB), undefined);

  // A re-issued scope replaces the figure on the next read.
  await issueScope(store, client, upload, REPAIR_JOB, {
    baseVersionId: repair.version.id,
    chargeLines: [{ ...CHARGE[0], unit_price_ex_gst: 900 }],
  });
  assertEquals(await cardValue(client), 990);

  // Any other board is served without a quote builder read, as before.
  reads.length = 0;
  const fencing: any = await _pipelineForTest(
    client,
    new URLSearchParams("type=fencing"),
  );
  assertEquals(reads.includes("quote_builder_versions"), false);
  const fencingRows = Object.values(fencing.columns).flat() as any[];
  assertEquals(fencingRows.map((row) => [row.id, row.value]), [
    [UNPRICED_FENCE_JOB, 0],
    [FENCE_REPAIR_JOB, 6420.5],
  ]);
});

Deno.test("quote builder: a variation counts on the Repairs card once approved, sent after approval or accepted, and a declined one drops out on the next read", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const variation = (id: string) =>
    store.job_variations.find((v) => v.id === id)!;
  await issueScope(store, client, upload, REPAIR_JOB);
  assertEquals(await cardValue(client), 715);
  // What the ops "send variation" action and the customer's links stamp.
  const send = (id: string) =>
    Object.assign(variation(id), { status: "sent", sent_at: tick() });
  const accept = (id: string) =>
    Object.assign(variation(id), { status: "accepted", accepted_at: tick() });

  // Issued and undecided: the card stays at the scope.
  const approvedOne = (await issueVariationOn(store, client, upload, 200))
    .variation.id as string;
  assertEquals(await cardValue(client), 715);
  const decision = await decideThroughDispatch(client, approvedOne, true);
  assertEquals("job_value" in decision, false);
  assertEquals(await cardValue(client), 935);
  // Sent to the client, then accepted by them: it keeps counting.
  send(approvedOne);
  assertEquals(await cardValue(client), 935);
  accept(approvedOne);
  assertEquals(await cardValue(client), 935);

  // Sent before anyone decided: not counted while it is only sent. Accepted on
  // the client's link: counted, with no office approval at all.
  const neverDecided = (await issueVariationOn(store, client, upload, 1000))
    .variation
    .id as string;
  send(neverDecided);
  assertEquals(await cardValue(client), 935);
  accept(neverDecided);
  assertEquals(await cardValue(client), 2035);

  // Rejected (which stamps approved_at too), then sent anyway: not counted.
  const rejectedOne = (await issueVariationOn(store, client, upload, 3000))
    .variation
    .id as string;
  await decideThroughDispatch(client, rejectedOne, false);
  assert(variation(rejectedOne).approved_at);
  send(rejectedOne);
  assertEquals(await cardValue(client), 2035);
  // The client accepts it all the same: counted, the rejection notwithstanding.
  accept(rejectedOne);
  assertEquals(await cardValue(client), 5335);
  // Back to sent with the rejection still its newest decision: off again.
  send(rejectedOne);
  assertEquals(await cardValue(client), 2035);
  // Re-decided as approved while sent, then sent again: counted from then on.
  await decideThroughDispatch(client, rejectedOne, true);
  send(rejectedOne);
  assertEquals(await cardValue(client), 5335);

  // The customer declines it on their link, with no builder action at all: it
  // is off the card on the very next read. So is a draft, cancelled, pending or
  // rejected one.
  for (
    const status of [
      "declined",
      "draft",
      "cancelled",
      "pending_approval",
      "rejected",
    ]
  ) {
    variation(rejectedOne).status = status;
    assertEquals(await cardValue(client), 2035);
  }
  // Approved with the ops button, outside the builder: on the card at once.
  variation(rejectedOne).status = "approved";
  assertEquals(await cardValue(client), 5335);

  // Nothing above touched the job's own pricing.
  assertEquals(
    store.jobs.find((j) => j.id === REPAIR_JOB)!.pricing_json,
    undefined,
  );
});

Deno.test("quote builder: a rejected or re-issued variation comes off the Repairs card until it is approved again", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store);
  const variation = (id: string) =>
    store.job_variations.find((v) => v.id === id)!;
  await issueScope(store, client, upload, REPAIR_JOB);
  // What the ops "send variation" action stamps, from any status.
  const send = (id: string) =>
    Object.assign(variation(id), { status: "sent", sent_at: tick() });

  // Approved, sent to the client, then rejected in the builder.
  const first = await issueVariationOn(store, client, upload, 200);
  const firstId = first.variation.id as string;
  await decideThroughDispatch(client, firstId, true);
  assertEquals(await cardValue(client), 935);
  send(firstId);
  await decideThroughDispatch(client, firstId, false);
  assertEquals(await cardValue(client), 715);

  // Approved, sent, then re-issued as a new version: the re-issue puts it back
  // to undecided.
  const second = await issueVariationOn(store, client, upload, 400);
  const secondId = second.variation.id as string;
  await decideThroughDispatch(client, secondId, true);
  assertEquals(await cardValue(client), 1155);
  send(secondId);
  const reissued = await issueVariationOn(
    store,
    client,
    upload,
    800,
    second.version,
  );
  assertEquals(reissued.variation.id, secondId);
  assertEquals(variation(secondId).status, "pending_approval");
  assertEquals(await cardValue(client), 715);

  // Ops send the new version without anyone approving it. The old approval is
  // not an approval of this version, so it still does not count.
  send(secondId);
  assertEquals(await cardValue(client), 715);

  // A fresh approval counts the new version at its own amount, and it keeps
  // counting once sent.
  await decideThroughDispatch(client, secondId, true);
  assertEquals(await cardValue(client), 1595);
  send(secondId);
  assertEquals(await cardValue(client), 1595);
});

Deno.test("quote builder: a failed card value read leaves every card as it was and marks the board degraded", async () => {
  const store = seed();
  let failing: string | null = null;
  const { client, upload } = makeFakeClient(store, {
    selectError: (table) =>
      table === failing
        ? { code: "57014", message: "statement timeout" }
        : null,
  });
  await issueScope(store, client, upload, REPAIR_JOB);
  const variationId = (await issueVariationOn(store, client, upload, 200))
    .variation.id as string;
  store.job_variations.find((v) => v.id === variationId)!.status = "approved";
  assertEquals(await cardValue(client), 935);

  const realError = console.error;
  console.error = () => {};
  try {
    // Whichever read fails, no figure is offered: never the scope alone as
    // though the approved variation did not exist.
    for (const table of ["quote_builder_versions", "job_variations"]) {
      failing = table;
      const { board, card } = await repairsBoard(client);
      assertEquals(card(REPAIR_JOB).value, 0);
      assertEquals(board.total, 2);
      assertEquals(board.degraded, true);
      assert(
        board.enrichment_errors.includes("pipeline.quote_builder_value"),
        JSON.stringify(board.enrichment_errors),
      );
      const read = await loadQuoteBuilderCardValues(client, [REPAIR_JOB]);
      assertEquals([read.values.size, read.degraded], [0, true]);
    }
  } finally {
    console.error = realError;
  }

  failing = null;
  assertEquals(await cardValue(client), 935);
});

/**
 * One press of an existing ops-api action through the real request handler,
 * as the ops server key. Every database read is answered from the store by a
 * PostgREST-shaped fetch stub and nothing is written back; a call to anything
 * that is not the database (Xero, the email sender, the CRM) is recorded in
 * `outside` and refused.
 */
async function pressOpsApi(store: Store, action: string, body: Row) {
  const outside: string[] = [];
  const writes: string[] = [];
  const rowMatches = (row: Row, url: URL) => {
    for (const [column, filter] of url.searchParams) {
      if (["select", "order", "limit", "offset", "columns"].includes(column)) {
        continue;
      }
      const value = String(pathValue(row, column));
      const eq = /^eq\.(.*)$/.exec(filter);
      if (eq && value !== eq[1]) return false;
      const among = /^in\.\((.*)\)$/.exec(filter);
      if (
        among &&
        !among[1].split(",").map((v) => v.replace(/"/g, "").trim()).includes(
          value,
        )
      ) return false;
    }
    return true;
  };
  const savedResendKey = Deno.env.get("RESEND_API_KEY");
  Deno.env.set("RESEND_API_KEY", "test-resend-key");
  _setDefaultLegacyKeyProbeForTest(() => Promise.resolve("accepted"));
  const realFetch = globalThis.fetch;
  const realError = console.error;
  console.error = () => {};
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = String(init?.method ?? request?.method ?? "GET")
      .toUpperCase();
    if (!url.pathname.startsWith("/rest/v1/")) {
      outside.push(`${method} ${url.host}${url.pathname}`);
      return Promise.resolve(
        Response.json({ error: "no outside call expected" }, { status: 503 }),
      );
    }
    const table = url.pathname.slice("/rest/v1/".length);
    const one = (new Headers(init?.headers ?? request?.headers).get("accept") ||
      "").includes("vnd.pgrst.object");
    const reply = (rows: Row[]) => {
      if (!one) return Promise.resolve(Response.json(rows));
      if (rows.length === 1) return Promise.resolve(Response.json(rows[0]));
      return Promise.resolve(
        Response.json({ code: "PGRST116", message: "not one row" }, {
          status: 406,
        }),
      );
    };
    if (method !== "GET" && method !== "HEAD") {
      writes.push(`${method} ${table}`);
      return Promise.resolve(Response.json([]));
    }
    return reply(
      (store[table] || []).filter((row) => rowMatches(row, url)).map((
        row,
      ) => ({ ...row })),
    );
  }) as typeof fetch;
  try {
    const response = await _opsApiRequestHandlerForTest(
      new Request(`https://example.invalid/ops-api?action=${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify(body),
      }),
    );
    return {
      status: response.status,
      body: await response.json(),
      outside,
      money_writes: writes.filter((w) =>
        /jobs|xero_invoices|job_documents|quote_revisions/.test(w)
      ),
    };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    _setDefaultLegacyKeyProbeForTest(null);
    if (savedResendKey === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", savedResendKey);
  }
}

Deno.test({
  name:
    "quote builder: after a quote is issued and a variation approved, a no-lines invoice and the quick quote email still refuse the job as they did before",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = seed();
    // The quick quote email reaches its pricing gate only on a job with an
    // address to send to.
    store.jobs.find((j) => j.id === REPAIR_JOB)!.client_email =
      "client@example.invalid";
    const { client, upload } = makeFakeClient(store);
    const press = async () => ({
      invoice: await pressOpsApi(store, "complete_and_invoice", {
        job_id: REPAIR_JOB,
      }),
      quickQuote: await pressOpsApi(store, "send_quick_quote_email", {
        job_id: REPAIR_JOB,
      }),
    });
    // What a job with no pricing is answered before the builder touches it:
    // each path stops at its own pricing gate, with nothing sent or written.
    const noPricing = {
      invoice: {
        status: 500,
        body: {
          error:
            "No pricing data found on this job. Add pricing_json before invoicing.",
        },
        outside: [],
        money_writes: [],
      },
      quickQuote: {
        status: 500,
        body: {
          error:
            "Quote total is zero or missing. Set pricing on the job in the scoping tool before sending.",
        },
        outside: [],
        money_writes: [],
      },
    };
    assertEquals(await press(), noPricing);

    const issued = await issueScope(store, client, upload, REPAIR_JOB);
    assertEquals(issued.version.status, "issued");
    assertEquals(issued.version.charge_total_inc_gst, 715);
    assertEquals(await press(), noPricing);

    const variationId = (await issueVariationOn(store, client, upload, 200))
      .variation
      .id as string;
    await decideThroughDispatch(client, variationId, true);
    assertEquals(await cardValue(client), 935);
    assertEquals(await press(), noPricing);
  },
});

Deno.test("quote builder: a variation issue whose request event cannot be written still issues, and says so", async () => {
  const store = seed();
  const { client, upload } = makeFakeClient(store, {
    insertError: (table, payload) =>
      table === "job_events" && payload.event_type === "variation_requested"
        ? { code: "57014", message: "statement timeout" }
        : null,
  });
  await issueScope(store, client, upload, REPAIR_JOB);
  const draft = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "variation",
    title: "Extra",
    charge_lines: CHARGE,
  }, ACTOR)).version;
  const slot = await quoteBuilderPdfUploadUrl(client, {
    version_id: draft.id,
  }, ACTOR);
  upload("job-pdfs", slot.path);

  const reported: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    reported.push(args);
  };
  let issued: any;
  try {
    issued = await issueQuoteBuilderVersion(
      client,
      { version_id: draft.id, pdf_path: slot.path },
      ACTOR,
      { moveRepairStage: stageMover(store, []) },
    );
  } finally {
    console.error = realError;
  }

  // The issue stands in full.
  assertEquals(issued.version.status, "issued");
  assertEquals(issued.variation.status, "pending_approval");
  assertEquals(
    store.job_events.some((e) => e.event_type === "variation_requested"),
    false,
  );
  // And the lost event is reported with the variation it belongs to.
  const report = reported.find((args) =>
    args.some((a) => String(a).includes("variation_requested"))
  );
  assert(report, "the failed event write was not reported");
  assert(report.includes(issued.variation.id), JSON.stringify(report));
  assert(report.includes("statement timeout"), JSON.stringify(report));
});

Deno.test("quote builder: the pricing settings are a goal, and a quote priced away from them saves and issues unchanged", async () => {
  const store = seed();
  store.quote_builder_settings = [
    { org_id: ORG, setting_key: "insurance_labour_rate_ex_gst", amount: 95 },
    { org_id: ORG, setting_key: "insurance_materials_multiplier", amount: 1.4 },
    { org_id: ORG, setting_key: "target_margin_pct", amount: 33 },
  ];
  const { client, upload } = makeFakeClient(store);
  // Labour charged well under the goal rate, a material sold at cost and one
  // given away: the margin is negative, far from the target.
  const costLines = [
    {
      line_id: "c-lab",
      line_type: "labour",
      description: "Carpenter",
      qty: 10,
      unit: "hr",
      unit_cost_ex_gst: 60,
    },
    {
      line_id: "c-mat",
      line_type: "material",
      description: "Gutter",
      qty: 4,
      unit: "m",
      unit_cost_ex_gst: 50,
    },
  ];
  const chargeLines = [
    {
      line_id: "q-lab",
      description: "Labour",
      qty: 10,
      unit: "hr",
      unit_price_ex_gst: 20,
    },
    {
      line_id: "q-mat",
      description: "Gutter",
      qty: 4,
      unit: "m",
      unit_price_ex_gst: 50,
    },
    {
      line_id: "q-gift",
      description: "Downpipe, no charge",
      qty: 1,
      unit: "ea",
      unit_price_ex_gst: 0,
    },
  ];
  const draft = (await saveQuoteBuilderVersion(client, {
    job_id: REPAIR_JOB,
    kind: "scope",
    cost_lines: costLines,
    charge_lines: chargeLines,
  }, ACTOR)).version;
  const priced = (version: any) =>
    version.charge_lines.map((l: any) => [
      l.line_id,
      l.qty,
      l.unit_price_ex_gst,
      l.line_total_ex_gst,
    ]);
  const asSent = [
    ["q-lab", 10, 20, 200],
    ["q-mat", 4, 50, 200],
    ["q-gift", 1, 0, 0],
  ];
  assertEquals(priced(draft), asSent);
  assertEquals(
    [draft.cost_total_ex_gst, draft.charge_total_ex_gst, draft.margin_ex_gst],
    [800, 400, -400],
  );
  assertEquals(draft.margin_pct, -100);

  const slot = await quoteBuilderPdfUploadUrl(client, {
    version_id: draft.id,
  }, ACTOR);
  upload("job-pdfs", slot.path);
  const issued = await issueQuoteBuilderVersion(
    client,
    { version_id: draft.id, pdf_path: slot.path },
    ACTOR,
    { moveRepairStage: stageMover(store, []) },
  );
  assertEquals(issued.version.status, "issued");
  assertEquals(priced(issued.version), asSent);
  assertEquals(issued.version.margin_ex_gst, -400);
  // The Repairs card figure is the charge lines as sent, not the goal's arithmetic.
  assertEquals(
    (await loadQuoteBuilderCardValues(client, [REPAIR_JOB])).values.get(
      REPAIR_JOB,
    ),
    440,
  );
  // The goal is still what the app is told.
  const opened = await getQuoteBuilderJob(
    client,
    new URLSearchParams(`job_id=${REPAIR_JOB}`),
    ACTOR,
  );
  assertEquals(opened.settings, {
    labour_rate_ex_gst: 95,
    materials_multiplier: 1.4,
    target_margin_pct: 33,
  });
  assertEquals(priced(opened.scope.versions[0]), asSent);
});

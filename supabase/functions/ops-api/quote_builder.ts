// deno-lint-ignore-file no-explicit-any
// Quote builder v1: the server half of Hugo's iPad scoping tool.
//
// Contract (fields, auth, example calls): docs/quote-builder-contract.md.
// Table: quote_builder_versions (20261009120000). The ops-api dispatch owns
// auth (staff JWT or the privileged server key) and passes the verified actor
// in; nothing here trusts a body field for identity.
//
// Writes land in four places and nowhere else: quote_builder_versions (the
// versioned scope with internal costs), job_media (scope photos), job_documents
// (the client quote PDF, never marked sent), job_variations (a variation, from
// its first issue). A private quote mints one `miscellaneous` job. Repair stage
// moves go through the injected `moveRepairStage`, which the dispatch binds to
// the existing update_repair_stage writer, and only ever forward.

import {
  INSURANCE_REPAIR_STAGES,
  insuranceRepairStage,
  isInsuranceRepairFamily,
  loadInsuranceRepairJobDetails,
  loadInsuranceRepairJobIds,
  projectInsuranceRepairPipelineRow,
} from "./insurance_repairs_board.ts";
import { quoteBuilderRunLabel } from "../_shared/quote_builder_run_label.ts";
import { QUOTE_BUILDER_PHOTO_PHASE } from "./makesafe_cycle_evidence.ts";

export const QUOTE_BUILDER_ORG_ID = "00000000-0000-0000-0000-000000000001";
export const QUOTE_BUILDER_PHOTO_BUCKET = "job-photos";
export const QUOTE_BUILDER_PDF_BUCKET = "job-pdfs";
export const QUOTE_BUILDER_MAX_LINES = 200;
export const QUOTE_BUILDER_GST_RATE = 0.1;
const PRIVATE_JOB_TYPE = "miscellaneous";
const PHOTO_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const TERMINAL_JOB_STATUSES = new Set(["cancelled", "lost", "archived"]);
const OPEN_VARIATION_STATUSES = new Set(["pending_approval", "sent"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JOB_SELECT =
  "id, org_id, job_number, type, status, client_name, client_phone, client_email, " +
  "site_address, site_suburb, metadata, created_at, updated_at";

const VERSION_SELECT =
  "id, org_id, job_id, kind, chain_id, version, status, title, narrative, cost_lines, " +
  "charge_lines, cost_total_ex_gst, charge_total_ex_gst, charge_gst, charge_total_inc_gst, " +
  "margin_ex_gst, margin_pct, photo_media_ids, client_snapshot, variation_id, " +
  "client_pdf_document_id, quote_number, created_by, issued_by, issued_at, created_at, updated_at";

export class QuoteBuilderError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface QuoteBuilderActor {
  id: string | null;
  email: string | null;
  orgId: string | null;
}

export type RepairStageMover = (input: {
  jobId: string;
  stage: string;
  operatorEmail: string | null;
}) => Promise<unknown>;

export type VariationDecider = (input: {
  variationId: string;
  approved: boolean;
  notes: string | null;
  userId: string | null;
}) => Promise<unknown>;

function fail(code: string, message: string, status = 400): never {
  throw new QuoteBuilderError(code, message, status);
}

function readError(label: string, error: any): never {
  throw new QuoteBuilderError(
    "read_failed",
    `${label}: ${error?.message || error}`,
    500,
  );
}

function text(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  if (!out) return null;
  return out.length > max ? out.slice(0, max) : out;
}

function uuidOrNull(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  return UUID_RE.test(v) ? v : null;
}

function requireUuid(value: unknown, field: string): string {
  const v = uuidOrNull(value);
  if (!v) fail("invalid_input", `${field} must be a uuid`);
  return v;
}

function isoOrNull(value: unknown): string | null {
  const raw = text(value, 40);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function cents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function amount(value: unknown, field: string, index: number): number {
  const n = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 10_000_000) {
    fail(
      "invalid_line",
      `line ${index + 1}: ${field} must be a number from 0 to 10,000,000`,
    );
  }
  return n;
}

function lineId(raw: any, prefix: string): string {
  const given = text(raw?.line_id, 64);
  return given ?? `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function linesInput(raw: unknown, field: string): any[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("invalid_input", `${field} must be an array`);
  if (raw.length > QUOTE_BUILDER_MAX_LINES) {
    fail(
      "invalid_input",
      `${field} holds at most ${QUOTE_BUILDER_MAX_LINES} lines`,
    );
  }
  return raw;
}

function uniqueLineIds(lines: any[], field: string) {
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.line_id)) {
      fail("invalid_line", `${field}: line_id ${line.line_id} is used twice`);
    }
    seen.add(line.line_id);
  }
}

/** Internal cost lines. Totals are always recomputed here, never trusted. */
export function normaliseCostLines(raw: unknown): any[] {
  const lines = linesInput(raw, "cost_lines").map((line: any, i: number) => {
    const description = text(line?.description, 2000);
    if (!description) {
      fail("invalid_line", `cost line ${i + 1}: description required`);
    }
    const qty = amount(line?.qty ?? 1, "qty", i);
    const unitCost = amount(line?.unit_cost_ex_gst ?? 0, "unit_cost_ex_gst", i);
    return {
      line_id: lineId(line, "c"),
      description,
      qty,
      unit: text(line?.unit, 32),
      unit_cost_ex_gst: cents(unitCost),
      line_total_ex_gst: cents(qty * unitCost),
      supplier_or_trade: text(line?.supplier_or_trade, 200),
    };
  });
  uniqueLineIds(lines, "cost_lines");
  return lines;
}

/** Client charge lines. GST is 10% unless the line says it does not apply. */
export function normaliseChargeLines(raw: unknown): any[] {
  const lines = linesInput(raw, "charge_lines").map((line: any, i: number) => {
    const description = text(line?.description, 2000);
    if (!description) {
      fail("invalid_line", `charge line ${i + 1}: description required`);
    }
    const qty = amount(line?.qty ?? 1, "qty", i);
    const unitPrice = amount(
      line?.unit_price_ex_gst ?? 0,
      "unit_price_ex_gst",
      i,
    );
    const gstApplies = line?.gst_applies !== false;
    const lineTotal = cents(qty * unitPrice);
    const gst = gstApplies ? cents(lineTotal * QUOTE_BUILDER_GST_RATE) : 0;
    return {
      line_id: lineId(line, "q"),
      description,
      qty,
      unit: text(line?.unit, 32),
      unit_price_ex_gst: cents(unitPrice),
      gst_applies: gstApplies,
      line_total_ex_gst: lineTotal,
      gst_ex: gst,
      line_total_inc_gst: cents(lineTotal + gst),
    };
  });
  uniqueLineIds(lines, "charge_lines");
  return lines;
}

export function quoteBuilderTotals(costLines: any[], chargeLines: any[]) {
  const sum = (lines: any[], key: string) =>
    cents(lines.reduce((acc, line) => acc + Number(line[key] || 0), 0));
  const cost = sum(costLines, "line_total_ex_gst");
  const charge = sum(chargeLines, "line_total_ex_gst");
  const gst = sum(chargeLines, "gst_ex");
  const margin = cents(charge - cost);
  return {
    cost_total_ex_gst: cost,
    charge_total_ex_gst: charge,
    charge_gst: gst,
    charge_total_inc_gst: cents(charge + gst),
    margin_ex_gst: margin,
    margin_pct: charge > 0 ? cents((margin / charge) * 100) : null,
  };
}

/** SWR-26123-Q2 for scope version 2; SWR-26123-V1.2 for variation 1 version 2. */
export function quoteBuilderQuoteNumber(
  jobNumber: string | null,
  kind: string,
  version: number,
  variationNumber?: number | null,
): string {
  const base = jobNumber || "JOB";
  return kind === "variation"
    ? `${base}-V${variationNumber || 1}.${version}`
    : `${base}-Q${version}`;
}

/** Forward-only: a card already at or past the target stays where it is. */
export function repairStageMoveDecision(current: string, target: string) {
  const order = INSURANCE_REPAIR_STAGES as readonly string[];
  const from = order.indexOf(current);
  const to = order.indexOf(target);
  if (to < 0) return { move: false, reason: "unknown_target_stage" };
  if (from >= to) return { move: false, reason: "already_past_stage" };
  return { move: true, reason: null };
}

/** Repair-family jobs (as the Repairs board reads them) and private quotes. */
export function quoteBuilderJobLane(row: any): "repair" | "private" | null {
  if (isInsuranceRepairFamily(row)) return "repair";
  if (String(row?.type || "").toLowerCase() === PRIVATE_JOB_TYPE) {
    return "private";
  }
  return null;
}

function assertActorOrg(actor: QuoteBuilderActor, job: any) {
  if (actor.orgId && String(job.org_id || "") !== actor.orgId) {
    fail("job_not_found", "Job not found", 404);
  }
}

async function loadJob(client: any, jobId: string, actor: QuoteBuilderActor) {
  const { data: job, error } = await client.from("jobs")
    .select(JOB_SELECT)
    .eq("id", jobId)
    .eq("org_id", QUOTE_BUILDER_ORG_ID)
    .maybeSingle();
  if (error) readError("job read failed", error);
  if (!job) fail("job_not_found", "Job not found", 404);
  assertActorOrg(actor, job);
  const { data: detail, error: detailError } = await client
    .from("makesafe_job_details")
    .select(
      "job_id, report_type, external_ref, requesting_company_slug, requesting_company_name, " +
        "makesafe_companies:requesting_company_id(slug, name)",
    )
    .eq("job_id", jobId)
    .maybeSingle();
  if (detailError) readError("job detail read failed", detailError);
  const authorityRow = { ...job, makesafe_details: detail || null };
  return {
    job,
    detail: detail || null,
    lane: quoteBuilderJobLane(authorityRow),
    authorityRow,
  };
}

function jobHeader(job: any, detail: any, lane: string | null) {
  const meta = job?.metadata && typeof job.metadata === "object"
    ? job.metadata
    : {};
  const repair = lane === "repair"
    ? projectInsuranceRepairPipelineRow(job, detail || undefined)
    : null;
  return {
    id: job.id,
    job_number: job.job_number ?? null,
    type: job.type ?? null,
    lane,
    status: job.status ?? null,
    repair_stage: repair ? repair.repair_stage : null,
    client_name: job.client_name ?? null,
    client_phone: job.client_phone ?? null,
    client_email: job.client_email ?? null,
    site_address: job.site_address ?? null,
    site_suburb: job.site_suburb ?? null,
    builder_name: repair?.builder_company_name ?? null,
    builder_work_order: repair?.builder_work_order_ref ?? null,
    builder_purchase_order: repair?.builder_po_number ?? null,
    category: meta?.quote_builder?.category ?? null,
    created_at: job.created_at ?? null,
  };
}

function versionView(row: any) {
  return {
    ...row,
    cost_lines: Array.isArray(row.cost_lines) ? row.cost_lines : [],
    charge_lines: Array.isArray(row.charge_lines) ? row.charge_lines : [],
    photo_media_ids: Array.isArray(row.photo_media_ids)
      ? row.photo_media_ids
      : [],
  };
}

async function loadVersions(client: any, jobIds: string[]) {
  if (!jobIds.length) return [];
  const out: any[] = [];
  for (let i = 0; i < jobIds.length; i += 50) {
    const { data, error } = await client.from("quote_builder_versions")
      .select(VERSION_SELECT)
      .in("job_id", jobIds.slice(i, i + 50))
      .order("version", { ascending: true });
    if (error) readError("quote builder versions read failed", error);
    out.push(...(data || []));
  }
  return out;
}

function latestScopeSummary(versions: any[], jobId: string) {
  const scope = versions.filter((v) =>
    v.job_id === jobId && v.kind === "scope"
  );
  if (!scope.length) return null;
  const latest = scope.reduce((a, b) => (b.version > a.version ? b : a));
  return {
    version_id: latest.id,
    version: latest.version,
    status: latest.status,
    charge_total_inc_gst: Number(latest.charge_total_inc_gst),
    updated_at: latest.updated_at,
  };
}

// ── GET quote_builder_list_jobs ─────────────────────────────────────────────

export async function listQuoteBuilderJobs(
  client: any,
  params: URLSearchParams,
  actor: QuoteBuilderActor,
) {
  const lane = (params.get("lane") || "repair").toLowerCase();
  const limit = Math.min(Math.max(Number(params.get("limit")) || 100, 1), 200);
  if (lane !== "repair" && lane !== "private") {
    fail("invalid_input", "lane must be repair or private");
  }

  if (lane === "private") {
    const { data, error } = await client.from("jobs")
      .select(JOB_SELECT)
      .eq("org_id", QUOTE_BUILDER_ORG_ID)
      .eq("type", PRIVATE_JOB_TYPE)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) readError("private jobs read failed", error);
    const rows = (data || []).filter((job: any) =>
      !TERMINAL_JOB_STATUSES.has(String(job.status || "")) &&
      (!actor.orgId || String(job.org_id || "") === actor.orgId)
    );
    const versions = await loadVersions(client, rows.map((j: any) => j.id));
    return {
      lane,
      jobs: rows.map((job: any) => ({
        ...jobHeader(job, null, "private"),
        latest_scope: latestScopeSummary(versions, job.id),
      })),
    };
  }

  const stagesParam = params.get("stages");
  const stages = (stagesParam ? stagesParam.split(",") : ["wo_in", "scoping"])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const stage of stages) {
    if (!(INSURANCE_REPAIR_STAGES as readonly string[]).includes(stage)) {
      fail("invalid_input", `unknown repair stage '${stage}'`);
    }
  }

  let ids: string[];
  try {
    ids = await loadInsuranceRepairJobIds(client, QUOTE_BUILDER_ORG_ID);
  } catch (error) {
    readError("repair jobs read failed", error);
  }
  const jobs: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { data, error } = await client.from("jobs")
      .select(JOB_SELECT)
      .in("id", ids.slice(i, i + 50))
      .eq("org_id", QUOTE_BUILDER_ORG_ID);
    if (error) readError("repair jobs read failed", error);
    jobs.push(...(data || []));
  }
  const { details } = await loadInsuranceRepairJobDetails(
    client,
    jobs.map((j) => j.id),
  );
  const rows = jobs
    .filter((job) =>
      !TERMINAL_JOB_STATUSES.has(String(job.status || "")) &&
      (!actor.orgId || String(job.org_id || "") === actor.orgId)
    )
    .map((job) => ({ job, detail: details.get(job.id) || null }))
    .filter(({ job }) => stages.includes(insuranceRepairStage(job)))
    .sort((a, b) =>
      String(b.job.created_at || "").localeCompare(
        String(a.job.created_at || ""),
      )
    )
    .slice(0, limit);
  const versions = await loadVersions(client, rows.map((r) => r.job.id));
  return {
    lane,
    stages,
    jobs: rows.map(({ job, detail }) => ({
      ...jobHeader(job, detail, "repair"),
      latest_scope: latestScopeSummary(versions, job.id),
    })),
  };
}

// ── GET quote_builder_get_job ───────────────────────────────────────────────

export async function getQuoteBuilderJob(
  client: any,
  params: URLSearchParams,
  actor: QuoteBuilderActor,
) {
  const jobId = requireUuid(
    params.get("job_id") || params.get("jobId"),
    "job_id",
  );
  const { job, detail, lane } = await loadJob(client, jobId, actor);
  if (!lane) {
    fail(
      "job_not_quotable",
      "Only repair and private jobs open in the quote builder",
      409,
    );
  }

  const versions = (await loadVersions(client, [jobId])).map(versionView);
  const { data: variationRows, error: variationError } = await client
    .from("job_variations")
    .select("id, variation_number, status, amount, cost_estimate, approved_at")
    .eq("job_id", jobId);
  if (variationError) readError("variations read failed", variationError);
  const variationById = new Map<string, any>(
    (variationRows || []).map((v: any) => [v.id, v]),
  );

  const chains = new Map<string, any[]>();
  for (const v of versions.filter((v) => v.kind === "variation")) {
    chains.set(v.chain_id, [...(chains.get(v.chain_id) || []), v]);
  }
  const variations = [...chains.entries()].map(([chainId, list]) => {
    const variationId = list.map((v) => v.variation_id).find(Boolean) || null;
    const row = variationId ? variationById.get(variationId) : null;
    return {
      chain_id: chainId,
      variation_id: variationId,
      variation_number: row?.variation_number ?? null,
      variation_status: row?.status ?? null,
      versions: list,
    };
  });

  const { data: media, error: mediaError } = await client.from("job_media")
    .select(
      "id, storage_url, thumbnail_url, label, taken_at, created_at, phase, type",
    )
    .eq("job_id", jobId)
    .eq("phase", QUOTE_BUILDER_PHOTO_PHASE)
    .eq("type", "photo")
    .order("created_at", { ascending: true });
  if (mediaError) readError("photos read failed", mediaError);

  const { data: docs, error: docsError } = await client.from("job_documents")
    .select(
      "id, quote_number, storage_url, pdf_url, file_name, metadata, created_at",
    )
    .eq("job_id", jobId)
    .eq("type", "quote")
    .order("created_at", { ascending: true });
  if (docsError) readError("documents read failed", docsError);

  return {
    job: jobHeader(job, detail, lane),
    scope: {
      chain_id: jobId,
      versions: versions.filter((v) => v.kind === "scope"),
    },
    variations,
    photos: (media || []).map((m: any) => ({
      id: m.id,
      url: m.storage_url,
      thumbnail_url: m.thumbnail_url ?? null,
      caption: m.label ?? null,
      taken_at: m.taken_at ?? null,
      created_at: m.created_at ?? null,
    })),
    documents: (docs || []).map((d: any) => ({
      id: d.id,
      quote_number: d.quote_number ?? null,
      url: d.pdf_url || d.storage_url || null,
      file_name: d.file_name ?? null,
      version_id: d.metadata?.quote_builder_version_id ?? null,
      created_at: d.created_at ?? null,
    })),
  };
}

// ── POST quote_builder_create_private_job ───────────────────────────────────

export async function createQuoteBuilderPrivateJob(
  client: any,
  body: any,
  actor: QuoteBuilderActor,
) {
  const requestId = requireUuid(body?.request_id, "request_id");
  const clientName = text(body?.client_name, 200);
  if (!clientName) fail("invalid_input", "client_name required");
  const category =
    text(body?.category, 64)?.toLowerCase().replace(/[^a-z0-9_]+/g, "_") ||
    "private_renovation";

  const existing = await findPrivateJobByRequest(client, requestId);
  if (existing) {
    return { created: false, job: jobHeader(existing, null, "private") };
  }

  const { data: job, error } = await client.from("jobs")
    .insert({
      org_id: QUOTE_BUILDER_ORG_ID,
      type: PRIVATE_JOB_TYPE,
      status: "draft",
      client_name: clientName,
      client_phone: text(body?.client_phone, 64),
      client_email: text(body?.client_email, 200),
      site_address: text(body?.site_address, 300),
      site_suburb: text(body?.site_suburb, 100),
      notes: text(body?.notes, 4000),
      created_by: actor.id,
      metadata: {
        quote_builder: {
          category,
          request_id: requestId,
          created_via: "quote_builder",
          created_by_user_id: actor.id,
        },
      },
    })
    .select(JOB_SELECT)
    .single();
  if (error) {
    const again = await findPrivateJobByRequest(client, requestId);
    if (again) {
      return { created: false, job: jobHeader(again, null, "private") };
    }
    readError("private job create failed", error);
  }

  await client.from("job_events").insert({
    job_id: job.id,
    user_id: actor.id,
    event_type: "quote_builder_private_job_created",
    detail_json: {
      category,
      request_id: requestId,
      operator_email: actor.email,
    },
  }).then(() => {}, () => {});

  return { created: true, job: jobHeader(job, null, "private") };
}

async function findPrivateJobByRequest(client: any, requestId: string) {
  const { data, error } = await client.from("jobs")
    .select(JOB_SELECT)
    .eq("org_id", QUOTE_BUILDER_ORG_ID)
    .eq("type", PRIVATE_JOB_TYPE)
    .eq("metadata->quote_builder->>request_id", requestId)
    .limit(1);
  if (error) readError("private job lookup failed", error);
  return (data || [])[0] || null;
}

// ── POST quote_builder_save ─────────────────────────────────────────────────

async function chainVersions(client: any, jobId: string, chainId: string) {
  const { data, error } = await client.from("quote_builder_versions")
    .select(VERSION_SELECT)
    .eq("job_id", jobId)
    .eq("chain_id", chainId)
    .order("version", { ascending: false })
    .limit(1);
  if (error) readError("quote builder chain read failed", error);
  return (data || [])[0] || null;
}

async function validatePhotoIds(client: any, jobId: string, raw: unknown) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    fail("invalid_input", "photo_media_ids must be an array");
  }
  const ids = [
    ...new Set(raw.map((id) => requireUuid(id, "photo_media_ids[]"))),
  ];
  if (ids.length > QUOTE_BUILDER_MAX_LINES) {
    fail("invalid_input", "too many photos");
  }
  if (!ids.length) return [];
  const { data, error } = await client.from("job_media")
    .select("id, job_id, phase")
    .in("id", ids);
  if (error) readError("photo read failed", error);
  const owned = new Set(
    (data || []).filter((m: any) =>
      m.job_id === jobId && m.phase === QUOTE_BUILDER_PHOTO_PHASE
    ).map((m: any) => m.id),
  );
  const foreign = ids.filter((id) => !owned.has(id));
  if (foreign.length) {
    fail(
      "photo_not_on_job",
      `photos not among this job's quote builder photos: ${foreign.join(", ")}`,
      409,
    );
  }
  return ids;
}

function clientSnapshot(header: any) {
  return {
    client_name: header.client_name,
    client_phone: header.client_phone,
    client_email: header.client_email,
    site_address: header.site_address,
    site_suburb: header.site_suburb,
    builder_name: header.builder_name,
    builder_work_order: header.builder_work_order,
    builder_purchase_order: header.builder_purchase_order,
    job_number: header.job_number,
  };
}

export async function saveQuoteBuilderVersion(
  client: any,
  body: any,
  actor: QuoteBuilderActor,
) {
  const jobId = requireUuid(body?.job_id, "job_id");
  const kind = String(body?.kind || "scope").toLowerCase();
  if (kind !== "scope" && kind !== "variation") {
    fail("invalid_input", "kind must be scope or variation");
  }
  const { job, detail, lane } = await loadJob(client, jobId, actor);
  if (!lane) {
    fail(
      "job_not_quotable",
      "Only repair and private jobs can be quoted in the quote builder",
      409,
    );
  }

  const baseVersionId = body?.base_version_id == null
    ? null
    : requireUuid(body.base_version_id, "base_version_id");
  let chainId: string;
  let latest: any = null;
  if (kind === "scope") {
    chainId = jobId;
    latest = await chainVersions(client, jobId, chainId);
  } else if (body?.chain_id) {
    chainId = requireUuid(body.chain_id, "chain_id");
    latest = await chainVersions(client, jobId, chainId);
    if (!latest || latest.kind !== "variation") {
      fail(
        "chain_not_found",
        "No variation with that chain_id on this job",
        404,
      );
    }
  } else {
    chainId = crypto.randomUUID();
  }

  if ((latest?.id ?? null) !== baseVersionId) {
    fail(
      "stale_version",
      "This scope changed since it was loaded; reload it and save again. Nothing was written.",
      409,
    );
  }

  const costLines = normaliseCostLines(body?.cost_lines);
  const chargeLines = normaliseChargeLines(body?.charge_lines);
  const photoIds = await validatePhotoIds(client, jobId, body?.photo_media_ids);
  const fields = {
    title: text(body?.title, 300),
    narrative: text(body?.narrative, 20000),
    cost_lines: costLines,
    charge_lines: chargeLines,
    ...quoteBuilderTotals(costLines, chargeLines),
    photo_media_ids: photoIds,
    client_snapshot: clientSnapshot(jobHeader(job, detail, lane)),
  };

  if (latest && latest.status === "draft") {
    let update = client.from("quote_builder_versions")
      .update({ ...fields, quote_number: null })
      .eq("id", latest.id)
      .eq("status", "draft");
    if (latest.updated_at) update = update.eq("updated_at", latest.updated_at);
    const { data, error } = await update.select(VERSION_SELECT).maybeSingle();
    if (error) readError("quote builder save failed", error);
    if (!data) {
      fail(
        "stale_version",
        "This scope changed while saving; reload it and save again.",
        409,
      );
    }
    return { version: versionView(data) };
  }

  const { data, error } = await client.from("quote_builder_versions")
    .insert({
      org_id: QUOTE_BUILDER_ORG_ID,
      job_id: jobId,
      kind,
      chain_id: chainId,
      version: latest ? Number(latest.version) + 1 : 1,
      status: "draft",
      created_by: actor.id,
      ...fields,
    })
    .select(VERSION_SELECT)
    .single();
  if (error) {
    if (error.code === "23505") {
      fail(
        "stale_version",
        "Someone else saved this scope first; reload it and save again.",
        409,
      );
    }
    readError("quote builder save failed", error);
  }
  return { version: versionView(data) };
}

// ── Photos ──────────────────────────────────────────────────────────────────

export async function quoteBuilderPhotoUploadUrl(
  client: any,
  body: any,
  actor: QuoteBuilderActor,
) {
  const jobId = requireUuid(body?.job_id, "job_id");
  const contentType = String(body?.content_type || "").toLowerCase();
  const ext = PHOTO_CONTENT_TYPES[contentType];
  if (!ext) {
    fail(
      "invalid_input",
      "content_type must be image/jpeg, image/png or image/webp",
    );
  }
  const { lane } = await loadJob(client, jobId, actor);
  if (!lane) {
    fail(
      "job_not_quotable",
      "Only repair and private jobs take quote builder photos",
      409,
    );
  }

  const path = `${jobId}/quote-builder/${crypto.randomUUID()}.${ext}`;
  const bucket = client.storage.from(QUOTE_BUILDER_PHOTO_BUCKET);
  const { data, error } = await bucket.createSignedUploadUrl(path);
  if (error) readError("photo upload slot failed", error);
  const { data: urlData } = bucket.getPublicUrl(path);
  return {
    path,
    signed_url: data.signedUrl,
    token: data.token,
    public_url: urlData.publicUrl,
  };
}

async function storageObjectExists(
  client: any,
  bucketName: string,
  path: string,
) {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  const { data, error } = await client.storage.from(bucketName)
    .list(dir, { search: name, limit: 10 });
  if (error) readError("storage check failed", error);
  return (data || []).some((o: any) => o?.name === name);
}

export async function quoteBuilderPhotoRegister(
  client: any,
  body: any,
  actor: QuoteBuilderActor,
) {
  const jobId = requireUuid(body?.job_id, "job_id");
  const path = String(body?.path || "");
  const expected = new RegExp(
    `^${jobId}/quote-builder/[0-9a-f-]{36}\\.(jpg|png|webp)$`,
    "i",
  );
  if (!expected.test(path)) {
    fail(
      "invalid_input",
      "path must be the one quote_builder_photo_upload_url returned",
    );
  }
  const { lane } = await loadJob(client, jobId, actor);
  if (!lane) {
    fail(
      "job_not_quotable",
      "Only repair and private jobs take quote builder photos",
      409,
    );
  }
  if (!(await storageObjectExists(client, QUOTE_BUILDER_PHOTO_BUCKET, path))) {
    fail(
      "upload_missing",
      "The photo is not in storage yet; upload it, then register it.",
      409,
    );
  }
  const { data: urlData } = client.storage.from(QUOTE_BUILDER_PHOTO_BUCKET)
    .getPublicUrl(path);

  const { data: existing, error: existingError } = await client.from(
    "job_media",
  )
    .select("id, storage_url, label")
    .eq("job_id", jobId)
    .eq("storage_url", urlData.publicUrl)
    .limit(1);
  if (existingError) readError("photo read failed", existingError);
  if (existing?.[0]) {
    return {
      photo: {
        id: existing[0].id,
        url: existing[0].storage_url,
        caption: existing[0].label ?? null,
      },
    };
  }

  const { data, error } = await client.from("job_media")
    .insert({
      job_id: jobId,
      phase: QUOTE_BUILDER_PHOTO_PHASE,
      type: "photo",
      storage_url: urlData.publicUrl,
      label: text(body?.caption, 500),
      uploaded_by: actor.id,
      taken_at: isoOrNull(body?.taken_at),
    })
    .select("id, storage_url, label")
    .single();
  if (error) readError("photo register failed", error);
  return {
    photo: { id: data.id, url: data.storage_url, caption: data.label ?? null },
  };
}

export async function quoteBuilderPhotoCaption(
  client: any,
  body: any,
  actor: QuoteBuilderActor,
) {
  const photoId = requireUuid(body?.photo_id, "photo_id");
  const { data: photo, error } = await client.from("job_media")
    .select("id, job_id, phase")
    .eq("id", photoId)
    .maybeSingle();
  if (error) readError("photo read failed", error);
  if (!photo || photo.phase !== QUOTE_BUILDER_PHOTO_PHASE) {
    fail("photo_not_found", "Photo not found", 404);
  }
  const { lane } = await loadJob(client, photo.job_id, actor);
  if (!lane) {
    fail(
      "job_not_quotable",
      "Only repair and private jobs take quote builder photos",
      409,
    );
  }
  const { data, error: updateError } = await client.from("job_media")
    .update({ label: text(body?.caption, 500) })
    .eq("id", photoId)
    .select("id, storage_url, label")
    .single();
  if (updateError) readError("caption update failed", updateError);
  return {
    photo: { id: data.id, url: data.storage_url, caption: data.label ?? null },
  };
}

// ── Client quote PDF and issue ──────────────────────────────────────────────

async function loadDraftVersion(client: any, versionId: string) {
  const { data, error } = await client.from("quote_builder_versions")
    .select(VERSION_SELECT)
    .eq("id", versionId)
    .maybeSingle();
  if (error) readError("quote builder version read failed", error);
  if (!data) fail("version_not_found", "Version not found", 404);
  if (data.status !== "draft") {
    fail(
      "version_frozen",
      "This version is already issued; save a new version first.",
      409,
    );
  }
  return data;
}

async function variationRowForChain(client: any, version: any) {
  const { data, error } = await client.from("quote_builder_versions")
    .select("variation_id")
    .eq("job_id", version.job_id)
    .eq("chain_id", version.chain_id)
    .not("variation_id", "is", null)
    .limit(1);
  if (error) readError("variation chain read failed", error);
  const variationId = (data || [])[0]?.variation_id || null;
  if (!variationId) return null;
  const { data: row, error: rowError } = await client.from("job_variations")
    .select("id, job_id, variation_number, status")
    .eq("id", variationId)
    .maybeSingle();
  if (rowError) readError("variation read failed", rowError);
  return row || null;
}

async function nextVariationNumber(client: any, jobId: string) {
  const { data, error } = await client.from("job_variations")
    .select("variation_number")
    .eq("job_id", jobId);
  if (error) readError("variation numbers read failed", error);
  return (data || []).reduce(
    (max: number, v: any) => Math.max(max, Number(v.variation_number) || 0),
    0,
  ) + 1;
}

function pdfPathFor(version: any, quoteNumber: string) {
  const safe = quoteNumber.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${version.job_id}/quote-builder/${version.id}/${safe}.pdf`;
}

async function plannedQuoteNumber(client: any, version: any, job: any) {
  if (version.kind !== "variation") {
    return quoteBuilderQuoteNumber(
      job.job_number,
      "scope",
      Number(version.version),
    );
  }
  const existing = await variationRowForChain(client, version);
  const number = existing?.variation_number ??
    await nextVariationNumber(client, version.job_id);
  return quoteBuilderQuoteNumber(
    job.job_number,
    "variation",
    Number(version.version),
    number,
  );
}

export async function quoteBuilderPdfUploadUrl(
  client: any,
  body: any,
  actor: QuoteBuilderActor,
) {
  const versionId = requireUuid(body?.version_id, "version_id");
  const version = await loadDraftVersion(client, versionId);
  const { job } = await loadJob(client, version.job_id, actor);
  const quoteNumber = await plannedQuoteNumber(client, version, job);
  const path = pdfPathFor(version, quoteNumber);

  // Stamp the number on the draft so issue can prove the PDF prints the number
  // it will be filed under. A later save clears it (the PDF is then stale).
  let stamp = client.from("quote_builder_versions")
    .update({ quote_number: quoteNumber })
    .eq("id", versionId)
    .eq("status", "draft");
  if (version.updated_at) stamp = stamp.eq("updated_at", version.updated_at);
  const { data: stamped, error: stampError } = await stamp.select(
    "id, updated_at",
  ).maybeSingle();
  if (stampError) readError("quote number stamp failed", stampError);
  if (!stamped) {
    fail(
      "stale_version",
      "This version changed; reload it and try again.",
      409,
    );
  }

  const bucket = client.storage.from(QUOTE_BUILDER_PDF_BUCKET);
  const { data, error } = await bucket.createSignedUploadUrl(path, {
    upsert: true,
  });
  if (error) readError("PDF upload slot failed", error);
  const { data: urlData } = bucket.getPublicUrl(path);
  return {
    path,
    signed_url: data.signedUrl,
    token: data.token,
    public_url: urlData.publicUrl,
    quote_number: quoteNumber,
  };
}

async function moveStageForward(
  client: any,
  jobId: string,
  target: string,
  actor: QuoteBuilderActor,
  moveRepairStage: RepairStageMover,
) {
  const { lane, authorityRow } = await loadJob(client, jobId, actor);
  if (lane !== "repair") return { moved: false, reason: "not_a_repair_job" };
  const current = insuranceRepairStage(authorityRow);
  const decision = repairStageMoveDecision(current, target);
  if (!decision.move) {
    return { moved: false, reason: decision.reason, from: current, to: target };
  }
  try {
    await moveRepairStage({ jobId, stage: target, operatorEmail: actor.email });
  } catch (error) {
    console.error(
      "[ops-api] quote builder repair stage move failed:",
      (error as Error)?.message || error,
    );
    return {
      moved: false,
      reason: "stage_write_failed",
      from: current,
      to: target,
      error: (error as Error)?.message || String(error),
    };
  }
  return { moved: true, from: current, to: target };
}

export async function issueQuoteBuilderVersion(
  client: any,
  body: any,
  actor: QuoteBuilderActor,
  deps: { moveRepairStage: RepairStageMover },
) {
  const versionId = requireUuid(body?.version_id, "version_id");
  const version = await loadDraftVersion(client, versionId);
  const { job, lane } = await loadJob(client, version.job_id, actor);
  if (!lane) {
    fail("job_not_quotable", "Only repair and private jobs can be quoted", 409);
  }
  if (
    !Array.isArray(version.charge_lines) || version.charge_lines.length === 0
  ) {
    fail(
      "no_charge_lines",
      "A quote needs at least one charge line before it is issued",
      409,
    );
  }
  if (!version.quote_number) {
    fail(
      "pdf_not_prepared",
      "Ask quote_builder_pdf_upload_url for this version, upload the PDF, then issue.",
      409,
    );
  }
  const planned = await plannedQuoteNumber(client, version, job);
  if (planned !== version.quote_number) {
    fail(
      "quote_number_changed",
      `The quote number is now ${planned}; ask for a new PDF upload slot and re-render.`,
      409,
    );
  }
  const path = pdfPathFor(version, version.quote_number);
  if (String(body?.pdf_path || "") !== path) {
    fail(
      "invalid_input",
      "pdf_path must be the path quote_builder_pdf_upload_url returned",
    );
  }
  if (!(await storageObjectExists(client, QUOTE_BUILDER_PDF_BUCKET, path))) {
    fail(
      "upload_missing",
      "The PDF is not in storage yet; upload it, then issue.",
      409,
    );
  }
  const { data: urlData } = client.storage.from(QUOTE_BUILDER_PDF_BUCKET)
    .getPublicUrl(path);

  // Variation: decide the job_variations row BEFORE any write, so a decided
  // variation refuses with nothing written.
  let variationRow: any = null;
  if (version.kind === "variation") {
    variationRow = await variationRowForChain(client, version);
    if (
      variationRow &&
      !OPEN_VARIATION_STATUSES.has(String(variationRow.status || ""))
    ) {
      fail(
        "variation_decided",
        `Variation ${variationRow.variation_number} is already ${variationRow.status}; start a new variation instead.`,
        409,
      );
    }
  }

  const totals = {
    charge_total_ex_gst: Number(version.charge_total_ex_gst),
    charge_gst: Number(version.charge_gst),
    charge_total_inc_gst: Number(version.charge_total_inc_gst),
  };
  const fileName = path.slice(path.lastIndexOf("/") + 1);

  // Retry-safe without a cross-call transaction: the PDF document is found by
  // its version before a new one is filed (and refreshed to this attempt's
  // number and lines), and a new variation row is linked to the draft before
  // the freeze, so a retry after a partial failure reuses both instead of
  // filing a second document or a second variation. Each chain keeps one live
  // document under its own run_label; the chain's earlier one is retired.
  const docFields = {
    version: Number(version.version),
    quote_number: version.quote_number,
    pdf_url: urlData.publicUrl,
    storage_url: urlData.publicUrl,
    file_name: fileName,
    data_snapshot_json: {
      source: "quote_builder",
      quote_builder_version_id: version.id,
      kind: version.kind,
      title: version.title,
      charge_lines: version.charge_lines,
      totals,
      client: version.client_snapshot,
    },
  };
  const docColumns = "id, quote_number, pdf_url, storage_url";
  const findVersionDoc = async () => {
    const { data, error } = await client.from("job_documents")
      .select(docColumns)
      .eq("job_id", version.job_id)
      .eq("type", "quote")
      .eq("metadata->>quote_builder_version_id", version.id)
      .limit(1);
    if (error) readError("quote document read failed", error);
    return (data || [])[0] || null;
  };
  let doc = await findVersionDoc();
  if (doc) {
    const { data, error } = await client.from("job_documents")
      .update(docFields)
      .eq("id", doc.id)
      .select(docColumns)
      .maybeSingle();
    if (error) readError("quote document write failed", error);
    doc = data || doc;
  } else {
    const runLabel = quoteBuilderRunLabel(version.chain_id);
    const { error: retireError } = await client.from("job_documents")
      .update({ superseded_at: new Date().toISOString() })
      .eq("job_id", version.job_id)
      .eq("type", "quote")
      .eq("run_label", runLabel)
      .not("sent_to_client", "is", true)
      .is("superseded_at", null)
      .is("accepted_at", null)
      .is("declined_at", null);
    if (retireError) readError("quote document retire failed", retireError);
    const { data, error: docError } = await client.from("job_documents")
      .insert({
        ...docFields,
        job_id: version.job_id,
        type: "quote",
        run_label: runLabel,
        visible_to_trades: false,
        created_by: actor.id,
        uploaded_by: actor.id,
        metadata: {
          source: "quote_builder",
          quote_builder_version_id: version.id,
          kind: version.kind,
          chain_id: version.chain_id,
        },
      })
      .select(docColumns)
      .single();
    if (docError) {
      doc = docError.code === "23505" ? await findVersionDoc() : null;
      if (!doc) readError("quote document write failed", docError);
    } else {
      doc = data;
    }
  }

  let variationResult: any = null;
  let createdVariationId: string | null = null;
  let draftUpdatedAt = version.updated_at;
  if (version.kind === "variation") {
    const description = text(version.title, 500) ||
      text(version.charge_lines[0]?.description, 500) || "Variation";
    const variationFields = {
      description,
      reason: text(version.narrative, 4000),
      amount: totals.charge_total_inc_gst,
      gst_included: true,
      cost_estimate: Number(version.cost_total_ex_gst),
      status: "pending_approval",
      needs_approval: true,
      updated_at: new Date().toISOString(),
    };
    if (variationRow) {
      const { data, error } = await client.from("job_variations")
        .update(variationFields)
        .eq("id", variationRow.id)
        .in("status", [...OPEN_VARIATION_STATUSES])
        .select("id, variation_number, status, amount")
        .maybeSingle();
      if (error) readError("variation update failed", error);
      if (!data) {
        fail(
          "variation_decided",
          "The variation was decided while issuing; reload.",
          409,
        );
      }
      variationResult = data;
    } else {
      const variationNumber = await nextVariationNumber(client, version.job_id);
      const { data, error } = await client.from("job_variations")
        .insert({
          org_id: QUOTE_BUILDER_ORG_ID,
          job_id: version.job_id,
          variation_number: variationNumber,
          created_by: actor.id,
          ...variationFields,
        })
        .select("id, variation_number, status, amount")
        .single();
      if (error) readError("variation create failed", error);
      variationResult = data;
      createdVariationId = data.id;
    }
    if (version.variation_id !== variationResult.id) {
      let link = client.from("quote_builder_versions")
        .update({ variation_id: variationResult.id })
        .eq("id", version.id)
        .eq("status", "draft");
      if (version.updated_at) link = link.eq("updated_at", version.updated_at);
      const { data: linked, error: linkError } = await link.select(
        "id, updated_at",
      ).maybeSingle();
      if (linkError || !linked) {
        if (createdVariationId) {
          const { error: discardError } = await client.from("job_variations")
            .delete()
            .eq("id", createdVariationId)
            .eq("status", "pending_approval");
          if (discardError) {
            console.error(
              "[quote_builder] unlinked variation not discarded",
              createdVariationId,
              discardError.message,
            );
          }
        }
        if (linkError) readError("variation link failed", linkError);
        fail(
          "stale_version",
          "This version changed while issuing; reload it and issue again.",
          409,
        );
      }
      draftUpdatedAt = linked.updated_at;
    }
    await client.from("job_events").insert({
      job_id: version.job_id,
      user_id: actor.id,
      event_type: "variation_requested",
      detail_json: {
        source: "quote_builder",
        variation_id: variationResult.id,
        quote_builder_version_id: version.id,
        quote_number: version.quote_number,
        amount_inc_gst: totals.charge_total_inc_gst,
        operator_email: actor.email,
      },
    }).then(() => {}, () => {});
  }

  let freeze = client.from("quote_builder_versions")
    .update({
      status: "issued",
      issued_at: new Date().toISOString(),
      issued_by: actor.id,
      client_pdf_document_id: doc.id,
      variation_id: variationResult?.id ?? null,
    })
    .eq("id", version.id)
    .eq("status", "draft");
  if (draftUpdatedAt) freeze = freeze.eq("updated_at", draftUpdatedAt);
  const { data: frozen, error: freezeError } = await freeze.select(
    VERSION_SELECT,
  ).maybeSingle();
  if (freezeError) readError("quote builder issue failed", freezeError);
  if (!frozen) {
    fail(
      "stale_version",
      "This version changed while issuing; reload it and issue again (the filed PDF document is reused).",
      409,
    );
  }

  await client.from("job_events").insert({
    job_id: version.job_id,
    user_id: actor.id,
    event_type: "quote_builder_issued",
    detail_json: {
      quote_builder_version_id: version.id,
      kind: version.kind,
      version: version.version,
      quote_number: version.quote_number,
      document_id: doc.id,
      charge_total_inc_gst: totals.charge_total_inc_gst,
      operator_email: actor.email,
    },
  }).then(() => {}, () => {});

  const stage = await moveStageForward(
    client,
    version.job_id,
    version.kind === "variation" ? "variation" : "quoted",
    actor,
    deps.moveRepairStage,
  );

  return {
    version: versionView(frozen),
    document: {
      id: doc.id,
      quote_number: doc.quote_number,
      url: doc.pdf_url || doc.storage_url,
    },
    variation: variationResult,
    stage,
  };
}

// ── POST quote_builder_decide_variation ─────────────────────────────────────

export async function decideQuoteBuilderVariation(
  client: any,
  body: any,
  actor: QuoteBuilderActor,
  deps: {
    decideVariation: VariationDecider;
    moveRepairStage: RepairStageMover;
  },
) {
  const variationId = requireUuid(body?.variation_id, "variation_id");
  if (typeof body?.approved !== "boolean") {
    fail("invalid_input", "approved must be true or false");
  }
  const approved = body.approved as boolean;
  const { data: variation, error } = await client.from("job_variations")
    .select("id, job_id, variation_number, status")
    .eq("id", variationId)
    .maybeSingle();
  if (error) readError("variation read failed", error);
  if (!variation) fail("variation_not_found", "Variation not found", 404);
  const { lane } = await loadJob(client, variation.job_id, actor);
  if (!lane) {
    fail(
      "job_not_quotable",
      "Only repair and private job variations are decided here",
      409,
    );
  }
  if (!OPEN_VARIATION_STATUSES.has(String(variation.status || ""))) {
    fail(
      "variation_decided",
      `Variation ${variation.variation_number} is already ${variation.status}`,
      409,
    );
  }

  await deps.decideVariation({
    variationId,
    approved,
    notes: text(body?.notes, 2000),
    userId: actor.id,
  });

  const expected = approved ? "approved" : "rejected";
  const { data: decided, error: decidedError } = await client.from(
    "job_variations",
  )
    .select("status")
    .eq("id", variationId)
    .maybeSingle();
  if (decidedError) readError("variation read failed", decidedError);
  if (decided?.status !== expected) {
    fail(
      "variation_decision_not_recorded",
      `Variation ${variation.variation_number} was not recorded as ${expected}; it reads ${
        decided?.status ?? "missing"
      }. Try again.`,
      409,
    );
  }

  const stage = approved
    ? await moveStageForward(
      client,
      variation.job_id,
      "approved",
      actor,
      deps.moveRepairStage,
    )
    : { moved: false, reason: "variation_rejected" };
  return { approved, variation_id: variationId, stage };
}

export const QUOTE_BUILDER_ACTIONS = new Set([
  "quote_builder_list_jobs",
  "quote_builder_get_job",
  "quote_builder_create_private_job",
  "quote_builder_save",
  "quote_builder_photo_upload_url",
  "quote_builder_photo_register",
  "quote_builder_photo_caption",
  "quote_builder_pdf_upload_url",
  "quote_builder_issue",
  "quote_builder_decide_variation",
]);

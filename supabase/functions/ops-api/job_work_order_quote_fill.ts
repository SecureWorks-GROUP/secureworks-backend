// deno-lint-ignore-file no-explicit-any
// Fills a job work order draft from the accepted quote. Contract:
// docs/quote-work-order-lines-v1.md. The lines come from the pure builder
// (quote_work_order_lines.ts); this module owns the reads and the one write.
//
// The write rule, in full:
// - Only a job work order (kind 'job') in status 'draft' is ever written. An
//   approved work order is sealed and never touched (the database seal refuses
//   it too).
// - Only an untouched draft is filled: no scope_items and no agreed_labour_ex.
//   Anything a person has typed into the draft is left alone.
// - The update is guarded by the draft's updated_at as read, so a save that
//   lands between the read and the fill wins and the fill writes nothing.
// - scope_items gets the builder's lines and agreed_labour_ex the counted
//   total. When no line could be counted, agreed_labour_ex stays empty for the
//   approver to set.

import {
  buildQuoteWorkOrderLines,
  FENCE_LABOUR_COST_ITEM_KEYS,
  type QuoteCostTable,
  type QuoteWorkOrderLines,
} from "./quote_work_order_lines.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same cap as the job work order draft edit (job_work_orders.ts).
const MAX_FILLED_SCOPE_ITEMS = 200;

const FILL_WO_COLUMNS =
  "id, org_id, job_id, wo_number, kind, status, scope_items, special_instructions, scheduled_date, site_address, agreed_labour_ex, approved_at, approved_by, approved_via, sealed_content_hash, origin, created_at, updated_at";

export class QuoteFillError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type QuoteSource =
  | "accepted_revision"
  | "frozen_revision"
  | "live_pricing";

export type JobQuoteWorkOrderLines = {
  job: {
    id: string;
    job_number: string | null;
    type: string | null;
    status: string | null;
  };
  quote: {
    source: QuoteSource;
    scope_revision_id: string | null;
    frozen_at: string | null;
    flags: string[];
  };
  result: QuoteWorkOrderLines;
};

export type QuoteFillOutcome = {
  filled: boolean;
  reason:
    | "filled"
    | "not_eligible"
    | "no_draft"
    | "sealed"
    | "draft_already_has_lines"
    | "no_quote_lines"
    | "draft_changed";
  work_order: any | null;
  scope_revision_id?: string | null;
  needs_review?: boolean;
};

const FILL_JOB_TYPES = new Set(["fencing", "patio"]);

/** A draft nobody has written lines or an agreed amount into. */
export function jobWorkOrderDraftIsUntouched(wo: any): boolean {
  if (!wo || wo.kind !== "job" || wo.status !== "draft") return false;
  const items = Array.isArray(wo.scope_items) ? wo.scope_items : [];
  return items.length === 0 &&
    (wo.agreed_labour_ex === null || wo.agreed_labour_ex === undefined);
}

function parsePricing(textValue: unknown): Record<string, any> | null {
  if (typeof textValue !== "string" || !textValue.trim()) return null;
  try {
    const parsed = JSON.parse(textValue);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function readJobForQuote(client: any, jobRef: string) {
  const ref = String(jobRef || "").trim();
  if (!ref) throw new QuoteFillError(400, "job_id_required", "job_id required");
  const select =
    "id, org_id, job_number, type, status, expected_costs, pricing_json";
  const byId = UUID_RE.test(ref);
  const find = async (column: "id" | "job_number", value: string) => {
    const { data, error } = await client.from("jobs").select(select)
      .eq(column, value).limit(1);
    if (error) {
      throw new QuoteFillError(
        500,
        "job_unreadable",
        "The job could not be read",
      );
    }
    return Array.isArray(data) ? data[0] ?? null : data ?? null;
  };
  let job = await find(byId ? "id" : "job_number", ref);
  if (!job && !byId && ref !== ref.toUpperCase()) {
    job = await find("job_number", ref.toUpperCase());
  }
  if (!job) {
    throw new QuoteFillError(404, "job_not_found", `Job ${ref} not found`);
  }
  return job;
}

// The accepted quote: the scope revision frozen at acceptance
// (jobs.expected_costs.scope_revision_id), else the newest frozen revision,
// else the job's live pricing (flagged quote_not_frozen).
async function readAcceptedQuote(client: any, job: any) {
  const flags: string[] = [];
  const acceptedId = typeof job?.expected_costs?.scope_revision_id === "string"
    ? job.expected_costs.scope_revision_id
    : null;
  const { data, error } = await client.from("scope_revisions")
    .select("id, revision_number, status, frozen_at, pricing_canonical_text")
    .eq("job_id", job.id)
    .eq("status", "frozen")
    .order("revision_number", { ascending: false })
    .limit(20);
  if (error) {
    throw new QuoteFillError(
      500,
      "quote_unreadable",
      "The job's frozen quote could not be read",
    );
  }
  const revisions = Array.isArray(data) ? data : [];
  const accepted = acceptedId
    ? revisions.find((r: any) => r.id === acceptedId) ?? null
    : null;
  const newest = revisions
    .slice()
    .sort((a: any, b: any) =>
      Number(b.revision_number || 0) - Number(a.revision_number || 0)
    )[0] ?? null;
  for (
    const [revision, source] of [
      [accepted, "accepted_revision"],
      [newest, "frozen_revision"],
    ] as const
  ) {
    if (!revision) continue;
    const pricing = parsePricing(revision.pricing_canonical_text);
    if (pricing) {
      return {
        pricing,
        quote: {
          source: source as QuoteSource,
          scope_revision_id: String(revision.id),
          frozen_at: revision.frozen_at ?? null,
          flags,
        },
      };
    }
    if (!flags.includes("frozen_quote_unreadable")) {
      flags.push("frozen_quote_unreadable");
    }
  }
  flags.push("quote_not_frozen");
  return {
    pricing: job.pricing_json && typeof job.pricing_json === "object"
      ? job.pricing_json
      : {},
    quote: {
      source: "live_pricing" as QuoteSource,
      scope_revision_id: null,
      frozen_at: null,
      flags,
    },
  };
}

/** The fencing labour rates from the scoping tool's cost table. A read
 *  fault throws: an unreadable table must never read as "no rates". */
export async function readFenceLabourCostTable(
  client: any,
  orgId: string | null,
): Promise<QuoteCostTable> {
  let query = client.from("scope_tool_defaults")
    .select("item_key, default_cost_rate")
    .eq("scope_tool", "fence-designer")
    .in("item_key", [...FENCE_LABOUR_COST_ITEM_KEYS]);
  if (orgId) query = query.eq("org_id", orgId);
  const { data, error } = await query;
  if (error) {
    throw new QuoteFillError(
      500,
      "cost_table_unreadable",
      "The scoping tool's cost table could not be read",
    );
  }
  const table: Record<string, number> = {};
  for (const row of Array.isArray(data) ? data : []) {
    const rate = Number(row?.default_cost_rate);
    if (typeof row?.item_key === "string" && Number.isFinite(rate)) {
      table[row.item_key] = rate;
    }
  }
  return table;
}

async function linesForJob(
  client: any,
  job: any,
): Promise<JobQuoteWorkOrderLines> {
  const { pricing, quote } = await readAcceptedQuote(client, job);
  const costTable = String(job.type || "") === "fencing"
    ? await readFenceLabourCostTable(client, job.org_id ?? null)
    : {};
  const result = buildQuoteWorkOrderLines({
    jobType: job.type,
    pricing,
    costTable,
  });
  if (quote.flags.length > 0) result.needs_review = true;
  return {
    job: {
      id: String(job.id),
      job_number: job.job_number ?? null,
      type: job.type ?? null,
      status: job.status ?? null,
    },
    quote,
    result,
  };
}

/** Read-only preview: the work order lines the accepted quote gives a job. */
export async function previewQuoteWorkOrderLines(
  client: any,
  jobRef: string,
): Promise<JobQuoteWorkOrderLines> {
  const job = await readJobForQuote(client, jobRef);
  return await linesForJob(client, job);
}

/** Fills the job's untouched draft from its accepted quote. Never touches an
 *  approved work order or a draft someone has written into. */
export async function fillJobWorkOrderDraftFromQuote(
  client: any,
  jobId: string,
): Promise<QuoteFillOutcome> {
  const job = await readJobForQuote(client, jobId);
  if (!FILL_JOB_TYPES.has(String(job.type || ""))) {
    return { filled: false, reason: "not_eligible", work_order: null };
  }
  const { data: rows, error } = await client.from("work_orders")
    .select(FILL_WO_COLUMNS)
    .eq("job_id", job.id)
    .eq("kind", "job")
    .in("status", ["draft", "approved"]);
  if (error) {
    throw new QuoteFillError(
      500,
      "work_order_unreadable",
      "The job's work order could not be read",
    );
  }
  const list = Array.isArray(rows) ? rows : [];
  const sealed = list.find((r: any) => r.status === "approved");
  if (sealed) return { filled: false, reason: "sealed", work_order: sealed };
  const draft = list.find((r: any) => r.status === "draft");
  if (!draft) return { filled: false, reason: "no_draft", work_order: null };
  if (!jobWorkOrderDraftIsUntouched(draft)) {
    return {
      filled: false,
      reason: "draft_already_has_lines",
      work_order: draft,
    };
  }

  const { quote, result } = await linesForJob(client, job);
  if (result.lines.length === 0) {
    return {
      filled: false,
      reason: "no_quote_lines",
      work_order: draft,
      scope_revision_id: quote.scope_revision_id,
    };
  }
  const patch: Record<string, unknown> = {
    scope_items: result.lines.slice(0, MAX_FILLED_SCOPE_ITEMS),
  };
  if (result.agreed_labour_ex !== null) {
    patch.agreed_labour_ex = result.agreed_labour_ex;
  }
  let update = client.from("work_orders").update(patch)
    .eq("id", draft.id)
    .eq("kind", "job")
    .eq("status", "draft");
  if (draft.updated_at) update = update.eq("updated_at", draft.updated_at);
  const { data: written, error: writeError } = await update
    .select(FILL_WO_COLUMNS)
    .maybeSingle();
  if (writeError) {
    throw new QuoteFillError(
      500,
      "draft_not_filled",
      "The draft work order could not be filled from the quote",
    );
  }
  if (!written) {
    return { filled: false, reason: "draft_changed", work_order: draft };
  }
  // Ids and counts only: job_events is readable by every signed-in user of
  // the org, trades included, so no amount goes here (job-work-orders-v1).
  try {
    await client.from("job_events").insert({
      job_id: job.id,
      event_type: "job_work_order_draft_filled_from_quote",
      detail_json: {
        work_order_id: written.id,
        wo_number: written.wo_number,
        scope_revision_id: quote.scope_revision_id,
        quote_source: quote.source,
        line_count: result.lines.length,
        needs_review: result.needs_review,
      },
    });
  } catch {
    // The fill stands even when its event cannot be written.
  }
  return {
    filled: true,
    reason: "filled",
    work_order: written,
    scope_revision_id: quote.scope_revision_id,
    needs_review: result.needs_review,
  };
}

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
// - scope_items gets the builder's lines and agreed_labour_ex the quote's own
//   labour figure. When the quote has none, agreed_labour_ex stays empty for
//   the approver to set.
// - The same write names the frozen scope revision the lines came from
//   (quote_filled_scope_revision_id, 20261020120000).
// - The same write stamps quote_filled_at, which marks the draft as the
//   fill's own: only such a draft, never edited since (hand_edited_at, set by
//   the database), is issued automatically (job_work_orders.ts,
//   20261016120000_job_work_order_auto_issue.sql). A draft someone already
//   edited by hand is filled without the stamp and waits for the approver.

import {
  buildQuoteWorkOrderLines,
  FENCE_LABOUR_COST_ITEM_KEYS,
  QUOTE_RESULT_FLAGS,
  type QuoteCostTable,
  type QuoteWorkOrderLines,
} from "./quote_work_order_lines.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same cap as the job work order draft edit (job_work_orders.ts).
const MAX_FILLED_SCOPE_ITEMS = 200;

const FILL_WO_COLUMNS =
  "id, org_id, job_id, wo_number, kind, status, scope_items, special_instructions, scheduled_date, site_address, agreed_labour_ex, approved_at, approved_by, approved_via, sealed_content_hash, origin, quote_filled_at, quote_filled_scope_revision_id, hand_edited_at, created_at, updated_at";

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
  | "revision_at_acceptance"
  | "latest_frozen_revision";

/** Open, approved job statuses. Mirrors the database's
 *  job_work_order_open_statuses() (20261012130000): the jobs a draft is opened
 *  for, and the only jobs whose work order is issued automatically
 *  (job_work_orders.ts re-exports it). A job in one of them has moved past
 *  quoted. */
export const JOB_WORK_ORDER_OPEN_STATUSES: ReadonlySet<string> = new Set([
  "accepted",
  "partially_accepted",
  "approvals",
  "deposit",
  "awaiting_deposit",
  "processing",
  "order_materials",
  "awaiting_supplier",
  "order_confirmed",
  "schedule_install",
  "scheduled",
  "in_progress",
  "rectification",
]);

export type JobQuoteWorkOrderLines = {
  job: {
    id: string;
    job_number: string | null;
    type: string | null;
    status: string | null;
  };
  quote: {
    /** null when the job has no accepted quote revision to read. */
    source: QuoteSource | null;
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
    | "no_accepted_quote"
    | "no_quote_lines"
    | "draft_changed";
  work_order: any | null;
  scope_revision_id?: string | null;
  needs_review?: boolean;
};

const FILL_JOB_TYPES = new Set(["fencing", "patio"]);

// Result flags the builder already puts on exactly the lines they concern.
const LINE_SCOPED_RESULT_FLAGS: ReadonlySet<string> = new Set([
  QUOTE_RESULT_FLAGS.labourDiffersFromQuote,
  QUOTE_RESULT_FLAGS.ratesChangedSinceQuote,
]);

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

async function readJobForQuote(client: any, jobId: string) {
  const id = String(jobId || "").trim();
  if (!UUID_RE.test(id)) {
    throw new QuoteFillError(400, "job_id_required", "job_id required");
  }
  const { data, error } = await client.from("jobs")
    .select(
      "id, org_id, job_number, type, status, accepted_at, expected_costs",
    )
    .eq("id", id)
    .limit(1);
  if (error) {
    throw new QuoteFillError(
      500,
      "job_unreadable",
      "The job could not be read",
    );
  }
  const job = Array.isArray(data) ? data[0] ?? null : data ?? null;
  if (!job) {
    throw new QuoteFillError(404, "job_not_found", `Job ${id} not found`);
  }
  return job;
}

const REVISION_COLUMNS =
  "id, revision_number, status, frozen_at, pricing_canonical_text";

async function readRevisions(
  client: any,
  query: (q: any) => any,
): Promise<any[]> {
  const { data, error } = await query(
    client.from("scope_revisions").select(REVISION_COLUMNS),
  );
  if (error) {
    throw new QuoteFillError(
      500,
      "quote_unreadable",
      "The job's frozen quote could not be read",
    );
  }
  return Array.isArray(data) ? data : [];
}

// The accepted quote, and only the accepted quote: never a revision frozen
// after acceptance, never the job's live pricing. The rule is the one the
// expected-costs freeze uses (_shared/expected_costs/expected_costs_freeze.ts):
// the revision recorded at acceptance (jobs.expected_costs.scope_revision_id),
// read whether it is still frozen or was superseded since; without one, the
// latest revision frozen at or before jobs.accepted_at, frozen or superseded.
// With neither, and only then: a job that has moved past quoted (it is in an
// open status, JOB_WORK_ORDER_OPEN_STATUSES) counts as accepted at its latest
// frozen tool quote, the newest revision still in status 'frozen', whenever it
// was frozen (captain, 16 Oct 2026). A superseded revision never counts under
// this rule. A status change on the Ops screen to 'accepted' stamps
// jobs.accepted_at; one straight to another open status (deposit, scheduled,
// ...) does not, so this is how those jobs' tool quote counts. With no frozen
// revision there is no accepted quote, flagged no_accepted_quote, and the
// draft is not filled: the office fills it by hand.
async function readAcceptedQuote(client: any, job: any): Promise<{
  pricing: Record<string, any> | null;
  quote: JobQuoteWorkOrderLines["quote"];
}> {
  const flags: string[] = [];
  const none = () => ({
    pricing: null,
    quote: {
      source: null,
      scope_revision_id: null,
      frozen_at: null,
      flags: [...flags, "no_accepted_quote"],
    },
  });
  const use = (revision: any, source: QuoteSource) => {
    const pricing = parsePricing(revision.pricing_canonical_text);
    if (!pricing) {
      flags.push("frozen_quote_unreadable");
      return none();
    }
    return {
      pricing,
      quote: {
        source,
        scope_revision_id: String(revision.id),
        frozen_at: revision.frozen_at ?? null,
        flags,
      },
    };
  };
  const acceptedId = typeof job?.expected_costs?.scope_revision_id === "string"
    ? job.expected_costs.scope_revision_id
    : null;
  if (acceptedId) {
    const [accepted] = await readRevisions(client, (q) =>
      q.eq("job_id", job.id)
        .eq("id", acceptedId)
        .in("status", ["frozen", "superseded"])
        .limit(1));
    if (accepted) return use(accepted, "accepted_revision");
  }
  const acceptedAt = typeof job?.accepted_at === "string" && job.accepted_at
    ? job.accepted_at
    : null;
  if (acceptedAt) {
    const [atAcceptance] = await readRevisions(
      client,
      (q) =>
        q.eq("job_id", job.id)
          .in("status", ["frozen", "superseded"])
          .lte("frozen_at", acceptedAt)
          .order("frozen_at", { ascending: false })
          .limit(1),
    );
    if (atAcceptance) return use(atAcceptance, "revision_at_acceptance");
    return none();
  }
  if (acceptedId) return none();
  if (!JOB_WORK_ORDER_OPEN_STATUSES.has(String(job?.status || ""))) {
    return none();
  }
  const [latestFrozen] = await readRevisions(
    client,
    (q) =>
      q.eq("job_id", job.id)
        .eq("status", "frozen")
        .order("frozen_at", { ascending: false, nullsFirst: false })
        .limit(1),
  );
  if (latestFrozen) return use(latestFrozen, "latest_frozen_revision");
  return none();
}

/** The fencing labour rates from the scoping tool's cost table, and the keys
 *  changed after the quote was frozen (or with no change time to compare). A
 *  read fault throws: an unreadable table must never read as "no rates". */
export async function readFenceLabourCostTable(
  client: any,
  orgId: string | null,
  frozenAt: string | null,
): Promise<{ rates: QuoteCostTable; changedSinceQuote: string[] }> {
  let query = client.from("scope_tool_defaults")
    .select("item_key, default_cost_rate, last_updated_at")
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
  const frozenMs = Date.parse(String(frozenAt ?? ""));
  const rates: Record<string, number> = {};
  const changed = new Set<string>();
  for (const row of Array.isArray(data) ? data : []) {
    const rate = Number(row?.default_cost_rate);
    if (typeof row?.item_key !== "string" || !Number.isFinite(rate)) continue;
    rates[row.item_key] = rate;
    const updatedMs = Date.parse(String(row.last_updated_at ?? ""));
    if (
      !Number.isFinite(frozenMs) || !Number.isFinite(updatedMs) ||
      updatedMs > frozenMs
    ) {
      changed.add(row.item_key);
    }
  }
  return { rates, changedSinceQuote: [...changed] };
}

async function linesForJob(
  client: any,
  job: any,
): Promise<JobQuoteWorkOrderLines> {
  const { pricing, quote } = await readAcceptedQuote(client, job);
  // No accepted quote, nothing to price: the cost table is not read.
  const table = pricing && String(job.type || "") === "fencing"
    ? await readFenceLabourCostTable(
      client,
      job.org_id ?? null,
      quote.frozen_at,
    )
    : { rates: {}, changedSinceQuote: [] };
  const result = buildQuoteWorkOrderLines({
    jobType: job.type,
    pricing,
    costTable: table.rates,
    ratesChangedSinceQuote: table.changedSinceQuote,
  });
  // The quote's and the result's review flags ride on every line, so they
  // stay on the stored draft for the approver (scope_items past description,
  // qty and unit are office-only). A line-scoped flag stays on the lines the
  // builder put it on.
  const reviewFlags = [
    ...quote.flags,
    ...result.flags.filter((f) => !LINE_SCOPED_RESULT_FLAGS.has(f)),
  ];
  if (reviewFlags.length > 0) result.needs_review = true;
  for (const line of result.lines) {
    for (const flag of reviewFlags) {
      if (!line.flags.includes(flag)) line.flags.push(flag);
    }
    if (reviewFlags.length > 0) line.needs_review = true;
  }
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
  jobId: string,
): Promise<JobQuoteWorkOrderLines> {
  const job = await readJobForQuote(client, jobId);
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
  if (quote.source === null) {
    return {
      filled: false,
      reason: "no_accepted_quote",
      work_order: draft,
      scope_revision_id: null,
    };
  }
  if (result.lines.length === 0) {
    await recordQuoteHasNoLines(client, job.id, draft, quote.scope_revision_id);
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
  // The database refuses this stamp on a draft edited by hand (its
  // special instructions, say), so such a draft is filled without it.
  if (!draft.hand_edited_at) {
    patch.quote_filled_at = new Date().toISOString();
  }
  // The revision the lines came from, on the row itself (Dispatch S6, R7;
  // 20261020120000): also on a draft edited by hand, since its lines still
  // come from this revision. A refill of a cleared draft may name a newer
  // revision; the database allows the change only from a cleared draft.
  if (quote.scope_revision_id && UUID_RE.test(quote.scope_revision_id)) {
    patch.quote_filled_scope_revision_id = quote.scope_revision_id;
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
  const { error: eventError } = await client.from("job_events").insert({
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
  if (eventError) {
    // The fill stands even when its event cannot be written.
    console.error(
      "[ops-api] job work order: fill event not written:",
      job.id,
      eventError.message,
    );
  }
  return {
    filled: true,
    reason: "filled",
    work_order: written,
    scope_revision_id: quote.scope_revision_id,
    needs_review: result.needs_review,
  };
}

export const QUOTE_HAS_NO_LINES_EVENT = "job_work_order_quote_has_no_lines";

/** Records, once per draft and quote revision, that the accepted quote gave
 *  the draft nothing to copy, so the office has a stored signal that the
 *  labour must be entered by hand. The sweep retries an untouched draft every
 *  two minutes, so an earlier event for the same pair is read first, and an
 *  unreadable read writes nothing rather than risk a flood. Ids only:
 *  job_events is readable by every signed-in user of the org, trades
 *  included. Never throws. */
async function recordQuoteHasNoLines(
  client: any,
  jobId: string,
  draft: any,
  scopeRevisionId: string | null,
): Promise<void> {
  try {
    const { data: earlier, error: readError } = await client.from("job_events")
      .select("id, detail_json")
      .eq("job_id", jobId)
      .eq("event_type", QUOTE_HAS_NO_LINES_EVENT);
    if (readError) {
      console.error(
        "[ops-api] job work order: no-lines event not checked:",
        jobId,
        readError.message,
      );
      return;
    }
    const seen = (Array.isArray(earlier) ? earlier : []).some((e: any) =>
      e?.detail_json?.work_order_id === draft.id &&
      (e?.detail_json?.scope_revision_id ?? null) === (scopeRevisionId ?? null)
    );
    if (seen) return;
    const { error } = await client.from("job_events").insert({
      job_id: jobId,
      event_type: QUOTE_HAS_NO_LINES_EVENT,
      detail_json: {
        work_order_id: draft.id,
        wo_number: draft.wo_number ?? null,
        scope_revision_id: scopeRevisionId ?? null,
      },
    });
    if (error) {
      console.error(
        "[ops-api] job work order: no-lines event not written:",
        jobId,
        error.message,
      );
    }
  } catch (e) {
    console.error(
      "[ops-api] job work order: no-lines event failed:",
      jobId,
      (e as Error)?.message,
    );
  }
}

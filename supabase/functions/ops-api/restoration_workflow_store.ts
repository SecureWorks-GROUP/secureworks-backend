// deno-lint-ignore-file no-explicit-any
// The ops-api Supabase client is intentionally untyped at this boundary,
// matching the sibling store modules.
//
// Restoration work on the SES board: reads and writes
// (docs/restoration-workflow-v1.md). Rules live in restoration_workflow.ts;
// this file only loads the card, applies a rule and stores the result.
//
// What it writes, and nothing else:
//   - jobs.metadata.restoration   the PRICE-FREE record: mode, limits, and per
//                                 quote revision its number, status, who sent
//                                 and decided, its document and content hash
//                                 (compare-and-set on jobs.updated_at)
//   - job_documents               the quote PDF and its priced content, type
//                                 'other', never visible to trades
//   - job_events                  one row per move, no amounts
//
// A trade can read jobs.metadata and job_events, and a trade sees no money:
// that is why the lines and totals live only on the office-only document. Do
// not move a price, a total or the PDF's link into metadata or an event.
//
// What it never does: it never sends anything to a builder, never touches
// Xero, never writes an invoice obligation, a docket, a board stage or a
// make-safe substatus. The hand-off to money is an object in a READ; a person
// or the terminal passes it to prepare_ses_invoice_obligation, where every
// existing guard and the human approval still run.

import { canonicalSesFamilyFromCard } from "./ses_family_matrix.ts";
import {
  renderRestorationQuotePdf,
  type RestorationQuoteDocumentInput,
} from "./restoration_quote_render.ts";
import {
  approvedQuote,
  attachRestorationQuoteDocument,
  authorityLimitCheck,
  decideRestorationQuote,
  describeRestorationPlan,
  markRestorationQuoteSent,
  readRestorationPlan,
  restorationScopeText,
  restorationInvoiceHandoff,
  type RestorationPlan,
  restorationPlanForStorage,
  type RestorationQuote,
  restorationQuoteCanonicalText,
  restorationQuoteContent,
  RestorationWorkflowError,
  saveRestorationQuote,
  setRestorationPlan,
} from "./restoration_workflow.ts";

export interface RestorationCaller {
  /** Staff email on a signed-in call; the named operator on a server call. */
  label: string | null;
  userId: string | null;
  orgId: string | null;
}

export interface RestorationStoreDeps {
  persistPdf: (args: {
    jobId: string;
    fileName: string;
    bytes: Uint8Array;
  }) => Promise<{ publicUrl: string; storagePath: string }>;
  renderQuote?: (
    input: RestorationQuoteDocumentInput,
  ) => Promise<{ bytes: Uint8Array; fileName: string }>;
  now?: () => string;
}

/** job_documents.metadata marker: this 'other' row is a restoration quote. */
export const RESTORATION_QUOTE_DOCUMENT_MARKER = "quote" as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JOB_COLUMNS =
  "id, org_id, job_number, type, status, client_name, site_address, site_suburb, notes, metadata, updated_at";

function fail(code: string, message: string, status = 400): never {
  throw new RestorationWorkflowError(code, message, status);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function readFailed(what: string, error: any): never {
  fail(
    "restoration_read_failed",
    `${what} could not be read (${
      text(error?.message) || "unknown database error"
    }). Nothing was changed.`,
    503,
  );
}

/**
 * A restoration card on the SES board: `makesafe` (how intake mints one) or
 * the older `insurance` storage shape, whose family is restoration by the one
 * canonical reader. Anything else is refused; a repair job has the Repairs
 * board and the quote builder, and a make-safe has no quote stage.
 */
export function isRestorationCard(job: any): boolean {
  const type = text(job?.type).toLowerCase();
  if (type !== "makesafe" && type !== "insurance") return false;
  const metadata = record(job?.metadata);
  return canonicalSesFamilyFromCard({
    makesafe_job_family: metadata.makesafe_job_family,
    insurance_job_type: metadata.insurance_job_type,
  }) === "restoration";
}

interface LoadedRestorationJob {
  job: any;
  detail: any | null;
  scopeText: string;
  plan: RestorationPlan;
  stored: boolean;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

/** The content hash of every quote revision on the plan, by revision. */
async function contentHashes(
  plan: RestorationPlan,
): Promise<Map<number, string>> {
  const hashes = new Map<number, string>();
  for (const quote of plan.quotes) {
    hashes.set(
      quote.revision,
      await sha256Hex(
        restorationQuoteCanonicalText(restorationQuoteContent(quote)),
      ),
    );
  }
  return hashes;
}

/**
 * True for the job document a restoration quote is filed as. It is priced, so
 * it must stay office-only: `toggle_document_visibility` refuses to show one
 * to trades.
 */
export function isRestorationQuoteDocument(document: any): boolean {
  return document?.type === "other" &&
    record(document?.metadata).restoration_document ===
      RESTORATION_QUOTE_DOCUMENT_MARKER;
}

/**
 * Put the priced content back beside each stored quote record. Every record
 * must find its own filed document, and that document's content must hash to
 * what the record says: an approval is an approval of exactly that content.
 * Anything else is refused, never guessed around.
 *
 * `dropBrokenDraft` is for the save path only: a draft whose document and
 * record disagree (a save that was interrupted between the two writes) is set
 * aside so the next save can put it right. A quote that went to the builder
 * is never set aside.
 */
async function withFiledQuoteContent(
  client: any,
  job: any,
  options: { dropBrokenDraft?: boolean } = {},
): Promise<Record<string, any>> {
  const metadata = record(job.metadata);
  const stored = metadata.restoration;
  const records: any[] = Array.isArray(record(stored).quotes)
    ? record(stored).quotes
    : [];
  if (!records.length) return metadata;
  const { data, error } = await client.from("job_documents")
    .select("id, type, pdf_url, metadata, data_snapshot_json")
    .eq("job_id", job.id)
    .eq("type", "other");
  if (error) readFailed("The job's filed quote", error);
  const documents: any[] = (Array.isArray(data) ? data : [])
    .filter(isRestorationQuoteDocument);
  const merged: any[] = [];
  for (const [index, entry] of records.entries()) {
    const quoteRecord = record(entry);
    const document = documents.find((row) =>
      String(row.id) === text(quoteRecord.document_id)
    );
    const content = record(record(document?.data_snapshot_json).restoration_quote);
    const matches = !!document &&
      Number(content.revision) === Number(quoteRecord.revision) &&
      (await sha256Hex(restorationQuoteCanonicalText(content as any))) ===
        text(quoteRecord.content_hash);
    if (!matches) {
      const isLastDraft = index === records.length - 1 &&
        quoteRecord.status === "draft";
      if (isLastDraft && options.dropBrokenDraft) continue;
      fail(
        "restoration_quote_mismatch",
        isLastDraft
          ? `The draft quote on ${job.job_number || "this job"} was not fully saved. Save the quote again.`
          : `Quote ${text(quoteRecord.quote_number) || `revision ${quoteRecord.revision}`} on ${job.job_number || "this job"} does not match its filed document, so nothing was changed. It needs a person to look at it.`,
        409,
      );
    }
    merged.push({
      ...quoteRecord,
      lines: content.lines,
      scope_of_works: content.scope_of_works,
      exclusions: content.exclusions,
      validity_days: content.validity_days,
      pdf_url: document.pdf_url || null,
    });
  }
  return { ...metadata, restoration: { ...record(stored), quotes: merged } };
}

async function loadRestorationJob(
  client: any,
  selector: { job_id?: unknown; job_number?: unknown },
  caller: RestorationCaller,
  options: { dropBrokenDraft?: boolean } = {},
): Promise<LoadedRestorationJob> {
  const jobId = text(selector.job_id);
  const jobNumber = text(selector.job_number).toUpperCase();
  if (!jobId && !jobNumber) {
    fail("job_required", "job_id or job_number is required.");
  }
  if (jobId && !UUID_RE.test(jobId)) {
    fail("job_id_invalid", "job_id must be a job UUID.");
  }
  let query = client.from("jobs").select(JOB_COLUMNS);
  query = jobId ? query.eq("id", jobId) : query.eq("job_number", jobNumber);
  const { data: job, error } = await query.maybeSingle();
  if (error) readFailed("The job", error);
  if (!job || (caller.orgId && job.org_id && job.org_id !== caller.orgId)) {
    fail("job_not_found", "No job matched.", 404);
  }
  if (!isRestorationCard(job)) {
    fail(
      "not_a_restoration_job",
      `${job.job_number || "This job"} is not a restoration job on the make-safe board. Set its family to Restoration first if that is what it is.`,
      409,
    );
  }
  const detailResponse = await client.from("makesafe_job_details")
    .select(
      "job_id, external_ref, requesting_company_id, requesting_company_name, requesting_company_slug, special_instructions",
    )
    .eq("job_id", job.id).maybeSingle();
  if (detailResponse.error) {
    readFailed("The job's builder details", detailResponse.error);
  }
  const detail = detailResponse.data
    ? { ...detailResponse.data, ...(await builderCompanyName(client, detailResponse.data)) }
    : null;
  const scopeText = restorationScopeText(job, detail);
  const { plan, stored } = readRestorationPlan(
    await withFiledQuoteContent(client, job, options),
    scopeText,
  );
  return { job, detail, scopeText, plan, stored };
}

// The builder's proper name (makesafe_companies.name). requesting_company_name
// on the detail row often holds the slug ("mlb"), which must never be printed
// on a quote. A failed read keeps the detail as it was.
async function builderCompanyName(
  client: any,
  detail: any,
): Promise<{ requesting_company_display_name?: string }> {
  const companyId = text(detail?.requesting_company_id);
  if (!companyId) return {};
  try {
    const { data, error } = await client.from("makesafe_companies")
      .select("name").eq("id", companyId).maybeSingle();
    if (error || !text(data?.name)) return {};
    return { requesting_company_display_name: text(data.name) };
  } catch {
    return {};
  }
}

function builderName(job: any, detail: any): string | null {
  const display = text(detail?.requesting_company_display_name);
  if (display) return display;
  const name = text(detail?.requesting_company_name);
  const slug = text(detail?.requesting_company_slug);
  if (name && name.toLowerCase() !== slug.toLowerCase()) return name;
  return text(record(record(job.metadata).requesting_company).name) || name || null;
}

function actorFor(
  caller: RestorationCaller,
  body: any,
  deps: RestorationStoreDeps,
): { label: string; now: string } {
  const label = text(caller.label) || text(body?.operator_email) ||
    text(body?.recorded_by);
  if (!label) {
    fail(
      "operator_required",
      "Say who is doing this (operator_email), so the record names a person.",
    );
  }
  return { label, now: (deps.now || (() => new Date().toISOString()))() };
}

async function writePlan(
  client: any,
  job: any,
  plan: RestorationPlan,
): Promise<any> {
  const metadata = {
    ...record(job.metadata),
    restoration: restorationPlanForStorage(plan, await contentHashes(plan)),
  };
  // Compare-and-set on updated_at, as updateRepairStage does: jobs.metadata is
  // one blob with other writers, and a quote must never be lost to a race.
  const { data, error } = await client.from("jobs")
    .update({ metadata })
    .eq("id", job.id)
    .eq("updated_at", job.updated_at)
    .select(JOB_COLUMNS);
  if (error) {
    fail(
      "restoration_write_failed",
      `The restoration plan could not be saved (${
        text(error.message) || "unknown database error"
      }).`,
      503,
    );
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    fail(
      "job_changed",
      `${job.job_number || "The job"} changed while this was being saved; nothing was written. Read it again and retry.`,
      409,
    );
  }
  return row;
}

async function writeEvent(
  client: any,
  jobId: string,
  eventType: string,
  detail: Record<string, unknown>,
): Promise<void> {
  // PostgREST returns errors, it does not throw: read the error and say so in
  // the log. The plan is already saved, so a lost audit row never fails the call.
  try {
    const { error } = await client.from("job_events").insert({
      job_id: jobId,
      event_type: eventType,
      detail_json: detail,
    });
    if (error) {
      console.error(
        `[restoration] ${eventType} event not written for ${jobId}: ${
          text(error.message) || "unknown error"
        }`,
      );
    }
  } catch (error) {
    console.error(
      `[restoration] ${eventType} event write threw for ${jobId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function builderPurchaseOrder(job: any): string | null {
  const metadata = record(job.metadata);
  return text(metadata.builder_po_number) || text(metadata.builder_po) || null;
}

function builderReference(job: any, detail: any): string | null {
  const metadata = record(job.metadata);
  // The detail row's external_ref is the builder's own job reference (MLR-41228);
  // builder_claim_ref can hold only the PO digits on an MLR- card, so it is the
  // fallback, never the first answer.
  return text(detail?.external_ref) || text(metadata.builder_claim_ref) ||
    text(metadata.external_ref) || null;
}

function siteAddress(job: any): string {
  const address = text(job.site_address);
  const suburb = text(job.site_suburb);
  if (!address) return suburb;
  return suburb && !address.toLowerCase().includes(suburb.toLowerCase())
    ? `${address}, ${suburb}`
    : address;
}

interface DocketPricingFacts {
  docket_revision_id: string | null;
  sealed_labour_rate_ex_gst: number | null;
  sealed_billable_hours_floor: number | null;
  trade_reported_hours_per_trade: number | null;
  proposal_subtotal_ex_gst: number | null;
  read_error: string | null;
}

function positive(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nonNegative(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The pricing facts of the docket `prepare_ses_invoice_obligation` would use:
 * the newest committed revision. Read-only. An unreadable or absent docket is
 * reported as such, never as zero.
 */
async function readDocketPricingFacts(
  client: any,
  jobId: string,
): Promise<DocketPricingFacts> {
  const empty: DocketPricingFacts = {
    docket_revision_id: null,
    sealed_labour_rate_ex_gst: null,
    sealed_billable_hours_floor: null,
    trade_reported_hours_per_trade: null,
    proposal_subtotal_ex_gst: null,
    read_error: null,
  };
  const { data, error } = await client.from("makesafe_docket_revisions")
    .select("id, stage, local_invoice_proposal, committed_at")
    .eq("job_id", jobId)
    .order("committed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return { ...empty, read_error: text(error.message) || "unknown error" };
  }
  const proposal = record(data?.local_invoice_proposal);
  if (!data || data.stage !== "pre_xero" || !Object.keys(proposal).length) {
    return empty;
  }
  // Same derivation as prepareSesInvoiceObligationAction: the sealed labour
  // rate is the first positive unit price on the docket's own proposal.
  let sealedRate: number | null = null;
  for (const line of Array.isArray(proposal.line_items) ? proposal.line_items : []) {
    const price = positive(line?.unit_price_ex_gst ?? line?.unit_price);
    if (price !== null) {
      sealedRate = price;
      break;
    }
  }
  return {
    docket_revision_id: text(data.id) || null,
    sealed_labour_rate_ex_gst: sealedRate,
    sealed_billable_hours_floor: nonNegative(proposal.billable_hours_floor),
    trade_reported_hours_per_trade:
      nonNegative(proposal.reported_hours_per_trade) ??
        nonNegative(proposal.billable_hours_per_trade),
    proposal_subtotal_ex_gst: nonNegative(proposal.subtotal_ex_gst),
    read_error: null,
  };
}

function jobSummary(job: any, detail: any): Record<string, unknown> {
  return {
    id: job.id,
    job_number: job.job_number || null,
    status: job.status || null,
    site_address: siteAddress(job) || null,
    builder_reference: builderReference(job, detail),
    builder_purchase_order: builderPurchaseOrder(job),
    builder_name: builderName(job, detail),
  };
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** READ. The plan, where the job is at, and the hand-off to an invoice. */
export async function getRestorationPlan(
  client: any,
  params: { job_id?: unknown; job_number?: unknown; authorised_by?: unknown },
  caller: RestorationCaller,
  deps: Pick<RestorationStoreDeps, "now"> = {},
): Promise<Record<string, unknown>> {
  const loaded = await loadRestorationJob(client, params, caller);
  const docket = await readDocketPricingFacts(client, loaded.job.id);
  const now = (deps.now || (() => new Date().toISOString()))();
  const authorisedBy = text(params.authorised_by) || text(caller.label);
  const handoff = approvedQuote(loaded.plan)
    ? restorationInvoiceHandoff(loaded.plan, {
      job_number: text(loaded.job.job_number),
      sealed_labour_rate_ex_gst: docket.sealed_labour_rate_ex_gst,
      sealed_billable_hours_floor: docket.sealed_billable_hours_floor,
      trade_reported_hours_per_trade: docket.trade_reported_hours_per_trade,
      authorised_by: authorisedBy,
      now,
    })
    : null;
  return {
    success: true,
    job: jobSummary(loaded.job, loaded.detail),
    restoration: describeRestorationPlan(loaded.plan, loaded.stored),
    authority_limit: authorityLimitCheck(
      loaded.plan,
      docket.proposal_subtotal_ex_gst,
    ),
    docket: {
      docket_revision_id: docket.docket_revision_id,
      proposal_subtotal_ex_gst: docket.proposal_subtotal_ex_gst,
      sealed_labour_rate_ex_gst: docket.sealed_labour_rate_ex_gst,
      read: docket.read_error ? "failed" : "ok",
      ...(docket.read_error ? { read_error: docket.read_error } : {}),
    },
    // Present only once a quote is approved. `ready: true` carries the exact
    // commercial_quantity_override to pass to prepare_ses_invoice_obligation.
    invoice_handoff: handoff,
  };
}

/** WRITE. Set the mode, the builder's authority limit or the equipment cap. */
export async function setRestorationPlanAction(
  client: any,
  body: any,
  caller: RestorationCaller,
  deps: Pick<RestorationStoreDeps, "now"> = {},
): Promise<Record<string, unknown>> {
  const loaded = await loadRestorationJob(client, body || {}, caller);
  const actor = actorFor(caller, body, deps as RestorationStoreDeps);
  const plan = setRestorationPlan(loaded.plan, {
    mode: body?.mode,
    authority_limit_ex_gst: body?.authority_limit_ex_gst,
    equipment_day_cap: body?.equipment_day_cap,
  }, actor);
  const job = await writePlan(client, loaded.job, plan);
  await writeEvent(client, job.id, "restoration_plan_set", {
    mode: plan.mode,
    authority_limit_ex_gst: plan.authority_limit_ex_gst,
    equipment_day_cap: plan.equipment_day_cap,
    operator: actor.label,
    changed_at: actor.now,
  });
  return {
    success: true,
    job: jobSummary(job, loaded.detail),
    restoration: describeRestorationPlan(plan, true),
  };
}

async function fileQuoteDocument(
  client: any,
  job: any,
  detail: any,
  quote: RestorationQuote,
  body: any,
  caller: RestorationCaller,
  deps: RestorationStoreDeps,
): Promise<{ document_id: string; pdf_url: string; file_name: string }> {
  const render = deps.renderQuote || renderRestorationQuotePdf;
  const rendered = await render({
    quote,
    job_number: text(job.job_number),
    builder_reference: builderReference(job, detail),
    builder_purchase_order: builderPurchaseOrder(job),
    builder_name: builderName(job, detail),
    attention: text(body?.attention) || null,
    site_address: siteAddress(job),
    insured_name: text(job.client_name) || null,
    quote_date: quote.prepared_at.slice(0, 10),
  });
  const uploaded = await deps.persistPdf({
    jobId: job.id,
    fileName: rendered.fileName,
    bytes: rendered.bytes,
  });
  // The priced content lives here and nowhere a trade can read.
  const snapshot = { restoration_quote: restorationQuoteContent(quote) };
  // One document per quote revision: a re-saved draft replaces its own file.
  // Type 'other' on purpose (as the quote builder's scope of works is): no
  // customer-quote reader, close-out reader or SES pack pointer counts it, and
  // it is never visible to trades. sent_at stays null; whether the quote went
  // to the builder is recorded on the plan, not on the document.
  const existing = await client.from("job_documents")
    .select("id, version")
    .eq("job_id", job.id)
    .eq("type", "other")
    .eq("file_name", rendered.fileName)
    .is("superseded_at", null)
    .limit(1);
  if (existing.error) readFailed("The job's documents", existing.error);
  const prior = Array.isArray(existing.data) ? existing.data[0] : null;
  if (prior) {
    const { error } = await client.from("job_documents").update({
      storage_url: uploaded.publicUrl,
      pdf_url: uploaded.publicUrl,
      version: (Number(prior.version) || 1) + 1,
      data_snapshot_json: snapshot,
      visible_to_trades: false,
    }).eq("id", prior.id);
    if (error) {
      fail(
        "quote_document_write_failed",
        `The quote PDF could not be filed (${text(error.message) || "unknown database error"}).`,
        503,
      );
    }
    return {
      document_id: String(prior.id),
      pdf_url: uploaded.publicUrl,
      file_name: rendered.fileName,
    };
  }
  const inserted = await client.from("job_documents").insert({
    job_id: job.id,
    type: "other",
    file_name: rendered.fileName,
    storage_url: uploaded.publicUrl,
    pdf_url: uploaded.publicUrl,
    visible_to_trades: false,
    sent_to_client: false,
    quote_number: quote.quote_number,
    uploaded_by: caller.userId,
    data_snapshot_json: snapshot,
    metadata: {
      source: "restoration_workflow",
      restoration_document: RESTORATION_QUOTE_DOCUMENT_MARKER,
      restoration_quote_revision: quote.revision,
    },
  }).select("id");
  if (inserted.error) {
    fail(
      "quote_document_write_failed",
      `The quote PDF could not be filed (${text(inserted.error.message) || "unknown database error"}).`,
      503,
    );
  }
  const row = Array.isArray(inserted.data) ? inserted.data[0] : inserted.data;
  if (!row?.id) {
    fail("quote_document_write_failed", "The quote PDF was not filed.", 503);
  }
  return {
    document_id: String(row.id),
    pdf_url: uploaded.publicUrl,
    file_name: rendered.fileName,
  };
}

/**
 * WRITE. Save the quote and file its PDF. `dry_run: true` validates and
 * totals the quote and writes nothing.
 */
export async function saveRestorationQuoteAction(
  client: any,
  body: any,
  caller: RestorationCaller,
  deps: RestorationStoreDeps,
): Promise<Record<string, unknown>> {
  const loaded = await loadRestorationJob(client, body || {}, caller, {
    dropBrokenDraft: true,
  });
  const actor = actorFor(caller, body, deps);
  const saved = saveRestorationQuote(loaded.plan, {
    lines: body?.lines,
    scope_of_works: body?.scope_of_works,
    exclusions: body?.exclusions,
    validity_days: body?.validity_days,
    revise_approved: body?.revise_approved,
  }, text(loaded.job.job_number), actor);
  if (body?.dry_run === true) {
    return {
      success: true,
      dry_run: true,
      job: jobSummary(loaded.job, loaded.detail),
      quote: saved.quote,
      restoration: describeRestorationPlan(saved.plan, loaded.stored),
    };
  }
  // PDF first: a quote with no document never becomes the stored quote.
  const filed = await fileQuoteDocument(
    client,
    loaded.job,
    loaded.detail,
    saved.quote,
    body,
    caller,
    deps,
  );
  const plan = attachRestorationQuoteDocument(
    saved.plan,
    filed.document_id,
    filed.pdf_url,
    actor,
  );
  const job = await writePlan(client, loaded.job, plan);
  const quote = plan.quotes[plan.quotes.length - 1];
  await writeEvent(client, job.id, "restoration_quote_saved", {
    quote_number: quote.quote_number,
    revision: quote.revision,
    document_id: filed.document_id,
    operator: actor.label,
    changed_at: actor.now,
  });
  return {
    success: true,
    job: jobSummary(job, loaded.detail),
    quote,
    document: filed,
    restoration: describeRestorationPlan(plan, true),
    // Said in the response so no caller reads a saved quote as a sent one.
    sent_to_builder: false,
  };
}

/** WRITE. Record that a person sent the quote to the builder. */
export async function markRestorationQuoteSentAction(
  client: any,
  body: any,
  caller: RestorationCaller,
  deps: Pick<RestorationStoreDeps, "now"> = {},
): Promise<Record<string, unknown>> {
  const loaded = await loadRestorationJob(client, body || {}, caller);
  const actor = actorFor(caller, body, deps as RestorationStoreDeps);
  const marked = markRestorationQuoteSent(loaded.plan, {
    revision: body?.revision,
    sent_to: body?.sent_to,
    sent_at: body?.sent_at,
    channel: body?.channel,
    note: body?.note,
  }, actor);
  const job = await writePlan(client, loaded.job, marked.plan);
  await writeEvent(client, job.id, "restoration_quote_sent", {
    quote_number: marked.quote.quote_number,
    revision: marked.quote.revision,
    sent_at: marked.quote.sent?.at || null,
    sent_to: marked.quote.sent?.to || null,
    channel: marked.quote.sent?.channel || null,
    operator: actor.label,
    changed_at: actor.now,
  });
  return {
    success: true,
    job: jobSummary(job, loaded.detail),
    quote: marked.quote,
    restoration: describeRestorationPlan(marked.plan, true),
  };
}

/** WRITE. Record the builder's approval or refusal, with its evidence. */
export async function decideRestorationQuoteAction(
  client: any,
  body: any,
  caller: RestorationCaller,
  deps: Pick<RestorationStoreDeps, "now"> = {},
): Promise<Record<string, unknown>> {
  const loaded = await loadRestorationJob(client, body || {}, caller);
  const actor = actorFor(caller, body, deps as RestorationStoreDeps);
  const decided = decideRestorationQuote(loaded.plan, {
    revision: body?.revision,
    decision: body?.decision,
    decided_by: body?.decided_by,
    decided_at: body?.decided_at,
    evidence_kind: body?.evidence_kind,
    evidence_ref: body?.evidence_ref,
    note: body?.note,
  }, actor);
  if (decided.plan === loaded.plan) {
    // The same decision recorded twice changes nothing.
    return {
      success: true,
      unchanged: true,
      job: jobSummary(loaded.job, loaded.detail),
      quote: decided.quote,
      restoration: describeRestorationPlan(loaded.plan, loaded.stored),
    };
  }
  const job = await writePlan(client, loaded.job, decided.plan);
  await writeEvent(
    client,
    job.id,
    decided.quote.status === "approved"
      ? "restoration_quote_approved"
      : "restoration_quote_declined",
    {
      quote_number: decided.quote.quote_number,
      revision: decided.quote.revision,
      decided_by: decided.quote.decision?.decided_by || null,
      decided_at: decided.quote.decision?.decided_at || null,
      evidence_kind: decided.quote.decision?.evidence_kind || null,
      evidence_ref: decided.quote.decision?.evidence_ref || null,
      operator: actor.label,
      changed_at: actor.now,
    },
  );
  return {
    success: true,
    job: jobSummary(job, loaded.detail),
    quote: decided.quote,
    restoration: describeRestorationPlan(decided.plan, true),
  };
}

// deno-lint-ignore-file no-explicit-any
//
// Job commercial read (context build slice D1, dossier design sections 4 and 6).
//
// What was quoted (which version, for how much, to whom, accepted or not),
// the variations, and a short scope summary, read at question time from the
// records that hold them. SELECT-only: no insert, update, delete or upsert,
// no provider call, no model call.
//
// One interpreter per fact:
//   - a sent quote's value comes ONLY from the SQL function job_quote_values
//     (migration 20260923233000); this module never re-derives a value;
//   - acceptance comes from job_documents plus run_acceptances;
//   - variations from job_variations (readJobVariations, also used by the
//     invoice read so the two reads agree);
//   - the scope summary from the release-packet adapter's scope block only.
//
// The job's live price (pricing_json.totalIncGST) is reported separately as
// current_price_inc_gst and is never a quote value.

import { dispatchAdapter } from "../_shared/release_packet/adapters/dispatch.ts";
import { OUR_DOMAINS } from "./makesafe_story.ts";

export const JOB_COMMERCIAL_READ_VERSION = "job-commercial/v1";

const QUOTE_DOC_LIMIT = 200;
const HISTORY_LIMIT = 10;
const VARIATION_LIMIT = 50;
const VARIATION_DESCRIPTION_MAX = 300;
const SCOPE_LINES_MAX = 12;
const DAY_MS = 86_400_000;

/**
 * The only sources the send-quote function writes quote.sent under: its
 * legacy insert ('send-quote') and recordEvidence (the handler name). Must
 * match job_quote_values. Any other source naming a quote is not evidence.
 */
export const SEND_QUOTE_SOURCES = [
  "send-quote",
  "send-quote/send",
  "send-quote/send-runs",
] as const;

// ── shared shapes ────────────────────────────────────────────────────────────

export type CommercialSourceState = "ok" | "failed" | "skipped";

/** Dossier sourceStatus entry for the D1 sections (dossier Review 19 shape). */
export interface CommercialSourceStatus {
  ok: boolean;
  state: CommercialSourceState;
  count: number;
  code?: string;
}

/** One row of public.job_quote_values(job). */
export interface QuoteValueRow {
  document_id: string;
  job_contact_id: string | null;
  party_is_owner: boolean | null;
  run_label: string | null;
  value_inc_gst: number | null;
  value_source: string;
  whole_quote_total_inc: number | null;
  whole_quote_source: string | null;
}

export interface QuoteDocumentRow {
  id: string;
  version: number | null;
  quote_number: string | null;
  run_label: string | null;
  job_contact_id: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  superseded_at: string | null;
  quote_revision_id: string | null;
  created_at: string | null;
}

export interface RunAcceptanceRow {
  job_contact_id: string | null;
  job_document_id: string | null;
  run_label: string | null;
  status: string | null;
  accepted_at: string | null;
  declined_at: string | null;
}

export interface QuoteRevisionRow {
  id: string;
  job_document_id: string | null;
  recipient_email: string | null;
  option_label?: string | null;
  released_via: string | null;
  version: number | null;
  sent_at: string | null;
}

export interface PartyEmailRow {
  id: string;
  client_email: string | null;
}

export interface QuoteSentEventRow {
  occurred_at: string | null;
  source: string | null;
  payload: any;
}

export type QuoteDocumentStatus = "accepted" | "declined" | "viewed" | "sent";
export type QuotesRollup =
  | "accepted"
  | "partially_accepted"
  | "declined"
  | "viewed"
  | "sent"
  | "none_recorded";

export interface QuoteDocumentView {
  document_id: string;
  quote_number: string | null;
  version: number | null;
  run_label: string | null;
  option_label: string | null;
  job_contact_id: string | null;
  party_is_owner: boolean | null;
  sent_at: string | null;
  viewed_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  superseded_at: string | null;
  status: QuoteDocumentStatus;
  value_inc_gst: number | null;
  value_source: string;
  sent_to: string | null;
  recipient_mismatch: boolean | null;
  status_line: string;
}

export interface OutstandingParty {
  job_contact_id: string | null;
  run_label: string | null;
  status: string;
}

export interface JobQuotes {
  status: QuotesRollup;
  outstanding: OutstandingParty[];
  whole_quote_total: { value_inc_gst: number; source: string } | null;
  headline: {
    document_id: string;
    quote_number: string | null;
    version: number | null;
    run_label: string | null;
    value_inc_gst: number | null;
    value_source: string;
    basis: "accepted" | "newest_current";
  } | null;
  current: QuoteDocumentView[];
  run_acceptances: RunAcceptanceRow[];
  history: QuoteDocumentView[];
  history_total: number;
  unsent_documents: number;
  note: string | null;
  read: { values: "ok"; recipients: string };
}

const NONE_RECORDED_NOTE =
  "No quote recorded in SecureWorks systems. A quote emailed from Outlook would not show here, so this is not proof the job was never quoted.";

// ── small helpers ────────────────────────────────────────────────────────────

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function time(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

function newestFirst<T>(rows: T[], at: (row: T) => string | null): T[] {
  return [...rows].sort((a, b) => time(at(b)) - time(at(a)));
}

function normEmail(value: unknown): string | null {
  const s = str(value);
  return s ? s.toLowerCase() : null;
}

function errorCode(error: any): string {
  const code = str(error?.code);
  return code ? code : "read_failed";
}

async function select(builder: any): Promise<{ data: any[]; code?: string }> {
  try {
    const { data, error } = await builder;
    if (error) return { data: [], code: errorCode(error) };
    return { data: Array.isArray(data) ? data : [] };
  } catch (_e) {
    return { data: [], code: "read_threw" };
  }
}

/** The job's live price. Never a quote value. Also used by the invoice read. */
export function currentPriceIncGst(pricing: unknown): number | null {
  let p: any = pricing;
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch (_e) {
      return null;
    }
  }
  if (!p || typeof p !== "object") return null;
  return num(p.totalIncGST) ?? num(p.total) ?? num(p.grandTotal) ??
    num(p.amount);
}

function isOwnDomain(email: string): boolean {
  const domain = email.split("@")[1] ?? "";
  return (OUR_DOMAINS as readonly string[]).some((d) =>
    domain === d || domain.endsWith(`.${d}`)
  );
}

// ── quotes: pure builder ─────────────────────────────────────────────────────

export interface BuildJobQuotesInput {
  job: { client_email: string | null };
  values: QuoteValueRow[];
  documents: QuoteDocumentRow[];
  runAcceptances: RunAcceptanceRow[];
  /** null when the recipient reads failed (sent_to then unknown). */
  recipients: {
    revisions: QuoteRevisionRow[];
    parties: PartyEmailRow[];
    sentEvents: QuoteSentEventRow[];
  } | null;
  recipientsReadState?: string;
}

function runAcceptanceFor(
  rows: RunAcceptanceRow[],
  doc: { job_contact_id: string | null; run_label: string | null },
): RunAcceptanceRow | null {
  if (!doc.run_label || !doc.job_contact_id) return null;
  return rows.find((r) =>
    r.run_label === doc.run_label && r.job_contact_id === doc.job_contact_id
  ) ?? null;
}

function documentStatus(
  doc: QuoteDocumentRow,
  runRow: RunAcceptanceRow | null,
): QuoteDocumentStatus {
  if (runRow?.status === "accepted" || doc.accepted_at) return "accepted";
  if (runRow?.status === "declined" || doc.declined_at) return "declined";
  if (doc.viewed_at) return "viewed";
  return "sent";
}

function recipientFor(
  doc: QuoteDocumentRow,
  recipients: NonNullable<BuildJobQuotesInput["recipients"]>,
): { sent_to: string | null; option_label: string | null } {
  // Same preference order as job_quote_values: the revision the document
  // points at, else its newest sent revision.
  const revisions = recipients.revisions.filter((r) =>
    r.job_document_id === doc.id && r.sent_at
  ).sort((a, b) =>
    Number(b.id === doc.quote_revision_id) -
      Number(a.id === doc.quote_revision_id) ||
    time(b.sent_at) - time(a.sent_at) ||
    (num(b.version) ?? 0) - (num(a.version) ?? 0)
  );
  const revision = revisions[0];
  const optionLabel = doc.run_label ? null : str(revision?.option_label);
  const fromRevision = str(revision?.recipient_email);
  if (fromRevision) return { sent_to: fromRevision, option_label: optionLabel };
  const event = newestFirst(
    recipients.sentEvents.filter((e) =>
      (SEND_QUOTE_SOURCES as readonly string[]).includes(String(e.source)) &&
      str(e.payload?.document_id) === doc.id
    ),
    (e) => e.occurred_at,
  )[0];
  return { sent_to: str(event?.payload?.sent_to), option_label: optionLabel };
}

function recipientMismatch(
  sentTo: string | null,
  jobClientEmail: string | null,
  parties: PartyEmailRow[],
): boolean | null {
  const to = normEmail(sentTo);
  if (!to) return null;
  if (isOwnDomain(to)) return true;
  const known = new Set<string>();
  const jobEmail = normEmail(jobClientEmail);
  if (jobEmail) known.add(jobEmail);
  for (const p of parties) {
    const e = normEmail(p.client_email);
    if (e) known.add(e);
  }
  return !known.has(to);
}

function statusLine(view: {
  status: QuoteDocumentStatus;
  sent_to: string | null;
  recipient_mismatch: boolean | null;
}): string {
  if (view.recipient_mismatch === true && view.sent_to) {
    return `${view.status}, but to ${view.sent_to}`;
  }
  return view.status;
}

/**
 * Builds the dossier quote block from the rows the reader fetched. Pure.
 * Values come verbatim from job_quote_values rows.
 */
export function buildJobQuotes(input: BuildJobQuotesInput): JobQuotes {
  const docsById = new Map(input.documents.map((d) => [d.id, d]));
  const views: QuoteDocumentView[] = [];
  for (const v of input.values) {
    const doc = docsById.get(v.document_id);
    if (!doc) continue; // cannot happen for one job; skip rather than invent
    const runRow = runAcceptanceFor(input.runAcceptances, doc);
    const status = documentStatus(doc, runRow);
    const rec = input.recipients
      ? recipientFor(doc, input.recipients)
      : { sent_to: null, option_label: null };
    const mismatch = input.recipients
      ? recipientMismatch(
        rec.sent_to,
        input.job.client_email,
        input.recipients.parties,
      )
      : null;
    const view: QuoteDocumentView = {
      document_id: doc.id,
      quote_number: doc.quote_number ?? null,
      version: num(doc.version),
      run_label: doc.run_label ?? null,
      option_label: rec.option_label,
      job_contact_id: doc.job_contact_id ?? null,
      party_is_owner: v.party_is_owner ?? null,
      sent_at: doc.sent_at ?? null,
      viewed_at: doc.viewed_at ?? null,
      accepted_at: runRow?.status === "accepted"
        ? (runRow.accepted_at ?? doc.accepted_at ?? null)
        : (doc.accepted_at ?? null),
      declined_at: runRow?.status === "declined"
        ? (runRow.declined_at ?? doc.declined_at ?? null)
        : (doc.declined_at ?? null),
      superseded_at: doc.superseded_at ?? null,
      status,
      value_inc_gst: num(v.value_inc_gst),
      value_source: v.value_source,
      sent_to: rec.sent_to,
      recipient_mismatch: mismatch,
      status_line: "",
    };
    view.status_line = statusLine(view);
    views.push(view);
  }

  const sentOrder = (a: QuoteDocumentView, b: QuoteDocumentView) =>
    time(b.sent_at) - time(a.sent_at) ||
    (b.version ?? 0) - (a.version ?? 0) ||
    a.document_id.localeCompare(b.document_id);
  const current = views.filter((v) =>
    !v.superseded_at && v.status !== "declined"
  ).sort(sentOrder);
  const historyAll = views.filter((v) => !current.includes(v)).sort(sentOrder);

  // ── roll-up over acceptance units ──
  // A unit is one party on one run (run_acceptances, or a sent run document
  // with no acceptance row), or one party's whole-quote documents (options
  // for the same recipient: any accepted means that party accepted). A
  // whole-quote document with no party belongs to the owner, like one on the
  // primary party. Superseded documents and acceptance rows bound to them do
  // not count.
  type Unit = {
    key: string;
    job_contact_id: string | null;
    run_label: string | null;
    status: string;
    viewed: boolean;
  };
  const units = new Map<string, Unit>();
  const liveDocIds = new Set(
    views.filter((v) => !v.superseded_at).map((v) => v.document_id),
  );
  // A run acceptance row bound to a superseded document, or to a document
  // that was never sent (send-runs writes the pending row before it
  // publishes), is not an open ask of that party.
  const notAskedDocIds = new Set(
    input.documents.filter((d) => d.superseded_at || !d.sent_at).map((d) =>
      d.id
    ),
  );
  for (const row of input.runAcceptances) {
    if (row.job_document_id && notAskedDocIds.has(row.job_document_id)) {
      continue;
    }
    const key = `run:${row.job_contact_id ?? "-"}:${row.run_label ?? "-"}`;
    const doc = row.job_document_id
      ? views.find((v) => v.document_id === row.job_document_id)
      : undefined;
    units.set(key, {
      key,
      job_contact_id: row.job_contact_id ?? null,
      run_label: row.run_label ?? null,
      status: row.status === "accepted" || row.status === "declined"
        ? row.status
        : (doc?.viewed_at ? "viewed" : "pending"),
      viewed: Boolean(doc?.viewed_at),
    });
  }
  for (const v of views) {
    if (!liveDocIds.has(v.document_id)) continue;
    if (v.run_label) {
      const key = `run:${v.job_contact_id ?? "-"}:${v.run_label}`;
      if (units.has(key)) continue;
      units.set(key, {
        key,
        job_contact_id: v.job_contact_id,
        run_label: v.run_label,
        status: v.status === "accepted" || v.status === "declined"
          ? v.status
          : (v.viewed_at ? "viewed" : "pending"),
        viewed: Boolean(v.viewed_at),
      });
      continue;
    }
    const owner = v.job_contact_id === null || v.party_is_owner === true;
    const key = `whole:${owner ? "owner" : v.job_contact_id}`;
    const prior = units.get(key);
    const unitStatus = v.status === "accepted"
      ? "accepted"
      : v.status === "declined"
      ? "declined"
      : (v.viewed_at ? "viewed" : "pending");
    if (!prior) {
      units.set(key, {
        key,
        job_contact_id: v.job_contact_id,
        run_label: null,
        status: unitStatus,
        viewed: Boolean(v.viewed_at),
      });
      continue;
    }
    // accepted wins; declined only when every option is declined
    const merged = prior.status === "accepted" || unitStatus === "accepted"
      ? "accepted"
      : prior.status === "declined" && unitStatus === "declined"
      ? "declined"
      : (prior.viewed || v.viewed_at ? "viewed" : "pending");
    units.set(key, {
      ...prior,
      job_contact_id: prior.job_contact_id ?? v.job_contact_id,
      status: merged,
      viewed: prior.viewed || Boolean(v.viewed_at),
    });
  }

  const unitList = [...units.values()].sort((a, b) =>
    a.key.localeCompare(b.key)
  );
  const accepted = unitList.filter((u) => u.status === "accepted");
  const declined = unitList.filter((u) => u.status === "declined");
  let rollup: QuotesRollup;
  let outstanding: OutstandingParty[] = [];
  if (unitList.length === 0) {
    rollup = "none_recorded";
  } else if (accepted.length === unitList.length) {
    rollup = "accepted";
  } else if (accepted.length > 0) {
    rollup = "partially_accepted";
    outstanding = unitList.filter((u) => u.status !== "accepted").map((u) => ({
      job_contact_id: u.job_contact_id,
      run_label: u.run_label,
      status: u.status,
    }));
  } else if (declined.length === unitList.length) {
    rollup = "declined";
  } else if (current.some((v) => v.viewed_at)) {
    rollup = "viewed";
  } else {
    rollup = "sent";
  }

  const acceptedCurrent = current.filter((v) => v.status === "accepted")
    .sort((a, b) => time(b.accepted_at) - time(a.accepted_at));
  const pick = acceptedCurrent[0] ?? current[0] ?? null;
  const headline = pick
    ? {
      document_id: pick.document_id,
      quote_number: pick.quote_number,
      version: pick.version,
      run_label: pick.run_label,
      value_inc_gst: pick.value_inc_gst,
      value_source: pick.value_source,
      basis: (acceptedCurrent[0] ? "accepted" : "newest_current") as
        | "accepted"
        | "newest_current",
    }
    : null;

  const wholeRow = input.values.find((v) =>
    num(v.whole_quote_total_inc) !== null && v.whole_quote_source
  );
  const sentIds = new Set(input.values.map((v) => v.document_id));
  return {
    status: rollup,
    outstanding,
    whole_quote_total: wholeRow
      ? {
        value_inc_gst: num(wholeRow.whole_quote_total_inc)!,
        source: wholeRow.whole_quote_source!,
      }
      : null,
    headline,
    current,
    run_acceptances: input.runAcceptances.map((r) => ({
      job_contact_id: r.job_contact_id ?? null,
      job_document_id: r.job_document_id ?? null,
      run_label: r.run_label ?? null,
      status: r.status ?? null,
      accepted_at: r.accepted_at ?? null,
      declined_at: r.declined_at ?? null,
    })),
    history: historyAll.slice(0, HISTORY_LIMIT),
    history_total: historyAll.length,
    unsent_documents: input.documents.filter((d) => !sentIds.has(d.id)).length,
    note: rollup === "none_recorded" ? NONE_RECORDED_NOTE : null,
    read: {
      values: "ok",
      recipients: input.recipients
        ? "ok"
        : (input.recipientsReadState ?? "failed"),
    },
  };
}

// ── quotes: reader ───────────────────────────────────────────────────────────

/**
 * Reads the job's quote block. The value, document and acceptance reads are
 * required: if any fails the block is null with the code. The recipient reads
 * (revisions, party emails, quote.sent) only feed sent_to: if they fail the
 * block is still returned with sent_to unknown.
 */
export async function readJobQuotes(
  client: any,
  job: { id: string; client_email: string | null },
): Promise<{ quotes: JobQuotes | null; status: CommercialSourceStatus }> {
  const [values, documents, runAcceptances, revisions, parties, sentEvents] =
    await Promise.all([
      (async () => {
        try {
          const { data, error } = await client.rpc("job_quote_values", {
            p_job_id: job.id,
          });
          if (error) return { data: [], code: errorCode(error) };
          return { data: Array.isArray(data) ? data : [] };
        } catch (_e) {
          return { data: [], code: "read_threw" };
        }
      })(),
      select(
        client.from("job_documents")
          .select(
            "id, version, quote_number, run_label, job_contact_id, sent_at, viewed_at, accepted_at, declined_at, superseded_at, quote_revision_id, created_at",
          )
          .eq("job_id", job.id)
          .eq("type", "quote")
          .order("created_at", { ascending: false })
          .limit(QUOTE_DOC_LIMIT),
      ),
      select(
        client.from("run_acceptances")
          .select(
            "job_contact_id, job_document_id, run_label, status, accepted_at, declined_at",
          )
          .eq("job_id", job.id)
          .limit(QUOTE_DOC_LIMIT),
      ),
      select(
        client.from("quote_revisions")
          .select(
            "id, job_document_id, recipient_email, option_label, released_via, version, sent_at",
          )
          .eq("job_id", job.id)
          .limit(QUOTE_DOC_LIMIT),
      ),
      select(
        client.from("job_contacts")
          .select("id, client_email")
          .eq("job_id", job.id)
          .limit(QUOTE_DOC_LIMIT),
      ),
      // Found by the job it names (idx_events_entity), not business_events.job_id,
      // which the attribution ladder may clear on a legacy insert.
      select(
        client.from("business_events")
          .select("occurred_at, source, payload")
          .eq("entity_type", "job")
          .eq("entity_id", job.id)
          .eq("event_type", "quote.sent")
          .in("source", [...SEND_QUOTE_SOURCES])
          .order("occurred_at", { ascending: false })
          .limit(QUOTE_DOC_LIMIT),
      ),
    ]);

  const requiredFailure = values.code ?? documents.code ?? runAcceptances.code;
  if (requiredFailure) {
    return {
      quotes: null,
      status: { ok: false, state: "failed", count: 0, code: requiredFailure },
    };
  }
  const recipientFailure = revisions.code ?? parties.code ?? sentEvents.code;
  const quotes = buildJobQuotes({
    job: { client_email: job.client_email },
    values: values.data as QuoteValueRow[],
    documents: documents.data as QuoteDocumentRow[],
    runAcceptances: runAcceptances.data as RunAcceptanceRow[],
    recipients: recipientFailure ? null : {
      revisions: revisions.data as QuoteRevisionRow[],
      parties: parties.data as PartyEmailRow[],
      sentEvents: sentEvents.data as QuoteSentEventRow[],
    },
    recipientsReadState: recipientFailure
      ? `failed:${recipientFailure}`
      : undefined,
  });
  return {
    quotes,
    status: {
      ok: true,
      state: "ok",
      count: quotes.current.length + quotes.history_total,
    },
  };
}

// ── variations ───────────────────────────────────────────────────────────────

export type VariationAgreement =
  | "customer_accepted"
  | "invoiced"
  | "declined"
  | "rejected_internally"
  | "sent_awaiting_customer"
  | "approved_internally_not_accepted"
  | "pending_internal_approval"
  | "unknown";

export interface VariationView {
  variation_number: number | null;
  description: string | null;
  amount: number | null;
  gst_included: boolean | null;
  status: string | null;
  approved_at: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  created_at: string | null;
  age_days: number | null;
  agreement: VariationAgreement;
  agreed: boolean;
  note: string | null;
}

const ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes HTML entities, drops tags, collapses whitespace, caps the length. */
export function decodeVariationText(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  const decoded = s
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) && n <= 0x10ffff
        ? String.fromCodePoint(n)
        : " ";
    })
    .replace(/&#(\d+);/g, (_m, d) => {
      const n = parseInt(d, 10);
      return Number.isFinite(n) && n <= 0x10ffff
        ? String.fromCodePoint(n)
        : " ";
    })
    .replace(/&([a-z]+);/gi, (m, name) => ENTITY[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
  if (!decoded) return null;
  return decoded.length > VARIATION_DESCRIPTION_MAX
    ? `${decoded.slice(0, VARIATION_DESCRIPTION_MAX - 1)}…`
    : decoded;
}

function variationAgreement(row: any): {
  agreement: VariationAgreement;
  note: string | null;
} {
  const status = str(row?.status)?.toLowerCase() ?? null;
  if (row?.declined_at || status === "declined") {
    return { agreement: "declined", note: "declined by the customer" };
  }
  if (status === "rejected") {
    return { agreement: "rejected_internally", note: "rejected internally" };
  }
  if (row?.accepted_at || status === "accepted") {
    return { agreement: "customer_accepted", note: null };
  }
  if (status === "invoiced") {
    return {
      agreement: "invoiced",
      note: "invoiced; customer acceptance not recorded",
    };
  }
  if (row?.sent_at || status === "sent") {
    return {
      agreement: "sent_awaiting_customer",
      note: "sent to the customer, not accepted",
    };
  }
  if (status === "approved" || status === "auto_approved") {
    return {
      agreement: "approved_internally_not_accepted",
      note: "approved internally, customer acceptance not recorded",
    };
  }
  if (status === "pending_approval") {
    return {
      agreement: "pending_internal_approval",
      note: "pending internal approval, not agreed",
    };
  }
  return { agreement: "unknown", note: `status not recognised: ${status}` };
}

/** Pure view of one job_variations row. */
export function variationView(row: any, now: Date): VariationView {
  const { agreement, note } = variationAgreement(row);
  const created = time(row?.created_at ?? null);
  return {
    variation_number: num(row?.variation_number),
    description: decodeVariationText(row?.description),
    amount: num(row?.amount),
    gst_included: typeof row?.gst_included === "boolean"
      ? row.gst_included
      : null,
    status: str(row?.status),
    approved_at: row?.approved_at ?? null,
    sent_at: row?.sent_at ?? null,
    accepted_at: row?.accepted_at ?? null,
    declined_at: row?.declined_at ?? null,
    created_at: row?.created_at ?? null,
    age_days: Number.isFinite(created)
      ? Math.max(0, Math.floor((now.getTime() - created) / DAY_MS))
      : null,
    agreement,
    agreed: agreement === "customer_accepted" || agreement === "invoiced",
    note,
  };
}

/** Reads the job's variations. Also the invoice read's variation source. */
export async function readJobVariations(
  client: any,
  jobId: string,
  now: Date = new Date(),
): Promise<
  { variations: VariationView[] | null; status: CommercialSourceStatus }
> {
  const read = await select(
    client.from("job_variations")
      .select(
        "variation_number, description, amount, gst_included, status, approved_at, sent_at, accepted_at, declined_at, created_at",
      )
      .eq("job_id", jobId)
      .order("variation_number", { ascending: true })
      .limit(VARIATION_LIMIT),
  );
  if (read.code) {
    return {
      variations: null,
      status: { ok: false, state: "failed", count: 0, code: read.code },
    };
  }
  const variations = read.data.map((row) => variationView(row, now));
  return {
    variations,
    status: { ok: true, state: "ok", count: variations.length },
  };
}

// ── scope summary ────────────────────────────────────────────────────────────

export interface ScopeSummary {
  status: string; // summarised | no_scope | not_summarised:<reason>
  kind: string | null;
  lines: string[];
  scope_version: number | null;
  scope_updated_at: string | null;
  signed_off_at: string | null;
  signed_off_source: string | null;
  current_price_inc_gst: number | null;
  changed_since_last_quote: boolean | null;
  changed_since_last_quote_basis: string;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  let v: unknown = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch (_e) {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

function metres(value: unknown): string | null {
  const n = num(value);
  if (n === null || n <= 0) return null;
  return String(Math.round(n * 100) / 100);
}

function scopeLines(scope: any): string[] {
  const out: string[] = [];
  if (scope?.kind === "patio") {
    const w = metres(scope.dimensions?.width_m);
    const d = metres(scope.dimensions?.depth_m);
    const h = metres(scope.dimensions?.height_m);
    const type = str(scope.structure_type);
    const head = [
      type && type !== "unknown" ? type : "patio",
      w && d ? `${w} m x ${d} m` : null,
      h ? `height ${h} m` : null,
    ].filter(Boolean).join(", ");
    out.push(head);
    const extras = [
      str(scope.roof_sheet_colour) ? `roof ${scope.roof_sheet_colour}` : null,
      str(scope.post_type) ? `posts ${scope.post_type}` : null,
      str(scope.footings) ? `footings ${scope.footings}` : null,
      str(scope.gutter) ? `gutter ${scope.gutter}` : null,
      scope.electrical_yes_no ? "electrical" : null,
      scope.demo_yes_no ? "demolition" : null,
    ].filter(Boolean);
    if (extras.length) out.push(extras.join(", "));
    for (
      const line of Array.isArray(scope.package_lines)
        ? scope.package_lines
        : []
    ) {
      const desc = str(line?.description);
      if (desc) {
        out.push(`${desc} (${num(line?.qty) ?? 1} ${str(line?.unit) ?? "ea"})`);
      }
    }
  } else if (scope?.kind === "fence") {
    for (const run of Array.isArray(scope.runs) ? scope.runs : []) {
      const len = metres(run?.lineal_m);
      const height = num(run?.height_mm);
      const gates = Array.isArray(run?.gates) ? run.gates.length : 0;
      out.push(
        [
          `${str(run?.run_label) ?? "run"}:`,
          str(run?.type) ?? "fence",
          len ? `${len} m` : null,
          height && height > 0 ? `${height} mm high` : null,
          gates ? `${gates} gate${gates === 1 ? "" : "s"}` : null,
          run?.demo ? "demolition" : null,
        ].filter(Boolean).join(" "),
      );
    }
  } else if (scope?.kind === "quick_quote") {
    const label = str(scope.label);
    const desc = decodeVariationText(scope.description);
    if (label) out.push(label);
    if (desc) out.push(desc.length > 200 ? `${desc.slice(0, 199)}…` : desc);
  }
  return out.filter((l) => l.length > 0).slice(0, SCOPE_LINES_MAX);
}

/**
 * Pure scope summary. Reads the adapter's scope block only (never pricing or
 * internal cost). newestQuoteSentAt is the newest CURRENT quote's sent_at.
 */
export function summariseScope(
  job: {
    id: string;
    type: string | null;
    org_id?: string | null;
    job_number?: string | null;
    scope_json: unknown;
    pricing_json: unknown;
    scope_version?: unknown;
    scope_updated_at?: string | null;
  },
  opts: {
    newestQuoteSentAt: string | null;
    signedOff: { at: string; source: string } | null;
  },
): ScopeSummary {
  const scopeJson = parseJsonObject(job.scope_json);
  const pricingJson = parseJsonObject(job.pricing_json);
  const scopeUpdatedAt = job.scope_updated_at ?? null;

  let changed: boolean | null;
  let basis: string;
  if (!opts.newestQuoteSentAt) {
    changed = null;
    basis = "no_sent_quote";
  } else if (!scopeUpdatedAt || !Number.isFinite(time(scopeUpdatedAt))) {
    changed = null;
    basis = "scope_update_time_not_recorded";
  } else {
    changed = time(scopeUpdatedAt) > time(opts.newestQuoteSentAt);
    basis = "scope_updated_at_vs_newest_current_quote";
  }

  const base: ScopeSummary = {
    status: "summarised",
    kind: null,
    lines: [],
    scope_version: num(job.scope_version),
    scope_updated_at: scopeUpdatedAt,
    signed_off_at: opts.signedOff?.at ?? null,
    signed_off_source: opts.signedOff?.source ?? null,
    current_price_inc_gst: currentPriceIncGst(pricingJson),
    changed_since_last_quote: changed,
    changed_since_last_quote_basis: basis,
  };
  if (!scopeJson || Object.keys(scopeJson).length === 0) {
    return { ...base, status: "no_scope" };
  }
  try {
    const result = dispatchAdapter({
      job: {
        id: job.id,
        type: String(job.type ?? ""),
        org_id: String(job.org_id ?? ""),
        client_name: null,
        client_email: null,
        client_phone: null,
        site_address: null,
        site_suburb: null,
        site_lat: null,
        site_lng: null,
        job_number: job.job_number ?? null,
        scope_json: scopeJson,
        pricing_json: pricingJson,
        notes: null,
      },
      supplemental: {},
    });
    if (!result.ok) {
      return {
        ...base,
        status: "not_summarised:no_adapter",
        kind: result.matched_kind,
      };
    }
    const scope: any = result.output.scope;
    return { ...base, kind: scope?.kind ?? null, lines: scopeLines(scope) };
  } catch (_e) {
    return { ...base, status: "not_summarised:adapter_error" };
  }
}

/**
 * Newest scope sign-off: the scoping tool's scope.completed event. Only the
 * two scoping-tool sources count (business_events is still public-insertable,
 * gate G-ANON), and the source is returned with the time. Found by the job it
 * names (entity), not business_events.job_id, which the attribution ladder may
 * clear.
 */
export async function readScopeSignOff(
  client: any,
  jobId: string,
): Promise<
  { signedOff: { at: string; source: string } | null; code?: string }
> {
  const read = await select(
    client.from("business_events")
      .select("occurred_at, source")
      .eq("entity_type", "job")
      .eq("entity_id", jobId)
      .eq("event_type", "scope.completed")
      .in("source", ["scoping_tool", "scoping_tool_walkup"])
      .order("occurred_at", { ascending: false })
      .limit(1),
  );
  if (read.code) return { signedOff: null, code: read.code };
  const row = read.data[0];
  const at = str(row?.occurred_at);
  return {
    signedOff: at ? { at, source: `scope.completed:${row.source}` } : null,
  };
}

/** Scope section plus its source status. */
export function scopeSourceStatus(
  scope: ScopeSummary,
  signOffCode?: string,
): CommercialSourceStatus {
  const state: CommercialSourceState = scope.status === "summarised"
    ? "ok"
    : "skipped";
  return {
    ok: true,
    state,
    count: scope.lines.length,
    ...(signOffCode
      ? { code: `signed_off_read_failed:${signOffCode}` }
      : scope.status === "summarised"
      ? {}
      : { code: scope.status }),
  };
}

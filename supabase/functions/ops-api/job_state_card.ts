// deno-lint-ignore-file no-explicit-any
//
// Job state card (context state-card-v1, 4 Oct 2026).
//
// One honest answer for any job, with no model call: a short list of plain
// lines, one fact each, built only from what assemble_job_dossier has already
// read (job row, quotes, invoices, bookings, conversation, facts, the stored
// brief, visit outcomes, freshness), plus an explicit list of what is NOT
// known. A job with no linked messages still gets its record-based state, and
// the reader can see that nothing has been read from texts, calls or emails.
//
// Pure: no client, no clock (the caller passes `now`), no write, no network.
// A source the dossier could not read is named in not_known ("Could not read
// ..."), never reported as "none".
//
// Shared contract with the agent side (sw_job_context_v2): the dossier gains a
// top-level `state` object
//   { version: "state-card-v1", lines: string[], not_known: string[],
//     brief: { present, written_at, stale, ... } }.
// `brief` may carry more keys (text, fact_id, stale_reason); the three named
// keys never change meaning within this version.

import type { JobFreshness } from "./job_freshness.ts";
import type { JobQuotes, QuoteDocumentView } from "./job_commercial_read.ts";

export const JOB_STATE_CARD_VERSION = "state-card-v1";

const PERTH_OFFSET_MS = 8 * 3_600_000; // Perth has no daylight saving.
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** The stored brief's sections, in order (secureworks-jarvis job-brief-shape.ts BRIEF_SECTIONS). */
const BRIEF_SECTION_TITLES: Record<string, string> = {
  where_it_stands: "Where it stands",
  what_they_want: "What they want",
  site_and_access: "Site and access",
  when_they_can_do: "When they can do",
  what_was_agreed: "What was agreed",
  promises: "What we promised, and whether we kept it",
  money: "Money",
  owed_next: "Owed next",
  not_known: "Not known",
};

const BRIEF_MARK_WORDS: Record<string, string> = {
  said: "customer said",
  we_said: "we said",
  record: "from our records",
  inferred: "inferred",
};

export interface StateCardBrief {
  present: boolean;
  /** When the brief was written (its own header, else the fact row's created_at). */
  written_at: string | null;
  /** True when the brief may be out of date, or its currency could not be checked. */
  stale: boolean;
  /** Why it is stale, in plain words; null when current or absent. */
  stale_reason: string | null;
  fact_id: string | null;
  /** The brief as readable text, headed by its freshness; null when absent or unreadable. */
  text: string | null;
}

export interface JobStateCard {
  version: typeof JOB_STATE_CARD_VERSION;
  lines: string[];
  not_known: string[];
  brief: StateCardBrief;
}

/** A read the dossier made: rows, and whether the read succeeded. */
export interface StateCardRead<T> {
  ok: boolean;
  rows: T[];
}

export interface JobStateCardInput {
  /** The time the card is built (ISO string or epoch ms). */
  now: string | number;
  job: {
    status?: string | null;
    created_at?: string | null;
    quoted_at?: string | null;
    accepted_at?: string | null;
    scheduled_at?: string | null;
    completed_at?: string | null;
    updated_at?: string | null;
    ghl_contact_id?: string | null;
  };
  /** operationalTruth.quotes; null when the quote read failed. */
  quotes: JobQuotes | null;
  quotesOk: boolean;
  invoices: StateCardRead<any>;
  assignments: StateCardRead<any>;
  /** The merged conversation the dossier returns (any order). */
  conversation: StateCardRead<any>;
  /** Current facts (visible and temporary), job_brief rows included or not. */
  facts: StateCardRead<any>;
  /** Current job_brief fact rows for this job (newest first is not required). */
  briefs: StateCardRead<any>;
  visitOutcomes: StateCardRead<any>;
  /** The dossier's freshness section; null when that read failed. */
  freshness: JobFreshness | null;
  /** The dossier's `since` filter, when one was applied to messages. */
  since?: string | null;
}

// ── small helpers ────────────────────────────────────────────────────────────

function ms(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return null;
  // A bare date (YYYY-MM-DD) is a Perth calendar day.
  const t = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T00:00:00+08:00`)
    : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function perthParts(t: number) {
  const d = new Date(t + PERTH_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    day: d.getUTCDate(),
    hh: String(d.getUTCHours()).padStart(2, "0"),
    mm: String(d.getUTCMinutes()).padStart(2, "0"),
  };
}

/** "4 Oct 2026" in Perth, or null. */
export function perthDate(value: unknown): string | null {
  const t = ms(value);
  if (t === null) return null;
  const p = perthParts(t);
  return `${p.day} ${MONTHS[p.m]} ${p.y}`;
}

/** "4 Oct 2026 10:23 Perth", or null. */
export function perthDateTime(value: unknown): string | null {
  const t = ms(value);
  if (t === null) return null;
  const p = perthParts(t);
  return `${p.day} ${MONTHS[p.m]} ${p.y} ${p.hh}:${p.mm} Perth`;
}

/** The Perth calendar day as YYYY-MM-DD. */
function perthDay(t: number): string {
  return new Date(t + PERTH_OFFSET_MS).toISOString().slice(0, 10);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "$1,234.50" */
export function money(value: number): string {
  const sign = value < 0 ? "-" : "";
  const [whole, cents] = Math.abs(value).toFixed(2).split(".");
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function words(value: unknown): string {
  return String(value ?? "").replace(/_/g, " ").trim();
}

// ── stage ────────────────────────────────────────────────────────────────────

/** Which job date says when the job reached its current stage. */
function stageDate(job: JobStateCardInput["job"]): string | null {
  const s = String(job.status || "").toLowerCase();
  if (s === "draft" || s === "new" || s === "lead") {
    return job.created_at ?? null;
  }
  if (s.includes("quot")) return job.quoted_at ?? null;
  if (s.includes("accept") || s.includes("deposit") || s === "won") {
    return job.accepted_at ?? null;
  }
  if (s.includes("schedul") || s.includes("progress")) {
    return job.scheduled_at ?? null;
  }
  if (
    s.includes("complet") || s === "invoiced" || s === "get_review" ||
    s === "paid"
  ) return job.completed_at ?? null;
  return null;
}

function stageLine(job: JobStateCardInput["job"]): string {
  const stage = words(job.status) || "not recorded";
  const reached = perthDate(stageDate(job));
  if (reached) return `Stage: ${stage}, since ${reached}.`;
  const updated = perthDate(job.updated_at);
  return updated
    ? `Stage: ${stage} (job record last changed ${updated}).`
    : `Stage: ${stage}.`;
}

// ── quote ────────────────────────────────────────────────────────────────────

function newestSentQuote(quotes: JobQuotes): QuoteDocumentView | null {
  const all = [...(quotes.current || []), ...(quotes.history || [])]
    .filter((q) => ms(q.sent_at) !== null);
  all.sort((a, b) => (ms(b.sent_at) as number) - (ms(a.sent_at) as number));
  return all[0] || null;
}

function quoteLine(quotes: JobQuotes): string {
  const q = newestSentQuote(quotes);
  if (!q) return "No sent quote on record in our systems.";
  const name = [
    q.quote_number || "quote with no number",
    q.version !== null && q.version !== undefined ? `version ${q.version}` : "",
    q.run_label ? `(${q.run_label})` : "",
  ].filter(Boolean).join(" ");
  const value = q.value_inc_gst !== null && q.value_inc_gst !== undefined
    ? `${money(q.value_inc_gst)} inc GST`
    : "value not recorded";
  const parts = [`sent ${perthDate(q.sent_at)}`];
  parts.push(q.viewed_at ? `viewed ${perthDate(q.viewed_at)}` : "not viewed");
  if (q.accepted_at || q.status === "accepted") {
    parts.push(
      q.accepted_at ? `accepted ${perthDate(q.accepted_at)}` : "accepted",
    );
  } else if (q.declined_at || q.status === "declined") {
    parts.push(
      q.declined_at ? `declined ${perthDate(q.declined_at)}` : "declined",
    );
  } else parts.push("not accepted");
  if (q.superseded_at) parts.push(`replaced ${perthDate(q.superseded_at)}`);
  return `Newest sent quote: ${name}, ${value}, ${parts.join(", ")}.`;
}

// ── bookings ─────────────────────────────────────────────────────────────────

function bookingWords(a: any): string {
  const date = perthDate(a.scheduled_date) as string;
  const end = a.scheduled_end && a.scheduled_end !== a.scheduled_date
    ? perthDate(a.scheduled_end)
    : null;
  const what = [
    a.assignment_type ? words(a.assignment_type) : "",
    a.crew_name ? `with ${a.crew_name}` : "",
  ].filter(Boolean).join(" ");
  return `${date}${end ? ` to ${end}` : ""}${what ? ` (${what})` : ""}`;
}

function bookingLines(rows: any[], now: number): string[] {
  // A cancelled booking, or a ghost watcher row (role observer), is not a booking.
  const real = rows.filter((a) =>
    a && String(a.status || "").toLowerCase() !== "cancelled" &&
    String(a.role || "").toLowerCase() !== "observer" &&
    ms(a.scheduled_date) !== null
  );
  if (!real.length) return ["No bookings on record."];
  const today = perthDay(now);
  const day = (a: any) => String(a.scheduled_date).slice(0, 10);
  const lastDay = (a: any) =>
    String(a.scheduled_end || a.scheduled_date).slice(0, 10);
  const upcoming = real.filter((a) => lastDay(a) >= today)
    .sort((a, b) => day(a).localeCompare(day(b)));
  const past = real.filter((a) => lastDay(a) < today)
    .sort((a, b) => day(b).localeCompare(day(a)));
  return [
    upcoming.length
      ? `Next booking: ${bookingWords(upcoming[0])}.`
      : "No upcoming booking.",
    past.length
      ? `Last booking: ${bookingWords(past[0])}.`
      : "No past booking.",
  ];
}

// ── invoices ─────────────────────────────────────────────────────────────────

function invoiceLine(rows: any[]): string {
  // Bills we owe (ACCPAY) are not this job's invoices to the customer.
  const ours = rows.filter((r) =>
    r && String(r.invoice_type || "ACCREC").toUpperCase() === "ACCREC"
  );
  const live = ours.filter((r) => {
    const s = String(r.status || "").toUpperCase();
    return s !== "VOIDED" && s !== "DELETED";
  });
  if (!live.length) return "No invoices on record.";
  const open = live.filter((r) => {
    const s = String(r.status || "").toUpperCase();
    return (s === "AUTHORISED" || s === "SUBMITTED") &&
      (num(r.amount_due) ?? 0) > 0;
  });
  const drafts = live.filter((r) =>
    String(r.status || "").toUpperCase() === "DRAFT"
  );
  const paid = live.filter((r) =>
    String(r.status || "").toUpperCase() === "PAID"
  );
  const tail = [
    drafts.length
      ? plural(drafts.length, "draft not yet issued", "drafts not yet issued")
      : "",
    paid.length ? `${paid.length} paid` : "",
  ].filter(Boolean).join(", ");
  if (!open.length) {
    return `No open invoices${tail ? ` (${tail})` : ""}.`;
  }
  const due = open.reduce((sum, r) => sum + (num(r.amount_due) ?? 0), 0);
  const numbers = open.map((r) => r.invoice_number).filter(Boolean);
  return `Open invoices: ${open.length}, ${money(due)} due` +
    `${numbers.length ? ` (${numbers.join(", ")})` : ""}` +
    `${tail ? `; also ${tail}` : ""}.`;
}

// ── messages ─────────────────────────────────────────────────────────────────

const CHANNEL_WORDS: Record<string, string> = {
  sms: "text",
  call: "call",
  email: "email",
};

// Party roles (B-6): who the other side was, when it was not the customer.
const OTHER_PARTY_WORDS: Record<string, string> = {
  supplier: "a supplier",
  insurer_builder: "the insurer or builder",
};

function newestContactLine(messages: any[]): string | null {
  // Crew and staff communication (audience internal) is never contact with
  // the customer.
  const customer = messages.filter((m) =>
    m && m.channel !== "note" && m.audience !== "internal" &&
    m.direction !== "internal" && ms(m.occurred_at) !== null
  );
  if (!customer.length) return null;
  customer.sort((a, b) =>
    (ms(b.occurred_at) as number) - (ms(a.occurred_at) as number)
  );
  const m = customer[0];
  const channel = CHANNEL_WORDS[m.channel] || words(m.channel) || "message";
  const other = m.direction === "outbound"
    ? OTHER_PARTY_WORDS[m.recipient_role]
    : OTHER_PARTY_WORDS[m.sender_role];
  const who = m.direction === "outbound"
    ? `from us${other ? ` to ${other}` : ""}`
    : m.direction === "inbound"
    ? `from ${other ?? "the customer"}`
    : "";
  const where = m.source_system === "ghl_cache"
    ? ", seen in the CRM thread (not linked to this job)"
    : m.source_system === "inbox"
    ? ", from the old inbox match"
    : "";
  return `Newest contact: ${channel}${who ? ` ${who}` : ""} on ${
    perthDate(m.occurred_at)
  }${where}.`;
}

// ── brief ────────────────────────────────────────────────────────────────────

function parseBrief(text: unknown): any | null {
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    if (
      parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      parsed.header && typeof parsed.header === "object" &&
      Array.isArray(parsed.lines)
    ) return parsed;
  } catch (_e) {
    // not JSON: handled by the caller
  }
  return null;
}

function newestBriefRow(rows: any[]): any | null {
  const briefs = rows.filter((r) => r && r.kind === "job_brief");
  briefs.sort((a, b) =>
    (ms(b.updated_at ?? b.created_at) ?? 0) -
    (ms(a.updated_at ?? a.created_at) ?? 0)
  );
  return briefs[0] || null;
}

/** The stored brief's lines as readable text, one section heading per section. */
export function renderBriefLines(brief: any): string {
  const out: string[] = [];
  const known = Object.keys(BRIEF_SECTION_TITLES);
  const sections = [
    ...known,
    ...[...new Set(brief.lines.map((l: any) => String(l?.section ?? "")))]
      .filter((s) => s && !known.includes(s as string)) as string[],
  ];
  for (const section of sections) {
    const lines = brief.lines.filter((l: any) =>
      l && String(l.section) === section &&
      typeof l.text === "string" && l.text.trim()
    );
    if (!lines.length) continue;
    out.push(`${BRIEF_SECTION_TITLES[section] || words(section)}:`);
    for (const l of lines) {
      const tags = [
        BRIEF_MARK_WORDS[l.mark] || "",
        l.promise ? `promise ${words(l.promise)}` : "",
        l.one_sided ? "one side only, not an agreement" : "",
      ].filter(Boolean);
      out.push(
        `- ${l.text.trim()}${tags.length ? ` (${tags.join("; ")})` : ""}`,
      );
    }
  }
  return out.join("\n");
}

/** The brief part of the card: presence, when written, whether current, readable text. */
export function stateCardBrief(
  briefRow: any | null,
  job: JobStateCardInput["job"],
  freshness: JobFreshness | null,
): StateCardBrief {
  if (!briefRow) {
    return {
      present: false,
      written_at: null,
      stale: false,
      stale_reason: null,
      fact_id: null,
      text: null,
    };
  }
  const rawText = briefRow?.value?.text;
  const parsed = parseBrief(rawText);
  const header = parsed?.header ?? null;
  const writtenAt: string | null =
    (typeof header?.written_at === "string" && ms(header.written_at) !== null
      ? header.written_at
      : null) ?? briefRow.created_at ?? null;

  const reasons: string[] = [];
  if (!freshness) {
    reasons.push("could not check for newer messages");
  } else if (freshness.unread_count > 0) {
    reasons.push(
      `${
        plural(freshness.unread_count, "newer message", "newer messages")
      } not yet read into it`,
    );
  }
  if (header?.evidence?.truncated === true) {
    reasons.push("it was written from a thread read that was cut short");
  }
  const briefStatus = typeof header?.job?.status === "string"
    ? header.job.status
    : null;
  if (briefStatus && job.status && briefStatus !== job.status) {
    reasons.push(
      `the job stage changed from ${words(briefStatus)} to ${
        words(job.status)
      } since it was written`,
    );
  }
  if (
    typeof rawText === "string" && !parsed && rawText.trim().startsWith("{")
  ) {
    reasons.push("it is stored in a shape this read does not recognise");
  }
  const stale = reasons.length > 0;
  const staleReason = stale ? reasons.join("; ") : null;

  const headLine = `Job brief written ${
    perthDateTime(writtenAt) ?? "at an unknown time"
  }; ${stale ? `may be out of date: ${staleReason}` : "current"}.`;
  let body: string | null = null;
  if (parsed) {
    const ev = header?.evidence ?? {};
    const read = typeof ev.events_read === "number"
      ? `Read from ${plural(ev.events_read, "message", "messages")}${
        typeof ev.records_read === "number"
          ? ` and ${
            plural(ev.records_read, "business record", "business records")
          }`
          : ""
      }${
        perthDateTime(ev.newest_event_at)
          ? `, newest message ${perthDateTime(ev.newest_event_at)}`
          : ""
      }. Memory only; it grants no authority to act.`
      : "Memory only; it grants no authority to act.";
    body = `${read}\n${renderBriefLines(parsed)}`;
  } else if (
    typeof rawText === "string" && rawText.trim() &&
    !rawText.trim().startsWith("{")
  ) {
    body = rawText.trim();
  }
  return {
    present: true,
    written_at: writtenAt,
    stale,
    stale_reason: staleReason,
    fact_id: briefRow.id ? String(briefRow.id) : null,
    text: body === null ? null : `${headLine}\n${body}`,
  };
}

// ── visit outcomes ───────────────────────────────────────────────────────────

function newestVisitOutcome(rows: any[]): any | null {
  // A corrected outcome supersedes the row it names; show only the latest word.
  const replaced = new Set(rows.map((r) => r?.supersedes).filter(Boolean));
  const live = rows.filter((r) =>
    r && !replaced.has(r.id) && ms(r.visit_start) !== null
  );
  live.sort((a, b) =>
    (ms(b.visit_start) as number) - (ms(a.visit_start) as number) ||
    (ms(b.recorded_at) ?? 0) - (ms(a.recorded_at) ?? 0)
  );
  return live[0] || null;
}

function visitOutcomeLine(v: any): string {
  const when = perthDate(v.visit_start);
  if (v.outcome === "happened") {
    return `Last visit outcome: visit happened on ${when}${
      v.quote_owed ? ", quote owed" : ""
    }.`;
  }
  return `Last visit outcome: visit on ${when} did not happen${
    v.reason ? ` (${words(v.reason)})` : ""
  }.`;
}

// ── the card ─────────────────────────────────────────────────────────────────

export function buildJobStateCard(input: JobStateCardInput): JobStateCard {
  const now = ms(input.now) ?? Date.now();
  const lines: string[] = [];
  const notKnown: string[] = [];
  const failed = (what: string) =>
    notKnown.push(`Could not read ${what}, so it is left out of this card.`);

  lines.push(stageLine(input.job));

  if (input.quotesOk && input.quotes) lines.push(quoteLine(input.quotes));
  else failed("quotes");

  if (input.assignments.ok) {
    lines.push(...bookingLines(input.assignments.rows, now));
  } else failed("bookings");

  if (input.invoices.ok) lines.push(invoiceLine(input.invoices.rows));
  else failed("invoices");

  if (input.conversation.ok) {
    const contact = newestContactLine(input.conversation.rows);
    lines.push(contact ?? "No texts, calls or emails seen for this job.");
  } else failed("messages");

  const briefRow = newestBriefRow([
    ...(input.briefs.ok ? input.briefs.rows : []),
    ...(input.facts.ok ? input.facts.rows : []),
  ]);
  const brief = stateCardBrief(briefRow, input.job, input.freshness);
  if (brief.present) {
    lines.push(
      `Brief: written ${
        perthDateTime(brief.written_at) ?? "at an unknown time"
      }, ${
        brief.stale ? `may be out of date (${brief.stale_reason})` : "current"
      }.`,
    );
  } else if (input.briefs.ok) {
    notKnown.push("No brief yet.");
  } else failed("the brief");

  if (input.facts.ok) {
    const count = input.facts.rows.filter((r) => r && r.kind !== "job_brief")
      .length;
    lines.push(
      count ? `Facts on file: ${count}.` : "No facts on file yet.",
    );
  } else failed("facts");

  // Linked rows: what the dossier read of business_events messages on this job,
  // plus the freshness judgement (unread rows, last read).
  const linkedShown = input.conversation.ok
    ? input.conversation.rows.filter((m) =>
      m && m.source_system === "business_events" && m.channel !== "note"
    ).length
    : null;
  const f = input.freshness;
  if (f) {
    const lastRead = perthDateTime(f.last_run_finished_at);
    lines.push(
      `Linked messages: ${
        linkedShown === null ? "count unknown" : `${linkedShown} shown`
      }${
        input.since ? ` since ${perthDate(input.since)}` : ""
      }, ${f.unread_count} not yet read, ${
        lastRead ? `last read ${lastRead}` : "never read"
      }.`,
    );
    if (
      !input.since && f.last_run_finished_at === null && f.unread_count === 0 &&
      linkedShown === 0
    ) {
      notKnown.push(
        "No messages are linked to this job, so nothing has been read from texts, calls or emails.",
      );
    }
  } else {
    notKnown.push(
      "Could not check how current the facts are or how many linked messages are unread.",
    );
  }

  if (input.visitOutcomes.ok) {
    const v = newestVisitOutcome(input.visitOutcomes.rows);
    if (v) lines.push(visitOutcomeLine(v));
    else notKnown.push("No visit outcome recorded.");
  } else failed("visit outcomes");

  const contactMissing = f ? f.contact_missing : !input.job.ghl_contact_id;
  if (contactMissing) {
    notKnown.push("No CRM contact on this job.");
  } else if (f && f.unplaced_for_contact.count > 0) {
    const n = f.unplaced_for_contact.count;
    notKnown.push(
      `${n} ${n === 1 ? "message" : "messages"} from this customer ${
        n === 1 ? "is" : "are"
      } not placed on any job.`,
    );
  }

  return {
    version: JOB_STATE_CARD_VERSION,
    lines,
    not_known: notKnown,
    brief,
  };
}

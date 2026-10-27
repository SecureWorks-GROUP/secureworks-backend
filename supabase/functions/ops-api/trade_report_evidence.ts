// A submitted trade service report reaches the context system as evidence on
// its own job (context gap: the job story could not say what the crew did).
//
// One business_events row per submitted report wording, written ONLY through
// capture_business_event (AGENTS.md "New Evidence Code Writes Through
// capture_business_event"):
//   * channel 'note', event_type 'note.trade_report', direction 'internal':
//     context_ledger_message_kind admits channel 'note' and the type is outside
//     its excluded record prefixes and context_event_status_only's list
//     ('trade.%' would be status-only, so it is deliberately NOT trade.*).
//   * job_id + match_method 'direct_job_id': the ladder keeps a writer's direct
//     job, as the document text reader (context-document-text/read.ts) relies on.
//   * provider_message_id `job_service_report:<report id>:<sha256 prefix of the
//     words>`: a retry or a resumed submit is a duplicate (no second row); a
//     report re-submitted after unlock_makesafe_report with different words is
//     a new row, so the edited narrative is not silently dropped. A backfill
//     built from the stored row yields the same key.
//   * words: the trade's narrative fields only. Never labour hours, trade
//     count, materials, invoice notes, variations or the signature; phone
//     numbers, email addresses and dollar amounts in the free text are removed.
//
// Best effort: the caller awaits it after the durable report write and the
// result never changes the submit. Logs carry ids and outcome codes, never words.

export const TRADE_REPORT_EVENT_TYPE = "note.trade_report";
export const TRADE_REPORT_SOURCE = "ops-api:trade-service-report";
export const TRADE_REPORT_KEY_PREFIX = "job_service_report:";
export const TRADE_REPORT_WRITER = "ops-api:trade-report-evidence";

const EXCERPT = 500;
const MAX_FIELD = 4000;

/** Make-safe checklist narrative keys, in reading order, with their labels. */
const MAKESAFE_NARRATIVE: ReadonlyArray<readonly [string, string]> = [
  ["damage_description", "Damage found"],
  ["damage_cause", "Cause"],
  ["work_done", "Work done"],
  ["access_issues", "Access issues"],
];

export interface TradeReportRow {
  id?: unknown;
  job_id?: unknown;
  status?: unknown;
  submitted_at?: unknown;
  checklist_json?: unknown;
  notes?: unknown;
  cycle_number?: unknown;
  attendance_cycle_id?: unknown;
}

const PHONE_RE = /(?:\+?61[\s-]?|\(?0)\(?[2-478]\)?(?:[\s-]?\d){8}\b|\b1[38]00(?:[\s-]?\d){6}\b|\b04\d{2}(?:[\s-]?\d){6}\b/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MONEY_RE = /(?:AU)?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|ex|inc|\+\s?gst))?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|aud)\b/gi;

/** Free text with contact details and money taken out, whitespace tidied. */
export function scrubTradeReportText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(EMAIL_RE, "[email removed]")
    .replace(MONEY_RE, "[amount removed]")
    .replace(PHONE_RE, "[phone removed]")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_FIELD);
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** The labelled narrative sections of a report, empty when it has no words. */
export function tradeReportSections(
  report: TradeReportRow,
): Array<{ field: string; label: string; text: string }> {
  const out: Array<{ field: string; label: string; text: string }> = [];
  const checklist = report.checklist_json;
  const isObject = checklist !== null && typeof checklist === "object" &&
    !Array.isArray(checklist);
  const seen = new Set<string>();
  if (isObject) {
    const c = checklist as Record<string, unknown>;
    for (const [field, label] of MAKESAFE_NARRATIVE) {
      const text = scrubTradeReportText(c[field]);
      if (text) {
        out.push({ field, label, text });
        seen.add(text);
      }
    }
    if (c.follow_up_required === true) {
      out.push({ field: "follow_up_required", label: "Follow-up required", text: "yes" });
    }
  }
  // submit_makesafe_report defaults notes to work_done: never say it twice.
  const notes = scrubTradeReportText(report.notes);
  if (notes && !seen.has(notes)) out.push({ field: "notes", label: "Notes", text: notes });
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type TradeReportSkip = "not_submitted" | "no_ids" | "no_words";

/**
 * The capture_business_event row for a submitted report, or the reason there
 * is none. Pure apart from hashing; the same stored row always builds the same
 * row, so the live hook and a backfill agree on the key.
 */
export async function buildTradeReportEvidenceRow(
  report: TradeReportRow,
  captureMode: "live" | "backfill" = "live",
): Promise<{ row: Record<string, unknown> } | { skip: TradeReportSkip }> {
  if (str(report.status) !== "submitted" && str(report.status) !== "approved") {
    return { skip: "not_submitted" };
  }
  const reportId = str(report.id).trim();
  const jobId = str(report.job_id).trim();
  if (!reportId || !jobId) return { skip: "no_ids" };
  const sections = tradeReportSections(report);
  if (!sections.length) return { skip: "no_words" };
  const body = sections.map((s) => `${s.label}: ${s.text}`).join("\n\n");
  const header =
    "[Trade service report: the crew's own words from the Trade App report, submitted after attending site. Not a message to or from the customer.]";
  const words = `${header}\n\n${body}`;
  const hash = await sha256Hex(body);
  const submittedAt = str(report.submitted_at).trim() || null;
  return {
    row: {
      event_type: TRADE_REPORT_EVENT_TYPE,
      source: TRADE_REPORT_SOURCE,
      entity_type: "job_service_report",
      entity_id: reportId,
      job_id: jobId,
      match_method: "direct_job_id",
      event_at: submittedAt,
      provider_message_id: `${TRADE_REPORT_KEY_PREFIX}${reportId}:${hash.slice(0, 16)}`,
      channel: "note",
      direction: "internal",
      thread_key: null,
      body_preview: body.slice(0, EXCERPT),
      safe_summary: `[Trade service report, ${sections.length} section${
        sections.length === 1 ? "" : "s"
      }, ${body.length} characters.]`,
      privacy_classification: "staff_only",
      retention_class: "7y_audit",
      payload: {
        words: true,
        channel: "note",
        text: words,
        job_id: jobId,
        from_name: "Trade crew (service report)",
        service_report: {
          id: reportId,
          fields: sections.map((s) => s.field),
          cycle_number: report.cycle_number ?? null,
          attendance_cycle_id: report.attendance_cycle_id ?? null,
          words_sha256: hash,
        },
        event_at_source: submittedAt ? "submitted_at" : "missing",
      },
      metadata: { capture_mode: captureMode, writer: TRADE_REPORT_WRITER },
    },
  };
}

export interface TradeReportCaptureResult {
  outcome: string;
  code?: string;
  id?: string;
}

/** Best effort: never throws; the submit's own result never depends on it. */
export async function captureTradeReportEvidence(
  client: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> },
  report: TradeReportRow,
): Promise<TradeReportCaptureResult> {
  let result: TradeReportCaptureResult;
  try {
    const built = await buildTradeReportEvidenceRow(report, "live");
    if ("skip" in built) {
      result = { outcome: "skipped", code: built.skip };
    } else {
      const { data, error } = await client.rpc("capture_business_event", { p_row: built.row });
      if (error) {
        const code = (error as { code?: unknown })?.code;
        result = { outcome: "error", code: typeof code === "string" && code ? code : "rpc_error" };
      } else if (!data || typeof data !== "object") {
        result = { outcome: "error", code: "rpc_no_result" };
      } else {
        const d = data as Record<string, unknown>;
        result = {
          outcome: str(d.outcome) || "unknown",
          ...(typeof d.code === "string" ? { code: d.code } : {}),
          ...(typeof d.id === "string" ? { id: d.id } : {}),
        };
      }
    }
  } catch {
    result = { outcome: "error", code: "threw" };
  }
  console.log(
    `[ops-api] trade_report_evidence report=${str(report.id) || "-"} job=${str(report.job_id) || "-"} outcome=${result.outcome} code=${result.code ?? "-"}`,
  );
  return result;
}

// deno-lint-ignore-file no-explicit-any
// Dispatch slice 1: the read-side additions the Ops screen's Dispatch tab needs.
// Contract: docs/dispatch-slice-1-read-contract.md.
//
// Everything here is pure. `pipeline` and `job_notes` in index.ts own the reads;
// this module owns what they project and derive, so the rules are testable
// without a database.

export const DISPATCH_LIST_PARAM = "dispatch";
export const DISPATCH_LIST_ON = "1";

// Opt-in, like the fencing stage-truth flag: with the param absent `pipeline`
// keeps its selects, row set and row keys exactly as they were.
export function isDispatchListRequested(
  params: { get(name: string): string | null },
): boolean {
  return params.get(DISPATCH_LIST_PARAM) === DISPATCH_LIST_ON;
}

// "Accepted work": every pipeline status except draft and quoted (cancelled and
// lost were never in the pipeline set). The floor is also what bounds the scope
// projection below: draft and quoted rows hold the heaviest scope blobs
// (measured 12 Oct 2026: 4.9 s to project every pipeline row against 0.43 s for
// these statuses), so widening this list is a cost change, not only a row change.
export const DISPATCH_LIST_STATUSES = [
  "partially_accepted",
  "accepted",
  "awaiting_deposit",
  "deposit",
  "approvals",
  "order_materials",
  "processing",
  "awaiting_supplier",
  "order_confirmed",
  "schedule_install",
  "scheduled",
  "in_progress",
  "rectification",
  "complete",
  "final_payment",
  "invoiced",
  "get_review",
  "archived",
];

// Make-safe jobs are not listed on Dispatch; they are reachable by search only.
export const DISPATCH_UNLISTED_TYPE = "makesafe";

// jobs.scope_json must never be selected across a list (AGENTS.md: it averages
// ~100 kB a row). These five paths are the whole input of the description line.
// Every path is one more detoast of the blob per row, so add one only with a
// measurement. `->` keeps JSON types, as the pricing projection does.
export const DISPATCH_SCOPE_PROJECTION = [
  "ds_runs:scope_json->job->runs",
  "ds_gates:scope_json->job->gates",
  "ds_colour:scope_json->job->colour",
  "ds_profile:scope_json->job->profile",
  "ds_config:scope_json->config",
];

export const DISPATCH_SCOPE_ALIASES = DISPATCH_SCOPE_PROJECTION.map(
  (projection) => projection.slice(0, projection.indexOf(":")),
);

export function stripDispatchScopeAliases(row: any) {
  const leanRow: Record<string, any> = { ...row };
  for (const alias of DISPATCH_SCOPE_ALIASES) delete leanRow[alias];
  return leanRow;
}

function cleanText(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

// One decimal at most, and no trailing ".0": 42 -> "42", 12.5 -> "12.5".
function plainNumber(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function measure(value: unknown): string {
  const text = cleanText(value);
  if (!text) return "";
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? plainNumber(parsed) : "";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function fenceLine(row: any): string | null {
  const runs = Array.isArray(row?.ds_runs) ? row.ds_runs : [];
  const gates = Array.isArray(row?.ds_gates) ? row.ds_gates : [];
  if (runs.length === 0 && gates.length === 0) return null;
  const metres = runs.reduce(
    (sum: number, run: any) => sum + (parseFloat(run?.length) || 0),
    0,
  );
  const head = [
    metres > 0 ? `${plainNumber(metres)}m` : "",
    cleanText(row?.ds_colour),
    cleanText(row?.ds_profile),
    "fence",
  ].filter(Boolean).join(" ");
  const tail = [
    runs.length > 1 ? plural(runs.length, "run") : "",
    gates.length > 0 ? plural(gates.length, "gate") : "",
  ].filter(Boolean);
  return [head, ...tail].join(", ");
}

function patioLine(row: any): string | null {
  const config = row?.ds_config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const length = measure(config.length);
  const projection = measure(config.projection);
  const size = length && projection ? `${length}m × ${projection}m` : "";
  const roofStyle = cleanText(config.roofStyle);
  if (!size && !roofStyle) return null;
  const head = [size, roofStyle, "patio"].filter(Boolean).join(" ");
  const roofing = cleanText(config.roofing || config.panel_type);
  return roofing ? `${head}, ${roofing}` : head;
}

// The one-line job description for a card and the job header, built from the
// same scope fields the Ops screen's renderScopeSummary reads. Shape decides,
// not job type: a repair job scoped in the fence tool reads as a fence. Null
// when the scope holds nothing to describe; never a placeholder.
export function dispatchJobDescription(row: any): string | null {
  return fenceLine(row) || patioLine(row);
}

// `value` is pricing_json.totalIncGST, falling back to the unlabelled
// pricing_json.total (pipelinePricingProjectionValues). True only when the
// figure shown is the first one, so "inc GST" is never printed on the fallback.
export function dispatchValueIncGst(row: any): boolean {
  return !!row?.pj_total_inc;
}

function noteDetail(event: any): Record<string, any> {
  const detail = event?.detail_json;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    return detail;
  }
  if (typeof detail !== "string") return {};
  try {
    const parsed = JSON.parse(detail);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { text: detail };
  } catch (_) {
    return { text: detail };
  }
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export type DispatchJobNote = {
  id: string;
  text: string;
  author: string | null;
  user_id: string | null;
  created_at: string;
  visibility: string | null;
  from_ops: boolean;
};

// One job_events note row as the screen shows it. The body falls back through
// the keys older writers used (the Ops screen's own readers do the same), and
// the author is the linked user's name, else a name the writer stored, else null:
// most notes were written with a server key and carry no user.
export function projectDispatchJobNote(event: any): DispatchJobNote {
  const detail = noteDetail(event);
  return {
    id: event?.id,
    text: firstText(detail.text, detail.note, detail.note_text, detail.message),
    author: firstText(event?.users?.name, detail.author) || null,
    user_id: event?.user_id || null,
    created_at: event?.created_at,
    visibility: typeof detail.visibility === "string"
      ? detail.visibility
      : null,
    from_ops: detail.from_ops === true,
  };
}

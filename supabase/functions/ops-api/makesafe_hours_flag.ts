// ── Make-safe hours-flag: baseline resolver + soft-flag annotation (M4 U1) ──
//
// Mission: profit-trade-invoice-intelligence-2026-07-03 (campaign
// profitability-job-costing, M4). Wiki issue #112. This module is the pure,
// unit-testable heart of the trade-invoice hours control: for a make-safe
// labour line it resolves the ALLOWED hours from a small, pluggable source
// registry, then decides whether the CHARGED hours exceed that allowance.
//
// Rules locked by Marnin:
//   • 2026-06-19: make-safe baseline = 2hr minimum; SUBMIT-not-block (a flag
//     never rejects the invoice); one review email per flagged invoice.
//   • 2026-07-04: the allowed value comes from a BASELINE RESOLVER — the job's
//     own reporting/allocation first (report sign-off expectation, e.g.
//     "2 trades x 2 hours"; ops-set expectation) when present AND trusted,
//     else the system rule default (2hr). Whatever we invoice the BUILDER /
//     client NEVER auto-raises the trade allowance — builder amounts are never
//     a candidate here (they are simply never passed in).
//
// Design invariants (adversarial-review findings, contract §7):
//   • #6 Activation is STRUCTURED ONLY (jobs.type='makesafe' / division). The
//     SWMS- job-number prefix is corroboration to LOG, never the required
//     filter — a make-safe line missing the prefix must still flag.
//   • #7 The Xero bill-Reference marker is the EXACT string `| HOURS-FLAG`.
//     Any replacement requires a contract amendment.
//   • This module NEVER changes $/hours/rates and NEVER blocks a submit. It
//     only produces annotation + flag-fact values for the caller to attach.
//
// index.ts (generate_trade_invoice) is excluded from deno fmt/lint and cannot
// be unit-tested against the DB, so ALL branching logic lives here where it is
// covered by makesafe_hours_flag_test.ts. The caller only gathers inputs and
// attaches outputs — identically on BOTH submit paths (clocked/assigned
// jobGroups AND searched-in extras).

// ─────────────────────────────────────────────────────────────────────────
// TUNING POINT #1 — source TRUST config.
//
// CP1 tunes THIS object (and ALLOWANCE_PRECEDENCE / RULE_DEFAULT_MIN_HOURS),
// not the resolver code below. Each source the resolver may draw an allowance
// from is listed with whether it is trusted enough to RAISE the allowance
// above the rule default:
//   • ops_set — the office-set expectation. NOT WIRED: the intended field
//     (work_orders.estimated_hours) does not exist in the schema and nothing
//     writes it, so index.ts always yields null here (job_assignments carries
//     only hours_worked, which is the CHARGED value, not an allowance).
//     TRUSTED by default per Marnin's 2026-07-04 ruling once a source exists:
//     it is set by the office, not the trade.
//   • report — the trade's OWN completion report
//     (job_service_reports.checklist_json: trade_count × labour_hours). NOT
//     trusted yet: the June 2026 finding was that self-reported trade_count is
//     unreliable. CP1 decides if/when to trust it and by what exact formula.
//
// The SECOND tuning point — which DB field feeds each source's VALUE — lives
// in index.ts (fetchMakesafeAllowanceInputs). CP1 can repoint a source's value
// there without touching this registry, and can flip trust here without
// touching the value mapping: two independent knobs, no rewrite.
// ─────────────────────────────────────────────────────────────────────────
export type AllowanceSourceKey = "ops_set" | "report";
export type AllowanceSource = AllowanceSourceKey | "rule_default";

export const ALLOWANCE_SOURCE_TRUST: Record<AllowanceSourceKey, boolean> = {
  ops_set: true,
  report: false,
};

// Precedence order: the first PRESENT and TRUSTED source wins; anything not
// listed falls through to the rule default. Extending the registry (e.g. a
// work-order allowance or out-of-scope rule) is additive — add the key here,
// give it a trust flag above, and have index.ts pass a candidate for it.
export const ALLOWANCE_PRECEDENCE: AllowanceSourceKey[] = ["ops_set", "report"];

// Marnin 2026-06-19: the make-safe minimum. The rule-default fallback allowance.
export const RULE_DEFAULT_MIN_HOURS = 2;

// EXACT marker appended to the Xero bill Reference when any line on the invoice
// is flagged (finding #7 — verbatim, no variants).
export const HOURS_FLAG_MARKER = "| HOURS-FLAG";

// The only flag_type this rule emits today. The registry is shaped so later
// rules (out-of-scope, over-WO-allowance, supplier drift) add their own type.
export const FLAG_TYPE_HOURS_OVER_BASELINE = "hours_over_baseline";

// Charged hours must exceed the allowance by more than this to flag. Guards
// against float noise (e.g. 2.0000001 vs 2) producing a spurious flag.
const HOURS_EPSILON = 0.001;

// ─────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────
export interface AllowanceCandidate {
  source: AllowanceSourceKey;
  // Hours this source expects for the job, or null when the source has no
  // value for this job. Builder/client invoice amounts are NEVER a candidate.
  hours: number | null;
}

export interface ResolvedAllowance {
  allowed_hours: number;
  source: AllowanceSource;
  // Sources that were PRESENT but skipped because untrusted — surfaced so CP1
  // can see what trusting them would change without re-running production.
  skipped_untrusted: AllowanceSourceKey[];
}

export interface ResolveOpts {
  trust?: Record<AllowanceSourceKey, boolean>;
  ruleDefaultHours?: number;
  precedence?: AllowanceSourceKey[];
}

// Resolve the allowed hours for a make-safe line. Walks the precedence list;
// a candidate wins only when it is PRESENT (non-null, > 0) AND trusted per the
// config. Present-but-untrusted candidates are recorded and skipped. Nothing
// trusted/present → the rule default.
export function resolveAllowance(
  candidates: AllowanceCandidate[],
  opts: ResolveOpts = {},
): ResolvedAllowance {
  const trust = opts.trust ?? ALLOWANCE_SOURCE_TRUST;
  const ruleDefault = opts.ruleDefaultHours ?? RULE_DEFAULT_MIN_HOURS;
  const precedence = opts.precedence ?? ALLOWANCE_PRECEDENCE;

  const byKey = new Map<AllowanceSourceKey, AllowanceCandidate>();
  for (const c of candidates) {
    if (c && !byKey.has(c.source)) byKey.set(c.source, c);
  }

  const skipped: AllowanceSourceKey[] = [];
  for (const key of precedence) {
    const cand = byKey.get(key);
    const present = cand != null && cand.hours != null &&
      Number.isFinite(cand.hours) && (cand.hours as number) > 0;
    if (!present) continue;
    if (!trust[key]) {
      skipped.push(key);
      continue;
    }
    return {
      allowed_hours: cand!.hours as number,
      source: key,
      skipped_untrusted: skipped,
    };
  }
  return {
    allowed_hours: ruleDefault,
    source: "rule_default",
    skipped_untrusted: skipped,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Activation (structured only — finding #6)
// ─────────────────────────────────────────────────────────────────────────
export interface MakeSafeActivationInput {
  jobType?: string | null; // jobs.type — canonical structured selector
  division?: string | null; // line/job division — structured corroborator
  lineType?: string | null; // trade_invoice_lines.line_type — structured
}

// True when the line is a make-safe line, by STRUCTURED signals only:
// jobs.type='makesafe' (canonical), or a make-safe division, or line_type
// 'make safe'. The SWMS- job-number prefix is NEVER consulted here.
export function isMakeSafeLine(input: MakeSafeActivationInput): boolean {
  const type = (input.jobType ?? "").trim().toLowerCase();
  if (type === "makesafe" || type === "make safe" || type === "make_safe") {
    return true;
  }

  const div = (input.division ?? "").trim().toLowerCase().replace(
    /[\s_-]/g,
    "",
  );
  if (div === "makesafe") return true;

  const lt = (input.lineType ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
  if (lt === "makesafe") return true;

  return false;
}

// Corroboration ONLY — logged next to a flag, never gates activation. A make-safe
// line without this prefix still flags (that is the whole point of finding #6).
export function hasSwmsPrefix(jobNumber?: string | null): boolean {
  return /^SWMS-/i.test((jobNumber ?? "").trim());
}

// ─────────────────────────────────────────────────────────────────────────
// Flag evaluation + annotation builders
// ─────────────────────────────────────────────────────────────────────────

// Persisted per-line flag facts (U4 field contract). Set on the
// trade_invoice_lines row by the caller. baseline_hours/baseline_source are
// recorded for EVERY make-safe line (so the U5 report can show allowed-vs-
// charged even within allowance); flag_type/hours_justification/flagged_at are
// set only when the line actually flags.
export interface FlagLineFields {
  flag_type: string | null;
  baseline_hours: number;
  baseline_source: AllowanceSource;
  hours_justification: string | null;
  flagged_at: string | null;
}

export interface HoursFlagInput {
  chargedHours: number;
  candidates: AllowanceCandidate[];
  justification?: string | null;
  trust?: Record<AllowanceSourceKey, boolean>;
  ruleDefaultHours?: number;
}

export interface HoursFlagOutcome {
  flagged: boolean;
  allowed_hours: number;
  allowed_source: AllowanceSource;
  charged_hours: number;
  justification: string | null;
  skipped_untrusted: AllowanceSourceKey[];
  // Fields to persist on the trade_invoice_lines row.
  lineFields: FlagLineFields;
  // Human review note for trade_invoice_lines.query_note (null when not flagged
  // so the caller keeps its existing rate note).
  queryNote: string | null;
  // Extra line to append to the Xero draft-bill line Description (null when not
  // flagged). Quantity/UnitAmount are untouched by this module.
  xeroDescriptionLine: string | null;
}

function roundHours(h: number): number {
  return Math.round((Number(h) || 0) * 100) / 100;
}

// Evaluate a single make-safe line. `nowIso` is injectable for deterministic
// tests. This function makes NO decision about $/hours/rates and never signals
// "block" — a flagged line still submits.
export function evaluateHoursFlag(
  input: HoursFlagInput,
  nowIso: string = new Date().toISOString(),
): HoursFlagOutcome {
  const charged = roundHours(input.chargedHours);
  const resolved = resolveAllowance(input.candidates, {
    trust: input.trust,
    ruleDefaultHours: input.ruleDefaultHours,
  });
  const allowed = resolved.allowed_hours;
  const justification = (input.justification ?? null) || null;

  const flagged = charged > allowed + HOURS_EPSILON;

  const lineFields: FlagLineFields = {
    flag_type: flagged ? FLAG_TYPE_HOURS_OVER_BASELINE : null,
    baseline_hours: allowed,
    baseline_source: resolved.source,
    hours_justification: flagged ? justification : null,
    flagged_at: flagged ? nowIso : null,
  };

  return {
    flagged,
    allowed_hours: allowed,
    allowed_source: resolved.source,
    charged_hours: charged,
    justification,
    skipped_untrusted: resolved.skipped_untrusted,
    lineFields,
    queryNote: flagged
      ? buildLineQueryNote(charged, allowed, resolved.source, justification)
      : null,
    xeroDescriptionLine: flagged
      ? buildXeroDescriptionLine(justification)
      : null,
  };
}

// Human-readable label for a resolved source, for review surfaces.
export function describeSource(source: AllowanceSource): string {
  switch (source) {
    case "ops_set":
      return "ops-set expectation";
    case "report":
      return "trade report expectation";
    case "rule_default":
      return "rule default (2hr minimum)";
  }
}

// The line query_note in the Allowed / Charged / Justification shape (aligned
// with the finance-email format Marnin ruled 2026-07-04). Ops verifies before
// approving the Xero draft.
export function buildLineQueryNote(
  chargedHours: number,
  allowedHours: number,
  source: AllowanceSource,
  justification: string | null,
): string {
  const charged = roundHours(chargedHours);
  const allowed = roundHours(allowedHours);
  const reason = justification && justification.trim()
    ? justification.trim()
    : "no explanation provided";
  return "HOURS-FLAG: allowed " + allowed + "h (" + describeSource(source) +
    ") · charged " + charged + "h · trade's explanation: " + reason +
    ". Verify before approving the Xero draft.";
}

// The extra Xero draft-bill Description line so finance sees the flag inline
// when approving. Quantity/UnitAmount unchanged.
export function buildXeroDescriptionLine(justification: string | null): string {
  return justification && justification.trim()
    ? "HOURS-FLAG (over allowance): " + justification.trim()
    : "HOURS-FLAG (over allowance): no explanation provided";
}

// Append the exact `| HOURS-FLAG` marker to a Xero bill Reference when any line
// on the invoice flagged. Idempotent — never doubles the marker.
export function appendHoursFlagMarker(
  reference: string,
  anyFlagged: boolean,
): string {
  if (!anyFlagged) return reference;
  if (reference.includes(HOURS_FLAG_MARKER)) return reference;
  return reference + " " + HOURS_FLAG_MARKER;
}

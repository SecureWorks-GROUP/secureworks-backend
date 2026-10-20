// Patio expected versus actual (CFO, Sales SQ-29). Contract:
// docs/job-profit-patio-expected.md.
//
// The patio scoper 2.0 saves one sealed revision to the job (`scope_json`,
// tool `patio-scoper`) with `expected: { materials, labour, sale }`: ex-GST
// figures from the scoper's own price build, each `null` when any price behind
// it is not known (scope-engine-v2 `patio/scoper/src/money.ts`, `build()`).
// This reads that block for ONE job and sets it beside the job's actual cost
// lanes and invoices from v_job_profit. It never writes, and it never feeds an
// expected figure into v_job_profit: expected figures are never actuals.
//
// The rules (CFO receipt to Sales, 20 Oct 2026):
// - `null` is not known. It is never summed as 0, and it gives no variance.
// - No expected cost, profit or margin while any lane it needs is `null`, the
//   family is not supported (`supported` false or not stated), or the scoper
//   did not confirm the quote, order and work order agree (`outputsAgree`).
// - `supported: false` gives no expected sale.
// - A lane's variance is shown only when the job's actual for that lane is
//   complete: an unlinked, ordered-not-billed or emailed-not-placed material,
//   or missing or unapproved labour, would read as a false saving.
//
// Where it reads from: `jobs.scope_json` holds only the last save (save_scope
// replaces it whole), so this is the CURRENT revision only. A parent revision
// is named, never readable, and nothing in the job system freezes the record
// yet (Sales owns that route). So the figures carry their revision (`n`,
// `frozenId`) and are compared with the job's sent quote: when the expected
// sale and the sent quote disagree, the saved revision is not the one quoted
// and the comparison says so.
//
// The record carries no commission, so the expected profit is before
// commission; the actual side carries commission as its own lane.

const SALE_MATCH_TOLERANCE_EX = 1;

export const PATIO_EXPECTED_SCOPE_PROJECTION =
  "ptool:scope_json->tool, prev:scope_json->revision, psup:scope_json->supported, pexp:scope_json->expected";

export interface PatioExpectedRevision {
  n: number | null;
  frozen_id: string | null;
  scope_revision_id: string | null;
  parent_revision_id: string | null;
  sealed_at: string | null;
  outputs_agree: boolean | null;
  source: "jobs.scope_json_last_save";
  parent_readable: false;
  frozen_in_job_system: false;
}

export interface PatioLane {
  expected_ex: number | null;
  actual_ex: number | null;
  actual_complete: boolean;
  variance_ex: number | null;
}

export interface PatioExpectedVersusActual {
  status: "complete" | "incomplete";
  revision: PatioExpectedRevision;
  supported: boolean | null;
  expected: {
    materials_ex: number | null;
    labour_ex: number | null;
    sale_ex: number | null;
    cost_ex: number | null;
    profit_before_commission_ex: number | null;
    margin_before_commission_pct: number | null;
  };
  lanes: { materials: PatioLane; labour: PatioLane };
  actual: {
    commission_ex: number | null;
    other_ex: number | null;
    cost_ex: number | null;
    invoiced_ex: number | null;
    profit_ex: number | null;
    margin_pct: number | null;
  };
  sent_quote_ex: number | null;
  sale_matches_sent_quote: boolean | null;
  flags: string[];
  basis: string;
}

const BASIS =
  "Expected figures are the patio scoper's own sealed revision (ex GST), read from the job's last save only. They are never actuals and never enter Job Profit. null is not known, never 0. The expected profit is before commission.";

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

function money(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function actualNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Completeness flags (v_job_profit) that leave a lane's actual not known.
const MATERIALS_ACTUAL_OPEN = [
  "no_cost_linked",
  "materials_not_linked",
  "open_purchase_orders",
  "ordered_not_billed",
  "invoice_emailed_bill_not_placed",
  "unclassified_lines",
  "incomplete_invoice_lines",
  "xero_project_exceeds_line_costs",
];
const LABOUR_ACTUAL_OPEN = [
  "no_cost_linked",
  "no_labour_linked",
  "unapproved_trade_charges",
  "unclassified_lines",
  "incomplete_invoice_lines",
  "xero_project_exceeds_line_costs",
];

/**
 * The patio record's expected figures beside the engine row's actuals, or null
 * when the job's scope is not a patio scoper 2.0 record. `scope` is the
 * projected read (PATIO_EXPECTED_SCOPE_PROJECTION); `row` is the job's
 * v_job_profit row.
 */
export function patioExpectedVersusActual(
  scope: Record<string, unknown> | null,
  row: Record<string, unknown>,
): PatioExpectedVersusActual | null {
  if (!scope || scope.ptool !== "patio-scoper") return null;
  const rev = obj(scope.prev);
  if (!rev) return null;
  const flags: string[] = [];

  const revision: PatioExpectedRevision = {
    n: typeof rev.n === "number" && Number.isInteger(rev.n) ? rev.n : null,
    frozen_id: text(rev.frozenId),
    scope_revision_id: text(rev.scopeRevisionId),
    parent_revision_id: text(rev.parentRevisionId),
    sealed_at: text(rev.sealedAt),
    outputs_agree: typeof rev.outputsAgree === "boolean"
      ? rev.outputsAgree
      : null,
    source: "jobs.scope_json_last_save",
    parent_readable: false,
    frozen_in_job_system: false,
  };
  if (revision.frozen_id === null || revision.n === null) {
    flags.push("revision_not_sealed");
  }
  if (revision.outputs_agree !== true) flags.push("outputs_not_confirmed");

  const supported = typeof scope.psup === "boolean" ? scope.psup : null;
  if (supported === false) flags.push("family_not_supported");
  if (supported === null) flags.push("supported_not_stated");

  const exp = obj(scope.pexp) ?? {};
  const materials = money(exp.materials);
  const labour = money(exp.labour);
  // supported false: model and scope only, no sale. Not stated: not known.
  const sale = supported === true ? money(exp.sale) : null;
  if (materials === null) flags.push("expected_materials_not_known");
  if (labour === null) flags.push("expected_labour_not_known");
  if (sale === null && supported === true) {
    flags.push("expected_sale_not_known");
  }

  const trusted = revision.outputs_agree === true &&
    !flags.includes("revision_not_sealed");
  const cost = trusted && materials !== null && labour !== null
    ? round2(materials + labour)
    : null;
  const profit = cost !== null && sale !== null ? round2(sale - cost) : null;
  const margin = profit !== null && sale !== null && sale > 0
    ? Math.round(profit / sale * 1000) / 10
    : null;

  const completeness = Array.isArray(row.completeness)
    ? row.completeness.map(String)
    : [];
  const lane = (
    expected: number | null,
    actualRaw: unknown,
    open: string[],
  ): PatioLane => {
    const actual = actualNum(actualRaw);
    const actualComplete = actual !== null &&
      !open.some((f) => completeness.includes(f));
    return {
      expected_ex: trusted ? expected : null,
      actual_ex: actual,
      actual_complete: actualComplete,
      variance_ex: trusted && expected !== null && actualComplete
        ? round2(actual! - expected)
        : null,
    };
  };
  const lanes = {
    materials: lane(materials, row.actual_materials_ex, MATERIALS_ACTUAL_OPEN),
    labour: lane(labour, row.actual_labour_ex, LABOUR_ACTUAL_OPEN),
  };
  if (!lanes.materials.actual_complete) flags.push("actual_materials_open");
  if (!lanes.labour.actual_complete) flags.push("actual_labour_open");

  const quoted = actualNum(row.quoted_ex);
  let saleMatches: boolean | null = null;
  if (quoted === null) flags.push("no_sent_quote");
  else if (sale !== null) {
    saleMatches = Math.abs(sale - quoted) <= SALE_MATCH_TOLERANCE_EX;
    if (!saleMatches) flags.push("expected_sale_differs_from_sent_quote");
  }
  if (row.quote_costs_incomplete === true) flags.push("quote_costs_incomplete");

  const complete = cost !== null && profit !== null && saleMatches === true &&
    lanes.materials.variance_ex !== null && lanes.labour.variance_ex !== null;

  return {
    status: complete ? "complete" : "incomplete",
    revision,
    supported,
    expected: {
      materials_ex: trusted ? materials : null,
      labour_ex: trusted ? labour : null,
      sale_ex: trusted ? sale : null,
      cost_ex: cost,
      profit_before_commission_ex: profit,
      margin_before_commission_pct: margin,
    },
    lanes,
    actual: {
      commission_ex: actualNum(row.actual_commission_ex),
      other_ex: actualNum(row.actual_other_ex),
      cost_ex: actualNum(row.actual_cost_ex),
      invoiced_ex: actualNum(row.invoiced_ex),
      profit_ex: actualNum(row.profit_ex),
      margin_pct: actualNum(row.margin_pct),
    },
    sent_quote_ex: quoted,
    sale_matches_sent_quote: saleMatches,
    flags,
    basis: BASIS,
  };
}

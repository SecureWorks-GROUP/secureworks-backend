// Patio expected versus actual (CFO, Sales SQ-29). Contract:
// docs/job-profit-patio-expected.md.
//
// The patio scoper 2.0 seals a revision, saves it to the job (`save_scope`,
// `scope_json` tool `patio-scoper`) and freezes it (`freeze_scope`,
// `scope_revisions` tool_kind `patio`). Its `expected: { materials, labour,
// sale }` are ex-GST figures from the scoper's own price build, each `null`
// when any price behind it is not known (scope-engine-v2
// `patio/scoper/src/money.ts`, `build()`). This reads them for ONE job and
// sets them beside the job's actual cost lanes and invoices from v_job_profit.
// It never writes, and it never feeds an expected figure into v_job_profit:
// expected figures are never actuals.
//
// Three things are kept apart and never mixed (Sales revision contract,
// company-os/sales-scoping-integration-20261020.md):
// - current_estimate: the job's last save (jobs.scope_json). A draft: shown,
//   never compared with actuals.
// - frozen_scope: the job's frozen scope_revisions row (status frozen; earlier
//   ones are superseded and kept). The ONLY source compared with actuals. Its
//   server id and revision_number are not the tool's frozenId, which is
//   reported apart. Whether the last save is still the frozen revision is
//   decided by the hashes freeze_scope stores (scope_hash, pricing_hash over
//   the canonical jobs.scope_json / pricing_json), never by matching ids
//   (Sales final revision contract,
//   company-os/sales-final-revision-contract-20261020.md).
// - commercial_baseline: the engine's own expected cost (v_job_profit
//   expected_source: frozen at acceptance, or an accepted or sent quote
//   revision), passed through untouched.
//
// The rules (CFO receipt to Sales, 20 Oct 2026):
// - `null` is not known. It is never summed as 0, and it gives no variance.
// - No expected cost, profit or margin while any lane it needs is `null`, the
//   family is not supported, the scoper did not confirm the quote, order and
//   work order agree (`outputsAgree`), or the frozen pricing is not complete
//   (`pricing_complete`, `internal.costs_complete`, `revision.sealed`,
//   `sell_to_confirm`).
// - `supported: false` gives no expected sale.
// - A lane's variance is shown only when the job's actual for that lane is
//   complete: an unlinked, ordered-not-billed or emailed-not-placed material,
//   or missing or unapproved labour, would read as a false saving.
// - An installer bill no recorded person confirmed (JP-12, #1107
//   20261020181800; person rule 20261021173000) holds BOTH lanes open: the
//   engine leaves its labour lines and any materials lines on the same bill
//   out of actual cost and flags installer_bill_unconfirmed. An engine without
//   JP-12 never raises that flag, so its absence is not known, never
//   confirmed: the caller says whether the rule is there (installerCheck),
//   and this reader gives no variance until it is. It must land after #1107.
// The record carries no commission, so the expected profit is before
// commission; the actual side carries commission as its own lane.

import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts";

const SALE_MATCH_TOLERANCE_EX = 1;

export const PATIO_EXPECTED_SCOPE_PROJECTION =
  "ptool:scope_json->tool, prev:scope_json->revision, psup:scope_json->supported, pexp:scope_json->expected";

export const PATIO_FROZEN_REVISION_COLUMNS =
  "id, revision_number, status, tool_kind, tool_version, frozen_at, scope_hash, pricing_hash, scope_canonical_text, pricing_canonical_text";

// The whole last save, read for one patio job only, to hash it the way
// freeze_scope does.
export const PATIO_LAST_SAVE_HASH_COLUMNS = "scope_json, pricing_json";

export interface LastSaveHashes {
  scope_hash: string | null;
  pricing_hash: string | null;
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * The last save's hashes, computed exactly as freeze_scope computes the frozen
 * row's (canonicalJsonAndHash over the raw column). A value that is not an
 * object gets no hash.
 */
export async function lastSaveHashes(
  row: Record<string, unknown> | null,
): Promise<LastSaveHashes> {
  const hashOf = async (v: unknown) =>
    obj(v) ? (await canonicalJsonAndHash(v)).hash : null;
  return {
    scope_hash: await hashOf(row?.scope_json),
    pricing_hash: await hashOf(row?.pricing_json),
  };
}

export interface ToolRevision {
  n: number | null;
  frozen_id: string | null;
  scope_revision_id: string | null;
  parent_revision_id: string | null;
  sealed_at: string | null;
  outputs_agree: boolean | null;
}

export interface ExpectedFigures {
  materials_ex: number | null;
  labour_ex: number | null;
  sale_ex: number | null;
  cost_ex: number | null;
  profit_before_commission_ex: number | null;
  margin_before_commission_pct: number | null;
}

export interface PatioLane {
  expected_ex: number | null;
  actual_ex: number | null;
  actual_complete: boolean;
  variance_ex: number | null;
}

export interface PatioExpectedVersusActual {
  status: "complete" | "incomplete";
  current_estimate: {
    label: "draft_current_estimate";
    source: "jobs.scope_json_last_save";
    tool_revision: ToolRevision;
    supported: boolean | null;
    expected: ExpectedFigures;
  } | null;
  frozen_scope: {
    label: "frozen_scope";
    source: "scope_revisions";
    server_revision: {
      id: string;
      revision_number: number | null;
      status: "frozen";
      frozen_at: string | null;
      tool_version: string | null;
    };
    tool_revision: ToolRevision;
    supported: boolean | null;
    pricing: {
      pricing_complete: boolean | null;
      costs_complete: boolean | null;
      sealed: boolean | null;
      // null: the list is missing, so not known (never read as empty)
      sell_to_confirm: number | null;
      costs_to_confirm: string[];
    };
    // A frozen revision is not an accepted one (Sales contract, "What a
    // freeze is not"): only recorded acceptance on the job lets it be compared
    // with actuals. Job level, because no record links a frozen revision to
    // the quote that was accepted.
    acceptance: FrozenAcceptance & { scope: "job" };
    expected: ExpectedFigures;
    // Compared by hash (scope_hash, pricing_hash), never by id. null: not
    // compared (the last save or a stored hash could not be read).
    last_save_matches_frozen: boolean | null;
    scope_hash_match: boolean | null;
    pricing_hash_match: boolean | null;
  } | null;
  commercial_baseline: {
    label: "commercial_baseline";
    source: string | null;
    accepted: boolean;
    labour_ex: number | null;
    materials_ex: number | null;
    commission_ex: number | null;
    cost_ex: number | null;
  };
  // expected (frozen scope only) beside actual (engine)
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
  "Expected figures are the patio scoper's own sealed revision (ex GST). Only the frozen scope revision is compared with actuals, and only once the job has recorded acceptance (a quote's accepted_at or an accepted run): a freeze is not an acceptance; the last save is a draft estimate and the commercial baseline is the engine's own. Expected figures are never actuals and never enter Job Profit. null is not known, never 0. The expected profit is before commission.";

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

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseJson(s: unknown): Record<string, unknown> | null {
  if (typeof s !== "string") return null;
  try {
    return obj(JSON.parse(s));
  } catch {
    return null;
  }
}

function toolRevision(rev: Record<string, unknown>): ToolRevision {
  return {
    n: typeof rev.n === "number" && Number.isInteger(rev.n) ? rev.n : null,
    frozen_id: text(rev.frozenId),
    scope_revision_id: text(rev.scopeRevisionId),
    parent_revision_id: text(rev.parentRevisionId),
    sealed_at: text(rev.sealedAt),
    outputs_agree: bool(rev.outputsAgree),
  };
}

// One record's figures. No figure is shown at all unless the revision is
// sealed and the scoper confirmed its outputs agree; cost, profit and margin
// also need complete pricing and every lane known.
function figures(
  exp: Record<string, unknown>,
  supported: boolean | null,
  revision: ToolRevision,
  pricingOk: boolean,
): ExpectedFigures {
  const shown = revision.outputs_agree === true &&
    revision.frozen_id !== null && revision.n !== null;
  const materials = shown ? money(exp.materials) : null;
  const labour = shown ? money(exp.labour) : null;
  const sale = shown && supported === true ? money(exp.sale) : null;
  const cost = pricingOk && materials !== null && labour !== null
    ? round2(materials + labour)
    : null;
  const profit = cost !== null && sale !== null ? round2(sale - cost) : null;
  const margin = profit !== null && sale !== null && sale > 0
    ? Math.round(profit / sale * 1000) / 10
    : null;
  return {
    materials_ex: materials,
    labour_ex: labour,
    sale_ex: sale,
    cost_ex: cost,
    profit_before_commission_ex: profit,
    margin_before_commission_pct: margin,
  };
}

// Completeness flags (v_job_profit) that leave a lane's actual not known.
// ordered_not_billed and invoice_emailed_bill_not_placed come from the
// CFO-12 / allocation bodies (20261019120000, 20261020181800), not yet on
// main; listed so they hold the lane the day those land. text_matched_lines
// and xero_project_linked_by_contact_only are not here on purpose: the engine
// marks both informational (the line cost is counted, margin not suppressed).
export const MATERIALS_ACTUAL_OPEN = [
  "no_cost_linked",
  "materials_not_linked",
  "open_purchase_orders",
  "ordered_not_billed",
  "invoice_emailed_bill_not_placed",
  "unclassified_lines",
  "incomplete_invoice_lines",
  "xero_project_exceeds_line_costs",
  "installer_bill_unconfirmed",
];
export const LABOUR_ACTUAL_OPEN = [
  "no_cost_linked",
  "no_labour_linked",
  "unapproved_trade_charges",
  "unclassified_lines",
  "incomplete_invoice_lines",
  "xero_project_exceeds_line_costs",
  "installer_bill_unconfirmed",
];

// The JP-12 rule's own function (#1107, 20261020181800). Present means the
// engine flags an unconfirmed installer bill; absent or unreadable means it
// cannot, so a missing flag says nothing.
export const INSTALLER_RULE_PROBE = "job_cost_installer_bill";

const ACCEPTED_SOURCES = ["frozen_at_acceptance", "accepted_quote_revision"];

/**
 * The job's recorded acceptance: a quote document's `accepted_at`, or a
 * `run_acceptances` row with status `accepted`. `accepted` is null when the
 * evidence could not be read; that holds the comparison like a no.
 */
export type FrozenAcceptance = {
  accepted: boolean | null;
  source: "job_documents.accepted_at" | "run_acceptances" | null;
};

/**
 * The patio record's expected figures beside the engine row's actuals, or null
 * when neither the last save nor the frozen revision is a patio scoper 2.0
 * record. `current` is the projected jobs read (PATIO_EXPECTED_SCOPE_PROJECTION),
 * `frozen` the job's frozen scope_revisions row (PATIO_FROZEN_REVISION_COLUMNS),
 * `row` its v_job_profit row. `installerCheck` is true only when the engine
 * applies JP-12 (INSTALLER_RULE_PROBE answered); anything else holds both
 * lanes open.
 */
export function patioExpectedVersusActual(
  current: Record<string, unknown> | null,
  frozen: Record<string, unknown> | null,
  row: Record<string, unknown>,
  lastSave: LastSaveHashes | null = null,
  installerCheck: boolean | null = null,
  acceptance: FrozenAcceptance | null = null,
): PatioExpectedVersusActual | null {
  const flags: string[] = [];

  // current estimate (the last save): a draft, never compared
  let currentEstimate: PatioExpectedVersusActual["current_estimate"] = null;
  const curRev = current?.ptool === "patio-scoper" ? obj(current.prev) : null;
  if (current && curRev) {
    const revision = toolRevision(curRev);
    const supported = bool(current.psup);
    currentEstimate = {
      label: "draft_current_estimate",
      source: "jobs.scope_json_last_save",
      tool_revision: revision,
      supported,
      expected: figures(obj(current.pexp) ?? {}, supported, revision, true),
    };
  }

  // frozen scope: the only expected side compared with actuals
  let frozenScope: PatioExpectedVersusActual["frozen_scope"] = null;
  const isFrozenPatio = !!frozen && frozen.status === "frozen" &&
    frozen.tool_kind === "patio";
  const fScope = isFrozenPatio ? parseJson(frozen!.scope_canonical_text) : null;
  const fRev = fScope?.tool === "patio-scoper" ? obj(fScope.revision) : null;
  if (isFrozenPatio && !fRev) flags.push("frozen_revision_unreadable");
  if (fScope && fRev) {
    const revision = toolRevision(fRev);
    const supported = bool(fScope.supported);
    const pricing = parseJson(frozen!.pricing_canonical_text) ?? {};
    const internal = obj(pricing.internal) ?? {};
    const pRev = obj(pricing.revision) ?? {};
    // A missing list is not known, never empty (Sales contract quote 2).
    const sellToConfirm = Array.isArray(pricing.sell_to_confirm)
      ? pricing.sell_to_confirm.length
      : null;
    const costsToConfirm = Array.isArray(internal.costs_to_confirm)
      ? internal.costs_to_confirm.filter((x): x is string =>
        typeof x === "string"
      )
      : [];
    const pricingComplete = bool(pricing.pricing_complete);
    const costsComplete = bool(internal.costs_complete);
    const sealed = bool(pRev.sealed);
    // Sales final revision contract: complete only when pricing_complete is
    // true, revision.sealed is true, internal.costs_complete is not false and
    // nothing is left to confirm. A missing flag is not a yes.
    const pricingOk = pricingComplete === true && costsComplete !== false &&
      sealed === true && sellToConfirm === 0;
    if (pricingComplete === false) flags.push("frozen_pricing_incomplete");
    if (pricingComplete === null) {
      flags.push("frozen_pricing_complete_not_stated");
    }
    if (costsComplete === false) flags.push("frozen_costs_incomplete");
    if (sealed === false) flags.push("frozen_pricing_not_sealed");
    if (sealed === null) flags.push("frozen_pricing_seal_not_stated");
    if (sellToConfirm === null) {
      flags.push("frozen_sell_to_confirm_not_stated");
    } else if (sellToConfirm > 0) flags.push("frozen_sell_to_confirm");
    const accepted = acceptance?.accepted ?? null;
    if (accepted === false) flags.push("frozen_not_accepted");
    if (accepted === null) flags.push("frozen_acceptance_not_known");
    if (revision.outputs_agree !== true) flags.push("outputs_not_confirmed");
    if (revision.frozen_id === null || revision.n === null) {
      flags.push("revision_not_sealed");
    }
    if (supported === false) flags.push("family_not_supported");
    if (supported === null) flags.push("supported_not_stated");
    const expected = figures(
      obj(fScope.expected) ?? {},
      supported,
      revision,
      pricingOk,
    );
    if (expected.materials_ex === null) {
      flags.push("expected_materials_not_known");
    }
    if (expected.labour_ex === null) flags.push("expected_labour_not_known");
    if (expected.sale_ex === null && supported === true) {
      flags.push("expected_sale_not_known");
    }
    const match = (stored: unknown, live: string | null | undefined) => {
      const s = text(stored);
      return s === null || !HASH_RE.test(s) || !live ? null : s === live;
    };
    const scopeMatch = match(frozen!.scope_hash, lastSave?.scope_hash);
    const pricingMatch = match(frozen!.pricing_hash, lastSave?.pricing_hash);
    frozenScope = {
      label: "frozen_scope",
      source: "scope_revisions",
      server_revision: {
        id: String(frozen!.id),
        revision_number: actualNum(frozen!.revision_number),
        status: "frozen",
        frozen_at: text(frozen!.frozen_at),
        tool_version: text(frozen!.tool_version),
      },
      tool_revision: revision,
      supported,
      pricing: {
        pricing_complete: pricingComplete,
        costs_complete: costsComplete,
        sealed,
        sell_to_confirm: sellToConfirm,
        costs_to_confirm: costsToConfirm,
      },
      acceptance: {
        accepted,
        source: accepted === true ? acceptance?.source ?? null : null,
        scope: "job",
      },
      expected,
      last_save_matches_frozen: scopeMatch === false || pricingMatch === false
        ? false
        : scopeMatch === true && pricingMatch === true
        ? true
        : null,
      scope_hash_match: scopeMatch,
      pricing_hash_match: pricingMatch,
    };
    if (frozenScope.last_save_matches_frozen === false) {
      flags.push("last_save_not_frozen");
    } else if (frozenScope.last_save_matches_frozen === null) {
      flags.push("last_save_freshness_not_checked");
    }
  }

  if (!currentEstimate && !frozenScope) return null;
  if (!frozenScope) flags.push("revision_not_frozen");

  // Expected lanes for the comparison come only from a frozen scope whose
  // cost is fixed and whose job has recorded acceptance: no lane variance
  // from a revision that fixes no cost or that nobody accepted.
  const fixed = frozenScope?.expected.cost_ex != null &&
      frozenScope.acceptance.accepted === true
    ? frozenScope.expected
    : null;
  // An unreadable completeness list holds both lanes open (fail closed).
  const completenessKnown = Array.isArray(row.completeness);
  const completeness = completenessKnown
    ? (row.completeness as unknown[]).map(String)
    : [];
  if (!completenessKnown) flags.push("actual_completeness_unreadable");
  const installerKnown = installerCheck === true;
  if (!installerKnown) flags.push("installer_confirmation_not_known");
  const lane = (
    expected: number | null,
    actualRaw: unknown,
    open: string[],
  ): PatioLane => {
    const actual = actualNum(actualRaw);
    const actualComplete = actual !== null && completenessKnown &&
      installerKnown && !open.some((f) => completeness.includes(f));
    return {
      expected_ex: expected,
      actual_ex: actual,
      actual_complete: actualComplete,
      variance_ex: expected !== null && actualComplete
        ? round2(actual! - expected)
        : null,
    };
  };
  const lanes = {
    materials: lane(
      fixed?.materials_ex ?? null,
      row.actual_materials_ex,
      MATERIALS_ACTUAL_OPEN,
    ),
    labour: lane(
      fixed?.labour_ex ?? null,
      row.actual_labour_ex,
      LABOUR_ACTUAL_OPEN,
    ),
  };
  if (!lanes.materials.actual_complete) flags.push("actual_materials_open");
  if (!lanes.labour.actual_complete) flags.push("actual_labour_open");

  const quoted = actualNum(row.quoted_ex);
  const sale = frozenScope?.expected.sale_ex ?? null;
  let saleMatches: boolean | null = null;
  if (quoted === null) flags.push("no_sent_quote");
  else if (sale !== null) {
    saleMatches = Math.abs(sale - quoted) <= SALE_MATCH_TOLERANCE_EX;
    if (!saleMatches) flags.push("expected_sale_differs_from_sent_quote");
  }
  if (row.quote_costs_incomplete === true) flags.push("quote_costs_incomplete");

  const baselineSource = text(row.expected_source);
  const complete = fixed !== null &&
    fixed.profit_before_commission_ex !== null && saleMatches === true &&
    lanes.materials.variance_ex !== null && lanes.labour.variance_ex !== null;

  return {
    status: complete ? "complete" : "incomplete",
    current_estimate: currentEstimate,
    frozen_scope: frozenScope,
    commercial_baseline: {
      label: "commercial_baseline",
      source: baselineSource,
      accepted: baselineSource !== null &&
        ACCEPTED_SOURCES.includes(baselineSource),
      labour_ex: actualNum(row.expected_labour_ex),
      materials_ex: actualNum(row.expected_materials_ex),
      commission_ex: actualNum(row.expected_commission_ex),
      cost_ex: actualNum(row.expected_cost_ex),
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

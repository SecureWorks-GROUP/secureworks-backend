// deno-lint-ignore-file no-explicit-any
// Supplier-bill classification for job profit.
//
// Whole job-number tokens only: SWMS, SWP, SWF, SWB, then 5 or 6 digits.
// SWF-2611 does not match inside SWF-261111. A bill that names more than one
// token goes to the split queue and is never auto-linked. Installer accounts
// 301 and 306, trade-app payee bills, and bills that already have a materials
// fact are never proposed as a job link.
//
// This module does not write. scripts/job-profit-bill-match.ts is a dry-run.
// Supplier-bill proposals are written only by xero-sync bill prematch.

export const JOB_NUMBER_RE =
  /(?<![A-Za-z0-9])(SWMS|SWP|SWF|SWB)-(\d{5,6})(?![A-Za-z0-9])/gi;

const TRADE_MIRROR_LINE_RE = /\| SW - [A-Z]/;
const INSTALLER_ACCOUNTS = new Set(["301", "306"]);
const UNPLACEABLE_STATUSES = new Set(["cancelled", "lost", "draft", "quoted"]);

export type BillOutcome =
  | "exact"
  | "split"
  | "unmatched"
  | "ambiguous"
  | "installer_hold"
  | "trade_app"
  | "already_linked"
  | "already_fact";

export type KnownJob = {
  id: string;
  status: string | null;
  holding: boolean;
};

export type BillJobNumberFields = {
  reference: string[];
  lines: string[];
  tracking: string[];
  all: string[];
  matched_text: string | null;
};

export type BillClassification = {
  outcome: BillOutcome;
  job_number: string | null;
  job_id: string | null;
  tokens: string[];
  real_job_numbers: string[];
  matched_text: string | null;
};

export type SupplierBill = {
  xero_invoice_id: string;
  job_id?: string | null;
  reference?: string | null;
  line_items?: unknown;
  trade_mirror?: boolean;
};

export function extractJobNumberTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const re = new RegExp(JOB_NUMBER_RE.source, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push(`${match[1].toUpperCase()}-${match[2]}`);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function lineItemsOf(raw: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(raw)
    ? raw
    : asRecord(raw)?.LineItems ?? asRecord(raw)?.lineItems;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => asRecord(row) !== null) as Record<string, unknown>[];
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function accountCode(item: Record<string, unknown>): string {
  const raw = item.AccountCode ?? item.account_code ?? item.accountCode;
  if (raw === null || raw === undefined) return "";
  return String(raw).trim();
}

/**
 * True when a line uses installer account 301 or 306 and the amount is
 * missing, unreadable, or not an explicit zero. An explicit 0 is not an
 * installer charge.
 */
export function isInstallerBill(lineItems: unknown): boolean {
  for (const item of lineItemsOf(lineItems)) {
    if (!INSTALLER_ACCOUNTS.has(accountCode(item))) continue;
    const raw = item.LineAmount ?? item.line_amount ?? item.lineAmount;
    if (raw === null || raw === undefined || raw === "") return true;
    const amount = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isFinite(amount) || amount !== 0) return true;
  }
  return false;
}

export function billJobNumberFields(bill: {
  reference?: string | null;
  line_items?: unknown;
}): BillJobNumberFields {
  const referenceText = bill.reference ?? "";
  const reference = extractJobNumberTokens(referenceText);
  const lines: string[] = [];
  const tracking: string[] = [];
  let matched = reference.length > 0 ? referenceText : "";
  for (const item of lineItemsOf(bill.line_items)) {
    const description = textOf(item.Description) || textOf(item.description);
    const lineTokens = extractJobNumberTokens(description);
    lines.push(...lineTokens);
    if (!matched && lineTokens.length > 0) matched = description;
    const track = item.Tracking ?? item.tracking;
    if (!Array.isArray(track)) continue;
    for (const entry of track) {
      const row = asRecord(entry);
      if (!row) continue;
      const trackingText = [
        textOf(row.Name),
        textOf(row.name),
        textOf(row.Option),
        textOf(row.option),
      ].filter(Boolean).join(" ");
      const trackingTokens = extractJobNumberTokens(trackingText);
      tracking.push(...trackingTokens);
      if (!matched && trackingTokens.length > 0) matched = trackingText;
    }
  }
  const all = [...new Set([...reference, ...lines, ...tracking])].sort();
  return {
    reference,
    lines,
    tracking,
    all,
    matched_text: matched || null,
  };
}

export function isTradeMirrorBill(
  xeroInvoiceId: string | null | undefined,
  lineItems: unknown,
  tradeBillIds: ReadonlySet<string>,
): boolean {
  if (xeroInvoiceId && tradeBillIds.has(xeroInvoiceId)) return true;
  for (const item of lineItemsOf(lineItems)) {
    const description = textOf(item.Description) || textOf(item.description);
    if (TRADE_MIRROR_LINE_RE.test(description)) return true;
  }
  return false;
}

function placeable(job: KnownJob): boolean {
  if (job.holding) return false;
  const status = (job.status ?? "").toLowerCase();
  return !UNPLACEABLE_STATUSES.has(status);
}

/**
 * Token rules only. Two or more tokens are split, including one real job
 * beside an unknown token. One token stored on two jobs is ambiguous.
 * A single token on a cancelled, lost, draft, quoted or holding job is
 * unmatched.
 */
export function classifyJobNumberMatch(
  tokens: readonly string[],
  jobsByNumber: ReadonlyMap<string, readonly KnownJob[]>,
): BillClassification {
  const unique = [...new Set(tokens.map((token) => token.toUpperCase()))].sort();
  const real: string[] = [];
  let multi = false;
  for (const token of unique) {
    const ids = [...new Set((jobsByNumber.get(token) ?? []).map((job) => job.id))];
    if (ids.length === 0) continue;
    real.push(token);
    if (ids.length !== 1) multi = true;
  }
  real.sort();
  const base = {
    tokens: unique,
    real_job_numbers: real,
    matched_text: null as string | null,
  };
  if (unique.length > 1) {
    return { ...base, outcome: "split", job_number: null, job_id: null };
  }
  if (multi) {
    return { ...base, outcome: "ambiguous", job_number: null, job_id: null };
  }
  if (real.length === 1) {
    const jobNumber = real[0];
    const jobs = jobsByNumber.get(jobNumber) ?? [];
    const job = jobs[0];
    if (!job || !placeable(job)) {
      return { ...base, outcome: "unmatched", job_number: null, job_id: null };
    }
    return {
      ...base,
      outcome: "exact",
      job_number: jobNumber,
      job_id: job.id,
    };
  }
  return { ...base, outcome: "unmatched", job_number: null, job_id: null, real_job_numbers: [] };
}

export function classifySupplierBill(
  bill: SupplierBill,
  jobsByNumber: ReadonlyMap<string, readonly KnownJob[]>,
  factInvoiceIds: ReadonlySet<string> = new Set(),
  tradeBillIds: ReadonlySet<string> = new Set(),
): BillClassification {
  const fields = billJobNumberFields(bill);
  const empty: BillClassification = {
    outcome: "unmatched",
    job_number: null,
    job_id: null,
    tokens: fields.all,
    real_job_numbers: [],
    matched_text: fields.matched_text,
  };
  if (bill.job_id) {
    return { ...empty, outcome: "already_linked" };
  }
  if (bill.xero_invoice_id && factInvoiceIds.has(bill.xero_invoice_id)) {
    return { ...empty, outcome: "already_fact" };
  }
  if (
    bill.trade_mirror ||
    isTradeMirrorBill(bill.xero_invoice_id, bill.line_items, tradeBillIds)
  ) {
    return { ...empty, outcome: "trade_app" };
  }
  if (isInstallerBill(bill.line_items)) {
    return { ...empty, outcome: "installer_hold" };
  }
  const match = classifyJobNumberMatch(fields.all, jobsByNumber);
  return { ...match, matched_text: fields.matched_text };
}

export type CohortBill = SupplierBill & {
  id: string;
  trade_mirror: boolean;
};

export type CohortSummary = {
  scanned: number;
  trade_mirrors_excluded: number;
  already_linked: number;
  already_fact: number;
  installer_hold: number;
  exact_unique: number;
  split: number;
  ambiguous: number;
  unmatched: number;
  line_text_hits: number;
  reference_hits: number;
  tracking_hits: number;
  apply_count: number;
};

function hasToken(tokens: string[]): boolean {
  return tokens.length > 0;
}

export function summariseSupplierBills(
  bills: readonly CohortBill[],
  jobsByNumber: ReadonlyMap<string, readonly KnownJob[]>,
  factInvoiceIds: ReadonlySet<string> = new Set(),
): CohortSummary {
  const summary: CohortSummary = {
    scanned: bills.length,
    trade_mirrors_excluded: 0,
    already_linked: 0,
    already_fact: 0,
    installer_hold: 0,
    exact_unique: 0,
    split: 0,
    ambiguous: 0,
    unmatched: 0,
    line_text_hits: 0,
    reference_hits: 0,
    tracking_hits: 0,
    apply_count: 0,
  };
  for (const bill of bills) {
    const classified = classifySupplierBill(bill, jobsByNumber, factInvoiceIds);
    if (classified.outcome === "trade_app") {
      summary.trade_mirrors_excluded += 1;
      continue;
    }
    if (classified.outcome === "already_linked") {
      summary.already_linked += 1;
      continue;
    }
    const fields = billJobNumberFields(bill);
    if (hasToken(fields.lines)) summary.line_text_hits += 1;
    if (hasToken(fields.reference)) summary.reference_hits += 1;
    if (hasToken(fields.tracking)) summary.tracking_hits += 1;
    if (classified.outcome === "already_fact") summary.already_fact += 1;
    else if (classified.outcome === "installer_hold") summary.installer_hold += 1;
    else if (classified.outcome === "exact") {
      summary.exact_unique += 1;
      summary.apply_count += 1;
    } else if (classified.outcome === "split") summary.split += 1;
    else if (classified.outcome === "ambiguous") summary.ambiguous += 1;
    else summary.unmatched += 1;
  }
  return summary;
}

/**
 * The audit's shape, not a production count: 649 recent non-trade supplier
 * bills (33 already linked, 616 not), 53 of the unlinked ones naming a job
 * number in line text, and 4 trade-mirror bills excluded from that 649.
 * The eight two-job bills are split, not a write.
 */
export function auditShapedCohort(): {
  bills: CohortBill[];
  jobsByNumber: Map<string, KnownJob[]>;
} {
  const jobsByNumber = new Map<string, KnownJob[]>();
  for (let n = 1; n <= 42; n++) {
    const suffix = String(261000 + n);
    jobsByNumber.set(`SWF-${suffix}`, [{
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      status: null,
      holding: false,
    }]);
  }
  const bills: CohortBill[] = [];
  for (let n = 1; n <= 33; n++) {
    bills.push({
      id: `linked-${n}`,
      job_id: `already-${n}`,
      xero_invoice_id: `LINKED-${n}`,
      reference: "PO-54000",
      line_items: [{ Description: "Supplier materials", Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }] }],
      trade_mirror: false,
    });
  }
  for (let n = 1; n <= 40; n++) {
    const suffix = String(261000 + n);
    bills.push({
      id: `exact-${n}`,
      job_id: null,
      xero_invoice_id: `EXACT-${n}`,
      reference: "PO-54000",
      line_items: [{
        Description: `Materials for SWF-${suffix}`,
        Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }],
      }],
      trade_mirror: false,
    });
  }
  for (let n = 1; n <= 8; n++) {
    bills.push({
      id: `split-${n}`,
      job_id: null,
      xero_invoice_id: `SPLIT-${n}`,
      reference: "PO-54000",
      line_items: [{
        Description: "Split delivery SWF-261041 and SWF-261042",
        Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }],
      }],
      trade_mirror: false,
    });
  }
  for (let n = 1; n <= 5; n++) {
    bills.push({
      id: `unknown-${n}`,
      job_id: null,
      xero_invoice_id: `UNKNOWN-${n}`,
      reference: "PO-54000",
      line_items: [{
        Description: `Site SWF-${999000 + n}`,
        Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }],
      }],
      trade_mirror: false,
    });
  }
  for (let n = 1; n <= 563; n++) {
    bills.push({
      id: `plain-${n}`,
      job_id: null,
      xero_invoice_id: `PLAIN-${n}`,
      reference: "PO-54000",
      line_items: [{
        Description: "Timber",
        Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }],
      }],
      trade_mirror: false,
    });
  }
  for (let n = 1; n <= 4; n++) {
    bills.push({
      id: `mirror-${n}`,
      job_id: null,
      xero_invoice_id: `MIRROR-${n}`,
      reference: null,
      line_items: [{ Description: "POSSIBLE DUPLICATE\nJOB | SW - FENCING\nLabour" }],
      trade_mirror: true,
    });
  }
  return { bills, jobsByNumber };
}

export type ReviewedLink = {
  xero_invoice_id: string;
  outcome: string;
  job_number?: string | null;
  matched_text?: string | null;
};

export type ApplyStep = {
  xero_invoice_id: string;
  outcome: BillOutcome;
  rpc: boolean;
  proposal_kind: "job" | "review" | null;
  job_number: string | null;
  matched_text: string;
  reason: string;
};

const SKIP_OUTCOMES = new Set<BillOutcome>([
  "installer_hold",
  "trade_app",
  "already_linked",
  "already_fact",
]);

/**
 * Checks a reviewed list against a fresh classification. A row whose outcome
 * or job number disagrees is an error, and no step is returned. rpc is always
 * false: this plan does not write a proposal.
 */
export function planReviewedLinks(
  reviewed: readonly ReviewedLink[],
  liveByInvoice: ReadonlyMap<string, BillClassification>,
): { ok: true; plan: ApplyStep[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const plan: ApplyStep[] = [];
  for (const row of reviewed) {
    const live = liveByInvoice.get(row.xero_invoice_id);
    if (!live) {
      errors.push(`${row.xero_invoice_id}: not in the live read`);
      continue;
    }
    if (row.outcome !== live.outcome) {
      errors.push(`${row.xero_invoice_id}: reviewed ${row.outcome}, live ${live.outcome}`);
      continue;
    }
    const reviewedJob = (row.job_number ?? "").toUpperCase();
    const liveJob = (live.job_number ?? "").toUpperCase();
    if (live.outcome === "exact" && reviewedJob !== liveJob) {
      errors.push(`${row.xero_invoice_id}: reviewed job ${reviewedJob || "(none)"}, live ${liveJob}`);
      continue;
    }
    if (SKIP_OUTCOMES.has(live.outcome)) {
      plan.push({
        xero_invoice_id: row.xero_invoice_id,
        outcome: live.outcome,
        rpc: false,
        proposal_kind: null,
        job_number: null,
        matched_text: live.matched_text ?? "",
        reason: `skipped ${live.outcome}`,
      });
      continue;
    }
    const proposalKind = live.outcome === "exact" ? "job" : "review";
    plan.push({
      xero_invoice_id: row.xero_invoice_id,
      outcome: live.outcome,
      rpc: false,
      proposal_kind: proposalKind,
      job_number: proposalKind === "job" ? live.job_number : null,
      matched_text: row.matched_text ?? live.matched_text ?? "",
      reason: `reviewed ${live.outcome}`,
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  if (plan.some((step) => step.rpc && (step.outcome === "installer_hold" || step.outcome === "trade_app"))) {
    return { ok: false, errors: ["apply plan included an installer or trade-app bill"] };
  }
  return { ok: true, plan };
}

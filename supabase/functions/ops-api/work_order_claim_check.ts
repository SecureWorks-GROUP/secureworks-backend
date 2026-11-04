// deno-lint-ignore-file no-explicit-any
// Work-order claim check (Group work orders field-ready, variable V16).
//
// A fence lead bills a fixed-price "work order" line whose description starts
// "Work order $1153.00." (written by _formatWoLabourBreakdown in
// wo_labour_fanout.ts), less the named crew, who then bill separately. When a
// second lead on the same job also claims a work order (nested leads), the
// labour paid on the job and the claims disagree. This module compares them
// for one job so the office sees it beside the line it is reviewing.
//
// A warning only. It never blocks, changes or recomputes any pay amount, and
// it is published to staff operators only (list_trade_invoice_lines). The
// trade app never receives it.
//
// Labour is the repo's single labour-lane definition:
// v_trade_charge_resolved.cost_lane = 'labour' (WORK_ORDER_LABOUR_COST_LANE),
// valued at line_total_ex as Job Profit values it. Live means the invoice is
// not ops-reject and not draft. Unknown stays unknown: a labour line with no
// amount makes the job's labour null, never 0.

import { WORK_ORDER_LABOUR_COST_LANE } from "./job_work_orders.ts";

/** Invoices that are not live: returned to the trade, or never sent. */
export const CLAIM_CHECK_EXCLUDED_INVOICE_STATUSES: ReadonlySet<string> =
  new Set(["ops-reject", "draft"]);

const CLAIM_RE = /^\s*Work order \$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;

/** The claimed work-order total on a line, or null when the line is not a claim. */
export function parseWorkOrderClaim(description: unknown): number | null {
  if (typeof description !== "string") return null;
  const m = CLAIM_RE.exec(description);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export type ClaimCheckLine = {
  line_id: string;
  user_id: string | null;
  invoice_status: string | null;
  cost_lane: string | null;
  amount_ex: unknown;
  description: string | null;
};

export type ClaimCheckClaimant = {
  user_id: string | null;
  name: string | null;
  /** This person's largest live claim on the job. */
  claim_ex: number;
  claim_count: number;
};

export type ClaimCheck = {
  /** Live labour-lane total on the job; null when a labour line has no amount. */
  live_labour_ex: number | null;
  largest_claim_ex: number;
  claimant_count: number;
  /** Largest claim first. */
  claimants: ClaimCheckClaimant[];
  /** live_labour_ex minus largest_claim_ex; null when labour is unknown. */
  difference_ex: number | null;
  warn: boolean;
  message: string | null;
  claim_line_ids: string[];
};

function cents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** "$1,720.00" from cents. */
export function claimMoneyWords(c: number): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  const dollars = String(Math.floor(abs / 100)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

const COUNT_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six"];

/**
 * The claim check for one job's lines (pure). Null when the job carries no
 * live work-order claim. names maps user_id to a display name.
 */
export function computeWorkOrderClaimCheck(
  lines: ClaimCheckLine[],
  names: Map<string, string> = new Map(),
): ClaimCheck | null {
  const live = (lines || []).filter((l) =>
    !CLAIM_CHECK_EXCLUDED_INVOICE_STATUSES.has(String(l?.invoice_status || ""))
  );

  let labourCents: number | null = 0;
  for (const l of live) {
    if (l.cost_lane !== WORK_ORDER_LABOUR_COST_LANE) continue;
    const c = cents(l.amount_ex);
    if (c === null) labourCents = null;
    else if (labourCents !== null) labourCents += c;
  }

  const byPerson = new Map<
    string,
    { user_id: string | null; claim: number; count: number }
  >();
  const claimLineIds: string[] = [];
  for (const l of live) {
    const claim = parseWorkOrderClaim(l.description);
    if (claim === null) continue;
    claimLineIds.push(String(l.line_id));
    const key = l.user_id ? `u:${l.user_id}` : `l:${l.line_id}`;
    const c = Math.round(claim * 100);
    const prev = byPerson.get(key);
    if (prev) {
      prev.claim = Math.max(prev.claim, c);
      prev.count += 1;
    } else {
      byPerson.set(key, { user_id: l.user_id ?? null, claim: c, count: 1 });
    }
  }
  if (byPerson.size === 0) return null;

  const claimants = [...byPerson.values()]
    .map((p) => ({
      user_id: p.user_id,
      name: (p.user_id && names.get(p.user_id)) || null,
      claim: p.claim,
      count: p.count,
    }))
    .sort((a, b) =>
      b.claim - a.claim ||
      String(a.name || "").localeCompare(String(b.name || ""))
    );
  const largest = claimants[0].claim;
  const diff = labourCents === null ? null : labourCents - largest;
  const warn = claimants.length >= 2 || diff === null || diff !== 0;

  let message: string | null = null;
  if (warn) {
    const parts: string[] = [];
    if (labourCents === null) {
      parts.push(
        `Labour on this job is not known on this read. The largest work-order claim is ${
          claimMoneyWords(largest)
        }.`,
      );
    } else {
      let s = `Labour on this job ${
        claimMoneyWords(labourCents)
      } against the largest work-order claim ${claimMoneyWords(largest)}`;
      if (diff !== null && diff > 0) s += `, ${claimMoneyWords(diff)} more`;
      if (diff !== null && diff < 0) s += `, ${claimMoneyWords(-diff)} less`;
      parts.push(`${s}.`);
    }
    if (claimants.length >= 2) {
      const who = claimants.map((c) =>
        `${c.name || "name not known"} ${claimMoneyWords(c.claim)}${
          c.count > 1 ? ` (${c.count} claims)` : ""
        }`
      ).join(", ");
      const n = COUNT_WORDS[claimants.length] || String(claimants.length);
      parts.push(`${n} leads claimed a work order: ${who}.`);
    }
    parts.push("Check who did the work before approving.");
    message = parts.join(" ");
  }

  return {
    live_labour_ex: labourCents === null ? null : labourCents / 100,
    largest_claim_ex: largest / 100,
    claimant_count: claimants.length,
    claimants: claimants.map((c) => ({
      user_id: c.user_id,
      name: c.name,
      claim_ex: c.claim / 100,
      claim_count: c.count,
    })),
    difference_ex: diff === null ? null : diff / 100,
    warn,
    message,
    claim_line_ids: claimLineIds,
  };
}

export type ClaimCheckRead = { check: ClaimCheck | null; error: string | null };

export const CLAIM_CHECK_UNREADABLE_WARNING =
  "The work-order claim check could not be read. Check who did the work before approving.";

/**
 * The warning text for one listed line, or null. Only a line that itself
 * carries a live "Work order $X" claim gets one. A failed read is said, never
 * shown as clean.
 */
export function claimWarningForLine(
  read: ClaimCheckRead,
  line: { id: unknown; description: unknown; invoice_status?: unknown },
): string | null {
  if (parseWorkOrderClaim(line?.description) === null) return null;
  if (
    CLAIM_CHECK_EXCLUDED_INVOICE_STATUSES.has(
      String(line?.invoice_status || ""),
    )
  ) return null;
  if (read.error) return CLAIM_CHECK_UNREADABLE_WARNING;
  const check = read.check;
  if (!check || !check.warn) return null;
  return check.message;
}

/**
 * list_trade_invoice_lines rows with work_order_claim_warning added to each
 * (text or null). The invoice status is the row's joined trade_invoices.status.
 */
export function withClaimWarnings<T extends Record<string, any>>(
  rows: T[],
  read: ClaimCheckRead,
): Array<T & { work_order_claim_warning: string | null }> {
  return (rows || []).map((row) => {
    const inv = Array.isArray(row?.trade_invoices)
      ? row.trade_invoices[0]
      : row?.trade_invoices;
    return {
      ...row,
      work_order_claim_warning: claimWarningForLine(read, {
        id: row?.id,
        description: row?.description,
        invoice_status: inv?.status ?? null,
      }),
    };
  });
}

/**
 * Reads one job's lines from v_trade_charge_resolved (resolved_job_id) and the
 * claimants' names, then computes the check. Never throws: a failed read is
 * { check: null, error }.
 */
export async function loadWorkOrderClaimCheck(
  client: any,
  jobId: string,
): Promise<ClaimCheckRead> {
  try {
    const { data, error } = await client.from("v_trade_charge_resolved")
      .select(
        "line_id, user_id, invoice_status, cost_lane, line_total_ex, description",
      )
      .eq("resolved_job_id", jobId);
    if (error) return { check: null, error: "labour_unreadable" };
    const lines: ClaimCheckLine[] = (data || []).map((r: any) => ({
      line_id: String(r.line_id),
      user_id: r.user_id ?? null,
      invoice_status: r.invoice_status ?? null,
      cost_lane: r.cost_lane ?? null,
      amount_ex: r.line_total_ex,
      description: r.description ?? null,
    }));
    const claimantIds = [
      ...new Set(
        lines.filter((l) =>
          l.user_id && parseWorkOrderClaim(l.description) !== null
        ).map((l) => String(l.user_id)),
      ),
    ];
    if (claimantIds.length === 0) return { check: null, error: null };
    const names = new Map<string, string>();
    const { data: users, error: usersErr } = await client.from("users")
      .select("id, name").in("id", claimantIds);
    if (!usersErr) {
      for (const u of users || []) {
        if (u?.id && u?.name) names.set(String(u.id), String(u.name));
      }
    }
    return { check: computeWorkOrderClaimCheck(lines, names), error: null };
  } catch {
    return { check: null, error: "labour_unreadable" };
  }
}

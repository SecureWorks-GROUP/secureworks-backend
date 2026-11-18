// Follow-up 66, mirror rule: the one place xero-sync asks "does a trade invoice
// mirror this supplier bill". The rule itself is the database function
// trade_invoice_bill_mirror_verdicts (ids compared trimmed and
// case-insensitively; a trade invoice with no organisation is a stop), which
// the database twin job_cost_lines_backfill_bills reads too. Never compare
// bill ids here: the function echoes each id exactly as given, so callers use
// an exact set.
//
// A failed or incomplete answer throws: a bill is never read as "not a mirror"
// because the check could not be made.

// deno-lint-ignore no-explicit-any
type Sb = any;

/** One call, at most this many ids (a sync page is 100, a backfill page 200). */
export const MIRROR_RULE_MAX_IDS = 200;

export class MirrorRuleUnavailable extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export type MirrorVerdicts = {
  /** Mirrored by this organisation's trade invoice: skip. */
  mirrors: Set<string>;
  /** Only a trade invoice with no organisation holds it, or the id is blank: write nothing, count it. */
  stopped: Set<string>;
};

export async function readBillMirrorVerdicts(
  sb: Sb,
  orgId: string,
  billIds: string[],
): Promise<MirrorVerdicts> {
  const ids = [...new Set(billIds)];
  const out: MirrorVerdicts = { mirrors: new Set(), stopped: new Set() };
  if (!ids.length) return out;
  if (ids.length > MIRROR_RULE_MAX_IDS) throw new MirrorRuleUnavailable("mirror_rule_too_many_ids");
  let res: { data: unknown; error: unknown };
  try {
    res = await sb.rpc("trade_invoice_bill_mirror_verdicts", { p_org_id: orgId, p_bill_ids: ids });
  } catch {
    throw new MirrorRuleUnavailable("mirror_rule_unreadable");
  }
  if (res.error || !Array.isArray(res.data)) throw new MirrorRuleUnavailable("mirror_rule_unreadable");
  const seen = new Map<string, string>();
  for (const row of res.data as Array<{ bill_id?: unknown; verdict?: unknown }>) {
    const id = typeof row?.bill_id === "string" ? row.bill_id : null;
    const verdict = typeof row?.verdict === "string" ? row.verdict : null;
    if (id === null || !["mirror", "stop", "none"].includes(verdict ?? "")) {
      throw new MirrorRuleUnavailable("mirror_rule_answer_invalid");
    }
    seen.set(id, verdict!);
  }
  for (const id of ids) {
    const verdict = seen.get(id);
    if (!verdict) throw new MirrorRuleUnavailable("mirror_rule_answer_incomplete");
    if (verdict === "mirror") out.mirrors.add(id);
    else if (verdict === "stop") out.stopped.add(id);
  }
  return out;
}

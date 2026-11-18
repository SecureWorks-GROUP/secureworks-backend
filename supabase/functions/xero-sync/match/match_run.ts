// P2-02.7 (Follow-up 66 b): run the matcher on cost documents the sync just
// changed, and on the match queue.
//
// PROPOSALS ONLY. The matcher may name a job for a bill from a job number, an
// order (a PO named on the bill, a sealed-scope order or one open order of the
// same amount) or other clues, but it never places one: a decideMatch result of
// `auto` is sent to match_apply as a `suggest` (reason `office_confirms`) with
// `would_place: true`, so the office confirms it on the Reconcile list. With
// reconcile_matcher_v1 off (as seeded) match_apply writes only the clues and a
// shadow row and raises nothing.
//
// Bills only (`xero_bill:<id>`). Every other subject is skipped and counted. A
// supplier credit that follows a bill is moved by job_cost_lines_refollow when
// the bill is decided, never by the matcher.
//
// A failed read never counts as "no clue": that subject is skipped, requeued
// and counted. Logs carry codes and counts only. Every read is per document.

import { jobNumbersIn } from "../bill_prematch.ts";
import { decideMatch } from "./decide.ts";
import {
  deliveryAddressClue,
  documentStops,
  groupTagClue,
  jobNumberClue,
  type MatchDocument,
  type MatchJob,
  type NamedOrder,
  orderNumberClue,
  overheadAccountClue,
} from "./doc_clues.ts";
import {
  type MatchOrder,
  orderAmountClue,
  sealedScopeOrderClue,
  supplierNameKey,
} from "./order_clues.ts";
import {
  type BillEvidenceRow,
  duplicateStop,
  type OtherCostDocument,
  samePersonStop,
  supplierMailClue,
} from "./record_clues.ts";
import type { Clue, ClueType, MatchResult, Stop } from "./types.ts";

export const MATCH_RUN_LIMIT = 50;
export const MATCH_RUN_BUDGET_MS = 20_000;
const ORDER_WINDOW_DAYS = 60;

// deno-lint-ignore no-explicit-any
type Sb = any;

export interface MatchRunReport {
  run: number;
  applied: Record<string, number>;
  requeued: number;
  skipped: Record<string, number>;
  failed: Record<string, number>;
}

class ReadFailed extends Error {
  constructor(public code: string) {
    super(code);
  }
}

async function read<T>(code: string, q: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  let res: { data: T; error: unknown };
  try {
    res = await q;
  } catch {
    throw new ReadFailed(code);
  }
  if (res.error) throw new ReadFailed(code);
  return res.data;
}

const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

/** Pure. The matcher proposes; it never places. */
export function proposalOnly(result: MatchResult): Record<string, unknown> {
  if (result.result !== "auto") return result as unknown as Record<string, unknown>;
  return {
    result: "suggest",
    reason: "office_confirms",
    outcome: "job",
    job_id: result.job_id,
    from_clue_index: result.clue_indexes[0],
    would_place: true,
    clue_indexes: result.clue_indexes,
  };
}

const dayMinus = (day: string, days: number) =>
  new Date(Date.parse(day.slice(0, 10) + "T00:00:00Z") - days * 86_400_000).toISOString().slice(0, 10);

function clueJson(c: Clue) {
  return {
    clue_code: c.clue_code,
    root: c.root,
    outcome: c.outcome,
    job_id: c.job_id ?? null,
    division: c.division ?? null,
    names_one: c.names_one,
    seen_where: c.seen_where ?? null,
    seen_value: c.seen_value ?? null,
    detail: c.detail ?? {},
  };
}

// deno-lint-ignore no-explicit-any
const num = (v: any) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

async function matchOne(
  sb: Sb,
  subjectId: string,
  types: Record<string, ClueType>,
): Promise<{ applied: string } | { skipped: string }> {
  const kind = subjectId.split(":", 1)[0];
  const documentId = subjectId.slice(kind.length + 1);
  if (kind !== "xero_bill" || !documentId) return { skipped: "subject_not_a_bill" };

  // job_cost_lines_document_idx
  const lines = await read<Array<Record<string, unknown>>>("read_cost_lines",
    sb.from("job_cost_lines").select(
      "line_key,line_no,description,account_code,xero_tracking_option,amount_ex,state,document_number,document_date,party_id,party_name",
    ).eq("document_kind", "xero_bill").eq("document_id", documentId).order("line_no", { ascending: true }));
  if (!lines?.length) return { skipped: "no_cost_lines" };
  const counted = lines.filter((l) => l.state != null);
  if (!counted.length) return { skipped: "no_counted_lines" };
  // Proposals are for bills waiting for a person. A bill already on a job,
  // split or filed is left alone: no item is raised over it.
  if (!counted.some((l) => l.state === "needs_person")) return { skipped: "nothing_waiting" };

  const bill = await read<Record<string, unknown> | null>("read_bill",
    sb.from("xero_invoices").select("xero_invoice_id,invoice_number,reference,xero_contact_id,contact_name,invoice_date,sub_total")
      .eq("xero_invoice_id", documentId).maybeSingle());
  const first = lines[0];
  const money = counted.map((l) => num(l.amount_ex));
  const doc: MatchDocument = {
    subject_id: subjectId,
    document_kind: "xero_bill",
    document_id: documentId,
    party_id: (bill?.xero_contact_id as string) ?? (first.party_id as string) ?? null,
    party_name: (bill?.contact_name as string) ?? (first.party_name as string) ?? null,
    document_number: (bill?.invoice_number as string) ?? (first.document_number as string) ?? null,
    reference: (bill?.reference as string) ?? null,
    document_date: ((bill?.invoice_date as string) ?? (first.document_date as string) ?? null)?.slice(0, 10) ?? null,
    total_ex: money.every((m) => m != null) ? Math.round(money.reduce((s, m) => s + m! * 100, 0)) / 100 : null,
    lines: counted.map((l) => ({
      line_key: String(l.line_key),
      description: (l.description as string) ?? null,
      account_code: (l.account_code as string) ?? null,
      tracking_option: (l.xero_tracking_option as string) ?? null,
      amount_ex: num(l.amount_ex),
    })),
  };

  // Jobs named in the texts, by number and by shared digits (a twin stops the clue).
  const texts = [doc.document_number, doc.reference, ...doc.lines.map((l) => l.description)].join("\n");
  const digits = [...new Set(jobNumbersIn(texts).map((n) => n.replace(/\D/g, "")).filter(Boolean))].slice(0, 10);
  let jobs: MatchJob[] = [];
  if (digits.length) {
    const rows = await read<Array<Record<string, unknown>>>("read_jobs",
      sb.from("jobs").select("id,job_number,status,created_at,site_address,site_suburb,holding:metadata->>do_not_schedule")
        .or(digits.map((d) => `job_number.ilike.%${d}`).join(",")).limit(50));
    jobs = (rows ?? []).filter((r) => typeof r.job_number === "string").map((r) => ({
      id: String(r.id),
      job_number: String(r.job_number),
      status: (r.status as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      site_address: (r.site_address as string) ?? null,
      site_suburb: (r.site_suburb as string) ?? null,
      holding: String(r.holding ?? "").toLowerCase() === "true",
    }));
  }

  // Orders from this supplier sent within 60 days before the bill.
  let orders: MatchOrder[] = [];
  let namedOrders: NamedOrder[] = [];
  if (doc.document_date && (doc.party_id || supplierNameKey(doc.party_name))) {
    let q = sb.from("v_job_orders").select(
      "order_kind,order_id,order_number,job_id,job_live,party_id,party_name_key,sent_on,cost_ex,from_sealed_scope,matched",
    ).gte("sent_on", dayMinus(doc.document_date, ORDER_WINDOW_DAYS)).lte("sent_on", doc.document_date);
    q = doc.party_id ? q.eq("party_id", doc.party_id) : q.eq("party_name_key", supplierNameKey(doc.party_name));
    const rows = await read<Array<Record<string, unknown>>>("read_orders", q.limit(200));
    orders = (rows ?? []).map((r) => ({
      order_kind: r.order_kind as MatchOrder["order_kind"],
      order_id: String(r.order_id),
      order_number: (r.order_number as string) ?? null,
      job_id: String(r.job_id ?? ""),
      job_live: r.job_live === true,
      party_id: (r.party_id as string) ?? null,
      party_name_key: (r.party_name_key as string) ?? null,
      sent_on: (r.sent_on as string) ?? null,
      cost_ex: num(r.cost_ex),
      from_sealed_scope: r.from_sealed_scope === true,
      matched: r.matched === true,
    }));
    namedOrders = orders.map((o) => ({
      order_kind: o.order_kind,
      order_id: o.order_id,
      order_number: o.order_number,
      job_id: o.job_id || null,
      party_id: o.party_id,
      status: null,
      matched: o.matched,
    }));
    // The order's job facts (live, holding) for the order-number clue.
    const orderJobIds = [...new Set(orders.map((o) => o.job_id).filter((id) => id && !jobs.some((j) => j.id === id)))].slice(0, 50);
    if (orderJobIds.length) {
      const rows = await read<Array<Record<string, unknown>>>("read_order_jobs",
        sb.from("jobs").select("id,job_number,status,created_at,site_address,site_suburb,holding:metadata->>do_not_schedule")
          .in("id", orderJobIds));
      for (const r of rows ?? []) {
        if (typeof r.job_number !== "string") continue;
        jobs.push({
          id: String(r.id),
          job_number: String(r.job_number),
          status: (r.status as string) ?? null,
          created_at: (r.created_at as string) ?? null,
          site_address: (r.site_address as string) ?? null,
          site_suburb: (r.site_suburb as string) ?? null,
          holding: String(r.holding ?? "").toLowerCase() === "true",
        });
      }
    }
  }

  const evidence = await read<BillEvidenceRow[]>("read_bill_evidence",
    sb.rpc("context_job_evidence_for_bills", { p_bill_ids: [documentId] }));

  // Other live documents of the same supplier with the same number.
  let others: OtherCostDocument[] = [];
  if (doc.document_number) {
    let q = sb.from("job_cost_lines").select("document_id,document_number,document_date,document_status,party_id,party_name,amount_ex,state")
      .eq("document_kind", "xero_bill").eq("document_number", doc.document_number).neq("document_id", documentId);
    if (doc.party_id) q = q.eq("party_id", doc.party_id);
    const rows = await read<Array<Record<string, unknown>>>("read_other_documents", q.limit(200));
    const byDoc = new Map<string, Array<Record<string, unknown>>>();
    for (const r of rows ?? []) byDoc.set(String(r.document_id), [...(byDoc.get(String(r.document_id)) ?? []), r]);
    others = [...byDoc.entries()].map(([id, rs]) => {
      const amounts = rs.filter((r) => r.state != null).map((r) => num(r.amount_ex));
      return {
        subject_id: `xero_bill:${id}`,
        document_kind: "xero_bill",
        document_id: id,
        party_id: (rs[0].party_id as string) ?? null,
        party_name: (rs[0].party_name as string) ?? null,
        document_number: (rs[0].document_number as string) ?? null,
        reference: null,
        document_date: (rs[0].document_date as string)?.slice(0, 10) ?? null,
        total_ex: amounts.length && amounts.every((a) => a != null)
          ? Math.round(amounts.reduce((s, a) => s + a! * 100, 0)) / 100
          : null,
        lines: [],
        status: (rs[0].document_status as string) ?? null,
        state_words: [...new Set(rs.map((r) => String(r.state ?? "not counted")))].join(", "),
      };
    });
  }

  // Clues another phase handed in (kept_from set), in id order: match_apply
  // appends them after this run's clues in the same order.
  const kept = await read<Array<Record<string, unknown>>>("read_kept_clues",
    sb.from("match_clues").select("id,clue_code,class,family,root,outcome,job_id,division,names_one,seen_where,seen_value,detail")
      .eq("subject_kind", "cost_document").eq("subject_id", subjectId).eq("current", true)
      .not("kept_from", "is", null).order("id", { ascending: true }));

  let rule: Record<string, unknown> | null = null;
  if (doc.party_id) {
    const rows = await read<Array<Record<string, unknown>>>("read_rules",
      sb.from("match_rules").select("id,kind,division").eq("party_id", doc.party_id).eq("status", "confirmed").limit(2));
    rule = rows?.length === 1 ? rows[0] : null;
  }

  const fresh: Clue[] = [
    jobNumberClue(doc, jobs),
    orderNumberClue(doc, namedOrders, jobs),
    sealedScopeOrderClue(doc, orders),
    orderAmountClue(doc, orders),
    supplierMailClue(evidence ?? []),
    deliveryAddressClue(doc, jobs),
    overheadAccountClue(doc),
    groupTagClue(doc),
    rule
      ? {
        clue_code: "learned_rule",
        class: "clue",
        family: "rule",
        root: `rule:${rule.id}`,
        outcome: rule.kind === "supplier_usually_overhead" ? "overhead" : "division_stock",
        ...(rule.division ? { division: String(rule.division) } : {}),
        names_one: true,
      } as Clue
      : null,
  ].filter((c): c is Clue => !!c && !!types[c.clue_code] && types[c.clue_code].mode !== "off");
  const keptClues: Clue[] = (kept ?? []).map((k) => ({
    clue_code: String(k.clue_code),
    class: k.class as Clue["class"],
    family: String(k.family),
    root: String(k.root),
    outcome: k.outcome as Clue["outcome"],
    ...(k.job_id ? { job_id: String(k.job_id) } : {}),
    ...(k.division ? { division: String(k.division) } : {}),
    names_one: k.names_one === true,
  }));
  const all = [...fresh, ...keptClues];

  const stops: Stop[] = [...documentStops(doc, jobs)];
  const dup = duplicateStop(doc, others);
  if (dup) stops.push(dup);
  const candidate = all.find((c) => c.outcome === "job" && c.job_id && c.names_one && (c.class === "key" || c.class === "clue"));
  if (candidate?.job_id && doc.party_id) {
    const users = await read<Array<{ id: string; xero_contact_id: string | null }>>("read_trade_user",
      sb.from("users").select("id,xero_contact_id").eq("xero_contact_id", doc.party_id).limit(2));
    if (users?.length === 1) {
      const rows = await read<Array<Record<string, unknown>>>("read_trade_lines",
        sb.from("trade_invoice_lines").select("job_id,line_total_ex,work_date,created_at,trade_invoices!inner(user_id)")
          .eq("job_id", candidate.job_id).eq("trade_invoices.user_id", users[0].id).limit(200));
      const same = samePersonStop(doc, { ...users[0], candidate_job_id: candidate.job_id },
        (rows ?? []).map((r) => ({
          user_id: users[0].id,
          job_id: String(r.job_id),
          line_date: ((r.work_date as string) ?? (r.created_at as string) ?? null)?.slice(0, 10) ?? null,
          total_ex: num(r.line_total_ex),
        })));
      if (same) stops.push(same);
    }
  }

  const result = proposalOnly(decideMatch(all, types, stops));
  const { data, error } = await sb.rpc("match_apply", {
    p_subject_kind: "cost_document",
    p_subject_id: subjectId,
    p_run_id: crypto.randomUUID(),
    p_item_kind: "bill",
    p_clues: fresh.map(clueJson),
    p_result: result,
    p_stops: stops,
    p_summary: {
      party: doc.party_name,
      number: doc.document_number,
      date: doc.document_date,
      amount_ex: doc.total_ex,
      lines: doc.lines.length,
    },
    p_rule_version: "v1",
  });
  if (error) {
    const code = /\b(match_[a-z_]+|reconcile_[a-z_]+)\b/.exec(String((error as { message?: unknown }).message ?? ""))?.[1];
    throw new ReadFailed(code ? `apply:${code}` : "apply_failed");
  }
  return { applied: String((data as { applied?: unknown })?.applied ?? "unknown") };
}

/** Never throws: every failure is counted and the subject requeued. */
export async function runMatchFor(
  sb: Sb,
  subjectIds: string[],
  opts: { ruleVersion: "v1"; budgetMs?: number; reason?: string; now?: () => number },
): Promise<MatchRunReport> {
  const report: MatchRunReport = { run: 0, applied: {}, requeued: 0, skipped: {}, failed: {} };
  const ids = [...new Set(subjectIds.filter((s) => typeof s === "string" && s.includes(":")))];
  if (!ids.length) return report;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? MATCH_RUN_BUDGET_MS);
  const requeue = async (id: string, reason: string) => {
    try {
      const { error } = await sb.rpc("match_requeue", { p_subject_kind: "cost_document", p_subject_id: id, p_reason: reason });
      if (error) bump(report.failed, "requeue_failed");
      else report.requeued++;
    } catch {
      bump(report.failed, "requeue_failed");
    }
  };

  let types: Record<string, ClueType>;
  try {
    const rows = await read<ClueType[]>("read_clue_types", sb.from("match_clue_types").select("code,class,family,mode"));
    types = Object.fromEntries((rows ?? []).map((t) => [t.code, t]));
    if (!Object.keys(types).length) throw new ReadFailed("read_clue_types");
  } catch {
    bump(report.failed, "read_clue_types");
    for (const id of ids) await requeue(id, "read_failed");
    console.error("[match_run] clue types unreadable", JSON.stringify(report));
    return report;
  }

  for (const [i, id] of ids.entries()) {
    if (i >= MATCH_RUN_LIMIT || now() > deadline) {
      await requeue(id, i >= MATCH_RUN_LIMIT ? "over_run_cap" : "over_run_time");
      continue;
    }
    report.run++;
    try {
      const out = await matchOne(sb, id, types);
      if ("applied" in out) bump(report.applied, out.applied);
      else bump(report.skipped, out.skipped);
    } catch (e) {
      const code = e instanceof ReadFailed ? e.code : "threw";
      bump(report.failed, code);
      // A data refusal from match_apply would refuse again: not requeued. An
      // unreadable switch is not a refusal and is retried.
      if (!code.startsWith("apply:match_") || code === "apply:match_switch_unreadable") await requeue(id, code.startsWith("apply") ? "apply_failed" : "read_failed");
    }
  }
  if (Object.keys(report.failed).length) console.error("[match_run] failures", JSON.stringify(report.failed));
  return report;
}

/** The match_pending action: one read when nothing waits. */
export async function matchPending(sb: Sb): Promise<Record<string, unknown>> {
  // match_queue_pkey. Bills only: a queued credit, receipt or message waits
  // for its own runner and is never deleted here.
  const { data, error } = await sb.from("match_queue").select("subject_kind,subject_id")
    .eq("subject_kind", "cost_document").like("subject_id", "xero_bill:%")
    .order("queued_at", { ascending: true }).limit(MATCH_RUN_LIMIT);
  if (error) return { matched: 0, error: "queue_unreadable" };
  const rows = (data ?? []) as Array<{ subject_kind: string; subject_id: string }>;
  if (!rows.length) return { matched: 0 };
  const ids = rows.map((r) => r.subject_id);
  const del = await sb.from("match_queue").delete().eq("subject_kind", "cost_document").in("subject_id", ids);
  if (del.error) return { matched: 0, error: "queue_delete_failed" };
  const report = await runMatchFor(sb, ids, { ruleVersion: "v1" });
  return { matched: report.run, ...report };
}

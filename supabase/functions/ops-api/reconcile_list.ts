// P2-03.6 (Follow-up 66 lift): the Reconcile cost list the "Cost lines to
// place" screen reads (secureworks-ux modules/ops-reconcile-place.js).
//
//   GET ?action=reconcile_list&tab=bills|card_bank|receipts|all&limit=1..100&after=<cursor>
//     -> { ok, enabled: true, tab, items, counts, next }
//
// Who may call: a signed-in staff session (admin, owner, ops manager) of the
// default organisation. A server key, the routine, an agent and a trade are
// refused 403 before the switch or any row is read. Behind
// feature_flags.reconcile_list_v1 (ships off; a missing row is off): off
// answers { ok, enabled: false } with no items, after reading only the switch.
// An unreadable switch or any failed read refuses 503: the list is never shown
// part read, and a failed read never reads as "nothing waiting".
//
// What it reads (one query each, all scoped to the caller's organisation):
//   reconcile_item_kinds (the cost kinds and their tab), reconcile_list_page
//   (one page, reconcile_items_open_page_idx), reconcile_list_counts (per kind,
//   same index), job_cost_lines of the page's documents
//   (job_cost_lines_document_idx), and for a credit: the bills it follows, their
//   counted lines and parts (job_cost_lines_document_idx, the parts' line key),
//   the bill's open item (reconcile_items_open_subject_idx), and the jobs named
//   (jobs primary key; never scope_json or pricing_json).
//
// Only the cost kinds of three tabs are listed: the pay tab (named pay) and the
// message tab are not read here. Logs carry codes and ids only.

export const RECONCILE_LIST_FLAG = "reconcile_list_v1";

/** The tabs this read answers; `all` is the three together. */
export const RECONCILE_LIST_TABS = ["all", "bills", "card_bank", "receipts"] as const;
type Tab = typeof RECONCILE_LIST_TABS[number];
const COST_TABS = ["bills", "card_bank", "receipts"] as const;

/** A cost document an item may name. Never a trade invoice (named pay). */
const COST_DOCUMENT_KINDS = new Set(["xero_bill", "xero_credit_note", "expense_receipt", "xero_bank_txn"]);

export class ReconcileListError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
  }
}

export const RECONCILE_LIST_WORDS: Record<string, [number, string]> = {
  method_not_allowed: [405, "This list is read with a GET."],
  operator_org_required: [403, "Organisation access required."],
  operator_access_required: [403, "Only admin, owner or ops manager can read the Reconcile list."],
  invalid_request: [400, "That request is not one this list accepts."],
  reconcile_list_unreadable: [503, "The list could not be read. Nothing is shown as placed. Try again in a minute."],
};

export function reconcileListRefusal(code: string): ReconcileListError {
  const hit = RECONCILE_LIST_WORDS[code] ?? RECONCILE_LIST_WORDS.reconcile_list_unreadable;
  return new ReconcileListError(RECONCILE_LIST_WORDS[code] ? code : "reconcile_list_unreadable", hit[0], hit[1]);
}

/** reason_words: one map (spec P2-03.6 step 5). */
export const RECONCILE_REASON_WORDS: Record<string, string> = {
  no_clue: "No suggestion",
  one_clue: "One reason found",
  ai_only: "The AI's suggestion only",
  two_jobs_named: "The document names two jobs",
  possible_duplicate: "Looks like a document already counted",
  same_person_also_in_app: "This person also bills through the Trade App",
  installer_bill_outside_app: "Labour billed outside the Trade App",
  digit_twin: "Two jobs share these digits",
  job_not_live: "The job named is not live",
  document_before_job: "Dated before the job existed",
  amount_unknown: "The amount is not known",
  document_changed_after_decision: "Changed in Xero after it was decided",
  document_does_not_conserve: "The lines do not add up to the total",
  ai_filed_overhead_recheck: "Filed by the AI as not for a job: please check",
  ai_placed_no_key_recheck: "Placed by the AI with no key: please check",
  trade_line_no_job: "A Trade App line with no job",
  credit_not_allocated: "A credit not yet applied to a bill",
  no_work_order: "No work order exists for this job",
  group_claim_not_agreed: "The crew did not agree the split in 48 hours",
  division_tag_missing: "No division tag for this job",
};

type Client = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  from: (table: string) => any;
};

export type ReconcileListCaller = {
  authMode: string;
  userId: string | null | undefined;
  /** The session's role is on the ops staff set. */
  isStaff: boolean;
  orgId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARAMS = new Set(["action", "tab", "limit", "after", "operator_email"]);
const CHUNK = 25;

/** Staff session only; checked before anything is read. */
export function reconcileListAllowed(caller: ReconcileListCaller): void {
  if (caller.authMode !== "jwt" || !caller.userId || !UUID.test(caller.userId) || !caller.isStaff) {
    throw reconcileListRefusal("operator_access_required");
  }
}

export type ReconcileListCursor = { snoozed: boolean; amount_ex: number | null; raised_at: string; id: string };

export function encodeCursor(c: ReconcileListCursor): string {
  return btoa(JSON.stringify([c.snoozed ? 1 : 0, c.amount_ex, c.raised_at, c.id]))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(raw: string): ReconcileListCursor {
  let v: unknown;
  try {
    v = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw reconcileListRefusal("invalid_request");
  }
  if (
    !Array.isArray(v) || v.length !== 4 || (v[0] !== 0 && v[0] !== 1) ||
    !(v[1] === null || (typeof v[1] === "number" && Number.isFinite(v[1]))) ||
    typeof v[2] !== "string" || !Number.isFinite(Date.parse(v[2])) ||
    typeof v[3] !== "string" || !UUID.test(v[3])
  ) throw reconcileListRefusal("invalid_request");
  return { snoozed: v[0] === 1, amount_ex: v[1] as number | null, raised_at: v[2], id: v[3] };
}

/** Pure. The checked query, before the switch is read. */
export function reconcileListInput(params: URLSearchParams): { tab: Tab; limit: number; after: ReconcileListCursor | null } {
  for (const key of params.keys()) if (!PARAMS.has(key)) throw reconcileListRefusal("invalid_request");
  const tab = (params.get("tab") ?? "all") as Tab;
  if (!RECONCILE_LIST_TABS.includes(tab)) throw reconcileListRefusal("invalid_request");
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 50 : /^[0-9]{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw reconcileListRefusal("invalid_request");
  const after = params.get("after");
  return { tab, limit, after: after ? decodeCursor(after) : null };
}

/** A missing row is off; an unreadable switch refuses 503. */
async function listSwitchOn(client: Client): Promise<boolean> {
  // feature_flags_flag_name_key
  const read = await safe(() => client.from("feature_flags").select("enabled").eq("flag_name", RECONCILE_LIST_FLAG));
  return (read as Array<{ enabled?: unknown }>).some((r) => r?.enabled === true);
}

async function safe(run: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<unknown[]> {
  let res: { data: unknown; error: unknown };
  try {
    res = await run();
  } catch {
    throw reconcileListRefusal("reconcile_list_unreadable");
  }
  if (res.error || !Array.isArray(res.data)) throw reconcileListRefusal("reconcile_list_unreadable");
  return res.data;
}

async function inChunks(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>) {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...await safe(() => read(ids.slice(i, i + CHUNK))));
  return out;
}

/** "kind:id" of a cost_document item; null for anything else. */
export function costDocumentOf(item: { subject_table?: unknown; subject_id?: unknown }) {
  if (item.subject_table !== "cost_document" || typeof item.subject_id !== "string") return null;
  const cut = item.subject_id.indexOf(":");
  if (cut < 1) return null;
  const kind = item.subject_id.slice(0, cut);
  return COST_DOCUMENT_KINDS.has(kind) ? { kind, id: item.subject_id.slice(cut + 1) } : null;
}

export type BillState = "not_loaded" | "waiting" | "placed" | "split" | "overhead" | "division_stock";

/**
 * Pure. A bill's state for a credit that follows it, by job_cost_lines_refollow's
 * rule: the bill's lines other than removed ones; none is not_loaded; any not
 * counted, needing a person or with no amount is waiting; else its parts say
 * placed (one job part), split (more than one), overhead or division_stock.
 */
export function billStateOf(
  lines: Array<{ id: string; state: string | null; amount_ex: number | null; not_counted_reason: string | null }>,
  parts: Array<{ line_id: string; target: string; job_id: string | null; division: string | null }>,
): { state: BillState; job_id: string | null; division: string | null } {
  const counted = lines.filter((l) => l.not_counted_reason !== "line_removed");
  if (counted.length === 0) return { state: "not_loaded", job_id: null, division: null };
  if (counted.some((l) => l.state === null || l.state === "needs_person" || l.amount_ex === null)) {
    return { state: "waiting", job_id: null, division: null };
  }
  const ids = new Set(counted.map((l) => l.id));
  const mine = parts.filter((p) => ids.has(p.line_id));
  if (mine.length === 0) return { state: "waiting", job_id: null, division: null };
  if (mine.length > 1) return { state: "split", job_id: null, division: null };
  const p = mine[0];
  if (p.target === "job") return { state: "placed", job_id: p.job_id, division: null };
  if (p.target === "division_stock") return { state: "division_stock", job_id: null, division: p.division };
  return { state: "overhead", job_id: null, division: null };
}

const LINE_COLUMNS = "id, document_kind, document_id, line_key, line_no, kind, description, account_code, " +
  "amount_ex, state, not_counted_reason, document_number, document_date, party_name, " +
  "follows_line_id, follows_document_kind, follows_document_id";

function money(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function daysSince(iso: string, now: Date): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 86_400_000)) : null;
}

export async function reconcileList(
  client: Client,
  params: URLSearchParams,
  caller: ReconcileListCaller,
  now: Date = new Date(),
) {
  reconcileListAllowed(caller);
  const input = reconcileListInput(params);
  if (!await listSwitchOn(client)) return { ok: true, enabled: false };

  // The cost kinds and their tabs (reconcile_item_kinds primary key).
  const kindRows = await safe(() => client.from("reconcile_item_kinds").select("kind, tab, words, card").eq("card", "cost")) as Array<
    { kind: string; tab: string; words: string; card: string }
  >;
  const tabs: readonly string[] = input.tab === "all" ? COST_TABS : [input.tab];
  const kinds = kindRows.filter((k) => tabs.includes(k.tab));
  const kindWords = new Map(kindRows.map((k) => [k.kind, k.words]));

  const pageRows = kinds.length === 0 ? [] : await safe(() =>
    client.rpc("reconcile_list_page", {
      p_org: caller.orgId,
      p_kinds: kinds.map((k) => k.kind),
      p_limit: input.limit,
      p_after: input.after,
    })
  ) as any[];
  const page = pageRows.slice(0, input.limit);
  const last = page[page.length - 1];
  const next = pageRows.length > input.limit && last
    ? encodeCursor({ snoozed: last.snoozed === true, amount_ex: money(last.amount_ex), raised_at: String(last.raised_at), id: String(last.id) })
    : null;

  const countRows = await safe(() => client.rpc("reconcile_list_counts", { p_org: caller.orgId })) as Array<{ kind: string; open: unknown }>;
  const counts: Record<string, number> = { bills: 0, card_bank: 0, receipts: 0 };
  for (const r of countRows) {
    const tab = kindRows.find((k) => k.kind === r.kind)?.tab;
    if (tab && tab in counts) counts[tab] += Number(r.open) || 0;
  }

  // The page's documents and their lines (job_cost_lines_document_idx).
  const docs = page.map((it) => costDocumentOf(it)).filter((d): d is { kind: string; id: string } => d !== null);
  const docIds = [...new Set(docs.map((d) => d.id))];
  const docKinds = [...new Set(docs.map((d) => d.kind))];
  const lines = docIds.length === 0 ? [] : await inChunks(docIds, (chunk) =>
    client.from("job_cost_lines").select(LINE_COLUMNS).eq("org_id", caller.orgId)
      .in("document_kind", docKinds).in("document_id", chunk));

  // A credit's bills: by document, or by the parent line's document.
  const credits = docs.filter((d) => d.kind === "xero_credit_note");
  const creditLines = lines.filter((l) => l.document_kind === "xero_credit_note" && credits.some((c) => c.id === l.document_id));
  const parentIds = [...new Set(creditLines.map((l) => l.follows_line_id).filter((v): v is string => typeof v === "string"))];
  const parents = parentIds.length === 0 ? [] : await inChunks(parentIds, (chunk) =>
    client.from("job_cost_lines").select("id, document_kind, document_id").eq("org_id", caller.orgId).in("id", chunk));
  const billOfLine = (l: any): string | null => {
    if (l.follows_document_kind === "xero_bill" && typeof l.follows_document_id === "string") return l.follows_document_id;
    const p = parents.find((x) => x.id === l.follows_line_id);
    return p && p.document_kind === "xero_bill" ? p.document_id : null;
  };
  const billIds = [...new Set(creditLines.map(billOfLine).filter((v): v is string => v !== null))];
  const billLines = billIds.length === 0 ? [] : await inChunks(billIds, (chunk) =>
    client.from("job_cost_lines").select(LINE_COLUMNS).eq("org_id", caller.orgId)
      .eq("document_kind", "xero_bill").in("document_id", chunk));
  const billLineIds = billLines.map((l) => l.id as string);
  const billParts = billLineIds.length === 0 ? [] : await inChunks(billLineIds, (chunk) =>
    client.from("job_cost_line_parts").select("line_id, target, job_id, division").in("line_id", chunk));
  const billItems = billIds.length === 0 ? [] : await inChunks(billIds.map((id) => `xero_bill:${id}`), (chunk) =>
    client.from("reconcile_items").select("id, subject_id").eq("org_id", caller.orgId)
      .eq("subject_table", "cost_document").eq("status", "open").in("subject_id", chunk));

  // Jobs named by a suggestion or a placed bill (jobs primary key).
  const bills = new Map(billIds.map((id) => {
    const own = billLines.filter((l) => l.document_id === id);
    return [id, { own, ...billStateOf(own, billParts) }];
  }));
  const jobIds = [...new Set([
    ...page.map((it) => it?.suggestion?.job_id).filter((v): v is string => typeof v === "string" && UUID.test(v)),
    ...[...bills.values()].map((b) => b.job_id).filter((v): v is string => typeof v === "string"),
  ])];
  const jobs = jobIds.length === 0 ? [] : await inChunks(jobIds, (chunk) =>
    client.from("jobs").select("id, job_number, site_address, site_suburb").eq("org_id", caller.orgId).in("id", chunk));
  const jobOf = (id: string | null) => {
    const j = id ? jobs.find((x) => x.id === id) : null;
    return { job_id: id, job_number: j?.job_number ?? null, job_site: j ? [j.site_address, j.site_suburb].filter(Boolean).join(", ") || null : null };
  };

  const items = page.map((it) => {
    const doc = costDocumentOf(it);
    const own = doc ? lines.filter((l) => l.document_kind === doc.kind && l.document_id === doc.id) : [];
    const first = own[0];
    const s = it.suggestion && typeof it.suggestion === "object" ? it.suggestion : null;
    const out: Record<string, unknown> = {
      id: it.id,
      kind: it.kind,
      card: "cost",
      kind_words: kindWords.get(it.kind) ?? null,
      reason: it.reason,
      reason_words: RECONCILE_REASON_WORDS[it.reason] ?? null,
      party: first?.party_name ?? null,
      document_number: first?.document_number ?? null,
      document_date: it.document_date ?? first?.document_date ?? null,
      amount_ex: money(it.amount_ex),
      waiting_days: daysSince(String(it.raised_at), now),
      snoozed: it.snoozed === true,
      shown_hash: it.evidence_hash ?? null,
      suggestion: s
        ? { outcome: s.outcome ?? null, ...jobOf(typeof s.job_id === "string" ? s.job_id : null), division: s.division ?? null }
        : null,
      lines: own
        .filter((l) => l.not_counted_reason !== "line_removed")
        .map((l) => ({ line_id: l.id, description: l.description ?? null, amount_ex: money(l.amount_ex), account_code: l.account_code ?? null, state: l.state ?? null })),
    };
    if (doc?.kind === "xero_credit_note") {
      const ids = [...new Set(own.map(billOfLine).filter((v): v is string => v !== null))];
      out.bills = ids.map((id) => {
        const b = bills.get(id)!;
        return {
          document_id: id,
          document_number: b.own[0]?.document_number ?? null,
          item_id: billItems.find((x) => x.subject_id === `xero_bill:${id}`)?.id ?? null,
          state: b.state,
          ...jobOf(b.job_id),
          division: b.division,
        };
      });
      // One bill: the screen's `bill`. None: not against a bill. Several: say so.
      out.bill = ids.length === 0 ? null : ids.length === 1 ? (out.bills as unknown[])[0] : { several: true };
    }
    return out;
  });

  return { ok: true, enabled: true, tab: input.tab, items, counts, next };
}

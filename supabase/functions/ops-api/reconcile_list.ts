import { onPeopleAccount, type PeopleAccounts, readPeopleAccounts } from "../_shared/people_accounts.ts";
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
//   (one page) and reconcile_list_counts (per kind), both through the existing
//   reconcile_items_list_idx, job_cost_lines of the page's documents
//   (job_cost_lines_document_idx), and for a credit: the bills it follows, their
//   counted lines and parts (job_cost_lines_document_idx, the parts' line key),
//   the bill's open item (reconcile_items_open_subject_idx), and the jobs named
//   (jobs primary key; never scope_json or pricing_json).
//
// Only the cost kinds of three tabs are listed: the pay tab (named pay) and the
// message tab are not read here. An item raised for labour billed outside the
// Trade App (reason installer_bill_outside_app) is a person's pay: the database
// functions leave it out of the page and the counts, and this read drops one
// that ever came back. A document with any line of kind installer_bill (a
// mixed bill: the item's kind and reason miss it) is not listed either, nor a
// credit that follows one: the database functions leave them out of the page
// and the counts (20261118195400), and this read drops one that ever came back.
// Each item carries the matcher's current clues (match_clues) and, as
// `against`, the words of the stops it stored. Every read is capped at READ_CAP (1000, the
// PostgREST row limit): a read, or the lines and parts of one answer, reaching
// it refuses the whole list, never a short one. Logs carry codes and ids only.

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
  reconcile_list_too_many_lines: [422, "This page holds more cost lines than one read may show. Nothing is shown as placed. Read a smaller page."],
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
/**
 * The most rows one read may return: PostgREST stops every read at 1000
 * (supabase/config.toml max_rows), so a read that comes back with 1000 rows may
 * be cut short. Every read asks for at most this many, and a read (or the
 * lines and parts of one answer together) reaching it refuses the whole list,
 * never a short one.
 */
export const READ_CAP = 1000;
/** A line kind that is a person's labour: its document is never listed (director, design read). */
export const UNLISTED_LINE_KINDS = new Set(["installer_bill"]);
/** Never listed: a person's pay, waiting on the owner's call (director, design read). */
export const UNLISTED_REASONS = new Set(["installer_bill_outside_app"]);

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
  const read = await safe(() => client.from("feature_flags").select("enabled").eq("flag_name", RECONCILE_LIST_FLAG).limit(READ_CAP));
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
  if (res.data.length >= READ_CAP) throw reconcileListRefusal("reconcile_list_too_many_lines");
  return res.data;
}

/**
 * Reads ids in chunks of 25, each capped at READ_CAP rows; READ_CAP rows from
 * one chunk or from all chunks together refuses the whole list.
 */
async function inChunks(ids: string[], read: (chunk: string[], cap: number) => PromiseLike<{ data: unknown; error: unknown }>) {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(...await safe(() => read(ids.slice(i, i + CHUNK), READ_CAP)));
    if (out.length >= READ_CAP) throw reconcileListRefusal("reconcile_list_too_many_lines");
  }
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

export type BillState = "not_loaded" | "not_counted" | "waiting" | "placed" | "split" | "overhead" | "division_stock";

/**
 * Pure. A bill's state for a credit that follows it. The bill's lines other than
 * removed ones; none is not_loaded. Lines not counted for another reason
 * (duplicate, counted by a bank line or a trade invoice, document not live) are
 * set aside: when every line is one, the bill is not_counted, with the reasons.
 * Of the counted lines, any needing a person, with no amount or with no part is
 * waiting. Else their parts, grouped by where they go (target, job, division):
 * one place says placed (a job), overhead or division_stock, so several lines all
 * on one job read placed; more than one place says split.
 */
export function billStateOf(
  lines: Array<{ id: string; state: string | null; amount_ex: number | null; not_counted_reason: string | null }>,
  parts: Array<{ line_id: string; target: string; job_id: string | null; division: string | null }>,
): { state: BillState; job_id: string | null; division: string | null; not_counted_reasons?: string[] } {
  const present = lines.filter((l) => l.not_counted_reason !== "line_removed");
  if (present.length === 0) return { state: "not_loaded", job_id: null, division: null };
  const counted = present.filter((l) => l.not_counted_reason === null || l.not_counted_reason === undefined);
  if (counted.length === 0) {
    const reasons = [...new Set(present.map((l) => String(l.not_counted_reason)))].sort();
    return { state: "not_counted", job_id: null, division: null, not_counted_reasons: reasons };
  }
  if (counted.some((l) => l.state === null || l.state === "needs_person" || l.amount_ex === null)) {
    return { state: "waiting", job_id: null, division: null };
  }
  const ids = new Set(counted.map((l) => l.id));
  const mine = parts.filter((p) => ids.has(p.line_id));
  if (counted.some((l) => !mine.some((p) => p.line_id === l.id))) return { state: "waiting", job_id: null, division: null };
  const places = new Map(mine.map((p) => [JSON.stringify([p.target, p.job_id ?? null, p.division ?? null]), p]));
  if (places.size > 1) return { state: "split", job_id: null, division: null };
  const p = [...places.values()][0];
  if (p.target === "job") return { state: "placed", job_id: p.job_id, division: null };
  if (p.target === "division_stock") return { state: "division_stock", job_id: null, division: p.division };
  return { state: "overhead", job_id: null, division: null };
}

const CLUE_COLUMNS = "id, subject_id, clue_code, outcome, job_id, division, names_one, seen_where, seen_value";

/** Why the matcher would not place it on its own: the stored stops' words. */
export function againstOf(evidence: unknown): string[] {
  const stops = evidence && typeof evidence === "object" ? (evidence as { stops?: unknown }).stops : null;
  if (!Array.isArray(stops)) return [];
  return [...new Set(stops.map((s) => (s && typeof s === "object" ? (s as { words?: unknown }).words : null))
    .filter((w): w is string => typeof w === "string" && w.trim() !== ""))];
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
  // The one set of people accounts (the list functions read the same table):
  // unreadable or empty refuses the list, never a list with pay on it.
  let people: PeopleAccounts;
  try {
    people = await readPeopleAccounts(client);
  } catch {
    throw reconcileListRefusal("reconcile_list_unreadable");
  }

  // The cost kinds and their tabs (reconcile_item_kinds primary key).
  const kindRows = await safe(() => client.from("reconcile_item_kinds").select("kind, tab, words, card").eq("card", "cost").limit(READ_CAP)) as Array<
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
  const page = pageRows.slice(0, input.limit).filter((it) => !UNLISTED_REASONS.has(it?.reason));
  const last = pageRows.slice(0, input.limit).at(-1);
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
  const lines = docIds.length === 0 ? [] : await inChunks(docIds, (chunk, cap) =>
    client.from("job_cost_lines").select(LINE_COLUMNS).eq("org_id", caller.orgId)
      .in("document_kind", docKinds).in("document_id", chunk).limit(cap));

  // A credit's bills: by document, or by the parent line's document.
  const credits = docs.filter((d) => d.kind === "xero_credit_note");
  // A removed credit line follows no bill (as the lines shown below).
  const creditLines = lines.filter((l) => l.document_kind === "xero_credit_note" && credits.some((c) => c.id === l.document_id) &&
    l.not_counted_reason !== "line_removed");
  const parentIds = [...new Set(creditLines.map((l) => l.follows_line_id).filter((v): v is string => typeof v === "string"))];
  const parents = parentIds.length === 0 ? [] : await inChunks(parentIds, (chunk, cap) =>
    client.from("job_cost_lines").select("id, document_kind, document_id").eq("org_id", caller.orgId).in("id", chunk).limit(cap));
  const billOfLine = (l: any): string | null => {
    if (l.follows_document_kind === "xero_bill" && typeof l.follows_document_id === "string") return l.follows_document_id;
    const p = parents.find((x) => x.id === l.follows_line_id);
    return p && p.document_kind === "xero_bill" ? p.document_id : null;
  };
  const billIds = [...new Set(creditLines.map(billOfLine).filter((v): v is string => v !== null))];
  const billLines = billIds.length === 0 ? [] : await inChunks(billIds, (chunk, cap) =>
    client.from("job_cost_lines").select(LINE_COLUMNS).eq("org_id", caller.orgId)
      .eq("document_kind", "xero_bill").in("document_id", chunk).limit(cap));
  const billLineIds = billLines.map((l) => l.id as string);
  const billParts = billLineIds.length === 0 ? [] : await inChunks(billLineIds, (chunk, cap) =>
    client.from("job_cost_line_parts").select("line_id, target, job_id, division").in("line_id", chunk).limit(cap));
  const billItems = billIds.length === 0 ? [] : await inChunks(billIds.map((id) => `xero_bill:${id}`), (chunk, cap) =>
    client.from("reconcile_items").select("id, subject_id").eq("org_id", caller.orgId)
      .eq("subject_table", "cost_document").eq("status", "open").in("subject_id", chunk).limit(cap));

  // The matcher's current clues for the page's documents
  // (match_clues_current_subject_idx) and the clue words (match_clue_types
  // primary key). A clue whose type is switched off is not shown.
  const subjectIds = [...new Set(page.filter((it) => costDocumentOf(it)).map((it) => String(it.subject_id)))];
  const clueRows = subjectIds.length === 0 ? [] : await inChunks(subjectIds, (chunk, cap) =>
    client.from("match_clues").select(CLUE_COLUMNS).eq("org_id", caller.orgId)
      .eq("subject_kind", "cost_document").eq("current", true).in("subject_id", chunk).limit(cap));
  const clueTypes = clueRows.length === 0 ? [] : await safe(() =>
    client.from("match_clue_types").select("code, class, mode, words").limit(READ_CAP)) as Array<
      { code: string; class: string; mode: string; words: string }
    >;
  const typeOf = new Map(clueTypes.map((t) => [t.code, t]));
  const shownClues = clueRows.filter((c) => typeOf.get(c.clue_code)?.mode !== "off");

  // Jobs named by a suggestion, a placed bill or a clue (jobs primary key).
  const bills = new Map(billIds.map((id) => {
    const own = billLines.filter((l) => l.document_id === id);
    return [id, { own, ...billStateOf(own, billParts) }];
  }));
  const jobIds = [...new Set([
    ...page.map((it) => it?.suggestion?.job_id).filter((v): v is string => typeof v === "string" && UUID.test(v)),
    ...[...bills.values()].map((b) => b.job_id).filter((v): v is string => typeof v === "string"),
    ...shownClues.map((c) => c.job_id).filter((v): v is string => typeof v === "string" && UUID.test(v)),
  ])];
  const jobs = jobIds.length === 0 ? [] : await inChunks(jobIds, (chunk, cap) =>
    client.from("jobs").select("id, job_number, site_address, site_suburb").eq("org_id", caller.orgId).in("id", chunk).limit(cap));
  const jobOf = (id: string | null) => {
    const j = id ? jobs.find((x) => x.id === id) : null;
    return { job_id: id, job_number: j?.job_number ?? null, job_site: j ? [j.site_address, j.site_suburb].filter(Boolean).join(", ") || null : null };
  };

  // The credits that follow each bill item on the page: credit lines naming the
  // bill (job_cost_lines_follows_document_idx) or one of its lines
  // (job_cost_lines_follows_line_idx). Removed credit lines follow nothing.
  const pageBillIds = [...new Set(docs.filter((d) => d.kind === "xero_bill").map((d) => d.id))];
  const pageBillLineIds = lines.filter((l) => l.document_kind === "xero_bill" && pageBillIds.includes(l.document_id))
    .map((l) => l.id as string);
  const followByDoc = pageBillIds.length === 0 ? [] : await inChunks(pageBillIds, (chunk, cap) =>
    client.from("job_cost_lines").select(LINE_COLUMNS).eq("org_id", caller.orgId)
      .eq("follows_document_kind", "xero_bill").in("follows_document_id", chunk).limit(cap));
  const followByLine = pageBillLineIds.length === 0 ? [] : await inChunks(pageBillLineIds, (chunk, cap) =>
    client.from("job_cost_lines").select(LINE_COLUMNS).eq("org_id", caller.orgId)
      .in("follows_line_id", chunk).limit(cap));
  const followers = new Map<string, any>();
  for (const l of [...followByDoc, ...followByLine]) {
    if (l.document_kind === "xero_credit_note" && l.not_counted_reason !== "line_removed") followers.set(l.id, l);
  }
  if (followers.size + lines.length >= READ_CAP) throw reconcileListRefusal("reconcile_list_too_many_lines");
  const billOfFollower = (l: any): string | null => {
    if (l.follows_document_kind === "xero_bill" && typeof l.follows_document_id === "string") return l.follows_document_id;
    const parent = lines.find((x) => x.id === l.follows_line_id);
    return parent && parent.document_kind === "xero_bill" ? parent.document_id : null;
  };
  /** A credit is shown as a credit: amount_ex is how much it takes off, never a bare minus. */
  const creditsOf = (billId: string) => {
    const mine = [...followers.values()].filter((l) => billOfFollower(l) === billId)
      .sort((x, y) => String(x.document_id).localeCompare(String(y.document_id)) || (Number(x.line_no) || 0) - (Number(y.line_no) || 0));
    const byDoc = new Map<string, any[]>();
    for (const l of mine) byDoc.set(l.document_id, [...(byDoc.get(l.document_id) ?? []), l]);
    return [...byDoc.entries()].map(([documentId, ls]) => {
      const amounts = ls.map((l) => money(l.amount_ex));
      const total = amounts.some((a) => a === null) ? null : Math.round(Math.abs(amounts.reduce((t, a) => t! + a!, 0)!) * 100) / 100;
      return {
        document_id: documentId,
        document_number: ls[0]?.document_number ?? null,
        is_credit: true,
        amount_ex: total,
        lines: ls.map((l) => {
          const a = money(l.amount_ex);
          return { line_id: l.id, description: l.description ?? null, amount_ex: a === null ? null : Math.abs(a), state: l.state ?? null };
        }),
      };
    });
  };

  /** The matcher's reasons, oldest clue first; `counts` false is a suggestion only. */
  const cluesOf = (subjectId: string, suggestion: any) => {
    const picked = new Set(Array.isArray(suggestion?.clue_ids) ? suggestion.clue_ids.map(String) : []);
    return shownClues.filter((c) => c.subject_id === subjectId)
      .sort((x, y) => Number(x.id) - Number(y.id))
      .map((c) => {
        const t = typeOf.get(c.clue_code);
        return {
          clue_id: Number(c.id),
          code: c.clue_code,
          words: t?.words ?? null,
          counts: t?.mode === "counts" && (t.class === "key" || t.class === "clue"),
          outcome: c.outcome ?? null,
          ...jobOf(typeof c.job_id === "string" ? c.job_id : null),
          division: c.division ?? null,
          names_one: c.names_one === true,
          seen_where: c.seen_where ?? null,
          seen_value: c.seen_value ?? null,
          in_suggestion: picked.has(String(c.id)),
        };
      });
  };

  // A document with a line of a person's labour (kind installer_bill, or a line
  // on a people account) is never listed, even when its item's kind or reason
  // says supplier bill (a mixed bill); nor is a credit that follows such a bill.
  const payDocs = new Set([...lines, ...billLines]
    .filter((l) => UNLISTED_LINE_KINDS.has(l.kind) || onPeopleAccount(people, l.account_code))
    .map((l) => `${l.document_kind}:${l.document_id}`));
  const listable = (it: any) => {
    const doc = costDocumentOf(it);
    if (!doc) return true;
    if (payDocs.has(`${doc.kind}:${doc.id}`)) return false;
    if (doc.kind !== "xero_credit_note") return true;
    return !lines.some((l) => l.document_kind === doc.kind && l.document_id === doc.id &&
      l.not_counted_reason !== "line_removed" && payDocs.has(`xero_bill:${billOfLine(l)}`));
  };

  const items = page.filter(listable).map((it) => {
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
      clues: cluesOf(String(it.subject_id), s),
      against: againstOf(it.evidence),
      lines: own
        .filter((l) => l.not_counted_reason !== "line_removed")
        .sort((x, y) => (Number(x.line_no) || 0) - (Number(y.line_no) || 0))
        .map((l) => ({ line_id: l.id, description: l.description ?? null, amount_ex: money(l.amount_ex), account_code: l.account_code ?? null, state: l.state ?? null })),
    };
    if (doc?.kind === "xero_bill") out.credits = creditsOf(doc.id);
    if (doc?.kind === "xero_credit_note") {
      const ids = [...new Set(own.filter((l) => l.not_counted_reason !== "line_removed").map(billOfLine)
        .filter((v): v is string => v !== null))];
      out.bills = ids.map((id) => {
        const b = bills.get(id)!;
        return {
          document_id: id,
          document_number: b.own[0]?.document_number ?? null,
          item_id: billItems.find((x) => x.subject_id === `xero_bill:${id}`)?.id ?? null,
          state: b.state,
          ...jobOf(b.job_id),
          division: b.division,
          ...(b.not_counted_reasons ? { not_counted_reasons: b.not_counted_reasons } : {}),
        };
      });
      // One bill: the screen's `bill`. None: not against a bill. Several: say so.
      out.bill = ids.length === 0 ? null : ids.length === 1 ? (out.bills as unknown[])[0] : { several: true };
    }
    return out;
  });

  return { ok: true, enabled: true, tab: input.tab, items, counts, next };
}

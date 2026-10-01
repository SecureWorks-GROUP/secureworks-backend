// Jan's morning text (plan step 5, docs/debt-book/PLAN.md sections 4 and 6 step 5). The
// captain's ruling (DECISIONS.md round 6, Q7): "Morning text to Jan that I approve; I record
// what he reports", "Yeap to Jan's phone number directly".
//
// One draft per morning, to Jan's own mobile, listing today's Jan visits from the morning list:
// every item at the jan_visit step that is not held (a broken promise at the Jan step
// included), each with the payer's name, the job's site address when it has one, the invoice
// numbers, the amount owing and how many days overdue. Shaun approves it through
// debt_draft_decide and it is sent through debt_draft_send (debt_desk_actions.ts): desk owner
// only, the same durable claim, the same sending switch, logged per covered invoice.
//
// Jan's mobile comes only from the one staff record (users) whose first name is Jan. When it
// cannot be found unambiguously the draft says "Jan's mobile not set in staff records" and
// cannot be approved. No number is ever written into the code.
//
// The draft id is `<perth date>:jan-<tag>-<wording tag>:jan:jan_text|<cents per invoice>`,
// where the tag is a short hash of Jan's number and the covered invoice ids in order, and the
// wording tag a short hash of the standard wording. So an approval is tied to the number and
// the list Shaun saw: a changed list or a changed number is a different draft.
//
// Jan's text goes to a member of staff, not a client, so the words no chase message may carry
// are not checked against the standard wording (its payers' names and job sites included: a
// street named Court is an address, not a threat). They are checked on the words Shaun adds or
// changes, found by comparing his text word by word with the standard wording; untouched and
// deleted lines need no check.
//
// Its chase-log rows carry no schedule step, so neither its approval nor its send moves any
// payer's ladder: the visit itself is recorded by debt_log_outcome (schedule_step jan_visit),
// and the payer stays on today's list until then. Once a Jan text is sent (or claimed) today it
// stays the day's Jan text, so logging Jan's report never offers a second text.
//
// Pure apart from createSupabaseJanStaffStore, which only reads.

import type { DebtMorningItem } from "./debt_chase_schedule.ts";
import { debtDraftStates } from "./debt_desk_drafts.ts";
import {
  type DebtDeskDraft,
  debtDraftId,
  debtDraftMoney,
  debtDraftTextProblem,
  parseDebtDraftId,
} from "./debt_draft_templates.ts";

export const JAN_TEXT_STEP = "jan_text" as const;
/** Each covered invoice is re-read live before the send: keep it well inside Xero's 60 a minute. */
export const JAN_TEXT_MAX_INVOICES = 30;
/** Ten SMS segments. */
export const JAN_TEXT_MAX_LENGTH = 1600;

export interface JanMobile {
  /** E.164, e.g. +61411222333; null when not set. */
  phone: string | null;
  source: "staff" | null;
  staff_user_id: string | null;
  staff_name: string | null;
  /** "Jan's mobile not set ..." when phone is null. */
  problem: string | null;
}

export interface JanStaffRecord {
  id: string;
  name: string | null;
  phone: string | null;
}

/** An Australian mobile in any common shape as +614XXXXXXXX, or null. */
export function normaliseAuMobile(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || !/^[+\d\s().-]+$/.test(text)) return null;
  let digits = text.replace(/\D/g, "");
  if (
    text.startsWith("+") || (digits.startsWith("61") && digits.length === 11)
  ) {
    if (!digits.startsWith("61")) return null;
    digits = `0${digits.slice(2)}`;
  }
  return /^04\d{8}$/.test(digits) ? `+61${digits.slice(1)}` : null;
}

function notSet(problem: string): JanMobile {
  return {
    phone: null,
    source: null,
    staff_user_id: null,
    staff_name: null,
    problem,
  };
}

const NOT_IN_STAFF = "Jan's mobile not set in staff records";

const firstName = (name: string | null) =>
  String(name ?? "").trim().split(/\s+/)[0].toLowerCase();

/** Jan's mobile: the one staff record named Jan. */
export function resolveJanMobile(staff: JanStaffRecord[]): JanMobile {
  const jans = staff.filter((u) => firstName(u.name) === "jan");
  if (!jans.length) {
    return notSet(`${NOT_IN_STAFF}: no staff record is named Jan`);
  }
  const phones = new Set(jans.map((u) => normaliseAuMobile(u.phone)));
  if (phones.size === 1 && !phones.has(null)) {
    const phone = [...phones][0]!;
    return {
      phone,
      source: "staff",
      staff_user_id: String(jans[0].id),
      staff_name: jans[0].name?.trim() || null,
      problem: null,
    };
  }
  return jans.length > 1
    ? notSet(
      `${NOT_IN_STAFF}: ${jans.length} staff records are named Jan, with different or missing mobiles`,
    )
    : notSet(
      `${NOT_IN_STAFF}: add an Australian mobile to Jan's staff record`,
    );
}

export interface JanStaffStore {
  /** Staff records whose name starts with "Jan" (the first-name match is done here). */
  janStaff(): Promise<JanStaffRecord[]>;
}

export function createSupabaseJanStaffStore(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
): JanStaffStore {
  return {
    async janStaff() {
      const { data, error } = await client.from("users")
        .select("id, name, phone").eq("org_id", orgId).ilike("name", "jan%");
      // A PostgREST error comes back, it is not thrown: an unread record must never read as
      // "nobody is named Jan".
      if (error) throw new Error(error?.message ?? String(error));
      return data || [];
    },
  };
}

/** Jan's mobile, read now from the staff records. */
export async function readJanMobile(store: JanStaffStore): Promise<JanMobile> {
  try {
    return resolveJanMobile(await store.janStaff());
  } catch (error) {
    console.error(
      "[debt_jan_text] staff records read failed",
      (error as Error)?.message ?? error,
    );
    return notSet(
      "Jan's mobile not set: the staff records could not be read. Try again shortly",
    );
  }
}

// ── The draft id ──

/** FNV-1a, 32 bits: a short stable tag, not a secret. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function janTextTag(phone: string, ids: string[]): string {
  return fnv1a(`${phone}|${ids.map((id) => id.toLowerCase()).join(",")}`);
}

const JAN_ID_TAGS = /^jan-([0-9a-f]{8})-([0-9a-f]{8})$/;

function janIdTags(draftId: string, count?: number) {
  const parsed = parseDebtDraftId(draftId);
  if (!parsed || parsed.step !== JAN_TEXT_STEP) return null;
  if (count !== undefined && parsed.amounts.length !== count) return null;
  const m = JAN_ID_TAGS.exec(parsed.item_id.split(":")[1] ?? "");
  return m ? { list: m[1], wording: m[2] } : null;
}

/** The draft id for Jan's text with this standard wording (`template`). */
export function janTextDraftId(
  perthDate: string,
  phone: string,
  invoices: Array<{ xero_invoice_id: string; amount_due: number }>,
  template: string,
): string {
  const tag = janTextTag(phone, invoices.map((i) => i.xero_invoice_id));
  return debtDraftId(
    `${perthDate}:jan-${tag}-${fnv1a(template)}:jan:${JAN_TEXT_STEP}`,
    invoices,
  );
}

/** True when the draft id was made for this number and these invoices, in this order. */
export function janTextDraftIdMatches(
  draftId: string,
  phone: string,
  ids: string[],
): boolean {
  return janIdTags(draftId, ids.length)?.list === janTextTag(phone, ids);
}

/** True when `template` is the standard wording the draft id was made for. */
export function janTextTemplateMatches(
  draftId: string,
  template: unknown,
): boolean {
  return typeof template === "string" &&
    janIdTags(draftId)?.wording === fnv1a(template);
}

/** Where the words of `text` that are not in `template` are: a word-by-word diff. */
function addedWords(text: string, template: string): Array<[number, number]> {
  const words = (s: string) => [...s.matchAll(/\S+/g)];
  const a = words(text);
  const b = words(template);
  const kept = Array.from(
    { length: a.length + 1 },
    () => new Uint16Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      kept[i][j] = a[i][0] === b[j][0]
        ? kept[i + 1][j + 1] + 1
        : Math.max(kept[i + 1][j], kept[i][j + 1]);
    }
  }
  const added: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < a.length;) {
    if (j < b.length && a[i][0] === b[j][0]) {
      i++;
      j++;
    } else if (j < b.length && kept[i][j + 1] >= kept[i + 1][j]) {
      j++;
    } else {
      added.push([a[i].index!, a[i].index! + a[i][0].length]);
      i++;
    }
  }
  return added;
}

/**
 * Why Jan's text may not be approved, or null when it may. Empty, em dash and length cover the
 * whole text; the words no chase message may carry are checked only where Shaun's text adds or
 * changes words of the standard wording (`template`).
 */
export function janTextProblem(text: unknown, template: string): string | null {
  if (typeof text !== "string" || text.length > JAN_TEXT_MAX_LENGTH) {
    return debtDraftTextProblem(text, JAN_TEXT_MAX_LENGTH);
  }
  const added = addedWords(text, template);
  return debtDraftTextProblem(
    text,
    JAN_TEXT_MAX_LENGTH,
    (start, end) => added.some(([s, e]) => s < end && start < e),
  );
}

// ── The wording ──

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function dayWords(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${
    MONTHS[d.getUTCMonth()]
  } ${d.getUTCFullYear()}`;
}

function listWords(parts: string[]): string {
  return parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export interface JanTextVisitInput {
  payer_name: string;
  site: string | null;
  invoices: Array<{ invoice_number: string; amount_due: number }>;
  amount: number;
  days_overdue: number | null;
}

/** The standard wording of Jan's morning text. */
export function janMorningText(
  perthDate: string,
  visits: JanTextVisitInput[],
): string {
  const lines = visits.map((v, k) => {
    const who = [v.payer_name, v.site]
      .map((s) => (s ?? "").replace(/\s+/g, " ").replace(/—/g, "-").trim())
      .filter(Boolean).join(", ");
    const days = v.days_overdue !== null && v.days_overdue > 0
      ? `, ${v.invoices.length > 1 ? "oldest " : ""}${v.days_overdue} day${
        v.days_overdue === 1 ? "" : "s"
      } overdue`
      : "";
    return `${k + 1}. ${who}: ${
      listWords(v.invoices.map((i) => i.invoice_number))
    }, ${debtDraftMoney(v.amount)} owing${days}.`;
  });
  return [
    `Hi Jan, your visits for ${dayWords(perthDate)}:`,
    ...lines,
    "Please tell Shaun how each visit goes. Thanks",
  ].join("\n");
}

// ── The draft on the morning list ──

export interface JanVisit {
  item_id: string;
  payer_key: string;
  payer_name: string;
  site: string | null;
  invoice_numbers: string[];
  xero_invoice_ids: string[];
  amount: number;
  days_overdue: number | null;
  /** True when the visit is a broken promise returning at the Jan step. */
  broken_promise: boolean;
}

/** Jan's morning text as debt_morning_list sends it (`jan_text`). */
export interface JanTextDraft
  extends Omit<DebtDeskDraft, "step" | "to" | "pay_links"> {
  step: typeof JAN_TEXT_STEP;
  to: "jan";
  /** Jan's mobile the text goes to (shown to Shaun before he approves); null when not set. */
  to_phone: string | null;
  mobile_source: JanMobile["source"];
  /** Today's Jan visits still on the list (after a send, those the sent text covered). */
  visits: JanVisit[];
  /** The invoices the text covers, in order: send these to debt_draft_decide. */
  xero_invoice_ids: string[];
  /** False when Jan's mobile is not set, the list cannot be one text, or it was sent. */
  approvable: boolean;
  /** Why it cannot be approved (for example "Jan's mobile not set in staff records: ..."). */
  problem: string | null;
}

export interface JanTextOptions {
  perthDate: string;
  mobile: JanMobile;
  /** The job's site address for an item's invoices. */
  siteFor: (item: DebtMorningItem) => string | null;
}

const cents = (n: number) => Math.round(Number(n || 0) * 100);

/** Today's Jan text from the morning list's items and the chase log. Null with no Jan visits. */
export function buildJanText(
  items: DebtMorningItem[],
  logRows: Record<string, unknown>[],
  opts: JanTextOptions,
): JanTextDraft | null {
  const states = debtDraftStates(logRows);
  const janItems = items.filter((i) => !i.hold && i.step === "jan_visit");
  const visits: JanVisit[] = janItems.map((i) => ({
    item_id: i.id,
    payer_key: i.payer_key,
    payer_name: i.payer_name,
    site: opts.siteFor(i),
    invoice_numbers: i.invoices.map((x) => x.invoice_number),
    xero_invoice_ids: i.invoices.map((x) => x.xero_invoice_id),
    amount: i.amount,
    days_overdue: i.days_overdue,
    broken_promise: i.group === "broken_promise",
  }));

  // A Jan text sent or claimed today stands for the rest of the day.
  const done = [...states.entries()].filter(([id, s]) => {
    const p = parseDebtDraftId(id);
    return p?.step === JAN_TEXT_STEP && p.perth_date === opts.perthDate &&
      (s.decision?.kind === "sent" || s.decision?.kind === "sending");
  }).sort((a, z) => a[1].decision!.at.localeCompare(z[1].decision!.at)).pop();
  if (done) {
    const [id, state] = done;
    const d = state.decision!;
    const covered = new Set(d.covers);
    return {
      id,
      channel: "sms",
      to: "jan",
      to_phone: opts.mobile.phone,
      mobile_source: opts.mobile.source,
      step: JAN_TEXT_STEP,
      visits: visits.filter((v) =>
        v.xero_invoice_ids.some((x) => covered.has(x.toLowerCase()))
      ),
      xero_invoice_ids: d.covers,
      text: d.text,
      template_text: null,
      status: d.kind as "sent" | "sending",
      edited: null,
      approved_by: state.approval?.by ?? null,
      approved_by_user_id: state.approval?.user_id ?? null,
      decided_at: d.at,
      last_send: d.kind === "sending" && d.reason
        ? { at: d.at, outcome: "not_confirmed", reason: d.reason }
        : null,
      approvable: false,
      problem: null,
    };
  }

  if (!visits.length) return null;
  const invoices = janItems.flatMap((i) => i.invoices);
  const template = janMorningText(
    opts.perthDate,
    visits.map((v, k) => ({
      payer_name: v.payer_name,
      site: v.site,
      invoices: janItems[k].invoices,
      amount: cents(v.amount) / 100,
      days_overdue: v.days_overdue,
    })),
  );
  const id = janTextDraftId(
    opts.perthDate,
    opts.mobile.phone ?? "",
    invoices,
    template,
  );
  const state = states.get(id);
  const decided = state?.decision ?? null;
  const status = decided && decided.kind !== "failed"
    ? decided.kind as "approved" | "skipped"
    : "pending";
  const text = decided?.text ?? template;
  const problem = opts.mobile.problem ??
    (invoices.length > JAN_TEXT_MAX_INVOICES
      ? `Jan's list covers ${invoices.length} invoices, more than the ${JAN_TEXT_MAX_INVOICES} one text can carry: log the visits already done, then read the list again`
      : template.length > JAN_TEXT_MAX_LENGTH
      ? `Jan's list is too long for one text (${template.length} characters, at most ${JAN_TEXT_MAX_LENGTH})`
      : janTextProblem(text, template));
  return {
    id,
    channel: "sms",
    to: "jan",
    to_phone: opts.mobile.phone,
    mobile_source: opts.mobile.source,
    step: JAN_TEXT_STEP,
    visits,
    xero_invoice_ids: invoices.map((i) => i.xero_invoice_id),
    text,
    template_text: template,
    status,
    edited: status === "approved" ? text !== template : false,
    approved_by: state?.approval?.by ?? null,
    approved_by_user_id: state?.approval?.user_id ?? null,
    decided_at: decided?.at ?? null,
    last_send: status === "approved" && state?.lastFailure
      ? {
        at: state.lastFailure.at,
        outcome: "failed",
        reason: state.lastFailure.reason,
      }
      : null,
    approvable: !problem,
    problem,
  };
}

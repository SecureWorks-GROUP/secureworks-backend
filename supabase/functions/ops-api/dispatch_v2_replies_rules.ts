// Dispatch v2, slice 8: supplier replies and suggested moves. The rules, pure.
//
// What this file decides, and nothing else does:
//   * who a captured email is from (one of our suppliers or not, and which);
//   * the job numbers and the supplier's own order numbers an email quotes;
//   * the delivery date an email gives, if any (simple, written-down rules,
//     Perth calendar days, no model call);
//   * which order an email belongs to, by the four rungs, surest first:
//       1. thread        same Outlook conversation as our sent order email
//       2. job_number    our job number (SWF-261387, SWP-26701, SWR-261499)
//       3. supplier_ref  the supplier's own number, already linked to an order
//       4. best_guess    e.g. the supplier has exactly one open order; a
//                        person must confirm it before anything is attached
//     and anything else from a supplier goes to the Unmatched tray.
//
// The reads and writes are dispatch_v2_replies.ts (the engine) and
// dispatch_v2_replies_store.ts (the database). Nothing here reads a database,
// the clock or the network, so every rule is tested on its own
// (dispatch_v2_replies_rules_test.ts).

// ── Shapes ────────────────────────────────────────────────────────────────

/** One captured inbound email, as the capture reader saved it in
 * business_events (supabase/functions/_shared/evidence/outlook_mail.ts). */
export type CapturedEmail = {
  business_event_id: string;
  sequence_number: number;
  provider_message_id: string | null;
  received_at: string | null;
  from_email: string | null;
  subject: string;
  // The new words of the email (the reader keeps only the new part of a
  // reply), with the reader's "Subject: ..." first line removed.
  body: string;
  conversation_id: string | null;
  // The reader's own sorting: "supplier" when the sender's domain is a
  // supplier's in Xero. Used only as a hint.
  sender_kind: string | null;
  has_attachments: boolean;
  attachment_names: string[];
};

/** One supplier on the app-kept approved order email list. */
export type ApprovedSupplierSender = {
  supplier_key: string;
  supplier_name: string;
  // suppliers.id rows (Xero contacts) that are this supplier.
  supplier_ids: string[];
  // Every approved To and CC address for the supplier, lower case.
  emails: string[];
};

/** One Xero supplier contact (suppliers table). */
export type SupplierContact = {
  id: string;
  name: string;
  email: string | null;
};

/** One Dispatch v2 order (one per supplier box). See the adapter,
 * dispatch_v2_replies_sources.ts, for where it comes from. */
export type V2Order = {
  order_id: string;
  job_id: string;
  job_number: string | null;
  supplier_id: string | null;
  supplier_name: string;
  // 'sent' once the order email went out. Anything in GONE_ORDER_STATUSES is
  // never matched.
  status: string;
  sent_at: string | null;
  sent_internet_message_id: string | null;
  sent_conversation_id: string | null;
  confirmed_delivery_date: string | null;
};

/** The job details the best guess may compare an email with. */
export type JobHint = {
  job_id: string;
  job_number: string | null;
  client_name: string | null;
  site_address: string | null;
  site_suburb: string | null;
  status: string | null;
  type: string | null;
};

export type SenderIdentity = {
  is_supplier: boolean;
  supplier_key: string | null;
  supplier_name: string | null;
  supplier_ids: string[];
  // How the sender was recognised.
  via:
    | "approved_address"
    | "approved_domain"
    | "supplier_contact_address"
    | "supplier_contact_domain"
    | "capture_hint"
    | null;
  // True for an address on (or the domain of) the approved order email list:
  // a supplier's order desk. Emails from elsewhere at a supplier (accounts,
  // marketing, no-reply) still match by the rungs, but an unmatched one is
  // kept out of the default tray view.
  order_desk: boolean;
};

export type MatchRung = "thread" | "job_number" | "supplier_ref" | "best_guess";

export type MatchCandidate = {
  order_id: string | null;
  job_id: string;
  job_number: string | null;
  supplier_name: string | null;
  reason: string;
};

export type MatchResult =
  | {
    state: "matched";
    rung: Exclude<MatchRung, "best_guess">;
    job_id: string;
    job_number: string | null;
    order_id: string | null;
    reason: string;
  }
  | {
    state: "needs_confirmation";
    rung: "best_guess";
    job_id: string;
    job_number: string | null;
    order_id: string;
    reason: string;
    candidates: MatchCandidate[];
  }
  | {
    state: "unmatched";
    rung: null;
    reason: string;
    candidates: MatchCandidate[];
  };

// ── Small helpers ─────────────────────────────────────────────────────────

export const GONE_ORDER_STATUSES = new Set([
  "cancelled",
  "canceled",
  "deleted",
  "discarded",
]);

// How long after it was sent an order still counts as open for a best guess.
export const BEST_GUESS_OPEN_DAYS = 90;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** "Name <a@b.com>" or "a@b.com" -> "a@b.com", lower case; null otherwise. */
export function emailAddressOf(value: unknown): string | null {
  const raw = text(value);
  const angled = /<([^<>]*)>/.exec(raw);
  const a = (angled ? angled[1] : raw).trim().toLowerCase();
  return /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(a) ? a : null;
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

// Shared mail services: a domain here never identifies a supplier by itself,
// only the exact address does.
const SHARED_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.com.au",
  "hotmail.com",
  "hotmail.com.au",
  "live.com",
  "live.com.au",
  "msn.com",
  "yahoo.com",
  "yahoo.com.au",
  "icloud.com",
  "me.com",
  "bigpond.com",
  "bigpond.net.au",
  "bigpond.com.au",
  "iinet.net.au",
  "westnet.com.au",
  "optusnet.com.au",
  "tpg.com.au",
  "internode.on.net",
]);

const OUR_DOMAIN =
  /(^|\.)(secureworkswa\.com\.au|secureworksgroup\.com\.au|secureworksgroup\.app)$/;

/** A stable key for a supplier name: lower case letters and digits only,
 * with company words dropped ("R & R Fencing Pty Ltd" -> "rrfencing"). */
export function supplierKeyOf(name: unknown): string {
  return text(name).toLowerCase()
    .replace(/&/g, " ")
    .replace(/\b(pty|ltd|limited|proprietary|the|co|company|group)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

// ── Who sent it ───────────────────────────────────────────────────────────

/** Who an email is from: one of our suppliers (and which), or not. The
 * approved order email list wins over the Xero contacts. */
export function identifySender(
  fromEmail: string | null,
  approved: ApprovedSupplierSender[],
  contacts: SupplierContact[],
  captureHint: string | null = null,
): SenderIdentity {
  const none: SenderIdentity = {
    is_supplier: false,
    supplier_key: null,
    supplier_name: null,
    supplier_ids: [],
    via: null,
    order_desk: false,
  };
  const from = emailAddressOf(fromEmail);
  if (!from) return none;
  const domain = domainOf(from);
  if (OUR_DOMAIN.test(domain)) return none;
  const sharedDomain = SHARED_MAIL_DOMAINS.has(domain);

  const pick = (
    entries: ApprovedSupplierSender[],
    via: SenderIdentity["via"],
  ): SenderIdentity | null => {
    const keys = [...new Set(entries.map((e) => e.supplier_key))];
    if (keys.length === 0) return null;
    if (keys.length > 1) {
      // One address or domain on two suppliers' lists: a supplier, but which
      // one is not known. The rungs that do not need the supplier still work.
      return { ...none, is_supplier: true, via, order_desk: true };
    }
    const e = entries[0];
    return {
      is_supplier: true,
      supplier_key: e.supplier_key,
      supplier_name: e.supplier_name,
      supplier_ids: [...new Set(entries.flatMap((x) => x.supplier_ids))],
      via,
      order_desk: true,
    };
  };

  const exact = approved.filter((a) => a.emails.includes(from));
  const byExact = pick(exact, "approved_address");
  if (byExact) return byExact;
  if (!sharedDomain) {
    const byDomain = pick(
      approved.filter((a) => a.emails.some((e) => domainOf(e) === domain)),
      "approved_domain",
    );
    if (byDomain) return byDomain;
  }

  const contactFor = (
    list: SupplierContact[],
    via: SenderIdentity["via"],
  ): SenderIdentity | null => {
    if (list.length === 0) return null;
    // A Xero contact that is on the approved list takes that supplier's key,
    // so its orders and its approved entry agree.
    const ids = list.map((c) => c.id);
    const owner = approved.filter((a) =>
      a.supplier_ids.some((id) => ids.includes(id))
    );
    const ownerKeys = [...new Set(owner.map((a) => a.supplier_key))];
    if (ownerKeys.length === 1) {
      return {
        is_supplier: true,
        supplier_key: owner[0].supplier_key,
        supplier_name: owner[0].supplier_name,
        supplier_ids: [...new Set([...owner[0].supplier_ids, ...ids])],
        via,
        order_desk: false,
      };
    }
    const keys = [...new Set(list.map((c) => supplierKeyOf(c.name)))];
    if (keys.length !== 1 || !keys[0]) {
      return { ...none, is_supplier: true, via, order_desk: false };
    }
    return {
      is_supplier: true,
      supplier_key: keys[0],
      supplier_name: list[0].name,
      supplier_ids: ids,
      via,
      order_desk: false,
    };
  };

  const byContact = contactFor(
    contacts.filter((c) => emailAddressOf(c.email) === from),
    "supplier_contact_address",
  );
  if (byContact) return byContact;
  if (!sharedDomain) {
    const byContactDomain = contactFor(
      contacts.filter((c) => {
        const a = emailAddressOf(c.email);
        return !!a && domainOf(a) === domain;
      }),
      "supplier_contact_domain",
    );
    if (byContactDomain) return byContactDomain;
  }

  if (captureHint === "supplier") {
    return { ...none, is_supplier: true, via: "capture_hint" };
  }
  return none;
}

/** An out-of-office or automatic reply: never matched, never stored. */
export function isAutoReply(subject: string, body: string): boolean {
  const s = subject.trim().toLowerCase();
  if (
    /^(automatic reply|auto(matic)?[- ]?reply|auto[- ]?response|out of (the )?office|ooo\b|undeliverable|delivery status notification|mail delivery failed|read:)/
      .test(s)
  ) return true;
  const b = body.slice(0, 600).toLowerCase();
  return /\b(i am|i'm) (currently )?(out of the office|away from the office|on leave)\b/
    .test(b) && b.length < 600;
}

// ── What it quotes ────────────────────────────────────────────────────────

// Our job numbers: SW, one to three letters (F fencing, P patio, R repair, M,
// D ...), an optional hyphen or space, then 4 to 7 digits. SWMS (make-safe)
// jobs never reach Dispatch, so they are not read.
const JOB_NUMBER_RE = /(?<![A-Za-z0-9])SW([A-Z]{1,3})[- ]?(\d{4,7})(?![0-9])/gi;

/** Our job numbers an email names, normalised to SWF-261387, distinct, in the
 * order first seen (subject first, then the words). */
export function jobNumbersIn(subject: string, body: string): string[] {
  const out: string[] = [];
  for (const source of [subject, body]) {
    for (const m of source.matchAll(JOB_NUMBER_RE)) {
      const letters = m[1].toUpperCase();
      if (letters === "MS") continue;
      const n = `SW${letters}-${m[2]}`;
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** The ways a job number may be stored: SWF-261387 and SWF261387. */
export function jobNumberForms(jobNumber: string): string[] {
  const n = jobNumber.toUpperCase();
  const bare = n.replace("-", "");
  return n === bare ? [n] : [n, bare];
}

export function normaliseJobNumber(value: unknown): string {
  const n = text(value).trim().toUpperCase();
  const m = /^SW([A-Z]{1,3})-?(\d{4,7})$/.exec(n);
  return m ? `SW${m[1]}-${m[2]}` : n;
}

// A supplier's own number comes after a label that says what it is. "Your
// ref" is OUR reference written back to us, and an account or customer number
// is the same on every order, so neither is read.
const SUPPLIER_REF_RE =
  /(?<!your\s{1,3})(?<!customer\s{1,3})\b(sales\s+order|order\s+confirmation|purchase\s+order|order|s\/o|so|tax\s+invoice|sales\s+invoice|invoice|inv|quotation|quote|delivery\s+docket|docket|consignment|con\s*note|booking|our\s+ref(?:erence)?|ref(?:erence)?)\b\.?\s*(?:no\.?|number|num|#)?\s*[:#.\- ]\s*([A-Z]{0,4}[-/]?\d[A-Z0-9/-]{2,19})/gi;

/** The supplier's own order, invoice or quote numbers an email quotes,
 * upper case, distinct. Our job numbers and our v1 PO numbers are left out. */
export function supplierRefsIn(subject: string, body: string): string[] {
  const out: string[] = [];
  for (const source of [subject, body]) {
    for (const m of source.matchAll(SUPPLIER_REF_RE)) {
      let ref = m[2].toUpperCase().replace(/[-/.]+$/, "");
      if ((ref.match(/\d/g) ?? []).length < 3) continue;
      if (/^SW[A-Z]{1,3}-?\d/.test(ref)) continue;
      if (/^PO-?\d/.test(ref)) continue;
      // A bare date (4/11/2026) is not a number.
      if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(ref)) continue;
      ref = ref.replace(/\s+/g, "");
      if (ref.length > 24) continue;
      if (!out.includes(ref)) out.push(ref);
    }
  }
  return out;
}

// ── Delivery dates ────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const WD =
  "(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)";
const MO =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

// The forms read, each with an optional weekday in front:
//   4 Nov, 4th November, 4 November 2026      (day month [year])
//   Nov 4, November 4th, Nov 4 2026            (month day [year])
//   4/11, 04/11/2026, 4-11-26, 4.11.2026       (day/month[/year], Australian order)
//   2026-11-04                                  (ISO)
//   Tuesday, tomorrow, today                    (a day word alone)
const DATE_RE = new RegExp(
  [
    `(?<iso>\\b(?<iy>20\\d{2})-(?<im>\\d{2})-(?<id>\\d{2})\\b)`,
    `(?<dm>(?:(?<dmw>${WD})\\.?,?\\s+(?:the\\s+)?)?\\b(?<dmd>\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(?<dmm>${MO})\\b\\.?(?:,?\\s+(?<dmy>20\\d{2}))?)`,
    `(?<md>(?:(?<mdw>${WD})\\.?,?\\s+)?\\b(?<mdm>${MO})\\.?\\s+(?<mdd>\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(?<mdy>20\\d{2}))?)`,
    `(?<num>(?:(?<nw>${WD})\\.?,?\\s+)?(?<![\\w/.:-])(?<nd>\\d{1,2})(?<sep>[/-])(?<nm>\\d{1,2})(?:\\k<sep>(?<ny>\\d{4}|\\d{2}))?(?![\\w/:-]|\\.\\d))`,
    `(?<dot>(?:(?<dw>${WD})\\.?,?\\s+)?(?<![\\w/.:-])(?<dd>\\d{1,2})\\.(?<dmo>\\d{1,2})\\.(?<dy>\\d{4}|\\d{2})(?![\\w/.:-]))`,
    `(?<rel>\\b(?<relw>tomorrow|today)\\b)`,
    `(?<wd>\\b(?:(?<wdq>this|next|on)\\s+)?(?<wdn>${WD})\\b)`,
  ].join("|"),
  "gi",
);

// Words that put a date in a delivery sentence.
const DELIVERY_WORDS =
  /\b(deliver\w*|despatch\w*|dispatch\w*|eta|arriv\w*|on\s*site|booked|book(?:ed)?\s+in|truck|run|ship\w*|freight|ready|pick\s*up|pickup|collect\w*|supply|supplied|send(?:ing)?\s+out|going\s+out|out\s+for|drop(?:ped)?\s+off|lead\s+time|available)\b/i;
// Words that say the date is not a delivery (we are closed, we cannot).
// ("no" alone is not one of them: "Order No 7781" is common.)
const NOT_DELIVERY_WORDS =
  /\b(no\s+deliver\w*|not|cannot|can't|cant|unable|won't|wont|closed|closure|shut\w*|holiday|holidays|invoice\s+date|due\s+date|statement|overdue|payment|paid)\b/i;
// A day range or a standing day ("Mon to Fri", "Monday - Friday") is opening
// hours, not a delivery day: removed before dates are read.
const DAY_RANGE = new RegExp(
  `\\b(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\\b\\s*(?:-|–|to|until|till|through|thru)\\s*\\b(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\\b|\\bevery\\s+\\w+`,
  "gi",
);
// Header lines of quoted mail and of our own order email ("Date:" is the
// date WE asked for, not the supplier's answer).
const HEADER_LINE =
  /^\s*(subject|sent|date|from|to|cc|bcc|received|delivery\s+date\s+requested)\s*:/i;
const WROTE_LINE = /^\s*on\s.+\bwrote:\s*$/i;

export type DeliveryDateRead = {
  // YYYY-MM-DD, a Perth calendar day.
  date: string;
  // "Tue 4 Nov"
  label: string;
  // The words the date was read from, cut to 160 characters.
  quote: string;
  // The weekday written did not fall on that date (the date wins).
  weekday_mismatch: boolean;
  // The email named only a day word ("Thursday", "tomorrow").
  day_word_only: boolean;
  // Other delivery dates in the same email: worth a look before accepting.
  other_dates: string[];
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 &&
    t.getUTCDate() === d;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

function isoFromDayNumber(n: number): string {
  const t = new Date(n * 86_400_000);
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function weekdayOfIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The Perth calendar day (UTC+8, no daylight saving) of an instant. */
export function perthDay(instant: string | null | undefined): string | null {
  const t = Date.parse(String(instant ?? ""));
  if (!Number.isFinite(t)) return null;
  const p = new Date(t + 8 * 3_600_000);
  return isoOf(p.getUTCFullYear(), p.getUTCMonth() + 1, p.getUTCDate());
}

const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO_SHORT = [
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

/** "2026-11-04" -> "Tue 4 Nov". */
export function dayLabel(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${WD_SHORT[weekdayOfIso(iso)]} ${d} ${MO_SHORT[m - 1]}`;
}

// A date with no year is the next one on or after a week before the email
// (a supplier may restate a date already passed this week; anything earlier
// is next year's).
function withYear(m: number, d: number, base: string): string | null {
  const baseYear = Number(base.slice(0, 4));
  for (const y of [baseYear, baseYear + 1]) {
    if (!validDate(y, m, d)) continue;
    const iso = isoOf(y, m, d);
    if (dayNumber(iso) >= dayNumber(base) - 7) return iso;
  }
  return null;
}

function fullYear(y: string | undefined): number | null {
  if (!y) return null;
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

type DateHit = {
  date: string;
  index: number;
  weekday_mismatch: boolean;
  day_word_only: boolean;
};

function readHit(g: Record<string, string | undefined>, base: string):
  | Omit<DateHit, "index">
  | null {
  let iso: string | null = null;
  let weekday: string | undefined;
  if (g.iso) {
    const y = Number(g.iy), m = Number(g.im), d = Number(g.id);
    iso = validDate(y, m, d) ? isoOf(y, m, d) : null;
  } else if (g.dm || g.md) {
    const dayText = g.dm ? g.dmd : g.mdd;
    const monthText = (g.dm ? g.dmm : g.mdm) ?? "";
    const yearText = g.dm ? g.dmy : g.mdy;
    weekday = g.dm ? g.dmw : g.mdw;
    const m = MONTHS[monthText.toLowerCase().replace(/\.$/, "")];
    const d = Number(dayText);
    const y = fullYear(yearText);
    if (!m) return null;
    iso = y
      ? (validDate(y, m, d) ? isoOf(y, m, d) : null)
      : withYear(m, d, base);
  } else if (g.num || g.dot) {
    const d = Number(g.num ? g.nd : g.dd);
    const m = Number(g.num ? g.nm : g.dmo);
    const y = fullYear(g.num ? g.ny : g.dy);
    weekday = g.num ? g.nw : g.dw;
    iso = y
      ? (validDate(y, m, d) ? isoOf(y, m, d) : null)
      : withYear(m, d, base);
  } else if (g.rel) {
    const word = (g.relw ?? "").toLowerCase();
    iso = isoFromDayNumber(dayNumber(base) + (word === "tomorrow" ? 1 : 0));
    return { date: iso, weekday_mismatch: false, day_word_only: true };
  } else if (g.wd) {
    const target = WEEKDAYS[(g.wdn ?? "").toLowerCase()];
    if (target === undefined) return null;
    // The next such day after the email's day.
    const b = dayNumber(base);
    let ahead = (target - weekdayOfIso(base) + 7) % 7;
    if (ahead === 0) ahead = 7;
    return {
      date: isoFromDayNumber(b + ahead),
      weekday_mismatch: false,
      day_word_only: true,
    };
  }
  if (!iso) return null;
  let mismatch = false;
  if (weekday) {
    const w = WEEKDAYS[weekday.toLowerCase()];
    mismatch = w !== undefined && w !== weekdayOfIso(iso);
  }
  return { date: iso, weekday_mismatch: mismatch, day_word_only: false };
}

/** The delivery date an email gives, read with simple rules:
 *   * only in a sentence that talks about delivery (deliver, dispatch, ETA,
 *     booked in, truck, ready, pick up ...), and never one that says no,
 *     cannot, closed, holiday, invoice date, due, payment ...;
 *   * never in a quoted header line (Sent:, Date:, From:) or "On ... wrote:";
 *   * Australian day/month order; a date with no year is the next one (on or
 *     after a week before the email); a day word alone ("Thursday") is the
 *     next such day after the email; "tomorrow" is the next Perth day;
 *   * a date before the email's Perth day, or more than 180 days after it, is
 *     not read;
 *   * the first delivery date written wins; any others are listed.
 * `receivedAt` is the email's instant; its Perth day is the base. */
export function readDeliveryDate(
  body: string,
  receivedAt: string | null,
): DeliveryDateRead | null {
  const base = perthDay(receivedAt);
  if (!base) return null;
  const lines = String(body ?? "").split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (WROTE_LINE.test(line)) break; // quoted history starts here
    if (/^-{2,}\s*original message\s*-{2,}/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    if (HEADER_LINE.test(line)) continue;
    kept.push(line);
  }
  // Sentences: split on full stops followed by a space, ! ? and new lines,
  // so "4.11.2026" stays whole.
  const sentences = kept.join("\n").split(/(?<=[!?])\s+|\.\s+|\n+/);
  const hits: (DateHit & { quote: string })[] = [];
  let offset = 0;
  for (const sentence of sentences) {
    const s = sentence.trim().replace(DAY_RANGE, " ");
    offset++;
    if (!s || !DELIVERY_WORDS.test(s) || NOT_DELIVERY_WORDS.test(s)) continue;
    for (const m of s.matchAll(DATE_RE)) {
      const hit = readHit(m.groups ?? {}, base);
      if (!hit) continue;
      const n = dayNumber(hit.date);
      if (n < dayNumber(base) || n > dayNumber(base) + 180) continue;
      hits.push({
        ...hit,
        index: offset * 10_000 + (m.index ?? 0),
        quote: s.slice(0, 160),
      });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.index - b.index);
  // A written date beats a day word in the same email.
  const firm = hits.filter((h) => !h.day_word_only);
  const first = (firm.length ? firm : hits)[0];
  const others = [...new Set(hits.map((h) => h.date))].filter((d) =>
    d !== first.date
  );
  return {
    date: first.date,
    label: dayLabel(first.date),
    quote: first.quote,
    weekday_mismatch: first.weekday_mismatch,
    day_word_only: first.day_word_only,
    other_dates: others,
  };
}

/** The suggestion's words: "Stratco: delivery Tue 4 Nov". */
export function suggestionLabel(supplierName: string | null, date: string) {
  const who = text(supplierName).trim() || "Supplier";
  return `${who}: delivery ${dayLabel(date)}`;
}

// ── Which order: the four rungs ───────────────────────────────────────────

export type MatchInputs = {
  email: CapturedEmail;
  sender: SenderIdentity;
  // Every Dispatch v2 order that is not gone (any job).
  orders: V2Order[];
  // Conversation ids our sent order emails are known by: the order's own,
  // plus the conversation id of the captured copy of that sent email (the
  // reader saw it in admin@ Sent Items). order_id -> ids.
  orderConversationIds: Map<string, string[]>;
  // Jobs found by the job numbers the email quotes (job number -> job).
  jobsByNumber: Map<string, JobHint>;
  // Supplier refs already linked to orders: ref -> links.
  refLinks: Map<string, { order_id: string; supplier_key: string | null }[]>;
  // The job details of every order's job (for the best guess).
  jobsById: Map<string, JobHint>;
  // Orders a person already said this email is NOT for.
  rejectedOrderIds: string[];
};

function orderSupplierKey(
  order: V2Order,
  approved: ApprovedSupplierSender[],
): string {
  if (order.supplier_id) {
    const owner = approved.find((a) =>
      a.supplier_ids.includes(order.supplier_id!)
    );
    if (owner) return owner.supplier_key;
  }
  return supplierKeyOf(order.supplier_name);
}

/** True when the order is with the supplier the email came from. */
export function orderIsFromSender(
  order: V2Order,
  sender: SenderIdentity,
  approved: ApprovedSupplierSender[],
): boolean {
  if (!sender.is_supplier) return false;
  if (order.supplier_id && sender.supplier_ids.includes(order.supplier_id)) {
    return true;
  }
  return !!sender.supplier_key &&
    orderSupplierKey(order, approved) === sender.supplier_key;
}

function latestSent(orders: V2Order[]): V2Order {
  return [...orders].sort((a, b) =>
    String(b.sent_at ?? "").localeCompare(String(a.sent_at ?? ""))
  )[0];
}

function isSent(order: V2Order): boolean {
  return !!order.sent_at || order.status === "sent";
}

function candidateOf(
  order: V2Order | null,
  job: JobHint | undefined,
  reason: string,
  jobId?: string,
): MatchCandidate {
  return {
    order_id: order?.order_id ?? null,
    job_id: order?.job_id ?? jobId ?? job?.job_id ?? "",
    job_number: order?.job_number ?? job?.job_number ?? null,
    supplier_name: order?.supplier_name ?? null,
    reason,
  };
}

function words(value: string | null): string[] {
  return text(value).toLowerCase().split(/[^a-z0-9]+/).filter((w) =>
    w.length >= 3
  );
}

// How strongly an email points at a job: its street (number and name), its
// client's surname, its suburb.
function jobScore(job: JobHint | undefined, haystack: string): {
  score: number;
  reason: string;
} {
  if (!job) return { score: 0, reason: "" };
  const h = ` ${haystack.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  let score = 0;
  const reasons: string[] = [];
  const address = text(job.site_address).toLowerCase();
  const street = /(\d+[a-z]?)\s+([a-z][a-z' -]{2,})/.exec(address);
  if (street) {
    const name = street[2].trim().split(/\s+/)[0];
    if (name.length >= 3 && h.includes(` ${street[1]} ${name} `)) {
      score += 3;
      reasons.push("site address");
    }
  }
  const surname = words(job.client_name).pop();
  if (surname && surname.length >= 3 && h.includes(` ${surname} `)) {
    score += 2;
    reasons.push("client name");
  }
  const suburb = text(job.site_suburb).toLowerCase().trim();
  if (
    suburb.length >= 4 && h.includes(` ${suburb.replace(/[^a-z0-9]+/g, " ")} `)
  ) {
    score += 1;
    reasons.push("suburb");
  }
  return { score, reason: reasons.join(", ") };
}

/** Which order an email belongs to, surest rung first. Pure: every read the
 * rungs need is in `inputs`. `now` is the run's instant (open-order window). */
export function matchEmail(
  inputs: MatchInputs,
  approved: ApprovedSupplierSender[],
  now: string,
): MatchResult {
  const { email, sender } = inputs;
  const live = inputs.orders.filter((o) =>
    !GONE_ORDER_STATUSES.has(String(o.status).toLowerCase())
  );

  // 1. Same thread as our sent order email.
  if (email.conversation_id) {
    const inThread = live.filter((o) =>
      (inputs.orderConversationIds.get(o.order_id) ?? []).includes(
        email.conversation_id!,
      )
    );
    if (inThread.length > 0) {
      const o = latestSent(inThread);
      return {
        state: "matched",
        rung: "thread",
        job_id: o.job_id,
        job_number: o.job_number,
        order_id: o.order_id,
        reason: "Same thread as our order email",
      };
    }
  }

  // 2. Our job number in the subject or the words.
  const numbers = jobNumbersIn(email.subject, email.body);
  const jobs = numbers.map((n) => inputs.jobsByNumber.get(n)).filter((
    j,
  ): j is JobHint => !!j);
  const distinctJobs = [...new Map(jobs.map((j) => [j.job_id, j])).values()];
  if (distinctJobs.length > 0) {
    let job: JobHint | null = null;
    if (distinctJobs.length === 1) job = distinctJobs[0];
    else {
      const withSupplierOrder = distinctJobs.filter((j) =>
        live.some((o) =>
          o.job_id === j.job_id && orderIsFromSender(o, sender, approved)
        )
      );
      if (withSupplierOrder.length === 1) job = withSupplierOrder[0];
      else {
        const inSubject = jobNumbersIn(email.subject, "")
          .map((n) => inputs.jobsByNumber.get(n)).find((j) => !!j);
        if (inSubject) job = inSubject;
      }
    }
    if (!job) {
      return {
        state: "unmatched",
        rung: null,
        reason: "Names more than one of our jobs",
        candidates: distinctJobs.map((j) =>
          candidateOf(null, j, "job number in email", j.job_id)
        ),
      };
    }
    const jobOrders = live.filter((o) => o.job_id === job!.job_id);
    const fromSender = jobOrders.filter((o) =>
      orderIsFromSender(o, sender, approved)
    );
    let order: V2Order | null = null;
    if (fromSender.length > 0) order = latestSent(fromSender);
    else if (!sender.supplier_key && jobOrders.length === 1) {
      order = jobOrders[0];
    }
    return {
      state: "matched",
      rung: "job_number",
      job_id: job.job_id,
      job_number: job.job_number,
      order_id: order?.order_id ?? null,
      reason: `Job number ${job.job_number ?? numbers[0]} in the email`,
    };
  }

  // 3. The supplier's own number, already linked to an order.
  const refs = supplierRefsIn(email.subject, email.body);
  const linkedOrderIds = new Set<string>();
  for (const ref of refs) {
    for (const link of inputs.refLinks.get(ref) ?? []) {
      if (
        sender.supplier_key && link.supplier_key &&
        link.supplier_key !== sender.supplier_key
      ) continue;
      linkedOrderIds.add(link.order_id);
    }
  }
  const linked = live.filter((o) => linkedOrderIds.has(o.order_id));
  if (linked.length === 1) {
    const o = linked[0];
    return {
      state: "matched",
      rung: "supplier_ref",
      job_id: o.job_id,
      job_number: o.job_number,
      order_id: o.order_id,
      reason: "Supplier's own number already linked to this order",
    };
  }
  if (linked.length > 1) {
    return {
      state: "unmatched",
      rung: null,
      reason: "Supplier's number is linked to more than one order",
      candidates: linked.map((o) =>
        candidateOf(o, inputs.jobsById.get(o.job_id), "supplier number")
      ),
    };
  }

  // 4. Best guess, for a person to confirm.
  const cutoff = Date.parse(now) - BEST_GUESS_OPEN_DAYS * 86_400_000;
  const open = live.filter((o) =>
    isSent(o) && orderIsFromSender(o, sender, approved) &&
    !inputs.rejectedOrderIds.includes(o.order_id) &&
    (!o.sent_at || Date.parse(o.sent_at) >= cutoff) &&
    (!o.sent_at || !email.received_at ||
      Date.parse(o.sent_at) <= Date.parse(email.received_at))
  );
  if (open.length === 1) {
    const o = open[0];
    return {
      state: "needs_confirmation",
      rung: "best_guess",
      job_id: o.job_id,
      job_number: o.job_number,
      order_id: o.order_id,
      reason: `${o.supplier_name} has one open order`,
      candidates: [
        candidateOf(o, inputs.jobsById.get(o.job_id), "only open order"),
      ],
    };
  }
  if (open.length > 1) {
    const haystack = `${email.subject}\n${email.body}`;
    const scored = open.map((o) => ({
      o,
      ...jobScore(inputs.jobsById.get(o.job_id), haystack),
    })).sort((a, b) => b.score - a.score);
    const top = scored[0];
    const candidates = scored.slice(0, 5).map((s) =>
      candidateOf(
        s.o,
        inputs.jobsById.get(s.o.job_id),
        s.score > 0 ? s.reason : "open order",
      )
    );
    if (top.score > 0 && (scored.length === 1 || scored[1].score < top.score)) {
      return {
        state: "needs_confirmation",
        rung: "best_guess",
        job_id: top.o.job_id,
        job_number: top.o.job_number,
        order_id: top.o.order_id,
        reason: `Mentions the job's ${top.reason}`,
        candidates,
      };
    }
    return {
      state: "unmatched",
      rung: null,
      reason: `${open.length} open orders with this supplier`,
      candidates,
    };
  }
  return {
    state: "unmatched",
    rung: null,
    reason: sender.supplier_name
      ? `No open order with ${sender.supplier_name}`
      : "Supplier not known",
    candidates: [],
  };
}

/** Plain words for a rung, for the screen. */
export function rungLabel(rung: string | null): string | null {
  switch (rung) {
    case "thread":
      return "Same thread";
    case "job_number":
      return "Job number in email";
    case "supplier_ref":
      return "Supplier's own number";
    case "best_guess":
      return "Best guess";
    case "manual":
      return "Picked by hand";
    default:
      return null;
  }
}

/** The stage move the screen may OFFER after a delivery date is accepted.
 * Never applied here: the screen asks, then calls update_job_status. */
export function stageMoveOffer(job: JobHint | null): {
  from_status: string;
  to_status: string;
  label: string;
} | null {
  if (!job || String(job.type ?? "").toLowerCase() === "repair") return null;
  const s = String(job.status ?? "").toLowerCase();
  if (s === "order_materials" || s === "awaiting_supplier") {
    return {
      from_status: s,
      to_status: "order_confirmed",
      label: "Move to Order Confirmed?",
    };
  }
  return null;
}

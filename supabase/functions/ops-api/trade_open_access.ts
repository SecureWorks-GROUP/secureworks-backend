// Trade open access (Marnin, 13 Nov 2026). Three rulings for the trades' app,
// each behind its own switch, all seeded OFF (20261113090000):
//
//   trade_company_job_view_v1  any trade may find and open any live job in
//                              their company, read only, no prices, and the
//                              customer's phone and email only once the trade
//                              is on the job (tier `company_view`).
//   trade_self_booking_v1      a trade may book THEMSELVES on a job for today
//                              or a future day, and undo their own booking
//                              (trade_self_allocation.ts).
//   trade_rate_editable_v1     a trade may type their hourly rate on a job
//                              card of their weekly invoice; the office sees
//                              the changed rate flagged, and a rate above the
//                              limit is held for office review.
//
// This file holds the switches and the pure rules for what a `company_view`
// reader is shown. Contract: docs/trade-open-access-v1.md.
// deno-lint-ignore-file no-explicit-any

export const TRADE_COMPANY_JOB_VIEW_FLAG = "trade_company_job_view_v1";
export const TRADE_SELF_BOOKING_FLAG = "trade_self_booking_v1";
export const TRADE_RATE_EDITABLE_FLAG = "trade_rate_editable_v1";

/**
 * Reads one of the three switches. A missing or unreadable row is OFF: a flag
 * read fault must never open a door, and never be why a read fails.
 */
export async function tradeOpenAccessFlagOn(client: any, flagName: string): Promise<boolean> {
  try {
    const { data, error } = await client.from("feature_flags")
      .select("enabled")
      .eq("flag_name", flagName)
      .limit(1);
    if (error) {
      console.error(`[ops-api] ${flagName} unreadable, treating as off:`, error.message);
      return false;
    }
    return (Array.isArray(data) ? data[0] : data)?.enabled === true;
  } catch (error) {
    console.error(
      `[ops-api] ${flagName} read threw, treating as off:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

// ── What a company_view reader never gets: the customer's contact ───────────

const CONTACT_KEY_SUFFIXES = ["phone", "phonenumber", "mobile", "mobilenumber", "email", "emailaddress"];
const CONTACT_KEY_EXACT = new Set(["ghlcontactid"]);

/**
 * True for a key that names a phone number, an email address or the CRM
 * contact (client_phone, clientEmail, contact_phone, mobile, ghl_contact_id).
 * A key that only mentions an email (builder_email_subject) is not one.
 */
export function isCustomerContactKey(key: string): boolean {
  const k = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!k) return false;
  if (CONTACT_KEY_EXACT.has(k)) return true;
  return CONTACT_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix));
}

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Australian numbers as people write them: 0412 345 678, 0412345678,
// 04 1234 5678, (08) 9123 4567, 08 9123 4567, +61 412 345 678, +61 8 9123 4567.
// Deliberately narrow: a job number, a purchase order or a measurement never
// has one of these shapes, and a run of digits inside a longer word or id
// (letters or digits either side) is never one. A bare eight-digit landline is
// not matched.
const PHONE_IN_TEXT = new RegExp(
  "(?<![\\dA-Za-z+])(?:" +
    "\\+?61[\\s-]?\\(?0?\\)?[\\s-]?4\\d{2}[\\s-]?\\d{3}[\\s-]?\\d{3}" +
    "|\\+?61[\\s-]?\\(?0?\\)?[\\s-]?[2378][\\s-]?\\d{4}[\\s-]?\\d{4}" +
    "|04\\d{2}[\\s-]?\\d{3}[\\s-]?\\d{3}" +
    "|\\(0[2-478]\\)[\\s-]?\\d{4}[\\s-]?\\d{4}" +
    "|0[2-478][\\s-]?\\d{4}[\\s-]?\\d{4}" +
    ")(?![\\dA-Za-z])",
  "g",
);

export const HIDDEN_PHONE_TEXT = "[phone hidden]";
export const HIDDEN_EMAIL_TEXT = "[email hidden]";

// A link or an inline file is never free text, and a very long string is a
// media blob, not a note.
const MASK_MAX_TEXT_LENGTH = 20000;

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMaskableText(value: string): boolean {
  if (value.length > MASK_MAX_TEXT_LENGTH) return false;
  if (UUID_TEXT.test(value.trim())) return false;
  return !/^\s*(?:data:|https?:\/\/)/i.test(value);
}

// A value under one of these keys is an identifier, a reference, a link or a
// file path, never prose: it is passed through untouched so the masker can
// never damage an id the app needs.
function isIdentifierKey(key: string): boolean {
  return /(?:^id$|_ids?$|Ids?$|_number$|Number$|_ref$|Ref$|_url$|Url$|^url$|^path$|_path$|Path$|_token$|_hash$|_at$|_date$|^date$)/
    .test(String(key || ""));
}

/**
 * Best effort: replaces phone numbers and email addresses written inside free
 * text (a note, the builder's email, a work order instruction). The named
 * contact fields are removed by key; this covers a number typed into prose.
 */
export function maskContactInText(value: string): string {
  if (typeof value !== "string" || !value || !isMaskableText(value)) return value;
  return value.replace(EMAIL_IN_TEXT, HIDDEN_EMAIL_TEXT).replace(PHONE_IN_TEXT, HIDDEN_PHONE_TEXT);
}

const STRIP_MAX_DEPTH = 40;

function walkContact(value: any, dropKeys: boolean, depth: number): any {
  if (typeof value === "string") return maskContactInText(value);
  if (value === null || typeof value !== "object") return value;
  // Past the cap nothing is passed through unread.
  if (depth > STRIP_MAX_DEPTH) return Array.isArray(value) ? [] : null;
  if (Array.isArray(value)) return value.map((item) => walkContact(item, dropKeys, depth + 1));
  const out: Record<string, any> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (dropKeys && isCustomerContactKey(key)) continue;
    out[key] = typeof inner === "string" && isIdentifierKey(key) && !isCustomerContactKey(key)
      ? inner
      : walkContact(inner, dropKeys, depth + 1);
  }
  return out;
}

/**
 * A copy of `value` with every contact key removed at every depth and every
 * phone number or email written in free text masked. Never mutates its input.
 */
export function stripCustomerContactDeep<T>(value: T): T {
  return walkContact(value, true, 0) as T;
}

/** As above, keeping every key: only free text is masked. */
export function maskContactDeep<T>(value: T): T {
  return walkContact(value, false, 0) as T;
}

/**
 * Who is on the job, for a reader who is not on it: name, user, day, status
 * and the lead mark. No phone, no hours, no clock stamps, no watcher rows.
 */
export function projectCompanyViewCrew(crew: any[]): any[] {
  return (crew || [])
    .filter((row: any) =>
      row && row.is_ghost !== true && String(row.role || "").toLowerCase() !== "observer"
    )
    .map((row: any) => ({
      id: row.id ?? null,
      user_id: row.user_id ?? null,
      name: row.name ?? row.users?.name ?? row.crew_name ?? null,
      scheduled_date: row.scheduled_date ?? null,
      status: row.status ?? null,
      is_lead: row.is_lead === true,
    }));
}

/**
 * trade_job_detail for the company_view tier. `detail` is the response as the
 * allocated tier would get it (prices already removed); this takes the
 * customer's contact off it, trims the crew, and withholds the service
 * reports. `leadOf` is the page's own lead helper.
 */
export function projectTradeJobDetailForCompanyView(
  detail: any,
  leadOf: (crew: any[]) => any | null,
): any {
  const crew = projectCompanyViewCrew(detail?.crew || []);
  const stripped = stripCustomerContactDeep({
    ...detail,
    crew: [],
    leadInstaller: null,
    serviceReport: null,
    serviceReports: [],
  });
  return { ...stripped, crew, leadInstaller: leadOf(crew) };
}

/**
 * One search_all_jobs row for a plain trade while the company view is on:
 * says whether the trade is on the job, and takes the customer's phone and
 * email off a job they are not on. Mutates and returns the row.
 */
export function presentCompanyViewFeedRow(job: any, assignedToMe: boolean): any {
  if (!job || typeof job !== "object") return job;
  job.assigned_to_me = assignedToMe === true;
  if (job.assigned_to_me) return job;
  for (const key of Object.keys(job)) {
    if (isCustomerContactKey(key)) delete job[key];
  }
  if (job.makesafe_details && typeof job.makesafe_details === "object") {
    job.makesafe_details = stripCustomerContactDeep(job.makesafe_details);
  }
  return job;
}

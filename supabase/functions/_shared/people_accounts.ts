// People accounts (director ruling, 19 Nov 2026): a cost document with ANY line
// on one of these Xero account codes is a person's pay. The ONE set lives in
// the database (public.people_account_codes, one row per code), so the
// owner's answer changes a row, never code. Every reader that used to hold
// 301 and 306 in code reads it here: xero-sync's cost lines, materials ingest,
// bill prematch, matcher and credit step, and ops-api's manual landing lane.
// The Reconcile list functions read the same table in SQL.
//
// Read once per entry point and pass the set down; never keep it in module
// scope (a warm isolate would serve a stale set to a later request). An
// unreadable or empty answer throws: a caller writes nothing on it and never
// reads it as "no people accounts".

export const PEOPLE_ACCOUNTS_TABLE = "people_account_codes";
/** More rows than this is not a small set of account codes: refused. */
export const PEOPLE_ACCOUNTS_MAX = 100;

export type PeopleAccounts = ReadonlySet<string>;

export type PeopleAccountsCode = "people_accounts_unreadable" | "people_accounts_empty";

export class PeopleAccountsUnavailable extends Error {
  constructor(public code: PeopleAccountsCode) {
    super(code);
    this.name = "PeopleAccountsUnavailable";
  }
}

// deno-lint-ignore no-explicit-any
export async function readPeopleAccounts(sb: any, opts: { timeoutMs?: number } = {}): Promise<PeopleAccounts> {
  let res: { data: unknown; error: unknown };
  try {
    let q = sb.from(PEOPLE_ACCOUNTS_TABLE).select("account_code").limit(PEOPLE_ACCOUNTS_MAX + 1);
    if (opts.timeoutMs) q = q.abortSignal(AbortSignal.timeout(opts.timeoutMs));
    res = await q;
  } catch {
    throw new PeopleAccountsUnavailable("people_accounts_unreadable");
  }
  if (res?.error || !Array.isArray(res?.data) || res.data.length > PEOPLE_ACCOUNTS_MAX) {
    throw new PeopleAccountsUnavailable("people_accounts_unreadable");
  }
  const set = new Set<string>();
  for (const row of res.data as Array<{ account_code?: unknown }>) {
    const code = typeof row?.account_code === "string" ? row.account_code.trim() : "";
    if (!code) throw new PeopleAccountsUnavailable("people_accounts_unreadable");
    set.add(code);
  }
  // An RLS-blocked or emptied table answers []: never "nobody is a person".
  if (!set.size) throw new PeopleAccountsUnavailable("people_accounts_empty");
  return set;
}

/** True when `code` (a Xero AccountCode, any spacing) is a people account. */
export function onPeopleAccount(people: PeopleAccounts, code: unknown): boolean {
  if (code == null) return false;
  const c = String(code).trim();
  return c !== "" && people.has(c);
}

export const peopleAccountsCode = (e: unknown): PeopleAccountsCode | null =>
  e instanceof PeopleAccountsUnavailable ? e.code : null;

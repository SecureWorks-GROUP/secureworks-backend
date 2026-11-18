// People accounts (director rulings, 19 Nov 2026 03:07 and 03:36). One table,
// public.people_account_codes, holds two SEPARATE facts about a Xero account
// code, so neither lives in code and the owner's answer changes a row:
//
//   labour                 a line on it is a person's labour. It decides a
//                          line's KIND and the labour stops (cost lines,
//                          materials ingest, bill prematch, the matcher's
//                          installer stop, ops-api's manual landing lane).
//                          301 and 306, exactly as the code held them before.
//   hidden_from_reconcile  a document with any line on it is never proposed
//                          and never listed. Read ONLY by the matcher's and the
//                          credit step's skip; the two Reconcile list functions
//                          read the same flag in SQL. 301, 306 and 475.
//
// The two sets are typed apart, so a kind decision cannot be handed the hidden
// set by mistake. A labour code is always hidden (the table's CHECK; checked
// again here). Read once per entry point and pass the sets down; never keep
// them in module scope (a warm isolate would serve a stale set to a later
// request). An unreadable answer, or no labour code at all, throws: a caller
// writes nothing on it and never reads it as "nobody is a person".

export const PEOPLE_ACCOUNTS_TABLE = "people_account_codes";
/** More rows than this is not a small set of account codes: refused. */
export const PEOPLE_ACCOUNTS_MAX = 100;

declare const labourBrand: unique symbol;
declare const hiddenBrand: unique symbol;
/** Codes whose lines are a person's labour: a line's kind and the labour stops. */
export type LabourAccounts = ReadonlySet<string> & { readonly [labourBrand]: true };
/** Codes whose documents are never proposed or listed on Reconcile. */
export type ReconcileHiddenAccounts = ReadonlySet<string> & { readonly [hiddenBrand]: true };
export type PeopleAccounts = { labour: LabourAccounts; hidden: ReconcileHiddenAccounts };

export const labourAccounts = (codes: Iterable<string>): LabourAccounts => new Set(codes) as unknown as LabourAccounts;
export const reconcileHiddenAccounts = (codes: Iterable<string>): ReconcileHiddenAccounts =>
  new Set(codes) as unknown as ReconcileHiddenAccounts;

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
    let q = sb.from(PEOPLE_ACCOUNTS_TABLE).select("account_code,labour,hidden_from_reconcile")
      .limit(PEOPLE_ACCOUNTS_MAX + 1);
    if (opts.timeoutMs) q = q.abortSignal(AbortSignal.timeout(opts.timeoutMs));
    res = await q;
  } catch {
    throw new PeopleAccountsUnavailable("people_accounts_unreadable");
  }
  if (res?.error || !Array.isArray(res?.data) || res.data.length > PEOPLE_ACCOUNTS_MAX) {
    throw new PeopleAccountsUnavailable("people_accounts_unreadable");
  }
  const labour: string[] = [];
  const hidden: string[] = [];
  for (const row of res.data as Array<Record<string, unknown>>) {
    const code = typeof row?.account_code === "string" ? row.account_code.trim() : "";
    const isLabour = row?.labour;
    const isHidden = row?.hidden_from_reconcile;
    if (!code || typeof isLabour !== "boolean" || typeof isHidden !== "boolean" || (isLabour && !isHidden)) {
      throw new PeopleAccountsUnavailable("people_accounts_unreadable");
    }
    if (isLabour) labour.push(code);
    if (isHidden) hidden.push(code);
  }
  // An RLS-blocked or emptied table answers []: never "nobody is a person".
  if (!labour.length) throw new PeopleAccountsUnavailable("people_accounts_empty");
  return { labour: labourAccounts(labour), hidden: reconcileHiddenAccounts(hidden) };
}

/**
 * A line's kind: true when `code` is a labour account. Exact match, as the code
 * held 301 and 306 before (no trimming: " 306" was never labour and is not now),
 * so no line's kind moves.
 */
export function onLabourAccount(labour: LabourAccounts, code: unknown): boolean {
  return labour.has(String(code ?? ""));
}

/** True when `code` (a Xero AccountCode, any spacing, as SQL's btrim) is hidden from Reconcile. */
export function onHiddenAccount(hidden: ReconcileHiddenAccounts, code: unknown): boolean {
  if (code == null) return false;
  const c = String(code).trim();
  return c !== "" && hidden.has(c);
}

/**
 * The matcher's and credit step's skip, read before any write: null when no
 * code is hidden; "labour" when a hidden code is also labour (the skip counted
 * as labour, as before); "hidden" for a hidden code that is not labour (475:
 * never proposed, but not a labour line either).
 */
export function hiddenSkip(accounts: PeopleAccounts, codes: unknown[]): "labour" | "hidden" | null {
  const hidden = codes.filter((c) => onHiddenAccount(accounts.hidden, c)).map((c) => String(c).trim());
  if (!hidden.length) return null;
  return hidden.some((c) => accounts.labour.has(c)) ? "labour" : "hidden";
}

export const peopleAccountsCode = (e: unknown): PeopleAccountsCode | null =>
  e instanceof PeopleAccountsUnavailable ? e.code : null;

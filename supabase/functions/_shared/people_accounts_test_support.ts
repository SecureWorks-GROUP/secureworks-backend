// Test support: people_account_codes as the migration seeds it.
import { labourAccounts, type PeopleAccounts, reconcileHiddenAccounts } from "./people_accounts.ts";

export const PEOPLE_ACCOUNT_ROWS = [
  { account_code: "301", labour: true, hidden_from_reconcile: true },
  { account_code: "306", labour: true, hidden_from_reconcile: true },
  { account_code: "475", labour: false, hidden_from_reconcile: true },
];
export const LABOUR = labourAccounts(["301", "306"]);
export const HIDDEN = reconcileHiddenAccounts(["301", "306", "475"]);
export const ACCOUNTS: PeopleAccounts = { labour: LABOUR, hidden: HIDDEN };
export const peopleRows = () => PEOPLE_ACCOUNT_ROWS.map((r) => ({ ...r }));

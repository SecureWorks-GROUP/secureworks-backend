// deno-lint-ignore-file no-explicit-any
// People accounts: two flags in one table. Fake client; made-up codes and no names.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  hiddenSkip,
  onHiddenAccount,
  onLabourAccount,
  PEOPLE_ACCOUNTS_MAX,
  PEOPLE_ACCOUNTS_TABLE,
  PeopleAccountsUnavailable,
  readPeopleAccounts,
} from "./people_accounts.ts";
import { PEOPLE_ACCOUNT_ROWS } from "./people_accounts_test_support.ts";

function fake(answer: () => any) {
  const calls: string[] = [];
  const q: any = {
    select: (cols: string) => (calls.push(`select:${cols}`), q),
    limit: (n: number) => (calls.push(`limit:${n}`), q),
    abortSignal: () => (calls.push("timed"), q),
    then: (ok: any, bad: any) => Promise.resolve().then(answer).then(ok, bad),
  };
  return { calls, client: { from: (t: string) => (calls.push(t), q) } };
}
const row = (account_code: string, labour: boolean, hidden_from_reconcile = true) => ({ account_code, labour, hidden_from_reconcile });

Deno.test("people accounts: one read gives two sets: labour 301 and 306, hidden 301, 306 and 475", async () => {
  const f = fake(() => ({ data: PEOPLE_ACCOUNT_ROWS, error: null }));
  const a = await readPeopleAccounts(f.client, { timeoutMs: 500 });
  assertEquals([[...a.labour].sort(), [...a.hidden].sort()], [["301", "306"], ["301", "306", "475"]]);
  assertEquals(f.calls, [PEOPLE_ACCOUNTS_TABLE, "select:account_code,labour,hidden_from_reconcile", `limit:${PEOPLE_ACCOUNTS_MAX + 1}`, "timed"]);
  // Labour is exact, as the code held it: a padded code was never labour.
  assert(onLabourAccount(a.labour, "306") && onLabourAccount(a.labour, 301));
  assert(!onLabourAccount(a.labour, "475") && !onLabourAccount(a.labour, " 306") && !onLabourAccount(a.labour, null));
  // Hidden is trimmed, as SQL's btrim.
  assert(onHiddenAccount(a.hidden, " 475 ") && onHiddenAccount(a.hidden, "306"));
  assert(!onHiddenAccount(a.hidden, "305") && !onHiddenAccount(a.hidden, null) && !onHiddenAccount(a.hidden, ""));
  // The skip: labour when a hidden code is labour, hidden when only 475, none otherwise.
  assertEquals([hiddenSkip(a, ["305", " 306"]), hiddenSkip(a, ["305", "475 "]), hiddenSkip(a, ["305", null])], ["labour", "hidden", null]);
});

Deno.test("people accounts: an error, a throw, a non-list, a bad row, labour not hidden or too many rows is unreadable; no labour is empty", async () => {
  const many = Array.from({ length: PEOPLE_ACCOUNTS_MAX + 1 }, (_, i) => row(`9${i}`, false));
  const cases: Array<[string, () => any]> = [
    ["people_accounts_unreadable", () => ({ data: null, error: { message: "x" } })],
    ["people_accounts_unreadable", () => Promise.reject(new Error("network"))],
    ["people_accounts_unreadable", () => ({ data: row("301", true), error: null })],
    ["people_accounts_unreadable", () => ({ data: [row("301", true), row(" ", false)], error: null })],
    ["people_accounts_unreadable", () => ({ data: [row("301", true), { account_code: "475", hidden_from_reconcile: true }], error: null })],
    ["people_accounts_unreadable", () => ({ data: [row("301", true), { account_code: "475", labour: false, hidden_from_reconcile: "yes" }], error: null })],
    ["people_accounts_unreadable", () => ({ data: [row("301", true, false)], error: null })],
    ["people_accounts_unreadable", () => ({ data: many, error: null })],
    ["people_accounts_empty", () => ({ data: [], error: null })],
    ["people_accounts_empty", () => ({ data: [row("475", false)], error: null })],
  ];
  for (const [code, answer] of cases) {
    const err = await assertRejects(() => readPeopleAccounts(fake(answer).client), PeopleAccountsUnavailable) as PeopleAccountsUnavailable;
    assertEquals([err.code, err.message], [code, code]);
  }
});

Deno.test("people accounts: no copy in code; kind decisions read only the labour flag, and only the matcher and credit step read the hidden flag", () => {
  const root = new URL("../", import.meta.url);
  const sources: Array<[string, string]> = [];
  const walk = (dir: URL, rel: string) => {
    for (const e of Deno.readDirSync(dir)) {
      if (e.isDirectory) walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`);
      else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts") && !e.name.includes("test_support")) {
        sources.push([`${rel}${e.name}`, Deno.readTextFileSync(new URL(e.name, dir))]);
      }
    }
  };
  walk(root, "");
  const src = (name: string) => sources.find(([n]) => n === name)?.[1] ?? "";
  // A literal set or list holding 301, 306 or 475 as an account, or an equality test on one.
  const copy = /(?:Set|\[)\s*\(?\s*\[?[^\]\n]*["'](?:301|306|475)["'][^\]\n]*["'](?:301|306|475)["']|account_?[cC]ode\s*===?\s*["'](?:301|306|475)["']|AccountCode\s*===?\s*["'](?:301|306|475)["']/;
  assertEquals(sources.filter(([, s]) => copy.test(s)).map(([n]) => n), []);
  const kindDeciders = ["xero-sync/materials_ingest.ts", "xero-sync/bill_prematch.ts", "xero-sync/cost_lines.ts",
    "xero-sync/match/doc_clues.ts", "ops-api/materials_recon.ts"];
  for (const name of kindDeciders) {
    assert(src(name).includes("onLabourAccount"), `${name} reads the labour flag`);
    assert(!/onHiddenAccount|hiddenSkip|ReconcileHiddenAccounts|accounts\.hidden\b/.test(src(name)), `${name} never reads the hidden flag`);
  }
  const readers = sources.filter(([, s]) => /onHiddenAccount|hiddenSkip|ReconcileHiddenAccounts|accounts\.hidden\b/.test(s)).map(([n]) => n).sort();
  assertEquals(readers, ["_shared/people_accounts.ts", "xero-sync/match/credit_run.ts", "xero-sync/match/match_run.ts"]);
});

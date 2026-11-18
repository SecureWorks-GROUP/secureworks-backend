// deno-lint-ignore-file no-explicit-any
// The one set of people accounts. Fake client; made-up codes and no names.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  onPeopleAccount,
  PEOPLE_ACCOUNTS_MAX,
  PEOPLE_ACCOUNTS_TABLE,
  PeopleAccountsUnavailable,
  readPeopleAccounts,
} from "./people_accounts.ts";

function fake(answer: () => any) {
  const calls: string[] = [];
  const q: any = {
    select: () => q,
    limit: (n: number) => (calls.push(`limit:${n}`), q),
    abortSignal: () => (calls.push("timed"), q),
    then: (ok: any, bad: any) => Promise.resolve().then(answer).then(ok, bad),
  };
  return { calls, client: { from: (t: string) => (calls.push(t), q) } };
}

Deno.test("people accounts: read once from the one table, trimmed, as a set", async () => {
  const f = fake(() => ({ data: [{ account_code: "301" }, { account_code: " 306 " }, { account_code: "475" }], error: null }));
  const set = await readPeopleAccounts(f.client, { timeoutMs: 500 });
  assertEquals([...set].sort(), ["301", "306", "475"]);
  assertEquals(f.calls, [PEOPLE_ACCOUNTS_TABLE, `limit:${PEOPLE_ACCOUNTS_MAX + 1}`, "timed"]);
  assert(onPeopleAccount(set, " 475") && onPeopleAccount(set, 306));
  assert(!onPeopleAccount(set, "305") && !onPeopleAccount(set, null) && !onPeopleAccount(set, ""));
});

Deno.test("people accounts: an error, a throw, a non-list, a blank code or too many rows is unreadable; none is empty; never 'nobody is a person'", async () => {
  const many = Array.from({ length: PEOPLE_ACCOUNTS_MAX + 1 }, (_, i) => ({ account_code: `9${i}` }));
  const cases: Array<[string, () => any]> = [
    ["people_accounts_unreadable", () => ({ data: null, error: { message: "x" } })],
    ["people_accounts_unreadable", () => Promise.reject(new Error("network"))],
    ["people_accounts_unreadable", () => ({ data: { account_code: "301" }, error: null })],
    ["people_accounts_unreadable", () => ({ data: [{ account_code: "301" }, { account_code: " " }], error: null })],
    ["people_accounts_unreadable", () => ({ data: many, error: null })],
    ["people_accounts_empty", () => ({ data: [], error: null })],
  ];
  for (const [code, answer] of cases) {
    const err = await assertRejects(() => readPeopleAccounts(fake(answer).client), PeopleAccountsUnavailable) as PeopleAccountsUnavailable;
    assertEquals([err.code, err.message], [code, code]);
  }
});

Deno.test("people accounts: no copy of the set is held in code; every reader takes the one database set", () => {
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
  // A literal set or list holding 301 or 306 as an account, or an equality test on one.
  const copy = /(?:Set|\[)\s*\(?\s*\[?[^\]\n]*["'](?:301|306|475)["'][^\]\n]*["'](?:301|306|475)["']|account_?[cC]ode\s*===?\s*["'](?:301|306|475)["']|AccountCode\s*===?\s*["'](?:301|306|475)["']/;
  const found = sources.filter(([, src]) => copy.test(src)).map(([name]) => name);
  assertEquals(found, []);
  // The booking account a trade invoice is written to is a different fact and stays.
  for (const name of ["xero-sync/materials_ingest.ts", "xero-sync/bill_prematch.ts", "xero-sync/cost_lines.ts",
    "xero-sync/match/match_run.ts", "xero-sync/match/credit_run.ts", "xero-sync/match/doc_clues.ts",
    "ops-api/materials_recon.ts", "ops-api/reconcile_list.ts"]) {
    const src = sources.find(([n]) => n === name)?.[1] ?? "";
    assert(src.includes("_shared/people_accounts.ts"), `${name} reads the one set`);
  }
});

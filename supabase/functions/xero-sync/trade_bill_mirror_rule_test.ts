// deno-lint-ignore-file no-explicit-any
// The one trade-invoice mirror rule for supplier bills. Fake client; made-up ids.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MIRROR_RULE_MAX_IDS, MirrorRuleUnavailable, readBillMirrorVerdicts } from "./trade_bill_mirror_rule.ts";

const ORG = "10000000-0000-4000-8000-000000000001";

function fake(answer: (args: any) => { data: unknown; error: unknown } | Promise<never>) {
  const calls: Array<{ fn: string; args: any }> = [];
  return {
    calls,
    client: {
      rpc(fn: string, args: any) {
        calls.push({ fn, args });
        return Promise.resolve().then(() => answer(args));
      },
      from() {
        throw new Error("the rule never reads a table itself");
      },
    },
  };
}

Deno.test("mirror rule: one call, ids echoed as given, mirror and stop split, none left out", async () => {
  const f = fake((args) => ({
    data: args.p_bill_ids.map((id: string) => ({
      bill_id: id,
      verdict: id === "Bill-A " ? "mirror" : id === "bill-b" ? "stop" : "none",
    })),
    error: null,
  }));
  const out = await readBillMirrorVerdicts(f.client, ORG, ["Bill-A ", "bill-b", "bill-c", "bill-c"]);
  assertEquals(f.calls, [{
    fn: "trade_invoice_bill_mirror_verdicts",
    args: { p_org_id: ORG, p_bill_ids: ["Bill-A ", "bill-b", "bill-c"] },
  }]);
  // Exact ids, so the caller's exact Set.has keeps working.
  assertEquals([...out.mirrors], ["Bill-A "]);
  assertEquals([...out.stopped], ["bill-b"]);
});

Deno.test("mirror rule: no ids makes no call", async () => {
  const f = fake(() => {
    throw new Error("called");
  });
  const out = await readBillMirrorVerdicts(f.client, ORG, []);
  assertEquals([f.calls.length, out.mirrors.size, out.stopped.size], [0, 0, 0]);
});

Deno.test("mirror rule: an error, a throw, a missing, unknown or extra-shaped answer refuses; never 'not a mirror'", async () => {
  const cases: Array<[string, (args: any) => any]> = [
    ["mirror_rule_unreadable", () => ({ data: null, error: { message: "x" } })],
    ["mirror_rule_unreadable", () => Promise.reject(new Error("network"))],
    ["mirror_rule_unreadable", () => ({ data: { verdict: "none" }, error: null })],
    ["mirror_rule_answer_incomplete", (a) => ({ data: [{ bill_id: a.p_bill_ids[0], verdict: "none" }], error: null })],
    ["mirror_rule_answer_invalid", (a) => ({ data: a.p_bill_ids.map((id: string) => ({ bill_id: id, verdict: "maybe" })), error: null })],
    ["mirror_rule_answer_invalid", (a) => ({ data: a.p_bill_ids.map(() => ({ bill_id: null, verdict: "none" })), error: null })],
    // The database trimmed or lower-cased the id it echoed: not the id we asked about.
    ["mirror_rule_answer_incomplete", (a) => ({ data: a.p_bill_ids.map((id: string) => ({ bill_id: id.toLowerCase(), verdict: "none" })), error: null })],
  ];
  for (const [code, answer] of cases) {
    const err = await assertRejects(
      () => readBillMirrorVerdicts(fake(answer).client, ORG, ["Bill-1", "bill-2"]),
      MirrorRuleUnavailable,
    ) as MirrorRuleUnavailable;
    assertEquals(err.code, code);
    assertEquals(err.message, code, "the message is a code, never a bill id");
  }
});

Deno.test("mirror rule: more ids than one page refuses before any call", async () => {
  const f = fake(() => ({ data: [], error: null }));
  const ids = Array.from({ length: MIRROR_RULE_MAX_IDS + 1 }, (_, i) => `b${i}`);
  const err = await assertRejects(() => readBillMirrorVerdicts(f.client, ORG, ids), MirrorRuleUnavailable) as MirrorRuleUnavailable;
  assertEquals([err.code, f.calls.length], ["mirror_rule_too_many_ids", 0]);
});

Deno.test("mirror rule: the sync, the edge backfill and the twin all read the one rule, and nothing else compares bill ids to trade invoices for cost lines", () => {
  const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));
  const sync = read("./index.ts");
  const backfill = read("./cost_lines_backfill.ts");
  for (const [name, src] of [["index.ts", sync], ["cost_lines_backfill.ts", backfill]]) {
    assert(src.includes("readBillMirrorVerdicts("), `${name} reads the rule`);
  }
  assert(!/costMirrorBillIds/.test(sync), "the sync's own mirror set is gone");
  assert(!/from\(["']trade_invoices["']\)/.test(backfill), "the backfill reads no trade invoices itself");
  const dir = new URL("../../migrations/", import.meta.url);
  const twin = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith("_trade_invoice_bill_mirror_rule.sql"));
  assertEquals(twin.length, 1);
  const sql = Deno.readTextFileSync(new URL(twin[0], dir));
  const body = sql.slice(sql.indexOf("FUNCTION public.job_cost_lines_backfill_bills("));
  assert(body.includes("public.trade_invoice_bill_mirror_verdicts(p_org_id"), "the twin reads the rule");
  assert(!/t\.xero_bill_id = x\.xero_invoice_id/.test(body), "the twin's own exact match is gone");
});

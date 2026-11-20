// search_all_jobs text search: a comma, bracket, quote or backslash in what
// the trade typed must not break the PostgREST or() filter (it returned 500).
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  tradeJobSearchOrFilter,
  tradeJobSearchOrTerm,
} from "./trade_job_search_filter.ts";

// Split an or() list the way PostgREST does: commas outside brackets and
// double quotes end a condition.
function conditions(filter: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const ch of filter) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && ch === ",") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

Deno.test("plain text is searched as typed across the four columns", () => {
  assertEquals(
    tradeJobSearchOrFilter("swf-1234"),
    "job_number.ilike.%swf-1234%,client_name.ilike.%swf-1234%,site_suburb.ilike.%swf-1234%,site_address.ilike.%swf-1234%",
  );
});

for (
  const typed of [
    "12 smith st, perth",
    "smith (front)",
    "unit 4) back",
    'the "big" gate',
    "a\\b",
    "(,)",
  ]
) {
  Deno.test(`reserved characters stay inside one condition: ${typed}`, () => {
    const filter = tradeJobSearchOrFilter(typed);
    const parts = conditions(filter);
    assertEquals(parts.length, 4, filter);
    for (const part of parts) {
      assert(/^[a-z_]+\.ilike\.%[^,()"\\]*%$/.test(part), part);
    }
  });
}

Deno.test("each reserved character becomes the one-character wildcard, so the address still matches", () => {
  assertEquals(tradeJobSearchOrTerm("12 smith st, perth"), "12 smith st_ perth");
  assertEquals(tradeJobSearchOrTerm('a(b)"c\\d'), "a_b__c_d");
  // ilike's `_` matches any one character, including the comma itself.
  const pattern = new RegExp(
    "^" + tradeJobSearchOrTerm("12 smith st, perth").replace(/_/g, ".") + "$",
  );
  assert(pattern.test("12 smith st, perth"));
});

Deno.test("search_all_jobs builds its or() filter through the helper", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(index.includes("jobQuery = jobQuery.or(tradeJobSearchOrFilter(q))"));
  assert(
    !index.includes(
      "`job_number.ilike.%${q}%,client_name.ilike.%${q}%,site_suburb.ilike.%${q}%,site_address.ilike.%${q}%`",
    ),
  );
});

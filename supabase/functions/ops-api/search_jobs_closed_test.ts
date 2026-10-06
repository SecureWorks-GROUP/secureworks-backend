// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// Ask the story (6 Oct 2026): search_jobs include_closed. Jarvis's
// sw_job_story finds a job by the words said (a surname, an address) and
// checks every match against them. The dashboard's search reads only open
// jobs, the newest 20 substring matches, so a question about a lost quote never
// found it and a short surname ("Ng" is inside a thousand names and emails)
// pushed the job asked about out of the list. Pins:
//   Closed     with include_closed=true, lost, cancelled and draft jobs come
//              too, after the open ones, marked by their status; old-system
//              (legacy) rows come last, marked legacy (include_legacy); test
//              records stay out, as before.
//   Phone      a phone is found by its digits however it is stored (with or
//              without spaces, +61 or 0, brackets), on the job and on its
//              contacts.
//   Words      whole-word matches of the client's or a contact's name, the
//              suburb, the job number and invoice references are read on
//              their own, so a short surname is never crowded out; regex
//              characters in the words are matched as written.
//   Capped     the answer says when a read hit its limit (capped) and when a
//              whole-word read did (words_capped), so a cut list is never read
//              as complete.
//   Unchanged  without include_closed the answer is exactly as before.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _searchJobsForTest } from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
type Tables = Record<string, any[]>;

/** A PostgREST filter value as the server reads it: quotes and backslash escapes removed. */
function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, "$1") : value;
}
/** `col.op.value` items of an or() string, split at commas outside quotes and parentheses. */
function orItems(expr: string): Array<{ col: string; op: string; value: string }> {
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quoted && ch === "\\") {
      current += ch + expr[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && ch === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) items.push(current);
  return items.map((item) => {
    const [col, op, ...rest] = item.split(".");
    return { col, op, value: unquote(rest.join(".")) };
  });
}
const like = (value: unknown, pattern: string) => {
  if (value === null || value === undefined) return false;
  const re = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${re}$`, "is").test(String(value));
};
/** PostgreSQL ~* as JavaScript: the POSIX classes the search uses, case-insensitive. */
const imatch = (value: unknown, pattern: string) => {
  if (value === null || value === undefined) return false;
  const js = pattern.replaceAll("[^[:alnum:]]", "[^A-Za-z0-9]").replaceAll("[[:space:]]", "\\s");
  return new RegExp(js, "i").test(String(value));
};
function holds(row: any, col: string, op: string, value: any): boolean {
  if (op === "is") return value === "null" ? (row[col] ?? null) === null : String(row[col]) === value;
  if (op === "eq") return String(row[col]) === String(value);
  if (op === "ilike") return like(row[col], String(value));
  if (op === "imatch") return imatch(row[col], String(value));
  if (op === "in") return (Array.isArray(value) ? value : String(value).replace(/^\(|\)$/g, "").split(",").map(unquote)).includes(String(row[col]));
  throw new Error(`fake: operator ${op} not handled`);
}

/** Read-only fake of the PostgREST client for the search's reads; any write throws. quote_revisions answers as live does (no quote_number column). */
function fakeClient(tables: Tables, reads: string[] = []) {
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const orders: Array<{ col: string; asc: boolean }> = [];
      let limit: number | null = null;
      const q: any = {};
      for (const m of ["insert", "update", "upsert", "delete"]) q[m] = () => { throw new Error(`write attempted: ${m} ${table}`); };
      q.select = () => q;
      q.eq = (c: string, v: any) => (filters.push((r) => r[c] === v), q);
      q.in = (c: string, vs: any[]) => (filters.push((r) => vs.includes(r[c])), q);
      q.not = (c: string, op: string, v: any) => (filters.push((r) => !holds(r, c, op, v)), q);
      q.ilike = (c: string, v: string) => (filters.push((r) => like(r[c], v)), q);
      q.filter = (c: string, op: string, v: any) => (filters.push((r) => holds(r, c, op, v)), q);
      q.or = (expr: string) => {
        const items = orItems(expr);
        filters.push((r) => items.some((it) => holds(r, it.col, it.op, it.value)));
        return q;
      };
      q.order = (col: string, o?: { ascending?: boolean }) => (orders.push({ col, asc: o?.ascending !== false }), q);
      q.limit = (n: number) => ((limit = n), q);
      q.then = (resolve: any, reject: any) => {
        reads.push(table);
        if (table === "quote_revisions") {
          return Promise.resolve({ data: null, error: { message: "column quote_revisions.quote_number does not exist" } }).then(resolve, reject);
        }
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        rows = [...rows].sort((a, b) => {
          for (const o of orders) {
            const av = a[o.col] ?? "";
            const bv = b[o.col] ?? "";
            if (av < bv) return o.asc ? -1 : 1;
            if (av > bv) return o.asc ? 1 : -1;
          }
          return 0;
        });
        if (limit !== null) rows = rows.slice(0, limit);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      };
      return q;
    },
  };
}

const id = (n: number) => `5a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function job(n: number, over: Record<string, unknown>) {
  return {
    id: id(n), org_id: ORG, legacy: false, job_number: `SWF-${99000 + n}`, client_name: `Client ${n}`, client_email: null, client_phone: null,
    site_address: `${n} Long Rd, Otherton WA 6000`, site_suburb: "Otherton", type: "fencing", status: "quoted",
    updated_at: `2026-09-${String(1 + (n % 28)).padStart(2, "0")}T02:00:00.000Z`, ...over,
  };
}

function tables(): Tables {
  // 25 open jobs updated after the one asked about, each holding "ng" inside a longer word.
  const crowd = Array.from({ length: 25 }, (_, i) => job(100 + i, {
    client_name: `Jo Youngman ${i}`, site_suburb: "Kingsway", updated_at: `2026-10-0${1 + (i % 5)}T0${i % 9}:00:00.000Z`,
  }));
  return {
    jobs: [
      job(1, { client_name: "Pat Sample", status: "quoted", updated_at: "2026-10-01T02:00:00.000Z" }),
      job(2, { client_name: "Lee Sample", status: "lost", updated_at: "2026-09-01T02:00:00.000Z" }),
      job(3, { client_name: "Jo Sample", status: "draft", job_number: null, updated_at: "2026-09-02T02:00:00.000Z" }),
      job(4, { client_name: "Kim Example", status: "cancelled", updated_at: "2026-09-03T02:00:00.000Z" }),
      job(5, { client_name: "Sample Legacy", status: "cancelled", legacy: true }),
      job(6, { client_name: "Lee Other", status: "scheduled" }),
      job(7, { client_name: "Al Ng", status: "quoted", updated_at: "2026-08-01T02:00:00.000Z" }),
      job(8, { client_name: "Test Sample", status: "quoted" }),
      job(9, { client_name: "Sampleton Holdings", status: "quoted" }),
      ...crowd,
    ],
    job_contacts: [{ job_id: id(6), status: "active", client_name: "Kim Sample", contact_label: "neighbour", client_email: null, client_phone: null }],
    xero_invoices: [{ job_id: id(4), reference: "Example fence balance", invoice_number: "INV-9001", status: "AUTHORISED", invoice_type: "ACCREC" }],
    makesafe_job_details: [],
    quote_revisions: [],
  };
}
const search = (params: Record<string, string>, reads?: string[]) =>
  _searchJobsForTest(fakeClient(tables(), reads), new URLSearchParams(params)) as Promise<any>;
const ids = (answer: any) => answer.results.map((r: any) => r.id);

Deno.test("include_closed: lost, cancelled and draft jobs come after the open ones, marked by status; old-system rows last, marked legacy; test records stay out", async () => {
  const answer = await search({ q: "Sample", include_closed: "true" });
  assertEquals(answer.include_closed, true);
  assertEquals(answer.include_legacy, true);
  assertEquals(answer.capped, false);
  assertEquals(answer.words_capped, false);
  const got = ids(answer);
  // Open first (the client, then the contact's job), then the closed and draft ones, then the old-system row.
  assertEquals(got.slice(0, 3).sort(), [id(1), id(6), id(9)].sort());
  assertEquals(got.slice(3, 5).sort(), [id(2), id(3)].sort());
  assertEquals(got[5], id(5), "an old-system (legacy) row comes last");
  assertEquals(got.length, 6);
  assertEquals(answer.results[5].legacy, true);
  assert(answer.results.slice(0, 5).every((r: any) => r.legacy === false), "every other row says it is not legacy");
  assert(!got.includes(id(8)), "a test record is never a match");
  const contact = answer.results.find((r: any) => r.id === id(6));
  assertEquals(contact.match_source, "Contact: Kim Sample (neighbour)");
  assertEquals(answer.results.find((r: any) => r.id === id(2)).status, "lost");
  // A closed job matched by an invoice reference comes too.
  const byInvoice = await search({ q: "Example fence", include_closed: "true" });
  assertEquals(ids(byInvoice), [id(4)]);
  assertEquals(byInvoice.results[0].match_source, "Invoice: INV-9001");
});

Deno.test("include_closed: a short surname is found by its whole word, however many longer words hold it", async () => {
  const answer = await search({ q: "Ng", include_closed: "true" });
  assert(ids(answer).includes(id(7)), "Al Ng is found although 25 newer jobs hold 'ng' inside a longer word");
  assertEquals(answer.results[0].id, id(7), "whole-word matches come first");
  assertEquals(answer.capped, true, "the substring read hit its limit, and says so");
  assertEquals(answer.words_capped, false, "the whole-word read did not");
  // Regex characters in the words are matched as written, never as a pattern.
  assertEquals(ids(await search({ q: ".*", include_closed: "true" })), []);
  assertEquals(ids(await search({ q: "Sample|Ng", include_closed: "true" })), []);
});

Deno.test("without include_closed the search is exactly as before: open jobs only, the newest substring matches, results alone", async () => {
  const reads: string[] = [];
  const answer = await search({ q: "Sample" }, reads);
  assertEquals(Object.keys(answer), ["results"]);
  assertEquals(ids(answer).sort(), [id(1), id(6), id(9)].sort());
  assertEquals(reads.slice(0, 5).sort(), ["jobs", "job_contacts", "makesafe_job_details", "quote_revisions", "xero_invoices"].sort());
  const short = await search({ q: "Ng" });
  assertEquals(short.results.length, 15);
  assert(!ids(short).includes(id(7)), "as before, the dashboard's list stops at the newest 15");
  assertEquals(await search({ q: "S" }), { results: [] });
  assertEquals(await search({ q: "S", include_closed: "true" }), { results: [], include_closed: true, include_legacy: true, capped: false, words_capped: false });
});

Deno.test("include_closed: a phone is found by its digits however it is stored, on the job and its contacts, old-system rows last", async () => {
  const phones: Tables = {
    jobs: [
      job(20, { client_name: "Jo Rectify", client_phone: "+61412345678", status: "rectification" }),
      job(21, { client_name: "Jo Draft", client_phone: "0412 345 678", status: "draft" }),
      job(22, { client_name: "Jo Spaced", client_phone: "+61 412 345 678", status: "quoted" }),
      job(23, { client_name: "Jo Grouped", client_phone: "04 1234 5678", status: "accepted" }),
      job(24, { client_name: "Jo Landline", client_phone: "(08) 9123 4567", status: "quoted" }),
      job(25, { client_name: "Jo Legacy", client_phone: "0412345678", status: "cancelled", legacy: true }),
      job(26, { client_name: "Jo Other", client_phone: "0498 765 432", status: "quoted" }),
      job(27, { client_name: "Jo Neighbour", client_phone: null, status: "quoted" }),
    ],
    job_contacts: [{ job_id: id(27), status: "active", client_name: "Kim Next", contact_label: "neighbour", client_email: null, client_phone: "+61 412 345 678" }],
    xero_invoices: [],
    makesafe_job_details: [],
  };
  const find = async (q: string) => await _searchJobsForTest(fakeClient(phones), new URLSearchParams({ q, include_closed: "true" })) as any;
  for (const q of ["0412345678", "0412 345 678", "+61 412 345 678", "+61412345678", "61412345678"]) {
    const answer = await find(q);
    const got = ids(answer);
    assertEquals(got.slice(0, 4).sort(), [id(22), id(23), id(27)].concat(id(20)).sort(), q);
    assertEquals(got.slice(4, 5), [id(21)], `${q}: the draft after the open ones`);
    assertEquals(got.slice(5), [id(25)], `${q}: the old-system row last`);
    assertEquals(answer.results.find((r: any) => r.id === id(27)).match_source, "Contact: Kim Next (neighbour)", q);
    assertEquals(answer.capped, false, q);
  }
  for (const q of ["08 9123 4567", "0891234567", "+61 8 9123 4567", "9123 4567"]) assertEquals(ids(await find(q)), [id(24)], q);
  // Words that are not a phone are not read as one.
  assertEquals(ids(await find("12 Long Rd")), []);
});

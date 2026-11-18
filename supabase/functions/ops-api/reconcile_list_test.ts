import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  billStateOf,
  READ_CAP,
  RECONCILE_REASON_WORDS,
  decodeCursor,
  encodeCursor,
  RECONCILE_LIST_FLAG,
  reconcileList,
  ReconcileListError,
} from "./reconcile_list.ts";

// Made-up ids, amounts and document numbers only.
const ORG = "00000000-0000-4000-8000-000000000001";
const STAFF = { authMode: "jwt", userId: "00000000-0000-4000-8000-0000000000a1", isStaff: true, orgId: ORG };
const NOW = new Date("2026-11-19T00:00:00Z");

type Filter = [string, string, unknown];
type Handler = (table: string, filters: Filter[]) => { data: unknown; error: unknown };

function fakeClient(handler: Handler, rpcs: Record<string, (args: any) => { data: unknown; error: unknown }> = {}) {
  const calls: string[] = [];
  const rpcArgs: Record<string, unknown> = {};
  const client = {
    calls,
    rpcArgs,
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.push(`rpc:${fn}`);
      rpcArgs[fn] = args;
      return Promise.resolve(rpcs[fn] ? rpcs[fn](args) : { data: null, error: { message: "missing" } });
    },
    from(table: string) {
      calls.push(table);
      const filters: Filter[] = [];
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), b),
        in: (c: string, v: unknown) => (filters.push(["in", c, v]), b),
        limit: (n: number) => (filters.push(["limit", "limit", n]), b),
        then: (ok: any, bad: any) => Promise.resolve(handler(table, filters)).then(ok, bad),
      };
      return b;
    },
  };
  return client;
}

const flagOn = { data: [{ enabled: true }], error: null };
const KINDS = [
  { kind: "bill", tab: "bills", words: "Bill", card: "cost" },
  { kind: "credit", tab: "bills", words: "Credit", card: "cost" },
  { kind: "receipt", tab: "receipts", words: "Receipt", card: "cost" },
  { kind: "card_line", tab: "card_bank", words: "Card line", card: "cost" },
];
const val = (filters: Filter[], col: string) => filters.find((f) => f[1] === col)?.[2];

function item(id: string, kind: string, subject: string, amount: number | null, extra: Record<string, unknown> = {}) {
  return {
    id, kind, subject_table: "cost_document", subject_id: subject, job_ids: [], reason: "no_clue",
    amount_ex: amount, document_date: "2026-11-10", summary: {}, suggestion: null, evidence: {},
    evidence_hash: `h-${id}`, raised_at: "2026-11-16T00:00:00Z", snooze_until: null, snoozed: false, ...extra,
  };
}

function line(id: string, docKind: string, docId: string, amount: number | null, extra: Record<string, unknown> = {}) {
  return {
    id, document_kind: docKind, document_id: docId, line_key: id, line_no: 1, kind: "supplier_bill",
    description: "ZZTEST line", account_code: "300", amount_ex: amount, state: "needs_person",
    not_counted_reason: null, document_number: `ZZ-${docId}`, document_date: "2026-11-10",
    party_name: "ZZTEST Supplier", follows_line_id: null, follows_document_kind: null, follows_document_id: null,
    ...extra,
  };
}

Deno.test("reconcile list: a server key, the routine and a trade are refused before any read", async () => {
  for (const caller of [
    { authMode: "api_key", userId: null, isStaff: false, orgId: ORG },
    { authMode: "routine", userId: null, isStaff: false, orgId: ORG },
    { authMode: "jwt", userId: "00000000-0000-4000-8000-0000000000b1", isStaff: false, orgId: ORG },
  ]) {
    const c = fakeClient(() => flagOn);
    const err = await assertRejects(() => reconcileList(c, new URLSearchParams("tab=bills"), caller), ReconcileListError);
    assertEquals([err.code, err.status], ["operator_access_required", 403]);
    assertEquals(c.calls, [], "nothing read");
  }
});

Deno.test("reconcile list: a bad query is refused 400 before the switch is read", async () => {
  for (const q of ["tab=pay", "tab=messages", "limit=101", "limit=0", "limit=x", "after=notacursor", "job_number=SWF-1", "extra=1"]) {
    const c = fakeClient(() => flagOn);
    const err = await assertRejects(() => reconcileList(c, new URLSearchParams(q), STAFF), ReconcileListError);
    assertEquals([err.code, err.status], ["invalid_request", 400], q);
    assertEquals(c.calls, [], q);
  }
});

Deno.test("reconcile list: switch off answers enabled false after reading only the switch", async () => {
  for (const flag of [{ data: [], error: null }, { data: [{ enabled: false }], error: null }]) {
    const c = fakeClient((t, f) => {
      assertEquals([t, val(f, "flag_name")], ["feature_flags", RECONCILE_LIST_FLAG]);
      return flag;
    });
    const out = await reconcileList(c, new URLSearchParams("tab=bills"), STAFF, NOW);
    assertEquals(out, { ok: true, enabled: false });
    assertEquals(c.calls, ["feature_flags"]);
  }
});

Deno.test("reconcile list: an unreadable switch or any failed read refuses 503, never a short list", async () => {
  const bad = fakeClient(() => ({ data: null, error: { message: "down" } }));
  const e1 = await assertRejects(() => reconcileList(bad, new URLSearchParams("tab=bills"), STAFF), ReconcileListError);
  assertEquals([e1.code, e1.status], ["reconcile_list_unreadable", 503]);
  // Lines read fails after the page read.
  const c = fakeClient((t) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
    return { data: null, error: { message: "timeout" } };
  }, {
    reconcile_list_page: () => ({ data: [item("i1", "bill", "xero_bill:B1", 100)], error: null }),
    reconcile_list_counts: () => ({ data: [{ kind: "bill", open: 1 }], error: null }),
  });
  const e2 = await assertRejects(() => reconcileList(c, new URLSearchParams("tab=bills"), STAFF), ReconcileListError);
  assertEquals(e2.code, "reconcile_list_unreadable");
});

Deno.test("reconcile list: a page of bills carries lines, a cursor, counts per tab and the suggested job", async () => {
  const JOB = "00000000-0000-4000-8000-000000000f01";
  const c = fakeClient((t, f) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
    if (t === "job_cost_lines") {
      assertEquals(val(f, "org_id"), ORG);
      return { data: [line("L1", "xero_bill", "B1", 600), line("L2", "xero_bill", "B1", 400),
        line("L3", "xero_bill", "B1", 0, { state: null, not_counted_reason: "line_removed" })], error: null };
    }
    if (t === "jobs") return { data: [{ id: JOB, job_number: "SWF-990001", site_address: "1 Test St", site_suburb: "Testville" }], error: null };
    if (t === "match_clues") return { data: [], error: null };
    throw new Error(`unexpected read ${t}`);
  }, {
    reconcile_list_page: (a) => {
      assertEquals([a.p_org, a.p_kinds, a.p_limit, a.p_after], [ORG, ["bill", "credit"], 1, null]);
      return { data: [item("c0000000-0000-4000-8000-000000000001", "bill", "xero_bill:B1", 1000,
        { suggestion: { outcome: "job", job_id: JOB, division: null, clue_ids: [1] } }),
        item("c0000000-0000-4000-8000-000000000002", "bill", "xero_bill:B2", 50)], error: null };
    },
    reconcile_list_counts: () => ({ data: [{ kind: "bill", open: 3 }, { kind: "credit", open: 2 }, { kind: "receipt", open: 4 },
      { kind: "pay_line_held", open: 9 }], error: null }),
  });
  const out: any = await reconcileList(c, new URLSearchParams("tab=bills&limit=1"), STAFF, NOW);
  assertEquals(out.enabled, true);
  assertEquals(out.counts, { bills: 5, card_bank: 0, receipts: 4 }, "pay kinds never counted");
  assertEquals(out.items.length, 1, "the extra row only says another page exists");
  const it = out.items[0];
  assertEquals([it.card, it.kind_words, it.reason_words, it.shown_hash, it.waiting_days, it.document_number, it.amount_ex],
    ["cost", "Bill", "No suggestion", "h-c0000000-0000-4000-8000-000000000001", 3, "ZZ-B1", 1000]);
  assertEquals(it.suggestion, { outcome: "job", job_id: JOB, job_number: "SWF-990001", job_site: "1 Test St, Testville", division: null });
  assertEquals(it.lines.map((l: any) => [l.line_id, l.amount_ex, l.state]), [["L1", 600, "needs_person"], ["L2", 400, "needs_person"]]);
  assertEquals("evidence" in it || "summary" in it, false, "never evidence or summary whole");
  assertEquals("bill" in it, false, "a bill carries no bill field");
  assertEquals(decodeCursor(out.next), { snoozed: false, amount_ex: 1000, raised_at: "2026-11-16T00:00:00Z", id: "c0000000-0000-4000-8000-000000000001" });
});

Deno.test("reconcile list: each credit carries its bill id and that bill's state", async () => {
  const JOB = "00000000-0000-4000-8000-000000000011";
  const page = [
    item("c0000000-0000-4000-8000-0000000000c1", "credit", "xero_credit_note:N1", -10), // bill not loaded
    item("c0000000-0000-4000-8000-0000000000c2", "credit", "xero_credit_note:N2", -20), // bill waiting
    item("c0000000-0000-4000-8000-0000000000c3", "credit", "xero_credit_note:N3", -30), // bill placed (via parent line)
    item("c0000000-0000-4000-8000-0000000000c4", "credit", "xero_credit_note:N4", -40), // not against a bill
    item("c0000000-0000-4000-8000-0000000000c5", "credit", "xero_credit_note:N5", -50), // two bills
  ];
  const credLines = [
    line("C1", "xero_credit_note", "N1", -10, { follows_document_kind: "xero_bill", follows_document_id: "BX" }),
    line("C2", "xero_credit_note", "N2", -20, { follows_document_kind: "xero_bill", follows_document_id: "BW" }),
    line("C3", "xero_credit_note", "N3", -30, { follows_line_id: "PL" }),
    line("C4", "xero_credit_note", "N4", -40, { line_key: "unallocated" }),
    line("C5a", "xero_credit_note", "N5", -25, { follows_document_kind: "xero_bill", follows_document_id: "BW" }),
    line("C5b", "xero_credit_note", "N5", -25, { follows_document_kind: "xero_bill", follows_document_id: "BP" }),
  ];
  const billLines = [
    line("W1", "xero_bill", "BW", 100),
    line("P1", "xero_bill", "BP", 300, { state: "on_job" }),
  ];
  const c = fakeClient((t, f) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
    if (t === "job_cost_lines" && val(f, "id")) return { data: [{ id: "PL", document_kind: "xero_bill", document_id: "BP" }], error: null };
    if (t === "job_cost_lines" && val(f, "document_kind") === "xero_bill") {
      const ids = val(f, "document_id") as string[];
      return { data: billLines.filter((l) => ids.includes(l.document_id)), error: null };
    }
    if (t === "job_cost_lines") return { data: credLines, error: null };
    if (t === "job_cost_line_parts") return { data: [{ line_id: "P1", target: "job", job_id: JOB, division: null }], error: null };
    if (t === "reconcile_items") {
      assertEquals([val(f, "status"), val(f, "subject_table")], ["open", "cost_document"]);
      return { data: [{ id: "c0000000-0000-4000-8000-0000000000b2", subject_id: "xero_bill:BW" }], error: null };
    }
    if (t === "jobs") return { data: [{ id: JOB, job_number: "SWF-990002", site_address: "2 Test St", site_suburb: null }], error: null };
    if (t === "match_clues") return { data: [], error: null };
    throw new Error(`unexpected read ${t}`);
  }, {
    reconcile_list_page: () => ({ data: page, error: null }),
    reconcile_list_counts: () => ({ data: [{ kind: "credit", open: 5 }], error: null }),
  });
  const out: any = await reconcileList(c, new URLSearchParams("tab=bills"), STAFF, NOW);
  const by = (id: string) => out.items.find((i: any) => i.id === id);
  assertEquals(by("c0000000-0000-4000-8000-0000000000c1").bill, {
    document_id: "BX", document_number: null, item_id: null, state: "not_loaded", job_id: null, job_number: null, job_site: null, division: null,
  });
  assertEquals(by("c0000000-0000-4000-8000-0000000000c2").bill, {
    document_id: "BW", document_number: "ZZ-BW", item_id: "c0000000-0000-4000-8000-0000000000b2", state: "waiting",
    job_id: null, job_number: null, job_site: null, division: null,
  });
  assertEquals(by("c0000000-0000-4000-8000-0000000000c3").bill, {
    document_id: "BP", document_number: "ZZ-BP", item_id: null, state: "placed",
    job_id: JOB, job_number: "SWF-990002", job_site: "2 Test St", division: null,
  });
  assertEquals(by("c0000000-0000-4000-8000-0000000000c4").bill, null, "not against a bill");
  const two = by("c0000000-0000-4000-8000-0000000000c5");
  assertEquals(two.bill, { several: true });
  assertEquals(two.bills.map((b: any) => [b.document_id, b.state]), [["BW", "waiting"], ["BP", "placed"]]);
  assertEquals(out.next, null);
});

Deno.test("reconcile list: a bill's state: removed lines, undecided lines, parts by place", () => {
  const L = (id: string, state: string | null, amount: number | null = 10, not: string | null = null) =>
    ({ id, state, amount_ex: amount, not_counted_reason: not });
  assertEquals(billStateOf([], []).state, "not_loaded");
  assertEquals(billStateOf([L("a", null, 10, "line_removed")], []).state, "not_loaded", "only removed lines");
  assertEquals(billStateOf([L("a", "on_job"), L("b", "needs_person")], []).state, "waiting");
  // Not counted for another reason: reads not_counted with its reasons, never waiting.
  for (const why of ["duplicate_document", "duplicate_of_trade_invoice", "counted_by_bank_line", "counted_by_trade_invoice", "document_not_live"]) {
    assertEquals(billStateOf([L("a", null, 10, why)], []), { state: "not_counted", job_id: null, division: null, not_counted_reasons: [why] }, why);
  }
  assertEquals(billStateOf([L("a", null, 10, "duplicate_document"), L("b", null, 10, "counted_by_bank_line"), L("c", null, 0, "line_removed")], []),
    { state: "not_counted", job_id: null, division: null, not_counted_reasons: ["counted_by_bank_line", "duplicate_document"] }, "several reasons, removed lines ignored");
  // A not-counted line beside counted ones: the counted lines decide.
  assertEquals(billStateOf([L("a", null, 10, "duplicate_document"), L("b", "on_job")],
    [{ line_id: "b", target: "job", job_id: "00000000-0000-4000-8000-000000000033", division: null }]),
    { state: "placed", job_id: "00000000-0000-4000-8000-000000000033", division: null }, "the counted line decides");
  assertEquals(billStateOf([L("a", null, 10, "duplicate_document"), L("b", "needs_person")], []).state, "waiting", "the counted line still waits");
  assertEquals(billStateOf([L("a", "on_job", null)], []).state, "waiting", "no amount");
  const J = "00000000-0000-4000-8000-000000000021";
  assertEquals(billStateOf([L("a", "on_job")], [{ line_id: "a", target: "job", job_id: J, division: null }]), { state: "placed", job_id: J, division: null });
  assertEquals(billStateOf([L("a", "on_job"), L("b", "on_job")], [
    { line_id: "a", target: "job", job_id: J, division: null }, { line_id: "b", target: "job", job_id: J, division: null },
  ]), { state: "placed", job_id: J, division: null }, "two lines on one job read placed (grouped by place)");
  assertEquals(billStateOf([L("a", "overhead")], [{ line_id: "a", target: "overhead", job_id: null, division: null }]).state, "overhead");
  assertEquals(billStateOf([L("a", "division_stock")], [{ line_id: "a", target: "division_stock", job_id: null, division: "fencing" }]),
    { state: "division_stock", job_id: null, division: "fencing" });
});

Deno.test("reconcile list: the cursor round-trips and passes to the page read", async () => {
  const cur = { snoozed: true, amount_ex: null, raised_at: "2026-11-16T00:00:00Z", id: "c0000000-0000-4000-8000-000000000003" };
  assertEquals(decodeCursor(encodeCursor(cur)), cur);
  const c = fakeClient((t) => t === "feature_flags" ? flagOn : { data: KINDS, error: null }, {
    reconcile_list_page: (a) => (assertEquals(a.p_after, cur), { data: [], error: null }),
    reconcile_list_counts: () => ({ data: [], error: null }),
  });
  const out: any = await reconcileList(c, new URLSearchParams(`tab=card_bank&after=${encodeCursor(cur)}`), STAFF, NOW);
  assertEquals([out.items, out.next, out.counts], [[], null, { bills: 0, card_bank: 0, receipts: 0 }]);
  assertEquals((c.rpcArgs.reconcile_list_page as any).p_kinds, ["card_line"]);
});

Deno.test("reconcile list: labour billed outside the Trade App is never listed or worded", async () => {
  assertEquals("installer_bill_outside_app" in RECONCILE_REASON_WORDS, false);
  const c = fakeClient((t) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
    if (t === "job_cost_lines") return { data: [line("L9", "xero_bill", "B9", 100)], error: null };
    if (t === "match_clues") return { data: [], error: null };
    throw new Error(`unexpected read ${t}`);
  }, {
    // The database leaves it out; this read drops one that ever came back.
    reconcile_list_page: () => ({ data: [
      item("c0000000-0000-4000-8000-0000000000e1", "bill", "xero_bill:B8", 5000, { reason: "installer_bill_outside_app" }),
      item("c0000000-0000-4000-8000-0000000000e2", "bill", "xero_bill:B9", 100),
    ], error: null }),
    reconcile_list_counts: () => ({ data: [{ kind: "bill", open: 1 }], error: null }),
  });
  const out: any = await reconcileList(c, new URLSearchParams("tab=bills"), STAFF, NOW);
  assertEquals(out.items.map((i: any) => i.id), ["c0000000-0000-4000-8000-0000000000e2"]);
  assertEquals(JSON.stringify(out).includes("installer_bill_outside_app"), false);
});

Deno.test("reconcile list: every read is capped at 1000, and a read reaching 1000 refuses", async () => {
  const many = (n: number, mk: (i: number) => unknown) => Array.from({ length: n }, (_, i) => mk(i));
  const limits: unknown[] = [];
  const base = (over: { lines?: number; parts?: number }) => fakeClient((t, f) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
    limits.push([t, val(f, "limit")]);
    if (t === "job_cost_lines" && val(f, "document_kind") === "xero_bill") {
      return { data: many(1, () => line("W1", "xero_bill", "BW", 10)), error: null };
    }
    if (t === "job_cost_lines") {
      return { data: many(over.lines ?? 1, (i) => line(`C${i}`, "xero_credit_note", "N1", -1,
        { follows_document_kind: "xero_bill", follows_document_id: "BW" })), error: null };
    }
    if (t === "job_cost_line_parts") {
      return { data: many(over.parts ?? 1, () => ({ line_id: "W1", target: "overhead", job_id: null, division: null })), error: null };
    }
    if (t === "reconcile_items") return { data: [], error: null };
    return { data: [], error: null };
  }, {
    reconcile_list_page: () => ({ data: [item("c0000000-0000-4000-8000-0000000000d1", "credit", "xero_credit_note:N1", -1)], error: null }),
    reconcile_list_counts: () => ({ data: [], error: null }),
  });
  const ok: any = await reconcileList(base({ lines: READ_CAP - 1 }), new URLSearchParams("tab=bills"), STAFF, NOW);
  assertEquals(ok.items[0].lines.length, READ_CAP - 1, "under the cap the list is whole");
  for (const [t, cap] of limits as Array<[string, unknown]>) assertEquals(cap, READ_CAP, `${t} read is capped at 1000`);
  // PostgREST stops a read at 1000 rows, so a read reaching 1000 may be cut short: refuse.
  for (const over of [{ lines: READ_CAP }, { parts: READ_CAP }]) {
    const err = await assertRejects(() => reconcileList(base(over), new URLSearchParams("tab=bills"), STAFF, NOW), ReconcileListError);
    assertEquals([err.code, err.status], ["reconcile_list_too_many_lines", 422], JSON.stringify(over));
  }
});

Deno.test("reconcile list: a bill's parts are grouped by where they go, and every counted line needs a part", () => {
  const L = (id: string, state: string) => ({ id, state, amount_ex: 10, not_counted_reason: null });
  const J1 = "00000000-0000-4000-8000-000000000031";
  const J2 = "00000000-0000-4000-8000-000000000032";
  const P = (line_id: string, target: string, job_id: string | null, division: string | null = null) => ({ line_id, target, job_id, division });
  // Several lines (and parts) all on one job: placed, not split.
  assertEquals(billStateOf([L("a", "on_job"), L("b", "on_job")], [P("a", "job", J1), P("b", "job", J1)]),
    { state: "placed", job_id: J1, division: null });
  // Two places: split.
  assertEquals(billStateOf([L("a", "on_job"), L("b", "on_job")], [P("a", "job", J1), P("b", "job", J2)]).state, "split");
  assertEquals(billStateOf([L("a", "on_job"), L("b", "overhead")], [P("a", "job", J1), P("b", "overhead", null)]).state, "split");
  assertEquals(billStateOf([L("a", "division_stock"), L("b", "division_stock")],
    [P("a", "division_stock", null, "fencing"), P("b", "division_stock", null, "patio")]).state, "split");
  // One overhead place across two lines.
  assertEquals(billStateOf([L("a", "overhead"), L("b", "overhead")], [P("a", "overhead", null), P("b", "overhead", null)]).state, "overhead");
  // A counted line with no part: waiting, never placed by its sibling's part.
  assertEquals(billStateOf([L("a", "on_job"), L("b", "on_job")], [P("a", "job", J1)]).state, "waiting");
});

Deno.test("reconcile list: a removed credit line follows no bill", async () => {
  const c = fakeClient((t, f) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
    if (t === "job_cost_lines" && val(f, "document_kind") === "xero_bill") {
      assertEquals(val(f, "document_id"), ["BK"], "the removed line's bill is never read");
      return { data: [line("K1", "xero_bill", "BK", 10)], error: null };
    }
    if (t === "job_cost_lines") {
      return { data: [
        line("R1", "xero_credit_note", "N7", -5, { follows_document_kind: "xero_bill", follows_document_id: "BK" }),
        line("R2", "xero_credit_note", "N7", 0, { state: null, not_counted_reason: "line_removed",
          follows_document_kind: "xero_bill", follows_document_id: "BR" }),
      ], error: null };
    }
    if (t === "job_cost_line_parts" || t === "reconcile_items") return { data: [], error: null };
    if (t === "match_clues") return { data: [], error: null };
    throw new Error(`unexpected read ${t}`);
  }, {
    reconcile_list_page: () => ({ data: [item("c0000000-0000-4000-8000-0000000000f7", "credit", "xero_credit_note:N7", -5)], error: null }),
    reconcile_list_counts: () => ({ data: [], error: null }),
  });
  const out: any = await reconcileList(c, new URLSearchParams("tab=bills"), STAFF, NOW);
  assertEquals(out.items[0].bills.map((b: any) => b.document_id), ["BK"]);
  assertEquals(out.items[0].bill.document_id, "BK", "one bill once the removed line is skipped");
});

Deno.test("reconcile list: a document with a person's labour line is never listed, nor a credit that follows it", async () => {
  const c = fakeClient((t, f) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
    if (t === "job_cost_lines" && val(f, "document_kind") === "xero_bill") {
      return { data: [line("M1", "xero_bill", "BM", 300), line("M2", "xero_bill", "BM", 700, { kind: "installer_bill" })], error: null };
    }
    if (t === "job_cost_lines") {
      return { data: [
        // A mixed bill: supplier line plus a labour line.
        line("X1", "xero_bill", "BX", 100), line("X2", "xero_bill", "BX", 400, { kind: "installer_bill" }),
        line("S1", "xero_bill", "BS", 50),
        line("Q1", "xero_credit_note", "NQ", -20, { follows_document_kind: "xero_bill", follows_document_id: "BM" }),
      ], error: null };
    }
    if (t === "job_cost_line_parts" || t === "reconcile_items") return { data: [], error: null };
    if (t === "match_clues") return { data: [], error: null };
    throw new Error(`unexpected read ${t}`);
  }, {
    reconcile_list_page: () => ({ data: [
      item("c0000000-0000-4000-8000-0000000000a1", "bill", "xero_bill:BX", 500),
      item("c0000000-0000-4000-8000-0000000000a2", "bill", "xero_bill:BS", 50),
      item("c0000000-0000-4000-8000-0000000000a3", "credit", "xero_credit_note:NQ", -20),
    ], error: null }),
    reconcile_list_counts: () => ({ data: [{ kind: "bill", open: 2 }, { kind: "credit", open: 1 }], error: null }),
  });
  const out: any = await reconcileList(c, new URLSearchParams("tab=bills"), STAFF, NOW);
  assertEquals(out.items.map((i: any) => i.id), ["c0000000-0000-4000-8000-0000000000a2"]);
  const text = JSON.stringify(out);
  for (const hidden of ["BX", "BM", "installer_bill", "700", "400"]) assertEquals(text.includes(`"${hidden}"`) || text.includes(`:${hidden},`), false, hidden);
});

Deno.test("reconcile list: any read that comes back with 1000 rows refuses (PostgREST stops at 1000)", async () => {
  const c = fakeClient((t) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: Array.from({ length: READ_CAP }, () => KINDS[0]), error: null };
    if (t === "match_clues") return { data: [], error: null };
    throw new Error(`unexpected read ${t}`);
  });
  const err = await assertRejects(() => reconcileList(c, new URLSearchParams("tab=bills"), STAFF, NOW), ReconcileListError);
  assertEquals([err.code, err.status], ["reconcile_list_too_many_lines", 422]);
});

Deno.test("reconcile list: a bill carries the credits that follow it, each shown as a credit", async () => {
  const reads: string[] = [];
  const c = fakeClient((t, f) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
    if (t === "job_cost_lines" && val(f, "follows_document_kind") === "xero_bill") {
      reads.push("by_document");
      assertEquals([val(f, "follows_document_id"), val(f, "limit")], [["BB"], READ_CAP]);
      return { data: [
        line("F1", "xero_credit_note", "NA", -30, { follows_document_kind: "xero_bill", follows_document_id: "BB", line_no: 1 }),
        line("F2", "xero_credit_note", "NA", -12.5, { follows_document_kind: "xero_bill", follows_document_id: "BB", line_no: 2 }),
        line("F3", "xero_credit_note", "NC", 0, { state: null, not_counted_reason: "line_removed",
          follows_document_kind: "xero_bill", follows_document_id: "BB" }),
      ], error: null };
    }
    if (t === "job_cost_lines" && val(f, "follows_line_id")) {
      reads.push("by_line");
      assertEquals([val(f, "follows_line_id"), val(f, "limit")], [["B1", "B2"], READ_CAP]);
      return { data: [line("G1", "xero_credit_note", "NB", null, { follows_line_id: "B2" })], error: null };
    }
    if (t === "job_cost_lines") return { data: [line("B1", "xero_bill", "BB", 400), line("B2", "xero_bill", "BB", 100)], error: null };
    if (t === "match_clues") return { data: [], error: null };
    throw new Error(`unexpected read ${t}`);
  }, {
    reconcile_list_page: () => ({ data: [item("c0000000-0000-4000-8000-0000000000b9", "bill", "xero_bill:BB", 500)], error: null }),
    reconcile_list_counts: () => ({ data: [], error: null }),
  });
  const out: any = await reconcileList(c, new URLSearchParams("tab=bills"), STAFF, NOW);
  assertEquals(reads.sort(), ["by_document", "by_line"]);
  assertEquals(out.items[0].credits, [
    { document_id: "NA", document_number: "ZZ-NA", is_credit: true, amount_ex: 42.5, lines: [
      { line_id: "F1", description: "ZZTEST line", amount_ex: 30, state: "needs_person" },
      { line_id: "F2", description: "ZZTEST line", amount_ex: 12.5, state: "needs_person" },
    ] },
    { document_id: "NB", document_number: "ZZ-NB", is_credit: true, amount_ex: null, lines: [
      { line_id: "G1", description: "ZZTEST line", amount_ex: null, state: "needs_person" },
    ] },
  ], "removed credit lines dropped; amounts are how much each credit takes off; an unknown amount stays null");
});

Deno.test("reconcile list: a bill with no credits carries an empty list, and too many followers refuse", async () => {
  const run = (followers: number) => reconcileList(fakeClient((t, f) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
    if (t === "job_cost_lines" && val(f, "follows_document_kind")) {
      return { data: Array.from({ length: followers }, (_, i) =>
        line(`F${i}`, "xero_credit_note", `N${i}`, -1, { follows_document_kind: "xero_bill", follows_document_id: "BB" })), error: null };
    }
    if (t === "job_cost_lines" && val(f, "follows_line_id")) return { data: [], error: null };
    if (t === "job_cost_lines") return { data: [line("B1", "xero_bill", "BB", 10)], error: null };
    if (t === "match_clues") return { data: [], error: null };
    throw new Error(`unexpected read ${t}`);
  }, {
    reconcile_list_page: () => ({ data: [item("c0000000-0000-4000-8000-0000000000ba", "bill", "xero_bill:BB", 10)], error: null }),
    reconcile_list_counts: () => ({ data: [], error: null }),
  }), new URLSearchParams("tab=bills"), STAFF, NOW);
  assertEquals(((await run(0)) as any).items[0].credits, []);
  for (const n of [READ_CAP, READ_CAP - 1]) {
    const err = await assertRejects(() => run(n), ReconcileListError);
    assertEquals(err.code, "reconcile_list_too_many_lines", `${n} followers plus the bill's line reach the cap`);
  }
});

Deno.test("reconcile list: a credit whose bill is not counted says so, with the reasons", async () => {
  const c = fakeClient((t, f) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
    if (t === "job_cost_lines" && val(f, "document_kind") === "xero_bill") {
      return { data: [line("N1", "xero_bill", "BN", 10, { state: null, not_counted_reason: "duplicate_document" })], error: null };
    }
    if (t === "job_cost_lines") {
      return { data: [line("R1", "xero_credit_note", "NN", -5, { follows_document_kind: "xero_bill", follows_document_id: "BN" })], error: null };
    }
    if (t === "job_cost_line_parts" || t === "reconcile_items" || t === "match_clues") return { data: [], error: null };
    throw new Error(`unexpected read ${t}`);
  }, {
    reconcile_list_page: () => ({ data: [item("c0000000-0000-4000-8000-0000000000c1", "credit", "xero_credit_note:NN", -5)], error: null }),
    reconcile_list_counts: () => ({ data: [], error: null }),
  });
  const out: any = await reconcileList(c, new URLSearchParams("tab=bills"), STAFF, NOW);
  assertEquals([out.items[0].bill.state, out.items[0].bill.not_counted_reasons], ["not_counted", ["duplicate_document"]]);
});

Deno.test("reconcile list: each item carries the matcher's clues and, as against, its stops' words", async () => {
  const J = "00000000-0000-4000-8000-000000000041";
  const reads: string[] = [];
  const c = fakeClient((t, f) => {
    if (t === "feature_flags") return flagOn;
    if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
    if (t === "match_clues") {
      reads.push(t);
      assertEquals([val(f, "org_id"), val(f, "subject_kind"), val(f, "current"), val(f, "subject_id"), val(f, "limit")],
        [ORG, "cost_document", true, ["xero_bill:BC", "xero_bill:BD"], READ_CAP]);
      return { data: [
        { id: 12, subject_id: "xero_bill:BC", clue_code: "delivery_address", outcome: "job", job_id: J, division: null, names_one: true, seen_where: "delivery address", seen_value: "ZZTEST site" },
        { id: 11, subject_id: "xero_bill:BC", clue_code: "job_number", outcome: "job", job_id: J, division: null, names_one: true, seen_where: "reference", seen_value: "SWF-ZZ1" },
        { id: 13, subject_id: "xero_bill:BC", clue_code: "division_tag", outcome: "division_stock", job_id: null, division: "fencing", names_one: true, seen_where: null, seen_value: null },
      ], error: null };
    }
    if (t === "match_clue_types") {
      reads.push(t);
      return { data: [
        { code: "job_number", class: "key", mode: "counts", words: "Our job number is written on the document" },
        { code: "delivery_address", class: "clue", mode: "suggest_only", words: "The delivery address is this job's site" },
        { code: "division_tag", class: "narrower", mode: "off", words: "The Xero tag" },
      ], error: null };
    }
    if (t === "jobs") return { data: [{ id: J, job_number: "SWF-ZZ1", site_address: null, site_suburb: null }], error: null };
    if (t === "job_cost_lines") return { data: [], error: null };
    throw new Error(`unexpected read ${t}`);
  }, {
    reconcile_list_page: () => ({ data: [
      item("c0000000-0000-4000-8000-0000000000d1", "bill", "xero_bill:BC", 90, {
        reason: "one_clue", suggestion: { outcome: "job", job_id: J, clue_ids: [11] },
        evidence: { stops: [{ code: "digit_twin", words: "Two jobs share these digits" }, { code: "x", words: "" }, "junk"] },
      }),
      item("c0000000-0000-4000-8000-0000000000d2", "bill", "xero_bill:BD", 80),
    ], error: null }),
    reconcile_list_counts: () => ({ data: [], error: null }),
  });
  const out: any = await reconcileList(c, new URLSearchParams("tab=bills"), STAFF, NOW);
  assertEquals(reads, ["match_clues", "match_clue_types"]);
  assertEquals(out.items[0].clues, [
    { clue_id: 11, code: "job_number", words: "Our job number is written on the document", counts: true, outcome: "job",
      job_id: J, job_number: "SWF-ZZ1", job_site: null, division: null, names_one: true, seen_where: "reference", seen_value: "SWF-ZZ1", in_suggestion: true },
    { clue_id: 12, code: "delivery_address", words: "The delivery address is this job's site", counts: false, outcome: "job",
      job_id: J, job_number: "SWF-ZZ1", job_site: null, division: null, names_one: true, seen_where: "delivery address", seen_value: "ZZTEST site", in_suggestion: false },
  ], "oldest first; a switched-off clue type is not shown; a suggest-only clue does not count");
  assertEquals(out.items[0].against, ["Two jobs share these digits"]);
  assertEquals([out.items[1].clues, out.items[1].against], [[], []], "no clues, no stops");
});

Deno.test("reconcile list: a failed clue read refuses, never a list without its reasons", async () => {
  for (const broken of ["match_clues", "match_clue_types"]) {
    const c = fakeClient((t) => {
      if (t === "feature_flags") return flagOn;
      if (t === "reconcile_item_kinds") return { data: KINDS, error: null };
      if (t === broken) return { data: null, error: { message: "down" } };
      if (t === "match_clues") return { data: [{ id: 1, subject_id: "xero_bill:BC", clue_code: "job_number", outcome: "job", job_id: null, division: null, names_one: true }], error: null };
      if (t === "job_cost_lines") return { data: [], error: null };
      throw new Error(`unexpected read ${t}`);
    }, {
      reconcile_list_page: () => ({ data: [item("c0000000-0000-4000-8000-0000000000d3", "bill", "xero_bill:BC", 90)], error: null }),
      reconcile_list_counts: () => ({ data: [], error: null }),
    });
    const err = await assertRejects(() => reconcileList(c, new URLSearchParams("tab=bills"), STAFF, NOW), ReconcileListError);
    assertEquals(err.code, "reconcile_list_unreadable", broken);
  }
});

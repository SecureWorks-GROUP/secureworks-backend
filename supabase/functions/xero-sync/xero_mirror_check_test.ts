// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compareMirror,
  healable,
  listXeroInvoices,
  MIRROR_CHECK_INTERVAL_MS,
  MIRROR_CHECK_KEY,
  MIRROR_HEAL_LIMIT,
  runInvoiceMirrorCheck,
} from "./xero_mirror_check.ts";
import { XeroSyncProviderError } from "./xero_transport.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-10-20T03:00:00.000Z");
const id = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ── A tiny in-memory PostgREST client: just the calls the check makes. ──

type Row = Record<string, any>;

function fakeClient(tables: Record<string, Row[]>) {
  const writes: Array<{ table: string; op: string; value: unknown }> = [];
  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "delete" = "select";
    let patch: Row = {};
    let range: [number, number] | null = null;
    let single = false;
    const rows = () => (tables[table] ??= []);
    const run = () => {
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        hit.forEach((r) => Object.assign(r, patch));
        writes.push({ table, op, value: patch });
        return { data: null, error: null };
      }
      if (op === "delete") {
        tables[table] = rows().filter((r) => !hit.includes(r));
        writes.push({ table, op, value: hit.length });
        return { data: null, error: null };
      }
      const sorted = [...hit].sort((a, b) =>
        String(a.xero_invoice_id ?? "").localeCompare(
          String(b.xero_invoice_id ?? ""),
        )
      );
      const data = range ? sorted.slice(range[0], range[1] + 1) : sorted;
      return {
        data: single ? data[0] ?? null : data.map((r) => ({ ...r })),
        error: null,
      };
    };
    const q: any = {
      select() {
        return q;
      },
      update(p: Row) {
        op = "update";
        patch = p;
        return q;
      },
      delete() {
        op = "delete";
        return q;
      },
      eq(f: string, v: unknown) {
        filters.push((r) => r[f] === v);
        return q;
      },
      gt(f: string, v: number) {
        filters.push((r) => Number(r[f]) > v);
        return q;
      },
      lt(f: string, v: string) {
        filters.push((r) => String(r[f]) < v);
        return q;
      },
      in(f: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[f]));
        return q;
      },
      order() {
        return q;
      },
      range(a: number, b: number) {
        range = [a, b];
        return q;
      },
      maybeSingle() {
        single = true;
        return Promise.resolve(run());
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        try {
          resolve(run());
        } catch (e) {
          reject(e);
        }
      },
    };
    return q;
  }
  const client = {
    from(table: string) {
      const q = query(table);
      return {
        ...q,
        select: () => q,
        update: (p: Row) => q.update(p),
        delete: () => q.delete(),
        insert(row: Row) {
          (tables[table] ??= []).push({ ...row });
          writes.push({ table, op: "insert", value: row });
          return Promise.resolve({ error: null });
        },
        upsert(row: Row) {
          const list = (tables[table] ??= []);
          const found = list.find((r) => r.key === row.key);
          if (found) Object.assign(found, row);
          else list.push({ ...row });
          writes.push({ table, op: "upsert", value: row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, tables, writes };
}

function copyRow(n: number, status: string, amount: number, extra: Row = {}) {
  return {
    org_id: ORG,
    invoice_type: "ACCREC",
    xero_invoice_id: id(n),
    invoice_number: `INV-${String(n).padStart(4, "0")}`,
    contact_name: `Contact ${n}`,
    status,
    amount_due: amount,
    raw_json: { Status: "AUTHORISED" },
    ...extra,
  };
}

function xeroInvoice(n: number, status: string, amountDue: number) {
  return {
    InvoiceID: id(n),
    InvoiceNumber: `INV-${String(n).padStart(4, "0")}`,
    Type: "ACCREC",
    Status: status,
    AmountDue: amountDue,
    AmountPaid: 0,
    Contact: { Name: `Contact ${n}` },
    UpdatedDateUTC: "/Date(1760000000000+0000)/",
  };
}

/** Xero as a list (by status) and as single reads (by id). */
function fakeXero(invoices: Array<ReturnType<typeof xeroInvoice>>) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      listPage: (status: "AUTHORISED" | "DRAFT", page: number) => {
        calls.push(`list ${status} ${page}`);
        const all = invoices.filter((i) => i.Status === status);
        return Promise.resolve({
          Invoices: all.slice((page - 1) * 100, page * 100),
        });
      },
      readInvoice: (invoiceId: string) => {
        calls.push(`read ${invoiceId}`);
        const inv = invoices.find((i) => i.InvoiceID === invoiceId);
        if (!inv) {
          return Promise.reject(
            new XeroSyncProviderError(404, `/Invoices/${invoiceId}`),
          );
        }
        return Promise.resolve({ Invoices: [inv] });
      },
    },
  };
}

// ── The five invoices of 20 Oct 2026, in synthetic form ──

Deno.test("open in Xero, DELETED in our copy: re-read by id, healed, then it matches", async () => {
  const { client, tables } = fakeClient({
    xero_invoices: [
      copyRow(1, "AUTHORISED", 100),
      // The bug: marked DELETED with nothing owing while Xero still says it is open.
      copyRow(2, "DELETED", 0),
      copyRow(3, "DELETED", 0),
    ],
    xero_sync_state: [],
  });
  const xero = fakeXero([
    xeroInvoice(1, "AUTHORISED", 100),
    xeroInvoice(2, "AUTHORISED", 734.48),
    xeroInvoice(3, "AUTHORISED", 352),
    xeroInvoice(9, "DRAFT", 500),
  ]);
  const out = await runInvoiceMirrorCheck(client, ORG, xero.deps, { now: NOW });

  assertEquals(out.ran, true);
  assertEquals(out.complete, true);
  assertEquals(out.matches, true);
  assertEquals(out.healed, 2);
  assertEquals(out.xero, { count: 3, total: 1186.48 });
  assertEquals(out.copy, { count: 3, total: 1186.48 });
  // Each heal is one read BY ID; Xero's list is read once per status.
  assertEquals(xero.calls, [
    "list AUTHORISED 1",
    `read ${id(2)}`,
    `read ${id(3)}`,
    "list DRAFT 1",
  ]);
  const healed = tables.xero_invoices.find((r) => r.xero_invoice_id === id(2))!;
  assertEquals(healed.status, "AUTHORISED");
  assertEquals(healed.amount_due, 734.48);
  assertEquals(healed.raw_json.Status, "AUTHORISED");

  const row = tables.xero_mirror_checks[0];
  assertEquals(row.complete, true);
  assertEquals(row.matches, true);
  assertEquals(row.differ_count, 0);
  assertEquals(row.drafts_count, 1);
  assertEquals(row.drafts_total, 500);
  assertEquals(row.healed.map((h: any) => [h.invoice_number, h.before, h.after]), [
    ["INV-0002", { status: "DELETED", amount_due: 0 }, {
      status: "AUTHORISED",
      amount_due: 734.48,
    }],
    ["INV-0003", { status: "DELETED", amount_due: 0 }, {
      status: "AUTHORISED",
      amount_due: 352,
    }],
  ]);
  // The hourly cursor moved.
  assertEquals(
    tables.xero_sync_state.find((r) => r.key === MIRROR_CHECK_KEY)?.cursor_at,
    NOW.toISOString(),
  );
});

Deno.test("never marks anything not owed: a copy row Xero does not list is only reported", async () => {
  const { client, tables, writes } = fakeClient({
    xero_invoices: [copyRow(1, "AUTHORISED", 100), copyRow(2, "AUTHORISED", 50)],
  });
  // Xero lists only invoice 1 as open; invoice 2 is not in the list at all.
  const xero = fakeXero([xeroInvoice(1, "AUTHORISED", 100)]);
  const out = await runInvoiceMirrorCheck(client, ORG, xero.deps, { now: NOW });

  assertEquals(out.matches, false);
  assertEquals(out.healed, 0);
  assert(!xero.calls.some((c) => c.startsWith("read")), "no read was made");
  // Our copy is untouched: still AUTHORISED with 50 owing. The hourly stale check
  // (xero_invoice_reconciliation.ts) re-reads it by id and copies what Xero says.
  const two = tables.xero_invoices.find((r) => r.xero_invoice_id === id(2))!;
  assertEquals([two.status, two.amount_due], ["AUTHORISED", 50]);
  assertEquals(writes.filter((w) => w.table === "xero_invoices").length, 0);
  assertEquals(tables.xero_mirror_checks[0].differences, [{
    xero_invoice_id: id(2),
    invoice_number: "INV-0002",
    contact_name: "Contact 2",
    reason: "not_owed_in_xero",
    xero_amount_due: null,
    copy_amount_due: 50,
    copy_status: "AUTHORISED",
  }]);
});

Deno.test("an invoice Xero lists that our copy has never seen is reported, never inserted", async () => {
  const { client, tables } = fakeClient({ xero_invoices: [] });
  const xero = fakeXero([xeroInvoice(5, "AUTHORISED", 75)]);
  const out = await runInvoiceMirrorCheck(client, ORG, xero.deps, { now: NOW });
  assertEquals(out.matches, false);
  assertEquals(out.healed, 0);
  assertEquals(tables.xero_invoices.length, 0);
  assertEquals(tables.xero_mirror_checks[0].differences[0].reason, "missing_from_copy");
  assertEquals(tables.xero_mirror_checks[0].differences[0].copy_status, null);
});

Deno.test("a different amount is healed from Xero's own record", async () => {
  const { client, tables } = fakeClient({
    xero_invoices: [copyRow(1, "AUTHORISED", 100)],
  });
  const xero = fakeXero([xeroInvoice(1, "AUTHORISED", 60)]);
  const out = await runInvoiceMirrorCheck(client, ORG, xero.deps, { now: NOW });
  assertEquals(out.matches, true);
  assertEquals(tables.xero_invoices[0].amount_due, 60);
});

Deno.test("a heal whose single read disagrees with the list copies the single read", async () => {
  // Listed as open, but by the time it is read by id Xero says it was paid: our copy
  // takes the single read (the same identity-checked write as the hourly check).
  const { client, tables } = fakeClient({
    xero_invoices: [copyRow(1, "DELETED", 0)],
  });
  const listed = xeroInvoice(1, "AUTHORISED", 40);
  const paid = { ...listed, Status: "PAID", AmountDue: 0, AmountPaid: 40 };
  const deps = {
    listPage: (status: string) =>
      Promise.resolve({ Invoices: status === "AUTHORISED" ? [listed] : [] }),
    readInvoice: () => Promise.resolve({ Invoices: [paid] }),
  };
  const out = await runInvoiceMirrorCheck(client, ORG, deps, { now: NOW });
  assertEquals(tables.xero_invoices[0].status, "PAID");
  // Still differs (Xero's list said open), so it is reported for the next check.
  assertEquals(out.matches, false);
  assertEquals(out.differ_count, 1);
});

Deno.test("a failed read by id leaves the row alone and keeps healing the rest", async () => {
  const { client, tables } = fakeClient({
    xero_invoices: [copyRow(1, "DELETED", 0), copyRow(2, "DELETED", 0)],
  });
  const xero = fakeXero([
    xeroInvoice(1, "AUTHORISED", 10),
    xeroInvoice(2, "AUTHORISED", 20),
  ]);
  const deps = {
    ...xero.deps,
    readInvoice: (invoiceId: string) =>
      invoiceId === id(1)
        ? Promise.reject(new XeroSyncProviderError(500, "/Invoices/x"))
        : xero.deps.readInvoice(invoiceId),
  };
  const out = await runInvoiceMirrorCheck(client, ORG, deps, { now: NOW });
  assertEquals(out.healed, 1);
  assertEquals(out.heal_failed, 1);
  // The failed one is exactly as it was: a failed read proves nothing.
  const one = tables.xero_invoices.find((r) => r.xero_invoice_id === id(1))!;
  assertEquals([one.status, one.amount_due], ["DELETED", 0]);
  assertEquals(tables.xero_mirror_checks[0].differ_count, 1);
});

Deno.test("a cooldown stops healing; the check still records what it found", async () => {
  const { client, tables } = fakeClient({
    xero_invoices: [copyRow(1, "DELETED", 0), copyRow(2, "DELETED", 0)],
  });
  const xero = fakeXero([
    xeroInvoice(1, "AUTHORISED", 10),
    xeroInvoice(2, "AUTHORISED", 20),
  ]);
  let reads = 0;
  const deps = {
    ...xero.deps,
    readInvoice: () => {
      reads++;
      return Promise.reject(new XeroCooldownError("fixture-only cooldown", 429, "xero_cooldown"));
    },
  };
  const out = await runInvoiceMirrorCheck(client, ORG, deps, { now: NOW });
  assertEquals(reads, 1);
  assertEquals(out.healed, 0);
  assertEquals(out.complete, true);
  assertEquals(tables.xero_mirror_checks[0].differ_count, 2);
});

Deno.test("an unverifiable Xero list heals nothing and records an incomplete check", async () => {
  const { client, tables, writes } = fakeClient({
    xero_invoices: [copyRow(1, "DELETED", 0)],
  });
  const deps = {
    // A record that does not say it is a sales invoice.
    listPage: () =>
      Promise.resolve({
        Invoices: [{ ...xeroInvoice(1, "AUTHORISED", 10), Type: "ACCPAY" }],
      }),
    readInvoice: () => Promise.reject(new Error("must not be called")),
  };
  const out = await runInvoiceMirrorCheck(client, ORG, deps, { now: NOW });
  assertEquals(out.complete, false);
  assertEquals(out.matches, null);
  assertEquals(writes.filter((w) => w.table === "xero_invoices").length, 0);
  assertEquals(tables.xero_mirror_checks[0].complete, false);
  assert(/unverified/.test(tables.xero_mirror_checks[0].error));
  // An incomplete check leaves the hourly cursor alone, so the next sync tries again.
  assertEquals(tables.xero_sync_state ?? [], []);
});

Deno.test("a Xero cooldown on the list never throws into the sync", async () => {
  const { client, tables } = fakeClient({ xero_invoices: [] });
  const deps = {
    listPage: () => Promise.reject(new XeroCooldownError("fixture-only cooldown", 429, "xero_cooldown")),
    readInvoice: () => Promise.reject(new Error("unused")),
  };
  const out = await runInvoiceMirrorCheck(client, ORG, deps, { now: NOW });
  assertEquals(out.complete, false);
  assert(/wait/.test(String(tables.xero_mirror_checks[0].error)));
});

Deno.test("once an hour: a recent check skips, an old one runs, force always runs", async () => {
  const recent = new Date(NOW.getTime() - 10 * 60_000).toISOString();
  const { client } = fakeClient({
    xero_invoices: [],
    xero_sync_state: [{ key: MIRROR_CHECK_KEY, cursor_at: recent }],
  });
  const xero = fakeXero([]);
  assertEquals(
    (await runInvoiceMirrorCheck(client, ORG, xero.deps, { now: NOW })).ran,
    false,
  );
  assertEquals(xero.calls, []);
  assertEquals(
    (await runInvoiceMirrorCheck(client, ORG, xero.deps, { now: NOW, force: true }))
      .ran,
    true,
  );
  const later = new Date(NOW.getTime() + MIRROR_CHECK_INTERVAL_MS + 1);
  assertEquals(
    (await runInvoiceMirrorCheck(client, ORG, xero.deps, { now: later })).ran,
    true,
  );
});

Deno.test("heals at most MIRROR_HEAL_LIMIT a check", async () => {
  const n = MIRROR_HEAL_LIMIT + 3;
  const copy = Array.from({ length: n }, (_, i) => copyRow(i + 1, "DELETED", 0));
  const listed = Array.from(
    { length: n },
    (_, i) => xeroInvoice(i + 1, "AUTHORISED", 10),
  );
  const { client } = fakeClient({ xero_invoices: copy });
  const xero = fakeXero(listed);
  const out = await runInvoiceMirrorCheck(client, ORG, xero.deps, { now: NOW });
  assertEquals(out.healed, MIRROR_HEAL_LIMIT);
  assertEquals(out.differ_count, 3);
});

Deno.test("the list is paged until a short page, and duplicates count once", async () => {
  const pages = [
    Array.from({ length: 100 }, (_, i) => xeroInvoice(i + 1, "AUTHORISED", 1)),
    [xeroInvoice(100, "AUTHORISED", 1), xeroInvoice(101, "AUTHORISED", 1)],
  ];
  const seen: number[] = [];
  const out = await listXeroInvoices((_s, page) => {
    seen.push(page);
    return Promise.resolve({ Invoices: pages[page - 1] ?? [] });
  }, "AUTHORISED");
  assertEquals(seen, [1, 2]);
  assertEquals(out.length, 101);
});

Deno.test("compareMirror names each kind of difference, and healable picks only owed ones", () => {
  const diffs = compareMirror(
    [
      { xero_invoice_id: id(1), invoice_number: "INV-0001", contact_name: null, amount_due: 10 },
      { xero_invoice_id: id(2), invoice_number: "INV-0002", contact_name: null, amount_due: 20 },
      { xero_invoice_id: id(3), invoice_number: "INV-0003", contact_name: null, amount_due: 30 },
    ],
    [
      { xero_invoice_id: id(1), invoice_number: "INV-0001", contact_name: null, status: "AUTHORISED", amount_due: 10 },
      { xero_invoice_id: id(2), invoice_number: "INV-0002", contact_name: null, status: "AUTHORISED", amount_due: 25 },
      { xero_invoice_id: id(4), invoice_number: "INV-0004", contact_name: null, status: "AUTHORISED", amount_due: 40 },
    ],
    [{ xero_invoice_id: id(3), invoice_number: "INV-0003", contact_name: null, status: "VOIDED", amount_due: 0 }],
  );
  assertEquals(diffs.map((d) => [d.invoice_number, d.reason, healable(d)]), [
    ["INV-0002", "amount_differs", true],
    ["INV-0003", "missing_from_copy", true],
    ["INV-0004", "not_owed_in_xero", false],
  ]);
});

// deno-lint-ignore-file no-import-prefix no-explicit-any
// Debt Workshop Supabase store (debt_ws_store.ts) and the batch Xero reader
// (debt_ws_deps.ts), over a recording fake PostgREST client.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createSupabaseDebtWsStore, DebtWsError } from "./debt_ws_store.ts";
import { readXeroInvoicesByIds } from "./debt_ws_deps.ts";

type Result = { data: any; error: any };

/** A chainable PostgREST stand-in: every call is recorded; the result comes from `answer`. */
function fakeClient(answer: (table: string, calls: string[]) => Result) {
  const log: Array<{ table: string; calls: string[] }> = [];
  const client = {
    from(table: string) {
      const calls: string[] = [];
      log.push({ table, calls });
      const builder: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") {
            const r = answer(table, calls);
            return (ok: any, bad: any) => Promise.resolve(r).then(ok, bad);
          }
          return (...args: unknown[]) => {
            calls.push(`${prop}(${JSON.stringify(args)})`);
            if (prop === "maybeSingle" || prop === "single") {
              return Promise.resolve(answer(table, calls));
            }
            return builder;
          };
        },
      });
      return builder;
    },
  };
  return { client, log };
}

Deno.test("store: a PostgREST read error throws, it never reads as empty", async () => {
  const { client } = fakeClient(() => ({
    data: null,
    error: { code: "42P01", message: "missing" },
  }));
  const store = createSupabaseDebtWsStore(client);
  for (
    const read of [
      () => store.settings(),
      () => store.openInvoices(),
      () => store.logs(["a"]),
      () => store.sends(["a"]),
      () => store.janList("2026-10-12"),
      () => store.statementsForWeek("2026-10-05"),
    ]
  ) {
    const error = await assertRejects(read, DebtWsError);
    assertEquals(error.code, "debt_ws_read_failed");
    assertEquals(error.status, 502);
  }
});

Deno.test("store: a missing settings row reads as everything off and nobody the owner", async () => {
  const { client } = fakeClient(() => ({ data: null, error: null }));
  const settings = await createSupabaseDebtWsStore(client).settings();
  assertEquals(settings.sending_enabled, false);
  assertEquals(settings.owner_user_ids, []);
  assertEquals(settings.auto_send_steps, {});
});

Deno.test("store: settings are normalised from the row", async () => {
  const { client } = fakeClient(() => ({
    data: {
      owner_user_ids: ["ABC"],
      tab_visible: true,
      sending_enabled: "true",
      agent_enabled: true,
      auto_send_steps: [],
      jan_list_auto_send: false,
      not_chased_contacts: ["X"],
      statement_emails: { A: "a@example.test" },
    },
    error: null,
  }));
  const s = await createSupabaseDebtWsStore(client).settings();
  assertEquals(s.owner_user_ids, ["abc"]);
  assertEquals(s.tab_visible, true);
  // Only a real boolean true switches sending on.
  assertEquals(s.sending_enabled, false);
  assertEquals(s.auto_send_steps, {});
  assertEquals(s.statement_emails, { A: "a@example.test" });
});

Deno.test("store: a claim that hits the unique index is null, any other error throws", async () => {
  const conflict = fakeClient(() => ({
    data: null,
    error: { code: "23505", message: "dup" },
  }));
  const claim = {
    share_key: "s",
    cycle_start: "2026-10-01",
    step: "d1",
    suggestion_id: null,
    actor: "Shaun",
  };
  assertEquals(
    await createSupabaseDebtWsStore(conflict.client).claimSend(claim),
    null,
  );
  const insert = conflict.log[0].calls[0];
  assert(insert.startsWith("insert("));
  assert(insert.includes('"status":"sending"'));
  const broken = fakeClient(() => ({
    data: null,
    error: { code: "42501", message: "denied" },
  }));
  await assertRejects(
    () => createSupabaseDebtWsStore(broken.client).claimSend(claim),
    DebtWsError,
  );
  assertEquals(
    await createSupabaseDebtWsStore(conflict.client).claimStatement({
      company_key: "c",
      week_start: "2026-10-05",
      xero_invoice_ids: [],
      total: 1,
      to_email: "a@example.test",
      approved_by: "Shaun",
    }),
    null,
  );
});

Deno.test("store: the open-invoice read is scoped and selects the first line's description", async () => {
  const { client, log } = fakeClient(() => ({
    data: [{
      xero_invoice_id: "ABC",
      total: "10.50",
      amount_due: "10.50",
      first_description: "Balance",
    }],
    error: null,
  }));
  const rows = await createSupabaseDebtWsStore(client).openInvoices();
  assertEquals(rows[0].xero_invoice_id, "abc");
  assertEquals(rows[0].total, 10.5);
  assertEquals(rows[0].first_description, "Balance");
  const calls = log[0].calls.join(" ");
  assert(calls.includes("first_description:line_items->0->>Description"));
  assert(calls.includes('eq(["invoice_type","ACCREC"])'));
  assert(calls.includes('eq(["status","AUTHORISED"])'));
  assert(calls.includes('gt(["amount_due",0])'));
});

Deno.test("store: a suggestion decision only lands while it is pending", async () => {
  const { client, log } = fakeClient(() => ({ data: [], error: null }));
  const ok = await createSupabaseDebtWsStore(client).decideSuggestion("id-1", {
    status: "dismissed",
    decided_by: "Shaun",
  });
  assertEquals(ok, false);
  assert(log[0].calls.join(" ").includes('in(["status",["pending"]])'));
});

Deno.test("batch Xero read: 40 ids a call, receivables only, nothing unasked", async () => {
  const ids = Array.from(
    { length: 45 },
    (_, k) => `10000000-0000-4000-8000-${String(k).padStart(12, "0")}`,
  );
  const calls: Array<Record<string, string>> = [];
  const rows = await readXeroInvoicesByIds({}, [...ids, "not-an-id"], {
    getToken: () => Promise.resolve({ accessToken: "t", tenantId: "x" }),
    xeroGet: (_path, _a, _t, params) => {
      calls.push(params!);
      const asked = params!.IDs.split(",");
      return Promise.resolve({
        data: {
          Invoices: asked.map((id) => ({
            InvoiceID: id.toUpperCase(),
            Type: "ACCREC",
            Status: "AUTHORISED",
            AmountDue: 1,
          })),
        },
      });
    },
  });
  assertEquals(calls.length, 2);
  assertEquals(calls[0].IDs.split(",").length, 40);
  assertEquals(rows.length, 45);
  await assertRejects(() =>
    readXeroInvoicesByIds({}, [ids[0]], {
      getToken: () => Promise.resolve({ accessToken: "t", tenantId: "x" }),
      xeroGet: () =>
        Promise.resolve({
          data: { Invoices: [{ InvoiceID: ids[1], Type: "ACCREC" }] },
        }),
    })
  );
  await assertRejects(() =>
    readXeroInvoicesByIds({}, [ids[0]], {
      getToken: () => Promise.resolve({ accessToken: "t", tenantId: "x" }),
      xeroGet: () =>
        Promise.resolve({
          data: { Invoices: [{ InvoiceID: ids[0], Type: "ACCPAY" }] },
        }),
    })
  );
  assertEquals(
    await readXeroInvoicesByIds({}, [], {
      getToken: () => Promise.reject(new Error("never called")),
      xeroGet: () => Promise.reject(new Error("never called")),
    }),
    [],
  );
});

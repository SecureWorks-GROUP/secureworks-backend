import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  backfillCostLines,
  handleCostLinesBackfill,
} from "./cost_lines_backfill.ts";

const org = "10000000-0000-4000-8000-000000000001";
function fake(kind = "bills") {
  const calls: { name: string; args: any }[] = [];
  const reads: any[] = [];
  const bill = (id: string) => ({
    xero_invoice_id: id,
    invoice_type: "ACCPAY",
    status: "AUTHORISED",
    line_items: [{ LineAmount: 1 }],
  });
  const rows: Record<string, any[]> = {
    xero_invoices: [bill("a"), bill("b"), bill("c")],
    trade_invoices: kind === "bills"
      ? [{ id: "m", xero_bill_id: "b" }]
      : [{ id: "a" }, { id: "b" }],
    xero_supplier_credit_notes: [{ xero_credit_note_id: "a" }, {
      xero_credit_note_id: "b",
    }],
  };
  const state = {
    enabled: true,
    fail: "",
    refused: false,
    missingFlag: false,
    failOn: 0,
  };
  const client = {
    from(table: string) {
      const filters: any[] = [];
      let key = "", cap = 0;
      const q: any = {
        select() {
          return q;
        },
        eq(k: string, v: unknown) {
          filters.push(["eq", k, v]);
          return q;
        },
        gt(k: string, v: unknown) {
          filters.push(["gt", k, v]);
          return q;
        },
        order(k: string) {
          key = k;
          return q;
        },
        limit(n: number) {
          cap = n;
          return q;
        },
        maybeSingle() {
          return q;
        },
        then(resolve: any, reject: any) {
          reads.push({ table, filters, key, cap });
          if (state.fail === table) {
            return Promise.resolve({
              data: null,
              error: { message: "read failed" },
            }).then(resolve, reject);
          }
          if (table === "feature_flags") {
            return Promise.resolve({
              data: state.missingFlag ? null : { enabled: state.enabled },
              error: null,
            }).then(resolve, reject);
          }
          let data = rows[table].filter((r) =>
            filters.every(([op, k, v]) => op !== "gt" || r[k] > v)
          );
          data = data.sort((a, b) =>
            String(a[key]).localeCompare(String(b[key]))
          ).slice(0, cap);
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
    rpc(name: string, args: any) {
      calls.push({ name, args });
      if ((state.fail === "rpc" || calls.length === state.failOn)) {
        return Promise.resolve({ data: null, error: { message: "busy" } });
      }
      return Promise.resolve({
        data: state.refused
          ? { ran: false, reason: "flag_off" }
          : { documents: 1, lines_written: 1, ran: true },
        error: null,
      });
    },
  };
  return { client, calls, reads, rows, state };
}
Deno.test("backfill: bills exclude mirrors, honour cursor, and finish only after empty read", async () => {
  const f = fake();
  assertEquals(await backfillCostLines(f.client, org, { kind: "bills" }), {
    kind: "bills",
    done: 3,
    next_after: "c",
  });
  assertEquals(f.calls.length, 1);
  assertEquals(f.calls[0].args.p_docs.map((d: any) => d.document_id), [
    "a",
    "c",
  ]);
  f.calls.length = 0;
  assertEquals(
    await backfillCostLines(f.client, org, { kind: "bills", after: "b" }),
    { kind: "bills", done: 1, next_after: "c" },
  );
  assertEquals(f.calls[0].args.p_docs.map((d: any) => d.document_id), ["c"]);
  assertEquals(
    await backfillCostLines(f.client, org, { kind: "bills", after: "c" }),
    { kind: "bills", done: 0, next_after: null },
  );
});
Deno.test("backfill: switch off, missing or failed reads never write", async () => {
  const f = fake();
  f.state.enabled = false;
  assertEquals(await backfillCostLines(f.client, org, { kind: "bills" }), {
    skipped: "switch_off",
  });
  assertEquals(f.reads.length, 1);
  f.state.missingFlag = true;
  assertEquals(await backfillCostLines(f.client, org, { kind: "bills" }), {
    skipped: "switch_off",
  });
  f.state.missingFlag = false;
  for (const table of ["feature_flags", "xero_invoices", "trade_invoices"]) {
    f.state.enabled = true;
    f.state.fail = table;
    const r = await backfillCostLines(f.client, org, {
      kind: "bills",
      after: "a",
    });
    assertEquals("error" in r, true);
    assertEquals((r as any).next_after, "a");
  }
  assertEquals(f.calls.length, 0);
});
Deno.test("backfill: credits batch, trade sequential progress and refusal retry", async () => {
  for (const kind of ["credits", "trade"] as const) {
    const f = fake(kind);
    f.state.fail = "rpc";
    const refused = await backfillCostLines(f.client, org, { kind });
    assertEquals((refused as any).next_after, null);
    assertEquals((refused as any).done, 0);
    f.state.fail = "";
    f.calls.length = 0;
    assertEquals(await backfillCostLines(f.client, org, { kind }), {
      kind,
      done: 2,
      next_after: "b",
    });
    assertEquals(
      f.calls.map((c) => c.name),
      kind === "credits" ? ["job_cost_lines_sync_credit_notes"] : [
        "job_cost_lines_sync_trade_invoice",
        "job_cost_lines_sync_trade_invoice",
      ],
    );
    assertEquals(
      f.calls[0].args,
      kind === "credits"
        ? { p_credit_note_ids: ["a", "b"] }
        : { p_trade_invoice_id: "a" },
    );
    f.state.refused = true;
    assertEquals(
      "error" in await backfillCostLines(f.client, org, { kind }),
      true,
    );
  }
});
Deno.test("backfill: office edits and missing amounts use current source and existing writer", async () => {
  const f = fake();
  f.rows.xero_invoices[0].sub_total = null;
  f.rows.xero_invoices[0].line_items = [];
  await backfillCostLines(f.client, org, { kind: "bills" });
  assertEquals(f.calls[0].args.p_docs[0].lines[0].amount_ex, null);
  f.rows.xero_invoices[0].line_items = [{ LineAmount: 2 }];
  await backfillCostLines(f.client, org, { kind: "bills" });
  assertEquals(f.calls[1].args.p_docs[0].lines[0].amount_ex, 2);
});
Deno.test("backfill: service key and POST required before any read", async () => {
  const f = fake();
  for (
    const [method, auth, expected] of [["POST", "Bearer other", 403], [
      "GET",
      "Bearer test-only",
      405,
    ], ["POST", "Bearer test-only", 200]] as const
  ) {
    const response = await handleCostLinesBackfill(
      new Request("https://example.invalid", {
        method,
        headers: { authorization: auth },
        ...(method === "POST"
          ? { body: JSON.stringify({ kind: "bills" }) }
          : {}),
      }),
      f.client,
      org,
      "test-only",
    );
    assertEquals(response.status, expected);
    if (expected !== 200) assertEquals(f.reads.length, 0);
  }
});

Deno.test("backfill: bounded pages and partial trade failure resume after the last committed invoice", async () => {
  const f = fake("trade");
  f.state.failOn = 2;
  assertEquals(await backfillCostLines(f.client, org, { kind: "trade" }), {
    kind: "trade",
    done: 1,
    next_after: "a",
    error: "busy",
  });
  f.state.failOn = 0;
  f.calls.length = 0;
  assertEquals(
    await backfillCostLines(f.client, org, { kind: "trade", after: "a" }),
    {
      kind: "trade",
      done: 1,
      next_after: "b",
    },
  );
  assertEquals(f.calls.map((c) => c.args), [{ p_trade_invoice_id: "b" }]);
  const c = fake("credits");
  c.rows.xero_supplier_credit_notes = Array.from(
    { length: 401 },
    (_, i) => ({ xero_credit_note_id: String(i).padStart(4, "0") }),
  );
  assertEquals(
    await backfillCostLines(c.client, org, { kind: "credits", pages: 2 }),
    {
      kind: "credits",
      done: 400,
      next_after: "0399",
    },
  );
  assertEquals(c.calls.map((call) => call.args.p_credit_note_ids.length), [
    200,
    200,
  ]);
  assertEquals(
    await backfillCostLines(c.client, org, { kind: "credits", after: "0399" }),
    {
      kind: "credits",
      done: 1,
      next_after: "0400",
    },
  );
});

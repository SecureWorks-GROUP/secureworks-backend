import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  backfillCostLines,
  handleCostLinesBackfill,
  MAX_TRADE_RPCS,
} from "./cost_lines_backfill.ts";

const org = "10000000-0000-4000-8000-000000000001";
function fake(kind = "bills") {
  const calls: { name: string; args: any }[] = [];
  const reads: any[] = [];
  const bill = (id: string) => ({
    org_id: org,
    xero_invoice_id: id,
    invoice_type: "ACCPAY",
    status: "AUTHORISED",
    line_items: [{ LineAmount: 1 }],
  });
  const rows: Record<string, any[]> = {
    xero_invoices: [bill("a"), bill("b"), bill("c")],
    trade_invoices: kind === "bills"
      ? [{ id: "m", org_id: org, xero_bill_id: "b" }]
      : [{ id: "a", org_id: org }, { id: "b", org_id: org }],
    xero_supplier_credit_notes: [{ org_id: org, xero_credit_note_id: "a" }, {
      org_id: org,
      xero_credit_note_id: "b",
    }],
  };
  const state = {
    enabled: true,
    fail: "",
    refused: false,
    missingFlag: false,
    failOn: 0,
    failReadOn: 0,
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
        in(k: string, v: unknown[]) {
          filters.push(["in", k, v]);
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
          if (
            state.fail === table && (!state.failReadOn ||
              reads.filter((r) => r.table === table).length ===
                state.failReadOn)
          ) {
            return Promise.resolve({
              data: null,
              error: { message: "read failed" },
            }).then(resolve, reject);
          }
          if (table === "feature_flags") {
            const flags = state.missingFlag ? [] : [
              { flag_name: "job_cost_lines_sync_v1", enabled: state.enabled },
              { flag_name: "job_cost_employer_super_v1", enabled: false },
            ];
            return Promise.resolve({
              data: flags.find((r) => matches(r, filters)) ?? null,
              error: null,
            }).then(resolve, reject);
          }
          let data = rows[table].filter((r) => matches(r, filters));
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
function matches(row: any, filters: any[]) {
  return filters.every(([op, k, v]) => {
    if (op === "eq") return row[k] === v;
    if (op === "gt") return row[k] > v;
    if (op === "in") return v.includes(row[k]);
    throw new Error(`Unsupported filter ${op}`);
  });
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
    (_, i) => ({
      org_id: org,
      xero_credit_note_id: String(i).padStart(4, "0"),
    }),
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

Deno.test("backfill: org and ACCPAY filters bound both the source page and mirror lookup", async () => {
  const f = fake();
  const otherOrg = "10000000-0000-4000-8000-000000000002";
  f.rows.xero_invoices.push(
    {
      ...f.rows.xero_invoices[0],
      org_id: otherOrg,
      xero_invoice_id: "foreign",
    },
    {
      ...f.rows.xero_invoices[0],
      invoice_type: "ACCREC",
      xero_invoice_id: "sales",
    },
  );
  // Another org's mirror must not suppress this org's bill.
  f.rows.trade_invoices.push({
    org_id: otherOrg,
    id: "foreign",
    xero_bill_id: "a",
  });
  assertEquals(await backfillCostLines(f.client, org, { kind: "bills" }), {
    kind: "bills",
    done: 3,
    next_after: "c",
  });
  assertEquals(f.calls[0].args.p_docs.map((d: any) => d.document_id), [
    "a",
    "c",
  ]);
  assertEquals(f.reads.find((r) => r.table === "xero_invoices").filters, [
    ["eq", "org_id", org],
    ["eq", "invoice_type", "ACCPAY"],
  ]);
  assertEquals(
    f.reads.filter((r) => r.table === "trade_invoices").map((r) => r.filters),
    [
      [["eq", "org_id", org], ["in", "xero_bill_id", ["a", "b", "c"]]],
    ],
  );
  for (const kind of ["credits", "trade"] as const) {
    const c = fake(kind);
    const table = kind === "credits"
      ? "xero_supplier_credit_notes"
      : "trade_invoices";
    const key = kind === "credits" ? "xero_credit_note_id" : "id";
    c.rows[table].push({ org_id: otherOrg, [key]: "foreign" });
    assertEquals(await backfillCostLines(c.client, org, { kind }), {
      kind,
      done: 2,
      next_after: "b",
    });
  }
});

Deno.test("backfill: ten bills pages make ten page-scoped mirror reads, never an estate scan", async () => {
  const f = fake();
  f.rows.xero_invoices = Array.from({ length: 2000 }, (_, i) => ({
    ...f.rows.xero_invoices[0],
    xero_invoice_id: String(i).padStart(4, "0"),
  }));
  f.rows.trade_invoices = Array.from({ length: 4000 }, (_, i) => ({
    id: String(i),
    org_id: org,
    xero_bill_id: `unrelated-${i}`,
  }));
  f.rows.trade_invoices.push({
    id: "match",
    org_id: org,
    xero_bill_id: "1999",
  });
  assertEquals(
    await backfillCostLines(f.client, org, { kind: "bills", pages: 10 }),
    {
      kind: "bills",
      done: 2000,
      next_after: "1999",
    },
  );
  const mirrors = f.reads.filter((r) => r.table === "trade_invoices");
  assertEquals(mirrors.length, 10);
  for (const [page, read] of mirrors.entries()) {
    assertEquals(read.filters, [
      ["eq", "org_id", org],
      [
        "in",
        "xero_bill_id",
        f.rows.xero_invoices.slice(page * 200, (page + 1) * 200).map((r) =>
          r.xero_invoice_id
        ),
      ],
    ]);
  }
  assertEquals(f.calls.length, 10);
  assertEquals(f.calls[9].args.p_docs.length, 199);
});

Deno.test("backfill: second mirror read failure preserves only the completed page and resumes it", async () => {
  const f = fake();
  f.rows.xero_invoices = Array.from({ length: 201 }, (_, i) => ({
    ...f.rows.xero_invoices[0],
    xero_invoice_id: String(i).padStart(4, "0"),
  }));
  f.state.fail = "trade_invoices";
  f.state.failReadOn = 2;
  assertEquals(
    await backfillCostLines(f.client, org, { kind: "bills", pages: 10 }),
    {
      kind: "bills",
      done: 200,
      next_after: "0199",
      error: "read failed",
    },
  );
  assertEquals(f.calls.length, 1);
  f.state.fail = "";
  assertEquals(
    await backfillCostLines(f.client, org, { kind: "bills", after: "0199" }),
    {
      kind: "bills",
      done: 1,
      next_after: "0200",
    },
  );
  assertEquals(f.calls[1].args.p_docs.map((d: any) => d.document_id), ["0200"]);
});

Deno.test("backfill: truncated mirror results refuse without writing or advancing the cursor", async () => {
  const f = fake();
  f.rows.trade_invoices = Array.from({ length: 1001 }, (_, i) => ({
    org_id: org,
    id: String(i),
    xero_bill_id: "b",
  }));
  assertEquals(
    await backfillCostLines(f.client, org, { kind: "bills", after: "a" }),
    {
      kind: "bills",
      done: 0,
      next_after: "a",
      error: "Mirror page limit reached",
    },
  );
  assertEquals(f.calls.length, 0);
});

Deno.test("backfill: trade RPC budget applies across ten requested pages and the next request resumes", async () => {
  const f = fake("trade");
  f.rows.trade_invoices = Array.from({ length: 2000 }, (_, i) => ({
    org_id: org,
    id: String(i).padStart(4, "0"),
  }));
  assertEquals(MAX_TRADE_RPCS, 20);
  assertEquals(
    await backfillCostLines(f.client, org, { kind: "trade", pages: 10 }),
    {
      kind: "trade",
      done: 20,
      next_after: "0019",
    },
  );
  assertEquals(f.calls.length, 20);
  assertEquals(f.reads.filter((r) => r.table === "trade_invoices").length, 1);
  f.calls.length = 0;
  assertEquals(
    await backfillCostLines(f.client, org, {
      kind: "trade",
      pages: 10,
      after: "0019",
    }),
    {
      kind: "trade",
      done: 20,
      next_after: "0039",
    },
  );
  assertEquals(f.calls.length, 20);
  assertEquals(f.calls[0].args, { p_trade_invoice_id: "0020" });
});

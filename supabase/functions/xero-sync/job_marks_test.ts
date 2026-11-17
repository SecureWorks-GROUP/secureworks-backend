import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { JobMarks } from "./job_marks.ts";
import { syncSettlementEvidence } from "./settlement_evidence.ts";
import { settlementFakeClient } from "../ops-api/xero_settlement_test_fake.ts";

Deno.test("job marks: one call per job, first source, no unlinked invoices", async () => {
  const marks = new JobMarks();
  marks.add("job-a", "xero_invoice");
  marks.add("job-a", "xero_payment");
  marks.add("job-b", "xero_invoice");
  marks.add(null, "xero_invoice");
  marks.add(undefined, "materials_fact");
  marks.add("", "materials_fact");
  const calls: unknown[] = [];
  assertEquals(
    await marks.flush({
      rpc: (_name, args) => {
        calls.push(args);
        return Promise.resolve({ error: null });
      },
    }),
    { marked: 2, skipped: null },
  );
  assertEquals(calls, [
    { p_job_id: "job-a", p_source: "xero_invoice" },
    { p_job_id: "job-b", p_source: "xero_invoice" },
  ]);
  assertEquals(
    await new JobMarks().flush({
      rpc: () => {
        throw new Error("unchanged materials must not mark");
      },
    }),
    { marked: 0, skipped: null },
  );
});

Deno.test("job marks: missing function stops, other failures continue sequentially", async () => {
  for (const missing of [true, false]) {
    const marks = new JobMarks();
    marks.add("job-a", "xero_payment");
    marks.add("job-b", "xero_payment");
    let calls = 0;
    let active = false;
    const result = await marks.flush({
      rpc: async () => {
        assertEquals(active, false);
        active = true;
        await Promise.resolve();
        active = false;
        calls++;
        return {
          error: calls === 1 ? { code: missing ? "PGRST202" : "XX000" } : null,
        };
      },
    });
    assertEquals(
      [result, calls],
      missing
        ? [{ marked: 0, skipped: "no_function" }, 1]
        : [{ marked: 1, skipped: null }, 2],
    );
  }
});

Deno.test("job marks: 501 jobs stops after the first 500", async () => {
  const marks = new JobMarks();
  for (let i = 0; i < 501; i++) marks.add(`job-${i}`, "xero_payment");
  let calls = 0;
  assertEquals(
    await marks.flush({
      rpc: () => {
        calls++;
        return Promise.resolve({ error: null });
      },
    }),
    { marked: 500, skipped: "over_500" },
  );
  assertEquals(calls, 500);
});

Deno.test("settlement marks: changed payments only, office links, batches and safe read failures", async () => {
  const org = "11111111-1111-4111-8111-111111111111";
  const tenant = "22222222-2222-4222-8222-222222222222";
  const invoice = (n: number) =>
    `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
  const payments = [1, 2, 3].map((n) => ({
    PaymentID: `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`,
    PaymentType: "ACCRECPAYMENT",
    Invoice: { InvoiceID: invoice(n), Type: "ACCREC" },
    Amount: 100,
    IsReconciled: false,
  }));
  const make = (enabled: boolean, failure?: string, writeFailure?: string) => {
    const tables: Record<string, Record<string, unknown>[]> = {
      feature_flags: [{ flag_name: "job_profit_refresh_v1", enabled }],
      xero_sync_state: [],
      xero_invoices: [1, 2, 3].map((n) => ({
        org_id: org,
        xero_invoice_id: invoice(n),
        job_id: n === 3 ? "job-b" : "job-a",
      })),
    };
    const { client } = settlementFakeClient(tables, {
      select: new Set(failure ? [failure] : []),
      upsert: new Set(writeFailure ? [writeFailure] : []),
    });
    const calls: { p_job_id: string; p_source: string }[] = [];
    client.rpc = (
      _name: string,
      args: { p_job_id: string; p_source: string },
    ) => {
      calls.push(args);
      return Promise.resolve({ error: null });
    };
    let batches: unknown[] = [];
    const gets: string[] = [];
    const run = (minute = 0) =>
      syncSettlementEvidence(client, org, tenant, (path) => {
        gets.push(path);
        return Promise.resolve(
          path === "/Payments"
            ? { Payments: payments }
            : { BatchPayments: batches },
        );
      }, () => new Date(Date.UTC(2026, 10, 18, 0, minute)));
    return {
      tables,
      calls,
      gets,
      run,
      batch: (value: unknown[]) => batches = value,
    };
  };
  const off = make(false);
  const offResult = await off.run();
  assertEquals(off.calls, []);
  assertEquals("job_marks" in offResult, false);
  const on = make(true);
  const { job_marks, ...onResult } = await on.run();
  assertEquals(job_marks, { marked: 2, skipped: null });
  assertEquals(onResult, offResult);
  assertEquals(on.gets, off.gets);
  assertEquals(
    on.tables.xero_settlement_evidence,
    off.tables.xero_settlement_evidence,
  );
  assertEquals(on.calls.map((c) => c.p_job_id), ["job-a", "job-b"]);
  on.calls.length = 0;
  assertEquals((await on.run(1)).job_marks, { marked: 0, skipped: null });
  assertEquals(on.calls, []);
  // Reconciliation has no new provider timestamp. Resolve the office's current
  // link rather than retaining a link captured by the earlier run.
  on.tables.xero_invoices[0].job_id = "job-office";
  payments[0].IsReconciled = true;
  assertEquals((await on.run(2)).job_marks, { marked: 1, skipped: null });
  assertEquals(on.calls, [{
    p_job_id: "job-office",
    p_source: "xero_payment",
  }]);
  on.calls.length = 0;
  on.batch([{
    BatchPaymentID: "77777777-7777-4777-8777-777777777777",
    Type: "RECBATCH",
    Payments: payments.slice(1),
  }]);
  assertEquals((await on.run(3)).job_marks, { marked: 2, skipped: null });
  assertEquals(on.calls.map((c) => c.p_job_id), ["job-a", "job-b"]);
  for (
    const [table, skipped] of [
      ["xero_settlement_evidence", "evidence_unreadable"],
      ["xero_invoices", "invoices_unreadable"],
      ["feature_flags", null],
    ] as const
  ) {
    const failed = make(true, table);
    const answer = await failed.run();
    assertEquals(failed.calls, []);
    assertEquals(failed.tables.xero_settlement_evidence.length, 3);
    assertEquals(failed.tables.xero_sync_state.length, 2);
    assertEquals(
      answer.job_marks,
      skipped ? { marked: 0, skipped } : undefined,
    );
  }
  const retry = make(true, undefined, "xero_sync_state");
  await assertRejects(
    () => retry.run(),
    Error,
    "Settlement cursor write failed",
  );
  assertEquals(retry.calls.map((c) => c.p_job_id), ["job-a", "job-b"]);
  await assertRejects(
    () => retry.run(1),
    Error,
    "Settlement cursor write failed",
  );
  assertEquals(retry.calls.length, 2);
});

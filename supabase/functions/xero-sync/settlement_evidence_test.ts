import {
  assertEquals,
  assertRejects,
  // deno-lint-ignore no-import-prefix
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { syncSettlementEvidence } from "./settlement_evidence.ts";
import { settlementFakeClient } from "../ops-api/xero_settlement_test_fake.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const KEY = `settlement_evidence:${ORG}:${TENANT}`;
const FULL = `settlement_evidence_full:${ORG}:${TENANT}`;
const NOW = new Date("2026-10-14T12:00:00.000Z");
const PAY = {
  PaymentID: "55555555-5555-4555-8555-555555555555",
  PaymentType: "ACCRECPAYMENT",
  Invoice: {
    InvoiceID: "33333333-3333-4333-8333-333333333333",
    Type: "ACCREC",
  },
  Amount: 100,
  IsReconciled: false,
  Status: "AUTHORISED",
};

type Call = { path: string; headers: Record<string, string> };
function provider(payments: unknown, batches: unknown = { BatchPayments: [] }) {
  const calls: Call[] = [];
  const get = (
    path: string,
    _p: Record<string, string>,
    headers: Record<string, string>,
  ) => {
    calls.push({ path, headers });
    return Promise.resolve(path === "/Payments" ? payments : batches);
  };
  return { calls, get };
}
const state = (rows: { key: string; cursor_at: string }[]) => ({
  xero_sync_state: rows as Record<string, unknown>[],
});
const cursor = (
  tables: { xero_sync_state?: Record<string, unknown>[] },
  key: string,
) => tables.xero_sync_state?.find((r) => r.key === key)?.cursor_at;

Deno.test("settlement sync: first run reads everything and records both cursors", async () => {
  const tables = state([]);
  const { client } = settlementFakeClient(tables);
  const p = provider({ Payments: [PAY] });
  const result = await syncSettlementEvidence(
    client,
    ORG,
    TENANT,
    p.get,
    () => NOW,
  );
  assertEquals(p.calls.map((c) => c.headers), [{}, {}]);
  assertEquals(
    [result.full_reread, cursor(tables, KEY), cursor(tables, FULL)],
    [true, NOW.toISOString(), NOW.toISOString()],
  );
});

Deno.test("settlement sync: within a day of a full read only modified records are asked for", async () => {
  const tables = state([
    { key: KEY, cursor_at: "2026-10-14T11:00:00.000Z" },
    { key: FULL, cursor_at: "2026-10-14T01:00:00.000Z" },
  ]);
  const { client } = settlementFakeClient(tables);
  const p = provider({ Payments: [PAY] });
  const result = await syncSettlementEvidence(
    client,
    ORG,
    TENANT,
    p.get,
    () => NOW,
  );
  assertEquals(p.calls[0].headers, {
    "If-Modified-Since": "2026-10-14T10:45:00.000Z",
  });
  assertEquals([result.full_reread, cursor(tables, FULL)], [
    false,
    "2026-10-14T01:00:00.000Z",
  ]);
});

Deno.test("settlement sync: a day after the last full read, a payment reconciled without a timestamp change is re-observed", async () => {
  const tables = {
    ...state([
      { key: KEY, cursor_at: "2026-10-14T11:00:00.000Z" },
      { key: FULL, cursor_at: "2026-10-13T11:59:00.000Z" },
    ]),
    xero_settlement_evidence: [] as Record<string, unknown>[],
  };
  const { client } = settlementFakeClient(tables);
  const p = provider({ Payments: [{ ...PAY, IsReconciled: true }] });
  await syncSettlementEvidence(client, ORG, TENANT, p.get, () => NOW);
  assertEquals(p.calls.map((c) => c.headers), [{}, {}]);
  assertEquals(tables.xero_settlement_evidence[0].is_reconciled, true);
  assertEquals(cursor(tables, FULL), NOW.toISOString());
});

Deno.test("settlement sync: a malformed collection writes nothing and keeps the cursor", async () => {
  const tables = state([{ key: KEY, cursor_at: "2026-10-14T11:00:00.000Z" }]);
  const { client, upserts } = settlementFakeClient(tables);
  const p = provider({ Payments: [PAY] }, { BatchPayments: "nope" });
  await assertRejects(() =>
    syncSettlementEvidence(client, ORG, TENANT, p.get, () => NOW)
  );
  assertEquals([upserts.length, cursor(tables, KEY)], [
    0,
    "2026-10-14T11:00:00.000Z",
  ]);
});

Deno.test("settlement sync: a failed evidence write keeps the cursor", async () => {
  const tables = state([{ key: KEY, cursor_at: "2026-10-14T11:00:00.000Z" }]);
  const { client } = settlementFakeClient(tables, {
    upsert: new Set(["xero_settlement_evidence"]),
  });
  const p = provider({ Payments: [PAY] });
  await assertRejects(
    () => syncSettlementEvidence(client, ORG, TENANT, p.get, () => NOW),
    Error,
    "Settlement evidence write failed",
  );
  assertEquals([cursor(tables, KEY), cursor(tables, FULL)], [
    "2026-10-14T11:00:00.000Z",
    undefined,
  ]);
});

// deno-lint-ignore-file no-import-prefix require-await

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createTradeInvoiceBeforeExternalWrite,
  replaceTradeInvoiceDraftKeepingPrior,
  replaceTradeInvoicePriorDraft,
  tradeInvoiceHasExternalXeroIdentity,
  tradeInvoiceXeroIdempotencyKey,
} from "./trade_invoice_persistence.ts";

Deno.test("trade invoice Xero idempotency key is reconstructable from the persisted invoice ID", () => {
  assertEquals(
    tradeInvoiceXeroIdempotencyKey("invoice-123"),
    "trade-inv-invoice-123",
  );
  assertEquals(
    tradeInvoiceXeroIdempotencyKey(" invoice-123 "),
    "trade-inv-invoice-123",
  );
});

Deno.test("any persisted Xero identity fences destructive invoice actions", () => {
  assertEquals(tradeInvoiceHasExternalXeroIdentity({}), false);
  assertEquals(
    tradeInvoiceHasExternalXeroIdentity({ xero_bill_id: "bill-1" }),
    true,
  );
  assertEquals(
    tradeInvoiceHasExternalXeroIdentity({
      xero_bill_id: null,
      xero_pushed_at: "2026-08-27T12:00:00Z",
    }),
    true,
  );
});

Deno.test("prior draft replacement delegates lock transfer and delete to one RPC", async () => {
  const calls: unknown[] = [];
  await replaceTradeInvoicePriorDraft(
    {
      rpc: async (name, args) => {
        calls.push({ name, args });
        return { data: "replacement", error: null };
      },
    },
    "prior",
    "replacement",
    "trade-user",
    ["asn-1", "asn-1", "asn-2"],
  );

  assertEquals(calls, [{
    name: "replace_trade_invoice_draft_v1",
    args: {
      p_prior_draft_id: "prior",
      p_replacement_id: "replacement",
      p_user_id: "trade-user",
      p_assignment_ids: ["asn-1", "asn-2"],
    },
  }]);
});

Deno.test("prior draft replacement refuses an unconfirmed RPC result", async () => {
  await assertRejects(
    () =>
      replaceTradeInvoicePriorDraft(
        {
          rpc: async () => ({ data: null, error: null }),
        },
        "prior",
        "replacement",
        "trade-user",
        [],
      ),
    Error,
    "replacement identity was not confirmed",
  );
});

Deno.test("trade invoice persistence refuses before external work when line tracking fails", async () => {
  const calls: string[] = [];
  let externalWrites = 0;

  await assertRejects(
    () =>
      createTradeInvoiceBeforeExternalWrite({
        createInvoice: async () => {
          calls.push("create:new");
          return "new";
        },
        insertLines: async () => {
          calls.push("lines:new");
          throw new Error("line insert refused");
        },
        deleteInvoice: async (id) => {
          calls.push(`delete:${id}`);
        },
      }).then(() => {
        externalWrites++;
        return "unreachable";
      }),
    Error,
    "line insert refused",
  );

  assertEquals(calls, ["create:new", "lines:new", "delete:new"]);
  assertEquals(externalWrites, 0);
});

Deno.test("draft replacement keeps the prior draft when replacement lines fail", async () => {
  const deleted: string[] = [];

  await assertRejects(
    () =>
      replaceTradeInvoiceDraftKeepingPrior({
        createInvoice: async () => "replacement",
        insertLines: async () => {
          throw new Error("replacement lines failed");
        },
        deleteInvoice: async (id) => {
          deleted.push(id);
        },
        replacePriorDraft: async (id) => {
          deleted.push(id);
        },
      }, "prior"),
    Error,
    "replacement lines failed",
  );

  assertEquals(deleted, ["replacement"]);
});

Deno.test("draft replacement deletes the prior draft only after the replacement is complete", async () => {
  const calls: string[] = [];
  const id = await replaceTradeInvoiceDraftKeepingPrior({
    createInvoice: async () => {
      calls.push("create:replacement");
      return "replacement";
    },
    insertLines: async (invoiceId) => {
      calls.push(`lines:${invoiceId}`);
    },
    deleteInvoice: async (invoiceId) => {
      calls.push(`delete:${invoiceId}`);
    },
    replacePriorDraft: async (invoiceId, replacementId) => {
      calls.push(`replace:${invoiceId}->${replacementId}`);
    },
  }, "prior");

  assertEquals(id, "replacement");
  assertEquals(calls, [
    "create:replacement",
    "lines:replacement",
    "replace:prior->replacement",
  ]);
});

Deno.test("draft replacement cleanup never re-enters the guarded replacement boundary", async () => {
  const calls: string[] = [];
  await assertRejects(
    () =>
      replaceTradeInvoiceDraftKeepingPrior({
        createInvoice: async () => "replacement",
        insertLines: async () => {},
        deleteInvoice: async (invoiceId) => {
          calls.push(`cleanup:${invoiceId}`);
        },
        replacePriorDraft: async (invoiceId, replacementId) => {
          calls.push(`guarded:${invoiceId}->${replacementId}`);
          throw new Error("prior changed");
        },
      }, "prior"),
    Error,
    "prior changed",
  );
  assertEquals(calls, [
    "guarded:prior->replacement",
    "cleanup:replacement",
  ]);
});

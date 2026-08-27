// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createTradeInvoiceBeforeExternalWrite,
  replaceTradeInvoiceDraftKeepingPrior,
} from "./trade_invoice_persistence.ts";

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
  }, "prior");

  assertEquals(id, "replacement");
  assertEquals(calls, [
    "create:replacement",
    "lines:replacement",
    "delete:prior",
  ]);
});

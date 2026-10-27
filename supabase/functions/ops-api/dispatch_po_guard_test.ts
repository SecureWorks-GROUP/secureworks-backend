// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch orders never go to Xero or out by the old order email paths
// (_shared/dispatch_po_guard.ts). ops-api push_po_to_xero and email_po refuse
// a Dispatch order with 409 `dispatch_po_refused` before any other read.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _emailPOForTest, _pushPOToXeroForTest, ApiError } from "./index.ts";
import {
  DISPATCH_PO_REFUSED_CODE,
  dispatchPoRefusal,
  isDispatchPurchaseOrder,
} from "../_shared/dispatch_po_guard.ts";

// A client that returns one purchase order and refuses every other table, so
// a test fails loudly if the function reads a job, a supplier or the Xero
// token before refusing.
function poClient(po: Record<string, unknown> | null) {
  const tables: string[] = [];
  const selects: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      if (table !== "purchase_orders") {
        throw new Error(`unexpected read of ${table}`);
      }
      const builder: any = {
        select: (columns: string) => {
          selects.push(columns);
          return builder;
        },
        eq: () => builder,
        single: () =>
          Promise.resolve(
            po ? { data: po, error: null } : { data: null, error: { message: "no rows" } },
          ),
        maybeSingle: () => Promise.resolve({ data: po, error: null }),
      };
      return builder;
    },
  };
  return { client, tables, selects };
}

const DISPATCH_PO = {
  id: "po-1",
  po_number: "PO-2001",
  job_id: "job-1",
  supplier_name: "Stratco",
  source: "dispatch",
  xero_po_id: null,
  total: 100,
};

Deno.test("guard: only source 'dispatch' is a Dispatch order", () => {
  assert(isDispatchPurchaseOrder({ source: "dispatch" }));
  assert(isDispatchPurchaseOrder({ source: " Dispatch " }));
  assert(!isDispatchPurchaseOrder({ source: null }));
  assert(!isDispatchPurchaseOrder({ source: "quote_builder" }));
  assert(!isDispatchPurchaseOrder({}));
  assert(!isDispatchPurchaseOrder(null));
});

Deno.test("guard: the refusal is a plain 409 with no em dash", () => {
  const refusal = dispatchPoRefusal("push_po_to_xero", DISPATCH_PO);
  assertEquals(refusal.status, 409);
  assertEquals(refusal.body.code, DISPATCH_PO_REFUSED_CODE);
  assertEquals(refusal.body.po_id, "po-1");
  assert(refusal.message.startsWith("PO-2001 was made in the Dispatch tab"));
  assert(!refusal.message.includes("—"));
  assert(dispatchPoRefusal("email_po", {}).message.startsWith("This order"));
});

Deno.test("push_po_to_xero: a Dispatch order is refused before any job, supplier or Xero read", async () => {
  const { client, tables } = poClient(DISPATCH_PO);
  const error = await assertRejects(
    () => _pushPOToXeroForTest(client, { id: "po-1" }),
    ApiError,
  ) as ApiError;
  assertEquals(error.status, 409);
  assertEquals((error.body as any).code, DISPATCH_PO_REFUSED_CODE);
  assertEquals((error.body as any).action, "push_po_to_xero");
  assertEquals(tables, ["purchase_orders"]);
});

Deno.test("push_po_to_xero: a Dispatch order already holding a Xero id is still refused as Dispatch", async () => {
  const { client } = poClient({ ...DISPATCH_PO, xero_po_id: "x-1" });
  const error = await assertRejects(
    () => _pushPOToXeroForTest(client, { id: "po-1" }),
    ApiError,
  ) as ApiError;
  assertEquals((error.body as any).code, DISPATCH_PO_REFUSED_CODE);
});

Deno.test("push_po_to_xero: any other order passes the guard (it stops later, at the already-synced check)", async () => {
  const { client } = poClient({ ...DISPATCH_PO, source: null, xero_po_id: "x-1" });
  await assertRejects(
    () => _pushPOToXeroForTest(client, { id: "po-1" }),
    Error,
    "PO already synced to Xero",
  );
});

Deno.test("email_po: a Dispatch order is refused before the Xero token, and the read asks for source", async () => {
  const { client, tables, selects } = poClient({ ...DISPATCH_PO, xero_po_id: "x-1" });
  const error = await assertRejects(
    () => _emailPOForTest(client, { id: "po-1" }),
    ApiError,
  ) as ApiError;
  assertEquals(error.status, 409);
  assertEquals((error.body as any).code, DISPATCH_PO_REFUSED_CODE);
  assertEquals((error.body as any).action, "email_po");
  assertEquals(tables, ["purchase_orders"]);
  assert(selects[0].split(",").map((c) => c.trim()).includes("source"));
});

Deno.test("email_po: any other order passes the guard (it stops later, at the not-synced check)", async () => {
  const { client } = poClient({ ...DISPATCH_PO, source: null, xero_po_id: null });
  await assertRejects(
    () => _emailPOForTest(client, { id: "po-1" }),
    Error,
    "PO has not been synced to Xero yet",
  );
});

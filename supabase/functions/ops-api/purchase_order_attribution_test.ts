// deno-lint-ignore-file no-import-prefix no-explicit-any
// The two fixes Dispatch slice 5 makes to existing purchase order paths
// (docs/dispatch-slice-5-contract.md).
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  purchaseOrderCreatedBy,
  supplierReplyMayMoveOrder,
} from "./purchase_order_attribution.ts";

const USER = "d1000000-0000-4000-8000-000000000001";

Deno.test("create_po: a signed-in user's id goes in created_by and the email in created_by_email", () => {
  assertEquals(
    purchaseOrderCreatedBy(USER, { operator_email: "shaun@example.com" }),
    { created_by: USER, created_by_email: "shaun@example.com" },
  );
});

Deno.test("create_po: an email is never written into the uuid column", () => {
  for (
    const [userId, body] of [
      [null, { operator_email: "shaun@example.com" }],
      [undefined, { user_email: "agent@example.com" }],
      ["shaun@example.com", { operator_email: "shaun@example.com" }],
      [null, {}],
      [null, null],
    ] as const
  ) {
    const out = purchaseOrderCreatedBy(userId as any, body as any);
    assert(out.created_by === null, `created_by for ${String(userId)}`);
  }
  assertEquals(purchaseOrderCreatedBy(null, {}).created_by_email, null);
  assertEquals(
    purchaseOrderCreatedBy(null, { user_email: "agent@example.com" })
      .created_by_email,
    "agent@example.com",
  );
});

Deno.test("supplier reply: a Dispatch order is never moved by a reply; any other order is, as before", () => {
  assertEquals(supplierReplyMayMoveOrder({ source: "dispatch" }), false);
  assertEquals(supplierReplyMayMoveOrder({ source: null }), true);
  assertEquals(supplierReplyMayMoveOrder({}), true);
  assertEquals(supplierReplyMayMoveOrder(null), true);
});

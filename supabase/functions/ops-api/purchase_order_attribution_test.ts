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

// The two rules are wired where they matter, read from the source itself.
const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
function body(name: string): string {
  const start = INDEX.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} not found`);
  const next = INDEX.indexOf("\nasync function ", start + 1);
  return INDEX.slice(start, next < 0 ? undefined : next);
}

Deno.test("wiring: createPO takes the session user and never writes an email into created_by", () => {
  const src = body("createPO");
  assert(src.includes("...purchaseOrderCreatedBy(sessionUserId, body)"));
  assert(!/created_by:\s*body\./.test(src));
  assert(
    INDEX.includes(
      "createPO(client, body, authMode === 'jwt' ? authUser?.id || null : null)",
    ),
  );
});

Deno.test("wiring: every purchase_orders write in analyseSupplierQuote is behind the Dispatch guard", () => {
  const src = body("analyseSupplierQuote");
  assert(
    src.includes("const replyMayMoveOrder = supplierReplyMayMoveOrder(po)"),
  );
  assert(
    src.includes(
      "'id, po_number, supplier_name, job_id, line_items, total, reference, status, source'",
    ),
  );
  // Each update of the order: status (high confidence), the date (low
  // confidence), the date (not a confirmation), invoice received.
  const updates = [
    ...src.matchAll(/client\.from\('purchase_orders'\)\s*\.update\(/g),
  ].map((m) => m.index!);
  assertEquals(updates.length, 4);
  for (const at of updates) {
    const before = src.slice(Math.max(0, at - 400), at);
    assert(before.includes("replyMayMoveOrder"), `unguarded update at ${at}`);
  }
});

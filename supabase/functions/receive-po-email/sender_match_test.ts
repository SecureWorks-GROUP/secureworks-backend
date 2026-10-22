// deno-lint-ignore-file no-import-prefix
// The untagged reply fallback: place by sender only when it is unambiguous.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideSenderMatch,
  ilikeLiteral,
  mergeOrders,
  suppliersForSender,
} from "./sender_match.ts";

const SUP = { id: "s1", name: "Steel Co", email: "Orders@SteelCo.example" };
const PO_A = { id: "p1", job_id: "j1", po_number: "PO-1000001" };
const PO_B = { id: "p2", job_id: "j2", po_number: "PO-1000002" };

Deno.test("sender: case and spaces do not stop a match", () => {
  assertEquals(
    suppliersForSender([SUP], "  orders@steelco.example ").map((s) => s.id),
    ["s1"],
  );
});

Deno.test("sender: one supplier with one open order is placed on that order", () => {
  const got = decideSenderMatch("orders@steelco.example", [SUP], [PO_A]);
  assertEquals(got.kind, "matched");
  if (got.kind === "matched") assertEquals(got.order.id, "p1");
});

Deno.test("sender: several open orders across jobs is never guessed (was: newest order)", () => {
  assertEquals(
    decideSenderMatch("orders@steelco.example", [SUP], [PO_A, PO_B]),
    { kind: "unplaced", reason: "several_open_orders" },
  );
});

Deno.test("sender: a shared address on two suppliers is unplaced, not silently dropped", () => {
  const twin = { id: "s2", name: "Steel Co West", email: "orders@steelco.example" };
  assertEquals(
    decideSenderMatch("orders@steelco.example", [SUP, twin], [PO_A]),
    { kind: "unplaced", reason: "several_suppliers" },
  );
});

Deno.test("sender: no supplier, no open order and no sender each say why", () => {
  assertEquals(decideSenderMatch("x@other.example", [SUP], [PO_A]), {
    kind: "unplaced",
    reason: "no_supplier",
  });
  assertEquals(decideSenderMatch("orders@steelco.example", [SUP], []), {
    kind: "unplaced",
    reason: "no_open_order",
  });
  assertEquals(decideSenderMatch("", [SUP], [PO_A]), {
    kind: "unplaced",
    reason: "no_sender",
  });
});

Deno.test("sender: an order read by id and by name counts once", () => {
  assertEquals(mergeOrders([PO_A], [PO_A]).length, 1);
  assertEquals(
    decideSenderMatch("orders@steelco.example", [SUP], mergeOrders([PO_A], [PO_A])).kind,
    "matched",
  );
});

Deno.test("sender: ilike wildcards in an address are escaped", () => {
  assertEquals(ilikeLiteral("a_b%c\\d@x.example"), "a\\_b\\%c\\\\d@x.example");
});

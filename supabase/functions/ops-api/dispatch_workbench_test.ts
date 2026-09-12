// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assessment,
  DispatchError,
  eligibility,
  emptyState,
  hash,
  reduceCommand,
} from "./dispatch_workbench.ts";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const apply = (s: unknown, c: string, p: unknown, source = "s1") =>
  reduceCommand(s, c, p, source, "operator", "2026-09-12T00:00:00Z");
const requirement = {
  id: id(1),
  description: "Roof sheets",
  quantity: 10,
  unit: "each",
  specification: "Profile as signed scope",
  destination: "site",
  phase: "roof",
};
Deno.test("group deletion preserves stable reviewed requirement and set identity", async () => {
  let s = await apply(emptyState(), "group_upsert", {
    id: id(2),
    name: "Roof",
    position: 0,
  });
  s = await apply(s, "requirement_upsert", { ...requirement, group_id: id(2) });
  s = await apply(s, "requirement_review", { id: id(1) });
  s = await apply(s, "set_review", {});
  s = await apply(s, "group_delete", { id: id(2) });
  assertEquals(s.requirements[0].id, id(1));
  assertEquals(s.requirements[0].group_id, null);
  assertEquals(s.reviewed_source_version, "s1");
  assert(
    assessment(s, "s2", "now").obligations.some((x: Record<string, unknown>) =>
      x.code === "complete_set_unreviewed"
    ),
  );
});
Deno.test("empty or incomplete kits cannot be reviewed", async () => {
  await assertRejects(
    () => apply(emptyState(), "set_review", {}),
    DispatchError,
  );
  const s = await apply(emptyState(), "requirement_upsert", {
    id: id(1),
    description: "Unknown scope",
  });
  await assertRejects(
    () => apply(s, "requirement_review", { id: id(1) }),
    DispatchError,
  );
});
Deno.test("notes require promotion and duplicate promotion is rejected", async () => {
  let s = await apply(emptyState(), "note_upsert", {
    id: id(2),
    text: "Check access",
  });
  assertEquals(s.requirements.length, 0);
  s = await apply(s, "note_promote", { id: id(2), requirement });
  assertEquals(s.requirements.length, 1);
  await assertRejects(
    () => apply(s, "note_promote", { id: id(2), requirement }),
    DispatchError,
  );
});
Deno.test("exact draft review binds content and source; editing removes approval", async () => {
  const d = {
    id: id(3),
    sender: "ops@example.com",
    to: ["supplier@example.com"],
    cc: [],
    subject: "Draft order",
    body: "Please review",
    attachments: [{
      id: "a",
      name: "Scope.pdf",
      source_ref: "job-doc:a",
      revision: "sha256:a",
    }],
  };
  let s = await apply(emptyState(), "draft_upsert", d);
  const original = s.drafts[0].content_hash;
  s = await apply(s, "draft_review", { id: id(3) });
  assertEquals(s.drafts[0].review.content_hash, original);
  await assertRejects(
    () => apply(s, "draft_review", { id: id(3) }, "s2"),
    DispatchError,
  );
  s = await apply(s, "draft_upsert", { ...d, body: "Changed quantity" });
  assert(s.drafts[0].content_hash !== original);
  assertEquals(s.drafts[0].review, undefined);
  await assertRejects(() => apply(s, "send", {}), DispatchError);
});
Deno.test("partial damaged yard receipt transfers once, replacement quantity stays accountable", async () => {
  let s = await apply(emptyState(), "requirement_upsert", requirement);
  s = await apply(s, "allocation_upsert", {
    id: id(2),
    requirement_id: id(1),
    supply_id: "po:a:0",
    quantity: 10,
  });
  s = await apply(s, "receipt_upsert", {
    id: id(3),
    allocation_id: id(2),
    usable_quantity: 8,
    damaged_quantity: 2,
    location: "yard",
    evidence: "Count and photo",
  });
  assert(
    assessment(s, "s1", "now").obligations.some((x: Record<string, unknown>) =>
      x.code === "supply_gap" && x.quantity === 2
    ),
  );
  s = await apply(s, "receipt_transfer", {
    id: id(3),
    location: "site",
    evidence: "Driver delivery photo",
  });
  assertEquals(s.receipts.length, 1);
  assertEquals(s.receipts[0].usable_quantity, 8);
  s = await apply(s, "allocation_upsert", {
    id: id(4),
    requirement_id: id(1),
    supply_id: "po:b:0",
    quantity: 2,
  });
  await assertRejects(
    () =>
      apply(s, "allocation_upsert", {
        id: id(5),
        requirement_id: id(1),
        supply_id: "po:c:0",
        quantity: 1,
      }),
    DispatchError,
  );
  await assertRejects(
    () => apply(s, "allocation_delete", { id: id(2) }),
    DispatchError,
  );
});
Deno.test("PO preparation is real draft input, unknown prices stay null and no duplicate requirement order", async () => {
  let s = await apply(emptyState(), "requirement_upsert", requirement);
  s = await apply(s, "requirement_review", { id: id(1) });
  const p = {
    id: id(2),
    supplier_name: "Fixture supplier",
    delivery_address: "Fixture site",
    requirement_ids: [id(1)],
    existing_supply_reviewed: true,
  };
  s = await apply(s, "order_prepare", p);
  assertEquals(s.order_drafts[0].line_items[0].unit_price, null);
  assertEquals(s.order_drafts[0].incomplete, true);
  await assertRejects(
    () => apply(s, "order_prepare", { ...p, id: id(3) }),
    DispatchError,
  );
});
Deno.test("acceptance never inferred from paid/stage alone; canonical hashes stable", async () => {
  assertEquals(
    eligibility({ status: "scheduled", deposit_at: "now" }).state,
    "unresolved",
  );
  assertEquals(
    eligibility({}, [{ id: "q", type: "quote", accepted_at: "now" }]).state,
    "accepted",
  );
  assertEquals(await hash({ a: 1, b: 2 }), await hash({ b: 2, a: 1 }));
});
Deno.test("partial supply orders only uncovered balance and supports two suppliers", async () => {
  let s = await apply(emptyState(), "requirement_upsert", requirement);
  s = await apply(s, "requirement_review", { id: id(1) });
  s = await apply(s, "allocation_upsert", {
    id: id(8),
    requirement_id: id(1),
    supply_id: "po:existing:0",
    quantity: 6,
  });
  const p = {
    id: id(2),
    supplier_name: "Supplier A",
    delivery_address: "Site",
    requirement_ids: [id(1)],
    existing_supply_reviewed: true,
    quantities: { [id(1)]: 2 },
  };
  s = await apply(s, "order_prepare", p);
  s = await apply(s, "order_prepare", {
    ...p,
    id: id(3),
    supplier_name: "Supplier B",
  });
  assertEquals(
    s.order_drafts.map((o: { line_items: { quantity: number }[] }) =>
      o.line_items[0].quantity
    ),
    [2, 2],
  );
  await assertRejects(
    () => apply(s, "order_prepare", { ...p, id: id(4) }),
    DispatchError,
  );
});
Deno.test("metadata and explicit scope reconciliation preserve receipts and expose surplus", async () => {
  let s = await apply(emptyState(), "requirement_upsert", requirement);
  s = await apply(s, "allocation_upsert", {
    id: id(8),
    requirement_id: id(1),
    supply_id: "po:existing:0",
    quantity: 10,
  });
  s = await apply(s, "receipt_upsert", {
    id: id(9),
    allocation_id: id(8),
    usable_quantity: 10,
    location: "yard",
    evidence: "Counted",
  });
  s = await apply(s, "requirement_upsert", {
    id: id(1),
    needed_by: "2026-10-01",
    owner: "Fixture operator",
  });
  assertEquals(s.receipts[0].usable_quantity, 10);
  assertEquals(s.requirements[0].owner, "Fixture operator");
  s = await apply(s, "requirement_reconcile", {
    id: id(1),
    quantity: 8,
    reason: "Signed scope reduction",
  });
  assert(
    assessment(s, "s1", "now").obligations.some((x: Record<string, unknown>) =>
      x.code === "supply_reconciliation"
    ),
  );
});
Deno.test("partial yard transfer conserves usable and damaged custody", async () => {
  let s = await apply(emptyState(), "requirement_upsert", requirement);
  s = await apply(s, "allocation_upsert", {
    id: id(8),
    requirement_id: id(1),
    supply_id: "po:a:0",
    quantity: 6,
  });
  s = await apply(s, "receipt_upsert", {
    id: id(9),
    allocation_id: id(8),
    usable_quantity: 4,
    damaged_quantity: 2,
    location: "yard",
    evidence: "Count",
  });
  s = await apply(s, "receipt_transfer", {
    id: id(9),
    new_id: id(10),
    quantity: 2,
    location: "site",
    evidence: "Partial delivery",
  });
  assertEquals(
    s.receipts.map((
      r: {
        usable_quantity: number;
        damaged_quantity: number;
        location: string;
      },
    ) => [r.usable_quantity, r.damaged_quantity, r.location]),
    [[2, 2, "yard"], [2, 0, "site"]],
  );
});

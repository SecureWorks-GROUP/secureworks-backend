// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch slice 6 (docs/dispatch-slice-6-contract.md): the delivery rules in
// dispatch_deliveries.ts. Fixtures are made up. Nothing here reads a database
// or sends.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchConfirmedState,
  dispatchDelivery,
  dispatchDeliveryListFields,
  dispatchDeliveryPersonIds,
  dispatchDeliveryRailLine,
  dispatchDeliveryRows,
  dispatchDeliverySummary,
  dispatchSightedOrderIds,
  isDispatchDeliveryCounted,
  isDispatchDeliveryDate,
  isDispatchOrderSighted,
} from "./dispatch_deliveries.ts";
import {
  dispatchMaterialCounts,
  dispatchMaterialDisplayStatus,
} from "./dispatch_materials.ts";

const STEEL = "b1000000-0000-4000-8000-000000000001";
const SHEETS = "b1000000-0000-4000-8000-000000000002";
const OTHER = "b1000000-0000-4000-8000-000000000003";
const PERSON = "d1000000-0000-4000-8000-000000000001";
const orderId = (n: number) =>
  `e1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function order(n: number, overrides: Record<string, any> = {}) {
  return {
    id: orderId(n),
    po_number: `PO-100000${n}`,
    supplier_id: STEEL,
    supplier_name: "Stored Steel",
    source: "dispatch",
    status: "draft",
    po_type: null,
    created_at: `2026-10-0${n}T00:00:00.000Z`,
    updated_at: "2026-10-14T00:00:00.000Z",
    delivery_date: null,
    confirmed_delivery_date: null,
    confirmed_delivery_set_at: null,
    confirmed_delivery_set_by: null,
    confirmed_delivery_set_by_email: null,
    delivery_sighted_at: null,
    delivery_sighted_by: null,
    delivery_sighted_by_email: null,
    xero_po_id: null,
    ...overrides,
  };
}

const names = new Map([[PERSON, "Office Person"]]);

Deno.test("date: a real calendar day, and 30 February is refused", () => {
  assert(isDispatchDeliveryDate("2026-10-18"));
  assert(isDispatchDeliveryDate("2024-02-29"));
  assert(!isDispatchDeliveryDate("2025-02-29"));
  assert(!isDispatchDeliveryDate("2026-02-30"));
  assert(!isDispatchDeliveryDate("2026-04-31"));
  assert(!isDispatchDeliveryDate("2026-1-1"));
  assert(!isDispatchDeliveryDate("2026-10-18T00:00:00Z"));
  assert(!isDispatchDeliveryDate(""));
  assert(!isDispatchDeliveryDate(null));
  assert(!isDispatchDeliveryDate(20261018));
});

Deno.test("counted: drafts and outside orders count; cancelled, deleted and non-material do not", () => {
  assert(isDispatchDeliveryCounted(order(1)));
  assert(
    isDispatchDeliveryCounted(order(1, { source: null, supplier_id: null })),
  );
  assert(isDispatchDeliveryCounted(order(1, { po_type: "material" })));
  assert(isDispatchDeliveryCounted(order(1, { status: "DRAFT" })));
  for (const status of ["cancelled", "Deleted"]) {
    assert(!isDispatchDeliveryCounted(order(1, { status })));
  }
  for (const po_type of ["labour", "subcontract"]) {
    assert(!isDispatchDeliveryCounted(order(1, { po_type })));
  }
});

Deno.test("expected date: shown as stored, and read-only once the order is in Xero", () => {
  const open = dispatchDelivery(order(1, { delivery_date: "2026-10-21" }));
  assertEquals(open.expected, "2026-10-21");
  assertEquals(open.expected_editable, true);

  const unset = dispatchDelivery(order(1));
  assertEquals(unset.expected, null);
  assertEquals(unset.expected_editable, true);

  const inXero = dispatchDelivery(order(1, {
    delivery_date: "2026-10-21",
    xero_po_id: "xero-po-1",
  }));
  assertEquals(inXero.expected, "2026-10-21");
  assertEquals(inXero.expected_editable, false);
});

Deno.test("confirmed date: a stored date, a status with no date, sighted with neither, or waiting", () => {
  assertEquals(
    dispatchConfirmedState(order(1, { confirmed_delivery_date: "2026-10-22" })),
    "date",
  );
  // A date wins over a confirming status.
  assertEquals(
    dispatchConfirmedState(order(1, {
      status: "billed",
      confirmed_delivery_date: "2026-10-22",
    })),
    "date",
  );
  for (const status of ["confirmed", "Delivered", "BILLED"]) {
    assertEquals(
      dispatchConfirmedState(order(1, { status })),
      "status_only",
      status,
    );
  }
  assertEquals(
    dispatchConfirmedState(order(1, {
      delivery_sighted_at: "2026-10-23T01:00:00.000Z",
    })),
    "not_confirmed",
  );
  assertEquals(
    dispatchConfirmedState(order(1, { status: "draft" })),
    "waiting",
  );
});

Deno.test("confirmed by hand only when a person set the date, name else email", () => {
  const byHand = dispatchDelivery(
    order(1, {
      confirmed_delivery_date: "2026-10-22",
      confirmed_delivery_set_at: "2026-10-18T02:00:00.000Z",
      confirmed_delivery_set_by: PERSON,
      confirmed_delivery_set_by_email: "office@example.test",
    }),
    names,
  );
  assertEquals(byHand.confirmed, {
    state: "date",
    date: "2026-10-22",
    set_by: "Office Person",
    set_at: "2026-10-18T02:00:00.000Z",
    by_hand: true,
  });
  assertEquals(byHand.step, 2);

  const emailOnly = dispatchDelivery(order(1, {
    confirmed_delivery_date: "2026-10-22",
    confirmed_delivery_set_at: "2026-10-18T02:00:00.000Z",
    confirmed_delivery_set_by: "missing-person",
    confirmed_delivery_set_by_email: "office@example.test",
  }));
  assertEquals(emailOnly.confirmed.set_by, "office@example.test");

  // A date the reply reader wrote has no hand stamp, so nobody is named.
  const machine = dispatchDelivery(order(1, {
    confirmed_delivery_date: "2026-10-22",
    confirmed_delivery_set_by_email: "office@example.test",
  }));
  assertEquals(machine.confirmed.by_hand, false);
  assertEquals(machine.confirmed.set_by, null);
  assertEquals(machine.confirmed.set_at, null);
  assertEquals(machine.step, 2);
});

Deno.test("sighted: step 3, the sighter's name, and a line on that order is Delivered", () => {
  const sighted = dispatchDelivery(
    order(1, {
      confirmed_delivery_date: "2026-10-22",
      delivery_sighted_at: "2026-10-23T01:00:00.000Z",
      delivery_sighted_by: PERSON,
      delivery_sighted_by_email: "office@example.test",
    }),
    names,
  );
  assertEquals(sighted.sighted, {
    at: "2026-10-23T01:00:00.000Z",
    by: "Office Person",
  });
  assertEquals(sighted.step, 3);
  assert(isDispatchOrderSighted(order(1, {
    delivery_sighted_at: "2026-10-23T01:00:00.000Z",
  })));

  const email = dispatchDelivery(order(1, {
    delivery_sighted_at: "2026-10-23T01:00:00.000Z",
    delivery_sighted_by_email: "office@example.test",
  }));
  assertEquals(email.sighted?.by, "office@example.test");
  // Sighted with no confirmation is still step 3, and the confirmed cell says so.
  assertEquals(email.confirmed.state, "not_confirmed");
  assertEquals(email.step, 3);

  const waiting = dispatchDelivery(order(1));
  assertEquals(waiting.sighted, null);
  assertEquals(waiting.step, 1);

  const ids = dispatchSightedOrderIds([
    order(1, { delivery_sighted_at: "2026-10-23T01:00:00.000Z" }),
    order(2),
  ]);
  const line = { status: "to_order", purchase_order_id: orderId(1) };
  assertEquals(dispatchMaterialDisplayStatus(line, ids), "delivered");
  assertEquals(dispatchMaterialDisplayStatus(line), "on_po");
  assertEquals(
    dispatchMaterialCounts([
      line,
      { status: "to_order", purchase_order_id: orderId(2) },
      { status: "in_stock" },
    ], ids),
    { total: 3, ready: 2 },
  );
});

Deno.test("summary: all sighted needs one counted order and every one sighted", () => {
  const sighted = order(1, { delivery_sighted_at: "2026-10-23T01:00:00.000Z" });
  assertEquals(dispatchDeliverySummary([]), {
    counted: 0,
    sighted: 0,
    all_sighted: false,
  });
  assertEquals(dispatchDeliverySummary([order(1, { status: "cancelled" })]), {
    counted: 0,
    sighted: 0,
    all_sighted: false,
  });
  assertEquals(dispatchDeliverySummary([sighted, order(2)]), {
    counted: 2,
    sighted: 1,
    all_sighted: false,
  });
  // A cancelled order and a labour order do not keep the job from all-sighted.
  assertEquals(
    dispatchDeliverySummary([
      sighted,
      order(2, { status: "deleted", delivery_sighted_at: null }),
      order(3, { po_type: "labour" }),
    ]),
    { counted: 1, sighted: 1, all_sighted: true },
  );
  assertEquals(dispatchDeliveryListFields([sighted, order(2)]), {
    deliveries_orders_total: 2,
    deliveries_orders_sighted: 1,
  });
});

Deno.test("rows: chosen suppliers first, their Dispatch orders oldest, else not ordered; the rest follow", () => {
  const sameInstant = "2026-10-01T00:00:00.000Z";
  const rows = dispatchDeliveryRows(
    [
      { supplier_id: STEEL, name: "Example Steel" },
      { supplier_id: "", name: "Skipped" },
      { supplier_id: SHEETS, name: "Example Sheets" },
    ],
    [
      order(2, { created_at: "2026-10-02T00:00:00.000Z" }),
      order(1, { created_at: sameInstant }),
      order(3, {
        created_at: sameInstant,
        source: "manual",
        supplier_name: "Outside name",
      }),
      order(4, { supplier_id: OTHER, created_at: "2026-10-03T00:00:00.000Z" }),
      order(5, { status: "cancelled" }),
      order(6, { po_type: "labour" }),
      // Same instant as order 1: the smaller id is first.
      order(8, { created_at: sameInstant }),
      order(7, { created_at: sameInstant }),
    ],
    names,
  );

  assertEquals(
    rows.map((row) =>
      row.kind === "not_ordered"
        ? `not_ordered:${row.supplier_name}`
        : `${row.po_number}:${row.supplier_name}:${row.made_in_dispatch}`
    ),
    [
      "PO-1000001:Example Steel:true",
      "PO-1000007:Example Steel:true",
      "PO-1000008:Example Steel:true",
      "PO-1000002:Example Steel:true",
      "not_ordered:Example Sheets",
      // An outside order is never filed under the chosen supplier.
      "PO-1000003:Outside name:false",
      "PO-1000004:Stored Steel:true",
    ],
  );
  const outside = rows.find((row) =>
    row.kind === "order" && row.po_number === "PO-1000003"
  );
  assert(outside && outside.kind === "order");
  assertEquals(outside.made_in_dispatch, false);
  assertEquals(outside.in_xero, false);
});

Deno.test("rail line: the sighted count, and the all-sighted wording depends on the stop", () => {
  assertEquals(dispatchDeliveryRailLine(null, 0, 4), null);
  assertEquals(dispatchDeliveryRailLine(0, 0, 6), null);
  assertEquals(
    dispatchDeliveryRailLine(3, 1, 4),
    "1 of 3 orders sighted on site.",
  );
  assertEquals(
    dispatchDeliveryRailLine(2, 2, 5),
    "Every order on this job is sighted on site.",
  );
  assertEquals(
    dispatchDeliveryRailLine(2, 2, 6),
    "Every order on this job is sighted on site.",
  );
  assertEquals(
    dispatchDeliveryRailLine(2, 2, 4),
    "Every order on this job is sighted on site. Press Materials on site to move the job.",
  );
  assertEquals(
    dispatchDeliveryRailLine(2, 2, null),
    "Every order on this job is sighted on site. Press Materials on site to move the job.",
  );
});

Deno.test("person ids: the setter and the sighter, once each", () => {
  assertEquals(
    dispatchDeliveryPersonIds([
      order(1, {
        confirmed_delivery_set_by: PERSON,
        delivery_sighted_by: PERSON,
      }),
      order(2, { delivery_sighted_by: "d1000000-0000-4000-8000-000000000002" }),
      order(3, { confirmed_delivery_set_by: "" }),
      order(4, { confirmed_delivery_set_by: 12 }),
    ]).sort(),
    [PERSON, "d1000000-0000-4000-8000-000000000002"].sort(),
  );
});

// deno-lint-ignore-file no-explicit-any no-import-prefix

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _calculateWorkOrderInvoiceTotals,
  _canSubmitWorkOrderInvoice,
  _selectWorkOrderNegativeCharges,
  handleTradeWorkOrdersAction,
  type TradeAuthContext,
  tradeWorkOrders,
} from "./index.ts";

const TENANT_A = "00000000-0000-0000-0000-000000000001";
const TENANT_B = "00000000-0000-0000-0000-000000000002";

const HENRY: TradeAuthContext = {
  id: "henry",
  email: "henry@example.com",
  orgId: TENANT_A,
  role: "lead_installer",
  managedVerticals: ["fencing"],
};

type CapturedQuery = {
  table: string;
  eq: Record<string, unknown>;
  notIn: string | null;
  inColumn: string | null;
  inValues: unknown[];
  referencedOr: string | null;
  range: [number, number] | null;
};

type Fixtures = {
  workOrders: any[];
  invoices?: any[];
  charges?: any[];
  profile?: any;
};

function parseNotIn(value: string): Set<string> {
  return new Set(
    [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );
}

function matchesVertical(job: any, clause: string): boolean {
  return clause.split(",").some((condition) => {
    const [column, operator, ...rest] = condition.split(".");
    const value = rest.join(".");
    const current = String(job?.[column] || "").toLowerCase();
    if (operator === "eq") return current === value.toLowerCase();
    if (operator === "ilike") {
      return current.startsWith(value.replace(/%$/, "").toLowerCase());
    }
    return false;
  });
}

function makeClient(
  fixtures: Fixtures,
  viewer: TradeAuthContext = HENRY,
): { client: any; captured: CapturedQuery[] } {
  const captured: CapturedQuery[] = [];
  const client: any = {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: { id: viewer.id, email: viewer.email } },
          error: null,
        }),
    },
    from(table: string) {
      if (table === "users") {
        let profileLookup = false;
        const userBuilder: any = {
          select: (columns: string) => {
            profileLookup = columns.includes("managed_verticals");
            return userBuilder;
          },
          eq: () => userBuilder,
          maybeSingle: () =>
            Promise.resolve({
              data: profileLookup
                ? fixtures.profile ?? {
                  org_id: viewer.orgId,
                  role: viewer.role,
                  managed_verticals: viewer.managedVerticals,
                }
                : null,
              error: null,
            }),
        };
        return userBuilder;
      }

      const state: CapturedQuery = {
        table,
        eq: {},
        notIn: null,
        inColumn: null,
        inValues: [],
        referencedOr: null,
        range: null,
      };
      captured.push(state);
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          state.eq[column] = value;
          return builder;
        },
        neq: () => builder,
        not: (_column: string, operator: string, value: string) => {
          if (operator === "in") state.notIn = value;
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          state.inColumn = column;
          state.inValues = values;
          return builder;
        },
        or: (
          clause: string,
          options?: { referencedTable?: string },
        ) => {
          if (options?.referencedTable === "jobs") {
            state.referencedOr = clause;
          }
          return builder;
        },
        order: () => builder,
        range: (from: number, to: number) => {
          state.range = [from, to];
          return builder;
        },
        then: (resolve: (result: unknown) => void) => {
          let rows: any[] = [];
          if (table === "work_orders") rows = fixtures.workOrders.slice();
          if (table === "trade_invoices") {
            rows = (fixtures.invoices || []).slice();
          }
          if (table === "trade_invoice_lines") {
            rows = (fixtures.charges || []).slice();
          }

          for (const [column, value] of Object.entries(state.eq)) {
            if (column === "jobs.org_id") {
              rows = rows.filter((row) => row.jobs?.org_id === value);
            } else if (column === "trade_invoices.org_id") {
              rows = rows.filter((row) => row.trade_invoices?.org_id === value);
            } else {
              rows = rows.filter((row) => row[column] === value);
            }
          }
          if (state.inColumn) {
            rows = rows.filter((row) =>
              state.inValues.includes(row[state.inColumn!])
            );
          }
          if (state.notIn) {
            const excluded = parseNotIn(state.notIn);
            rows = rows.filter((row) =>
              !excluded.has(String(row.status || ""))
            );
          }
          if (state.referencedOr) {
            rows = rows.filter((row) =>
              matchesVertical(row.jobs, state.referencedOr!)
            );
          }
          if (table === "work_orders") {
            rows.sort((a, b) =>
              String(b.created_at || "").localeCompare(
                String(a.created_at || ""),
              ) || String(a.id).localeCompare(String(b.id))
            );
          }
          const range = state.range || [0, 999];
          resolve({
            data: rows.slice(range[0], range[1] + 1),
            error: null,
          });
        },
      };
      return builder;
    },
  };
  return { client, captured };
}

function workOrder(
  id: string,
  {
    assigned = "crew",
    type = "fencing",
    orgId = TENANT_A,
    scheduledDate = null,
    createdAt = "2026-07-01T00:00:00Z",
  }: {
    assigned?: string;
    type?: string;
    orgId?: string;
    scheduledDate?: string | null;
    createdAt?: string;
  } = {},
): any {
  return {
    id,
    org_id: orgId,
    job_id: `job-${id}`,
    assigned_user_id: assigned,
    wo_number: `WO-${id}`,
    status: "complete",
    scope_items: [{ description: "Install", quantity: 2, unit_price: 500 }],
    site_address: `${id} Test Street`,
    scheduled_date: scheduledDate,
    created_at: createdAt,
    jobs: {
      id: `job-${id}`,
      org_id: orgId,
      job_number: `SW${type === "fencing" ? "F" : "P"}-${id}`,
      client_name: `Client ${id}`,
      type,
      status: "complete",
      site_address: `${id} Test Street`,
      site_suburb: "Perth",
    },
  };
}

Deno.test("work-order boundary refuses an unauthenticated request", async () => {
  const { client } = makeClient({ workOrders: [] });
  client.auth.getUser = () =>
    Promise.resolve({ data: { user: null }, error: { message: "no session" } });
  const error = await assertRejects(
    () =>
      handleTradeWorkOrdersAction(
        new Request(
          "https://example.test/functions/v1/ops-api?action=my_work_orders",
        ),
        client,
      ),
    Error,
    "Login required",
  );
  assertEquals((error as any).status, 401);
});

Deno.test("fencing manager can manually page the complete same-tenant fencing range", async () => {
  const count = 1002;
  const rows = Array.from(
    { length: count },
    (_, index) =>
      workOrder(String(index).padStart(4, "0"), {
        scheduledDate: index % 3 === 0
          ? "2024-01-08"
          : index % 3 === 1
          ? "2032-02-09"
          : null,
        createdAt: `2026-07-${
          String(1 + (index % 20)).padStart(2, "0")
        }T00:00:00Z`,
      }),
  );
  rows.push(workOrder("patio", { type: "patio" }));
  rows.push(workOrder("tenant-b", { orgId: TENANT_B }));
  const service = makeClient({ workOrders: rows });

  const fetchPage = async (offset: number) =>
    await tradeWorkOrders(
      service.client,
      new URLSearchParams({
        mode: "all",
        type: "fencing",
        // The selected Perth week is intentionally empty; the manual selector
        // remains the complete authorised work-order source.
        week_start: "2026-08-03",
        week_end: "2026-08-09",
        page_size: "500",
        offset: String(offset),
      }),
      HENRY,
      false,
    );
  const first = await fetchPage(0);
  const second = await fetchPage(500);
  const third = await fetchPage(1000);
  const all = [
    ...first.work_orders,
    ...second.work_orders,
    ...third.work_orders,
  ];

  assertEquals(first.mode, "all");
  assertEquals(first.type, "fencing");
  assertEquals(first.total, count);
  assertEquals(first.next_offset, 500);
  assertEquals(second.next_offset, 1000);
  assertEquals(third.next_offset, null);
  assertEquals(all.length, count);
  assertEquals(new Set(all.map((row: any) => row.id)).size, count);
  assertEquals(
    new Set(all.map((row: any) => row.scheduled_date)),
    new Set(["2024-01-08", "2032-02-09", null]),
  );
  assertEquals(all.every((row: any) => row.job_type === "fencing"), true);
  assertEquals(
    service.captured.some((query) =>
      query.table === "work_orders" &&
      query.range?.[0] === 1000
    ),
    true,
  );
});

Deno.test("ordinary installer requesting Everyone remains own-only", async () => {
  const ordinary = { ...HENRY, managedVerticals: [] };
  const rows = [
    workOrder("own", { assigned: ordinary.id }),
    workOrder("other", { assigned: "other-crew" }),
  ];
  const { client } = makeClient({ workOrders: rows }, ordinary);
  const result = await tradeWorkOrders(
    client,
    new URLSearchParams({ mode: "all" }),
    ordinary,
    false,
  );

  assertEquals(result.mode, "mine");
  assertEquals(result.work_orders.map((row: any) => row.id), ["own"]);
});

Deno.test("fencing manager is denied an unmanaged work-order vertical", async () => {
  const { client } = makeClient({ workOrders: [] });
  const error = await assertRejects(
    () =>
      tradeWorkOrders(
        client,
        new URLSearchParams({ mode: "all", type: "patio" }),
        HENRY,
        false,
      ),
    Error,
    "not managed",
  );
  assertEquals((error as any).status, 403);
});

Deno.test("work-order submission authority is tenant, vertical, and own-work scoped", () => {
  const fencing = workOrder("fencing", { assigned: "other-crew" });
  const patio = workOrder("patio", {
    assigned: "other-crew",
    type: "patio",
  });
  const otherTenant = workOrder("other-tenant", {
    assigned: "other-crew",
    orgId: TENANT_B,
  });
  const ordinary = { ...HENRY, managedVerticals: [] };
  const own = workOrder("own", { assigned: ordinary.id });

  assertEquals(_canSubmitWorkOrderInvoice(HENRY, fencing), true);
  assertEquals(_canSubmitWorkOrderInvoice(HENRY, patio), false);
  assertEquals(_canSubmitWorkOrderInvoice(HENRY, otherTenant), false);
  assertEquals(_canSubmitWorkOrderInvoice(ordinary, own), true);
  assertEquals(_canSubmitWorkOrderInvoice(ordinary, fencing), false);
});

Deno.test("work order invoiced by any same-tenant trade cannot be duplicated", async () => {
  const wo = workOrder("already", { assigned: "other-crew" });
  const { client } = makeClient({
    workOrders: [wo],
    invoices: [{
      id: "invoice-existing",
      org_id: TENANT_A,
      user_id: "different-trade",
      work_order_id: wo.id,
      status: "pushed_to_xero",
      xero_bill_id: "xero-1",
    }],
  });
  const result = await tradeWorkOrders(
    client,
    new URLSearchParams({ mode: "all", type: "fencing" }),
    HENRY,
    false,
  );

  assertEquals(result.work_orders[0].already_invoiced, true);
  assertEquals(result.work_orders[0].can_invoice, false);
});

Deno.test("negative work-order charges are server-selected from acknowledged same-job tenant lines", () => {
  const parent = {
    org_id: TENANT_A,
    user_id: "crew-other",
    status: "pushed_to_xero",
    users: { name: "Crew Other" },
  };
  const rows = [
    {
      id: "valid",
      job_id: "job-1",
      line_total_ex: 125.55,
      override_amount: 100,
      acknowledgment_status: "acknowledged",
      description: "Crew labour",
      trade_invoices: parent,
    },
    {
      id: "pending",
      job_id: "job-1",
      line_total_ex: 50,
      acknowledgment_status: "pending",
      trade_invoices: parent,
    },
    {
      id: "draft-parent",
      job_id: "job-1",
      line_total_ex: 50,
      acknowledgment_status: "acknowledged",
      trade_invoices: { ...parent, status: "draft" },
    },
    {
      id: "self",
      job_id: "job-1",
      line_total_ex: 50,
      acknowledgment_status: "acknowledged",
      trade_invoices: { ...parent, user_id: HENRY.id },
    },
    {
      id: "other-tenant",
      job_id: "job-1",
      line_total_ex: 50,
      acknowledgment_status: "acknowledged",
      trade_invoices: { ...parent, org_id: TENANT_B },
    },
    {
      id: "other-job",
      job_id: "job-2",
      line_total_ex: 50,
      acknowledgment_status: "acknowledged",
      trade_invoices: parent,
    },
  ];

  const selected = _selectWorkOrderNegativeCharges(rows, {
    jobId: "job-1",
    orgId: TENANT_A,
    viewerId: HENRY.id,
    selectedIds: ["valid"],
  });
  assertEquals(selected, [{
    line_id: "valid",
    job_id: "job-1",
    trade_name: "Crew Other",
    description: "Crew labour",
    source_amount_ex: 100,
    amount_ex: -100,
    override_applied: true,
    invoice_status: "pushed_to_xero",
  }]);
});

Deno.test("invalid or stale negative-charge selection fails closed", () => {
  const rows = [{
    id: "pending",
    job_id: "job-1",
    line_total_ex: 50,
    acknowledgment_status: "pending",
    trade_invoices: {
      org_id: TENANT_A,
      user_id: "crew-other",
      status: "pushed_to_xero",
    },
  }];
  let error: any = null;
  try {
    _selectWorkOrderNegativeCharges(rows, {
      jobId: "job-1",
      orgId: TENANT_A,
      viewerId: HENRY.id,
      selectedIds: ["pending"],
    });
  } catch (caught) {
    error = caught;
  }
  assertEquals(error?.status, 422);
});

Deno.test("work-order totals subtract selected trade charges before GST", () => {
  const totals = _calculateWorkOrderInvoiceTotals(
    [{ description: "Install", quantity: 2, unit_price: 500 }],
    [{ amount_ex: -125.55 }],
  );
  assertEquals(totals, {
    work_order_subtotal_ex: 1000,
    negative_charge_total_ex: -125.55,
    subtotal_ex: 874.45,
    gst: 87.45,
    total_inc: 961.9,
  });
});

Deno.test("negative charges cannot reduce a work-order invoice to zero or below", () => {
  let error: any = null;
  try {
    _calculateWorkOrderInvoiceTotals(
      [{ description: "Install", quantity: 1, unit_price: 100 }],
      [{ amount_ex: -100 }],
    );
  } catch (caught) {
    error = caught;
  }
  assertEquals(error?.status, 422);
});

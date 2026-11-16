// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  payRunCheckParams,
  readTradePayRunCheck,
  TradePayRunCheckError,
} from "./trade_pay_run_check.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";

function url(query = ""): URL {
  return new URL(
    `https://example.invalid/ops-api?action=trade_pay_run_check${query}`,
  );
}

const ANSWER = {
  rule: "trade-pay-check-v1",
  counts: { invoices: 1, clean: 0, stopped: 1, to_pay: 1 },
  invoices: [{
    invoice_number: "SW-INV-1",
    verdict: "stopped",
    stops: [{ code: "not_in_xero", text: "Not in Xero yet." }],
    notes: [],
  }],
};

Deno.test("pay-run check: parameters default to today and two weeks", () => {
  assertEquals(payRunCheckParams(null, null, ORG), {
    p_as_of: null,
    p_weeks: 2,
    p_org_id: ORG,
  });
  assertEquals(payRunCheckParams("", " ", ORG), {
    p_as_of: null,
    p_weeks: 2,
    p_org_id: ORG,
  });
  assertEquals(payRunCheckParams("2026-11-15", "6", ORG), {
    p_as_of: "2026-11-15",
    p_weeks: 6,
    p_org_id: ORG,
  });
});

Deno.test("pay-run check: a bad date or week count is refused, not guessed", () => {
  for (const d of ["2026-13-01", "2026-02-30", "15/11/2026", "today"]) {
    assertThrows(
      () => payRunCheckParams(d, null, ORG),
      TradePayRunCheckError,
      "as_of",
      d,
    );
  }
  for (const w of ["0", "27", "1.5", "two", "0x10", "1e1", "-2"]) {
    assertThrows(
      () => payRunCheckParams(null, w, ORG),
      TradePayRunCheckError,
      "weeks",
      w,
    );
  }
});

Deno.test("pay-run check: no org is a 403, never every org's invoices", () => {
  for (const o of [null, undefined, "", "not-a-uuid"]) {
    const err = assertThrows(
      () => payRunCheckParams(null, null, o),
      TradePayRunCheckError,
      "organisation",
    );
    assertEquals(err.status, 403);
  }
});

Deno.test("pay-run check: passes the parameters and returns the answer whole", async () => {
  const calls: any[] = [];
  const client = {
    rpc: (name: string, args: any) => {
      calls.push([name, args]);
      return Promise.resolve({ data: ANSWER, error: null });
    },
  };
  assertEquals(
    await readTradePayRunCheck(client, {
      asOf: "2026-11-15",
      weeks: "4",
      orgId: ORG,
    }),
    { ok: true, check: ANSWER },
  );
  assertEquals(calls, [[
    "trade_pay_run_check",
    { p_as_of: "2026-11-15", p_weeks: 4, p_org_id: ORG },
  ]]);
});

Deno.test("pay-run check: an unreadable answer is a 503, never 'every bill clean'", async () => {
  for (
    const res of [
      {
        data: null,
        error: { message: "function trade_pay_run_check does not exist" },
      },
      { data: null, error: null },
      { data: { ...ANSWER, rule: "something-else" }, error: null },
      { data: { rule: "trade-pay-check-v1", counts: {} }, error: null },
      { data: { rule: "trade-pay-check-v1", invoices: [] }, error: null },
      { data: "trade-pay-check-v1", error: null },
      // A list that does not match its own count is not shown.
      { data: { ...ANSWER, invoices: [] }, error: null },
      // Counts that do not add up, or a bill marked clean that carries a stop.
      {
        data: { ...ANSWER, counts: { ...ANSWER.counts, stopped: 0 } },
        error: null,
      },
      {
        data: {
          ...ANSWER,
          invoices: [{ ...ANSWER.invoices[0], verdict: "clean" }],
        },
        error: null,
      },
      {
        data: {
          ...ANSWER,
          invoices: [{ ...ANSWER.invoices[0], stops: undefined }],
        },
        error: null,
      },
    ]
  ) {
    const err = await assertRejects(
      () =>
        readTradePayRunCheck({ rpc: () => Promise.resolve(res) }, {
          orgId: ORG,
        }),
      TradePayRunCheckError,
    );
    assertEquals(err.status, 503);
  }
});

Deno.test("pay-run check: a bad org never reaches the database", async () => {
  let called = false;
  const err = await assertRejects(
    () =>
      readTradePayRunCheck({
        rpc: () => {
          called = true;
          return Promise.resolve({ data: ANSWER, error: null });
        },
      }, { orgId: "" }),
    TradePayRunCheckError,
  );
  assertEquals(err.status, 403);
  assertEquals(called, false);
});

Deno.test("pay-run check: staff only at the ops-api front door", () => {
  assertEquals(_opsApiActionNeedsStaffRole(url()), true);
  assertEquals(AGENT_READ_ALLOWED_ACTIONS.has("trade_pay_run_check"), false);
  assertEquals(LEAD_INSTALLER_READ_ACTIONS.has("trade_pay_run_check"), false);
  const status = (
    authMode: any,
    role?: string,
    extra: Record<string, unknown> = {},
  ) => {
    const d = _authorizeOpsApiAction({
      url: url(),
      authMode,
      authUser: role ? { role, managedVerticals: ["fencing"] } : null,
      ...extra,
    } as any);
    return d.ok ? 200 : d.status;
  };
  assertEquals(status("none"), 401);
  assertEquals(status("api_key"), 401);
  assertEquals(
    status("api_key", undefined, { serverSecretPresented: true }),
    200,
  );
  for (const role of ["admin", "owner", "ops_manager"]) {
    assertEquals(status("jwt", role), 200, role);
  }
  for (
    const role of ["trade", "crew", "lead_installer", "installer", "estimator"]
  ) {
    assertEquals(status("jwt", role), 403, role);
  }
});

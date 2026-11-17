// deno-lint-ignore-file no-explicit-any no-import-prefix
// P1-06.6: the pay settings read and set, and the unset behaviours that are
// in this slice (tax guide hidden, repayment account required). The
// reimbursement and not-job-work holds are P1-06.6b.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tradePaySettingsAction } from "./trade_pay_settings.ts";
import { tradeRepaymentsAction } from "./trade_repayments.ts";
import { buildPayView } from "./trade_pay_view.ts";
import {
  _authorizeOpsApiAction,
  _opsApiCallerIsStaffOperator,
} from "./index.ts";

const APPROVER = "ZZTEST-approver";
const STAFF = "ZZTEST-staff";

type Store = {
  settings: Record<string, any> | null;
  changes: any[];
  users: any[];
  fail?: { settings?: boolean; changes?: boolean; users?: boolean };
  rpcError?: string;
};

function fakeClient(store: Store) {
  const rpcs: any[] = [];
  const writes: any[] = [];
  const client: any = {
    rpcs,
    writes,
    rpc(name: string, args: any) {
      rpcs.push({ name, args });
      if (name === "trade_repayment_balance") return { data: 0, error: null };
      if (store.rpcError) {
        return { data: null, error: { message: store.rpcError } };
      }
      const s = store.settings!;
      const from = s[args.p_field] ?? null;
      s[args.p_field] = args.p_value;
      store.changes.unshift({
        field: args.p_field,
        from_value: from === null ? null : String(from),
        to_value: args.p_value,
        changed_by: args.p_actor,
        changed_at: "2099-01-05T00:00:00Z",
      });
      return {
        data: {
          field: args.p_field,
          value: args.p_value,
          changed_at: "2099-01-05T00:00:00Z",
        },
        error: null,
      };
    },
    from(table: string) {
      let write: any;
      const q: any = {
        select: () => q,
        eq: () => q,
        in: () => q,
        or: () => q,
        order: () => q,
        limit: () => q,
        single: () => q,
        maybeSingle: () => q,
        insert: (row: any) => {
          write = row;
          writes.push({ table, row });
          return q;
        },
        update: (row: any) => {
          write = row;
          writes.push({ table, row });
          return q;
        },
        then(resolve: any) {
          if (write) {
            return resolve({
              data: { id: "ZZTEST-rule", ...write },
              error: null,
            });
          }
          if (table === "trade_pay_settings") {
            return resolve(
              store.fail?.settings
                ? { data: null, error: { message: "boom" } }
                : { data: store.settings, error: null },
            );
          }
          if (table === "trade_pay_settings_changes") {
            return resolve(
              store.fail?.changes
                ? { data: null, error: { message: "boom" } }
                : { data: store.changes.slice(0, 20), error: null },
            );
          }
          if (table === "users") {
            if (store.fail?.users) {
              return resolve({ data: null, error: { message: "boom" } });
            }
            return resolve({ data: store.users[0] ?? null, error: null });
          }
          if (table === "trade_recurring_deductions") {
            return resolve({ data: [], error: null });
          }
          return resolve({ data: null, error: null });
        },
      };
      if (table === "users") {
        // People reads: list by ids (changes), or one person (repayment).
        q.in = () => {
          q.then = (resolve: any) =>
            resolve(
              store.fail?.users
                ? { data: null, error: { message: "boom" } }
                : { data: store.users, error: null },
            );
          return q;
        };
      }
      return q;
    },
  };
  return client;
}

function unsetStore(): Store {
  return {
    settings: {
      inclusive_super_from: "2099-01-05",
      tax_set_aside_percent: null,
      reimbursement_account_code: null,
      repayment_account_code: null,
      not_job_work_account_code: null,
      pay_run_approver_user_ids: [APPROVER],
    },
    changes: [],
    users: [{ id: APPROVER, role: "admin" }],
  };
}

const staff = { staff: true, userId: STAFF };
const approver = { staff: true, userId: APPROVER };
const serverKey = { staff: true, userId: null };
const read = (client: any, caller: any) =>
  tradePaySettingsAction(client, "trade_pay_settings", "GET", {}, caller);
const set = (client: any, caller: any, body: any) =>
  tradePaySettingsAction(client, "set_trade_pay_setting", "POST", body, caller);

Deno.test("ZZTEST read: staff and approver see the same values, can_edit differs, no approver ids", async () => {
  const store = unsetStore();
  const asStaff: any = await read(fakeClient(store), staff);
  const asApprover: any = await read(fakeClient(store), approver);
  const asServer: any = await read(fakeClient(store), serverKey);
  assertEquals(asStaff.status, 200);
  assertEquals(asStaff.body.can_edit, false);
  assertEquals(asApprover.body.can_edit, true);
  assertEquals(asServer.body.can_edit, false);
  assertEquals(asStaff.body.approvers_set, true);
  assertEquals(asStaff.body.inclusive_super_from, "2099-01-05");
  assertEquals(asStaff.body.missing, [
    "tax_set_aside_percent",
    "reimbursement_account_code",
    "repayment_account_code",
    "not_job_work_account_code",
  ]);
  for (const out of [asStaff, asApprover, asServer]) {
    assert(!JSON.stringify(out.body).includes(APPROVER), "approver id leaked");
    assert(!("pay_run_approver_user_ids" in out.body));
  }
});

Deno.test("ZZTEST read: no approvers set means nobody can edit", async () => {
  const store = unsetStore();
  store.settings!.pay_run_approver_user_ids = [];
  const out: any = await read(fakeClient(store), approver);
  assertEquals(out.body.approvers_set, false);
  assertEquals(out.body.can_edit, false);
});

Deno.test("ZZTEST read: a failed settings or changes read is an error, never all missing", async () => {
  for (const fail of [{ settings: true }, { changes: true }]) {
    const store = { ...unsetStore(), fail };
    const out: any = await read(fakeClient(store), staff);
    assertEquals(out.status, 503);
    assertEquals(out.body.code, "pay_settings_unavailable");
    assert(!("missing" in out.body));
  }
});

Deno.test("ZZTEST set: an approver sets each field; the change shows by role, never by id", async () => {
  const store = unsetStore();
  const client = fakeClient(store);
  const values: Record<string, any> = {
    tax_set_aside_percent: "20.00",
    reimbursement_account_code: "ZZ-1",
    repayment_account_code: "ZZ-2",
    not_job_work_account_code: "ZZ-3",
  };
  for (const [field, value] of Object.entries(values)) {
    const out: any = await set(client, approver, { field, value });
    assertEquals(out.status, 200, field);
    assertEquals(out.body.setting.field, field);
  }
  assertEquals(
    client.rpcs.map((r: any) => r.args.p_actor),
    Array(4).fill(APPROVER),
  );
  const after: any = await read(client, approver);
  assertEquals(after.body.missing, []);
  assertEquals(after.body.tax_set_aside_percent, "20.00");
  assertEquals(after.body.recent_changes.length, 4);
  assertEquals(after.body.recent_changes[0].changed_by_role, "admin");
  assert(!JSON.stringify(after.body).includes(APPROVER));
  // An explicit null clears; a number is accepted for the percent.
  assertEquals(
    (await set(client, approver, {
      field: "repayment_account_code",
      value: null,
    })).status,
    200,
  );
  assertEquals(
    (await set(client, approver, {
      field: "tax_set_aside_percent",
      value: 12.5,
    })).status,
    200,
  );
  assertEquals(client.rpcs.at(-1).args.p_value, "12.5");
});

Deno.test("ZZTEST set: a non-approver gets 403 with the words; a retry is refused the same way", async () => {
  const store = { ...unsetStore(), rpcError: "pay_setting_not_approver" };
  const client = fakeClient(store);
  for (let i = 0; i < 2; i++) {
    const out: any = await set(client, staff, {
      field: "tax_set_aside_percent",
      value: "20",
    });
    assertEquals(out.status, 403);
    assertEquals(
      out.body.error,
      "Only the bookkeeper and the owner can change pay settings.",
    );
  }
  assertEquals(store.settings!.tax_set_aside_percent, null);
  assertEquals(store.changes.length, 0);
});

Deno.test("ZZTEST set: a trade sign-in and a server key are refused before any write", async () => {
  // The front door refuses a trade session for both actions.
  for (const action of ["trade_pay_settings", "set_trade_pay_setting"]) {
    const decision: any = _authorizeOpsApiAction({
      url: new URL(`https://example.invalid/ops-api?action=${action}`),
      authMode: "jwt",
      authUser: { role: "lead_installer", managedVerticals: ["fencing"] },
    });
    assertEquals(decision.ok, false);
    assertEquals(decision.status, 403);
  }
  // The dispatch passes staff false for a trade; the action refuses again.
  const tradeCaller = {
    staff: _opsApiCallerIsStaffOperator(
      "jwt",
      { role: "lead_installer" } as any,
    ),
    userId: "ZZTEST-trade",
  };
  const client = fakeClient(unsetStore());
  assertEquals((await read(client, tradeCaller)).status, 403);
  assertEquals(
    (await set(client, tradeCaller, {
      field: "tax_set_aside_percent",
      value: "20",
    })).status,
    403,
  );
  // A server key may read but never set: there is no person to record.
  const out: any = await set(client, serverKey, {
    field: "tax_set_aside_percent",
    value: "20",
  });
  assertEquals(out.status, 403);
  assertEquals(out.body.code, "pay_setting_sign_in_required");
  assertEquals(client.rpcs.length, 0);
});

Deno.test("ZZTEST set: start date, approver list, empty box and missing value are 400 before the database", async () => {
  const client = fakeClient(unsetStore());
  for (
    const body of [
      { field: "inclusive_super_from", value: "2099-01-05" },
      { field: "pay_run_approver_user_ids", value: "ZZTEST" },
      { field: "repayment_account_code", value: "" },
      { field: "repayment_account_code" },
      { field: "reimbursement_account_code", value: 7 },
    ]
  ) {
    assertEquals(
      (await set(client, approver, body)).status,
      400,
      JSON.stringify(body),
    );
  }
  assertEquals(client.rpcs.length, 0);
});

Deno.test("ZZTEST set: database validation codes are 400, anything else is a server error", async () => {
  for (
    const [code, status] of [["pay_setting_value_invalid", 400], [
      "pay_setting_field_not_allowed",
      400,
    ]] as const
  ) {
    const out: any = await set(
      fakeClient({ ...unsetStore(), rpcError: code }),
      approver,
      {
        field: "tax_set_aside_percent",
        value: "61",
      },
    );
    assertEquals(out.status, status);
  }
  await assertRejects(() =>
    set(
      fakeClient({ ...unsetStore(), rpcError: "connection reset" }),
      approver,
      {
        field: "tax_set_aside_percent",
        value: "20",
      },
    )
  );
});

Deno.test("ZZTEST methods: read is GET only, set is POST only", async () => {
  const client = fakeClient(unsetStore());
  assertEquals(
    (await tradePaySettingsAction(
      client,
      "trade_pay_settings",
      "POST",
      {},
      staff,
    )).status,
    405,
  );
  assertEquals(
    (await tradePaySettingsAction(
      client,
      "set_trade_pay_setting",
      "GET",
      {},
      approver,
    )).status,
    405,
  );
});

Deno.test("ZZTEST unset tax percent: the pay view carries no tax guide", () => {
  const money: any = {
    super_basis: "inclusive_12_112_v1",
    gross_earned: 1120,
    super_base_ex: 1120,
    super_amount: 120,
    gst_amount: 0,
    trade_payable: 1000,
    recurring_deduction: null,
  };
  const unset = buildPayView(money, {
    reimbursementsEx: 0,
    taxSetAsidePercent: null,
    repayment: null,
  });
  assertEquals(unset?.tax_set_aside, null);
  const setView = buildPayView(money, {
    reimbursementsEx: 0,
    taxSetAsidePercent: 20,
    repayment: null,
  });
  assertEquals(setView?.tax_set_aside, { percent: 20, amount: 200 });
});

const repayment = {
  user_id: "ZZTEST-trade",
  label: "ZZTEST repayment",
  amount: 100,
  balance_total: 250,
  first_week_start: "2099-01-05",
  note: "ZZTEST",
};
const repayCaller = { staff: true, userId: APPROVER, orgId: "ZZTEST-org" };

Deno.test("ZZTEST unset repayment account: a repayment needs an account typed", async () => {
  for (const body of [repayment, { ...repayment, xero_account_code: "" }]) {
    const client = fakeClient(unsetStore());
    const out: any = await tradeRepaymentsAction(
      client,
      "set_trade_repayment",
      "POST",
      body,
      repayCaller,
    );
    assertEquals(out.status, 400);
    assertEquals(out.body.code, "repayment_invalid");
    assertEquals(out.body.field, "xero_account_code");
    assertEquals(client.writes.length, 0);
  }
});

Deno.test("ZZTEST set repayment account: it is the default; a typed account still wins", async () => {
  const store = unsetStore();
  store.settings!.repayment_account_code = "ZZ-DEFAULT";
  store.users = [{ id: "ZZTEST-trade" }];
  let client = fakeClient(store);
  let out: any = await tradeRepaymentsAction(
    client,
    "set_trade_repayment",
    "POST",
    repayment,
    repayCaller,
  );
  assertEquals(out.status, 200);
  assertEquals(client.writes[0].row.xero_account_code, "ZZ-DEFAULT");
  client = fakeClient(store);
  out = await tradeRepaymentsAction(client, "set_trade_repayment", "POST", {
    ...repayment,
    xero_account_code: "ZZ-TYPED",
  }, repayCaller);
  assertEquals(out.status, 200);
  assertEquals(client.writes[0].row.xero_account_code, "ZZ-TYPED");
});

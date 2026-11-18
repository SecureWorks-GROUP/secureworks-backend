// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _authorizeOpsApiAction,
  _opsApiCallerIsStaffOperator,
} from "./index.ts";
import { tradeRepaymentsAction } from "./trade_repayments.ts";

const OPERATOR = "ZZTEST-approver";
const ORG = "ZZTEST-org";
const SET = {
  user_id: "ZZTEST-trade",
  label: "ZZTEST repayment",
  amount: 10,
  balance_total: 25,
  first_week_start: "2099-01-05",
  xero_account_code: "ZZTEST-account",
};
const STOP = { id: "ZZTEST-rule", reason: "ZZTEST stop" };

function officeStore(
  options: { approver?: boolean; readFailed?: boolean } = {},
) {
  const writes: Array<{ method: string; row: any }> = [];
  const client = {
    from(table: string) {
      let write: any;
      let overlap = false;
      const q: any = {
        select: () => q,
        eq: () => q,
        or() {
          overlap = true;
          return q;
        },
        single: () => q,
        maybeSingle: () => q,
        insert(row: any) {
          write = row;
          writes.push({ method: "insert", row });
          return q;
        },
        update(row: any) {
          write = row;
          writes.push({ method: "update", row });
          return q;
        },
        then(resolve: any) {
          if (table === "trade_pay_settings") {
            return resolve({
              data: options.readFailed ? null : {
                pay_run_approver_user_ids: options.approver === false
                  ? []
                  : [OPERATOR],
              },
              error: options.readFailed ? { code: "ZZTEST read failed" } : null,
            });
          }
          const data = write
            ? { id: "ZZTEST-rule", ...write }
            : table === "users"
            ? { id: "ZZTEST-trade" }
            : table === "trade_recurring_deductions"
            ? (overlap
              ? []
              : { id: "ZZTEST-rule", user_id: "ZZTEST-trade", note: "" })
            : null;
          return resolve({ data, error: null });
        },
      };
      return q;
    },
  };
  return { client, writes };
}

for (const role of ["admin", "owner", "ops_manager"]) {
  Deno.test(`repayment roles: configured ${role} passes set and stop staff gates`, async () => {
    const { client, writes } = officeStore();
    const authUser = { role };
    for (
      const [action, body] of [
        ["set_trade_repayment", SET],
        ["stop_trade_repayment", STOP],
      ] as const
    ) {
      // Exercise the actual front-door and dispatch staff decisions, then the
      // action's separate configured-approver check. Role alone is not enough.
      assertEquals(
        _authorizeOpsApiAction({
          url: new URL(`https://example.invalid/ops-api?action=${action}`),
          authMode: "jwt",
          authUser,
        }),
        { ok: true },
      );
      const reply = await tradeRepaymentsAction(
        client,
        action,
        "POST",
        body,
        {
          staff: _opsApiCallerIsStaffOperator("jwt", authUser),
          userId: OPERATOR,
          orgId: ORG,
        },
      );
      assertEquals(reply.status, 200, action);
    }
    assertEquals(writes.length, 2);
    assertEquals(writes[0].method, "insert");
    assertEquals(writes[0].row.set_by, OPERATOR);
    assertEquals(writes[1].method, "update");
    assertEquals(writes[1].row.active, false);
    assertEquals(writes[1].row.note, STOP.reason);
  });

  Deno.test(`repayment roles: ${role} without approval authority or after a failed read cannot set or stop`, async () => {
    for (const options of [{ approver: false }, { readFailed: true }]) {
      const { client, writes } = officeStore(options);
      for (
        const [action, body] of [
          ["set_trade_repayment", SET],
          ["stop_trade_repayment", STOP],
        ] as const
      ) {
        // Repeating the refusal must not write or bypass the settings check.
        for (let attempt = 0; attempt < 2; attempt++) {
          const reply = await tradeRepaymentsAction(
            client,
            action,
            "POST",
            body,
            {
              staff: _opsApiCallerIsStaffOperator("jwt", { role }),
              userId: OPERATOR,
              orgId: ORG,
            },
          );
          assertEquals(reply.status, 403);
          assert("code" in reply.body);
          assertEquals(reply.body.code, "repayment_not_approver");
        }
      }
      assertEquals(writes, []);
    }
  });
}

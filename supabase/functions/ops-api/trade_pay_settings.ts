// deno-lint-ignore-file no-explicit-any
// P1-06.6. Staff read the pay settings; only a named approver changes one of
// the four settable fields, through the database writer set_trade_pay_setting
// (P1-06.5), which records every change. The start date and the approver list
// are never accepted here, and approver ids are never returned.
type Caller = { staff: boolean; userId: string | null };

export const TRADE_PAY_SETTABLE_FIELDS = [
  "tax_set_aside_percent",
  "reimbursement_account_code",
  "repayment_account_code",
  "not_job_work_account_code",
] as const;

const NOT_APPROVER =
  "Only the bookkeeper and the owner can change pay settings.";

const result = (
  status: number,
  code: string,
  error: string,
  field?: string,
) => ({ status, body: { code, error, ...(field ? { field } : {}) } });

export async function tradePaySettingsAction(
  client: any,
  action: string,
  method: string,
  body: Record<string, any>,
  caller: Caller,
) {
  if (!caller.staff) {
    return result(403, "staff_only", "Pay settings are for the office.");
  }
  if (method !== (action === "trade_pay_settings" ? "GET" : "POST")) {
    return result(
      405,
      "method_not_allowed",
      "Use the required request method.",
    );
  }
  if (action === "trade_pay_settings") {
    return await readSettings(client, caller);
  }

  // The actor is the signed-in person only; a server key cannot set a value.
  if (!caller.userId) {
    return result(
      403,
      "pay_setting_sign_in_required",
      "A signed-in person is required to change pay settings.",
    );
  }
  const field = body?.field;
  if (
    typeof field !== "string" ||
    !(TRADE_PAY_SETTABLE_FIELDS as readonly string[]).includes(field)
  ) {
    return result(
      400,
      "pay_setting_field_not_allowed",
      "That pay setting cannot be changed here.",
      "field",
    );
  }
  // Only an explicit null clears a value; a missing value or an empty box is
  // refused rather than read as a clear.
  const raw = body && Object.prototype.hasOwnProperty.call(body, "value")
    ? body.value
    : undefined;
  let value: string | null;
  if (raw === null) value = null;
  else if (typeof raw === "string" && raw !== "") value = raw;
  else if (
    typeof raw === "number" && Number.isFinite(raw) &&
    field === "tax_set_aside_percent"
  ) value = String(raw);
  else {
    return result(
      400,
      "pay_setting_value_invalid",
      "Check the pay setting value.",
      "value",
    );
  }
  const saved = await client.rpc("set_trade_pay_setting", {
    p_field: field,
    p_value: value,
    p_actor: caller.userId,
  });
  if (saved.error) {
    const message = String(saved.error.message || saved.error);
    if (message.includes("pay_setting_not_approver")) {
      return result(403, "pay_setting_not_approver", NOT_APPROVER);
    }
    if (message.includes("pay_setting_field_not_allowed")) {
      return result(
        400,
        "pay_setting_field_not_allowed",
        "That pay setting cannot be changed here.",
        "field",
      );
    }
    if (message.includes("pay_setting_value_invalid")) {
      return result(
        400,
        "pay_setting_value_invalid",
        field === "tax_set_aside_percent"
          ? "The percent must be a number from 0 to 60 with at most two decimals."
          : "The Xero account code must be 1 to 20 characters.",
        "value",
      );
    }
    throw new Error("Could not change pay setting");
  }
  return { status: 200, body: { setting: saved.data } };
}

async function readSettings(client: any, caller: Caller) {
  const settings = await client.from("trade_pay_settings").select(
    "inclusive_super_from, tax_set_aside_percent, reimbursement_account_code, repayment_account_code, not_job_work_account_code, pay_run_approver_user_ids",
  ).eq("id", 1).maybeSingle();
  if (settings.error) {
    return result(
      503,
      "pay_settings_unavailable",
      "The pay settings could not be read. Try again in a minute.",
    );
  }
  // trade_pay_settings_changes is append-only and written one row per
  // approver press; it holds a handful of rows.
  const changes = await client.from("trade_pay_settings_changes").select(
    "field, from_value, to_value, changed_by, changed_at",
  ).order("changed_at", { ascending: false }).limit(20);
  if (changes.error) {
    return result(
      503,
      "pay_settings_unavailable",
      "The pay settings could not be read. Try again in a minute.",
    );
  }
  const row = settings.data ?? {};
  const approvers: string[] = Array.isArray(row.pay_run_approver_user_ids)
    ? row.pay_run_approver_user_ids.map(String)
    : [];
  const changeRows: any[] = Array.isArray(changes.data) ? changes.data : [];
  const who = [
    ...new Set(changeRows.map((c) => c.changed_by).filter(Boolean)),
  ];
  const roles = new Map<string, string | null>();
  if (who.length) {
    const users = await client.from("users").select("id, role").in("id", who);
    if (!users.error) {
      for (const u of users.data || []) roles.set(String(u.id), u.role ?? null);
    }
  }
  const values: Record<string, unknown> = {};
  for (const field of TRADE_PAY_SETTABLE_FIELDS) {
    values[field] = row[field] ?? null;
  }
  return {
    status: 200,
    body: {
      inclusive_super_from: row.inclusive_super_from ?? null,
      ...values,
      approvers_set: approvers.length > 0,
      can_edit: !!caller.userId && approvers.includes(caller.userId),
      missing: TRADE_PAY_SETTABLE_FIELDS.filter((f) => values[f] === null),
      recent_changes: changeRows.map((c) => ({
        field: c.field,
        from_value: c.from_value ?? null,
        to_value: c.to_value ?? null,
        changed_by_role: roles.get(String(c.changed_by)) ?? null,
        changed_at: c.changed_at,
      })),
    },
  };
}

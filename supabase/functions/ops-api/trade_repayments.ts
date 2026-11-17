// deno-lint-ignore-file no-explicit-any
// P1-09.3. Rule amounts are immutable here: stop, then create a new rule.
type Caller = { staff: boolean; userId: string | null; orgId: string | null };
const result = (
  status: number,
  code: string,
  error: string,
  field?: string,
) => ({ status, body: { code, error, ...(field ? { field } : {}) } });
const invalid = (field: string) =>
  result(400, "repayment_invalid", "Check the repayment field.", field);
const money = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 &&
  Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;

export async function tradeRepaymentsAction(
  client: any,
  action: string,
  method: string,
  body: Record<string, any>,
  caller: Caller,
) {
  if (!caller.staff || !caller.userId) {
    return result(403, "staff_only", "Repayments are for the office.");
  }
  if (method !== (action === "list_trade_repayments" ? "GET" : "POST")) {
    return result(
      405,
      "method_not_allowed",
      "Use the required request method.",
    );
  }
  if (!caller.orgId) return result(403, "staff_only", "A company is required.");
  if (action !== "list_trade_repayments") {
    if (!caller.userId) {
      return result(
        403,
        "repayment_not_approver",
        "Only the bookkeeper and the owner can set a repayment.",
      );
    }
    const setting = await client.from("trade_pay_settings").select(
      "pay_run_approver_user_ids",
    ).eq("id", 1).maybeSingle();
    if (
      setting.error ||
      !setting.data?.pay_run_approver_user_ids?.includes(caller.userId)
    ) {
      return result(
        403,
        "repayment_not_approver",
        "Only the bookkeeper and the owner can set a repayment.",
      );
    }
  }
  if (action === "list_trade_repayments") {
    const users = await client.from("users").select("id, name").eq(
      "org_id",
      caller.orgId,
    );
    if (users.error) throw new Error("Could not read repayment people");
    if (!users.data?.length) return { status: 200, body: { repayments: [] } };
    const names = new Map(users.data.map((u: any) => [u.id, u.name]));
    const rows = await client.from("trade_recurring_deductions").select(
      "id, user_id, label, amount, balance_total, first_week_start, active, stopped_at, set_by, xero_account_code",
    )
      .eq("kind", "repayment").in("user_id", users.data.map((u: any) => u.id))
      .order("first_week_start", { ascending: false });
    if (rows.error) throw new Error("Could not read repayments");
    const repayments = [];
    for (const row of rows.data || []) {
      const balance = await client.rpc("trade_repayment_balance", {
        p_id: row.id,
      });
      if (balance.error || balance.data === null) {
        throw new Error("Could not read repayment balance");
      }
      const { set_by, ...fields } = row;
      repayments.push({
        ...fields,
        trade_name: names.get(row.user_id) ?? null,
        set_by_name: names.get(set_by) ?? null,
        balance_left: Number(balance.data),
      });
    }
    return { status: 200, body: { repayments } };
  }
  if (action === "set_trade_repayment") {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label || label.length > 60) return invalid("label");
    if (!money(body.amount)) return invalid("amount");
    if (!money(body.balance_total) || body.balance_total < body.amount) {
      return invalid("balance_total");
    }
    const week = String(body.first_week_start || "");
    const day = new Date(week + "T00:00:00Z");
    const today = new Date(
      new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Perth" }) +
        "T00:00:00Z",
    );
    today.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isFinite(day.getTime()) ||
      day.toISOString().slice(0, 10) !== week || day.getUTCDay() !== 1 ||
      day < today
    ) return invalid("first_week_start");
    const account = typeof body.xero_account_code === "string"
      ? body.xero_account_code.trim()
      : "";
    if (!account) return invalid("xero_account_code");
    const person = await client.from("users").select("id").eq(
      "id",
      body.user_id,
    ).eq("org_id", caller.orgId).maybeSingle();
    if (person.error || !person.data) return invalid("user_id");
    const overlap = await client.from("trade_recurring_deductions").select("id")
      .eq("user_id", body.user_id).eq("active", true)
      .or(`last_week_start.is.null,last_week_start.gte.${week}`);
    if (overlap.error) throw new Error("Could not check repayment overlap");
    if (Array.isArray(overlap.data) && overlap.data.length) {
      return result(
        409,
        "repayment_overlaps",
        "An active deduction already covers this week or a later week.",
      );
    }
    const saved = await client.from("trade_recurring_deductions").insert({
      user_id: body.user_id,
      label,
      amount: body.amount,
      balance_total: body.balance_total,
      first_week_start: week,
      xero_account_code: account,
      note: String(body.note || ""),
      kind: "repayment",
      set_by: caller.userId,
    }).select("*").single();
    if (saved.error) throw new Error("Could not set repayment");
    return { status: 200, body: { repayment: saved.data } };
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!body.id) return invalid("id");
  if (!reason) return invalid("reason");
  const rule = await client.from("trade_recurring_deductions").select(
    "id, user_id, note",
  ).eq("id", body.id).eq("kind", "repayment").maybeSingle();
  if (rule.error || !rule.data) return invalid("id");
  const person = await client.from("users").select("id").eq(
    "id",
    rule.data.user_id,
  ).eq("org_id", caller.orgId).maybeSingle();
  if (person.error || !person.data) return invalid("id");
  const stopped = await client.from("trade_recurring_deductions").update({
    active: false,
    stopped_at: new Date().toISOString(),
    note: [rule.data.note, reason].filter(Boolean).join("\n"),
  }).eq("id", body.id).eq("kind", "repayment").select("*").single();
  if (stopped.error) throw new Error("Could not stop repayment");
  return { status: 200, body: { repayment: stopped.data } };
}

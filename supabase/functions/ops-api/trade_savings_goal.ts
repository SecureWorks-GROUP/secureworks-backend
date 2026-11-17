// A trade's own savings goal (P1-07.4). Read, set and clear, for the
// signed-in trade only.
//
// Two trade actions:
//   `my_savings_goal` (GET)      -> { ok: true, goal: {...} | null }
//   `set_my_savings_goal` (POST) -> body { label, target_amount, saved_amount,
//                                   target_date } saves the caller's goal;
//                                   body { clear: true } removes it.
//
// The user id is ALWAYS the session's (authTrade), passed in by the route.
// Nothing in the body or the query string can name another person: the row
// written is built field by field from the four goal fields, never by spreading
// the body. The owner's "view as trade" preview cannot read or write a goal
// (neither action is on TRADE_PREVIEW_READS): a goal is the trade's own.
//
// The goal is self-reported. It holds no bank, fund or invoice link, and no
// wording here suggests an amount, a product or a place to save.
//
// Every answer is { status, body }, so the route is one json(body, status)
// line. Input the table would refuse comes back as 400 `goal_invalid` naming
// the field, never as a server fault. A failed read is 503 `goal_unreadable`,
// never "no goal"; a failed write is 503 `goal_unsaved` and nothing changed.
// deno-lint-ignore-file no-explicit-any

export const SAVINGS_GOAL_LABEL_MAX = 60;
// numeric(12,2): ten digits before the point.
export const SAVINGS_GOAL_AMOUNT_MAX = 9999999999.99;

const GOAL_COLUMNS = "label, target_amount, saved_amount, target_date, updated_at";

export type SavingsGoal = {
  label: string;
  target_amount: number;
  saved_amount: number;
  target_date: string | null;
  updated_at: string | null;
};

export type SavingsGoalAnswer = {
  status: number;
  body:
    | { ok: true; goal: SavingsGoal | null }
    | { ok: false; error: string; code: string; field?: string };
};

type SavingsGoalFields = Omit<SavingsGoal, "updated_at">;

type ParsedGoalInput =
  | { kind: "clear" }
  | { kind: "set"; fields: SavingsGoalFields }
  | { kind: "invalid"; field: string; error: string };

function invalid(field: string, error: string): ParsedGoalInput {
  return { kind: "invalid", field, error };
}

function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value.slice(0, 4) === "0000") return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// An amount is a finite number, or a plain decimal string ("1200", "1200.50").
// null, "", booleans, arrays and objects are not amounts: no Number() coercion.
function readAmount(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw)) {
    n = Number(raw.trim());
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  // The column keeps cents; round as it would, so the check below sees what
  // is stored.
  return Math.round(n * 100) / 100;
}

/** Reads a set/clear body. Takes only the goal fields; anything else is ignored. */
export function parseSavingsGoalInput(body: unknown): ParsedGoalInput {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (b.clear === true) return { kind: "clear" };

  if (typeof b.label !== "string") {
    return invalid("label", "Say what you are saving for, in 60 characters or fewer.");
  }
  const label = b.label.trim();
  const labelLength = Array.from(label).length;
  if (labelLength < 1 || labelLength > SAVINGS_GOAL_LABEL_MAX) {
    return invalid("label", "Say what you are saving for, in 60 characters or fewer.");
  }

  const target = readAmount(b.target_amount);
  if (target === null || target <= 0 || target > SAVINGS_GOAL_AMOUNT_MAX) {
    return invalid("target_amount", "Enter how much you want to save, more than $0.");
  }

  // Saved so far defaults to 0, as the table does.
  let saved = 0;
  if (b.saved_amount !== undefined && b.saved_amount !== null && b.saved_amount !== "") {
    const read = readAmount(b.saved_amount);
    if (read === null || read < 0 || read > SAVINGS_GOAL_AMOUNT_MAX) {
      return invalid("saved_amount", "Enter what you have saved so far, $0 or more.");
    }
    saved = read;
  }

  let targetDate: string | null = null;
  if (b.target_date !== undefined && b.target_date !== null && b.target_date !== "") {
    if (typeof b.target_date !== "string" || !isIsoDay(b.target_date)) {
      return invalid("target_date", "Pick a real date, or leave the date empty.");
    }
    targetDate = b.target_date;
  }

  return {
    kind: "set",
    fields: { label, target_amount: target, saved_amount: saved, target_date: targetDate },
  };
}

function goalFromRow(row: any): SavingsGoal | null {
  if (!row) return null;
  return {
    label: String(row.label),
    target_amount: Number(row.target_amount),
    saved_amount: Number(row.saved_amount),
    target_date: row.target_date ? String(row.target_date) : null,
    updated_at: row.updated_at ? String(row.updated_at) : null,
  };
}

function unreadable(): SavingsGoalAnswer {
  return {
    status: 503,
    body: { ok: false, code: "goal_unreadable", error: "Could not load your goal. Try again." },
  };
}

function unsaved(): SavingsGoalAnswer {
  return {
    status: 503,
    body: { ok: false, code: "goal_unsaved", error: "Could not save your goal. Nothing changed. Try again." },
  };
}

function requireUserId(userId: string): void {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("savings goal: a session user id is required");
  }
}

/** The signed-in trade's goal, or null when they have none. */
export async function readMySavingsGoal(client: any, userId: string): Promise<SavingsGoalAnswer> {
  requireUserId(userId);
  try {
    const { data, error } = await client.from("trade_savings_goals")
      .select(GOAL_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return unreadable();
    return { status: 200, body: { ok: true, goal: goalFromRow(data) } };
  } catch {
    return unreadable();
  }
}

/** Saves or clears the signed-in trade's goal. */
export async function setMySavingsGoal(
  client: any,
  userId: string,
  body: unknown,
  now: () => string = () => new Date().toISOString(),
): Promise<SavingsGoalAnswer> {
  requireUserId(userId);
  const parsed = parseSavingsGoalInput(body);
  if (parsed.kind === "invalid") {
    return {
      status: 400,
      body: { ok: false, code: "goal_invalid", field: parsed.field, error: parsed.error },
    };
  }
  try {
    if (parsed.kind === "clear") {
      const { error } = await client.from("trade_savings_goals").delete().eq("user_id", userId);
      if (error) return unsaved();
      return { status: 200, body: { ok: true, goal: null } };
    }
    const row = {
      user_id: userId,
      label: parsed.fields.label,
      target_amount: parsed.fields.target_amount,
      saved_amount: parsed.fields.saved_amount,
      target_date: parsed.fields.target_date,
      updated_at: now(),
    };
    const { data, error } = await client.from("trade_savings_goals")
      .upsert(row, { onConflict: "user_id" })
      .select(GOAL_COLUMNS)
      .single();
    if (error || !data) return unsaved();
    return { status: 200, body: { ok: true, goal: goalFromRow(data) } };
  } catch {
    return unsaved();
  }
}

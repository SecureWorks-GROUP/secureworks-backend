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
// never "no goal"; a failed write is 503 `goal_unsaved`. The write may still
// have landed, so the caller is told to reload, never that nothing changed.
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

// numeric(12,2) in cents, so the range check is on whole cents.
const SAVINGS_GOAL_AMOUNT_MAX_CENTS = 999999999999n;

// An amount is a finite number, or a plain decimal string ("1200", "1200.50").
// null, "", booleans, arrays and objects are not amounts: no Number() coercion.
// A negative amount is refused before any rounding, so -0.004 never reads as 0.
// Rounding is done on the decimal digits, half away from zero, as numeric(12,2)
// does: "1.005" and 1.005 both store 1.01 (binary Math.round would give 1.00).
// Returns whole cents, or null when it is not an amount.
function readAmountCents(raw: unknown): bigint | null {
  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return null;
    // The shortest decimal that names this number, which is what the JSON
    // body carries to the database.
    text = String(raw);
    if (/e/i.test(text)) {
      // Exponent form only below 1e-6 (rounds to 0 cents) or at 1e21 and up
      // (over the column's range).
      return raw < 1 ? 0n : SAVINGS_GOAL_AMOUNT_MAX_CENTS + 1n;
    }
  } else if (typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw)) {
    text = raw.trim();
  } else {
    return null;
  }
  const [whole, frac = ""] = text.split(".");
  const cents = BigInt(whole + (frac + "00").slice(0, 2));
  return frac.length > 2 && frac[2] >= "5" ? cents + 1n : cents;
}

function centsToAmount(cents: bigint): number {
  return Number(cents) / 100;
}

// A high surrogate not followed by a low one, or a low one not preceded by a
// high one. A valid pair (an emoji) never matches.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Reads a set/clear body. Takes only the goal fields; anything else is ignored. */
export function parseSavingsGoalInput(body: unknown): ParsedGoalInput {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (b.clear === true) return { kind: "clear" };

  if (typeof b.label !== "string") {
    return invalid("label", "Say what you are saving for, in 60 characters or fewer.");
  }
  // PostgreSQL text cannot hold a NUL character: refuse it here, not as a 503.
  // Nor a lone UTF-16 surrogate (JSON "\uD800" parses to one): refuse it
  // here too, or the write fails and reads as 503 goal_unsaved.
  if (b.label.includes("\u0000") || LONE_SURROGATE.test(b.label)) {
    return invalid("label", "Say what you are saving for, in 60 characters or fewer.");
  }
  const label = b.label.trim();
  const labelLength = Array.from(label).length;
  if (labelLength < 1 || labelLength > SAVINGS_GOAL_LABEL_MAX) {
    return invalid("label", "Say what you are saving for, in 60 characters or fewer.");
  }

  const targetCents = readAmountCents(b.target_amount);
  if (targetCents === null || targetCents <= 0n || targetCents > SAVINGS_GOAL_AMOUNT_MAX_CENTS) {
    return invalid("target_amount", "Enter how much you want to save, more than $0.");
  }
  const target = centsToAmount(targetCents);

  // Saved so far defaults to 0, as the table does.
  let saved = 0;
  if (b.saved_amount !== undefined && b.saved_amount !== null && b.saved_amount !== "") {
    const readCents = readAmountCents(b.saved_amount);
    if (readCents === null || readCents > SAVINGS_GOAL_AMOUNT_MAX_CENTS) {
      return invalid("saved_amount", "Enter what you have saved so far, $0 or more.");
    }
    saved = centsToAmount(readCents);
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
    body: { ok: false, code: "goal_unsaved", error: "Could not save your goal. Reload to see what is saved, then try again." },
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

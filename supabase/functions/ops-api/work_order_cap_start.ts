// Follow-up 49 item 9(b), before the switch: the work order cap's start date
// (work_order_cap_settings.cap_start_on). GET work_order_cap_start reads it and
// its recent changes (office staff). POST set_work_order_cap_start sets it: a
// signed-in approver only, never the server key; who may is the database's
// owner_approval_authority, checked by set_work_order_cap_start before it
// reads anything. Every change, by this door or by hand in SQL, is recorded in
// work_order_cap_start_changes. Logs carry codes only.
// deno-lint-ignore-file no-explicit-any

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day as YYYY-MM-DD, null for "no start date", or undefined
 * when the value is neither. */
function dayOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) return undefined;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

const SET_REFUSALS: Array<[string, number, string, string]> = [
  ["work_order_cap_start_not_approver", 403, "approver_required", "Only an approver on the work order approver list can set the cap's start date."],
  ["work_order_cap_start_reason_invalid", 400, "reason_invalid", "Give a reason of 3 to 500 characters."],
  ["work_order_cap_start_changed", 409, "cap_start_changed", "The start date changed since you read it. Read it again, then set it."],
  ["work_order_cap_settings_missing", 409, "cap_settings_missing", "The cap's settings row is missing, so no job is capped. Tell the office."],
];

export async function workOrderCapStartAction(
  client: any,
  action: "work_order_cap_start" | "set_work_order_cap_start",
  method: string,
  input: any,
  ctx: { staff: boolean; signedIn: boolean; userId: string | null; email: string | null },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const refuse = (status: number, code: string, error: string) => ({ status, body: { ok: false, code, error } });
  if (action === "work_order_cap_start") {
    if (method !== "GET") return refuse(405, "method_not_allowed", "Use GET.");
    if (!ctx.staff) return refuse(403, "operator_access_required", "Office staff only.");
    // work_order_cap_settings_pkey; the record by its primary key, newest first.
    const [settings, changes] = await Promise.all([
      client.from("work_order_cap_settings").select("cap_start_on, updated_at").eq("id", 1).limit(1),
      client.from("work_order_cap_start_changes")
        .select("id, changed_at, previous_start, new_start, via, set_by, set_by_email, authority, reason, db_role")
        .order("id", { ascending: false }).limit(20),
    ]);
    if (settings?.error || !Array.isArray(settings?.data) || changes?.error || !Array.isArray(changes?.data)) {
      console.error("[ops-api] work_order_cap_start: unreadable");
      return refuse(503, "cap_start_unreadable", "The cap's start date could not be read. Try again in a minute.");
    }
    const row = settings.data[0];
    return {
      status: 200,
      body: {
        ok: true,
        // No settings row reads exactly as no start date: no job is capped.
        settings_row: !!row,
        cap_start_on: row?.cap_start_on ?? null,
        updated_at: row?.updated_at ?? null,
        changes: changes.data,
      },
    };
  }
  if (method !== "POST") return refuse(405, "method_not_allowed", "Use POST.");
  if (!ctx.signedIn || !ctx.userId) {
    return refuse(403, "named_person_required", "The cap's start date is set by a signed-in approver, so it names who set it.");
  }
  const body = input && typeof input === "object" ? input : {};
  // Both keys must be sent: null is a real answer (no start date).
  const shown = "shown_start" in body ? dayOrNull(body.shown_start) : undefined;
  const start = "cap_start_on" in body ? dayOrNull(body.cap_start_on) : undefined;
  if (shown === undefined) {
    return refuse(400, "shown_start_invalid", "Send shown_start: the start date you were shown (YYYY-MM-DD), or null if none.");
  }
  if (start === undefined) {
    return refuse(400, "cap_start_invalid", "Send cap_start_on: a Perth day (YYYY-MM-DD), or null for no start date.");
  }
  const reason = typeof body.reason === "string" ? body.reason.replace(/\s+/g, " ").trim() : "";
  if (reason.length < 3 || reason.length > 500) {
    return refuse(400, "reason_invalid", "Give a reason of 3 to 500 characters.");
  }
  let result: any;
  try {
    result = await client.rpc("set_work_order_cap_start", {
      p_actor: ctx.userId,
      p_actor_email: ctx.email,
      p_shown_start: shown,
      p_start: start,
      p_reason: reason,
    });
  } catch {
    console.error("[ops-api] set_work_order_cap_start: rpc_failed");
    return refuse(503, "cap_start_unwritable", "The start date could not be saved. Try again in a minute.");
  }
  if (result?.error) {
    const message = String(result.error?.message || "");
    for (const [needle, status, code, words] of SET_REFUSALS) {
      if (message.includes(needle)) return refuse(status, code, words);
    }
    console.error("[ops-api] set_work_order_cap_start: rpc_error", result.error?.code || "unknown");
    return refuse(503, "cap_start_unwritable", "The start date could not be saved. Try again in a minute.");
  }
  const data = result?.data;
  if (!data || typeof data !== "object" || typeof data.changed !== "boolean") {
    console.error("[ops-api] set_work_order_cap_start: answer_malformed");
    return refuse(503, "cap_start_unwritable", "The start date could not be confirmed. Read it again before retrying.");
  }
  return {
    status: 200,
    body: {
      ok: true,
      changed: data.changed,
      cap_start_on: data.cap_start_on ?? null,
      previous_start: data.previous_start ?? null,
      authority: data.authority ?? null,
    },
  };
}

// Follow-up 49 item 9(b), before the switch: the work order cap's start date
// (work_order_cap_settings.cap_start_on). GET work_order_cap_start reads it and
// its recent changes (office staff). POST set_work_order_cap_start sets it: a
// signed-in approver only, never the server key (preview: true answers what
// the change would do and writes nothing, for an approver only); who may is the database's
// owner_approval_authority, checked by set_work_order_cap_start before it
// reads anything. The door records its own change in work_order_cap_start_changes;
// a hand change in SQL is recorded there once the director installs the record
// trigger (install_work_order_cap_start_record). Logs carry codes only.
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

/** What a change of the start date does, in the setter's screen words, true
 * for the held-lines switch (trade_line_hold_v1) as it stands. The cap's rule
 * (work_order_cap_scope): with the switch on, a job is capped by its work
 * order when the order was approved on or after the start day, or, with no
 * approved order, when the job was created on or after it. So an earlier day
 * caps more jobs and a later day caps fewer. With the switch off the date
 * decides nothing yet: every approved work order caps its job, as before. With
 * the switch on, no start date would cap no job, so the database refuses to
 * clear it. holdOn null: the switch was not read, and the words say so. The
 * hourly maximum is not part of this and stays on every hourly job. */
export type CapStartEffect = "unchanged" | "set" | "earlier" | "later" | "cleared";
export function capStartChangeWords(
  previous: string | null,
  next: string | null,
  holdOn: boolean | null,
): { effect: CapStartEffect; words: string; refused: boolean } {
  const hourly = " Hourly maximums still apply to every hourly job.";
  const now = holdOn === true
    ? ""
    : holdOn === false
    ? " Held lines are off now, so this changes nothing yet: every approved work order still caps its job. The date decides only once held lines go on."
    : " Whether held lines are on could not be read.";
  if (previous === next) {
    return { effect: "unchanged", words: "No change: the start date is already this day.", refused: false };
  }
  if (next === null) {
    if (holdOn === true) {
      return {
        effect: "cleared",
        refused: true,
        words: `Not allowed while held lines are on: with no start date no job would be capped by its work order. Turn held lines off first, or pick a day.${hourly}`,
      };
    }
    return {
      effect: "cleared",
      refused: false,
      words: holdOn === false
        ? `No start date. Held lines are off, so this changes nothing yet: every approved work order still caps its job. Set a day before held lines go on.${hourly}`
        : `No start date. While held lines are on this is refused; whether they are on could not be read.${hourly}`,
    };
  }
  if (previous === null) {
    return {
      effect: "set",
      refused: false,
      words: `Start day ${next}: a job whose work order is approved on or after this day, or with no approved work order created on or after it, is capped by its work order. Older jobs are not.${now}${hourly}`,
    };
  }
  if (next > previous) {
    return {
      effect: "later",
      refused: false,
      words: `Later start day, ${previous} to ${next}: fewer jobs capped. A job approved, or with no approved work order created, on or after ${previous} and before ${next} is no longer capped by its work order.${now}${hourly}`,
    };
  }
  return {
    effect: "earlier",
    refused: false,
    words: `Earlier start day, ${previous} to ${next}: more jobs capped. A job approved, or with no approved work order created, on or after ${next} and before ${previous} is now capped by its work order.${now}${hourly}`,
  };
}

/** Separate item (the director may strike it): held lines on with no start
 * date caps no job by its work order. Nothing here can stop the switch being
 * turned on, so every answer about the date carries this warning while that is
 * the state. Go-live order: set the date, then turn held lines on. */
export const HOLD_ON_WITHOUT_START_WORDS =
  "Held lines are on but no start date is set, so no job is capped by its work order. Set a start day now. Go-live order: set the date first, then turn held lines on.";
export function capStartWarning(holdOn: boolean | null, capStartOn: string | null) {
  return holdOn === true && capStartOn === null
    ? { code: "hold_on_without_start", words: HOLD_ON_WITHOUT_START_WORDS }
    : null;
}

const SET_REFUSALS: Array<[string, number, string, string]> = [
  ["work_order_cap_start_not_approver", 403, "approver_required", "Only an approver on the work order approver list can set the cap's start date."],
  ["work_order_cap_start_reason_invalid", 400, "reason_invalid", "Give a reason of 3 to 500 characters."],
  ["work_order_cap_start_changed", 409, "cap_start_changed", "The start date changed since you read it. Read it again, then set it."],
  ["work_order_cap_start_not_recorded", 503, "cap_start_unrecorded", "The start date was not saved because its record could not be written. Try again in a minute."],
  ["work_order_cap_settings_missing", 409, "cap_settings_missing", "The cap's settings row is missing, so no job is capped. Tell the office."],
  ["work_order_cap_start_clear_while_on", 409, "cap_start_clear_while_on", "The start date cannot be cleared while held lines are on: no job would be capped by its work order. Turn held lines off first, or pick a day."],
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
    // work_order_cap_settings_pkey; the record by its primary key, newest
    // first; the held-lines switch by flag_name (feature_flags_pkey).
    const [settings, changes, flag] = await Promise.all([
      client.from("work_order_cap_settings").select("cap_start_on, updated_at").eq("id", 1).limit(1),
      client.from("work_order_cap_start_changes")
        .select("id, changed_at, previous_start, new_start, via, set_by, set_by_email, authority, reason, db_role")
        .order("id", { ascending: false }).limit(20),
      client.from("feature_flags").select("enabled").eq("flag_name", "trade_line_hold_v1").limit(1),
    ]);
    if (
      settings?.error || !Array.isArray(settings?.data) || changes?.error || !Array.isArray(changes?.data) ||
      flag?.error || !Array.isArray(flag?.data)
    ) {
      console.error("[ops-api] work_order_cap_start: unreadable");
      return refuse(503, "cap_start_unreadable", "The cap's start date could not be read. Try again in a minute.");
    }
    const row = settings.data[0];
    // No switch row reads as off, as every reader of the switch does.
    const holdOn = flag.data[0]?.enabled === true;
    return {
      status: 200,
      body: {
        ok: true,
        // No settings row reads exactly as no start date: no job is capped.
        settings_row: !!row,
        cap_start_on: row?.cap_start_on ?? null,
        updated_at: row?.updated_at ?? null,
        hold_switch_on: holdOn,
        warning: capStartWarning(holdOn, row?.cap_start_on ?? null),
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
  // A preview names what the change would do, for the screen to show before
  // the approver confirms; it writes nothing. The database checks the approver
  // list before it reads the date (work_order_cap_start_preview).
  if (body.preview === true) {
    let read: any;
    try {
      read = await client.rpc("work_order_cap_start_preview", { p_actor: ctx.userId });
    } catch {
      read = { error: { code: "thrown" } };
    }
    if (read?.error) {
      if (String(read.error?.message || "").includes("work_order_cap_start_not_approver")) {
        return refuse(403, "approver_required", SET_REFUSALS[0][3]);
      }
      console.error("[ops-api] set_work_order_cap_start: preview_unreadable", read.error?.code || "unknown");
      return refuse(503, "cap_start_unreadable", "The cap's start date could not be read. Try again in a minute.");
    }
    const d = read?.data;
    const saved = d && typeof d === "object" ? dayOrNull(d.cap_start_on ?? null) : undefined;
    if (saved === undefined || typeof d.hold_switch_on !== "boolean") {
      console.error("[ops-api] set_work_order_cap_start: preview_malformed");
      return refuse(503, "cap_start_unreadable", "The cap's start date could not be read. Try again in a minute.");
    }
    const change = capStartChangeWords(saved, start, d.hold_switch_on);
    return {
      status: 200,
      body: {
        ok: true, preview: true, cap_start_on: saved, proposed_start: start,
        shown_matches: saved === shown, hold_switch_on: d.hold_switch_on,
        effect: change.effect, refused: change.refused, words: change.words,
        warning: capStartWarning(d.hold_switch_on, saved),
      },
    };
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
  const holdOn = typeof data.hold_switch_on === "boolean" ? data.hold_switch_on : null;
  const done = data.changed === true
    ? capStartChangeWords(data.previous_start ?? null, data.cap_start_on ?? null, holdOn)
    : capStartChangeWords(start, start, holdOn);
  return {
    status: 200,
    body: {
      ok: true,
      effect: done.effect,
      words: done.words,
      changed: data.changed,
      cap_start_on: data.cap_start_on ?? null,
      previous_start: data.previous_start ?? null,
      authority: data.authority ?? null,
      hold_switch_on: holdOn,
      warning: capStartWarning(holdOn, data.cap_start_on ?? null),
    },
  };
}

// The office's held trade lines (P1-05.10, ruling 16): the list of lines a
// trade sent that wait on the office, and the one decision door, which calls
// decide_held_trade_line (20261119091000). Read and decide only through these
// two; the database function holds every money rule, so nothing here prices
// a line or moves a pay figure.
//
// Who: a signed-in staff person in their own company. The server key is no
// person and is refused (403), as the pay run doors refuse it. The decision's
// own staff, approver and own-claim checks stay in the database.

export const HELD_LINE_SWITCH = "trade_line_hold_v1";

export class HeldTradeLineError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000;
const ID_CHUNK = 25;

const LINE_COLUMNS =
  "id, trade_invoice_id, job_id, job_number, line_type, description, work_date, total_hours, hourly_rate, line_total_ex, sent_amount_ex, hold_reason, office_review_status, office_review_note";
const INVOICE_COLUMNS =
  "id, org_id, user_id, invoice_number, week_start, week_end, invoice_kind, status, pay_run_id, xero_bill_id";

function unreadable(what: string): HeldTradeLineError {
  return new HeldTradeLineError(
    "held_lines_unreadable",
    `Could not read ${what}. Nothing was changed.`,
    503,
  );
}

function person(opts: { orgId?: string | null; actorUserId?: string | null }) {
  const orgId = String(opts.orgId ?? "").trim();
  const actor = String(opts.actorUserId ?? "").trim();
  if (!UUID_RE.test(actor)) {
    throw new HeldTradeLineError(
      "held_line_person_required",
      "Only a signed-in office person can read or decide held lines.",
      403,
    );
  }
  if (!UUID_RE.test(orgId)) {
    throw new HeldTradeLineError(
      "held_line_no_org",
      "Your profile has no organisation, so held lines cannot be read.",
      403,
    );
  }
  return { orgId, actor };
}

export type HeldLineListDeps = {
  switchOn(): Promise<boolean>;
  /** Lines held for the office and not yet decided. */
  heldLines(): Promise<Array<Record<string, any>>>;
  invoicesById(ids: string[]): Promise<Array<Record<string, any>>>;
  /** The office person's role and company (the decision's own staff rule). */
  staff(actor: string, orgId: string): Promise<boolean>;
  namesById(ids: string[], orgId: string): Promise<Map<string, string>>;
};

/**
 * GET held_trade_lines: every line in the caller's company held for the
 * office, still awaiting or queried, on a holding invoice that no pay run or
 * Xero bill has taken (the lines decide_held_trade_line can decide).
 * `enabled` is trade_line_hold_v1: the decision door refuses while it is off.
 */
export async function listHeldTradeLines(
  deps: HeldLineListDeps,
  opts: { orgId?: string | null; actorUserId?: string | null },
): Promise<Record<string, unknown>> {
  const { orgId, actor } = person(opts);
  if (!await deps.staff(actor, orgId)) {
    throw new HeldTradeLineError(
      "held_line_staff_required",
      "Only office staff can read held lines.",
      403,
    );
  }
  const enabled = await deps.switchOn();
  const held = await deps.heldLines();
  const invoiceIds = [...new Set(held.map((l) => String(l.trade_invoice_id)))];
  const invoices = new Map(
    (await deps.invoicesById(invoiceIds)).map((i) => [String(i.id), i]),
  );
  const open = held.filter((l) => {
    const i = invoices.get(String(l.trade_invoice_id));
    return !!i && i.org_id === orgId && i.invoice_kind === "held" &&
      i.status === "pending_ops_review" && i.pay_run_id == null &&
      i.xero_bill_id == null;
  });
  const userIds = [
    ...new Set(
      open.map((l) => invoices.get(String(l.trade_invoice_id))?.user_id)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ];
  const names = await deps.namesById(userIds, orgId);
  const lines = open.map((l) => {
    const i = invoices.get(String(l.trade_invoice_id))!;
    return {
      id: l.id,
      trade_invoice_id: l.trade_invoice_id,
      invoice_number: i.invoice_number ?? null,
      trade_user_id: i.user_id ?? null,
      trade_name: (i.user_id && names.get(String(i.user_id))) || null,
      week_start: i.week_start ?? null,
      week_end: i.week_end ?? null,
      job_id: l.job_id ?? null,
      job_number: l.job_number ?? null,
      line_type: l.line_type ?? null,
      description: l.description ?? null,
      work_date: l.work_date ?? null,
      total_hours: l.total_hours ?? null,
      hourly_rate: l.hourly_rate ?? null,
      line_total_ex: l.line_total_ex ?? null,
      sent_amount_ex: l.sent_amount_ex ?? null,
      hold_reason: l.hold_reason,
      office_review_status: l.office_review_status,
      office_review_note: l.office_review_note ?? null,
    };
  }).sort((a, b) =>
    String(a.week_start ?? "").localeCompare(String(b.week_start ?? "")) ||
    String(a.invoice_number ?? "").localeCompare(String(b.invoice_number ?? "")) ||
    String(a.id).localeCompare(String(b.id))
  );
  return { ok: true, enabled, count: lines.length, lines };
}

export function heldLineListDepsFromClient(
  client: any,
  switchOn: () => Promise<boolean>,
): HeldLineListDeps {
  return {
    switchOn,
    async heldLines() {
      const rows: any[] = [];
      for (let from = 0;; from += PAGE) {
        const { data, error } = await client.from("trade_invoice_lines")
          .select(LINE_COLUMNS)
          .not("hold_reason", "is", null)
          .in("office_review_status", ["awaiting", "queried"])
          .order("id").range(from, from + PAGE - 1);
        if (error || !Array.isArray(data)) throw unreadable("the held lines");
        rows.push(...data);
        if (data.length < PAGE) return rows;
      }
    },
    async invoicesById(ids) {
      const rows: any[] = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data, error } = await client.from("trade_invoices")
          .select(INVOICE_COLUMNS).in("id", ids.slice(i, i + ID_CHUNK));
        if (error || !Array.isArray(data)) throw unreadable("the held invoices");
        rows.push(...data);
      }
      return rows;
    },
    async staff(actor, orgId) {
      const { data, error } = await client.from("users").select("id, org_id, role")
        .eq("id", actor).maybeSingle();
      if (error) throw unreadable("your profile");
      return !!data && data.org_id === orgId &&
        ["admin", "owner", "ops_manager"].includes(String(data.role));
    },
    async namesById(ids, orgId) {
      const out = new Map<string, string>();
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data, error } = await client.from("users").select("id, name, org_id")
          .in("id", ids.slice(i, i + ID_CHUNK));
        if (error || !Array.isArray(data)) throw unreadable("the trades' names");
        for (const u of data) {
          if (u.org_id === orgId && typeof u.name === "string") out.set(String(u.id), u.name);
        }
      }
      return out;
    },
  };
}

/** HTTP status for each refusal the database function raises. */
export const HELD_LINE_REFUSAL_STATUS: Readonly<Record<string, number>> = {
  held_line_switch_off: 409,
  held_line_staff_required: 403,
  approver_required: 403,
  held_line_own_claim: 403,
  held_line_not_found: 404,
  held_line_already_decided: 409,
  held_line_reason_required: 400,
  held_line_invalid_decision: 400,
  held_line_invalid_amount: 400,
  held_line_invalid_hours: 400,
  held_line_needs_job_or_type: 400,
  held_line_amount_changed: 409,
  held_line_above_sent: 409,
  held_line_commission_claimed: 409,
  held_line_commission_not_known: 409,
  held_line_crew_week_missing: 409,
  held_line_follow_on_changed: 409,
  held_line_invalid_send: 409,
  held_line_job_not_backed: 409,
  held_line_not_balanced: 409,
  held_line_original_gst_missing: 409,
  work_order_split_locked: 409,
  held_line_decision_failed: 500,
};

/** Plain words for each refusal; codes only ever reach a log. */
export const HELD_LINE_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  held_line_switch_off: "Held lines cannot be decided yet: the switch is off.",
  held_line_staff_required: "Only office staff can decide a held line.",
  approver_required: "Only a pay run approver can decide this line.",
  held_line_own_claim: "You cannot decide a line on your own invoice.",
  held_line_not_found: "That held line was not found, or is no longer waiting for the office.",
  held_line_already_decided: "That line has already been decided.",
  held_line_reason_required: "Give a reason of 3 to 500 characters.",
  held_line_invalid_decision: "Choose approve, decline or query. Only an approval may change the line.",
  held_line_invalid_amount: "That amount cannot be used.",
  held_line_invalid_hours: "Those hours cannot be used.",
  held_line_needs_job_or_type: "Name the job, or the kind of work that is not on a job.",
  held_line_amount_changed: "The line changed since it was read. Read it again.",
  held_line_above_sent: "An approval cannot pay more than the trade sent.",
  held_line_commission_claimed: "The commission on that job is already claimed.",
  held_line_commission_not_known: "The commission on that job is not known.",
  held_line_crew_week_missing: "The trade's invoice for that week is missing.",
  held_line_follow_on_changed: "The follow-on invoice changed. Read it again.",
  held_line_invalid_send: "That invoice's send does not add up. Ask for it to be checked.",
  held_line_job_not_backed: "That job has no room on its work order for this line.",
  held_line_not_balanced: "The send would not balance. Nothing was changed.",
  held_line_original_gst_missing: "The original invoice's GST is missing.",
  work_order_split_locked: "That work order's split is locked.",
  held_line_decision_failed: "The decision could not be saved. Nothing was changed.",
};

export type HeldLineDecideDeps = {
  decide(params: {
    p_line_id: string;
    p_decision: string;
    p_actor: string;
    p_org_id: string;
    p_changes: Record<string, unknown>;
    p_reason: string;
  }): Promise<{ data: any; error: any }>;
};

/**
 * POST decide_held_trade_line { line_id, decision: approve|decline|query,
 * reason, changes? }: one call to the database function, as the signed-in
 * staff person in their own company. Refusals come back with the function's
 * code and plain words; nothing here changes a line.
 */
export async function decideHeldTradeLine(
  deps: HeldLineDecideDeps,
  opts: {
    orgId?: string | null;
    actorUserId?: string | null;
    lineId?: unknown;
    decision?: unknown;
    reason?: unknown;
    changes?: unknown;
  },
): Promise<Record<string, unknown>> {
  const { orgId, actor } = person(opts);
  const lineId = String(opts.lineId ?? "").trim();
  if (!UUID_RE.test(lineId)) {
    throw new HeldTradeLineError("held_line_not_found", HELD_LINE_REFUSAL_WORDS.held_line_not_found, 404);
  }
  const changes = opts.changes ?? {};
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) {
    throw new HeldTradeLineError(
      "held_line_invalid_decision",
      HELD_LINE_REFUSAL_WORDS.held_line_invalid_decision,
      400,
    );
  }
  const { data, error } = await deps.decide({
    p_line_id: lineId,
    p_decision: String(opts.decision ?? ""),
    p_actor: actor,
    p_org_id: orgId,
    p_changes: changes as Record<string, unknown>,
    p_reason: typeof opts.reason === "string" ? opts.reason : "",
  });
  if (error) {
    const code = String(error.message ?? "").trim();
    if (Object.hasOwn(HELD_LINE_REFUSAL_STATUS, code)) {
      throw new HeldTradeLineError(code, HELD_LINE_REFUSAL_WORDS[code], HELD_LINE_REFUSAL_STATUS[code]);
    }
    throw new HeldTradeLineError(
      "held_line_decision_unreadable",
      "The decision could not be confirmed. Read the line again before deciding.",
      503,
    );
  }
  if (!data || typeof data !== "object") {
    throw new HeldTradeLineError(
      "held_line_decision_unreadable",
      "The decision could not be confirmed. Read the line again before deciding.",
      503,
    );
  }
  return { ok: true, ...data };
}

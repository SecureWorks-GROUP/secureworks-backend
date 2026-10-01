// Debt desk actions (plan step 3, docs/debt-book/PLAN.md sections 4 and 6). Screen contract:
// secureworks-ux docs/clear-debt-desk.md. The captain's rulings: docs/debt-book/DECISIONS.md.
//
//   debt_draft_decide  POST  approve (with the text, edited or not) or skip one morning-list
//                            draft. Desk owner only. Records the owner's user id on an approval.
//   debt_log_outcome   POST  what a call or Jan's visit achieved (no answer, spoke, promised,
//                            disputed, says paid; for Jan: no one home, visited and paid,
//                            promised or disputed). Any signed-in staff user. A promise stamps
//                            the covered invoices' amount due, read live from Xero, so a part
//                            payment can keep it.
//   debt_draft_send    POST  send approved drafts, one at a time. Desk owner only. Off until
//                            Shaun says start sending: DEBT_SENDING_ENABLED must be exactly
//                            "true". Every attempt while off is refused and logged. When on,
//                            each invoice is re-read live from Xero first, the draft is claimed
//                            (a 'sending' row per invoice, unique per draft and invoice), and
//                            the text goes only through the existing send_chase_sms path.
//                            Jan's morning text (debt_jan_text.ts, plan step 5) goes the same
//                            way, to Jan's own mobile through the staff SMS path, and only
//                            while Jan's mobile is set and is the number it was approved for.
//
// The desk owner approves every message (captain: "shaun" owns the desk): the user ids in
// DEBT_DESK_OWNER_USER_IDS when that secret is set, otherwise the owner list in
// debt_desk_settings (seeded with Shaun's users.id). Never a role: several users hold
// ops_manager. With no owner, nobody can approve or send ("desk owner not set").
//
// Every write is a payment_chase_logs row per covered invoice (columns from
// 20261001100000_debt_desk_chase_log.sql). Rows carrying a draft id but no "sent" never move
// the chase ladder (debtChaseEventFromLogRow). Apart from the text debt_draft_send hands to
// send_chase_sms, no action here writes to Xero, GHL or a job.

import {
  DEBT_CHASE_OUTCOMES,
  type DebtChaseEvent,
  debtChaseEventFromLogRow,
  type DebtChaseOutcome,
  debtOutcomeLabel,
} from "./debt_chase_schedule.ts";
import { type DebtDraftDecision, debtDraftStates } from "./debt_desk_drafts.ts";
import {
  debtDraftTextProblem,
  parseDebtDraftId,
} from "./debt_draft_templates.ts";
import {
  JAN_TEXT_STEP,
  type JanMobile,
  janTextDraftIdMatches,
  janTextProblem,
  janTextTemplateMatches,
} from "./debt_jan_text.ts";

export const DEBT_DESK_VERSION = "debt-desk/v1";
/** The one switch. Sending stays off unless this is exactly "true" (captain: "my go"). */
export const DEBT_SENDING_SWITCH = "DEBT_SENDING_ENABLED";
/** Comma-separated user ids who may approve and send. Unset: the owner list in debt_desk_settings; never a role. */
export const DEBT_DESK_OWNERS_SETTING = "DEBT_DESK_OWNER_USER_IDS";
export const DEBT_SEND_BATCH_LIMIT = 20;

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_CHUNK = 50;
const PAGE = 1000;

export class DebtDeskError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "debt_desk_bad_request",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DebtDeskError";
  }
}

/** send_chase_sms refused in its own guards, before any SMS was handed to GoHighLevel. */
export class DebtSendRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebtSendRefusedError";
  }
}

/** The signed-in staff user. Approvals, outcomes and sends are a person's act. */
export interface DebtDeskActor {
  user_id: string;
  email: string | null;
}

export interface DebtDeskStore {
  /** One insert of every row; a PostgREST error is thrown, never swallowed. */
  insertChaseRows(rows: Record<string, unknown>[]): Promise<void>;
  /**
   * Inserts a send's claim rows (outcome_code sending) in one statement. False when the
   * draft is already claimed or sent on one of its invoices (the unique claim index).
   */
  claimSend(rows: Record<string, unknown>[]): Promise<boolean>;
  /** Updates the draft's claim rows on these invoices; throws unless every one changed. */
  settleSend(
    draftId: string,
    xeroInvoiceIds: string[],
    patch: Record<string, unknown>,
  ): Promise<void>;
  draftRows(draftId: string): Promise<Record<string, unknown>[]>;
  chaseLogRows(xeroInvoiceIds: string[]): Promise<Record<string, unknown>[]>;
  invoiceJobLinks(
    xeroInvoiceIds: string[],
  ): Promise<Array<{ xero_invoice_id: string; job_id: string | null }>>;
  jobGhlContacts(
    jobIds: string[],
  ): Promise<Array<{ id: string; ghl_contact_id: string | null }>>;
  /** The owner list in debt_desk_settings (users.id values); empty when none is set. */
  deskOwnerSetting(): Promise<string[]>;
}

export interface DebtDeskDeps {
  store: DebtDeskStore;
  /** One live Xero read of one invoice (get_xero_receivable). Returns the raw Xero invoice. */
  readInvoice: (xeroInvoiceId: string) => Promise<Record<string, unknown>>;
  /** The existing ops-api send_chase_sms path. */
  sendSms?: (
    body: Record<string, unknown>,
  ) => Promise<{ success?: boolean; message_id?: string | null }>;
  /** Jan's mobile, read now (debt_jan_text.ts readJanMobile). Absent: not set. */
  janMobile?: () => Promise<JanMobile>;
  /**
   * The staff SMS path to one raw mobile (ghl-proxy send_sms with a phone), for Jan's text.
   * Accepted only with a provider message id.
   */
  sendStaffSms?: (
    phone: string,
    message: string,
  ) => Promise<
    {
      accepted: boolean;
      messageId: string | null;
      failureReason: string | null;
    }
  >;
  /** DEBT_SENDING_ENABLED is exactly "true". */
  sendingEnabled: boolean;
  /** The user ids who may approve and send (debtDeskOwnerIds). */
  deskOwnerIds: () => Promise<string[]>;
  now?: () => Date;
}

/** The switch, read from the server's environment. Anything but exactly "true" is off. */
export function debtSendingEnabled(
  get: (name: string) => string | undefined = (name) => Deno.env.get(name),
): boolean {
  return get(DEBT_SENDING_SWITCH) === "true";
}

/**
 * The desk owners. When DEBT_DESK_OWNER_USER_IDS is set, exactly its valid user ids (an
 * unusable value means nobody, never everybody); otherwise the debt_desk_settings owner
 * list. Never a role. Empty means nobody can approve or send.
 */
export async function debtDeskOwnerIds(
  store: Pick<DebtDeskStore, "deskOwnerSetting">,
  get: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Promise<string[]> {
  const setting = get(DEBT_DESK_OWNERS_SETTING)?.trim();
  if (setting) {
    return setting.split(",").map((id) => id.trim().toLowerCase()).filter((
      id,
    ) => UUID.test(id));
  }
  return (await store.deskOwnerSetting()).map((id) => String(id).toLowerCase())
    .filter((id) => UUID.test(id));
}

// ── Helpers ──

const JAN_NOT_WIRED: JanMobile = {
  phone: null,
  source: null,
  staff_user_id: null,
  staff_name: null,
  problem: "Jan's mobile not set: the desk cannot read it here",
};

async function janMobileOf(deps: DebtDeskDeps): Promise<JanMobile> {
  return deps.janMobile ? await deps.janMobile() : JAN_NOT_WIRED;
}

const cents = (n: number) => Math.round(Number(n || 0) * 100);
const money = (n: number) => `$${(cents(n) / 100).toFixed(2)}`;

function perthDate(now: Date): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

function bad(message: string): never {
  throw new DebtDeskError(message, 400, "debt_desk_bad_request");
}

function requireActor(actor: DebtDeskActor | null | undefined): DebtDeskActor {
  if (
    !actor || typeof actor.user_id !== "string" || !UUID.test(actor.user_id)
  ) {
    throw new DebtDeskError(
      "A signed-in staff user is required: the desk records who approved and who logged",
      403,
      "debt_desk_user_required",
    );
  }
  return { user_id: actor.user_id.toLowerCase(), email: actor.email ?? null };
}

/**
 * The desk as the signed-in viewer sees it, for the morning list: whether an owner is named,
 * whether this viewer is it, and whether sending is on. An unreadable owner setting reads as
 * "not known" (owner_set null) and never as the viewer being the owner.
 */
export async function debtDeskState(
  actor: DebtDeskActor | null | undefined,
  deps: Pick<DebtDeskDeps, "deskOwnerIds" | "sendingEnabled">,
) {
  let owners: string[] | null = null;
  try {
    owners = await deps.deskOwnerIds();
  } catch (error) {
    console.error(
      "[debt_desk] desk owner unreadable",
      (error as Error)?.message ?? error,
    );
  }
  const viewer = typeof actor?.user_id === "string"
    ? actor.user_id.toLowerCase()
    : null;
  return {
    owner_set: owners === null ? null : owners.length > 0,
    viewer_is_owner: !!viewer && !!owners?.includes(viewer),
    sending_enabled: deps.sendingEnabled,
    note: owners === null
      ? "The desk owner could not be read"
      : owners.length
      ? null
      : "Desk owner not set: nobody can approve or send",
  };
}

async function requireDeskOwner(actor: DebtDeskActor, deps: DebtDeskDeps) {
  const owners = await deps.deskOwnerIds();
  if (!owners.length) {
    throw new DebtDeskError(
      "Desk owner not set: nobody can approve or send until the desk owner is named (DEBT_DESK_OWNER_USER_IDS or debt_desk_settings)",
      403,
      "debt_desk_owner_not_set",
    );
  }
  if (!owners.includes(actor.user_id)) {
    throw new DebtDeskError(
      "Only the desk owner (Shaun) approves and sends debt messages",
      403,
      "debt_desk_owner_required",
    );
  }
}

function onlyKeys(body: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(body)) {
    if (key !== "action" && !allowed.includes(key)) {
      bad(`Unsupported field: ${key}`);
    }
  }
}

function asBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    bad("The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function invoiceIds(value: unknown, max = IN_CHUNK): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) {
    bad(`xero_invoice_ids must list 1 to ${max} Xero invoice ids`);
  }
  const ids = value.map((v) => {
    if (typeof v !== "string" || !UUID.test(v)) {
      bad("xero_invoice_ids must be Xero invoice ids");
    }
    return v.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) bad("xero_invoice_ids repeats an id");
  return ids;
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

// ── debt_draft_decide ──

export async function debtDraftDecide(
  rawBody: unknown,
  rawActor: DebtDeskActor | null | undefined,
  deps: DebtDeskDeps,
) {
  const actor = requireActor(rawActor);
  await requireDeskOwner(actor, deps);
  const body = asBody(rawBody);
  onlyKeys(body, [
    "draft_id",
    "decision",
    "text",
    "xero_invoice_ids",
    "template_text",
  ]);
  const draft = parseDebtDraftId(body.draft_id);
  const draftId = String(body.draft_id);
  if (!draft) {
    throw new DebtDeskError(
      "That is not one of the desk's draft ids",
      400,
      "debt_draft_unknown",
    );
  }
  const today = perthDate(deps.now?.() ?? new Date());
  if (draft.perth_date !== today) {
    throw new DebtDeskError(
      `That draft is from ${draft.perth_date}; read today's list and decide today's draft`,
      409,
      "debt_draft_not_today",
    );
  }
  const decision = body.decision;
  if (decision !== "approve" && decision !== "skip") {
    bad('decision must be "approve" or "skip"');
  }
  const ids = invoiceIds(body.xero_invoice_ids);
  if (ids.length !== draft.amounts.length) {
    bad(
      `This draft covers ${draft.amounts.length} invoice(s); send its invoice ids in the item's order`,
    );
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const jan = draft.step === JAN_TEXT_STEP;
  if (!jan && body.template_text !== undefined) {
    bad("template_text is only for Jan's text");
  }
  if (decision === "approve") {
    if (jan && !janTextTemplateMatches(draftId, body.template_text)) {
      throw new DebtDeskError(
        "Send Jan's text with its template_text from today's list: that is not the wording this draft was made from",
        409,
        "debt_draft_invoices_changed",
      );
    }
    const problem = jan
      ? janTextProblem(text, body.template_text as string)
      : debtDraftTextProblem(text);
    if (problem) {
      throw new DebtDeskError(problem, 400, "debt_draft_text_not_allowed");
    }
  }
  if (jan) {
    // Jan's text is tied to the number and the list Shaun saw. It cannot be approved while
    // Jan's mobile is not set; a skip needs no number.
    const mobile = await janMobileOf(deps);
    if (decision === "approve" && !mobile.phone) {
      throw new DebtDeskError(
        mobile.problem ?? "Jan's mobile not set",
        409,
        "jan_mobile_not_set",
      );
    }
    if (!janTextDraftIdMatches(draftId, mobile.phone ?? "", ids)) {
      throw new DebtDeskError(
        "That Jan text was drafted for another mobile number or another list: read today's list again",
        409,
        "debt_draft_invoices_changed",
      );
    }
  }

  const state = debtDraftStates(await deps.store.draftRows(draftId))
    .get(draftId);
  if (state?.decision?.kind === "sent") {
    throw new DebtDeskError(
      "That draft was already sent",
      409,
      "debt_draft_already_sent",
    );
  }
  if (state?.decision?.kind === "sending") {
    throw new DebtDeskError(
      "That draft was claimed by a send that is not confirmed, so it cannot be decided again today",
      409,
      "debt_draft_sending",
    );
  }
  const earlier = state?.rows.find((r) => r.kind !== "failed");
  if (earlier && !sameIds(earlier.covers, ids)) {
    throw new DebtDeskError(
      "Those invoices are not the ones this draft was decided on",
      409,
      "debt_draft_invoices_changed",
    );
  }

  const approve = decision === "approve";
  await deps.store.insertChaseRows(ids.map((id, k) => ({
    xero_invoice_id: id,
    method: "sms",
    direction: "outbound",
    // Jan's text carries no step: it is not a step of any payer's ladder.
    schedule_step: jan ? null : draft.step,
    draft_id: draftId,
    draft_amount: draft.amounts[k],
    covers_invoice_ids: ids,
    outcome_code: approve ? null : "skipped",
    outcome: approve ? "approved" : "skipped",
    notes: text || null,
    approved_by_user_id: approve ? actor.user_id : null,
    chased_by: actor.email,
    automated: false,
  })));

  const after = debtDraftStates(await deps.store.draftRows(draftId))
    .get(draftId);
  return {
    ok: true,
    version: DEBT_DESK_VERSION,
    draft: {
      id: draftId,
      channel: "sms" as const,
      to: jan ? "jan" as const : "client" as const,
      step: draft.step,
      status: approve ? "approved" as const : "skipped" as const,
      text: text || null,
      approved_by: approve ? actor.email : after?.approval?.by ?? null,
      approved_by_user_id: approve
        ? actor.user_id
        : after?.approval?.user_id ?? null,
      decided_at: after?.decision?.at ?? null,
    },
  };
}

// ── debt_log_outcome ──

const OUTCOME_STEPS = ["call", "builder_call", "jan_visit"] as const;

function liveAmountDue(invoice: Record<string, unknown>) {
  const due = Number(invoice.AmountDue);
  return Number.isFinite(due) ? due : NaN;
}

async function readLive(deps: DebtDeskDeps, id: string) {
  try {
    return await deps.readInvoice(id);
  } catch (error) {
    throw new DebtDeskError(
      "Xero could not be read for that invoice, so nothing was logged. Try again shortly",
      502,
      "debt_xero_read_failed",
      {
        xero_invoice_id: id,
        cause: String((error as Error)?.message ?? error).slice(0, 200),
      },
    );
  }
}

export async function debtLogOutcome(
  rawBody: unknown,
  rawActor: DebtDeskActor | null | undefined,
  deps: DebtDeskDeps,
) {
  const actor = requireActor(rawActor);
  const body = asBody(rawBody);
  onlyKeys(body, [
    "xero_invoice_ids",
    "outcome_code",
    "promised_amount",
    "promised_date",
    "note",
    "channel",
    "schedule_step",
  ]);
  const ids = invoiceIds(body.xero_invoice_ids);
  const code = body.outcome_code as DebtChaseOutcome;
  if (!DEBT_CHASE_OUTCOMES.includes(code)) {
    bad(`outcome_code must be one of ${DEBT_CHASE_OUTCOMES.join(", ")}`);
  }
  const step = (body.schedule_step ?? null) as
    | (typeof OUTCOME_STEPS)[number]
    | null;
  if (step !== null && !(OUTCOME_STEPS as readonly unknown[]).includes(step)) {
    bad(
      `schedule_step must be one of ${
        OUTCOME_STEPS.join(", ")
      } or null; texts and statements are stamped by their send`,
    );
  }
  const channel = body.channel ?? "call";
  if (channel !== "call" && channel !== "visit") {
    bad('channel must be "call" or "visit"');
  }
  const method = step === "jan_visit" ? "visit" : channel;
  const note = body.note === undefined || body.note === null
    ? null
    : typeof body.note === "string"
    ? body.note.trim().slice(0, 2000) || null
    : bad("note must be text");

  let promise: {
    amount: number;
    date: string;
    dueAtPromise: number;
  } | null = null;
  if (code === "promised") {
    const amount = Number(body.promised_amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
      bad("promised_amount must be a positive amount");
    }
    const date = body.promised_date;
    const today = perthDate(deps.now?.() ?? new Date());
    if (
      typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    ) bad("promised_date must be YYYY-MM-DD");
    if (date < today) bad("promised_date cannot be before today");
    // Read in sequence, never fanned out: Xero allows 60 calls a minute.
    let due = 0;
    for (const id of ids) {
      const inv = await readLive(deps, id);
      const d = liveAmountDue(inv);
      if (inv.Status !== "AUTHORISED" || !(d > 0)) {
        throw new DebtDeskError(
          `Xero shows ${inv.InvoiceNumber ?? id} is not open (${inv.Status}, ${
            money(d || 0)
          } due), so a promise cannot be logged against it`,
          409,
          "debt_invoice_not_open",
        );
      }
      due += cents(d);
    }
    if (cents(amount) > due) {
      throw new DebtDeskError(
        `The promise (${money(amount)}) is more than Xero shows owing (${
          money(due / 100)
        })`,
        409,
        "debt_promise_more_than_due",
      );
    }
    promise = {
      amount: cents(amount) / 100,
      date: date as string,
      dueAtPromise: due / 100,
    };
  }

  await deps.store.insertChaseRows(ids.map((id) => ({
    xero_invoice_id: id,
    method,
    direction: "outbound",
    outcome_code: code,
    outcome: debtOutcomeLabel(code, step),
    notes: note,
    schedule_step: step,
    promised_amount: promise?.amount ?? null,
    promised_date: promise?.date ?? null,
    amount_due_at_promise: promise?.dueAtPromise ?? null,
    covers_invoice_ids: ids,
    chased_by: actor.email,
    automated: false,
  })));
  return {
    ok: true,
    version: DEBT_DESK_VERSION,
    logged: {
      outcome_code: code,
      label: debtOutcomeLabel(code, step),
      schedule_step: step,
      method,
      xero_invoice_ids: ids,
      promised_amount: promise?.amount ?? null,
      promised_date: promise?.date ?? null,
      amount_due_at_promise: promise?.dueAtPromise ?? null,
      by: actor.email,
      rows: ids.length,
    },
  };
}

// ── debt_draft_send ──

type SendResult = {
  draft_id: string;
  sent: boolean;
  code?: string;
  reason?: string;
  provider_message_id?: string | null;
  logged: boolean;
};

class Refusal {
  constructor(readonly code: string, readonly reason: string) {}
}

const CLIENT_TEXT_STEPS = ["friendly_text", "firm_text", "deposit_reminder"];

function isRateLimit(error: unknown): boolean {
  const e = error as { name?: string; status?: number } | null;
  return e?.name === "XeroCooldownError" || e?.status === 429;
}

/** Why a live Xero invoice must not get this text, or null when it may. */
function lastCheckProblem(
  inv: Record<string, unknown>,
  draftAmount: number | null,
): Refusal | null {
  const number = String(inv.InvoiceNumber ?? inv.InvoiceID ?? "the invoice");
  const due = liveAmountDue(inv);
  const status = String(inv.Status ?? "");
  if (status === "VOIDED" || status === "DELETED") {
    return new Refusal(
      "voided",
      `Xero shows ${number} ${status.toLowerCase()}: nothing to chase`,
    );
  }
  if (status === "PAID" || (status === "AUTHORISED" && !(due > 0))) {
    return new Refusal(
      "paid",
      `Xero shows ${number} paid: the text was not sent`,
    );
  }
  if (status !== "AUTHORISED") {
    return new Refusal(
      "not_authorised",
      `Xero shows ${number} as ${status}, not an open invoice`,
    );
  }
  if (draftAmount === null) {
    return new Refusal(
      "draft_amount_missing",
      `The approval for ${number} carries no amount to check`,
    );
  }
  if (cents(due) < cents(draftAmount)) {
    return new Refusal(
      "part_paid",
      `Xero shows ${money(due)} owing on ${number}, less than the ${
        money(draftAmount)
      } the text says: paid, part paid or credited since the draft`,
    );
  }
  return null;
}

export async function debtDraftSend(
  rawBody: unknown,
  rawActor: DebtDeskActor | null | undefined,
  deps: DebtDeskDeps,
) {
  const actor = requireActor(rawActor);
  await requireDeskOwner(actor, deps);
  const body = asBody(rawBody);
  onlyKeys(body, ["draft_ids"]);
  const list = body.draft_ids;
  if (
    !Array.isArray(list) || !list.length ||
    list.length > DEBT_SEND_BATCH_LIMIT ||
    !list.every((d) => typeof d === "string")
  ) {
    bad(`draft_ids must list 1 to ${DEBT_SEND_BATCH_LIMIT} draft ids`);
  }
  const today = perthDate(deps.now?.() ?? new Date());
  const results: SendResult[] = [];
  let stopped: Refusal | null = null;

  // Strictly one draft after another: one live Xero read per invoice, then one SMS.
  for (const draftId of list as string[]) {
    const parsed = parseDebtDraftId(draftId);
    if (!parsed) {
      results.push({
        draft_id: draftId,
        sent: false,
        code: "draft_unknown",
        reason: "That is not one of the desk's draft ids",
        logged: false,
      });
      continue;
    }
    const state = debtDraftStates(await deps.store.draftRows(draftId)).get(
      draftId,
    );
    const approval = state?.approval ?? null;
    const perInvoice = new Map<string, DebtDraftDecision>();
    for (const r of state?.rows ?? []) {
      if (r.kind === "approved" && approval && r.at === approval.at) {
        perInvoice.set(r.xero_invoice_id, r);
      }
    }
    const ids = approval?.covers ?? state?.rows[0]?.covers ?? [];
    const jan = parsed.step === JAN_TEXT_STEP;
    // Jan's text carries no step: it is not a step of any payer's ladder.
    const rowStep = jan ? null : parsed.step;

    const refuse = async (refusal: Refusal) => {
      let logged = false;
      if (ids.length) {
        try {
          await deps.store.insertChaseRows(ids.map((id) => ({
            xero_invoice_id: id,
            method: "sms",
            direction: "outbound",
            schedule_step: rowStep,
            draft_id: draftId,
            draft_amount: perInvoice.get(id)?.draft_amount ?? null,
            covers_invoice_ids: ids,
            outcome_code: "failed",
            outcome: `refused: ${refusal.code}`,
            notes: refusal.reason,
            chased_by: actor.email,
            automated: false,
          })));
          logged = true;
        } catch (error) {
          console.error("[debt_draft_send] refusal not logged", draftId, error);
        }
      }
      results.push({
        draft_id: draftId,
        sent: false,
        code: refusal.code,
        reason: refusal.reason,
        logged,
      });
    };

    if (!deps.sendingEnabled) {
      await refuse(
        new Refusal(
          "sending_off",
          "Sending is off until Shaun says start sending",
        ),
      );
      continue;
    }
    if (stopped) {
      await refuse(stopped);
      continue;
    }
    if (state?.decision?.kind === "sent") {
      await refuse(new Refusal("already_sent", "That draft was already sent"));
      continue;
    }
    if (state?.decision?.kind === "sending") {
      await refuse(
        new Refusal(
          "already_sending",
          "That draft was claimed by a send that is not confirmed, so it is not sent again",
        ),
      );
      continue;
    }
    if (!approval) {
      await refuse(
        new Refusal("not_approved", "Only an approved draft can be sent"),
      );
      continue;
    }
    if (state?.decision?.kind === "skipped") {
      await refuse(
        new Refusal("skipped", "That draft was skipped after it was approved"),
      );
      continue;
    }
    if (parsed.perth_date !== today) {
      await refuse(
        new Refusal(
          "approval_stale",
          `Approved for ${parsed.perth_date}; approve today's draft instead`,
        ),
      );
      continue;
    }
    if (!jan && !CLIENT_TEXT_STEPS.includes(parsed.step)) {
      await refuse(
        new Refusal("draft_unknown", "The desk does not send that step"),
      );
      continue;
    }
    if (!approval.text) {
      await refuse(new Refusal("no_text", "The approval carries no text"));
      continue;
    }

    try {
      // Anything logged on these invoices since the approval (a promise, a dispute, a call)
      // changes what should be said: the approval no longer stands.
      const since = (await deps.store.chaseLogRows(ids)).map(
        debtChaseEventFromLogRow,
      )
        .filter((e): e is DebtChaseEvent => e !== null)
        .filter((e) => e.at > approval.at);
      if (since.length) {
        await refuse(
          new Refusal(
            "chased_since_approval",
            "Something was logged on these invoices after the approval: read the list and approve again",
          ),
        );
        continue;
      }
      // Where it goes: the payer's GoHighLevel contact, or Jan's own mobile.
      let jobId: string | null = null;
      let contact: string | null = null;
      let janPhone: string | null = null;
      if (jan) {
        const mobile = await janMobileOf(deps);
        if (!mobile.phone) {
          await refuse(
            new Refusal(
              "jan_mobile_not_set",
              mobile.problem ?? "Jan's mobile not set",
            ),
          );
          continue;
        }
        if (!janTextDraftIdMatches(draftId, mobile.phone, ids)) {
          await refuse(
            new Refusal(
              "jan_mobile_changed",
              "Jan's mobile is not the number this text was approved for: read the list and approve again",
            ),
          );
          continue;
        }
        janPhone = mobile.phone;
      } else {
        const links = await deps.store.invoiceJobLinks(ids);
        jobId = links.find((l) => l.xero_invoice_id.toLowerCase() === ids[0])
          ?.job_id ?? null;
        contact = jobId
          ? (await deps.store.jobGhlContacts([jobId]))[0]?.ghl_contact_id ??
            null
          : null;
        if (!jobId || !contact) {
          await refuse(
            new Refusal(
              "no_contact",
              "The invoice's job has no GoHighLevel contact to text",
            ),
          );
          continue;
        }
      }

      // The last check: one live Xero read per invoice, in sequence.
      let problem: Refusal | null = null;
      for (const id of ids) {
        let inv: Record<string, unknown>;
        try {
          inv = await deps.readInvoice(id);
        } catch (error) {
          if (isRateLimit(error)) {
            stopped = new Refusal(
              "last_check_unavailable",
              "Xero is rate limited, so the last check could not run: nothing more was sent",
            );
            problem = stopped;
          } else {
            problem = new Refusal(
              "last_check_failed",
              "Xero could not be read for the last check, so the text was not sent",
            );
          }
          break;
        }
        problem = lastCheckProblem(
          inv,
          perInvoice.get(id)?.draft_amount ?? null,
        );
        if (problem) break;
      }
      if (problem) {
        await refuse(problem);
        continue;
      }
      if (jan ? !deps.sendStaffSms : !deps.sendSms) {
        throw new Error(
          jan
            ? "the staff SMS path is not wired"
            : "send_chase_sms is not wired",
        );
      }

      // The claim: at most one sending-or-sent row per draft and invoice, so an overlapping
      // send of this draft is refused here and never reaches the client.
      const claimed = await deps.store.claimSend(ids.map((id) => ({
        xero_invoice_id: id,
        job_id: id === ids[0] ? jobId : null,
        ghl_contact_id: contact,
        method: "sms",
        direction: "outbound",
        schedule_step: rowStep,
        draft_id: draftId,
        draft_amount: perInvoice.get(id)?.draft_amount ?? null,
        covers_invoice_ids: ids,
        outcome_code: "sending",
        outcome: "sending",
        notes: approval.text,
        approved_by_user_id: approval.user_id,
        chased_by: actor.email,
        automated: false,
      })));
      if (!claimed) {
        await refuse(
          new Refusal(
            "already_sending",
            "Another send already claimed that draft, so it is not sent again",
          ),
        );
        continue;
      }

      let messageId: string | null;
      try {
        if (janPhone) {
          const sent = await deps.sendStaffSms!(janPhone, approval.text);
          if (!sent?.accepted || !sent.messageId) {
            throw new Error(sent?.failureReason || "SMS send failed");
          }
          messageId = sent.messageId;
        } else {
          const sent = await deps.sendSms!({
            ghl_contact_id: contact,
            job_id: jobId,
            xero_invoice_id: ids[0],
            message: approval.text,
            operator_email: actor.email,
          });
          if (sent?.success === false) throw new Error("SMS send failed");
          messageId = sent?.message_id ?? null;
        }
      } catch (error) {
        // The provider may have sent it before failing, so the claim stays: the draft never
        // texts twice. Tomorrow's list drafts the step again.
        const why = String((error as Error)?.message ?? error).slice(0, 300);
        const refused = error instanceof DebtSendRefusedError;
        let logged = false;
        try {
          await deps.store.settleSend(draftId, ids, {
            outcome: refused
              ? `send refused: ${why}`
              : `send not confirmed: ${why}`,
          });
          logged = true;
        } catch (logError) {
          console.error(
            "[debt_draft_send] unconfirmed send not logged",
            draftId,
            logError,
          );
        }
        results.push({
          draft_id: draftId,
          sent: false,
          code: refused ? "send_refused_by_guard" : "send_not_confirmed",
          reason: refused
            ? `${why}. No text was sent, and the draft stays claimed so it cannot text twice`
            : `${why}. The draft stays claimed so it cannot text twice; check the GoHighLevel conversation`,
          logged,
        });
        continue;
      }

      let logged = false;
      try {
        await deps.store.settleSend(draftId, ids, {
          outcome_code: "sent",
          outcome: "sent",
          provider_message_id: messageId,
        });
        logged = true;
      } catch (error) {
        // The text went and the claim stays, so it is never sent again; only "sent" is missing.
        console.error(
          "[debt_draft_send] SENT BUT NOT LOGGED",
          draftId,
          messageId,
          error,
        );
      }
      results.push({
        draft_id: draftId,
        sent: true,
        provider_message_id: messageId,
        logged,
      });
    } catch (error) {
      if (error instanceof DebtDeskError) {
        await refuse(new Refusal(error.code, error.message));
        continue;
      }
      throw error;
    }
  }

  return {
    ok: true,
    version: DEBT_DESK_VERSION,
    sending_enabled: deps.sendingEnabled,
    results,
    sent: results.filter((r) => r.sent).length,
    refused: results.filter((r) => !r.sent).length,
  };
}

// ── The Supabase store ──

function chunks<T>(xs: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

// deno-lint-ignore no-explicit-any
function writeFailed(error: any): never {
  console.error(
    "[debt_desk] chase-log write failed",
    error?.code ?? "",
    error?.message ?? error,
  );
  throw new DebtDeskError(
    "The desk could not write the chase log",
    502,
    "debt_desk_write_failed",
  );
}

// deno-lint-ignore no-explicit-any
function readFailed(what: string, error: any): never {
  // A PostgREST error comes back, it is not thrown: an unread log must never read as empty.
  console.error(
    `[debt_desk] ${what} read failed`,
    error?.code ?? "",
    error?.message ?? error,
  );
  throw new DebtDeskError(
    `The desk could not read ${what}`,
    502,
    "debt_desk_read_failed",
    { read: what },
  );
}

export function createSupabaseDebtDeskStore(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string = ORG_ID,
): DebtDeskStore {
  const pagedLog = async (
    // deno-lint-ignore no-explicit-any
    filter: (q: any) => any,
    what: string,
  ) => {
    const out: Record<string, unknown>[] = [];
    for (let offset = 0;; offset += PAGE) {
      const { data, error } = await filter(
        client.from("payment_chase_logs").select("*").eq("org_id", orgId),
      ).order("created_at", { ascending: true }).order("id", {
        ascending: true,
      })
        .range(offset, offset + PAGE - 1);
      if (error) readFailed(what, error);
      out.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return out;
  };
  return {
    async insertChaseRows(rows) {
      if (!rows.length) return;
      const { error } = await client.from("payment_chase_logs").insert(
        rows.map((r) => ({ ...r, org_id: orgId })),
      );
      if (error) writeFailed(error);
    },
    async claimSend(rows) {
      const { error } = await client.from("payment_chase_logs").insert(
        rows.map((r) => ({ ...r, org_id: orgId })),
      );
      if (!error) return true;
      if (String(error?.code ?? "") === "23505") return false;
      writeFailed(error);
    },
    async settleSend(draftId, ids, patch) {
      const { data, error } = await client.from("payment_chase_logs")
        .update(patch).eq("org_id", orgId).eq("draft_id", draftId)
        .eq("outcome_code", "sending").in("xero_invoice_id", ids).select("id");
      if (error) writeFailed(error);
      if ((data || []).length !== ids.length) {
        writeFailed({
          message: `settled ${(data || []).length} of ${ids.length} claim rows`,
        });
      }
    },
    draftRows: (draftId) =>
      pagedLog((q) => q.eq("draft_id", draftId), "the draft's log"),
    async chaseLogRows(ids) {
      const out: Record<string, unknown>[] = [];
      for (const part of chunks(ids)) {
        out.push(
          ...await pagedLog(
            (q) => q.in("xero_invoice_id", part),
            "the chase log",
          ),
        );
      }
      return out;
    },
    async invoiceJobLinks(ids) {
      const out: Array<{ xero_invoice_id: string; job_id: string | null }> = [];
      for (const part of chunks(ids)) {
        const { data, error } = await client.from("xero_invoices")
          .select("xero_invoice_id, job_id").eq("org_id", orgId).in(
            "xero_invoice_id",
            part,
          );
        if (error) readFailed("invoice job links", error);
        out.push(...(data || []));
      }
      return out;
    },
    async jobGhlContacts(ids) {
      const out: Array<{ id: string; ghl_contact_id: string | null }> = [];
      for (const part of chunks(ids)) {
        const { data, error } = await client.from("jobs").select(
          "id, ghl_contact_id",
        ).in("id", part);
        if (error) readFailed("job contacts", error);
        out.push(...(data || []));
      }
      return out;
    },
    async deskOwnerSetting() {
      // An unreadable setting stops the action: it never reads as "nobody" or "anybody".
      const { data, error } = await client.from("debt_desk_settings")
        .select("owner_user_ids").eq("id", 1).maybeSingle();
      if (error) readFailed("the desk owner", error);
      return Array.isArray(data?.owner_user_ids)
        ? data.owner_user_ids.map((id: unknown) => String(id))
        : [];
    },
  };
}

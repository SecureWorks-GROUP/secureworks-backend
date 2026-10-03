// Debt desk drafts on the morning list (plan step 3, docs/debt-book/PLAN.md section 4).
//
// The morning list (debt_morning_list.ts) works out today's step per payer; this module puts
// the client draft on each item that has one (Jan's visits are listed in Jan's one morning
// text instead, debt_jan_text.ts): the standard wording (debt_draft_templates.ts), and,
// once Shaun has decided, what he decided. Decisions live on payment_chase_logs as rows
// carrying the draft's id (debt_desk_actions.ts writes them):
//
//   outcome_code null      approved (approved_by_user_id set; notes holds the approved text)
//   outcome_code skipped   skipped for today
//   outcome_code sending   a send claimed the draft (notes holds the text); not yet confirmed
//   outcome_code sent      sent: the sending row once the text went
//   outcome_code failed    a send attempt refused before any claim (sending off, the last
//                          Xero check)
//
// One decision writes one row per covered invoice; rows at one instant are one decision. These
// rows are the desk's state, not chase history: the older Clear Debt, job and invoice readers
// leave them out (DEBT_CHASE_HISTORY_FILTER). A desk send appears there once per covered
// invoice: send_chase_sms's own "SMS sent" row on the first, the desk's sent row on the rest.
//
// A firm text needs each invoice's Xero OnlineInvoice pay link. Links are read only for drafts
// still pending, one at a time (Xero allows 60 calls a minute and the book read already spent
// two), at most `payLinkLimit` live reads per list, in list order so the top of the list is
// drafted first. A link read once is kept for the rest of that Perth day (`payLinkCache`), so
// reading the list again after each approval spends no more Xero calls on it. A decided firm
// text (approved, skipped, claimed or sent) is never read live again: an approved one keeps its
// links inside its text, and a skipped one is worded from links already read today, else shows
// its earlier approved text. A draft whose link could not be read is left out with a reason,
// never sent without its link.

import type { DebtMorningItem } from "./debt_chase_schedule.ts";
import {
  DEBT_DRAFT_STEPS,
  type DebtDeskDraft,
  debtDraftId,
  type DebtDraftStep,
  debtDraftText,
} from "./debt_draft_templates.ts";

export const DEBT_PAY_LINK_LIMIT = 10;

/**
 * PostgREST `.or()` filter for the older chase-history readers (Clear Debt, job_detail,
 * invoice_context, debt notes), so every invoice a desk send covers reads as chased once. A
 * desk approval, skip, refusal or claim is not a chase. send_chase_sms logs a desk send with its
 * own row (no draft id) on the first covered invoice only; the desk's sent row there carries the
 * job id, as that row does, and is left out. The desk's sent rows on the other covered invoices
 * carry no job id and are shown. Jan's morning text (debt_jan_text.ts) goes to Jan, not the
 * payer, so it is not a chase of the payer either: its rows carry no schedule step and are left
 * out. Jan's visit is shown once Shaun logs what Jan reports.
 */
export const DEBT_CHASE_HISTORY_FILTER =
  "draft_id.is.null,and(outcome_code.eq.sent,job_id.is.null,schedule_step.not.is.null)";

/** Pay links read today, keyed `<perth date>|<xero invoice id>`; other days are dropped. */
const PAY_LINK_CACHE = new Map<string, string>();

export type DebtDraftDecisionKind =
  | "approved"
  | "skipped"
  | "sending"
  | "sent"
  | "failed";

export interface DebtDraftDecision {
  draft_id: string;
  kind: DebtDraftDecisionKind;
  at: string;
  by: string | null;
  user_id: string | null;
  text: string | null;
  reason: string | null;
  xero_invoice_id: string;
  covers: string[];
  draft_amount: number | null;
  provider_message_id: string | null;
}

const str = (v: unknown) => typeof v === "string" && v ? v : null;

/** A chase-log row as a draft decision, or null when the row belongs to no draft. */
export function debtDraftDecisionFromRow(
  row: Record<string, unknown>,
): DebtDraftDecision | null {
  const draftId = str(row.draft_id);
  const at = str(row.created_at);
  if (!draftId || !at || !row.xero_invoice_id) return null;
  const code = row.outcome_code ?? null;
  const kind: DebtDraftDecisionKind | null = code === "sent"
    ? "sent"
    : code === "sending"
    ? "sending"
    : code === "skipped"
    ? "skipped"
    : code === "failed"
    ? "failed"
    : code === null && str(row.approved_by_user_id)
    ? "approved"
    : null;
  if (!kind) return null;
  const xeroId = String(row.xero_invoice_id).toLowerCase();
  const amount = row.draft_amount === null || row.draft_amount === undefined ||
      row.draft_amount === ""
    ? null
    : Number(row.draft_amount);
  return {
    draft_id: draftId,
    kind,
    at,
    by: str(row.chased_by),
    user_id: str(row.approved_by_user_id),
    text: kind === "failed" ? null : str(row.notes),
    reason: kind === "failed"
      ? str(row.notes) ?? str(row.outcome)
      : kind === "sending" && str(row.outcome) !== "sending"
      ? str(row.outcome)
      : null,
    xero_invoice_id: xeroId,
    covers: Array.isArray(row.covers_invoice_ids) &&
        row.covers_invoice_ids.length
      ? row.covers_invoice_ids.map((id) => String(id).toLowerCase())
      : [xeroId],
    draft_amount: Number.isFinite(amount) ? amount : null,
    provider_message_id: str(row.provider_message_id),
  };
}

export interface DebtDraftState {
  /**
   * The decision in force: a claimed or confirmed send is final; otherwise the newest approval
   * or skip.
   */
  decision: DebtDraftDecision | null;
  /** The newest approval, when the draft has one. */
  approval: DebtDraftDecision | null;
  /** The newest failed or refused send since the newest approval. */
  lastFailure: DebtDraftDecision | null;
  /** Every decision row of the draft, oldest first. */
  rows: DebtDraftDecision[];
}

/** Every draft's state from its chase-log rows. */
export function debtDraftStates(
  rows: Record<string, unknown>[],
): Map<string, DebtDraftState> {
  const decisions = rows.map(debtDraftDecisionFromRow).filter((
    d,
  ): d is DebtDraftDecision => d !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  const out = new Map<string, DebtDraftState>();
  for (const d of decisions) {
    const s = out.get(d.draft_id) ??
      { decision: null, approval: null, lastFailure: null, rows: [] };
    s.rows.push(d);
    if (s.decision?.kind !== "sent" && s.decision?.kind !== "sending") {
      if (d.kind !== "failed") s.decision = d;
    }
    if (d.kind === "approved") {
      s.approval = d;
      s.lastFailure = null;
    }
    if (d.kind === "failed") s.lastFailure = d;
    out.set(d.draft_id, s);
  }
  return out;
}

const statusOf = (d: DebtDraftDecision | null): DebtDeskDraft["status"] =>
  d && d.kind !== "failed" ? d.kind : "pending";

export interface AttachDraftOptions {
  /** Today's Perth date: the pay-link cache keeps only today's links. */
  perthDate: string;
  /** Reads one invoice's Xero OnlineInvoice URL. Absent: firm texts get no draft. */
  payLink?: (xeroInvoiceId: string) => Promise<string>;
  payLinkLimit?: number;
  /** Defaults to the module's day cache. */
  payLinkCache?: Map<string, string>;
}

/** Puts today's draft on every item that has one. Writes nothing. */
export async function attachDebtDrafts(
  items: DebtMorningItem[],
  logRows: Record<string, unknown>[],
  opts: AttachDraftOptions,
): Promise<{ pay_links_read: number }> {
  const states = debtDraftStates(logRows);
  const limit = opts.payLinkLimit ?? DEBT_PAY_LINK_LIMIT;
  const cache = opts.payLinkCache ?? PAY_LINK_CACHE;
  const today = `${opts.perthDate}|`;
  for (const key of [...cache.keys()]) {
    if (!key.startsWith(today)) cache.delete(key);
  }
  let linksRead = 0;
  let linkFailure: string | null = null;

  const readLinks = async (
    item: DebtMorningItem,
  ): Promise<Record<string, string> | string> => {
    if (!opts.payLink) {
      return "No Xero pay link reader is wired here, so the firm text cannot be drafted";
    }
    if (linkFailure) {
      return `Pay link not read: an earlier Xero read failed (${linkFailure})`;
    }
    const unread = item.invoices.filter((i) =>
      !cache.has(today + i.xero_invoice_id)
    );
    if (linksRead + unread.length > limit) {
      return `Pay link not read: the list reads at most ${limit} pay links at a time. Approve or skip the drafts above, then read the list again`;
    }
    const links: Record<string, string> = {};
    for (const i of item.invoices) {
      const cached = cache.get(today + i.xero_invoice_id);
      if (cached) {
        links[i.xero_invoice_id] = cached;
        continue;
      }
      linksRead += 1;
      try {
        const url = await opts.payLink(i.xero_invoice_id);
        if (typeof url !== "string" || !/^https:\/\/\S+$/.test(url)) {
          throw new Error("Xero returned no online invoice link");
        }
        links[i.xero_invoice_id] = url;
        cache.set(today + i.xero_invoice_id, url);
      } catch (error) {
        linkFailure = String((error as Error)?.message ?? error).slice(0, 200);
        return `The pay link for ${i.invoice_number} could not be read from Xero: ${linkFailure}`;
      }
    }
    return links;
  };
  const cachedLinks = (item: DebtMorningItem) => {
    const links: Record<string, string> = {};
    for (const i of item.invoices) {
      const url = cache.get(today + i.xero_invoice_id);
      if (!url) return null;
      links[i.xero_invoice_id] = url;
    }
    return links;
  };

  for (const item of items) {
    const step = item.step as DebtDraftStep | null;
    if (item.hold || !step || !DEBT_DRAFT_STEPS.includes(step)) continue;
    const id = debtDraftId(item.id, item.invoices);
    const state = states.get(id);
    const decided = state?.decision ?? null;
    const input = {
      step,
      payer_name: item.payer_name,
      invoices: item.invoices,
    };

    let template: string | null = null;
    let payLinks: DebtDeskDraft["pay_links"] = null;
    if (step !== "firm_text") template = debtDraftText(input);
    else if (!decided || decided.kind === "skipped") {
      const links = decided ? cachedLinks(item) : await readLinks(item);
      if (typeof links === "string") {
        item.draft_problem = links;
        continue;
      }
      if (links) {
        payLinks = item.invoices.map((i) => ({
          xero_invoice_id: i.xero_invoice_id,
          invoice_number: i.invoice_number,
          url: links[i.xero_invoice_id],
        }));
        template = debtDraftText({ ...input, pay_links: links });
      }
    }

    const status = statusOf(decided);
    const text = decided?.text ?? template ?? state?.approval?.text ?? null;
    const used = status === "approved" || status === "sending" ||
      status === "sent";
    item.draft = {
      id,
      channel: "sms",
      to: "client",
      step,
      text,
      template_text: template,
      status,
      edited: !used ? false : template !== null ? text !== template : null,
      pay_links: payLinks,
      approved_by: state?.approval?.by ?? null,
      approved_by_user_id: state?.approval?.user_id ?? null,
      decided_at: decided?.at ?? null,
      last_send: status === "approved" && state?.lastFailure
        ? {
          at: state.lastFailure.at,
          outcome: "failed",
          reason: state.lastFailure.reason,
        }
        : status === "sending" && decided?.reason
        ? { at: decided.at, outcome: "not_confirmed", reason: decided.reason }
        : null,
    };
  }
  return { pay_links_read: linksRead };
}

/** Drafts sent on a Perth date: they leave the list once sent, so the screen can still show them. */
export function debtSentOn(
  logRows: Record<string, unknown>[],
  perthDate: string,
  describe: (
    ids: string[],
  ) => { payer_name: string | null; invoice_numbers: string[] },
) {
  const out = [];
  for (const [draftId, state] of debtDraftStates(logRows)) {
    const sent = state.decision?.kind === "sent" ? state.decision : null;
    if (!sent) continue;
    const day = new Date(Date.parse(sent.at) + 8 * 3600_000).toISOString()
      .slice(0, 10);
    if (day !== perthDate) continue;
    const who = describe(sent.covers);
    const step = draftId.slice(
      draftId.lastIndexOf(":") + 1,
      draftId.lastIndexOf("|"),
    );
    out.push({
      draft_id: draftId,
      // Jan's morning text went to Jan, covering several payers.
      to: step === "jan_text" ? "jan" as const : "client" as const,
      payer_name: step === "jan_text" ? "Jan" : who.payer_name,
      invoice_numbers: who.invoice_numbers,
      step,
      text: sent.text,
      at: sent.at,
      by: sent.by,
      provider_message_id: sent.provider_message_id,
    });
  }
  return out.sort((a, z) => a.at.localeCompare(z.at));
}

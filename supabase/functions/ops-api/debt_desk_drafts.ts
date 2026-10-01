// Debt desk drafts on the morning list (plan step 3, docs/debt-book/PLAN.md section 4).
//
// The morning list (debt_morning_list.ts) works out today's step per payer; this module puts
// the draft on each item that has one: the standard wording (debt_draft_templates.ts), and,
// once Shaun has decided, what he decided. Decisions live on payment_chase_logs as rows
// carrying the draft's id (debt_desk_actions.ts writes them):
//
//   outcome_code null      approved (approved_by_user_id set; notes holds the approved text)
//   outcome_code skipped   skipped for today
//   outcome_code sent      sent (notes holds the text that went)
//   outcome_code failed    a send attempt that did not send: refused (sending off, the last
//                          Xero check) or failed at the provider
//
// One decision writes one row per covered invoice; rows at one instant are one decision.
//
// A firm text needs each invoice's Xero OnlineInvoice pay link. Links are read only for drafts
// still pending, one at a time (Xero allows 60 calls a minute and the book read already spent
// two), at most `payLinkLimit` per list, in list order so the top of the list is drafted first.
// A draft whose link could not be read is left out with a reason, never sent without its link.

import type { DebtMorningItem } from "./debt_chase_schedule.ts";
import {
  DEBT_DRAFT_STEPS,
  type DebtDeskDraft,
  debtDraftId,
  type DebtDraftStep,
  debtDraftText,
} from "./debt_draft_templates.ts";

export const DEBT_PAY_LINK_LIMIT = 20;

export type DebtDraftDecisionKind = "approved" | "skipped" | "sent" | "failed";

export interface DebtDraftDecision {
  draft_id: string;
  kind: DebtDraftDecisionKind;
  at: string;
  by: string | null;
  user_id: string | null;
  text: string | null;
  edited: boolean;
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
    edited: /\bedited\b/.test(String(row.outcome ?? "")),
    reason: kind === "failed" ? str(row.notes) ?? str(row.outcome) : null,
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
  /** The decision in force: a send is final; otherwise the newest approval or skip. */
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
    if (s.decision?.kind !== "sent") {
      if (d.kind === "sent") s.decision = d;
      else if (d.kind === "approved" || d.kind === "skipped") s.decision = d;
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
  d?.kind === "sent"
    ? "sent"
    : d?.kind === "approved"
    ? "approved"
    : d?.kind === "skipped"
    ? "skipped"
    : "pending";

export interface AttachDraftOptions {
  /** The job's site address for the item's invoices (Jan's text). */
  siteFor: (item: DebtMorningItem) => string | null;
  /** Reads one invoice's Xero OnlineInvoice URL. Absent: firm texts get no draft. */
  payLink?: (xeroInvoiceId: string) => Promise<string>;
  payLinkLimit?: number;
}

/** Puts today's draft on every item that has one. Writes nothing. */
export async function attachDebtDrafts(
  items: DebtMorningItem[],
  logRows: Record<string, unknown>[],
  opts: AttachDraftOptions,
): Promise<{ pay_links_read: number }> {
  const states = debtDraftStates(logRows);
  const limit = opts.payLinkLimit ?? DEBT_PAY_LINK_LIMIT;
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
    if (linksRead + item.invoices.length > limit) {
      return `Pay link not read: the list reads at most ${limit} pay links at a time. Approve or skip the drafts above, then read the list again`;
    }
    const links: Record<string, string> = {};
    for (const i of item.invoices) {
      linksRead += 1;
      try {
        const url = await opts.payLink(i.xero_invoice_id);
        if (typeof url !== "string" || !/^https:\/\/\S+$/.test(url)) {
          throw new Error("Xero returned no online invoice link");
        }
        links[i.xero_invoice_id] = url;
      } catch (error) {
        linkFailure = String((error as Error)?.message ?? error).slice(0, 200);
        return `The pay link for ${i.invoice_number} could not be read from Xero: ${linkFailure}`;
      }
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
      site: step === "jan_visit" ? opts.siteFor(item) : null,
      phone: step === "jan_visit" ? item.phone : null,
    };

    let template: string | null = null;
    let payLinks: DebtDeskDraft["pay_links"] = null;
    if (step !== "firm_text") template = debtDraftText(input);
    else if (!decided?.text) {
      const links = await readLinks(item);
      if (typeof links === "string") {
        item.draft_problem = links;
        continue;
      }
      payLinks = item.invoices.map((i) => ({
        xero_invoice_id: i.xero_invoice_id,
        invoice_number: i.invoice_number,
        url: links[i.xero_invoice_id],
      }));
      template = debtDraftText({ ...input, pay_links: links });
    }

    const status = statusOf(decided);
    const text = status !== "pending" && decided?.text
      ? decided.text
      : template!;
    item.draft = {
      id,
      channel: "sms",
      to: step === "jan_visit" ? "jan" : "client",
      step,
      text,
      template_text: template ?? text,
      status,
      // Against the standard wording when it is known; a decided firm text keeps the flag
      // its approval recorded, because its pay links are not read again.
      edited: (status === "approved" || status === "sent") &&
        (template !== null ? text !== template : decided?.edited ?? false),
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
    out.push({
      draft_id: draftId,
      payer_name: who.payer_name,
      invoice_numbers: who.invoice_numbers,
      step: draftId.slice(
        draftId.lastIndexOf(":") + 1,
        draftId.lastIndexOf("|"),
      ),
      text: sent.text,
      at: sent.at,
      by: sent.by,
      provider_message_id: sent.provider_message_id,
    });
  }
  return out.sort((a, z) => a.at.localeCompare(z.at));
}

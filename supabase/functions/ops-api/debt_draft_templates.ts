// Debt desk drafts: the standard wording for each chase step, filled in from the book.
// Pure, no I/O. Plan: docs/debt-book/PLAN.md section 4 ("Drafts") and section 6 step 3.
//
// Drafts are deterministic templates (no paid AI). Each one is filled only with facts the desk
// already holds: the payer's name, the invoice numbers, the amounts due, the due dates, the
// Xero online-invoice pay link (firm text only, fetched per invoice) and, for Jan, the job's
// site and the client's phone. They never invent a fact, threaten, or mention legal action or
// credit reporting; debtDraftTextProblem refuses an edited text that does.
//
//   friendly_text     day 1, to the client
//   firm_text         day 2, to the client, with each invoice's pay link
//   jan_visit         day 7, to Jan (his own phone), naming who to visit and where
//   deposit_reminder  the one friendly reminder about a deposit or before-work invoice; it
//                     says "deposit" only when every invoice is a deposit, otherwise "the
//                     invoice for your job" (a progress claim or materials invoice before the
//                     job's first payment is not a deposit)
//
// The call steps carry no text (Shaun calls), and builder statements are plan step 6.
//
// A draft's id is its morning-list item id plus each invoice's amount due in cents, in the
// item's invoice order: `<item id>|420000,15050`. The amounts are what the text says is owed,
// so the last check before a send can refuse when Xero now shows less. A changed amount is a
// different draft, so an approval never carries over to a text it did not see.

export type DebtDraftStep =
  | "friendly_text"
  | "firm_text"
  | "jan_visit"
  | "deposit_reminder";

export const DEBT_DRAFT_STEPS: DebtDraftStep[] = [
  "friendly_text",
  "firm_text",
  "jan_visit",
  "deposit_reminder",
];

export const DEBT_DRAFT_SIGN_OFF = "Thanks, SecureWorks";
export const DEBT_DRAFT_MAX_LENGTH = 1000;

export interface DebtDraftInvoice {
  xero_invoice_id: string;
  invoice_number: string;
  amount_due: number;
  due_date: string | null;
  days_overdue: number | null;
  /** The debt book's kind (deposit, progress_claim, materials, ...); absent when unknown. */
  kind?: string | null;
}

export interface DebtDraftInput {
  step: DebtDraftStep;
  payer_name: string;
  invoices: DebtDraftInvoice[];
  /** Firm text only: Xero OnlineInvoice URL per Xero invoice id. */
  pay_links?: Record<string, string>;
  /** Jan only: the job's site address. */
  site?: string | null;
  /** Jan only: the client's phone. */
  phone?: string | null;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const cents = (n: number) => Math.round(Number(n || 0) * 100);

export function debtDraftMoney(amount: number): string {
  const c = cents(amount);
  const whole = Math.floor(Math.abs(c) / 100).toLocaleString("en-AU");
  return `${c < 0 ? "-" : ""}$${whole}.${
    String(Math.abs(c) % 100).padStart(2, "0")
  }`;
}

function dateWords(isoDate: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate ?? "");
  if (!m) return null;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** A person's first name; a title, a couple, a company or an empty name keeps the whole. */
export function greetingName(payerName: string): string {
  const name = payerName.trim().replace(/\s+/g, " ");
  if (!name) return "there";
  const words = name.split(" ");
  if (
    words.length < 2 ||
    /^(mr|mrs|ms|miss|dr|mx)\.?$/i.test(words[0]) ||
    /(&|\band\b|\bpty\b|\bltd\b|\blimited\b|\bgroup\b|\btrust\b|\binc\b)/i.test(
      name,
    ) ||
    !/^[\p{L}'-]+$/u.test(words[0])
  ) {
    return name;
  }
  return words[0];
}

function listWords(parts: string[]): string {
  return parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function invoicePhrase(invoices: DebtDraftInvoice[]): {
  single: boolean;
  text: string;
} {
  if (invoices.length === 1) {
    const i = invoices[0];
    const due = dateWords(i.due_date);
    return {
      single: true,
      text: `invoice ${i.invoice_number} for ${debtDraftMoney(i.amount_due)}${
        due ? ` was due on ${due}` : ""
      }`,
    };
  }
  const total = invoices.reduce((a, i) => a + cents(i.amount_due), 0) / 100;
  const each = invoices.map((i) => {
    const due = dateWords(i.due_date);
    return `${i.invoice_number} (${debtDraftMoney(i.amount_due)}${
      due ? `, due ${due}` : ""
    })`;
  });
  return {
    single: false,
    text: `invoices ${listWords(each)}, ${debtDraftMoney(total)} in total,`,
  };
}

const PAID_THANKS =
  "If you have already paid, thank you, and please ignore this message.";

/** The standard wording for a step. Throws when a firm text is missing a pay link. */
export function debtDraftText(input: DebtDraftInput): string {
  if (!input.invoices.length) throw new Error("A draft needs an invoice");
  const name = greetingName(input.payer_name);
  const what = invoicePhrase(input.invoices);
  switch (input.step) {
    case "friendly_text":
      return `Hi ${name}, a friendly reminder that ${what.text} ${
        what.single ? "" : "are now due"
      }`.trimEnd() + `. ${PAID_THANKS} ${DEBT_DRAFT_SIGN_OFF}`;
    case "firm_text": {
      const links = input.invoices.map((i) => {
        const url = input.pay_links?.[i.xero_invoice_id];
        if (!url) {
          throw new Error(`No Xero pay link for ${i.invoice_number}`);
        }
        return { number: i.invoice_number, url };
      });
      const pay = what.single
        ? `Please pay it today here: ${links[0].url}`
        : `Please pay them today here: ${
          listWords(links.map((l) => `${l.number} ${l.url}`))
        }`;
      return `Hi ${name}, ${what.text}${
        what.single ? " and is still unpaid." : " are still unpaid."
      } ${pay} If you have already paid, please reply to let us know. ${DEBT_DRAFT_SIGN_OFF}`;
    }
    case "jan_visit": {
      let about: string;
      if (what.single) {
        const i = input.invoices[0];
        const due = dateWords(i.due_date);
        const late = i.days_overdue && i.days_overdue > 0
          ? ` (${i.days_overdue} day${i.days_overdue === 1 ? "" : "s"} overdue)`
          : "";
        about = `unpaid invoice ${i.invoice_number}, ${
          debtDraftMoney(i.amount_due)
        }${due ? `, due ${due}` : ""}${late}`;
      } else {
        about = `unpaid ${what.text.replace(/,$/, "")}`;
      }
      const site = input.site?.trim() ? ` Site: ${input.site.trim()}.` : "";
      const phone = input.phone?.trim() ? ` Phone: ${input.phone.trim()}.` : "";
      return `Hi Jan, please visit ${input.payer_name.trim()} about ${about}.${site}${phone} Please tell Shaun how it goes.`;
    }
    case "deposit_reminder": {
      const about = input.invoices.every((i) => i.kind === "deposit")
        ? "the deposit"
        : what.single
        ? "the invoice"
        : "the invoices";
      return `Hi ${name}, a friendly reminder about ${about} for your job: ${what.text}${
        what.single ? "" : " now due"
      }. ${PAID_THANKS} If you have any questions about the job, just reply to this text. ${DEBT_DRAFT_SIGN_OFF}`;
    }
  }
}

// Words no chase message may carry (PLAN.md section 4: never threaten, never mention legal
// action or credit reporting). Checked on every approved text, edited or not.
const NOT_ALLOWED: Array<[RegExp, string]> = [
  [/\blegal\b/i, "legal"],
  [/\blawyers?\b|\bsolicitors?\b/i, "a lawyer"],
  [/\bcourts?\b|\btribunal\b|\bmagistrates?\b/i, "court"],
  [/\bsue\b|\bsuing\b|\bsued\b/i, "suing"],
  [
    /\bdebt collect|\bcollection agenc|\bcollections? agent/i,
    "debt collection",
  ],
  [
    /\bcredit (report|rating|score|file|history|bureau|reference)/i,
    "credit reporting",
  ],
  [/\bdefault\b/i, "a default listing"],
  [/\bletter of demand\b/i, "a letter of demand"],
];

/** Why a message text may not be approved, or null when it may. */
export function debtDraftTextProblem(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return "The message is empty";
  if (/—/.test(text)) return "The message contains an em dash";
  if (text.length > DEBT_DRAFT_MAX_LENGTH) {
    return `The message is longer than ${DEBT_DRAFT_MAX_LENGTH} characters`;
  }
  for (const [re, what] of NOT_ALLOWED) {
    if (re.test(text)) {
      return `The message mentions ${what}: chase messages never mention legal action or credit reporting`;
    }
  }
  return null;
}

/** The draft id for a morning-list item: the item id plus each invoice's amount in cents. */
export function debtDraftId(
  itemId: string,
  invoices: Array<{ amount_due: number }>,
): string {
  return `${itemId}|${invoices.map((i) => cents(i.amount_due)).join(",")}`;
}

export interface ParsedDebtDraftId {
  item_id: string;
  perth_date: string;
  group: string;
  step: DebtDraftStep;
  amounts: number[];
}

/** Reads a draft id back, or null when it is not one of the desk's own draft ids. */
export function parseDebtDraftId(id: unknown): ParsedDebtDraftId | null {
  if (typeof id !== "string" || id.length > 500) return null;
  const bar = id.lastIndexOf("|");
  if (bar < 0) return null;
  const itemId = id.slice(0, bar);
  const amountText = id.slice(bar + 1);
  if (!/^\d+(,\d+)*$/.test(amountText)) return null;
  const parts = itemId.split(":");
  if (parts.length < 4) return null;
  const perthDate = parts[0];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(perthDate);
  const parsed = m ? Date.parse(`${perthDate}T00:00:00Z`) : NaN;
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== perthDate
  ) return null;
  const step = parts[parts.length - 1] as DebtDraftStep;
  if (!DEBT_DRAFT_STEPS.includes(step)) return null;
  return {
    item_id: itemId,
    perth_date: perthDate,
    group: parts[parts.length - 2],
    step,
    amounts: amountText.split(",").map((c) => Number(c) / 100),
  };
}

/** A draft as the morning list sends it (secureworks-ux docs/clear-debt-desk.md `draft`). */
export interface DebtDeskDraft {
  id: string;
  channel: "sms";
  /** client: the payer's phone through send_chase_sms; jan: Jan's own phone (plan step 5). */
  to: "client" | "jan";
  step: DebtDraftStep;
  /**
   * The text to show: the approved or sent text once decided, else the standard wording. Null
   * on a skipped firm text with no text, whose pay links are not read.
   */
  text: string | null;
  /**
   * The standard wording for this draft. Null on a decided firm text: its pay links are not
   * read again, so its standard wording is not known.
   */
  template_text: string | null;
  /** sending: a send claimed the draft and has not been confirmed sent. */
  status: "pending" | "approved" | "skipped" | "sending" | "sent";
  /**
   * True when the approved or sent text differs from the standard wording; null when the
   * standard wording is not known (a decided firm text).
   */
  edited: boolean | null;
  /** Firm text only: the pay link read from Xero for each invoice. */
  pay_links:
    | Array<
      { xero_invoice_id: string; invoice_number: string; url: string }
    >
    | null;
  approved_by: string | null;
  approved_by_user_id: string | null;
  decided_at: string | null;
  /**
   * failed: the last send attempt after the approval that did not send (refused). A claimed
   * send that could not be confirmed is not_confirmed: it stays claimed so it never texts twice.
   */
  last_send:
    | { at: string; outcome: "failed" | "not_confirmed"; reason: string | null }
    | null;
}

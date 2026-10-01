// Debt morning list: the read-only "Today" list behind the Clear Debt desk (plan step 2).
// Plan: docs/debt-book/PLAN.md sections 4 and 6 step 2. Schedule: debt_chase_schedule.ts.
// Screen contract: secureworks-ux docs/clear-debt-desk.md (`debt_morning_list`, GET).
//
//   debt_morning_list   reads the debt book live from Xero (debt_book.ts), the chase log
//                       (payment_chase_logs) for the invoices that can be chased, and the
//                       linked jobs' client phone, email and site, then works out today's step
//                       per payer. Plan step 3 adds each item's draft (debt_desk_drafts.ts):
//                       the standard wording, a firm text's Xero pay links (read one at a
//                       time, kept for the Perth day), and what Shaun decided. Approving and
//                       sending are debt_desk_actions.ts. Plan step 5 adds `jan_text`: Jan's
//                       one morning text listing today's Jan visits (debt_jan_text.ts), to
//                       Jan's own mobile, which is read from the staff records only when
//                       there is a Jan text to show.
//
// This module writes nothing: no database write, no Xero write, no message.

import { type DebtBookDeps, DebtBookError, readDebtBook } from "./debt_book.ts";
import { perthTimestamp } from "./debt_book_rules.ts";
import { attachDebtDrafts, debtSentOn } from "./debt_desk_drafts.ts";
import {
  buildJanText,
  JAN_TEXT_STEP,
  type JanMobile,
} from "./debt_jan_text.ts";
import {
  DEBT_CHASE_GROUP_ORDER,
  DEBT_CHASE_NO_REMINDER,
  DEBT_CHASE_OUTCOME_LABELS,
  DEBT_CHASE_SCHEDULES,
  DEBT_CHASE_STEPS,
  DEBT_JAN_VISIT_OUTCOMES,
  type DebtChaseContact,
  type DebtChaseEvent,
  debtChaseEventFromLogRow,
  planDebtMorningList,
} from "./debt_chase_schedule.ts";

export const DEBT_MORNING_LIST_VERSION = "debt-morning/v1";

/** Keeps each PostgREST `.in()` well inside a reliable GET URL (36-character UUIDs). */
const IN_CHUNK = 50;
const LOG_PAGE = 1000;

/** The only extra database reads the morning list makes. Every method reads; none writes. */
export interface DebtChaseLogStore {
  /** Every chase-log row on the given Xero invoice ids, oldest first. */
  chaseLogRows(xeroInvoiceIds: string[]): Promise<Record<string, unknown>[]>;
  jobContacts(jobIds: string[]): Promise<DebtJobContact[]>;
}

export interface DebtJobContact {
  id: string;
  client_phone: string | null;
  client_email: string | null;
  site_address?: string | null;
  site_suburb?: string | null;
}

export type DebtMorningListDeps = DebtBookDeps & {
  chaseLog: DebtChaseLogStore;
  /** Reads one invoice's Xero OnlineInvoice URL for a firm text (read-only). */
  payLink?: (xeroInvoiceId: string) => Promise<string>;
  /** At most this many live pay-link reads per list read (default DEBT_PAY_LINK_LIMIT). */
  payLinkLimit?: number;
  /** Pay links already read today (default: the module's day cache, debt_desk_drafts.ts). */
  payLinkCache?: Map<string, string>;
  /** The desk owner and sending state for the signed-in viewer (debtDeskState). */
  desk?: () => Promise<Record<string, unknown>>;
  /** Jan's mobile, read now (debt_jan_text.ts readJanMobile). Absent: not set. */
  janMobile?: () => Promise<JanMobile>;
};

function chunks<T>(xs: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

// deno-lint-ignore no-explicit-any
function readFailed(what: string, error: any): never {
  // A PostgREST error comes back, it is not thrown. An empty chase log would restart every
  // payer's ladder and hide every promise, so an unreadable read stops the list.
  console.error(
    `[debt_morning_list] ${what} read failed`,
    error?.code ?? "",
    error?.message ?? error,
  );
  throw new DebtBookError(
    `The morning list could not read ${what}`,
    502,
    "debt_book_read_failed",
    { read: what },
  );
}

export function createSupabaseDebtChaseLogStore(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
): DebtChaseLogStore {
  return {
    async chaseLogRows(ids) {
      const out: Record<string, unknown>[] = [];
      for (const part of chunks(ids)) {
        for (let offset = 0;; offset += LOG_PAGE) {
          // `*` on purpose: the desk columns (schedule_step, outcome_code, promised_*,
          // amount_due_at_promise) arrive with plan step 3's additive migration, and a named
          // column that is not there yet would 400 this read. The table carries no large blobs.
          const { data, error } = await client.from("payment_chase_logs")
            .select("*")
            .eq("org_id", orgId)
            .in("xero_invoice_id", part)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(offset, offset + LOG_PAGE - 1);
          if (error) readFailed("the chase log", error);
          out.push(...(data || []));
          if (!data || data.length < LOG_PAGE) break;
        }
      }
      return out;
    },
    async jobContacts(jobIds) {
      const out: DebtJobContact[] = [];
      for (const part of chunks(jobIds)) {
        const { data, error } = await client.from("jobs")
          .select("id, client_phone, client_email, site_address, site_suburb")
          .in("id", part);
        if (error) readFailed("job contacts", error);
        out.push(...(data || []));
      }
      return out;
    },
  };
}

/** The job's site, with the suburb added only when the address does not already name it. */
function siteWords(c: DebtJobContact | undefined): string | null {
  const address = c?.site_address?.trim() || "";
  const suburb = c?.site_suburb?.trim() || "";
  if (!address) return suburb || null;
  return suburb && !address.toLowerCase().includes(suburb.toLowerCase())
    ? `${address}, ${suburb}`
    : address;
}

type Params = URLSearchParams | Record<string, unknown>;

function validateParams(params: Params) {
  const keys = params instanceof URLSearchParams
    ? [...params.keys()]
    : Object.keys(params);
  for (const key of keys) {
    if (key !== "action") {
      throw new DebtBookError(
        `Unsupported parameter: ${key}`,
        400,
        "debt_morning_list_bad_request",
      );
    }
  }
}

export async function readDebtMorningList(
  client: unknown,
  params: Params,
  deps: DebtMorningListDeps,
) {
  validateParams(params);
  const book = await readDebtBook(client, {}, deps);

  // Only invoices the schedule can act on need their log: debt and before-work invoices.
  const relevant = book.invoices.filter((i) =>
    i.payer !== "not_chased" &&
    (i.is_debt ||
      (i.payer === "client" &&
        (i.kind === "deposit" || i.not_debt_reason === "before_first_payment")))
  );
  const ids = [...new Set(relevant.map((i) => i.xero_invoice_id))];
  const jobIds = [
    ...new Set(
      relevant.filter((i) => i.payer === "client" && i.job_id).map((i) =>
        String(i.job_id)
      ),
    ),
  ];
  const [rows, contacts] = await Promise.all([
    ids.length ? deps.chaseLog.chaseLogRows(ids) : Promise.resolve([]),
    jobIds.length ? deps.chaseLog.jobContacts(jobIds) : Promise.resolve([]),
  ]);
  const events = rows.map(debtChaseEventFromLogRow).filter(
    (e): e is DebtChaseEvent => e !== null,
  );
  const contactsByJobId = new Map<string, DebtChaseContact>(
    contacts.map((c) => [String(c.id), {
      phone: c.client_phone?.trim() || null,
      email: c.client_email?.trim() || null,
    }]),
  );

  const plan = planDebtMorningList(relevant, events, {
    perthDate: book.perth_date,
    contactsByJobId,
  });

  const bookById = new Map(
    book.invoices.map((i) => [i.xero_invoice_id.toLowerCase(), i]),
  );
  const jobIdByInvoice = new Map(
    relevant.map((i) => [i.xero_invoice_id.toLowerCase(), i.job_id]),
  );
  const contactById = new Map(contacts.map((c) => [String(c.id), c]));
  const drafts = await attachDebtDrafts(plan.items, rows, {
    perthDate: book.perth_date,
    payLink: deps.payLink,
    payLinkLimit: deps.payLinkLimit,
    payLinkCache: deps.payLinkCache,
  });

  // Jan's morning text: Jan's mobile is read only when there is a Jan text to show.
  const janToday = `${book.perth_date}:jan-`;
  const janNeeded = plan.items.some((i) => !i.hold && i.step === "jan_visit") ||
    rows.some((r) =>
      String(r.draft_id ?? "").startsWith(janToday) &&
      String(r.draft_id).includes(`:${JAN_TEXT_STEP}|`)
    );
  const janText = janNeeded
    ? buildJanText(plan.items, rows, {
      perthDate: book.perth_date,
      mobile: deps.janMobile ? await deps.janMobile() : {
        phone: null,
        source: null,
        staff_user_id: null,
        staff_name: null,
        problem: "Jan's mobile not set: the desk cannot read it here",
      },
      siteFor: (item) => {
        for (const line of item.invoices) {
          const jobId = jobIdByInvoice.get(line.xero_invoice_id.toLowerCase());
          const site = jobId ? siteWords(contactById.get(String(jobId))) : null;
          if (site) return site;
        }
        return null;
      },
    })
    : null;

  return {
    ok: true,
    version: DEBT_MORNING_LIST_VERSION,
    generated_at: perthTimestamp(deps.now?.() ?? new Date()),
    ...plan,
    book: {
      version: book.version,
      read_at: book.read_at,
      read_stable: book.read_stable,
      read_warning: book.read_warning,
      copy_check: {
        matches: book.copy_check.matches,
        differs_by: book.copy_check.differs_by,
        invoice_count: book.copy_check.invoice_count,
        stamp: book.copy_check.stamp,
      },
      summary: book.summary,
    },
    chase_log: {
      rows_read: rows.length,
      desk_rows: events.length,
    },
    // Whether a desk owner is named and whether this viewer is it: with none, the screen
    // shows "desk owner not set" and nobody can approve or send.
    desk: deps.desk ? await deps.desk() : null,
    jan_text: janText,
    sent_today: debtSentOn(rows, book.perth_date, (ids) => {
      const invs = ids.map((id) => bookById.get(id)).filter((i) => !!i);
      return {
        payer_name: invs[0]?.contact_name ?? null,
        invoice_numbers: invs.map((i) => i!.invoice_number).sort(),
      };
    }),
    drafts: {
      drafted: plan.items.filter((i) => i.draft).length,
      pending: plan.items.filter((i) => i.draft?.status === "pending").length,
      not_drafted: plan.items.filter((i) => i.draft_problem).length,
      pay_links_read: drafts.pay_links_read,
      jan_text: janText?.status ?? null,
    },
    schedule: {
      schedules: DEBT_CHASE_SCHEDULES,
      steps: DEBT_CHASE_STEPS,
      group_order: DEBT_CHASE_GROUP_ORDER,
      no_reminder: DEBT_CHASE_NO_REMINDER,
      outcomes: DEBT_CHASE_OUTCOME_LABELS,
      jan_visit_outcomes: DEBT_JAN_VISIT_OUTCOMES,
    },
  };
}

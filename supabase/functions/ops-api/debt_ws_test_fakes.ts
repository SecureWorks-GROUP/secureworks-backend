// Test fakes for the Debt Workshop: an in-memory DebtWsStore and a DebtWsDeps that records
// every send. Synthetic data only: no client names, phones or addresses from production.
import type { BankTransaction, WsInvoice, WsJob } from "./debt_ws_rules.ts";
import {
  DEBT_WS_SETTINGS_OFF,
  type DebtWsReportSettings,
  type DebtWsSettings,
  type DebtWsStore,
  type WsEvidence,
  type WsJanListRow,
  type WsLogRow,
  type WsPayment,
  type WsReportClaim,
  type WsReportRow,
  type WsReportSettle,
  type WsSendRow,
  type WsState,
  type WsStatementRow,
  type WsSuggestion,
} from "./debt_ws_store.ts";
import type { DebtWsCaller, DebtWsDeps } from "./debt_ws_actions.ts";
import type { BankAccountBalance } from "./debt_ws_report.ts";
import type { MirrorCheckRow } from "./debt_ws_xero_check.ts";
import type { WsJobContact } from "./debt_ws_payer.ts";

export const SHAUN_ID = "30000000-0000-4000-8000-0000000000aa";
export const OTHER_STAFF_ID = "30000000-0000-4000-8000-0000000000bb";
export const SHAUN: DebtWsCaller = {
  kind: "user",
  user_id: SHAUN_ID,
  email: "owner@example.test",
  staff: true,
};
export const STAFF: DebtWsCaller = {
  kind: "user",
  user_id: OTHER_STAFF_ID,
  email: "staff@example.test",
  staff: true,
};
export const SERVER: DebtWsCaller = { kind: "server" };

/** Thursday 8 October 2026, 10:00 Perth. */
export const NOW = new Date("2026-10-08T02:00:00Z");

let seq = 0;
const nextId = () =>
  `90000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

export const IDS = {
  final: "10000000-0000-4000-8000-00000000000a",
  progress: "10000000-0000-4000-8000-00000000000b",
  deposit: "10000000-0000-4000-8000-00000000000c",
  account: "10000000-0000-4000-8000-00000000000d",
  account2: "10000000-0000-4000-8000-00000000000e",
  unlinked: "10000000-0000-4000-8000-00000000000f",
  notChased: "10000000-0000-4000-8000-000000000010",
  janFinal: "10000000-0000-4000-8000-000000000011",
  goAhead: "10000000-0000-4000-8000-000000000012",
  paidDeposit: "10000000-0000-4000-8000-000000000013",
  paidThisWeek: "10000000-0000-4000-8000-000000000014",
};
export const JOBS = {
  fence: "20000000-0000-4000-8000-00000000000a",
  patio: "20000000-0000-4000-8000-00000000000b",
  makesafe: "20000000-0000-4000-8000-00000000000c",
  janFence: "20000000-0000-4000-8000-00000000000d",
  newPatio: "20000000-0000-4000-8000-00000000000e",
};
export const MLB_CONTACT = "c0000000-0000-4000-8000-0000000000a1";

function inv(over: Partial<WsInvoice>): WsInvoice {
  return {
    xero_invoice_id: nextId(),
    xero_contact_id: "c0000000-0000-4000-8000-000000000001",
    contact_name: "Alex Sample",
    invoice_number: "INV-1",
    invoice_type: "ACCREC",
    status: "AUTHORISED",
    reference: null,
    total: 1000,
    amount_due: 1000,
    invoice_date: "2026-10-01",
    due_date: null,
    fully_paid_on: null,
    job_id: null,
    first_description: null,
    ...over,
  };
}

export function fixtureInvoices(): WsInvoice[] {
  return [
    // Day 7 final: step d7 due today.
    inv({
      xero_invoice_id: IDS.final,
      invoice_number: "INV-2001",
      reference: "SWF-90001-FINBAL",
      first_description: "Balance (50% of $2,000)",
      job_id: JOBS.fence,
      total: 1000,
      amount_due: 1000,
    }),
    // Patio: paid deposit, then a materials invoice (progress, due 27 Sep, day 11).
    inv({
      xero_invoice_id: IDS.paidDeposit,
      invoice_number: "INV-1990",
      contact_name: "Casey Example",
      reference: "SWP-90002-DEP20",
      first_description: "Deposit (20%)",
      job_id: JOBS.patio,
      status: "PAID",
      amount_due: 0,
      total: 800,
      invoice_date: "2026-09-01",
    }),
    inv({
      xero_invoice_id: IDS.progress,
      invoice_number: "INV-2002",
      contact_name: "Casey Example",
      reference: "SWP-90002-MAT50",
      first_description: "Materials (50%)",
      job_id: JOBS.patio,
      total: 2000,
      amount_due: 2000,
      invoice_date: "2026-09-20",
    }),
    // Make-safe for Major Loss Builders: due 11 Sep, day 27; and one in grace.
    inv({
      xero_invoice_id: IDS.account,
      invoice_number: "INV-2003",
      contact_name: "Major Loss Builders",
      xero_contact_id: MLB_CONTACT,
      reference: "WO-1",
      first_description: "Make safe",
      job_id: JOBS.makesafe,
      total: 330,
      amount_due: 330,
      invoice_date: "2026-09-01",
    }),
    inv({
      xero_invoice_id: IDS.account2,
      invoice_number: "INV-2008",
      contact_name: "Major Loss Builders",
      xero_contact_id: MLB_CONTACT,
      reference: "WO-2",
      first_description: "Make safe",
      job_id: JOBS.makesafe,
      total: 440,
      amount_due: 440,
      invoice_date: "2026-10-05",
    }),
    // A person with no job: needs a look.
    inv({
      xero_invoice_id: IDS.unlinked,
      invoice_number: "INV-2004",
      contact_name: "Pat Nobody",
      reference: "Fencing",
      total: 50,
      amount_due: 50,
    }),
    // Not chased: Builderwest.
    inv({
      xero_invoice_id: IDS.notChased,
      invoice_number: "INV-2005",
      contact_name: "Builderwest Pty Ltd",
      xero_contact_id: "c0000000-0000-4000-8000-0000000000b1",
      reference: "BW-1",
      first_description: "Make safe",
      total: 561,
      amount_due: 561,
      invoice_date: "2026-09-01",
    }),
    // Day 30 final: on Jan's list.
    inv({
      xero_invoice_id: IDS.janFinal,
      invoice_number: "INV-2006",
      contact_name: "Robin Next",
      reference: "SWF-90004-B-FINBAL",
      first_description: "Balance (25%)",
      job_id: JOBS.janFence,
      total: 750,
      amount_due: 750,
      invoice_date: "2026-09-08",
    }),
    // A new patio's open deposit: the go-ahead payment, hidden.
    inv({
      xero_invoice_id: IDS.goAhead,
      invoice_number: "INV-2007",
      contact_name: "Jamie Fresh",
      reference: "SWP-90005-DEP50",
      first_description: "Deposit (50%)",
      job_id: JOBS.newPatio,
      total: 5000,
      amount_due: 5000,
    }),
    // A final paid on Tuesday this week.
    inv({
      xero_invoice_id: IDS.paidThisWeek,
      invoice_number: "INV-1999",
      contact_name: "Morgan Paid",
      reference: "SWF-90006-FINBAL",
      first_description: "Balance",
      status: "PAID",
      amount_due: 0,
      total: 900,
      fully_paid_on: "2026-10-06",
    }),
  ];
}

export function fixtureJobs(): WsJob[] {
  const base = {
    status: "final_payment",
    client_phone: "0400 000 001",
    client_email: "client@example.test",
    site_suburb: "Testville",
  };
  return [
    {
      ...base,
      id: JOBS.fence,
      type: "fencing",
      job_number: "SWF-90001",
      client_name: "Alex Sample",
      site_address: "12 Example Street, Testville WA 6000",
      ghl_contact_id: "ghlcontact0000000001",
    },
    {
      ...base,
      id: JOBS.patio,
      type: "patio",
      job_number: "SWP-90002",
      client_name: "Casey Example",
      site_address: "3 Sample Road",
      ghl_contact_id: "ghlcontact0000000002",
    },
    {
      ...base,
      id: JOBS.makesafe,
      type: "makesafe",
      job_number: "SWMS-90003",
      client_name: "Insured Person",
      site_address: "9 Storm Way",
      ghl_contact_id: null,
    },
    {
      ...base,
      id: JOBS.janFence,
      type: "fencing",
      job_number: "SWF-90004",
      client_name: "Taylor Main",
      site_address: "4 Boundary Lane",
      ghl_contact_id: "ghlcontact0000000004",
    },
    {
      ...base,
      id: JOBS.newPatio,
      type: "patio",
      job_number: "SWP-90005",
      client_name: "Jamie Fresh",
      site_address: "5 New Place",
      ghl_contact_id: "ghlcontact0000000005",
    },
  ];
}

export class FakeStore implements DebtWsStore {
  settingsRow: DebtWsSettings = {
    ...DEBT_WS_SETTINGS_OFF,
    owner_user_ids: [SHAUN_ID],
    not_chased_contacts: ["Emergency Trade Services", "Builderwest"],
    // Keyed by the canonical Xero contact id (spec section 4).
    statement_emails: {
      [MLB_CONTACT]: "accounts@builders.example.test",
    },
    company_aliases: {},
  };
  invoices: WsInvoice[] = fixtureInvoices();
  jobRows: WsJob[] = fixtureJobs();
  /** job_contacts rows (payers on shared jobs). None by default. */
  contactRows: WsJobContact[] = [];
  exits: Array<{ job_id: string; occurred_at: string }> = [];
  evidence: Array<WsEvidence> = [];
  stateRows: WsState[] = [];
  logRows: WsLogRow[] = [];
  sendRows: WsSendRow[] = [];
  suggestionRows: WsSuggestion[] = [];
  statementRows: Array<WsStatementRow & { html?: string }> = [];
  janRows: Array<WsJanListRow & { provider_message_id?: string | null }> = [];
  staff = [{ id: "s1", name: "Jan Visitor", phone: "0411 222 333" }];
  /** Set to make the next claim lose a race. */
  loseNextClaim = false;
  // ── The debt report ──
  reportSettingsRow: DebtWsReportSettings = {
    recipients: ["marnin@secureworkswa.com.au"],
    cc: ["shaun@secureworkswa.com.au"],
    auto_send: false,
  };
  /** Payments applied in Xero (debt_ws_payments_between). */
  paymentRows: WsPayment[] = [
    // Tuesday this week: a fencing final (job SWF-90001) and a patio deposit.
    {
      xero_invoice_id: IDS.paidThisWeek,
      invoice_number: "INV-1999",
      contact_name: "Morgan Paid",
      reference: "SWF-90006-FINBAL",
      first_description: "Balance",
      job_id: JOBS.fence,
      paid_on: "2026-10-06",
      amount: 900,
    },
    {
      xero_invoice_id: IDS.paidDeposit,
      invoice_number: "INV-1990",
      contact_name: "Casey Example",
      reference: "SWP-90002-DEP20",
      first_description: "Deposit (20%)",
      job_id: JOBS.patio,
      paid_on: "2026-10-07",
      amount: 800,
    },
    // Three weeks ago: a make-safe payment (not homeowner work).
    {
      xero_invoice_id: "10000000-0000-4000-8000-0000000000aa",
      invoice_number: "INV-1900",
      contact_name: "Major Loss Builders",
      reference: "WO-0",
      first_description: "Make safe",
      job_id: JOBS.makesafe,
      paid_on: "2026-09-17",
      amount: 330,
    },
  ];
  syncedAt: string | null = "2026-10-08T01:45:00Z";
  reportRows: Array<WsReportRow & Record<string, unknown>> = [];
  /** Set to make the report store reads fail (the migration not applied yet). */
  reportReadsFail = false;
  /** xero_mirror_checks rows (the hourly check against Xero). None by default. */
  mirrorCheckRows: MirrorCheckRow[] = [];
  /** Set to make the check read fail (its migration not applied yet). */
  mirrorReadFails = false;

  settings() {
    return Promise.resolve({ ...this.settingsRow });
  }
  openInvoices() {
    return Promise.resolve(
      this.invoices.filter((i) =>
        i.invoice_type === "ACCREC" && i.status === "AUTHORISED" &&
        Number(i.amount_due) > 0
      ),
    );
  }
  invoicesByIds(ids: string[]) {
    return Promise.resolve(
      this.invoices.filter((i) => ids.includes(i.xero_invoice_id)),
    );
  }
  jobInvoices(jobIds: string[]) {
    return Promise.resolve(
      this.invoices.filter((i) => i.job_id && jobIds.includes(i.job_id)),
    );
  }
  paidBetween(from: string, to: string) {
    return Promise.resolve(
      this.invoices.filter((i) =>
        i.status === "PAID" && !!i.fully_paid_on && i.fully_paid_on >= from &&
        i.fully_paid_on <= to
      ),
    );
  }
  jobs(jobIds: string[]) {
    return Promise.resolve(this.jobRows.filter((j) => jobIds.includes(j.id)));
  }
  jobContacts(jobIds: string[]) {
    return Promise.resolve(
      this.contactRows.filter((c) =>
        jobIds.includes(c.job_id) && (!c.status || c.status === "active")
      ),
    );
  }
  setContactRowGhl(rowId: string, jobId: string, contact: string) {
    const row = this.contactRows.find((c) =>
      c.id === rowId && c.job_id === jobId
    );
    if (!row) throw new Error("no contact row");
    row.ghl_contact_id = contact;
    return Promise.resolve();
  }
  rectificationExits(jobIds: string[]) {
    return Promise.resolve(this.exits.filter((e) => jobIds.includes(e.job_id)));
  }
  evidenceSince(jobIds: string[], since: string) {
    return Promise.resolve(
      this.evidence.filter((e) =>
        jobIds.includes(e.job_id) && Date.parse(e.at) > Date.parse(since)
      ),
    );
  }
  states(keys: string[]) {
    return Promise.resolve(
      this.stateRows.filter((s) => keys.includes(s.share_key)),
    );
  }
  upsertState(shareKey: string, patch: Partial<Omit<WsState, "share_key">>) {
    const row = this.stateRows.find((s) => s.share_key === shareKey);
    if (row) Object.assign(row, patch);
    else {
      this.stateRows.push({
        share_key: shareKey,
        says_paid_since: null,
        paused_until: null,
        agent_reviewed_at: null,
        note: null,
        pay_link: null,
        pay_link_read_at: null,
        ...patch,
      });
    }
    return Promise.resolve();
  }
  logs(keys: string[]) {
    return Promise.resolve(
      this.logRows.filter((l) => keys.includes(l.share_key)),
    );
  }
  logsForJob(jobId: string) {
    return Promise.resolve(this.logRows.filter((l) => l.job_id === jobId));
  }
  insertLog(row: Omit<WsLogRow, "id" | "created_at">) {
    const full: WsLogRow = {
      ...row,
      id: nextId(),
      created_at: new Date(NOW.getTime() + this.logRows.length * 1000)
        .toISOString(),
    };
    this.logRows.push(full);
    return Promise.resolve(full);
  }
  sends(keys: string[]) {
    return Promise.resolve(
      this.sendRows.filter((s) => keys.includes(s.share_key)),
    );
  }
  claimSend(row: {
    share_key: string;
    cycle_start: string;
    step: string;
    suggestion_id: string | null;
    actor: string;
  }) {
    if (this.loseNextClaim) {
      this.loseNextClaim = false;
      return Promise.resolve(null);
    }
    if (
      this.sendRows.some((s) =>
        s.share_key === row.share_key && s.cycle_start === row.cycle_start &&
        s.step === row.step && (s.status === "sending" || s.status === "sent")
      )
    ) return Promise.resolve(null);
    const full: WsSendRow = {
      ...row,
      id: nextId(),
      status: "sending",
      provider_message_id: null,
      error: null,
      created_at: NOW.toISOString(),
    };
    this.sendRows.push(full);
    return Promise.resolve(full);
  }
  settleSend(id: string, patch: Partial<WsSendRow>) {
    const row = this.sendRows.find((s) => s.id === id);
    if (!row) throw new Error("no claim");
    Object.assign(row, patch);
    return Promise.resolve();
  }
  suggestions(keys: string[]) {
    return Promise.resolve(
      this.suggestionRows.filter((s) => keys.includes(s.share_key)),
    );
  }
  suggestionById(id: string) {
    return Promise.resolve(
      this.suggestionRows.find((s) => s.id === id) ?? null,
    );
  }
  insertSuggestion(
    row: Omit<
      WsSuggestion,
      "id" | "created_at" | "decided_at" | "decided_by" | "status"
    >,
  ) {
    const full: WsSuggestion = {
      ...row,
      id: nextId(),
      status: "pending",
      created_at: new Date(NOW.getTime() + this.suggestionRows.length * 1000)
        .toISOString(),
      decided_at: null,
      decided_by: null,
    };
    this.suggestionRows.push(full);
    return Promise.resolve(full);
  }
  supersedePending(shareKey: string, kinds: string[], exceptId: string | null) {
    for (const s of this.suggestionRows) {
      if (
        s.share_key === shareKey && s.status === "pending" &&
        kinds.includes(s.kind) && s.id !== exceptId
      ) s.status = "superseded";
    }
    return Promise.resolve();
  }
  decideSuggestion(
    id: string,
    patch: { status: WsSuggestion["status"]; decided_by: string | null },
    from: Array<WsSuggestion["status"]> = ["pending"],
  ) {
    const s = this.suggestionRows.find((x) => x.id === id);
    if (!s || !from.includes(s.status)) return Promise.resolve(false);
    s.status = patch.status;
    s.decided_by = patch.decided_by;
    return Promise.resolve(true);
  }
  statementsForWeek(weekStart: string) {
    return Promise.resolve(
      this.statementRows.filter((s) => s.week_start === weekStart),
    );
  }
  claimStatement(row: {
    company_key: string;
    week_start: string;
    xero_invoice_ids: string[];
    total: number;
    to_email: string;
    approved_by: string;
  }) {
    if (
      this.statementRows.some((s) =>
        s.company_key === row.company_key && s.week_start === row.week_start &&
        (s.status === "sending" || s.status === "sent")
      )
    ) return Promise.resolve(null);
    const full = {
      ...row,
      id: nextId(),
      status: "sending" as const,
      sent_at: null,
      error: null,
    };
    this.statementRows.push(full);
    return Promise.resolve(full);
  }
  settleStatement(id: string, patch: Record<string, unknown>) {
    const row = this.statementRows.find((s) => s.id === id);
    if (!row) throw new Error("no statement");
    Object.assign(row, patch);
    return Promise.resolve();
  }
  janList(visitDate: string) {
    return Promise.resolve(
      this.janRows.find((r) => r.visit_date === visitDate) ?? null,
    );
  }
  async ensureJanList(visitDate: string) {
    if (!this.janRows.some((r) => r.visit_date === visitDate)) {
      this.janRows.push({
        id: nextId(),
        visit_date: visitDate,
        items: [],
        removed_share_keys: [],
        status: "open",
        locked_at: null,
        sent_at: null,
        error: null,
      });
    }
    return (await this.janList(visitDate))!;
  }
  updateJanList(
    visitDate: string,
    from: Array<WsJanListRow["status"]>,
    patch: Record<string, unknown>,
  ) {
    const row = this.janRows.find((r) => r.visit_date === visitDate);
    if (!row || !from.includes(row.status)) return Promise.resolve(false);
    Object.assign(row, patch);
    return Promise.resolve(true);
  }
  setJobContact(jobId: string, contact: string) {
    const job = this.jobRows.find((j) => j.id === jobId);
    if (!job) throw new Error("no job");
    job.ghl_contact_id = contact;
    return Promise.resolve();
  }
  userName(id: string) {
    return Promise.resolve(id === SHAUN_ID ? "Shaun" : "Staff Member");
  }
  janStaff() {
    return Promise.resolve(this.staff);
  }
  // ── The debt report ──
  reportSettings() {
    if (this.reportReadsFail) return Promise.reject(new Error("no columns"));
    return Promise.resolve({
      ...this.reportSettingsRow,
      recipients: [...this.reportSettingsRow.recipients],
      cc: [...this.reportSettingsRow.cc],
    });
  }
  paymentsBetween(from: string, to: string) {
    if (this.reportReadsFail) return Promise.reject(new Error("no function"));
    return Promise.resolve(
      this.paymentRows.filter((p) => p.paid_on >= from && p.paid_on <= to),
    );
  }
  lastInvoiceSync() {
    return Promise.resolve(this.syncedAt);
  }
  mirrorChecks() {
    if (this.mirrorReadFails) return Promise.reject(new Error("no table"));
    const newest = [...this.mirrorCheckRows].sort((a, b) =>
      String(b.checked_at).localeCompare(String(a.checked_at))
    );
    return Promise.resolve({
      latest: newest[0] ?? null,
      latestComplete: newest.find((r) => r.complete) ?? null,
    });
  }
  reportSends(limit: number) {
    if (this.reportReadsFail) return Promise.reject(new Error("no table"));
    return Promise.resolve(
      [...this.reportRows].sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at))
      ).slice(0, limit),
    );
  }
  claimReport(row: WsReportClaim) {
    if (
      row.kind === "auto" &&
      this.reportRows.some((r) =>
        r.kind === "auto" && r.week_start === row.week_start &&
        (r.status === "sending" || r.status === "sent")
      )
    ) return Promise.resolve(null);
    const full = {
      ...row,
      id: nextId(),
      status: "sending" as const,
      subject: null,
      error: null,
      created_at: this.clock().toISOString(),
      sent_at: null,
    };
    this.reportRows.push(full);
    return Promise.resolve(full);
  }
  settleReport(id: string, patch: WsReportSettle) {
    const row = this.reportRows.find((r) => r.id === id);
    if (!row) throw new Error("no report row");
    Object.assign(row, patch);
    return Promise.resolve();
  }
  /** The time new report rows are stamped with (tests move it on). */
  clock: () => Date = () => NOW;
}

export interface Recorder {
  sms: Record<string, unknown>[];
  staffSms: Array<{ phone: string; message: string }>;
  emails: Array<Parameters<DebtWsDeps["sendEmail"]>[0]>;
  /** One entry per report PDF drawn. */
  pdfs: number;
  statusMoves: Record<string, unknown>[];
  liveReads: string[];
  /** One entry per bank-feed page call: the date_from asked for. */
  bankReads: Array<string | null>;
  bankPages: number[];
  payLinkReads: string[];
  /** One entry per conversation read: the job, the extra and the held contact ids asked for. */
  conversationReads: Array<
    { jobId: string; contactIds: string[]; heldContactIds: string[] }
  >;
}

export function fakeDeps(
  store: FakeStore,
  options: {
    env?: Record<string, string>;
    live?: Record<string, Record<string, unknown>>;
    /** One page of bank transactions (has_more false). */
    bank?: BankTransaction[];
    /** Several pages, in order; has_more is true on every page but the last. */
    bankPages?: BankTransaction[][];
    /** Every bank-feed call fails with this. */
    bankError?: Error;
    /** readInvoices (the batch live read) fails with this. */
    liveError?: Error;
    smsError?: Error;
    /** The conversation every read returns, instead of the job's two default messages. */
    conversation?: Record<string, unknown>[];
    now?: Date;
    /** Xero's bank balances for the report, or an error to make the read fail. */
    bankSummary?: BankAccountBalance[] | Error;
    /** Drawing the report PDF fails with this. */
    pdfError?: Error;
    /** The email send answers with this (default: accepted), or throws this error. */
    emailResult?: { ok: boolean; status: number; error: string | null };
    emailError?: Error;
  } = {},
): { deps: DebtWsDeps; rec: Recorder } {
  const rec: Recorder = {
    sms: [],
    staffSms: [],
    emails: [],
    statusMoves: [],
    pdfs: 0,
    liveReads: [],
    bankReads: [],
    bankPages: [],
    payLinkReads: [],
    conversationReads: [],
  };
  const liveOf = (id: string) => {
    if (options.live?.[id]) return options.live[id];
    const copy = store.invoices.find((i) => i.xero_invoice_id === id);
    return {
      InvoiceID: id,
      InvoiceNumber: copy?.invoice_number,
      Status: copy?.status ?? "AUTHORISED",
      AmountDue: copy?.amount_due ?? 0,
      Type: "ACCREC",
    };
  };
  const deps: DebtWsDeps = {
    store,
    env: (name) => options.env?.[name],
    now: () => options.now ?? NOW,
    readInvoice: (id) => {
      rec.liveReads.push(id);
      return Promise.resolve(liveOf(id));
    },
    readInvoices: (ids) => {
      rec.liveReads.push(...ids);
      if (options.liveError) return Promise.reject(options.liveError);
      return Promise.resolve(ids.map(liveOf));
    },
    payLink: (id) => {
      rec.payLinkReads.push(id);
      return Promise.resolve(`https://in.xero.com/pay-${id.slice(-4)}`);
    },
    bankTransactions: (dateFrom, page) => {
      rec.bankReads.push(dateFrom);
      rec.bankPages.push(page);
      if (options.bankError) return Promise.reject(options.bankError);
      const pages = options.bankPages ?? [options.bank ?? []];
      // Like Xero's Date>= filter: nothing dated before date_from comes back.
      return Promise.resolve({
        transactions: (pages[page - 1] ?? []).filter((t) =>
          !dateFrom || !t.date || String(t.date).slice(0, 10) >= dateFrom
        ),
        has_more: page < pages.length,
      });
    },
    sendSms: (body) => {
      rec.sms.push(body);
      if (options.smsError) return Promise.reject(options.smsError);
      return Promise.resolve({
        success: true,
        message_id: `msg-${rec.sms.length}`,
      });
    },
    sendStaffSms: (phone, message) => {
      rec.staffSms.push({ phone, message });
      return Promise.resolve({
        accepted: true,
        messageId: "jan-msg-1",
        failureReason: null,
      });
    },
    sendEmail: (payload) => {
      rec.emails.push(payload);
      if (options.emailError) return Promise.reject(options.emailError);
      return Promise.resolve(
        options.emailResult ?? { ok: true, status: 200, error: null },
      );
    },
    bankSummary: () => {
      if (options.bankSummary instanceof Error) {
        return Promise.reject(options.bankSummary);
      }
      return Promise.resolve(
        options.bankSummary ?? [
          { name: "Operations", account_id: "b1", closing: 60444.05 },
          { name: "GST Provision", account_id: "b2", closing: 34782.14 },
          { name: "PAYGO", account_id: "b3", closing: 8808 },
          { name: "Cash Reserve", account_id: "b4", closing: 4232.32 },
          { name: "Old Account", account_id: "b5", closing: null },
        ],
      );
    },
    renderReportPdf: (report) => {
      rec.pdfs += 1;
      if (options.pdfError) return Promise.reject(options.pdfError);
      // A tiny stand-in: the real PDF is tested in debt_ws_report_pdf_test.ts.
      return Promise.resolve({
        bytes: new TextEncoder().encode(`%PDF-1.3 fake ${report.today}`),
        pageCount: 3,
      });
    },
    updateJobStatus: (body) => {
      rec.statusMoves.push(body);
      const job = store.jobRows.find((j) => j.id === body.job_id);
      if (job) job.status = String(body.status);
      return Promise.resolve({ success: true });
    },
    // By default two messages with the job's own GoHighLevel contact.
    conversation: (jobId, limit, contactIds, heldContactIds) => {
      rec.conversationReads.push({
        jobId,
        contactIds: contactIds ?? [],
        heldContactIds: heldContactIds ?? [],
      });
      const contact =
        store.jobRows.find((j) => j.id === jobId)?.ghl_contact_id ?? null;
      const messages = options.conversation ?? [
        {
          id: "ghl:2",
          channel: "call",
          direction: "inbound",
          occurred_at: "2026-10-07T03:00:00Z",
          author: "Client",
          body: "Transcript: I will pay Friday",
          contact_id: contact,
        },
        {
          id: "ghl:1",
          channel: "sms",
          direction: "outbound",
          occurred_at: "2026-10-02T03:00:00Z",
          author: "Shaun",
          body: "Hi there",
          contact_id: contact,
        },
      ];
      return Promise.resolve({
        messages: messages.slice(0, limit),
        summary: { count: messages.length },
      });
    },
    story: () =>
      Promise.resolve({
        story: {
          version: "job-story-v1",
          job: { number: "SWF-90001" },
          events: [1, 2, 3],
          timeline: Array.from({ length: 30 }, (_, k) => k),
        },
        status: { ok: true, state: "ok" },
      }),
    listDocuments: () =>
      Promise.resolve([
        {
          id: "d0000000-0000-4000-8000-000000000001",
          type: "quote",
          file_name: "Quote.pdf",
        },
        {
          id: "d0000000-0000-4000-8000-000000000002",
          type: "photo",
          storage_url: "https://x/y/site.jpg",
        },
      ]),
    getDocument: (jobId, documentId) =>
      Promise.resolve({
        status: 200,
        body: {
          ok: true,
          document: { id: documentId, job_id: jobId },
          content: { base64: "QUJD" },
        },
      }),
    invoicePdf: (id) =>
      Promise.resolve({
        success: true,
        pdf_base64: "JVBERi0",
        filename: `${id}.pdf`,
      }),
    searchContacts: (q) =>
      Promise.resolve([
        {
          id: "ghlcandidate00000001",
          name: "Insured Person",
          phone: "0400 000 001",
          email: "",
        },
        {
          id: "ghlcandidate00000002",
          name: "Other",
          phone: "",
          email: q.includes("@") ? q : "",
        },
      ]),
  };
  return { deps, rec };
}

// The retired env switch, set to "true". Since 14 Oct 2026 (Shaun) the database switch
// debt_ws_settings.sending_enabled alone turns sending on, so this env is ignored. Tests
// pass it to prove it neither turns sending on nor is needed.
export const ON = {
  DEBT_WS_SENDING_ENABLED: "true",
};

// ── A shared fence (synthetic, shaped like a real two-payer job) ──
//
// The job's client is Jordan Primary (share A, linked in GoHighLevel, paid). The
// neighbour is Riley Neighbour (share B): their own job_contacts row with their own Xero
// contact, phone and email, NOT linked in GoHighLevel, and the open B balance is theirs.
// The row's name has a double space, as live rows can.

export const SHARED = {
  job: "20000000-0000-4000-8000-0000000000f1",
  aBal: "10000000-0000-4000-8000-0000000000f1",
  bBal: "10000000-0000-4000-8000-0000000000f2",
  bDep: "10000000-0000-4000-8000-0000000000f3",
  aRow: "40000000-0000-4000-8000-0000000000f1",
  bRow: "40000000-0000-4000-8000-0000000000f2",
  primaryGhl: "ghlprimary0000000001",
  neighbourGhl: "ghlneighbour00000001",
  primaryXero: "c0000000-0000-4000-8000-0000000000f1",
  neighbourXero: "c0000000-0000-4000-8000-0000000000f2",
  neighbourPhone: "0400 999 222",
  neighbourEmail: "riley@example.test",
};

export function addSharedFence(store: FakeStore) {
  store.jobRows.push({
    id: SHARED.job,
    status: "final_payment",
    type: "fencing",
    job_number: "SWF-90007",
    client_name: "Jordan Primary",
    client_phone: "0400 111 000",
    client_email: "jordan@example.test",
    site_address: "7 Shared Boundary Road",
    site_suburb: "Testville",
    ghl_contact_id: SHARED.primaryGhl,
    xero_contact_id: SHARED.primaryXero,
  });
  store.contactRows.push(
    {
      id: SHARED.aRow,
      job_id: SHARED.job,
      contact_type: "primary",
      contact_label: "A",
      is_primary: true,
      status: "active",
      client_name: "Jordan Primary",
      client_phone: "0400 111 000",
      client_email: "jordan@example.test",
      xero_contact_id: SHARED.primaryXero,
      ghl_contact_id: SHARED.primaryGhl,
    },
    {
      id: SHARED.bRow,
      job_id: SHARED.job,
      contact_type: "neighbour_b",
      contact_label: "B",
      is_primary: false,
      status: "active",
      client_name: "Riley  Neighbour",
      client_phone: SHARED.neighbourPhone,
      client_email: SHARED.neighbourEmail,
      xero_contact_id: SHARED.neighbourXero,
      ghl_contact_id: null,
    },
  );
  store.invoices.push(
    inv({
      xero_invoice_id: SHARED.aBal,
      invoice_number: "INV-3001",
      contact_name: "Jordan Primary",
      xero_contact_id: SHARED.primaryXero,
      reference: "SWF-90007-A-BAL",
      first_description: "Balance (50%)",
      job_id: SHARED.job,
      status: "PAID",
      total: 1400,
      amount_due: 0,
      invoice_date: "2026-09-25",
    }),
    inv({
      xero_invoice_id: SHARED.bDep,
      invoice_number: "INV-3000",
      contact_name: "Riley Neighbour",
      xero_contact_id: SHARED.neighbourXero,
      reference: "SWF-90007-B-DEP50",
      first_description: "Deposit (50%)",
      job_id: SHARED.job,
      status: "PAID",
      total: 1400,
      amount_due: 0,
      invoice_date: "2026-07-01",
    }),
    inv({
      // Day 7 final (invoice 1 Oct): step d7 due today, like the fence fixture.
      xero_invoice_id: SHARED.bBal,
      invoice_number: "INV-3002",
      contact_name: "Riley Neighbour",
      xero_contact_id: SHARED.neighbourXero,
      reference: "SWF-90007-B-BAL",
      first_description: "Balance (50%)",
      job_id: SHARED.job,
      total: 1420.37,
      amount_due: 1420.37,
      invoice_date: "2026-10-01",
    }),
  );
}

/** The shared job's thread: mostly the primary client's messages, one neighbour email. */
export const SHARED_THREAD: Record<string, unknown>[] = [
  {
    id: "bev:1",
    channel: "sms",
    direction: "inbound",
    occurred_at: "2026-10-06T03:00:00Z",
    body: "I have paid my half",
    contact_id: SHARED.primaryGhl,
  },
  {
    id: "bev:2",
    channel: "sms",
    direction: "outbound",
    occurred_at: "2026-10-05T03:00:00Z",
    body: "Thanks Jordan",
    contact_id: SHARED.primaryGhl,
  },
  {
    id: "bev:3",
    channel: "email",
    direction: "inbound",
    occurred_at: "2026-10-04T03:00:00Z",
    body: "Can I pay next week?",
    email_addresses: [SHARED.neighbourEmail, "admin@example.test"],
  },
  {
    id: "bev:4",
    channel: "sms",
    direction: "outbound",
    occurred_at: "2026-10-03T03:00:00Z",
    body: "Hi Riley",
    contact_id: SHARED.neighbourGhl,
  },
  {
    id: "note:1",
    channel: "note",
    direction: "internal",
    occurred_at: "2026-10-02T03:00:00Z",
    body: "Staff note",
  },
];

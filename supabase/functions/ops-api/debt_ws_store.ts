// Debt Workshop store: every database read and write the workshop makes, behind one
// interface so the actions can be tested with fakes (debt_ws_actions_test.ts). Tables come
// from supabase/migrations/20261008170000_debt_workshop.sql; the invoice copy is
// xero_invoices, read only.
//
// PostgREST returns errors, it does not throw (AGENTS.md). Every read here checks `error`
// and throws DebtWsError, so an unread table never reads as "nothing there".

import type { WsInvoice, WsJob } from "./debt_ws_rules.ts";

export const DEBT_WS_ORG_ID = "00000000-0000-0000-0000-000000000001";
const IN_CHUNK = 50;
const PAGE = 1000;

export class DebtWsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "debt_ws_bad_request",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DebtWsError";
  }
}

export interface DebtWsSettings {
  owner_user_ids: string[];
  tab_visible: boolean;
  sending_enabled: boolean;
  agent_enabled: boolean;
  auto_send_steps: Record<string, unknown>;
  jan_list_auto_send: boolean;
  /** Names or Xero contact ids (a canonical id covers its aliases too). */
  not_chased_contacts: string[];
  /** Canonical Xero contact id (lower case) to the accounts email; a name key is a fallback. */
  statement_emails: Record<string, unknown>;
  /** Extra Xero contact id to the canonical company contact id, both lower case. */
  company_aliases: Record<string, string>;
}

/** Everything off and nobody the owner: what a missing settings row means. */
export const DEBT_WS_SETTINGS_OFF: DebtWsSettings = {
  owner_user_ids: [],
  tab_visible: false,
  sending_enabled: false,
  agent_enabled: false,
  auto_send_steps: {},
  jan_list_auto_send: false,
  not_chased_contacts: [],
  statement_emails: {},
  company_aliases: {},
};

export interface WsState {
  share_key: string;
  says_paid_since: string | null;
  paused_until: string | null;
  agent_reviewed_at: string | null;
  note: string | null;
  pay_link: string | null;
  pay_link_read_at: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface WsLogRow {
  id: string;
  share_key: string;
  xero_invoice_ids: string[];
  job_id: string | null;
  kind: string;
  step: string | null;
  body: string | null;
  meta: Record<string, unknown>;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

export type WsLogInsert = Omit<WsLogRow, "id" | "created_at">;

export interface WsSuggestion {
  id: string;
  share_key: string;
  xero_invoice_ids: string[];
  job_id: string | null;
  cycle_start: string | null;
  step: string | null;
  kind: "draft" | "move" | "flag";
  channel: "sms" | "email" | null;
  text: string | null;
  why: string | null;
  proposed_category: "says_paid" | "rectification" | null;
  amount: number | null;
  source: "agent" | "template";
  agent_version: string | null;
  status:
    | "pending"
    | "sent"
    | "skipped"
    | "superseded"
    | "accepted"
    | "dismissed";
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export type WsSuggestionInsert = Omit<
  WsSuggestion,
  "id" | "created_at" | "decided_at" | "decided_by" | "status"
>;

export interface WsSendRow {
  id: string;
  share_key: string;
  cycle_start: string;
  step: string;
  suggestion_id: string | null;
  status: "sending" | "sent" | "failed" | "refused";
  provider_message_id: string | null;
  error: string | null;
  actor: string | null;
  created_at: string;
}

export interface WsStatementRow {
  id: string;
  company_key: string;
  week_start: string;
  xero_invoice_ids: string[];
  total: number | null;
  to_email: string | null;
  status: "sending" | "sent" | "failed" | "refused";
  approved_by: string | null;
  sent_at: string | null;
  error: string | null;
}

export interface WsJanListRow {
  id: string;
  visit_date: string;
  items: unknown[];
  removed_share_keys: string[];
  status: "open" | "locked" | "sending" | "sent" | "failed" | "skipped";
  locked_at: string | null;
  sent_at: string | null;
  error: string | null;
}

export interface WsEvidence {
  job_id: string;
  at: string;
  event_type: string;
}

export interface DebtWsStore {
  settings(): Promise<DebtWsSettings>;
  /** ACCREC, AUTHORISED, amount due above zero (the SAMPLE- filter is a rule, not a query). */
  openInvoices(): Promise<WsInvoice[]>;
  invoicesByIds(ids: string[]): Promise<WsInvoice[]>;
  /** Every ACCREC invoice on these jobs, any status. */
  jobInvoices(jobIds: string[]): Promise<WsInvoice[]>;
  /** ACCREC invoices fully paid between two Perth dates (inclusive). */
  paidBetween(from: string, to: string): Promise<WsInvoice[]>;
  jobs(jobIds: string[]): Promise<WsJob[]>;
  /** The latest job.status_changed event out of rectification, per job. */
  rectificationExits(
    jobIds: string[],
  ): Promise<Array<{ job_id: string; occurred_at: string }>>;
  /** The latest evidence (inbound message, call, payment, status change) per job since a time. */
  evidenceSince(jobIds: string[], since: string): Promise<WsEvidence[]>;
  states(shareKeys: string[]): Promise<WsState[]>;
  upsertState(
    shareKey: string,
    patch: Partial<Omit<WsState, "share_key">>,
  ): Promise<void>;
  logs(shareKeys: string[]): Promise<WsLogRow[]>;
  logsForJob(jobId: string): Promise<WsLogRow[]>;
  insertLog(row: WsLogInsert): Promise<WsLogRow>;
  sends(shareKeys: string[]): Promise<WsSendRow[]>;
  /** The claim: inserts a 'sending' row. Null when that step is already claimed or sent. */
  claimSend(row: {
    share_key: string;
    cycle_start: string;
    step: string;
    suggestion_id: string | null;
    actor: string;
  }): Promise<WsSendRow | null>;
  settleSend(
    id: string,
    patch: Partial<Pick<WsSendRow, "status" | "provider_message_id" | "error">>,
  ): Promise<void>;
  suggestions(shareKeys: string[]): Promise<WsSuggestion[]>;
  suggestionById(id: string): Promise<WsSuggestion | null>;
  insertSuggestion(row: WsSuggestionInsert): Promise<WsSuggestion>;
  /** Marks pending suggestions of these kinds on the share superseded (except one id). */
  supersedePending(
    shareKey: string,
    kinds: Array<WsSuggestion["kind"]>,
    exceptId: string | null,
  ): Promise<void>;
  /**
   * Updates a suggestion only while its status is one of `from` (default: pending). False
   * when it was not.
   */
  decideSuggestion(
    id: string,
    patch: Pick<WsSuggestion, "status"> & { decided_by: string | null },
    from?: Array<WsSuggestion["status"]>,
  ): Promise<boolean>;
  statementsForWeek(weekStart: string): Promise<WsStatementRow[]>;
  /** The claim: inserts a 'sending' statement row. Null when this week's is claimed or sent. */
  claimStatement(row: {
    company_key: string;
    week_start: string;
    xero_invoice_ids: string[];
    total: number;
    to_email: string;
    approved_by: string;
  }): Promise<WsStatementRow | null>;
  settleStatement(
    id: string,
    patch: Partial<
      Pick<
        WsStatementRow,
        "status" | "error" | "sent_at" | "xero_invoice_ids" | "total"
      > & { html: string }
    >,
  ): Promise<void>;
  janList(visitDate: string): Promise<WsJanListRow | null>;
  /** Creates the week's row (status open) if missing, and returns it. */
  ensureJanList(visitDate: string): Promise<WsJanListRow>;
  /** Updates the week's row only while its status is one of `from`. False otherwise. */
  updateJanList(
    visitDate: string,
    from: Array<WsJanListRow["status"]>,
    patch: Partial<Omit<WsJanListRow, "id" | "visit_date">> & {
      provider_message_id?: string | null;
    },
  ): Promise<boolean>;
  setJobContact(jobId: string, ghlContactId: string): Promise<void>;
  userName(userId: string): Promise<string | null>;
  /** Staff records whose name starts with Jan. */
  janStaff(): Promise<
    Array<{ id: string; name: string | null; phone: string | null }>
  >;
}

// ── The Supabase store ──

function chunks<T>(xs: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

const uniq = (
  xs: Array<string | null | undefined>,
) => [...new Set(xs.filter((x): x is string => !!x))];

// deno-lint-ignore no-explicit-any
function readFailed(what: string, error: any): never {
  console.error(
    `[debt_ws] ${what} read failed`,
    error?.code ?? "",
    error?.message ?? error,
  );
  throw new DebtWsError(
    `The debt workshop could not read ${what}`,
    502,
    "debt_ws_read_failed",
    { read: what },
  );
}

// deno-lint-ignore no-explicit-any
function writeFailed(what: string, error: any): never {
  console.error(
    `[debt_ws] ${what} write failed`,
    error?.code ?? "",
    error?.message ?? error,
  );
  throw new DebtWsError(
    `The debt workshop could not write ${what}`,
    502,
    "debt_ws_write_failed",
    { write: what },
  );
}

const INVOICE_SELECT =
  "xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status, reference, total, amount_due, invoice_date, due_date, fully_paid_on, job_id, first_description:line_items->0->>Description";
const JOB_SELECT =
  "id, status, type, job_number, client_name, client_phone, client_email, site_address, site_suburb, ghl_contact_id";
const EVIDENCE_TYPES = [
  "client.reply",
  "client.email_in",
  "client.call_logged",
  "call.transcript_completed",
  "invoice.paid",
  "invoice.payment_received",
  "job.status_changed",
];

// deno-lint-ignore no-explicit-any
function toInvoice(r: any): WsInvoice {
  return {
    xero_invoice_id: String(r.xero_invoice_id).toLowerCase(),
    xero_contact_id: r.xero_contact_id ?? null,
    contact_name: r.contact_name ?? null,
    invoice_number: r.invoice_number ?? null,
    invoice_type: r.invoice_type ?? null,
    status: r.status ?? null,
    reference: r.reference ?? null,
    total: r.total === null || r.total === undefined ? null : Number(r.total),
    amount_due: r.amount_due === null || r.amount_due === undefined
      ? null
      : Number(r.amount_due),
    invoice_date: r.invoice_date ?? null,
    due_date: r.due_date ?? null,
    fully_paid_on: r.fully_paid_on ?? null,
    job_id: r.job_id ?? null,
    first_description: r.first_description ?? null,
  };
}

// deno-lint-ignore no-explicit-any
function toSettings(r: any): DebtWsSettings {
  const obj = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? v as Record<string, unknown>
      : {};
  return {
    owner_user_ids: Array.isArray(r?.owner_user_ids)
      ? r.owner_user_ids.map((x: unknown) => String(x).toLowerCase())
      : [],
    tab_visible: r?.tab_visible === true,
    sending_enabled: r?.sending_enabled === true,
    agent_enabled: r?.agent_enabled === true,
    auto_send_steps: obj(r?.auto_send_steps),
    jan_list_auto_send: r?.jan_list_auto_send === true,
    not_chased_contacts: Array.isArray(r?.not_chased_contacts)
      ? r.not_chased_contacts.map((x: unknown) => String(x))
      : [],
    statement_emails: obj(r?.statement_emails),
    company_aliases: aliasesOf(r?.company_aliases),
  };
}

const CONTACT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** company_aliases as {alias id: canonical id}, lower case; anything not an id pair is dropped. */
export function aliasesOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [alias, canonical] of Object.entries(value)) {
    const a = alias.trim().toLowerCase();
    const c = typeof canonical === "string"
      ? canonical.trim().toLowerCase()
      : "";
    if (CONTACT_ID.test(a) && CONTACT_ID.test(c) && a !== c) out[a] = c;
  }
  return out;
}

export function createSupabaseDebtWsStore(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string = DEBT_WS_ORG_ID,
): DebtWsStore {
  // deno-lint-ignore no-explicit-any
  async function paged<T>(build: () => any, what: string): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0;; offset += PAGE) {
      const { data, error } = await build().range(offset, offset + PAGE - 1);
      if (error) readFailed(what, error);
      out.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return out;
  }
  async function byChunks<T>(
    ids: string[],
    // deno-lint-ignore no-explicit-any
    build: (part: string[]) => any,
    what: string,
  ): Promise<T[]> {
    const out: T[] = [];
    for (const part of chunks(uniq(ids))) {
      out.push(...await paged<T>(() => build(part), what));
    }
    return out;
  }

  return {
    async settings() {
      const { data, error } = await client.from("debt_ws_settings").select(
        "owner_user_ids, tab_visible, sending_enabled, agent_enabled, auto_send_steps, jan_list_auto_send, not_chased_contacts, statement_emails, company_aliases",
      ).eq("id", 1).maybeSingle();
      if (error) readFailed("the workshop settings", error);
      return data ? toSettings(data) : { ...DEBT_WS_SETTINGS_OFF };
    },
    async openInvoices() {
      const rows = await paged(
        () =>
          client.from("xero_invoices").select(INVOICE_SELECT).eq(
            "org_id",
            orgId,
          ).eq("invoice_type", "ACCREC").eq("status", "AUTHORISED").gt(
            "amount_due",
            0,
          ).order("xero_invoice_id", { ascending: true }),
        "open invoices",
      );
      return rows.map(toInvoice);
    },
    async invoicesByIds(ids) {
      const rows = await byChunks(
        ids,
        (part) =>
          client.from("xero_invoices").select(INVOICE_SELECT).eq(
            "org_id",
            orgId,
          ).eq("invoice_type", "ACCREC").in("xero_invoice_id", part).order(
            "xero_invoice_id",
            { ascending: true },
          ),
        "invoices",
      );
      return rows.map(toInvoice);
    },
    async jobInvoices(jobIds) {
      const rows = await byChunks(
        jobIds,
        (part) =>
          client.from("xero_invoices").select(INVOICE_SELECT).eq(
            "org_id",
            orgId,
          ).eq("invoice_type", "ACCREC").in("job_id", part).order(
            "xero_invoice_id",
            { ascending: true },
          ),
        "the jobs' invoices",
      );
      return rows.map(toInvoice);
    },
    async paidBetween(from, to) {
      const rows = await paged(
        () =>
          client.from("xero_invoices").select(INVOICE_SELECT).eq(
            "org_id",
            orgId,
          ).eq("invoice_type", "ACCREC").eq("status", "PAID").gte(
            "fully_paid_on",
            from,
          ).lte("fully_paid_on", to).order("xero_invoice_id", {
            ascending: true,
          }),
        "invoices paid this week",
      );
      return rows.map(toInvoice);
    },
    jobs(jobIds) {
      return byChunks<WsJob>(
        jobIds,
        (part) =>
          client.from("jobs").select(JOB_SELECT).in("id", part).order("id", {
            ascending: true,
          }),
        "jobs",
      );
    },
    async rectificationExits(jobIds) {
      // deno-lint-ignore no-explicit-any
      const rows = await byChunks<any>(
        jobIds,
        (part) =>
          client.from("business_events").select("job_id, occurred_at").eq(
            "event_type",
            "job.status_changed",
          ).eq("payload->changes->status->>from", "rectification").in(
            "job_id",
            part,
          ).order("occurred_at", { ascending: false }),
        "rectification exits",
      );
      const latest = new Map<string, string>();
      for (const r of rows) {
        const id = String(r.job_id);
        if (!latest.has(id) || String(r.occurred_at) > latest.get(id)!) {
          latest.set(id, String(r.occurred_at));
        }
      }
      return [...latest].map(([job_id, occurred_at]) => ({
        job_id,
        occurred_at,
      }));
    },
    async evidenceSince(jobIds, since) {
      // deno-lint-ignore no-explicit-any
      const rows = await byChunks<any>(
        jobIds,
        (part) =>
          client.from("business_events").select(
            "job_id, occurred_at, event_type",
          ).in("event_type", EVIDENCE_TYPES).in("job_id", part).gt(
            "occurred_at",
            since,
          ).order("occurred_at", { ascending: false }),
        "job evidence",
      );
      const latest = new Map<string, WsEvidence>();
      for (const r of rows) {
        const id = String(r.job_id);
        if (!latest.has(id) || String(r.occurred_at) > latest.get(id)!.at) {
          latest.set(id, {
            job_id: id,
            at: String(r.occurred_at),
            event_type: String(r.event_type),
          });
        }
      }
      return [...latest.values()];
    },
    states(shareKeys) {
      return byChunks<WsState>(
        shareKeys,
        (part) =>
          client.from("debt_ws_states").select(
            "share_key, says_paid_since, paused_until, agent_reviewed_at, note, pay_link, pay_link_read_at, updated_at, updated_by",
          ).eq("org_id", orgId).in("share_key", part).order("share_key", {
            ascending: true,
          }),
        "share states",
      );
    },
    async upsertState(shareKey, patch) {
      const { error } = await client.from("debt_ws_states").upsert({
        org_id: orgId,
        share_key: shareKey,
        ...patch,
        updated_at: new Date().toISOString(),
      }, { onConflict: "org_id,share_key" });
      if (error) writeFailed("the share state", error);
    },
    logs(shareKeys) {
      return byChunks<WsLogRow>(
        shareKeys,
        (part) =>
          client.from("debt_ws_log").select("*").eq("org_id", orgId).in(
            "share_key",
            part,
          ).order("created_at", { ascending: false }).order("id", {
            ascending: true,
          }),
        "the workshop log",
      );
    },
    logsForJob(jobId) {
      return paged<WsLogRow>(
        () =>
          client.from("debt_ws_log").select("*").eq("org_id", orgId).eq(
            "job_id",
            jobId,
          ).order("created_at", { ascending: false }).order("id", {
            ascending: true,
          }),
        "the job's workshop log",
      );
    },
    async insertLog(row) {
      const { data, error } = await client.from("debt_ws_log").insert({
        ...row,
        org_id: orgId,
      }).select("*").single();
      if (error) writeFailed("the workshop log", error);
      return data as WsLogRow;
    },
    sends(shareKeys) {
      return byChunks<WsSendRow>(
        shareKeys,
        (part) =>
          client.from("debt_ws_sends").select("*").eq("org_id", orgId).in(
            "share_key",
            part,
          ).order("created_at", { ascending: true }).order("id", {
            ascending: true,
          }),
        "the workshop sends",
      );
    },
    async claimSend(row) {
      const { data, error } = await client.from("debt_ws_sends").insert({
        ...row,
        org_id: orgId,
        status: "sending",
      }).select("*").single();
      if (!error) return data as WsSendRow;
      if (String(error?.code ?? "") === "23505") return null;
      writeFailed("the send claim", error);
    },
    async settleSend(id, patch) {
      const { data, error } = await client.from("debt_ws_sends").update({
        ...patch,
        updated_at: new Date().toISOString(),
      }).eq("id", id).select("id");
      if (error) writeFailed("the send", error);
      if ((data || []).length !== 1) {
        writeFailed("the send", { message: "claim row not found" });
      }
    },
    suggestions(shareKeys) {
      return byChunks<WsSuggestion>(
        shareKeys,
        (part) =>
          client.from("debt_ws_suggestions").select("*").eq("org_id", orgId)
            .in("share_key", part).order("created_at", { ascending: false })
            .order("id", { ascending: true }),
        "the suggestions",
      );
    },
    async suggestionById(id) {
      const { data, error } = await client.from("debt_ws_suggestions").select(
        "*",
      ).eq("org_id", orgId).eq("id", id).maybeSingle();
      if (error) readFailed("the suggestion", error);
      return (data as WsSuggestion) ?? null;
    },
    async insertSuggestion(row) {
      const { data, error } = await client.from("debt_ws_suggestions").insert({
        ...row,
        org_id: orgId,
        status: "pending",
      }).select("*").single();
      if (error) writeFailed("the suggestion", error);
      return data as WsSuggestion;
    },
    async supersedePending(shareKey, kinds, exceptId) {
      let q = client.from("debt_ws_suggestions").update({
        status: "superseded",
        decided_at: new Date().toISOString(),
      }).eq("org_id", orgId).eq("share_key", shareKey).eq("status", "pending")
        .in("kind", kinds);
      if (exceptId) q = q.neq("id", exceptId);
      const { error } = await q;
      if (error) writeFailed("older suggestions", error);
    },
    async decideSuggestion(id, patch, from = ["pending"]) {
      const { data, error } = await client.from("debt_ws_suggestions").update({
        status: patch.status,
        decided_by: patch.decided_by,
        decided_at: new Date().toISOString(),
      }).eq("org_id", orgId).eq("id", id).in("status", from).select("id");
      if (error) writeFailed("the suggestion", error);
      return (data || []).length === 1;
    },
    async statementsForWeek(weekStart) {
      const { data, error } = await client.from("debt_ws_statements").select(
        "id, company_key, week_start, xero_invoice_ids, total, to_email, status, approved_by, sent_at, error",
      ).eq("org_id", orgId).eq("week_start", weekStart).order("created_at", {
        ascending: true,
      });
      if (error) readFailed("this week's statements", error);
      return (data || []) as WsStatementRow[];
    },
    async claimStatement(row) {
      const { data, error } = await client.from("debt_ws_statements").insert({
        ...row,
        org_id: orgId,
        status: "sending",
      }).select(
        "id, company_key, week_start, xero_invoice_ids, total, to_email, status, approved_by, sent_at, error",
      ).single();
      if (!error) return data as WsStatementRow;
      if (String(error?.code ?? "") === "23505") return null;
      writeFailed("the statement claim", error);
    },
    async settleStatement(id, patch) {
      const { data, error } = await client.from("debt_ws_statements").update(
        patch,
      ).eq("id", id).select("id");
      if (error) writeFailed("the statement", error);
      if ((data || []).length !== 1) {
        writeFailed("the statement", { message: "claim row not found" });
      }
    },
    async janList(visitDate) {
      const { data, error } = await client.from("debt_ws_jan_lists").select(
        "id, visit_date, items, removed_share_keys, status, locked_at, sent_at, error",
      ).eq("visit_date", visitDate).maybeSingle();
      if (error) readFailed("Jan's visit list", error);
      return (data as WsJanListRow) ?? null;
    },
    async ensureJanList(visitDate) {
      const { error } = await client.from("debt_ws_jan_lists").upsert({
        visit_date: visitDate,
      }, { onConflict: "visit_date", ignoreDuplicates: true });
      if (error) writeFailed("Jan's visit list", error);
      const row = await this.janList(visitDate);
      if (!row) writeFailed("Jan's visit list", { message: "row missing" });
      return row;
    },
    async updateJanList(visitDate, from, patch) {
      const { data, error } = await client.from("debt_ws_jan_lists").update({
        ...patch,
        updated_at: new Date().toISOString(),
      }).eq("visit_date", visitDate).in("status", from).select("id");
      if (error) writeFailed("Jan's visit list", error);
      return (data || []).length === 1;
    },
    async setJobContact(jobId, ghlContactId) {
      const { data, error } = await client.from("jobs").update({
        ghl_contact_id: ghlContactId,
        updated_at: new Date().toISOString(),
      }).eq("id", jobId).select("id");
      if (error) writeFailed("the job's contact", error);
      if ((data || []).length !== 1) {
        throw new DebtWsError("That job was not found", 404, "job_not_found");
      }
    },
    async userName(userId) {
      const { data, error } = await client.from("users").select("name").eq(
        "id",
        userId,
      ).maybeSingle();
      if (error) return null;
      return data?.name ? String(data.name) : null;
    },
    async janStaff() {
      const { data, error } = await client.from("users").select(
        "id, name, phone",
      ).eq("org_id", orgId).ilike("name", "jan%");
      if (error) readFailed("the staff records", error);
      return data || [];
    },
  };
}

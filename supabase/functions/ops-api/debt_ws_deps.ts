// Debt Workshop dependencies: builds DebtWsDeps from what index.ts owns. index.ts passes its
// private helpers as closures (sendChaseSms, getJobConversation, getToken, xeroReadGet,
// updateJobStatus, the Outlook send, the invoice PDF, the GHL contact search, the staff SMS
// path and the job document read); this module adds the shared Xero reads
// (xero_receivables_read.ts) and the job story (job_story_read.ts). No send, Xero or GHL
// call is made here unless an action asks for it.

import {
  getXeroOnlineInvoiceUrl,
  getXeroReceivable,
  listXeroBankTransactions,
} from "./xero_receivables_read.ts";
import { readJobStory } from "./job_story_read.ts";
import type { BankTransaction } from "./debt_ws_rules.ts";
import type { DebtWsDeps } from "./debt_ws_actions.ts";
import { createSupabaseDebtWsStore, DEBT_WS_ORG_ID } from "./debt_ws_store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Invoice ids per Xero GET /Invoices?IDs= call (keeps the URL short). */
const IDS_PER_CALL = 40;

// deno-lint-ignore no-explicit-any
type Any = any;

export interface DebtWsDepsInput {
  client: Any;
  orgId?: string;
  getToken: (client: Any) => Promise<{ accessToken: string; tenantId: string }>;
  /** xeroReadGet: returns { data, metadata }. */
  xeroGet: (
    path: string,
    accessToken: string,
    tenantId: string,
    params?: Record<string, string>,
  ) => Promise<Any>;
  sendChaseSms: DebtWsDeps["sendSms"];
  sendStaffSms: DebtWsDeps["sendStaffSms"];
  getJobConversation: (
    body: Record<string, unknown>,
  ) => Promise<{ messages: Record<string, unknown>[]; summary?: unknown }>;
  updateJobStatus: DebtWsDeps["updateJobStatus"];
  sendEmail: DebtWsDeps["sendEmail"];
  invoicePdf: DebtWsDeps["invoicePdf"];
  searchContacts: DebtWsDeps["searchContacts"];
  /** insuranceReadAction with the verified caller, for list_job_documents / get_job_document. */
  insuranceRead: (
    params: URLSearchParams,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  env?: (name: string) => string | undefined;
  now?: () => Date;
}

/**
 * Live Xero reads of several receivables in one call per 40 ids (GET /Invoices?IDs=).
 * Returns raw Xero invoices; an id Xero does not return is simply absent.
 */
export async function readXeroInvoicesByIds(
  client: Any,
  ids: string[],
  deps: Pick<DebtWsDepsInput, "getToken" | "xeroGet">,
): Promise<Record<string, unknown>[]> {
  const clean = [...new Set(ids.map((id) => String(id).toLowerCase()))].filter(
    (id) => UUID.test(id),
  );
  if (!clean.length) return [];
  const { accessToken, tenantId } = await deps.getToken(client);
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < clean.length; i += IDS_PER_CALL) {
    const part = clean.slice(i, i + IDS_PER_CALL);
    const result = await deps.xeroGet("/Invoices", accessToken, tenantId, {
      IDs: part.join(","),
      page: "1",
    });
    const data = result && typeof result === "object" && "data" in result
      ? result.data
      : result;
    const rows = Array.isArray(data?.Invoices) ? data.Invoices : [];
    for (const row of rows) {
      const id = String(row?.InvoiceID ?? "").toLowerCase();
      if (!part.includes(id)) {
        throw new Error("Xero returned an invoice that was not asked for");
      }
      if (String(row?.Type ?? "") !== "ACCREC") {
        throw new Error("Xero returned a non-receivable invoice");
      }
      out.push(row);
    }
  }
  return out;
}

export function createDebtWsDeps(input: DebtWsDepsInput): DebtWsDeps {
  const { client } = input;
  const read = { getToken: input.getToken, xeroGet: input.xeroGet };
  return {
    store: createSupabaseDebtWsStore(client, input.orgId ?? DEBT_WS_ORG_ID),
    env: input.env ?? ((name) => Deno.env.get(name)),
    now: input.now ?? (() => new Date()),
    readInvoice: async (id) =>
      (await getXeroReceivable(client, { xero_invoice_id: id }, read))
        .invoice as Record<string, unknown>,
    readInvoices: (ids) => readXeroInvoicesByIds(client, ids, read),
    payLink: (id) => getXeroOnlineInvoiceUrl(client, id, read),
    // One page per call; debt_ws_actions.ts pages, filters to RECEIVE and caches.
    // listXeroBankTransactions has no Type filter, so spends come back and are dropped there.
    bankTransactions: async (dateFrom, page) => {
      const result = await listXeroBankTransactions(client, {
        status: "UNRECONCILED",
        page: String(page),
        page_size: "100",
        ...(dateFrom ? { date_from: dateFrom } : {}),
      }, read);
      return {
        has_more: result.pagination.has_more === true,
        transactions: result.transactions.map((t): BankTransaction => ({
          bank_transaction_id: t.bank_transaction_id,
          type: typeof t.type === "string" ? t.type : null,
          date: typeof t.date === "string" ? t.date : null,
          total: t.total,
          reference: t.reference,
          contact_name: t.contact_name,
          line_item_descriptions: t.line_item_descriptions,
        })),
      };
    },
    sendSms: input.sendChaseSms,
    sendStaffSms: input.sendStaffSms,
    sendEmail: input.sendEmail,
    updateJobStatus: input.updateJobStatus,
    conversation: (jobId, limit) =>
      input.getJobConversation({ job_id: jobId, limit }),
    story: async (jobId) => {
      const { story, status } = await readJobStory(client, { jobId });
      return { story, status };
    },
    listDocuments: async (jobId) => {
      const result = await input.insuranceRead(
        new URLSearchParams({
          action: "list_job_documents",
          job_id: jobId,
          page_size: "100",
        }),
      );
      if (result.status !== 200 || !Array.isArray(result.body.rows)) {
        throw new Error(`documents read ${result.status}`);
      }
      return result.body.rows as Record<string, unknown>[];
    },
    getDocument: (jobId, documentId) =>
      input.insuranceRead(
        new URLSearchParams({
          action: "get_job_document",
          job_id: jobId,
          document_id: documentId,
        }),
      ),
    invoicePdf: input.invoicePdf,
    searchContacts: input.searchContacts,
  };
}

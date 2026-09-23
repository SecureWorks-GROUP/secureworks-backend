/** Production adapters for sales_booking_execute.ts. Reads only, except the
 * two ghl-proxy calls, the executor-ledger claim/settle and the Outlook mirror
 * write, which the executor makes only when SALES_BOOKING_BOOK_EXECUTE is on
 * and the captain pressed.
 *
 * Credential: ops-api calls ghl-proxy server-to-server with the project's
 * SUPABASE_SERVICE_ROLE_KEY as `Authorization: Bearer`, which ghl-proxy
 * classifies as `service_role` (ghl-proxy/hardening_helpers.ts
 * classifyAuthCredential). Same path as ops-api's existing proposed-SMS send.
 * Never the shared browser key.
 */
import type { ExecutableApprovalRecord } from "../_shared/booking_approval_gate.ts";
import { getGraphToken, graphFetch } from "../_shared/graph_client.ts";
import type {
  ExecutionLedger,
  OutlookEvent,
  OutlookRead,
  SalesBookingExecuteDeps,
} from "./sales_booking_execute.ts";
import { mirrorGhlAppointmentToOutlook } from "./sales_booking_outlook_mirror.ts";
import {
  ghlRead,
  readJobSitesLive,
  readSalesBookingThreadMessages,
  SALES_BOOKING_GHL_USERS,
  salesBookingPublishedSuburb,
} from "./sales_booking_read.ts";

// Supabase's structural query builder is owned by the pinned runtime client.
// deno-lint-ignore no-explicit-any
type Client = any;
// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

const GRAPH = "https://graph.microsoft.com/v1.0";

export function executionLedger(client: Client): ExecutionLedger {
  const table = "sales_booking_executions";
  return {
    async get(bindingHash) {
      const { data, error } = await client.from(table)
        .select(
          "binding_hash,step,state,press_token,message_id,appointment_id",
        )
        .eq("binding_hash", bindingHash).maybeSingle();
      if (error) throw new Error("execution_ledger_unreadable");
      return data ?? null;
    },
    async claim(row) {
      const state = row.step === "calendar" ? "claimed" : "sending";
      const { error } = await client.from(table).insert({
        binding_hash: row.binding_hash,
        step: row.step,
        contact_id: row.contact_id,
        state,
        press_token: row.press_token,
        claimed_by_email: row.claimed_by_email,
      });
      if (!error) return true;
      if (error.code !== "23505") {
        throw new Error("execution_ledger_unwritable");
      }
      if (row.step !== "calendar") return false;
      const { data, error: updateError } = await client.from(table).update({
        press_token: row.press_token,
        claimed_at: new Date().toISOString(),
      }).eq("binding_hash", row.binding_hash).eq("step", "calendar")
        .eq("state", "claimed").select("binding_hash");
      if (updateError) throw new Error("execution_ledger_unwritable");
      return Array.isArray(data) && data.length === 1;
    },
    async settle(bindingHash, outcome) {
      const prior = outcome.state === "booked" ? "claimed" : "sending";
      const { error } = await client.from(table).update({
        state: outcome.state,
        message_id: outcome.state === "sent" ? outcome.message_id : null,
        appointment_id: outcome.state === "booked"
          ? outcome.appointment_id
          : null,
        finished_at: new Date().toISOString(),
      }).eq("binding_hash", bindingHash).eq("state", prior);
      if (error) throw new Error("execution_ledger_unwritable");
    },
  };
}

/** Outlook primary calendar of the booking resource (the mail app's
 * Calendars.ReadWrite, read only here). Any failed or partial page refuses. */
export async function readResourceOutlook(
  resource: string,
  startIso: string,
  endIso: string,
): Promise<OutlookRead> {
  const mailbox = SALES_BOOKING_GHL_USERS[resource]?.email;
  if (!mailbox) return { ok: false, reason: "resource_has_no_outlook_mailbox" };
  let token = await getGraphToken();
  const url = new URL(
    `${GRAPH}/users/${encodeURIComponent(mailbox)}/calendarView`,
  );
  url.searchParams.set("startDateTime", startIso);
  url.searchParams.set("endDateTime", endIso);
  url.searchParams.set(
    "$select",
    "id,subject,start,end,showAs,isCancelled,isAllDay",
  );
  url.searchParams.set("$top", "100");
  const events: OutlookEvent[] = [];
  let next: string | null = url.toString();
  for (let page = 0; next; page++) {
    if (page >= 10) return { ok: false, reason: "outlook_pagination_capped" };
    const res: Response = await graphFetch(next, token, {
      init: {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        // UTC keeps every returned instant unambiguous.
        headers: { Prefer: 'outlook.timezone="UTC"' },
      },
      refresh: async () => {
        token = await getGraphToken({ forceRefresh: true });
        return token;
      },
    });
    if (!res.ok) return { ok: false, reason: `outlook_http_${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.value)) {
      return { ok: false, reason: "outlook_page_malformed" };
    }
    for (const item of data.value as Obj[]) {
      const utc = (v: Obj | undefined) =>
        typeof v?.dateTime === "string"
          ? `${v.dateTime.replace(/\.\d+$/, "")}Z`
          : "";
      events.push({
        id: String(item?.id ?? ""),
        subject: typeof item?.subject === "string" ? item.subject : null,
        start: utc(item?.start),
        end: utc(item?.end),
        show_as: typeof item?.showAs === "string" ? item.showAs : null,
        is_cancelled: item?.isCancelled === true,
      });
    }
    const link = data["@odata.nextLink"];
    next = typeof link === "string" && link.startsWith(`${GRAPH}/`)
      ? link
      : null;
  }
  return { ok: true, mailbox, events };
}

async function callGhlProxy(
  action: string,
  body: Obj,
): Promise<{ status: number; body: Obj }> {
  const base = (Deno.env.get("SUPABASE_URL") || "").replace("/rest/v1", "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) {
    return { status: 503, body: { ok: false, code: "proxy_unconfigured" } };
  }
  const res = await fetch(`${base}/functions/v1/ghl-proxy?action=${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const parsed = await res.json().catch(() => ({}));
  return {
    status: res.status,
    body: parsed && typeof parsed === "object" ? parsed : {},
  };
}

export function createSalesBookingExecuteDeps(
  client: Client,
): SalesBookingExecuteDeps {
  const locationId = Deno.env.get("GHL_LOCATION_ID") || "";
  async function readContact(contactId: string): Promise<Obj> {
    const body = await ghlRead(`/contacts/${encodeURIComponent(contactId)}`);
    const contact = body?.contact as Obj | undefined;
    if (contact?.id !== contactId || contact?.locationId !== locationId) {
      throw new Error("contact_mismatch");
    }
    return contact;
  }
  return {
    async findApproval(bindingHash) {
      const { data, error } = await client.from("sales_booking_approvals")
        .select(
          "binding_hash,step,state,snapshot,approved_by_email,approved_at,expires_at",
        ).eq("binding_hash", bindingHash).maybeSingle();
      if (error) throw new Error("approval_unreadable");
      return (data as ExecutableApprovalRecord | null) ?? null;
    },
    async appointmentLedger(key) {
      if (!locationId) throw new Error("location_unconfigured");
      const { data, error } = await client.from(
        "ghl_calendar_appointment_requests",
      ).select("state,result").eq("location_id", locationId)
        .eq("idempotency_key", key).maybeSingle();
      if (error) throw new Error("appointment_ledger_unreadable");
      return data ?? null;
    },
    readThread: (contactId) =>
      readSalesBookingThreadMessages(
        (path) => ghlRead(path),
        contactId,
        locationId,
      ),
    readOutlook: readResourceOutlook,
    async readContactPhone(contactId) {
      const contact = await readContact(contactId);
      return typeof contact.phone === "string" ? contact.phone : null;
    },
    async readOutlookLead({ contactId, opportunityId }) {
      const contact = await readContact(contactId);
      const jobSites = await readJobSitesLive(
        client,
        opportunityId ? [opportunityId] : [],
        contactId ? [contactId] : [],
      );
      const job = (opportunityId && jobSites[opportunityId]) ||
        (contactId ? jobSites[contactId] : undefined);
      return {
        contact,
        suburb: salesBookingPublishedSuburb(contact, job),
      };
    },
    mirrorToOutlook: (input, options) =>
      mirrorGhlAppointmentToOutlook(input, options),
    callAppointmentWriter: (body) =>
      callGhlProxy("create_calendar_appointment", body),
    callSendSms: (body) => callGhlProxy("send_sms", body),
    executions: executionLedger(client),
  };
}

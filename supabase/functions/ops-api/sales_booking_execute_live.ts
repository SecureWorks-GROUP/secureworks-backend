/** Production adapters for sales_booking_execute.ts. Reads only, except the
 * two ghl-proxy calls and the send-ledger claim/settle, which the executor
 * makes only when its switch is on and the captain pressed.
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
  OutlookEvent,
  OutlookRead,
  SalesBookingExecuteDeps,
  SendLedger,
} from "./sales_booking_execute.ts";
import {
  ghlRead,
  readSalesBookingThreadMessages,
  SALES_BOOKING_GHL_USERS,
} from "./sales_booking_read.ts";

// Supabase's structural query builder is owned by the pinned runtime client.
// deno-lint-ignore no-explicit-any
type Client = any;
// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

const GRAPH = "https://graph.microsoft.com/v1.0";

export function sendLedger(client: Client): SendLedger {
  const table = "sales_booking_message_sends";
  return {
    async get(bindingHash) {
      const { data, error } = await client.from(table)
        .select("binding_hash,state,message_id")
        .eq("binding_hash", bindingHash).maybeSingle();
      if (error) throw new Error("send_ledger_unreadable");
      return data ?? null;
    },
    async claim(row) {
      const { error } = await client.from(table).insert({
        ...row,
        state: "sending",
      });
      if (error?.code === "23505") return false;
      if (error) throw new Error("send_ledger_unwritable");
      return true;
    },
    async settle(bindingHash, outcome) {
      const { error } = await client.from(table).update({
        state: outcome.state,
        message_id: outcome.state === "sent" ? outcome.message_id : null,
        finished_at: new Date().toISOString(),
      }).eq("binding_hash", bindingHash).eq("state", "sending");
      if (error) throw new Error("send_ledger_unwritable");
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
      const body = await ghlRead(`/contacts/${encodeURIComponent(contactId)}`);
      const contact = body?.contact as Obj | undefined;
      if (contact?.id !== contactId || contact?.locationId !== locationId) {
        throw new Error("contact_mismatch");
      }
      return typeof contact.phone === "string" ? contact.phone : null;
    },
    callAppointmentWriter: (body) =>
      callGhlProxy("create_calendar_appointment", body),
    callSendSms: (body) => callGhlProxy("send_sms", body),
    sends: sendLedger(client),
  };
}

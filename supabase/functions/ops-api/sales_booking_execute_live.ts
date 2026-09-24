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
import type {
  OwnerApprovalDeps,
  OwnerApprovalReader,
} from "./sales_booking_owner_approval.ts";
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
    "id,subject,location,start,end,showAs,isCancelled,isAllDay",
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
        location: typeof item?.location?.displayName === "string"
          ? item.location.displayName
          : null,
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

// ── Owner-authored approvals (sales_booking_owner_approval.ts) ─────────────

function ghlCompleteBody(body: Obj, field: string): Obj[] {
  if (
    !body || !Array.isArray(body[field]) ||
    !(body[field] as unknown[]).every((row) =>
      !!row && typeof row === "object" && !Array.isArray(row)
    ) ||
    body.nextPage || body.nextPageUrl || body.hasMore ||
    body.complete === false || body.error
  ) throw new Error(`ghl_${field}_incomplete`);
  return body[field] as Obj[];
}

/** Reads the owner-authored approval path needs. Reads only: the approval
 * row itself is written by the confirmation store. */
export function createOwnerApprovalDeps(
  client: Client,
): Omit<
  OwnerApprovalDeps,
  "store" | "readWorkspace" | "envGet" | "now"
> {
  const execute = createSalesBookingExecuteDeps(client);
  const locationId = () => {
    const id = Deno.env.get("GHL_LOCATION_ID") || "";
    if (!id) throw new Error("location_unconfigured");
    return id;
  };
  return {
    // Same contact and published suburb as the executor's Outlook lead read,
    // plus the recorded job site for a street the contact lacks.
    async readLead({ contactId, opportunityId }) {
      const location = locationId();
      const body = await ghlRead(`/contacts/${encodeURIComponent(contactId)}`);
      const contact = body?.contact as Obj | undefined;
      if (contact?.id !== contactId || contact?.locationId !== location) {
        throw new Error("contact_mismatch");
      }
      const jobSites = await readJobSitesLive(
        client,
        opportunityId ? [opportunityId] : [],
        [contactId],
      );
      const job = (opportunityId && jobSites[opportunityId]) ||
        jobSites[contactId] || null;
      return {
        contact,
        suburb: salesBookingPublishedSuburb(contact, job ?? undefined),
        job_site: job,
      };
    },
    readThread: execute.readThread,
    readOutlook: readResourceOutlook,
    async readGhlDirectory() {
      const location = encodeURIComponent(locationId());
      const calendars = ghlCompleteBody(
        await ghlRead(`/calendars/?locationId=${location}`),
        "calendars",
      ).map((row) => {
        const members = Array.isArray(row.teamMembers) ? row.teamMembers : null;
        const ids = (members ?? []).map((m: Obj) => m?.userId);
        return {
          id: String(row.id ?? ""),
          is_active: typeof row.isActive === "boolean" ? row.isActive : null,
          assigned_user_ids: ids.filter((v: unknown): v is string =>
            typeof v === "string" && !!v
          ),
          assignments_returned: members !== null &&
            ids.every((v: unknown) => typeof v === "string" && !!v),
        };
      });
      const users = ghlCompleteBody(
        await ghlRead(`/users/?locationId=${location}`),
        "users",
      ).map((row) => ({
        id: String(row.id ?? ""),
        email: typeof row.email === "string"
          ? row.email.trim().toLowerCase()
          : null,
      }));
      return { calendars, users };
    },
    async readGhlEvents(selector, startIso, endIso) {
      const query = new URLSearchParams({
        locationId: locationId(),
        startTime: String(Date.parse(startIso)),
        endTime: String(Date.parse(endIso)),
      });
      if ("calendarId" in selector) {
        query.set("calendarId", selector.calendarId);
        query.set("userId", selector.userId);
      } else {
        query.set("userId", selector.userId);
      }
      return ghlCompleteBody(
        await ghlRead(`/calendars/events?${query.toString()}`),
        "events",
      );
    },
    async readSystemOfferRecords(sinceIso) {
      const executions: Obj[] = [];
      for (let offset = 0;; offset += 500) {
        if (offset >= 10_000) throw new Error("read_limit_reached");
        const { data, error } = await client.from("sales_booking_executions")
          .select(
            "binding_hash,step,contact_id,state,appointment_id,claimed_at",
          )
          .gte("claimed_at", sinceIso).order("claimed_at", { ascending: true })
          .order("binding_hash", { ascending: true })
          .range(offset, offset + 499);
        if (error || !Array.isArray(data)) throw new Error("unreadable");
        executions.push(...data);
        if (data.length < 500) break;
      }
      const hashes = [...new Set(executions.map((e) => e.binding_hash))];
      const approvals: Obj[] = [];
      for (let i = 0; i < hashes.length; i += 50) {
        const { data, error } = await client.from("sales_booking_approvals")
          .select("binding_hash,step,snapshot")
          .in("binding_hash", hashes.slice(i, i + 50));
        if (error || !Array.isArray(data)) throw new Error("unreadable");
        approvals.push(...data);
      }
      approvals.push(...await ownerApprovalReader(client)(sinceIso));
      return { executions, approvals };
    },
  };
}

/** Owner-authored approval rows recorded since `sinceIso` (live ones are at
 * most 15 minutes old). Throws on a failed read, never returns a false []. */
export function ownerApprovalReader(client: Client): OwnerApprovalReader {
  return async (sinceIso) => {
    const { data, error } = await client.from("sales_booking_approvals")
      .select(
        "binding_hash,step,resource,week_start,state,reason,snapshot,approved_by_user_id,approved_by_email,approved_at,expires_at",
      ).eq("resource", "marnin").gte("approved_at", sinceIso)
      .filter("snapshot->>source", "eq", "owner")
      .order("approved_at", { ascending: false }).limit(1000);
    if (error || !Array.isArray(data)) throw new Error("unreadable");
    return data;
  };
}

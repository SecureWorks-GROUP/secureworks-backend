// ════════════════════════════════════════════════════════════
// Hugo's line router (owner ruling 11 Nov 2026).
//
// Anyone who texts or calls Hugo's line, +61 489 267 776 (GHL "SecureWorks
// Insurance"), goes into the SECUREWORKS INSURANCE PIPELINE assigned to Hugo
// Graetz: the contact's owner becomes Hugo, and the contact gets an open
// opportunity in that pipeline (SCOPE JOB) owned by Hugo, or its existing open
// one there is given to Hugo. Every contact, make-safe homeowners included
// (owner's choice, 11 Nov 2026).
//
// Calls are also handled inside GHL by the workflow "INSURANCE - Calls to
// Hugo line > Insurance pipeline + assign Hugo" (Start IVR trigger on that
// number). GHL's own text triggers cannot tell which of our numbers a customer
// texted, so texts are routed here: the receiver hands an authenticated
// InboundMessage or CustomerReplied delivery to this module, which reads the
// contact's newest conversation and acts only when the newest inbound item was
// sent TO Hugo's line within the last 30 minutes. Running it twice for one
// message does nothing new.
//
// Switch: env HUGO_LINE_ROUTER_MODE. Missing or anything else = off (nothing
// is read or written); "dry_run" reads and logs what it would do; "live"
// writes to GHL. It never touches the receiver's response, receipts or the
// evidence rows, and never throws. Logs carry ids and codes only.
// ════════════════════════════════════════════════════════════

export const HUGO_LINE_LAST9 = "489267776";
/** Hugo Graetz's GHL user id (owner of every Insurance pipeline card, read 11 Nov 2026). */
export const HUGO_USER_ID = "9o6BRmWI5Pl2I3HC9gur";
export const INSURANCE_PIPELINE_ID = "7m3FY70V8HXqwI5ZFCYS";
/** SCOPE JOB, the first stage of the Insurance pipeline. */
export const INSURANCE_FIRST_STAGE_ID = "ab01d9e3-5051-4acc-8996-5d7ca72e8327";
export const ROUTER_FRESH_MS = 30 * 60 * 1000;
export const ROUTER_SOURCE = "Hugo line (inbound text)";

const GHL_BASE = "https://services.leadconnectorhq.com";

export type RouterMode = "off" | "dry_run" | "live";

export function routerMode(raw: string | undefined): RouterMode {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "live" ? "live" : v === "dry_run" ? "dry_run" : "off";
}

export interface RouterResult {
  mode: RouterMode;
  outcome:
    | "off"
    | "skipped"
    | "would_route"
    | "routed"
    | "error";
  reason: string | null;
  contactAssigned: boolean;
  opportunity: "created" | "reassigned" | "already_hugo" | null;
  opportunityId: string | null;
}

type Json = Record<string, unknown>;

function idOf(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(v) ? v : null;
}

export function isHugoLine(raw: unknown): boolean {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length >= 9 && digits.slice(-9) === HUGO_LINE_LAST9;
}

/** The newest inbound text or call in a GHL message list (newest first or not). */
export function newestInbound(messages: unknown[]): Json | null {
  let best: Json | null = null;
  let bestMs = -Infinity;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const row = m as Json;
    if (String(row.direction ?? "").toLowerCase() !== "inbound") continue;
    const ms = Date.parse(String(row.dateAdded ?? ""));
    const at = Number.isFinite(ms) ? ms : -Infinity;
    if (best === null || at > bestMs) {
      best = row;
      bestMs = at;
    }
  }
  return best;
}

class RouterError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function ghl(
  fetchFn: typeof fetch,
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  version: string,
  body?: Json,
): Promise<Json> {
  const res = await fetchFn(`${GHL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: version,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch { /* ignore */ }
    throw new RouterError(`ghl_${method.toLowerCase()}_${res.status}`);
  }
  const data = await res.json().catch(() => null);
  return data && typeof data === "object" ? data as Json : {};
}

export async function routeHugoLine(
  body: Json,
  deps: {
    env: (name: string) => string | undefined;
    fetch: typeof fetch;
    now?: () => number;
  },
): Promise<RouterResult> {
  const mode = routerMode(deps.env("HUGO_LINE_ROUTER_MODE"));
  const result: RouterResult = {
    mode,
    outcome: "off",
    reason: null,
    contactAssigned: false,
    opportunity: null,
    opportunityId: null,
  };
  if (mode === "off") return result;

  const skip = (reason: string): RouterResult => ({
    ...result,
    outcome: "skipped",
    reason,
  });

  try {
    const token = deps.env("GHL_API_TOKEN") ?? "";
    const locationId = (deps.env("GHL_LOCATION_ID") ?? "").trim();
    if (!token || !locationId) return skip("provider_not_configured");
    const contactId = idOf(body.contactId ?? body.contact_id);
    if (!contactId) return skip("no_contact");

    // An app InboundMessage names the number it was sent to; one that names
    // another of our lines is not Hugo's, so nothing is read.
    if (body.to != null && !isHugoLine(body.to)) return skip("not_hugo_line");

    const conv = await ghl(
      deps.fetch,
      token,
      "GET",
      `/conversations/search?locationId=${encodeURIComponent(locationId)}` +
        `&contactId=${encodeURIComponent(contactId)}&limit=1`,
      "2021-04-15",
    );
    const convRows = Array.isArray(conv.conversations)
      ? conv.conversations
      : [];
    const conversationId = idOf((convRows[0] as Json | undefined)?.id);
    if (!conversationId) return skip("no_conversation");

    const page = await ghl(
      deps.fetch,
      token,
      "GET",
      `/conversations/${conversationId}/messages?limit=20`,
      "2021-04-15",
    );
    const inner = page.messages as Json | unknown[] | undefined;
    const list = Array.isArray(inner)
      ? inner
      : Array.isArray((inner as Json | undefined)?.messages)
      ? (inner as Json).messages as unknown[]
      : [];
    const inbound = newestInbound(list);
    if (!inbound) return skip("no_inbound");
    if (!isHugoLine(inbound.to)) return skip("not_hugo_line");
    const at = Date.parse(String(inbound.dateAdded ?? ""));
    const now = (deps.now ?? Date.now)();
    if (!Number.isFinite(at) || now - at > ROUTER_FRESH_MS) {
      return skip("inbound_not_fresh");
    }

    const contactRead = await ghl(
      deps.fetch,
      token,
      "GET",
      `/contacts/${contactId}`,
      "2021-07-28",
    );
    const contact = (contactRead.contact ?? {}) as Json;
    const needsContact = contact.assignedTo !== HUGO_USER_ID;

    const search = await ghl(
      deps.fetch,
      token,
      "GET",
      `/opportunities/search?location_id=${encodeURIComponent(locationId)}` +
        `&contact_id=${contactId}&pipeline_id=${INSURANCE_PIPELINE_ID}` +
        `&status=open`,
      "2021-07-28",
    );
    const opps =
      (Array.isArray(search.opportunities) ? search.opportunities : [])
        .filter((o) =>
          o && typeof o === "object" &&
          (o as Json).pipelineId === INSURANCE_PIPELINE_ID &&
          (o as Json).status === "open"
        ) as Json[];
    const open = opps[0] ?? null;
    const openId = open ? idOf(open.id) : null;
    const opportunity: RouterResult["opportunity"] = !open
      ? "created"
      : open.assignedTo === HUGO_USER_ID
      ? "already_hugo"
      : "reassigned";

    if (mode === "dry_run") {
      return {
        ...result,
        outcome: "would_route",
        reason: null,
        contactAssigned: needsContact,
        opportunity,
        opportunityId: openId,
      };
    }

    if (needsContact) {
      await ghl(
        deps.fetch,
        token,
        "PUT",
        `/contacts/${contactId}`,
        "2021-07-28",
        {
          assignedTo: HUGO_USER_ID,
        },
      );
    }
    let opportunityId = openId;
    if (opportunity === "created") {
      const name = [contact.firstName, contact.lastName]
        .filter((p) => typeof p === "string" && p.trim())
        .join(" ").trim() ||
        (typeof contact.contactName === "string" &&
          contact.contactName.trim()) ||
        "Hugo line lead";
      const created = await ghl(
        deps.fetch,
        token,
        "POST",
        `/opportunities/`,
        "2021-07-28",
        {
          locationId,
          pipelineId: INSURANCE_PIPELINE_ID,
          pipelineStageId: INSURANCE_FIRST_STAGE_ID,
          contactId,
          name,
          status: "open",
          assignedTo: HUGO_USER_ID,
          source: ROUTER_SOURCE,
        },
      );
      opportunityId = idOf((created.opportunity as Json | undefined)?.id);
    } else if (opportunity === "reassigned" && openId) {
      await ghl(
        deps.fetch,
        token,
        "PUT",
        `/opportunities/${openId}`,
        "2021-07-28",
        {
          assignedTo: HUGO_USER_ID,
        },
      );
    }
    return {
      ...result,
      outcome: "routed",
      reason: null,
      contactAssigned: needsContact,
      opportunity,
      opportunityId,
    };
  } catch (e) {
    return {
      ...result,
      outcome: "error",
      reason: e instanceof RouterError ? e.code : "router_threw",
    };
  }
}

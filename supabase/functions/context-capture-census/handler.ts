// HTTP door for the capture census (finish line row C7). The census itself is
// census.ts; the live reads are reads.ts.
//
// Who may call: a server credential (a key in SUPABASE_SECRET_KEYS, or the
// legacy service-role key while Supabase still honours it; _shared/
// service_credential.ts), or a signed-in admin or owner of the company
// organisation. Ops staff (ops_manager) are refused: the answer lists message
// ids and times for every monitored mailbox, owner mailboxes included, which is
// an owner-level read like choosing those mailboxes (ops-api
// set_monitored_mailbox) and the GHL provider reads (ghl-proxy).
//
// POST {"lane": ..., "mailbox"?, "from"?, "to"?, "next"?, "conversations"?,
// "items"?}; see census.ts for each lane. The answer is ids, times, folders,
// types and codes; never a subject, address, body or file. Logs carry the lane
// and counts only.

import {
  type LegacyKeyProbe,
  verifyServiceCredential,
} from "../_shared/service_credential.ts";
import {
  type CensusReads,
  CensusRefusal,
  type CensusRequest,
  errorCode,
  type Lane,
  runCensus,
} from "./census.ts";

export const COMPANY_ORG_ID = "00000000-0000-0000-0000-000000000001";
const OPERATOR_ROLES = new Set(["admin", "owner"]);

export interface HandlerDeps {
  /** True when the request carries a server credential. */
  isServer(headers: Headers): Promise<boolean>;
  /** The signed-in user's role and organisation for a user JWT, or null. */
  userProfile(jwt: string): Promise<{ role: string; orgId: string } | null>;
  reads(): CensusReads;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The server-credential check. A legacy service-role key is accepted by its
 * `role` claim, as for the cron callers of ops-api and monitor-ses-makesafes:
 * the key a server caller holds need not equal the key the platform injects
 * into this function, and verifyServiceCredential still asks the platform
 * whether that key is honoured before trusting it (a refused or unknown claim
 * is never accepted).
 */
export function serverCredentialCheck(
  env: (name: string) => string | undefined,
  probe?: LegacyKeyProbe,
): (headers: Headers) => Promise<boolean> {
  return async (headers) =>
    (await verifyServiceCredential(headers, {
      env,
      legacy: "service_role_claim",
      ...(probe ? { probe } : {}),
    })) !== null;
}

export async function handleCensus(
  req: Request,
  deps: HandlerDeps,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let allowed = await deps.isServer(req.headers);
  if (!allowed) {
    const header = req.headers.get("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const profile = bearer ? await deps.userProfile(bearer) : null;
    allowed = !!profile &&
      OPERATOR_ROLES.has(String(profile.role).toLowerCase()) &&
      profile.orgId === COMPANY_ORG_ID;
  }
  if (!allowed) {
    return json({
      error: "operator_required",
      detail:
        "A server credential or a company admin or owner session is required.",
    }, 403);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "body_invalid" }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "body_invalid" }, 400);
  }
  const known = new Set([
    "lane",
    "mailbox",
    "from",
    "to",
    "next",
    "conversations",
    "items",
  ]);
  const unknown = Object.keys(body).filter((k) => !known.has(k));
  if (unknown.length) {
    return json({ error: "field_unknown", fields: unknown.sort() }, 400);
  }
  const request: CensusRequest = {
    lane: body.lane as Lane,
    mailbox: typeof body.mailbox === "string" ? body.mailbox : null,
    from: typeof body.from === "string" ? body.from : null,
    to: typeof body.to === "string" ? body.to : null,
    next: typeof body.next === "string" ? body.next : null,
    conversations: Array.isArray(body.conversations)
      ? body.conversations as string[]
      : null,
    items: Array.isArray(body.items)
      ? body.items as CensusRequest["items"]
      : null,
  };
  try {
    const result = await runCensus(deps.reads(), request);
    const items = Array.isArray(result.items) ? result.items.length : 0;
    console.log(
      `[context-capture-census] lane=${request.lane} items=${items} complete=${result.complete} error=${
        result.error_code ?? "-"
      }`,
    );
    return json(result);
  } catch (e) {
    if (e instanceof CensusRefusal) return json({ error: e.code }, 400);
    const c = errorCode(e);
    console.error(
      `[context-capture-census] lane=${request.lane} failed code=${c}`,
    );
    return json({ error: c }, 502);
  }
}

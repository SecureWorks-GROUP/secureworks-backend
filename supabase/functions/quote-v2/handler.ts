// Quote v2: party link page, acceptance, server-side build, rendering and the
// owner-stamped send. PROGRAM BRANCH ONLY: not deployed until the owner
// carries the quote v2 program over. Writes no job, GHL or Xero record. A
// send captures its messages to the outbox and delivers nothing unless a
// staging-only gate is open (delivery.ts); nothing in this program opens it.
//
// Public (the link is the credential):
//   GET  ?t=<token>                 the party's own CURRENT quote, as the
//        branded document with Accept. A link to a replaced revision forwards
//        to the same party's current revision.
//   GET  ?t=<token>&format=pdf      the same quote as a PDF.
//   POST ?action=accept {t, revision_id, content_hash, accepted_name?}
//        accept exactly the revision and content that page showed.
//
// Staff (an exact server secret, or a verified signed-in admin, owner,
// ops_manager, estimator or sales session; trades, the public SW_API_KEY and
// unverified JWT claims are refused):
//   POST ?action=create_draft    {job_id, payload}        -> revision_id
//   POST ?action=set_line_markup {revision_id, line_key, multiplier, reason?}
//   POST ?action=freeze          {revision_id, valid_until}
//   POST ?action=issue_link      {revision_id, party_id}  -> token, once
//   POST ?action=revoke_link     {link_id, reason}        -> count revoked;
//        revokes EVERY link that party holds for the job, forwarding links too
//   GET  ?action=revision&revision_id=
//   GET  ?action=job_acceptance&job_id=
// Stage 3 (contract: docs/quote-v2/server-build-and-send-v1.md):
//   POST ?action=build        {job_id, family, scope, parties, items,
//        valid_until?} -> a draft priced from the price book (and frozen when
//        valid_until is given), in one transaction
//   GET  ?action=render&revision_id=&party_id=&format=html|pdf
//   POST ?action=prepare_send {revision_id, parties:[{party_id, recipients}],
//        from_name?, note?, adapter?} -> the preview and its hash
//   POST ?action=approve_send {preview_id, preview_hash}: the owner's stamp;
//        a verified session on the approver list only, never a server key
//   POST ?action=send         {preview_id, preview_hash}: runs an approved
//        preview once; a retry returns the same send
//   GET  ?action=send_status&preview_id=
// The actor on every write is the signed-in user; a server caller must name
// who it acts for in `acting_for`. Callers never choose the actor otherwise.
//
// All money and state rules live in SQL (migration
// 20260925020000_quote_v2_records.sql); this handler only routes and renders.
// Contract: docs/quote-v2/quote-records-v1.md.

import { type PartyLinkResult, renderPartyPage } from "./party_page.ts";
import {
  type QuoteDocumentView,
  quoteReference,
  renderQuoteDocumentHtml,
  sha256Hex,
} from "./quote_document.ts";
import { renderQuotePdf } from "./quote_pdf.ts";
import { buildPartyMessages } from "./send_message.ts";
import {
  deliverLiveRow,
  liveDeliveryGate,
  type LiveOutboxRow,
} from "./delivery.ts";
import {
  planScopeBuild,
  type PriceBookRow,
  ScopeBuildError,
  type ScopeInput,
  scopePriceBookKeys,
} from "./scope_build.ts";

export const QUOTE_V2_STAFF_ROLES = new Set([
  "admin",
  "owner",
  "ops_manager",
  "estimator",
  "sales",
]);

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

export interface UserIdentity {
  role: string;
  /** Who the user is, for the record (email, else user id). */
  actor: string;
  /** The verified email, when the account has one (the owner's stamp). */
  email?: string | null;
}

export interface QuoteV2Deps {
  env: (name: string) => string | undefined;
  userIdentity: (token: string) => Promise<UserIdentity | null>;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
  nonce?: () => string;
  /** Only the staging-only live adapter uses it. */
  fetch?: typeof fetch;
}

export const DEFAULT_QUOTE_SEND_APPROVER = "marnin@secureworkswa.com.au";

/** Who may stamp a send: QUOTE_V2_SEND_APPROVER_EMAILS (comma separated),
 * else the owner. */
export function quoteSendApprovers(raw: string | undefined): string[] {
  const list = (raw ?? "").split(",").map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : [DEFAULT_QUOTE_SEND_APPROVER];
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-api-key, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      ...PRIVATE_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

function refuse(status: number, code: string, error: string): Response {
  return json({ ok: false, code, error }, status);
}

const TOKEN_RE = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stable code a quote function raised, e.g. `quote_line_unpriced`. */
export function refusalCode(message: string): string | null {
  const m = /^((?:quote|price_book)_[a-z0-9_]+)/.exec(message);
  return m ? m[1] : null;
}

// Plain words for the public page. Internal detail never reaches a customer.
const ACCEPT_REFUSALS: Record<string, [number, string]> = {
  quote_link_invalid: [404, "This quote link is no longer valid."],
  quote_revision_not_current: [
    409,
    "This quote was updated. Please reopen your link to see the current quote.",
  ],
  quote_content_changed: [
    409,
    "This quote was updated. Please reopen your link to see the current quote.",
  ],
  quote_expired: [
    410,
    "This quote has expired. Please contact SecureWorks Group for an updated quote.",
  ],
  quote_party_nothing_to_accept: [
    409,
    "There is no current quote for you to accept on this job.",
  ],
};

async function readJson(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, "");
}

async function pdfResponse(view: QuoteDocumentView): Promise<Response> {
  const bytes = await renderQuotePdf(view);
  const name = `Quote-${
    quoteReference(view).replace(/[^A-Za-z0-9-]+/g, "-")
  }.pdf`;
  return new Response(bytes, {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name}"`,
    },
  });
}

async function partyPage(url: URL, deps: QuoteV2Deps): Promise<Response> {
  const token = url.searchParams.get("t") ?? "";
  const nonce = (deps.nonce ?? randomNonce)();
  let result: PartyLinkResult;
  if (!TOKEN_RE.test(token)) {
    result = { state: "unknown", link_revision_number: null, quote: null };
  } else {
    const { data, error } = await deps.rpc("quote_v2_open_party_document", {
      p_token: token,
    });
    if (error || !data || typeof data !== "object") {
      return new Response("This quote could not be loaded. Please try again.", {
        status: 502,
        headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain" },
      });
    }
    result = data as PartyLinkResult;
  }
  if (url.searchParams.get("format") === "pdf") {
    if (
      (result.state !== "current" && result.state !== "forwarded") ||
      !result.quote
    ) {
      return new Response("This quote link is no longer valid.", {
        status: 404,
        headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain" },
      });
    }
    return pdfResponse(result.quote as unknown as QuoteDocumentView);
  }
  const { status, html } = renderPartyPage(result, nonce);
  return new Response(html, {
    status,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        `default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

async function accept(req: Request, deps: QuoteV2Deps): Promise<Response> {
  const body = await readJson(req);
  const token = typeof body?.t === "string" ? body.t : "";
  const revisionId = typeof body?.revision_id === "string"
    ? body.revision_id
    : "";
  const hash = typeof body?.content_hash === "string" ? body.content_hash : "";
  if (!TOKEN_RE.test(token)) {
    return refuse(
      404,
      "quote_link_invalid",
      ACCEPT_REFUSALS.quote_link_invalid[1],
    );
  }
  if (!UUID_RE.test(revisionId) || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
    return refuse(
      400,
      "accept_body_invalid",
      "Please reopen your quote link and try again.",
    );
  }
  const name = typeof body?.accepted_name === "string"
    ? body.accepted_name.slice(0, 200)
    : null;
  const { data, error } = await deps.rpc("quote_v2_accept", {
    p_token: token,
    p_revision_id: revisionId,
    p_content_hash: hash,
    p_accepted_name: name,
  });
  if (error) {
    const code = refusalCode(error.message);
    const known = code ? ACCEPT_REFUSALS[code] : undefined;
    if (known) return refuse(known[0], code!, known[1]);
    return refuse(
      502,
      "accept_failed",
      "Your acceptance could not be recorded. Please try again.",
    );
  }
  const r = data as { state: string; accepted_at: string };
  // Whether the whole job is accepted is the office's business, not the
  // party's: it would tell a neighbour whether the client has accepted.
  return json({ ok: true, state: r.state, accepted_at: r.accepted_at });
}

type StaffAuth =
  | {
    ok: true;
    caller: "server" | "user";
    actor: string | null;
    email: string | null;
  }
  | { ok: false; response: Response };

export async function authorizeQuoteV2Staff(
  req: Request,
  deps: QuoteV2Deps,
): Promise<StaffAuth> {
  const shared = deps.env("SW_API_KEY") || null;
  const service = deps.env("SUPABASE_SERVICE_ROLE_KEY") || null;
  const agent = deps.env("OPS_AGENT_SERVER_KEY") || null;
  const xApiKey = req.headers.get("x-api-key");
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const presents = (secret: string | null) =>
    !!secret && secret !== shared && (xApiKey === secret || bearer === secret);
  // This function runs with gateway JWT verification OFF (the party page is
  // public), so a JWT's claims are never trusted here: server callers present
  // an exact secret, and a user session is verified by userIdentity.
  if (presents(service) || presents(agent)) {
    return { ok: true, caller: "server", actor: null, email: null };
  }
  if (!bearer || (shared && bearer === shared)) {
    return {
      ok: false,
      response: refuse(
        401,
        "user_jwt_required",
        "A signed-in session is required.",
      ),
    };
  }
  const who = await deps.userIdentity(bearer).catch(() => null);
  if (!who) {
    return {
      ok: false,
      response: refuse(
        401,
        "user_jwt_required",
        "A signed-in session is required.",
      ),
    };
  }
  if (!QUOTE_V2_STAFF_ROLES.has(who.role.toLowerCase())) {
    return {
      ok: false,
      response: refuse(
        403,
        "operator_access_required",
        "Quotes are staff only.",
      ),
    };
  }
  return {
    ok: true,
    caller: "user",
    actor: who.actor,
    email: who.email ? who.email.toLowerCase() : null,
  };
}

function actorFor(
  auth: { caller: "server" | "user"; actor: string | null },
  body: Record<string, unknown>,
): string | null {
  if (auth.caller === "user") return auth.actor;
  const named = typeof body.acting_for === "string"
    ? body.acting_for.trim()
    : "";
  return named ? `${named} (via server)` : null;
}

async function callStaff(
  deps: QuoteV2Deps,
  fn: string,
  args: Record<string, unknown>,
): Promise<Response> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) {
    const code = refusalCode(error.message);
    if (code) return refuse(409, code, error.message);
    return refuse(
      502,
      "quote_unreadable",
      "The quote records could not be read or written.",
    );
  }
  return json({ ok: true, result: data });
}

async function staff(
  req: Request,
  url: URL,
  action: string,
  deps: QuoteV2Deps,
): Promise<Response> {
  const auth = await authorizeQuoteV2Staff(req, deps);
  if (!auth.ok) return auth.response;

  if (req.method === "GET") {
    if (action === "revision") {
      const id = url.searchParams.get("revision_id") ?? "";
      if (!UUID_RE.test(id)) {
        return refuse(400, "revision_id_invalid", "revision_id is required.");
      }
      return await callStaff(deps, "quote_v2_staff_revision", {
        p_revision_id: id,
      });
    }
    if (action === "job_acceptance") {
      const id = url.searchParams.get("job_id") ?? "";
      if (!UUID_RE.test(id)) {
        return refuse(400, "job_id_invalid", "job_id is required.");
      }
      return await callStaff(deps, "quote_v2_job_acceptance", { p_job_id: id });
    }
    if (action === "render") return await renderAction(url, deps);
    if (action === "send_status") {
      const id = url.searchParams.get("preview_id") ?? "";
      if (!UUID_RE.test(id)) {
        return refuse(400, "preview_id_invalid", "preview_id is required.");
      }
      return await callStaff(deps, "quote_v2_send_status", {
        p_preview_id: id,
      });
    }
    return refuse(400, "action_unknown", "Unknown quote action.");
  }

  const body = await readJson(req);
  if (!body) return refuse(400, "body_invalid", "Send a JSON body.");
  const actor = actorFor(auth, body);
  if (!actor) {
    return refuse(
      400,
      "acting_for_required",
      "Name who this change is for in acting_for.",
    );
  }
  const id = (k: string) =>
    typeof body[k] === "string" && UUID_RE.test(body[k] as string)
      ? body[k] as string
      : null;

  switch (action) {
    case "create_draft": {
      if (!id("job_id") || !body.payload || typeof body.payload !== "object") {
        return refuse(
          400,
          "draft_body_invalid",
          "job_id and payload are required.",
        );
      }
      return await callStaff(deps, "quote_v2_create_draft", {
        p_job_id: body.job_id,
        p_payload: body.payload,
        p_prepared_by: actor,
      });
    }
    case "set_line_markup": {
      const multiplier = Number(body.multiplier);
      if (
        !id("revision_id") || typeof body.line_key !== "string" ||
        !Number.isFinite(multiplier)
      ) {
        return refuse(
          400,
          "markup_body_invalid",
          "revision_id, line_key and multiplier are required.",
        );
      }
      return await callStaff(deps, "quote_v2_set_line_markup", {
        p_revision_id: body.revision_id,
        p_line_key: body.line_key,
        p_multiplier: multiplier,
        p_set_by: actor,
        p_reason: typeof body.reason === "string" ? body.reason : null,
      });
    }
    case "freeze": {
      if (
        !id("revision_id") || typeof body.valid_until !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(body.valid_until)
      ) {
        return refuse(
          400,
          "freeze_body_invalid",
          "revision_id and valid_until (YYYY-MM-DD) are required.",
        );
      }
      return await callStaff(deps, "quote_v2_freeze_revision", {
        p_revision_id: body.revision_id,
        p_frozen_by: actor,
        p_valid_until: body.valid_until,
      });
    }
    case "issue_link": {
      if (!id("revision_id") || !id("party_id")) {
        return refuse(
          400,
          "link_body_invalid",
          "revision_id and party_id are required.",
        );
      }
      return await callStaff(deps, "quote_v2_issue_party_link", {
        p_revision_id: body.revision_id,
        p_party_id: body.party_id,
        p_issued_by: actor,
      });
    }
    case "revoke_link": {
      if (
        !id("link_id") || typeof body.reason !== "string" || !body.reason.trim()
      ) {
        return refuse(
          400,
          "revoke_body_invalid",
          "link_id and reason are required.",
        );
      }
      return await callStaff(deps, "quote_v2_revoke_party_link", {
        p_link_id: body.link_id,
        p_revoked_by: actor,
        p_reason: body.reason,
      });
    }
    case "build":
      return await buildAction(body, actor, deps);
    case "prepare_send":
      return await prepareSendAction(body, actor, deps);
    case "approve_send":
      return await approveSendAction(body, auth, deps);
    case "send":
      return await sendAction(body, actor, deps);
  }
  return refuse(400, "action_unknown", "Unknown quote action.");
}

export async function handleQuoteV2Request(
  req: Request,
  deps: QuoteV2Deps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";
  try {
    if (!action && req.method === "GET") return await partyPage(url, deps);
    if (action === "accept" && req.method === "POST") {
      return await accept(req, deps);
    }
    if (action && action !== "accept") {
      return await staff(req, url, action, deps);
    }
    return refuse(400, "action_unknown", "Unknown quote action.");
  } catch (_) {
    return refuse(500, "quote_error", "The quote request failed.");
  }
}

// ── Stage 3: build, render, stamped send ────────────────────────────────

function refusalFrom(error: { message: string }): Response {
  const code = refusalCode(error.message);
  if (code) return refuse(409, code, error.message);
  return refuse(
    502,
    "quote_unreadable",
    "The quote records could not be read or written.",
  );
}

async function buildAction(
  body: Record<string, unknown>,
  actor: string,
  deps: QuoteV2Deps,
): Promise<Response> {
  const jobId = typeof body.job_id === "string" && UUID_RE.test(body.job_id)
    ? body.job_id
    : null;
  const validUntil = body.valid_until;
  if (!jobId) return refuse(400, "build_body_invalid", "job_id is required.");
  if (
    validUntil !== undefined && validUntil !== null &&
    (typeof validUntil !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(validUntil))
  ) {
    return refuse(
      400,
      "build_body_invalid",
      "valid_until must be YYYY-MM-DD when given.",
    );
  }
  const input = body as unknown as ScopeInput;
  let rows: PriceBookRow[] = [];
  const keys = Array.isArray(input.items) ? scopePriceBookKeys(input) : [];
  if (keys.length) {
    const read = await deps.rpc("price_book_current_costs", {
      p_item_keys: keys,
      p_family: null,
    });
    if (read.error) {
      return refuse(
        502,
        "price_book_unreadable",
        "The price book could not be read.",
      );
    }
    rows = (Array.isArray(read.data) ? read.data : []) as PriceBookRow[];
  }
  let plan;
  try {
    plan = planScopeBuild(input, rows);
  } catch (e) {
    if (e instanceof ScopeBuildError) return refuse(409, e.code, e.message);
    throw e;
  }
  const { data, error } = await deps.rpc("quote_v2_build_draft", {
    p_job_id: jobId,
    p_payload: plan.payload,
    p_markups: plan.markups,
    p_actor: actor,
    p_valid_until: validUntil ?? null,
  });
  if (error) return refusalFrom(error);
  return json({ ok: true, result: data, cuts: plan.cuts });
}

async function partyDocument(
  deps: QuoteV2Deps,
  revisionId: string,
  partyId: string,
): Promise<{ view: QuoteDocumentView } | { response: Response }> {
  const { data, error } = await deps.rpc("quote_v2_party_document", {
    p_revision_id: revisionId,
    p_party_id: partyId,
  });
  if (error) return { response: refusalFrom(error) };
  if (!data || typeof data !== "object") {
    return {
      response: refuse(
        404,
        "quote_party_document_missing",
        "No frozen quote for that revision and party.",
      ),
    };
  }
  return { view: data as QuoteDocumentView };
}

async function renderAction(url: URL, deps: QuoteV2Deps): Promise<Response> {
  const rev = url.searchParams.get("revision_id") ?? "";
  const party = url.searchParams.get("party_id") ?? "";
  const format = url.searchParams.get("format") ?? "html";
  if (!UUID_RE.test(rev) || !UUID_RE.test(party)) {
    return refuse(
      400,
      "render_query_invalid",
      "revision_id and party_id are required.",
    );
  }
  if (format !== "html" && format !== "pdf") {
    return refuse(400, "render_format_unknown", "format is html or pdf.");
  }
  const doc = await partyDocument(deps, rev, party);
  if ("response" in doc) return doc.response;
  if (format === "pdf") return await pdfResponse(doc.view);
  return new Response(renderQuoteDocumentHtml(doc.view), {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'",
    },
  });
}

function linkBaseUrl(deps: QuoteV2Deps): string | null {
  const explicit = deps.env("QUOTE_V2_PUBLIC_BASE_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  const base = deps.env("SUPABASE_URL");
  return base ? `${base.replace(/\/+$/, "")}/functions/v1/quote-v2` : null;
}

interface SendPartyInput {
  party_id: string;
  recipients: unknown;
}

async function prepareSendAction(
  body: Record<string, unknown>,
  actor: string,
  deps: QuoteV2Deps,
): Promise<Response> {
  const rev = typeof body.revision_id === "string" &&
      UUID_RE.test(body.revision_id)
    ? body.revision_id
    : null;
  const parties = Array.isArray(body.parties)
    ? body.parties as SendPartyInput[]
    : null;
  if (
    !rev || !parties?.length ||
    parties.some((p) =>
      !p || typeof p.party_id !== "string" || !UUID_RE.test(p.party_id) ||
      !Array.isArray(p.recipients)
    )
  ) {
    return refuse(
      400,
      "send_body_invalid",
      "revision_id and parties [{party_id, recipients}] are required.",
    );
  }
  const wanted = body.adapter ?? "capture";
  if (wanted !== "capture" && wanted !== "live") {
    return refuse(400, "send_body_invalid", "adapter is capture or live.");
  }
  if (wanted === "live") {
    const gate = liveDeliveryGate(deps.env);
    if (!gate.allowed) {
      return refuse(
        409,
        "quote_send_live_disabled",
        `Live delivery is off: ${gate.reason}. Sends are captured only.`,
      );
    }
  }
  const base = linkBaseUrl(deps);
  if (!base) {
    return refuse(
      500,
      "quote_link_base_unset",
      "The public quote address is not configured.",
    );
  }
  const fromName = typeof body.from_name === "string" ? body.from_name : null;
  const note = typeof body.note === "string" ? body.note.slice(0, 1000) : null;
  const docs = await Promise.all(
    parties.map((p) => partyDocument(deps, rev, p.party_id)),
  );
  const sendParties = [];
  for (let i = 0; i < parties.length; i++) {
    const d = docs[i];
    if ("response" in d) return d.response;
    const html = renderQuoteDocumentHtml(d.view);
    const pdf = await renderQuotePdf(d.view);
    sendParties.push({
      party_id: parties[i].party_id,
      recipients: parties[i].recipients,
      messages: buildPartyMessages(d.view, { fromName, note }),
      documents: {
        html_sha256: await sha256Hex(html),
        pdf_sha256: await sha256Hex(pdf),
      },
    });
  }
  const ttl = Number.isInteger(body.ttl_minutes) ? body.ttl_minutes : 60;
  const { data, error } = await deps.rpc("quote_v2_prepare_send", {
    p_revision_id: rev,
    p_send: { adapter: wanted, link_base_url: base, parties: sendParties },
    p_prepared_by: actor,
    p_ttl_minutes: ttl,
  });
  if (error) return refusalFrom(error);
  return json({ ok: true, result: data });
}

function previewBody(
  body: Record<string, unknown>,
): { id: string; hash: string } | null {
  const id = typeof body.preview_id === "string" &&
      UUID_RE.test(body.preview_id)
    ? body.preview_id
    : null;
  const hash = typeof body.preview_hash === "string" &&
      /^[0-9a-f]{64}$/.test(body.preview_hash)
    ? body.preview_hash
    : null;
  return id && hash ? { id, hash } : null;
}

async function approveSendAction(
  body: Record<string, unknown>,
  auth: { caller: "server" | "user"; email: string | null },
  deps: QuoteV2Deps,
): Promise<Response> {
  // The stamp is a person, never a key: a server secret cannot approve, and
  // the session's verified email must be on the approver list.
  if (
    auth.caller !== "user" || !auth.email ||
    !quoteSendApprovers(deps.env("QUOTE_V2_SEND_APPROVER_EMAILS")).includes(
      auth.email,
    )
  ) {
    return refuse(
      403,
      "owner_stamp_required",
      "Only the owner can stamp a quote send, from their own session.",
    );
  }
  const p = previewBody(body);
  if (!p) {
    return refuse(
      400,
      "stamp_body_invalid",
      "preview_id and the preview_hash you were shown are required.",
    );
  }
  const { data, error } = await deps.rpc("quote_v2_approve_send", {
    p_preview_id: p.id,
    p_preview_hash: p.hash,
    p_approved_by: auth.email,
  });
  if (error) return refusalFrom(error);
  return json({ ok: true, result: data });
}

async function sendAction(
  body: Record<string, unknown>,
  actor: string,
  deps: QuoteV2Deps,
): Promise<Response> {
  const p = previewBody(body);
  if (!p) {
    return refuse(
      400,
      "send_body_invalid",
      "preview_id and preview_hash are required.",
    );
  }
  const gate = liveDeliveryGate(deps.env);
  const sent = await deps.rpc("quote_v2_execute_send", {
    p_preview_id: p.id,
    p_preview_hash: p.hash,
    p_sent_by: actor,
    p_live_allowed: gate.allowed,
  });
  if (sent.error) return refusalFrom(sent.error);
  const result = sent.data as { send_id: string; adapter: string };
  if (result.adapter !== "live" || !gate.allowed) {
    return json({ ok: true, result });
  }
  const pending = await deps.rpc("quote_v2_live_outbox_pending", {
    p_send_id: result.send_id,
  });
  if (pending.error) return refusalFrom(pending.error);
  const doFetch = deps.fetch ?? fetch;
  for (const row of (pending.data ?? []) as LiveOutboxRow[]) {
    const outcome = await deliverLiveRow(row, {
      env: deps.env,
      fetch: doFetch,
    });
    await deps.rpc("quote_v2_record_delivery", {
      p_outbox_id: row.id,
      p_outcome: outcome.outcome,
      p_provider_message_id: outcome.provider_message_id ?? null,
      p_detail: outcome.detail ?? null,
    });
  }
  const after = await deps.rpc("quote_v2_send_result", {
    p_send_id: result.send_id,
    p_replay: false,
  });
  if (after.error) return refusalFrom(after.error);
  return json({ ok: true, result: after.data });
}

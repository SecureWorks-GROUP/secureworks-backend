// deno-lint-ignore-file no-explicit-any
// The owner-approved price a quote send needs before the customer sees a
// price (20261109040000_scope_owner_approvals.sql). Every quote send path,
// send-quote /send and /send-runs and ops-api Quick Quote, judges it before
// any email.
//
//   A send that names a saved revision with the owner's price decision: its
//   PDF must be one the decision covers (approvedQuotePdf).
//   A send with no price decision, naming a saved revision or none: refused
//   while owner_approval_saved_revision_required_v1 is on (409
//   owner_price_approval_required, or ..._requires_saved_revision).
//   While the switch is off (as shipped, until the owner says) every send goes
//   exactly as today and no decision is read. It is recorded before the email
//   (claimUnapprovedLegacySend) and marked sent after it
//   (markUnapprovedLegacySendSent), best effort: a record that cannot be
//   written is logged and never stops the send.

import type { SealedSendSource } from "./quote_scope_revision_link.ts";

export const OWNER_APPROVAL_SAVED_REVISION_FLAG =
  "owner_approval_saved_revision_required_v1";

export type OwnerPriceGate =
  | {
    kind: "approved";
    approval_id: string;
    scope_revision_id: string;
    /** The sha256 of every quote PDF the decision covers: the revision's
     * quote PDFs as the server recorded them when the owner decided. Null
     * when the decision record does not carry the list (refuses any PDF). */
    quote_document_sha256s: string[] | null;
  }
  /** Sent as today while the switch is off, and recorded as unapproved.
   * scope_revision_id: the saved revision it names, or null for none. */
  | { kind: "legacy_unapproved"; scope_revision_id: string | null }
  /** The sealed-revision judgement refuses this send on its own. */
  | { kind: "not_judged" }
  | {
    kind: "refused";
    status: number;
    body: { error: string; code: string };
  };

export async function ownerPriceGate(
  sb: any,
  jobId: string,
  sealed: SealedSendSource,
): Promise<OwnerPriceGate> {
  if (sealed.kind === "refused") return { kind: "not_judged" };
  const revisionId = sealed.kind === "sealed" ? sealed.revision_id : null;
  // The switch first. Off (as shipped) the send goes exactly as today: no
  // decision is read, so a decision recorded early never selects the stricter
  // PDF check. A switch that cannot be read counts as off and is logged, so a
  // flag read never stops a send that goes today.
  const required = await readRequiredFlag(sb);
  if (required !== true) {
    if (required === null) {
      console.error("[owner-price] switch unreadable; sending as today");
    }
    return { kind: "legacy_unapproved", scope_revision_id: revisionId };
  }
  if (sealed.kind !== "sealed") {
    return {
      kind: "refused",
      status: 409,
      body: {
        error:
          "This send names no saved quote revision, so the owner's price approval cannot be checked. Nothing was sent. Save the quote, have the owner approve its price, then send again.",
        code: "owner_price_approval_requires_saved_revision",
      },
    };
  }
  try {
    const { data, error } = await sb.rpc("scope_price_owner_approval", {
      p_job_id: jobId,
      p_scope_revision_id: sealed.revision_id,
    });
    if (error) return unreadable();
    if (!data || typeof data !== "object" || !data.id) {
      return {
        kind: "refused",
        status: 409,
        body: {
          error:
            "The owner has not approved the price on this saved quote revision. Nothing was sent. Ask the owner to approve the price, then send again.",
          code: "owner_price_approval_required",
        },
      };
    }
    return {
      kind: "approved",
      approval_id: String(data.id),
      scope_revision_id: sealed.revision_id,
      quote_document_sha256s: documentList(data.quote_document_sha256s),
    };
  } catch {
    return unreadable();
  }
}

/** The switch, or null when it cannot be read (the caller counts it as off). */
async function readRequiredFlag(sb: any): Promise<boolean | null> {
  try {
    const { data, error } = await sb.from("feature_flags").select("enabled")
      .eq("flag_name", OWNER_APPROVAL_SAVED_REVISION_FLAG).maybeSingle();
    if (error) return null;
    return data?.enabled === true;
  } catch {
    return null;
  }
}

function documentList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) return null;
  return value as string[];
}

function unreadable(): OwnerPriceGate {
  return {
    kind: "refused",
    status: 503,
    body: {
      error:
        "Could not check the owner's price approval. Nothing was sent. Try again.",
      code: "owner_price_approval_unreadable",
    },
  };
}

export type UnapprovedSendPath = "send" | "send-runs" | "quick-quote";

/** The one record key per send: a quote document, or one Quick Quote call. */
export function unapprovedSendKeyForDocument(documentId: string): string {
  return `quote_document:${documentId}`;
}
export function unapprovedSendKeyForQuickQuote(callId: string): string {
  return `quick_quote:${callId}`;
}

type UnapprovedSend = {
  send_key: string;
  job_id: string;
  path: UnapprovedSendPath;
  document_id: string | null;
  /** The saved revision the send names, when it names one. */
  scope_revision_id?: string | null;
};

/** Before the email: the record of a send with no owner price decision
 * (quote_send_price_unapproved_sends). Idempotent on its key, whichever send
 * path claimed it first. Best effort: a record that cannot be written is
 * logged and the send goes exactly as today. recorded says whether it holds. */
export async function claimUnapprovedLegacySend(
  sb: any,
  send: UnapprovedSend,
): Promise<{ ok: true; recorded: boolean }> {
  try {
    const { data, error } = await sb.rpc("record_quote_send_price_unapproved", {
      p_send_key: send.send_key,
      p_job_id: send.job_id,
      p_path: send.path,
      p_document_id: send.document_id,
      p_state: "claimed",
      p_scope_revision_id: send.scope_revision_id ?? null,
    });
    if (!error && data?.recorded === true) return { ok: true, recorded: true };
    console.error(
      "[owner-price] unapproved send not recorded; sending as today:",
      error?.code ?? "not_recorded",
    );
  } catch {
    console.error("[owner-price] unapproved send record unreachable; sending as today");
  }
  return { ok: true, recorded: false };
}

/** After the provider took the email, or on a replay of a published document:
 * moves an existing record to sent. Never invents a record and never blocks;
 * a record left claimed still accounts for the send. */
export async function markUnapprovedLegacySendSent(
  sb: any,
  send: UnapprovedSend,
): Promise<boolean> {
  try {
    const { data, error } = await sb.rpc("record_quote_send_price_unapproved", {
      p_send_key: send.send_key,
      p_job_id: send.job_id,
      p_path: send.path,
      p_document_id: send.document_id,
      p_state: "sent",
    });
    if (!error && data?.recorded === true) return true;
    if (error) {
      console.error("[owner-price] unapproved send not marked sent:", error.code ?? "error");
    }
  } catch {
    console.error("[owner-price] unapproved send not marked sent");
  }
  return false;
}

/** Everything a send path needs before its email, in one call: the price
 * gate, then (for a send naming no saved revision while the switch allows
 * it) the durable record. go carries the record to mark sent after the
 * provider took the email. */
export async function ownerPriceBeforeSend(
  sb: any,
  input: {
    job_id: string;
    sealed: SealedSendSource;
    path: UnapprovedSendPath;
    send_key: string;
    document_id: string | null;
  },
): Promise<
  | {
    kind: "go";
    unapproved: UnapprovedSend | null;
    approved: Extract<OwnerPriceGate, { kind: "approved" }> | null;
  }
  | { kind: "refused"; status: number; body: { error: string; code: string } }
> {
  const gate = await ownerPriceGate(sb, input.job_id, input.sealed);
  if (gate.kind === "refused") return gate;
  if (gate.kind === "not_judged") {
    return {
      kind: "refused",
      status: 409,
      body: {
        error: "The named quote revision could not be proved. Nothing was sent.",
        code: "owner_price_approval_not_judged",
      },
    };
  }
  if (gate.kind === "approved") return { kind: "go", unapproved: null, approved: gate };
  const unapproved: UnapprovedSend = {
    send_key: input.send_key,
    job_id: input.job_id,
    path: input.path,
    document_id: input.document_id,
    scope_revision_id: gate.scope_revision_id,
  };
  await claimUnapprovedLegacySend(sb, unapproved);
  return { kind: "go", unapproved, approved: null };
}

const MAX_QUOTE_PDF_BYTES = 26214400;

type PdfRefusal = {
  ok: false;
  status: number;
  body: { error: string; code: string };
};

function pdfRefusal(status: number, code: string, error: string): PdfRefusal {
  return { ok: false, status, body: { error, code } };
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** On a send naming an approved saved revision, the PDF that goes out must be
 * one the owner's price decision covers: the same sha256 as a quote PDF the
 * server recorded on that revision when the owner decided. The bytes are read
 * once here and the caller sends exactly these bytes, never the URL again.
 * Anything else, or a PDF that cannot be read, refuses: nothing is sent. */
export async function approvedQuotePdf(
  gate: Extract<OwnerPriceGate, { kind: "approved" }>,
  pdfUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; bytes: Uint8Array; sha256: string } | PdfRefusal> {
  const unreadable = () =>
    pdfRefusal(
      503,
      "owner_price_pdf_unreadable",
      "Could not read the quote PDF to check it against the approved quote. Nothing was sent. Try again.",
    );
  if (!gate.quote_document_sha256s) return unreadable();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const res = await fetchImpl(pdfUrl);
    if (!res.ok) return unreadable();
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return unreadable();
  }
  if (bytes.length === 0 || bytes.length > MAX_QUOTE_PDF_BYTES) return unreadable();
  const sha256 = await sha256Hex(bytes);
  if (!gate.quote_document_sha256s.includes(sha256)) {
    return pdfRefusal(
      409,
      "owner_price_pdf_not_approved",
      "This quote PDF is not one the owner approved with this quote's price. Nothing was sent. Send the approved quote PDF, or save the new quote and have the owner approve it.",
    );
  }
  return { ok: true, bytes, sha256 };
}

/** Every run PDF a send names, checked as approvedQuotePdf does, by run
 * label. One that fails refuses the whole send. */
export async function approvedQuotePdfsByLabel(
  gate: Extract<OwnerPriceGate, { kind: "approved" }>,
  runPdfs: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; byLabel: Map<string, Uint8Array> } | PdfRefusal> {
  const byLabel = new Map<string, Uint8Array>();
  if (!runPdfs || typeof runPdfs !== "object") return { ok: true, byLabel };
  for (const [label, url] of Object.entries(runPdfs as Record<string, unknown>)) {
    if (typeof url !== "string" || url.length === 0) continue;
    const checked = await approvedQuotePdf(gate, url, fetchImpl);
    if (!checked.ok) return checked;
    byLabel.set(label, checked.bytes);
  }
  return { ok: true, byLabel };
}

/** The price a quote document's page shows (its stored snapshot), on a send
 * naming an approved saved revision, must be a figure that revision's frozen
 * price holds: the job total or one party's share, inc GST, to the cent. A
 * document that shows no price passes. */
export function approvedDocumentSnapshotPrice(
  snapshot: unknown,
  sealedPricing: unknown,
): { ok: true } | PdfRefusal {
  const shown = snapshot && typeof snapshot === "object"
    ? ((snapshot as any).totalIncGST || (snapshot as any).total || null)
    : null;
  if (shown === null || shown === undefined || shown === "") return { ok: true };
  const cents = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };
  const shownCents = cents(shown);
  const pricing = (sealedPricing && typeof sealedPricing === "object") ? sealedPricing as any : {};
  const approved = new Set<number>();
  const total = cents(pricing.totalIncGST);
  if (total !== null) approved.add(total);
  for (const party of Array.isArray(pricing.parties) ? pricing.parties : []) {
    const share = cents(party?.inc_gst);
    if (share !== null) approved.add(share);
  }
  if (shownCents !== null && approved.has(shownCents)) return { ok: true };
  return pdfRefusal(
    409,
    "owner_price_document_price_mismatch",
    "This quote document shows a price that is not in the approved quote. Nothing was sent. Make the quote document again from the approved quote, or save the new quote and have the owner approve it.",
  );
}

/** Base64 for an email attachment, in chunks. */
export function quotePdfBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(out);
}

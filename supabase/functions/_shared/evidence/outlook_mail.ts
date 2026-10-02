// The one mapping from an Outlook message or M365 group post to a
// business_events row (context build plan slice EM2; design email.md §2, §3,
// §13a). The reader (supabase/functions/outlook-mail-capture) builds every
// email row here and saves it through public.capture_business_event(p_row).
//
// Rules (each pinned by outlook_mail_test.ts):
//   * key: email:<internet message id>, lower case, angle brackets removed, so
//     one email copied into several mailboxes (and a group post of it) is one
//     row. With no internet id: graph:<mailbox>:<graph id>.
//   * body: "Subject: <subject>" first (the ladder's step 1 and Luna read the
//     subject through payload.body), a "To-tag:" line when a recipient is
//     patios+<job>@ or fencing+<job>@, then the new words only (Graph
//     uniqueBody; a group post is cut at its first quoted-history marker).
//     Cut at 20,000 characters, flagged.
//   * who sent it is decided here, deterministically, with no model call:
//     ours, supplier (domain on suppliers), council (gov.au), automated
//     (no-reply, platform, auto-submitted, list mail) or customer. Automated
//     mail is not written unless it names exactly one of our references;
//     platform mail (Xero, MYOB, ...) is never written.
//   * owner mailboxes (owner_privacy): our own human-sent mail is captured
//     only when it names one of our references or goes to a job's client
//     email (D-EM3). Tool-marked mail is always captured.
//   * payload.email is the counterpart (inbound sender, outbound first outside
//     recipient), the key the placement ladder matches against a job.
//   * attachments: names, types and sizes only on the row; the bytes are the
//     reader's attachment ledger's business, never this row's.
//
// Pure: no I/O, no clock, no model call.

import { jobRefTokens } from "../job_refs.ts";

export type CaptureMode = "live" | "backfill" | "relink";
export type FolderKind = "inbox" | "sent" | "deleted" | "other" | "group";
export type SenderKind =
  | "ours"
  | "supplier"
  | "council"
  | "automated"
  | "customer";

export interface OutlookAttachmentMeta {
  id: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  isInline?: boolean | null;
  /** fileAttachment, itemAttachment or referenceAttachment. */
  kind?: "file" | "item" | "reference" | null;
}

/** One message (user mailbox) or post (group), already read from Graph. */
export interface OutlookMailItem {
  graphId: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  subject?: string | null;
  from?: string | null;
  to?: string[] | null;
  cc?: string[] | null;
  receivedAt?: string | null;
  sentAt?: string | null;
  /** The new words: uniqueBody text, or a group post's body. */
  bodyText?: string | null;
  /** True when bodyText is HTML (a group post without a text preference). */
  bodyIsHtml?: boolean | null;
  /** Header names lower case. Only a few are read (auto-submitted, list mail, tool marker). */
  headers?: Record<string, string> | null;
  folderKind: FolderKind;
  hasAttachments?: boolean | null;
  attachments?: OutlookAttachmentMeta[] | null;
}

export interface OutlookSource {
  email: string;
  sourceKey: string;
  kind: "user" | "group";
  scopeLabel: string;
  ownerPrivacy: boolean;
}

export interface OutlookCaptureContext {
  /** business_events.source, e.g. "outlook-mail-capture". */
  source: string;
  captureMode: CaptureMode;
  /** Lower-case domains of suppliers.email. */
  supplierDomains?: ReadonlySet<string>;
  /** Lower-case client emails of our jobs (owner-mailbox privacy rule). */
  jobClientEmails?: ReadonlySet<string>;
}

export type OutlookSkipReason =
  | "no_id"
  | "no_sender"
  | "skipped_noise"
  | "skipped_private";

export type OutlookMailBuild =
  | { kind: "row"; row: Record<string, unknown>; senderKind: SenderKind }
  | { kind: "skip"; reason: OutlookSkipReason; senderKind?: SenderKind };

export const BODY_MAX_CHARS = 20_000;
export const PREVIEW_CHARS = 500;
export const SUBJECT_MAX_CHARS = 200;
export const ATTACHMENTS_ON_ROW = 10;

const OUR_DOMAIN =
  /(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$/;
/** Platforms whose notifications are never job evidence on their own. */
const PLATFORM_DOMAIN =
  /(^|\.)(xero\.com|myob\.com|docusign\.net|docusign\.com|stripe\.com|paypal\.com|intuit\.com|mailchimp\.com|mcsv\.net|hubspot\.com|linkedin\.com|facebookmail\.com|google\.com|microsoft\.com|office\.com|office365\.com)$/;
const NO_REPLY_LOCAL =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|mailer[-_.]?daemon|postmaster|bounces?|alerts?|newsletter|news|marketing|info[-_.]?noreply)([-_.+].*)?$/;
/** Our reference grammar: job numbers (SWP-, SWF-, SWD-, SWR-, SWMS-, legacy SW1234), INV-, PO-. */
const OUR_REF = /^(SW[A-Z]{0,3}-?\d{3,}|INV-\d{3,}|PO-?\d{4,})$/;
const TO_TAG = /^(patios|fencing)\+([a-z0-9-]{3,40})@secureworkswa\.com\.au$/;

/** Lower-case bare address of "Name <a@b>" or "a@b"; null when not an address. */
export function emailAddress(raw: string | null | undefined): string | null {
  const s = String(raw ?? "");
  const angled = /<([^<>]*)>/.exec(s);
  const a = (angled ? angled[1] : s).trim().toLowerCase();
  return /^[^\s@<>]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(a) ? a : null;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

export function isOurAddress(address: string | null | undefined): boolean {
  const a = emailAddress(address);
  return !!a && OUR_DOMAIN.test(domainOf(a));
}

/** Key for one email: email:<internet id> (lower case, no angle brackets). */
export function emailProviderKey(
  internetMessageId: string | null | undefined,
): string | null {
  const id = String(internetMessageId ?? "").trim().replace(/^<+|>+$/g, "")
    .trim().toLowerCase();
  if (!id || /\s/.test(id) || id.length > 900) return null;
  return `email:${id}`;
}

function isSupplierDomain(
  domain: string,
  suppliers: ReadonlySet<string> | undefined,
): boolean {
  if (!suppliers || suppliers.size === 0) return false;
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (suppliers.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

function headerValue(
  headers: Record<string, string> | null | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const v = headers[name.toLowerCase()];
  return typeof v === "string" ? v.trim() : null;
}

/** Bulk or machine-sent, by header: Auto-Submitted, List-Unsubscribe/List-Id, Precedence. */
function headerSaysAutomated(
  headers: Record<string, string> | null | undefined,
): boolean {
  const auto = (headerValue(headers, "auto-submitted") ?? "").toLowerCase();
  if (auto && auto !== "no") return true;
  if (headerValue(headers, "list-unsubscribe")) return true;
  if (headerValue(headers, "list-id")) return true;
  const precedence = (headerValue(headers, "precedence") ?? "").toLowerCase();
  return precedence === "bulk" || precedence === "list" ||
    precedence === "junk";
}

/** Marked by one of our sending tools (send-outlook-email and siblings). */
export function toolMarked(
  headers: Record<string, string> | null | undefined,
): boolean {
  return !!(headerValue(headers, "x-sw-job-id") ??
    headerValue(headers, "x-sw-tool") ??
    headerValue(headers, "x-secureworks-ses-operation"));
}

/** Who sent it, from the sender address and headers. */
export function senderKind(
  from: string | null,
  headers: Record<string, string> | null | undefined,
  supplierDomains?: ReadonlySet<string>,
): SenderKind {
  const a = emailAddress(from);
  if (!a) return "automated";
  const domain = domainOf(a);
  if (OUR_DOMAIN.test(domain)) return "ours";
  if (/(^|\.)gov\.au$/.test(domain)) return "council";
  if (isSupplierDomain(domain, supplierDomains)) return "supplier";
  if (PLATFORM_DOMAIN.test(domain)) return "automated";
  if (NO_REPLY_LOCAL.test(a.slice(0, a.indexOf("@")))) return "automated";
  if (headerSaysAutomated(headers)) return "automated";
  return "customer";
}

function isPlatform(from: string | null): boolean {
  const a = emailAddress(from);
  return !!a && PLATFORM_DOMAIN.test(domainOf(a));
}

/** Our reference tokens a text names (job numbers, INV-, PO-), distinct. */
export function ourReferences(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of jobRefTokens(text)) {
    if (!OUR_REF.test(t)) continue;
    const same = t.replace(/-/g, "");
    if (seen.has(same)) continue;
    seen.add(same);
    out.push(t);
  }
  return out;
}

/** HTML to plain text: tags dropped, block ends as new lines, common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

/** Whitespace tidied: CRLF to LF, runs of spaces to one, at most one blank line. */
export function tidyText(text: string): string {
  return text.replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const QUOTE_MARKERS: RegExp[] = [
  // Outlook desktop and web: separator line, then From:/Sent:
  /^_{8,}\s*$/,
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  /^from:\s.+$/i,
  // Quoted lines (Gmail plain text, Apple Mail).
  /^>/,
];
/** "On <date>, <name> wrote:" (Gmail, Yahoo, iPhone), on one line or two. */
const WROTE = /^on\s.{4,300}\bwrote:?$/i;

/**
 * The new words of a post that carries its whole thread: everything before the
 * first quoted-history marker. A "From:" line only counts when a Sent:, Date:,
 * To: or Subject: line follows within three lines (Outlook's header block), so
 * a sentence starting "From:" is kept.
 */
export function cutQuotedHistory(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const pair = i + 1 < lines.length ? `${line} ${lines[i + 1].trim()}` : line;
    if (WROTE.test(line) || (/^on\s/i.test(line) && WROTE.test(pair))) {
      return lines.slice(0, i).join("\n");
    }
    for (const marker of QUOTE_MARKERS) {
      if (!marker.test(line)) continue;
      if (/^from:/i.test(line)) {
        const next = lines.slice(i + 1, i + 4).join("\n");
        if (!/^(sent|date|to|subject):/im.test(next)) continue;
      }
      return lines.slice(0, i).join("\n");
    }
  }
  return text;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function addresses(list: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of list ?? []) {
    const a = emailAddress(raw);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/** The business line from the whole recipient list: one group address decides; both or neither decide nothing. */
export function lineFromRecipients(recipients: string[]): {
  line: "patio" | "fencing" | null;
  delivered_to: string | null;
} {
  const patios = recipients.find((a) =>
    /^patios(\+[^@]*)?@/.test(a) && isOurAddress(a)
  );
  const fencing = recipients.find((a) =>
    /^fencing(\+[^@]*)?@/.test(a) && isOurAddress(a)
  );
  if (patios && !fencing) return { line: "patio", delivered_to: patios };
  if (fencing && !patios) return { line: "fencing", delivered_to: fencing };
  return { line: null, delivered_to: null };
}

/** A plus-addressed reply tag naming a job number (patios+SWP-26195@). */
export function toTag(recipients: string[]): string | null {
  for (const a of recipients) {
    const m = TO_TAG.exec(a);
    if (m && /[0-9]/.test(m[2]) && m[2].length >= 5) return m[2].toUpperCase();
  }
  return null;
}

/** The row for one Outlook message or group post, or why it is not written. */
export function buildOutlookMailRow(
  item: OutlookMailItem,
  source: OutlookSource,
  ctx: OutlookCaptureContext,
): OutlookMailBuild {
  const graphId = String(item.graphId ?? "").trim();
  if (!graphId) return { kind: "skip", reason: "no_id" };
  const from = emailAddress(item.from);
  if (!from) return { kind: "skip", reason: "no_sender" };

  const to = addresses(item.to);
  const cc = addresses(item.cc);
  const mailbox = source.email.toLowerCase();
  const recipients = source.kind === "group"
    ? [...new Set([...to, ...cc, mailbox])]
    : [...new Set([...to, ...cc])];
  const external = recipients.filter((a) => !isOurAddress(a));
  const kind = senderKind(from, item.headers, ctx.supplierDomains);

  const subject = clip(tidyText(String(item.subject ?? "")), SUBJECT_MAX_CHARS);
  let words = String(item.bodyText ?? "");
  if (item.bodyIsHtml) words = htmlToText(words);
  words = tidyText(words);
  let bodySource: "unique_body" | "post_body_cut" = "unique_body";
  if (source.kind === "group") {
    words = tidyText(cutQuotedHistory(words));
    bodySource = "post_body_cut";
  }
  const tag = toTag(recipients);
  const head = `Subject: ${subject || "(no subject)"}` +
    (tag ? `\nTo-tag: ${tag}` : "");
  const full = words ? `${head}\n\n${words}` : head;
  const refs = ourReferences(`${subject}\n${tag ?? ""}\n${words}`);

  let eventType: string;
  let direction: "inbound" | "outbound" | "internal";
  let counterpart: string | null;
  if (kind === "ours") {
    direction = external.length > 0 ? "outbound" : "internal";
    eventType = direction === "outbound"
      ? "client.email_out"
      : "staff.email_internal";
    counterpart = direction === "outbound" ? external[0] : null;
    const marked = toolMarked(item.headers);
    if (source.ownerPrivacy && !marked && source.kind === "user") {
      const toClient = !!ctx.jobClientEmails &&
        external.some((a) => ctx.jobClientEmails!.has(a));
      if (refs.length === 0 && !toClient) {
        return { kind: "skip", reason: "skipped_private", senderKind: kind };
      }
    }
  } else {
    direction = "inbound";
    counterpart = from;
    if (kind === "automated") {
      if (isPlatform(from) || refs.length !== 1) {
        return { kind: "skip", reason: "skipped_noise", senderKind: kind };
      }
      eventType = "supplier.email_in";
    } else {
      eventType = kind === "supplier" ? "supplier.email_in" : "client.email_in";
    }
  }

  const keyFromInternet = emailProviderKey(item.internetMessageId);
  const key = keyFromInternet ?? `graph:${mailbox}:${graphId}`;
  const truncated = full.length > BODY_MAX_CHARS;
  const body = clip(full, BODY_MAX_CHARS);
  const line = lineFromRecipients(recipients);
  const eventAt = direction === "inbound"
    ? (item.receivedAt ?? item.sentAt ?? null)
    : (item.sentAt ?? item.receivedAt ?? null);
  const atts = (item.attachments ?? []).slice(0, ATTACHMENTS_ON_ROW).map((
    a,
  ) => ({
    name: a.name ?? null,
    content_type: a.contentType ?? null,
    size: typeof a.size === "number" ? a.size : null,
    inline: a.isInline === true,
    kind: a.kind ?? "file",
  }));

  const payload: Record<string, unknown> = {
    body,
    subject,
    email: counterpart,
    from,
    to,
    cc,
    mailbox,
    folder_kind: item.folderKind,
    delivered_to: line.delivered_to,
    line: line.line,
    sender_kind: kind,
    sent_by_kind: kind === "ours"
      ? (toolMarked(item.headers) ? "our_tool" : "staff_email")
      : "external",
    sent_by_user: kind === "ours" ? from : null,
    internet_message_id: keyFromInternet ? keyFromInternet.slice(6) : null,
    conversation_id: item.conversationId ?? null,
    body_source: bodySource,
    body_truncated: truncated,
    body_chars_total: full.length,
    has_attachments: item.hasAttachments === true || atts.length > 0,
    attachments: atts,
    attachments_total: (item.attachments ?? []).length,
    references: refs,
    event_at_source: eventAt ? "provider" : "missing",
  };
  if (tag) payload.to_tag = tag;

  return {
    kind: "row",
    senderKind: kind,
    row: {
      event_type: eventType,
      source: ctx.source,
      entity_type: "email",
      entity_id: key,
      job_id: null,
      match_method: "none",
      event_at: eventAt,
      provider_message_id: key,
      channel: "email",
      direction,
      thread_key: item.conversationId ? `outlook:${item.conversationId}` : null,
      body_preview: body.slice(0, PREVIEW_CHARS),
      safe_summary: body.slice(0, 280),
      privacy_classification: source.ownerPrivacy
        ? "restricted_pii"
        : "staff_only",
      retention_class: "7y_audit",
      payload,
      metadata: keyFromInternet
        ? { capture_mode: ctx.captureMode, capture_path: "outlook_mail_v1" }
        : {
          capture_mode: ctx.captureMode,
          capture_path: "outlook_mail_v1",
          no_internet_id: true,
        },
    },
  };
}

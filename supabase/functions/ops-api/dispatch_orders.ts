// deno-lint-ignore-file no-explicit-any
// Dispatch slice 5: a purchase order and its email, one supplier at a time.
// The rules, pure. Contract: docs/dispatch-slice-5-contract.md.
//
// dispatch_orders_store.ts reads and writes; this module decides: which lines
// go on an order and the order line shape, the draft's subject and message,
// the draft hash a Send must echo, the supplier address check, the order chip
// on a supplier card, and how po_communications rows group into threads.
// Nothing here prices anything: an order line is item, quantity and unit.

import { isOwnDomain } from "./makesafe_compact_reads.ts";

export const DISPATCH_ORDER_PDF_BUCKET = "dispatch-order-pdfs";
export const DISPATCH_ORDER_PDF_LINK_SECONDS = 300;
export const DISPATCH_DRAFT_SUBJECT_MAX = 300;
export const DISPATCH_DRAFT_BODY_MAX = 20_000;
export const DISPATCH_ORDER_LINES_MAX = 500;
// A claim older than this with no answer is treated as a send whose result is
// unknown: the worker that held it is gone, and the same idempotency key makes
// a retry safe.
export const DISPATCH_SENDING_STALE_MS = 120_000;
export const DISPATCH_THREAD_ROWS_LOG_AT = 500;

// ── Order lines ─────────────────────────────────────────────────────────────

export type DispatchOrderLine = {
  line_id: string;
  description: string;
  quantity: number | null;
  unit: string | null;
};

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function byPosition(a: any, b: any): number {
  const pa = Number(a?.position), pb = Number(b?.position);
  if (pa !== pb) {
    return (Number.isFinite(pa) ? pa : 0) - (Number.isFinite(pb) ? pb : 0);
  }
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

// The lines that go on a new order for this supplier (ruling O4): every line
// under it marked To order and on no order. Not reviewed and In stock lines,
// and every other supplier's lines, are left alone.
export function dispatchOrderableLines(
  lines: any[],
  supplierId: string,
): any[] {
  return (Array.isArray(lines) ? lines : [])
    .filter((line) =>
      String(line?.supplier_id ?? "") === supplierId &&
      line?.status === "to_order" && !line?.purchase_order_id
    )
    .sort(byPosition);
}

// The order's copy of a working line, made at the press: no price.
export function dispatchOrderLine(line: any): DispatchOrderLine {
  return {
    line_id: String(line?.id ?? ""),
    description: String(line?.description ?? ""),
    quantity: numberOrNull(line?.quantity),
    unit: typeof line?.unit === "string" && line.unit.trim() ? line.unit : null,
  };
}

export function dispatchOrderLines(lines: any[]): DispatchOrderLine[] {
  return [...(Array.isArray(lines) ? lines : [])].sort(byPosition).map(
    dispatchOrderLine,
  );
}

export type DispatchLineStamp = { id: string; updated_at: string };

// The caller's {id, updated_at} list against the stored rows: the same ids,
// each with the same stamp. Stamps are compared as instants, so the same
// moment written two ways (Z or +00:00) is the same.
export function dispatchSameLineSet(
  expected: DispatchLineStamp[],
  stored: any[],
): boolean {
  if (expected.length !== stored.length) return false;
  const byId = new Map(stored.map((row) => [String(row?.id), row]));
  if (byId.size !== stored.length) return false;
  for (const stamp of expected) {
    const row = byId.get(String(stamp.id));
    if (!row || !sameInstant(stamp.updated_at, row.updated_at)) return false;
  }
  return new Set(expected.map((s) => s.id)).size === expected.length;
}

export function sameInstant(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a === b) return true;
  // Date keeps milliseconds only; compare the microsecond part as text too.
  const micro = (s: string) => (/\.(\d+)/.exec(s)?.[1] ?? "").padEnd(6, "0");
  const ta = Date.parse(a), tb = Date.parse(b);
  return Number.isFinite(ta) && ta === tb && micro(a) === micro(b);
}

// ── The draft's text (section 4.3) ──────────────────────────────────────────

export function formatDispatchQuantity(quantity: number): string {
  // numeric(12,3): at most three places, never trailing zeros.
  return String(Math.round(quantity * 1000) / 1000);
}

// "18 sheets Colorbond sheet 2.1 m". A line with no quantity says its
// quantity is to confirm (a scope can leave a quantity unknown, SQ-29), so
// the supplier never reads the item alone as a whole order; quantity and
// unit print as stored.
export const DISPATCH_QUANTITY_TO_CONFIRM = "quantity to confirm";

export function dispatchOrderLineText(line: DispatchOrderLine): string {
  const item = String(line.description ?? "").trim();
  if (line.quantity === null || line.quantity === undefined) {
    return `${item} (${DISPATCH_QUANTITY_TO_CONFIRM})`;
  }
  const unit = line.unit ? ` ${line.unit.trim()}` : "";
  return `${formatDispatchQuantity(line.quantity)}${unit} ${item}`;
}

export type DispatchDraftKind = "order" | "update";

export function dispatchOrderSubject(
  kind: DispatchDraftKind,
  poNumber: string,
  jobNumber: string | null,
): string {
  const job = jobNumber ? ` for ${jobNumber}` : "";
  return kind === "update"
    ? `Updated purchase order ${poNumber}${job}`
    : `Purchase order ${poNumber}${job}`;
}

// Lines added and taken off since the order email last sent, by line id. A
// line whose words changed is never possible on an order (lines are locked),
// so a line is either in both, added, or taken off.
export function dispatchOrderLineChanges(
  previous: DispatchOrderLine[],
  current: DispatchOrderLine[],
): { added: DispatchOrderLine[]; removed: DispatchOrderLine[] } {
  const before = new Set(previous.map((l) => l.line_id));
  const after = new Set(current.map((l) => l.line_id));
  return {
    added: current.filter((l) => !before.has(l.line_id)),
    removed: previous.filter((l) => !after.has(l.line_id)),
  };
}

// The message as the server writes it. Plain English, no long dashes, no
// prices; the street address is in the PDF, not here.
export function dispatchOrderBody(input: {
  kind: DispatchDraftKind;
  poNumber: string;
  jobNumber: string | null;
  suburb: string | null;
  lines: DispatchOrderLine[];
  previousLines?: DispatchOrderLine[] | null;
}): string {
  const job = input.jobNumber || "this job";
  const suburb = typeof input.suburb === "string" && input.suburb.trim()
    ? ` (${input.suburb.trim()})`
    : "";
  const lineBlock = input.lines.map(dispatchOrderLineText).join("\n");
  const parts: string[] = ["Hi team,"];
  if (input.kind === "update") {
    parts.push(
      `Please find attached the updated ${input.poNumber} for job ${job}${suburb}.`,
    );
    const changes = dispatchOrderLineChanges(
      input.previousLines || [],
      input.lines,
    );
    if (changes.added.length > 0) {
      parts.push(
        `Added:\n${changes.added.map(dispatchOrderLineText).join("\n")}`,
      );
    }
    if (changes.removed.length > 0) {
      parts.push(
        `Taken off:\n${changes.removed.map(dispatchOrderLineText).join("\n")}`,
      );
    }
    parts.push(`The order now reads:\n${lineBlock}`);
  } else {
    parts.push(
      `Please find attached ${input.poNumber} for job ${job}${suburb}.`,
    );
    parts.push(lineBlock);
  }
  parts.push(
    input.jobNumber
      ? `Please confirm the delivery date, and quote ${input.jobNumber} on your delivery docket and invoice.`
      : "Please confirm the delivery date.",
  );
  parts.push("Thanks,\nSecureWorks Group");
  return parts.join("\n\n");
}

// ── Hashes ──────────────────────────────────────────────────────────────────

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

// sha256 of the canonical JSON of exactly what a Send would send. The screen
// holds it from the last read or save and echoes it; a contact address changed
// by the nightly sync, a redone PDF, or an edit in another tab breaks it.
export async function dispatchDraftHash(input: {
  draft_id: string;
  purchase_order_id: string;
  to_email: string | null;
  subject: string;
  body_text: string;
  pdf_sha256: string;
}): Promise<string> {
  return await sha256Hex(JSON.stringify({
    draft_id: input.draft_id,
    purchase_order_id: input.purchase_order_id,
    to_email: input.to_email,
    subject: input.subject,
    body_text: input.body_text,
    pdf_sha256: input.pdf_sha256,
  }));
}

// ── The address check (ruling O7) ───────────────────────────────────────────

export type DispatchAddressState =
  | "ok"
  | "missing"
  | "not_supplier"
  | "malformed";

const ONE_ADDRESS = /^[^\s@,;<>"()[\]]+@[^\s@,;<>"()[\]]+\.[^\s@,;<>"()[\]]+$/;
const TEST_DOMAINS = new Set(["example.com", "example.org", "example.net"]);

// Where a send may go. Only ever an address from the supplier's contact (or,
// for a reply, the address the supplier wrote from); never typed. Refused when
// it is one of our own domains, a reserved test domain or test@, or not one
// address.
export function dispatchAddressCheck(
  raw: unknown,
): { state: DispatchAddressState; email: string | null } {
  const email = typeof raw === "string" ? raw.trim() : "";
  if (!email) return { state: "missing", email: null };
  if (!ONE_ADDRESS.test(email)) return { state: "malformed", email };
  const [local, domain] = [
    email.slice(0, email.lastIndexOf("@")).toLowerCase(),
    email.slice(email.lastIndexOf("@") + 1).toLowerCase(),
  ];
  if (isOwnDomain(domain) || TEST_DOMAINS.has(domain) || local === "test") {
    return { state: "not_supplier", email };
  }
  return { state: "ok", email };
}

// ── Plain text from HTML ────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export function dispatchHtmlToText(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (match, name: string) => {
      const key = name.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      if (key.startsWith("#x")) {
        const code = parseInt(key.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (key.startsWith("#")) {
        const code = parseInt(key.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    })
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/[ \t ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function dispatchMessageText(row: any): string {
  if (typeof row?.body_text === "string" && row.body_text.trim()) {
    return row.body_text;
  }
  return dispatchHtmlToText(row?.body_html);
}

// ── Perth dates ─────────────────────────────────────────────────────────────

const PERTH_OFFSET_MS = 8 * 60 * 60 * 1000;

function perthParts(iso: unknown) {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + PERTH_OFFSET_MS);
  return {
    day: d.getUTCDate(),
    month: d.getUTCMonth() + 1,
    year: d.getUTCFullYear(),
  };
}

// "14/10"
export function perthDayMonth(iso: unknown): string | null {
  const p = perthParts(iso);
  if (!p) return null;
  return `${String(p.day).padStart(2, "0")}/${
    String(p.month).padStart(2, "0")
  }`;
}

// "14/10/2026"
export function perthDate(iso: unknown): string | null {
  const p = perthParts(iso);
  if (!p) return null;
  return `${String(p.day).padStart(2, "0")}/${
    String(p.month).padStart(2, "0")
  }/${p.year}`;
}

// ── Threads ─────────────────────────────────────────────────────────────────

export function dispatchMessageAt(row: any): string | null {
  return row?.sent_at || row?.received_at || row?.created_at || null;
}

function compareMessages(a: any, b: any): number {
  const ta = Date.parse(dispatchMessageAt(a) || "") || 0;
  const tb = Date.parse(dispatchMessageAt(b) || "") || 0;
  if (ta !== tb) return ta - tb;
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

export function dispatchThreadTag(row: any): "supplier" | "client" | null {
  if (row?.communication_type === "purchase_order") return "supplier";
  if (row?.communication_type === "client") return "client";
  return null;
}

function attachmentNames(row: any): Array<{ file_name: string }> {
  const list = Array.isArray(row?.attachments_json) ? row.attachments_json : [];
  return list
    .map((a: any) => a?.file_name ?? a?.filename ?? a?.name)
    .filter((name: unknown) => typeof name === "string" && name)
    .map((file_name: string) => ({ file_name }));
}

export type DispatchThreadContext = {
  orders: Map<
    string,
    { po_number: string | null; supplier_name: string | null }
  >;
};

// Groups a job's po_communications rows (purchase order and client rows only)
// into threads. Rows sharing a thread_id are one thread; a supplier row also
// joins every other supplier row on the same order, because our sent message
// is filed under the Resend id while a supplier's reply carries the real
// Message-ID header, so their thread_ids rarely meet. A thread's key is its
// oldest message's id, so it stays the same as messages arrive.
export function dispatchGroupThreads(rows: any[], ctx: DispatchThreadContext) {
  const usable = (Array.isArray(rows) ? rows : []).filter((row) =>
    dispatchThreadTag(row) !== null && row?.id
  );
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let walk = id;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const row of usable) parent.set(String(row.id), String(row.id));
  const firstByKey = new Map<string, string>();
  for (const row of usable) {
    const tag = dispatchThreadTag(row)!;
    const keys: string[] = [];
    if (row.thread_id) keys.push(`${tag}:t:${row.thread_id}`);
    if (tag === "supplier" && row.po_id) keys.push(`supplier:p:${row.po_id}`);
    for (const key of keys) {
      const first = firstByKey.get(key);
      if (first) union(first, String(row.id));
      else firstByKey.set(key, String(row.id));
    }
  }
  const groups = new Map<string, any[]>();
  for (const row of usable) {
    const root = find(String(row.id));
    const bucket = groups.get(root);
    if (bucket) bucket.push(row);
    else groups.set(root, [row]);
  }

  const threads = [...groups.values()].map((messages) => {
    messages.sort(compareMessages);
    const tag = dispatchThreadTag(messages[0])!;
    const newest = messages[messages.length - 1];
    const poId = messages.find((m) => m.po_id)?.po_id ?? null;
    const order = poId ? ctx.orders.get(String(poId)) : undefined;
    const inbound = messages.filter((m) => m.direction === "inbound");
    const newestInbound = inbound[inbound.length - 1] || null;
    const replyCheck = newestInbound
      ? dispatchAddressCheck(newestInbound.from_email)
      : null;
    const subjectSource = [...messages].reverse().find((m) =>
      typeof m.subject === "string" && m.subject.trim()
    );
    const counterpartRow = newestInbound ||
      messages.find((m) => m.direction === "outbound");
    const otherAddress = newestInbound
      ? newestInbound.from_email
      : counterpartRow?.to_email;
    const text = dispatchMessageText(newest);
    return {
      key: `th-${messages[0].id}`,
      tag,
      po_id: poId,
      po_number: order?.po_number ?? null,
      subject: subjectSource?.subject ?? null,
      counterpart: tag === "client"
        ? "Client"
        : (order?.supplier_name || otherAddress || null),
      last_at: dispatchMessageAt(newest),
      last_preview: text.slice(0, 140),
      can_reply: tag === "supplier" && replyCheck?.state === "ok",
      can_link: tag === "supplier" && messages.every((m) => !m.po_id),
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.direction ?? null,
        from_email: m.from_email ?? null,
        to_email: m.to_email ?? null,
        subject: m.subject ?? null,
        text: dispatchMessageText(m),
        at: dispatchMessageAt(m),
        attachments: attachmentNames(m),
        delivery_status: m.delivery_status ?? null,
      })),
      // Used by the reply and link writes; not drawn.
      _rows: messages,
    };
  });
  threads.sort((a, b) =>
    -compareMessages(
      { sent_at: a.last_at, id: a.key },
      { sent_at: b.last_at, id: b.key },
    )
  );
  return threads;
}

export function publicThread(thread: any) {
  const { _rows: _ignored, ...rest } = thread;
  return rest;
}

// ── The order chip (section 4.2) ────────────────────────────────────────────

export type DispatchChip = {
  state:
    | "not_ordered"
    | "send_unknown"
    | "draft_ready"
    | "not_sent"
    | "changed_not_sent"
    | "replied"
    | "sent";
  text: string;
  tone: "muted" | "info" | "warn" | "ok";
  in_xero: boolean;
};

export function isStaleSending(draft: any, nowMs: number): boolean {
  if (draft?.status !== "sending") return false;
  const t = Date.parse(draft?.updated_at || "");
  return Number.isFinite(t) && nowMs - t > DISPATCH_SENDING_STALE_MS;
}

// The status a draft shows: a claim left with no answer reads as not confirmed.
export function dispatchDraftShownStatus(draft: any, nowMs: number): string {
  return isStaleSending(draft, nowMs) ? "send_unknown" : String(draft?.status);
}

export function dispatchOrderChip(input: {
  order: any | null;
  openDraft: any | null;
  newestMessage: any | null;
  nowMs: number;
}): DispatchChip {
  const { order } = input;
  if (!order) {
    return {
      state: "not_ordered",
      text: "Not ordered",
      tone: "muted",
      in_xero: false,
    };
  }
  const inXero = !!order.xero_po_id || order.in_xero === true;
  const po = String(order.po_number ?? "");
  const draftStatus = input.openDraft
    ? dispatchDraftShownStatus(input.openDraft, input.nowMs)
    : null;
  let chip: Omit<DispatchChip, "in_xero">;
  if (draftStatus === "send_unknown") {
    chip = {
      state: "send_unknown",
      text: `${po} · Send not confirmed`,
      tone: "warn",
    };
  } else if (draftStatus === "draft" || draftStatus === "sending") {
    chip = {
      state: "draft_ready",
      text: `${po} · Draft email ready`,
      tone: "info",
    };
  } else if (!order.last_sent_at) {
    chip = { state: "not_sent", text: `${po} · Not sent`, tone: "warn" };
  } else if (
    Number(order.pdf_version ?? 0) > Number(order.last_sent_pdf_version ?? 0)
  ) {
    chip = {
      state: "changed_not_sent",
      text: `${po} · Changed, not sent`,
      tone: "warn",
    };
  } else if (input.newestMessage?.direction === "inbound") {
    const day = perthDayMonth(dispatchMessageAt(input.newestMessage));
    chip = {
      state: "replied",
      text: `${po} · Replied${day ? ` ${day}` : ""}`,
      tone: "ok",
    };
  } else {
    const day = perthDayMonth(
      dispatchMessageAt(input.newestMessage) || order.last_sent_at,
    );
    chip = {
      state: "sent",
      text: `${po} · Sent${day ? ` ${day}` : ""}`,
      tone: "info",
    };
  }
  return {
    ...chip,
    text: inXero ? `${chip.text} · In Xero` : chip.text,
    in_xero: inXero,
  };
}

// The newest open Dispatch order for a supplier on the job, or null.
export function dispatchOpenOrderFor(
  orders: any[],
  supplierId: string,
): any | null {
  const open = (Array.isArray(orders) ? orders : []).filter((order) =>
    order?.source === "dispatch" &&
    String(order?.supplier_id ?? "") === supplierId &&
    order?.status !== "cancelled" && order?.status !== "deleted"
  );
  open.sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) ||
    String(b.id ?? "").localeCompare(String(a.id ?? ""))
  );
  return open[0] ?? null;
}

// The supplier card's `order`: the open order and its chip.
export function dispatchSupplierOrder(input: {
  orders: any[];
  supplierId: string;
  openDrafts: any[];
  messages: any[];
  nowMs: number;
}) {
  const order = dispatchOpenOrderFor(input.orders, input.supplierId);
  if (!order) return null;
  const openDraft =
    (input.openDrafts || []).find((d) =>
      String(d?.purchase_order_id) === String(order.id)
    ) || null;
  const own = (input.messages || []).filter((m) =>
    String(m?.po_id) === String(order.id)
  ).sort(compareMessages);
  const newestMessage = own[own.length - 1] || null;
  return {
    id: order.id,
    po_number: order.po_number ?? null,
    status: order.status ?? null,
    // Sent back as expected_order_updated_at by Update, Take off and Cancel.
    updated_at: order.updated_at ?? null,
    chip: dispatchOrderChip({
      order,
      openDraft,
      newestMessage,
      nowMs: input.nowMs,
    }),
    in_xero: !!order.xero_po_id,
    pdf_version: order.pdf_version ?? null,
    last_sent_pdf_version: order.last_sent_pdf_version ?? null,
    last_sent_at: order.last_sent_at ?? null,
  };
}

// ── Draft projection ────────────────────────────────────────────────────────

export function dispatchPdfFileName(poNumber: unknown): string {
  return `${String(poNumber ?? "order")}.pdf`;
}

export async function projectDispatchDraft(input: {
  draft: any;
  order: any;
  supplier: any | null;
  nowMs: number;
  // sha256 of the message the server would write now for this draft's lines.
  currentGeneratedSha: string | null;
}) {
  const { draft, order, supplier } = input;
  // A send already attempted (sending or not confirmed) shows, and is retried
  // to, the address that attempt carried, never a newer one from the contact.
  const attempted = draft.status !== "draft" &&
      typeof draft.attempt_to_email === "string" && draft.attempt_to_email
    ? draft.attempt_to_email
    : null;
  const address = dispatchAddressCheck(attempted ?? supplier?.email);
  const bodySha = await sha256Hex(String(draft.body_text ?? ""));
  const edited = bodySha !== draft.body_generated_sha;
  return {
    id: draft.id,
    purchase_order_id: draft.purchase_order_id,
    po_number: order?.po_number ?? null,
    supplier_id: draft.supplier_id,
    supplier_name: supplier?.name ?? order?.supplier_name ?? null,
    kind: draft.kind,
    status: dispatchDraftShownStatus(draft, input.nowMs),
    to: { email: address.email, state: address.state },
    subject: draft.subject,
    body_text: draft.body_text,
    body_edited: edited,
    // The person edited the message, and the message the server would write
    // for the draft's lines now differs from the one it wrote before the edit:
    // the order changed after the edit, so the message may no longer list it.
    order_changed_since_edit: edited &&
      typeof input.currentGeneratedSha === "string" &&
      input.currentGeneratedSha !== draft.body_generated_sha,
    pdf: {
      version: draft.pdf_version,
      file_name: dispatchPdfFileName(order?.po_number),
      line_count: draft.line_count,
    },
    draft_hash: await dispatchDraftHash({
      draft_id: draft.id,
      purchase_order_id: draft.purchase_order_id,
      to_email: address.state === "ok" ? address.email : null,
      subject: draft.subject,
      body_text: draft.body_text,
      pdf_sha256: draft.pdf_sha256,
    }),
    last_error: draft.last_error ?? null,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
  };
}

// ── Update decision ─────────────────────────────────────────────────────────

// What an Update does to the order's open draft. An unedited message is
// rewritten for the new lines; an edited one is kept, and the read reports
// order_changed_since_edit. No open draft: a new one, `update` when the order
// was sent before, else `order`.
export async function dispatchUpdateDraftPlan(input: {
  openDraft: any | null;
  order: any;
  jobNumber: string | null;
  suburb: string | null;
  lines: DispatchOrderLine[];
  lastSentLines: DispatchOrderLine[] | null;
}) {
  const sentBefore = !!input.order?.last_sent_at;
  const writeBody = async (kind: DispatchDraftKind) => {
    const body = dispatchOrderBody({
      kind,
      poNumber: input.order.po_number,
      jobNumber: input.jobNumber,
      suburb: input.suburb,
      lines: input.lines,
      previousLines: input.lastSentLines,
    });
    return { body_text: body, body_generated_sha: await sha256Hex(body) };
  };
  if (input.openDraft) {
    const kind: DispatchDraftKind = input.openDraft.kind === "update"
      ? "update"
      : "order";
    const edited = await sha256Hex(String(input.openDraft.body_text ?? "")) !==
      input.openDraft.body_generated_sha;
    return {
      kind: "refresh" as const,
      draft_id: input.openDraft.id,
      expected_updated_at: input.openDraft.updated_at,
      fields: edited ? {} : await writeBody(kind),
      body_kept: edited,
    };
  }
  const kind: DispatchDraftKind = sentBefore ? "update" : "order";
  return {
    kind: "insert" as const,
    fields: {
      kind,
      subject: dispatchOrderSubject(
        kind,
        input.order.po_number,
        input.jobNumber,
      ),
      ...(await writeBody(kind)),
    },
  };
}

// ── Delivery address ────────────────────────────────────────────────────────

// The job's site address with its suburb, without repeating the suburb when
// the address already holds it.
export function dispatchDeliverTo(
  address: unknown,
  suburb: unknown,
): string | null {
  const a = typeof address === "string" ? address.trim() : "";
  const s = typeof suburb === "string" ? suburb.trim() : "";
  if (!a) return s || null;
  if (!s || a.toLowerCase().includes(s.toLowerCase())) return a;
  return `${a}, ${s}`;
}

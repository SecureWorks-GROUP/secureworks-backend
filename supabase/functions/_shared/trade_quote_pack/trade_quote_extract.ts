/**
 * Trade-facing price-free quote extract (TRD-6).
 *
 * Assembled from frozen `trade_pack_json` plus the customer / terms
 * snapshots stamped at send (or overlaid from the live job for older packs).
 * Rendered as printable HTML. Office keeps the priced quote PDF; allocated
 * trades get this extract only.
 *
 * Never invents prices. Never copies `unit_price` / `line_total` /
 * installer rates / quote totals. The HTML template contains no `$`.
 */

import {
  type QuoteDocRow,
  type TradePackItem,
  type TradeQuoteCustomerSnapshot,
  type TradeQuotePack,
  type TradeQuoteTermsSnapshot,
  allocatedPaymentTerms,
  allocatedTradePackIdentity,
  frozenTradePackForExtract,
  isSealedPaymentTermsPhrase,
  isTradePaymentTermsFieldPath,
  overlayTradePackSnapshots,
  sanitizeTradePackKind,
  sanitizeTradePackUnit,
  stripTradePackMoney,
  tradeTextHasMoneyToken,
} from "./pack_trade_quote.ts";

export const TRADE_QUOTE_EXTRACT_DOC_TYPE = "trade_quote_extract" as const;
export const TRADE_QUOTE_EXTRACT_SCHEMA = "secureworks.trade-quote-extract/v1";
export const TRADE_QUOTE_EXTRACT_ACTION = "trade_quote_extract";

export type TradeQuoteExtractScopeItem = {
  kind: TradePackItem["kind"];
  description: string;
  quantity: number | null;
  unit: string | null;
};

export type TradeQuoteExtract = {
  schema: typeof TRADE_QUOTE_EXTRACT_SCHEMA;
  type: typeof TRADE_QUOTE_EXTRACT_DOC_TYPE;
  quote_number: string | null;
  job_number: string | null;
  status: string;
  sent_at: string | null;
  customer: TradeQuoteCustomerSnapshot;
  terms: TradeQuoteTermsSnapshot;
  scope: TradeQuoteExtractScopeItem[];
  notes: string[];
  summary: string | null;
};

export type TradeQuoteExtractPointer = {
  type: typeof TRADE_QUOTE_EXTRACT_DOC_TYPE;
  label: "Quote extract";
  action: typeof TRADE_QUOTE_EXTRACT_ACTION;
  job_document_id: string | null;
  quote_number: string;
  status: string;
  sent_at: string | null;
  filename: string;
};

export type TradeQuoteExtractJobOverlay = {
  job_number?: unknown;
  client_name?: unknown;
  client_phone?: unknown;
  client_email?: unknown;
  site_address?: unknown;
  site_suburb?: unknown;
};

function extractFieldHasMoney(text: string): boolean {
  return tradeTextHasMoneyToken(text);
}

function failClosedText(value: unknown, scrub: (raw: string) => string | null): string | null {
  if (typeof value !== "string") return null;
  const cleaned = scrub(value);
  if (!cleaned) return null;
  if (extractFieldHasMoney(cleaned)) return null;
  return cleaned;
}

function extractProse(value: unknown): string | null {
  return failClosedText(value, (raw) => stripTradePackMoney(raw).trim() || null);
}

/** payment_terms only. Exact sealed leftover after strip; any other leftover drops. */
function extractPaymentTerms(value: unknown): string | null {
  const kept = allocatedPaymentTerms(value);
  if (!kept) return null;
  return kept;
}

/** Phone / email / quote numbers keep digits. Drop the field if a money token is present. */
function extractIdentity(value: unknown): string | null {
  return failClosedText(value, (raw) => raw.trim() || null);
}

function extractScopeItem(item: TradePackItem): TradeQuoteExtractScopeItem | null {
  const kind = item.kind === "note" ? undefined : sanitizeTradePackKind(item.kind);
  if (!kind) return null;
  const unit = sanitizeTradePackUnit(item.unit ?? undefined) ?? null;
  if (unit && extractFieldHasMoney(unit)) return null;
  return {
    kind: kind as TradePackItem["kind"],
    description: extractProse(item.description) || kind,
    quantity: Number.isFinite(item.quantity) ? item.quantity : null,
    unit,
  };
}

export function assembleFrozenQuoteExtractPacks(args: {
  documents: QuoteDocRow[];
  customer?: Partial<TradeQuoteCustomerSnapshot> | null;
  terms?: Partial<TradeQuoteTermsSnapshot> | null;
}): TradeQuotePack[] {
  return (args.documents || [])
    .map((doc) =>
      frozenTradePackForExtract(doc, {
        customer: args.customer,
        terms: args.terms,
      })
    )
    .filter((pack): pack is TradeQuotePack => !!pack)
    .sort((a, b) =>
      String(b.sent_at || "").localeCompare(String(a.sent_at || ""))
    );
}

export function tradeQuoteExtractIsEligible(pack: TradeQuotePack | null | undefined): boolean {
  if (!pack || pack.source === "live_fallback") return false;
  if (!allocatedTradePackIdentity(pack.quote_number)) return false;
  if (pack.status === "superseded") return false;
  if (pack.accepted === true || pack.status === "accepted") return true;
  return pack.status === "sent" && !!pack.sent_at;
}

export function assembleTradeQuoteExtract(args: {
  pack: TradeQuotePack;
  job?: TradeQuoteExtractJobOverlay | null;
}): TradeQuoteExtract {
  const pack = overlayTradePackSnapshots(args.pack, {
    customer: {
      name: typeof args.job?.client_name === "string" ? args.job.client_name : null,
      phone: typeof args.job?.client_phone === "string" ? args.job.client_phone : null,
      email: typeof args.job?.client_email === "string" ? args.job.client_email : null,
      site_address: typeof args.job?.site_address === "string" ? args.job.site_address : null,
      site_suburb: typeof args.job?.site_suburb === "string" ? args.job.site_suburb : null,
    },
  });
  const accepted = pack.accepted === true || pack.status === "accepted";
  const sentAt = pack.sent_at ?? null;
  const status = accepted ? "accepted" : sentAt ? "sent" : pack.status;
  const jobNumber = extractIdentity(args.job?.job_number);
  return {
    schema: TRADE_QUOTE_EXTRACT_SCHEMA,
    type: TRADE_QUOTE_EXTRACT_DOC_TYPE,
    quote_number: allocatedTradePackIdentity(pack.quote_number),
    job_number: jobNumber,
    status,
    sent_at: sentAt,
    customer: {
      name: extractProse(pack.customer?.name),
      phone: extractIdentity(pack.customer?.phone),
      email: extractIdentity(pack.customer?.email),
      site_address: extractProse(pack.customer?.site_address),
      site_suburb: extractProse(pack.customer?.site_suburb),
    },
    terms: {
      payment_terms: extractPaymentTerms(pack.terms?.payment_terms),
      valid_days: typeof pack.terms?.valid_days === "number" && Number.isFinite(pack.terms.valid_days)
        ? pack.terms.valid_days
        : null,
      valid_until: extractIdentity(pack.terms?.valid_until),
    },
    scope: pack.items.map(extractScopeItem).filter((row): row is TradeQuoteExtractScopeItem => !!row),
    notes: extractProse(pack.notes) ? [extractProse(pack.notes) as string] : [],
    summary: extractProse(pack.summary),
  };
}

function slugTradeExtractIdentity(value: unknown): string {
  const clean = allocatedTradePackIdentity(value);
  if (!clean) return "";
  return clean.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function tradeQuoteExtractFilename(extract: {
  job_number?: string | null;
  quote_number?: string | null;
}): string {
  const job = slugTradeExtractIdentity(extract.job_number);
  const quote = slugTradeExtractIdentity(extract.quote_number);
  const stem = [job, quote, "trade-extract"].filter(Boolean).join("-");
  return `${stem || "trade-extract"}.html`;
}

export function projectTradeQuoteExtracts(
  packs: Array<TradeQuotePack & { job_document_id?: string | null }>,
  jobNumber?: string | null,
): TradeQuoteExtractPointer[] {
  return packs
    .filter((pack) => tradeQuoteExtractIsEligible(pack))
    .flatMap((pack) => {
      const quoteNumber = allocatedTradePackIdentity(pack.quote_number);
      if (!quoteNumber) return [];
      return [{
        type: TRADE_QUOTE_EXTRACT_DOC_TYPE,
        label: "Quote extract" as const,
        action: TRADE_QUOTE_EXTRACT_ACTION,
        job_document_id: pack.job_document_id ?? null,
        quote_number: quoteNumber,
        status: pack.status,
        sent_at: pack.sent_at ?? null,
        filename: tradeQuoteExtractFilename({
          job_number: jobNumber,
          quote_number: quoteNumber,
        }),
      }];
    });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatQuantity(quantity: number | null, unit: string | null): string {
  if (quantity == null || !Number.isFinite(quantity)) return unit ? escapeHtml(unit) : "-";
  const qty = Number.isInteger(quantity) ? String(quantity) : String(Math.round(quantity * 100) / 100);
  return unit ? `${qty} ${escapeHtml(unit)}` : qty;
}

function customerRows(customer: TradeQuoteCustomerSnapshot): Array<[string, string]> {
  return [
    ["Name", customer.name],
    ["Phone", customer.phone],
    ["Email", customer.email],
    ["Site address", customer.site_address],
    ["Suburb", customer.site_suburb],
  ].filter(([, value]) => !!value) as Array<[string, string]>;
}

function termsRows(terms: TradeQuoteTermsSnapshot): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (terms.payment_terms) rows.push(["Payment terms", terms.payment_terms]);
  if (terms.valid_days != null) rows.push(["Valid for", `${terms.valid_days} days`]);
  if (terms.valid_until) rows.push(["Valid until", terms.valid_until]);
  return rows;
}

function dl(rows: Array<[string, string]>): string {
  if (rows.length === 0) return `<p class="empty">Not recorded on this quote.</p>`;
  return `<dl>${
    rows
      .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
      .join("")
  }</dl>`;
}

/**
 * Printable HTML extract. One artifact type the trade app can open or print
 * to PDF from the browser. Template copy is price-free by construction.
 */
export function renderTradeQuoteExtractHtml(extract: TradeQuoteExtract): string {
  const scopeRows = extract.scope.map((item) => {
    const qty = formatQuantity(item.quantity, item.unit);
    return `<tr>
      <td>${escapeHtml(item.description || item.kind)}</td>
      <td class="qty">${qty}</td>
    </tr>`;
  }).join("");
  const notes = extract.notes
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join("");
  const heading = [
    extract.job_number,
    extract.quote_number ? `Quote ${extract.quote_number}` : null,
  ].filter(Boolean).join(" · ") || "Quote extract";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(heading)} - trade extract</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; color: #1a2428; background: #f4f1ea; }
  main { max-width: 760px; margin: 0 auto; padding: 28px 22px 48px; background: #fff; }
  header { border-bottom: 4px solid #293C46; padding-bottom: 16px; margin-bottom: 22px; }
  .brand { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #293C46; font-weight: 700; }
  h1 { margin: 8px 0 4px; font-size: 26px; }
  .meta { color: #4a5a62; font-size: 14px; }
  h2 { margin: 26px 0 10px; font-size: 16px; color: #293C46; text-transform: uppercase; letter-spacing: 0.04em; }
  dl { display: grid; gap: 8px; margin: 0; }
  dl div { display: grid; grid-template-columns: 140px 1fr; gap: 8px; }
  dt { font-weight: 600; color: #4a5a62; }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #d9d3c7; vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #4a5a62; }
  td.qty { white-space: nowrap; width: 28%; }
  .empty, .summary { color: #4a5a62; }
  footer { margin-top: 32px; padding-top: 14px; border-top: 1px solid #d9d3c7; font-size: 12px; color: #4a5a62; }
  @media print {
    body { background: #fff; }
    main { padding: 0; max-width: none; }
  }
</style>
</head>
<body>
<main>
  <header>
    <div class="brand">SecureWorks WA - trade extract</div>
    <h1>${escapeHtml(heading)}</h1>
    <p class="meta">Status: ${escapeHtml(extract.status)}${extract.sent_at ? ` · Sent ${escapeHtml(extract.sent_at.slice(0, 10))}` : ""}</p>
  </header>
  <section>
    <h2>Customer details</h2>
    ${dl(customerRows(extract.customer))}
  </section>
  <section>
    <h2>Terms and validity</h2>
    ${dl(termsRows(extract.terms))}
  </section>
  <section>
    <h2>Scope of works</h2>
    ${
      scopeRows
        ? `<table><thead><tr><th>Item</th><th>Quantity</th></tr></thead><tbody>${scopeRows}</tbody></table>`
        : `<p class="empty">No scope items on this quote.</p>`
    }
    ${extract.summary ? `<p class="summary">${escapeHtml(extract.summary)}</p>` : ""}
  </section>
  ${
    notes
      ? `<section><h2>Notes</h2><ul>${notes}</ul></section>`
      : ""
  }
  <footer>
    This extract is for site work only. It lists customer details, terms, and quantities.
    It does not include prices, rates, or totals. The office holds the priced quote.
  </footer>
</main>
</body>
</html>`;
}

export function tradeQuoteExtractMoneyLeakKeys(value: unknown, path = ""): string[] {
  const leaks: string[] = [];
  const walk = (node: unknown, at: string) => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${at}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const next = at ? `${at}.${key}` : key;
      if (TRADE_QUOTE_EXTRACT_FORBIDDEN_KEYS.has(key)) leaks.push(next);
      walk(child, next);
    }
  };
  walk(value, path);
  return leaks;
}

export const TRADE_QUOTE_EXTRACT_FORBIDDEN_KEYS = new Set([
  "unit_price",
  "line_total",
  "installer_rate",
  "installer_line_total",
  "quoted_amount",
  "quoted_value",
  "deposit_amount",
  "deposit_percent",
  "subtotal",
  "gst",
  "total",
  "total_inc",
  "total_ex",
  "price",
  "pricing_json",
  "amount",
]);

const EXTRACT_HTML_SEALED_PAYMENT_TERMS_ROW =
  /(<div><dt>Payment terms<\/dt><dd>)50%\s*deposit\s*\+\s*50%\s*on\s+completion(<\/dd><\/div>)/gi;
const EXTRACT_HTML_FOOTER_DISCLAIMER = /It does not include prices, rates, or totals\./g;
const EXTRACT_HTML_STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style>/gi;

const EXTRACT_HTML_PAYMENT_TERMS_ROW =
  /<div><dt>Payment terms<\/dt><dd>([\s\S]*?)<\/dd><\/div>/gi;

/** Payment terms `<dd>` may carry only the exact sealed phrase. */
export function tradeQuoteExtractHtmlPaymentTermsAllowlistLeaks(html: string): string[] {
  const leaks: string[] = [];
  const re = new RegExp(EXTRACT_HTML_PAYMENT_TERMS_ROW.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(html || ""))) !== null) {
    const text = String(match[1] || "").replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    if (!isSealedPaymentTermsPhrase(text)) leaks.push("html.payment_terms");
  }
  return [...new Set(leaks)];
}

export function tradeQuoteExtractHtmlMoneyNeedles(html: string): string[] {
  const paymentTermsLeaks = tradeQuoteExtractHtmlPaymentTermsAllowlistLeaks(html);
  const stripped = String(html || "")
    .replace(EXTRACT_HTML_STYLE_BLOCK, "")
    .replace(EXTRACT_HTML_SEALED_PAYMENT_TERMS_ROW, "$1$2")
    .replace(EXTRACT_HTML_FOOTER_DISCLAIMER, "");
  const hits: string[] = [...paymentTermsLeaks];
  if (stripped.includes("$")) hits.push("$");
  if (/%|percent(?:age)?/i.test(stripped)) hits.push("percent");
  if (/\bGST\b/i.test(stripped)) hits.push("GST");
  if (/\b(?:AUD|USD)\b/i.test(stripped)) hits.push("currency");
  if (/\b(?:inc GST|ex GST|subtotal|line total|unit price)\b/i.test(stripped)) hits.push("money-phrase");
  if (/\b(?:rate|price|amount|cost|fee|deposit)\b/i.test(stripped)) hits.push("money-word");
  if (/\b(?:upfront|up-front|balance|owing|payable|outstanding|due)\b/i.test(stripped)) {
    hits.push("payment-language");
  }
  if (tradeTextHasMoneyToken(stripped)) hits.push("money-token");
  return [...new Set(hits)];
}

function extractStringLeafMoneyLeaks(value: unknown, path = ""): string[] {
  const leaks: string[] = [];
  const walk = (node: unknown, at: string) => {
    if (typeof node === "string") {
      if (isTradePaymentTermsFieldPath(at)) {
        if (!isSealedPaymentTermsPhrase(node)) leaks.push(at || "root");
        return;
      }
      if (extractFieldHasMoney(node)) leaks.push(at || "root");
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${at}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, at ? `${at}.${key}` : key);
    }
  };
  walk(value, path);
  return leaks;
}

export function tradeQuoteExtractArtifactLeaks(
  extract: TradeQuoteExtract,
  html: string,
): string[] {
  const leaks = [
    ...tradeQuoteExtractMoneyLeakKeys(extract),
    ...extractStringLeafMoneyLeaks(extract, "extract"),
    ...tradeQuoteExtractHtmlMoneyNeedles(html).map((hit) => `html.${hit}`),
  ];
  if (JSON.stringify(extract).includes("$")) leaks.push("extract.$");
  return [...new Set(leaks)];
}

export function assertTradeQuoteExtractArtifact(
  extract: TradeQuoteExtract,
  html: string,
): void {
  const leaks = tradeQuoteExtractArtifactLeaks(extract, html);
  if (leaks.length) {
    throw new Error(`trade quote extract money leak: ${leaks.join(",")}`);
  }
}

export function buildTradeQuoteExtractArtifact(args: {
  pack: TradeQuotePack;
  job?: TradeQuoteExtractJobOverlay | null;
}): { extract: TradeQuoteExtract; html: string; filename: string } {
  const extract = assembleTradeQuoteExtract(args);
  const html = renderTradeQuoteExtractHtml(extract);
  assertTradeQuoteExtractArtifact(extract, html);
  return { extract, html, filename: tradeQuoteExtractFilename(extract) };
}

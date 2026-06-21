// MakeSafe Review & Send -- draft-only Claude pack generator helpers.
//
// These helpers are PURE: no Supabase, no Xero, no email, no storage. The Edge
// action in index.ts supplies the live clients and calls these helpers to build
// the prompt, parse Claude's JSON, and validate the draft-only contract.
//
// Load-bearing boundary:
//   Draft Pack / Revise Pack may create or refresh draft artefacts only
//   (rendered report PDF, Xero DRAFT invoice, draft invoice PDF attachment).
//   It must never authorise an invoice, send email, close a job, or write a
//   MAKESAFE_PACK_SENT marker. Those actions remain in makesafe_send_pack.

export const MAKESAFE_DRAFT_PACK_MODEL = "claude-sonnet-4-6";

export interface DraftPackLineItem {
  description: string;
  quantity: number;
  unit_price: number;
  account_code?: string;
}

export interface DraftPackOutput {
  report: {
    ref?: string;
    address?: string;
    contact?: string;
    date?: string;
    arrival?: string;
    crew?: string;
    billing_note?: string;
    scope?: string;
    findings?: string;
    works?: string;
    materials?: string;
    photo_limit?: number;
  };
  invoice: {
    reference?: string;
    contact_name?: string;
    due_date?: string;
    line_items: DraftPackLineItem[];
  };
  change_summary: string;
}

export interface DraftPackContext {
  job?: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
  service_report?: Record<string, unknown> | null;
  feedback_notes?: Array<Record<string, unknown>>;
  selected_photo_urls?: string[];
  source_docs?: Array<Record<string, unknown>>;
}

export interface DraftPackDueDetail {
  job_id?: string | null;
  substatus?: string | null;
  report_received_at?: string | null;
  report_sent_at?: string | null;
  report_type?: string | null;
}

export interface DraftPackDuePack {
  job_id?: string | null;
  pack_kind?: string | null;
  status?: string | null;
  report_doc_id?: string | null;
  invoice_doc_id?: string | null;
  xero_invoice_id?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

const FORBIDDEN_IRREVERSIBLE_WORDS = [
  "authorise",
  "authorize",
  "was sent",
  "send email",
  "email sent",
  "job is closed",
  "closed",
  "close job",
  "mark complete",
  "MAKESAFE_PACK_SENT",
];

export function buildDraftPackSystemPrompt(): string {
  return [
    "You draft MakeSafe close-out artefacts for SecureWorks Group in Perth.",
    "Return JSON only. Do not use markdown.",
    "You may draft report wording and DRAFT invoice line items.",
    "You must not claim that anything has been sent, authorised, paid, closed, or approved.",
    "Use concise trade-business language. No em dashes.",
  ].join("\n");
}

export function buildDraftPackUserPrompt(ctx: DraftPackContext): string {
  return JSON.stringify({
    task: "Draft or revise a MakeSafe report pack for human approval.",
    output_schema: {
      report: {
        ref: "builder reference",
        address: "site address",
        contact: "site contact/client",
        date: "attendance/submission date",
        arrival: "arrival or attendance time if known",
        crew: "crew/trade if known",
        billing_note:
          "short billing basis matching the invoice labour quantity/trades, e.g. '1 trade x 3 hours'. Do not include pricing-to-be-confirmed wording when priced invoice lines are supplied",
        scope: "work order scope",
        findings: "site findings and cause",
        works: "works completed",
        materials: "materials/equipment used",
        photo_limit: 8,
      },
      invoice: {
        reference: "builder reference",
        contact_name: "builder/customer name for Xero draft",
        due_date: "optional YYYY-MM-DD",
        line_items: [
          {
            description: "line description",
            quantity: 1,
            unit_price: 85,
            account_code: "210",
          },
        ],
      },
      change_summary:
        "short note explaining what changed and what still needs human review",
    },
    rules: [
      "Invoice lines must be DRAFT-only and exclude GST in unit_price.",
      "Every invoice line must have quantity > 0 and unit_price > 0. Never output a $0 placeholder line.",
      "Use account_code 210 unless the context clearly specifies another make-safe account.",
      "For Major Loss Builders / MLB routine make-safe work, use a minimum/default of 1 trade x 3 hours at $85 ex GST per hour. Do not reduce below 3 labour hours just because a checklist records fewer hours unless human Ops feedback explicitly says to discount/reduce it.",
      "The report.billing_note must be terse and must match the invoice labour basis. Use wording like '1 trade x 3 hours' or '2 trades x 2 hours (4 labour hours total)'.",
      "Do not put travel/material/pricing uncertainty in report.billing_note. Put materials in report.materials and unresolved review items in change_summary.",
      "If costing is uncertain, use the best available SecureWorks/ops pricing from the context and say it needs pricing review in change_summary.",
      "If the latest Ops feedback says the invoice should read specific labour/trade/hour/rate wording and says 'that's it', 'thats it', 'that is it', 'labour only', or 'no materials', output ONLY those requested invoice line(s). Do not add placeholder materials or best-estimate lines.",
      "Treat feedback_notes as chronological cumulative human instructions. Later human notes refine earlier human notes; do not forget an earlier requested labour basis when the latest note only says retry/remove a placeholder.",
      "For MLB / Major Loss Builders temporary-fence hire, use the SecureWorks hire card when the evidence gives quantities: labour $85 ex/hr weekday with 3-hour minimum (4 hours for solo temp-fence), retrieval allowance 2 hours x $90, panel hire $5 per panel per week for 12 weeks minimum, star pickets $13.50 each, cable ties/small consumables $25 flat. Do not price MLB panels as a sale.",
      "Only use selected_photo_urls as the approved photo set for this draft refresh.",
      "Never include MAKESAFE_PACK_SENT or any wording that says the pack was sent/authorised/closed.",
    ],
    context: ctx,
  });
}

export function stripJsonFences(text: string): string {
  let out = String(text ?? "").trim();
  if (out.startsWith("```")) {
    out = out.replace(/^```(?:json|JSON)?\n?/, "").replace(/\n?```$/, "")
      .trim();
  }
  return out;
}

export function extractJsonObject(text: string): string {
  const clean = stripJsonFences(text);
  if (clean.startsWith("{") && clean.endsWith("}")) return clean;
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Claude draft response did not contain a JSON object");
  }
  return match[0];
}

export function parseDraftPackResponse(text: string): DraftPackOutput {
  const parsed = JSON.parse(extractJsonObject(text));
  return normaliseDraftPackOutput(parsed);
}

export function normaliseDraftPackOutput(raw: unknown): DraftPackOutput {
  const root = asRecord(raw);
  const report = asRecord(root.report);
  const invoice = asRecord(root.invoice);
  const lineItems = Array.isArray(invoice.line_items)
    ? invoice.line_items
    : (Array.isArray(invoice.lines) ? invoice.lines : []);
  const lines = lineItems.map((rawLine: unknown) => {
    const li = asRecord(rawLine);
    return {
      description: cleanDraftText(li.description ?? li.Description ?? ""),
      quantity: num(li.quantity ?? li.Quantity ?? 1, 1),
      unit_price: num(li.unit_price ?? li.unitPrice ?? li.UnitAmount ?? 0, 0),
      account_code: String(li.account_code ?? li.accountCode ?? "210").trim() ||
        "210",
    };
  }).filter((li: DraftPackLineItem) => li.description);

  if (lines.length === 0) {
    throw new Error(
      "Claude draft response must include at least one invoice line item",
    );
  }
  const badPricing = lines
    .map((li: DraftPackLineItem, index: number) => {
      if (!Number.isFinite(li.quantity) || li.quantity <= 0) {
        return `invoice line ${index + 1} has invalid quantity`;
      }
      if (!Number.isFinite(li.unit_price) || li.unit_price <= 0) {
        return `invoice line ${index + 1} has $0/invalid unit_price`;
      }
      return "";
    })
    .filter(Boolean);
  if (badPricing.length > 0) {
    throw new Error(
      `Claude draft response has invalid invoice pricing: ${
        badPricing.join("; ")
      }`,
    );
  }

  const out: DraftPackOutput = {
    report: {
      ref: cleanDraftText(report.ref),
      address: cleanDraftText(report.address),
      contact: cleanDraftText(report.contact),
      date: cleanDraftText(report.date),
      arrival: cleanDraftText(report.arrival),
      crew: cleanDraftText(report.crew),
      billing_note: cleanDraftText(report.billing_note),
      scope: cleanDraftText(report.scope),
      findings: cleanDraftText(report.findings),
      works: cleanDraftText(report.works),
      materials: cleanDraftText(report.materials),
      photo_limit: Math.max(
        1,
        Math.min(8, Math.round(num(report.photo_limit, 8))),
      ),
    },
    invoice: {
      reference: clean(invoice.reference),
      contact_name: clean(invoice.contact_name ?? invoice.contactName),
      due_date: clean(invoice.due_date ?? invoice.dueDate),
      line_items: lines,
    },
    change_summary: cleanDraftReviewSummary(
      root.change_summary ?? root.summary,
    ) ||
      "Draft pack refreshed for human review.",
  };
  assertDraftOnlyText(JSON.stringify(out));
  return out;
}

export function cleanDraftReviewSummary(v: unknown): string {
  return softenDraftReviewLanguage(clean(v));
}

function scrubStalePricingReviewSummary(v: unknown): string {
  return cleanDraftReviewSummary(v)
    .replace(
      /(?:^|[.;]\s*)[^.;]*(?:placeholder|pricing\s+schedule|pricing\s+review|unit[_\s-]?prices?|must\s+be\s+reviewed\s+and\s+updated|price(?:s|d)?\s+to\s+be\s+confirmed)[^.;]*[.;]?/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .replace(/\s+([.;,])/g, "$1")
    .trim();
}

function cleanDraftText(v: unknown): string {
  return softenDraftReviewLanguage(clean(v));
}

function softenDraftReviewLanguage(text: string): string {
  return String(text || "")
    .replace(/\bauthori[sz](?:e(?:d|s|r|rs)?|ing)\b/gi, (match) => {
      const lower = match.toLowerCase();
      if (lower.endsWith("ing")) return "finalising";
      if (lower.endsWith("ed")) return "finalised";
      return "finalise";
    })
    .replace(/\bapproved?\b/gi, "reviewed")
    .replace(/\bwas sent\b/gi, "is ready for review")
    .replace(/\bemail sent\b/gi, "email draft ready")
    .replace(/\bsend email\b/gi, "prepare email")
    .replace(/\bclosed\b/gi, "complete")
    .replace(/\bclose job\b/gi, "complete job after review")
    .replace(/\bmark complete\b/gi, "prepare for completion review");
}

function humanFeedbackBodies(ctx: DraftPackContext): string[] {
  return (ctx.feedback_notes || [])
    .filter((note) => String(note?.role || "").toLowerCase() !== "agent")
    .map((note) => String(note?.note_body ?? note?.body ?? note?.content ?? ""))
    .filter(Boolean);
}

function formatQty(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Math.round(value * 100) / 100);
}

function lastRegexMatch(text: string, regex: RegExp): RegExpMatchArray | null {
  const flags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
  const re = new RegExp(regex.source, flags);
  let last: RegExpMatchArray | null = null;
  let m: RegExpMatchArray | null;
  while ((m = re.exec(text)) !== null) last = m;
  return last;
}

function parseTradeHourInstruction(
  text: string,
): { trades: number; hoursEach: number } | null {
  const lower = String(text || "").toLowerCase();
  const tradeHourMatch = lastRegexMatch(
    lower,
    /(\d+(?:\.\d+)?)\s*(?:x\s*)?trades?\s*(?:x\s*)?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:each)?/gi,
  ) ||
    lastRegexMatch(
      lower,
      /(\d+(?:\.\d+)?)\s*trades?\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:each)?/gi,
    );
  if (!tradeHourMatch) return null;
  const trades = Number(tradeHourMatch[1]);
  const hoursEach = Number(tradeHourMatch[2]);
  if (!Number.isFinite(trades) || trades <= 0) return null;
  if (!Number.isFinite(hoursEach) || hoursEach <= 0) return null;
  return { trades, hoursEach };
}

function parseRateInstruction(text: string): number | null {
  const lower = String(text || "").toLowerCase();
  const rateMatch = lastRegexMatch(
    lower,
    /(?:at|@|charged\s+at)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:p\s*\/?\s*h|per\s+hour|ph|\/\s*h|hr|hour)?/gi,
  );
  if (!rateMatch) return null;
  const rate = Number(rateMatch[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function isLaterMaterialAddInstruction(text: string): boolean {
  const lower = String(text || "").toLowerCase();
  return /\b(?:add|include|charge|hire|supply|retrieval|star\s*pickets?|panels?|materials?)\b/
    .test(lower) &&
    !/\b(?:remove|delete|take\s+out|get\s+rid)\b/.test(lower);
}

function parseExactLabourOnlyFeedback(
  bodies: string[],
): { trades: number; hoursEach: number; rate: number } | null {
  let exactIndex = -1;
  let exactBody = "";
  bodies.forEach((body, index) => {
    const lower = String(body || "").toLowerCase();
    const exact = /\binvoice\s+should\s+(?:read|be)\b/.test(lower) &&
      (/\b(?:that['’]?s|that\s+is)\s+it\b/.test(lower) ||
        /\blabou?r\s+only\b/.test(lower) || /\bno\s+materials?\b/.test(lower));
    if (exact) {
      exactIndex = index;
      exactBody = body;
    }
  });
  if (exactIndex < 0) return null;
  const later = bodies.slice(exactIndex + 1).join("\n");
  if (isLaterMaterialAddInstruction(later)) return null;
  const tradeHours = parseTradeHourInstruction(exactBody);
  const rate = parseRateInstruction(exactBody);
  if (!tradeHours || !rate) return null;
  return { ...tradeHours, rate };
}

function parseGeneralLabourFeedback(
  bodies: string[],
  output: DraftPackOutput,
  ctx: DraftPackContext,
): { trades: number; hoursEach: number; rate: number } | null {
  let latestBody = "";
  bodies.forEach((body) => {
    const lower = String(body || "").toLowerCase();
    if (
      /\b(?:charge|invoice|labou?r)\b/.test(lower) &&
      parseTradeHourInstruction(body)
    ) latestBody = body;
  });
  if (!latestBody) return null;
  const tradeHours = parseTradeHourInstruction(latestBody);
  if (!tradeHours) return null;
  const explicitRate = parseRateInstruction(latestBody);
  const existingLabourRate = Number(
    output.invoice.line_items.find((line) => isLabourLine(line))?.unit_price ??
      NaN,
  );
  const rate = explicitRate ||
    (Number.isFinite(existingLabourRate) && existingLabourRate > 0
      ? existingLabourRate
      : defaultLabourRate(ctx, output));
  return { ...tradeHours, rate };
}

function applyLabourInstruction(
  output: DraftPackOutput,
  ctx: DraftPackContext,
  instruction: { trades: number; hoursEach: number; rate: number },
  replaceAllLines: boolean,
  summaryPrefix: string,
): DraftPackOutput {
  const totalHours = instruction.trades * instruction.hoursEach;
  const tradeLabel = instruction.trades === 1 ? "trade" : "trades";
  const accountCode =
    output.invoice.line_items.find((line) => line.account_code)?.account_code ||
    "210";
  const labourLine: DraftPackLineItem = {
    description: buildExactLabourDescription(
      output,
      ctx,
      totalHours,
      instruction.trades,
      instruction.hoursEach,
    ),
    quantity: totalHours,
    unit_price: instruction.rate,
    account_code: accountCode,
  };
  const lineItems = replaceAllLines
    ? [labourLine]
    : replaceOrPrependLabourLine(output.invoice.line_items, labourLine);
  return {
    ...output,
    report: {
      ...output.report,
      billing_note: `${formatQty(instruction.trades)} ${tradeLabel} x ${
        formatQty(instruction.hoursEach)
      } hours (${formatQty(totalHours)} labour hours total).`,
    },
    invoice: {
      ...output.invoice,
      line_items: lineItems,
    },
    change_summary: cleanDraftReviewSummary(
      `${
        replaceAllLines
          ? scrubStalePricingReviewSummary(output.change_summary)
          : output.change_summary
      } ${summaryPrefix}: ${formatQty(instruction.trades)} ${tradeLabel} x ${
        formatQty(instruction.hoursEach)
      } hours at $${formatQty(instruction.rate)} ex GST.`,
    ),
  };
}

function buildExactLabourDescription(
  output: DraftPackOutput,
  ctx: DraftPackContext,
  totalHours: number,
  trades: number,
  hoursEach: number,
): string {
  const existingLabour = output.invoice.line_items.find((line) => {
    return isLabourLine(line);
  });
  if (existingLabour?.description) return existingLabour.description;

  const detail = asRecord(ctx.detail);
  const job = asRecord(ctx.job);
  const ref = output.invoice.reference || output.report.ref ||
    detail.external_ref || job.job_number || "";
  const address = output.report.address || job.site_address ||
    job.site_suburb || "";
  const tradeLabel = trades === 1 ? "trade" : "trades";
  return [
    "Make-Safe Labour",
    address ? String(address) : "",
    `${formatQty(trades)} ${tradeLabel} x ${formatQty(hoursEach)} hours each (${
      formatQty(totalHours)
    } labour hours total)`,
    ref ? String(ref) : "",
  ].filter(Boolean).join(" - ");
}

function isLabourLine(line: DraftPackLineItem): boolean {
  const desc = String(line?.description || "").toLowerCase();
  return /labou?r|attendance|make[- ]safe|make safe|crew|trade/.test(desc) &&
    !/materials?|consumables?|panel|base|feet|fixings?|pickets?|tarp|retrieval|hire/
      .test(desc);
}

function replaceOrPrependLabourLine(
  lines: DraftPackLineItem[],
  labourLine: DraftPackLineItem,
): DraftPackLineItem[] {
  let replaced = false;
  const next = lines.map((line) => {
    if (!replaced && isLabourLine(line)) {
      replaced = true;
      return labourLine;
    }
    return line;
  });
  return replaced ? next : [labourLine, ...next];
}

function defaultLabourRate(
  ctx: DraftPackContext,
  output: DraftPackOutput,
): number {
  const detail = asRecord(ctx.detail);
  const makesafeCompany = asRecord(detail.makesafe_companies);
  const company = String(
    detail.requesting_company_name || makesafeCompany.name ||
      output.invoice.contact_name || "",
  ).toLowerCase();
  const ref = String(
    output.invoice.reference || output.report.ref || detail.external_ref || "",
  ).toUpperCase();
  if (
    ref.startsWith("AJBR") || company.includes("aj building") ||
    company.includes("ajs")
  ) return 80;
  return 85;
}

function feedbackRequestsPlaceholderRemoval(text: string): boolean {
  const lower = String(text || "").toLowerCase();
  return /\b(?:remove|delete|take\s+out|get\s+rid)\b[\s\S]{0,120}(?:\$1|one\s+dollar|placeholder|materials?\s+line)/
    .test(lower) ||
    /(?:\$1|one\s+dollar|placeholder|materials?\s+line)[\s\S]{0,120}\b(?:remove|delete|take\s+out|get\s+rid)\b/
      .test(lower);
}

function isPlaceholderInvoiceLine(line: DraftPackLineItem): boolean {
  const desc = String(line?.description || "").toLowerCase();
  const unit = Number(line?.unit_price ?? 0);
  return unit > 0 && unit <= 1.01 &&
    /placeholder|tbc|to\s+confirm|materials?|consumables?|sundries|misc/.test(
      desc,
    );
}

function applyPlaceholderRemoval(
  output: DraftPackOutput,
  feedbackText: string,
): DraftPackOutput {
  if (!feedbackRequestsPlaceholderRemoval(feedbackText)) return output;
  const filtered = output.invoice.line_items.filter((line) =>
    !isPlaceholderInvoiceLine(line)
  );
  if (filtered.length === output.invoice.line_items.length) return output;
  if (filtered.length === 0) {
    throw new Error(
      "Ops feedback asked to remove the $1 placeholder, but no non-placeholder invoice line remains",
    );
  }
  return {
    ...output,
    invoice: { ...output.invoice, line_items: filtered },
    change_summary: cleanDraftReviewSummary(
      `${
        scrubStalePricingReviewSummary(output.change_summary)
      } Removed the $1 placeholder invoice line per Ops feedback.`,
    ),
  };
}

function extractReportRemovalTerms(feedbackText: string): string[] {
  const lower = String(feedbackText || "").toLowerCase();
  const out: string[] = [];
  const re =
    /remove(?:\s+all)?\s+mentions?\s+of\s+([^.;\n]+?)(?:\s+from\s+(?:the\s+)?report|\s+from\s+report|[.;\n]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const chunk = m[1] || "";
    chunk.split(/\s*(?:,|\/|&|\band\b|\bor\b)\s*/i)
      .map((term) => term.replace(/\b(all|the|any|mentions?|of)\b/g, "").trim())
      .filter((term) => term.length >= 3)
      .forEach((term) => out.push(term));
  }
  return Array.from(new Set(out));
}

function scrubTermsFromText(text: string | undefined, terms: string[]): string {
  let result = cleanDraftText(text || "");
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sentenceRe = new RegExp(
      `(?:^|[.!?]\\s+)[^.!?]*\\b${escaped}\\b[^.!?]*(?=$|[.!?])`,
      "gi",
    );
    result = result.replace(sentenceRe, " ").replace(/\s+/g, " ").trim();
    const wordRe = new RegExp(`\\b${escaped}\\b`, "gi");
    result = result.replace(wordRe, "").replace(/\s+/g, " ").replace(
      /\s+([,.])/g,
      "$1",
    ).trim();
  }
  return result;
}

function applyReportTermRemovals(
  output: DraftPackOutput,
  feedbackText: string,
): DraftPackOutput {
  const terms = extractReportRemovalTerms(feedbackText);
  if (terms.length === 0) return output;
  return {
    ...output,
    report: {
      ...output.report,
      scope: scrubTermsFromText(output.report.scope, terms),
      findings: scrubTermsFromText(output.report.findings, terms),
      works: scrubTermsFromText(output.report.works, terms),
      materials: scrubTermsFromText(output.report.materials, terms),
    },
    change_summary: cleanDraftReviewSummary(
      `${output.change_summary} Removed report wording for: ${
        terms.join(", ")
      }.`,
    ),
  };
}

function isMlbDraft(ctx: DraftPackContext, output: DraftPackOutput): boolean {
  const detail = asRecord(ctx.detail);
  const makesafeCompany = asRecord(detail.makesafe_companies);
  const ref = String(
    output.invoice.reference || output.report.ref || detail.external_ref || "",
  ).toUpperCase();
  const company = String(
    output.invoice.contact_name || detail.requesting_company_name ||
      makesafeCompany.name || "",
  ).toLowerCase();
  return ref.startsWith("MLB") || company.includes("major loss") ||
    company.includes("ml builders");
}

function extractCountNear(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const m = lastRegexMatch(text, pattern);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function applyMlbTempFenceHireFeedback(
  output: DraftPackOutput,
  ctx: DraftPackContext,
  feedbackText: string,
): DraftPackOutput {
  const lowerFeedback = String(feedbackText || "").toLowerCase();
  if (!isMlbDraft(ctx, output)) return output;
  if (
    !/\b(?:hire|rental|retrieval|star\s*pickets?|temp(?:orary)?\s+fenc(?:e|ing)|panels?)\b/
      .test(lowerFeedback)
  ) return output;
  if (!/\b(?:charge|add|include|hire|we\s+hire|fee)\b/.test(lowerFeedback)) {
    return output;
  }

  const searchable = [
    feedbackText,
    output.report.scope,
    output.report.findings,
    output.report.works,
    output.report.materials,
    JSON.stringify(ctx.service_report || {}),
    JSON.stringify(ctx.detail || {}),
  ].join("\n").toLowerCase();

  const panels = extractCountNear(searchable, [
    /(?:temp(?:orary)?\s+)?(?:fenc(?:e|ing)\s+)?panels?\s*(?:x|×|:|-)?\s*(\d+(?:\.\d+)?)/gi,
    /(\d+(?:\.\d+)?)\s*(?:temp(?:orary)?\s+)?(?:fenc(?:e|ing)\s+)?panels?/gi,
  ]);
  const pickets = extractCountNear(searchable, [
    /star\s*pickets?\s*(?:x|×|:|-)?\s*(\d+(?:\.\d+)?)/gi,
    /(\d+(?:\.\d+)?)\s*star\s*pickets?/gi,
  ]);

  const detail = asRecord(ctx.detail);
  const job = asRecord(ctx.job);
  const ref = output.invoice.reference || output.report.ref ||
    detail.external_ref || "";
  const suburb = String(job.site_suburb || "").trim();
  const prefix = [ref, suburb].filter(Boolean).join(" - ");
  const accountCode =
    output.invoice.line_items.find((line) => line.account_code)?.account_code ||
    "210";
  const withoutOldHireLines = output.invoice.line_items.filter((line) => {
    const desc = String(line.description || "").toLowerCase();
    return !/temporary\s+fence\s+hire|star\s*pickets?|retrieval|collection|loading|cable\s+ties|small\s+consumables|fence\s+bases|feet/
      .test(desc);
  });
  const additions: DraftPackLineItem[] = [];
  additions.push({
    description: `${
      prefix ? prefix + " - " : ""
    }Temporary fencing retrieval, collection and loading allowance - 2 hours`,
    quantity: 2,
    unit_price: 90,
    account_code: accountCode,
  });
  if (panels) {
    additions.push({
      description: `${prefix ? prefix + " - " : ""}Temporary fence hire: ${
        formatQty(panels)
      } panels x $5 per panel per week x 12 weeks minimum`,
      quantity: 12,
      unit_price: panels * 5,
      account_code: accountCode,
    });
  }
  if (pickets) {
    additions.push({
      description: `${
        prefix ? prefix + " - " : ""
      }Star pickets supplied for temporary fencing make-safe - ${
        formatQty(pickets)
      } units`,
      quantity: pickets,
      unit_price: 13.5,
      account_code: accountCode,
    });
  }
  additions.push({
    description: `${
      prefix ? prefix + " - " : ""
    }Cable ties and small consumables`,
    quantity: 1,
    unit_price: 25,
    account_code: accountCode,
  });

  return {
    ...output,
    invoice: {
      ...output.invoice,
      line_items: [...withoutOldHireLines, ...additions],
    },
    change_summary: cleanDraftReviewSummary(
      `${
        scrubStalePricingReviewSummary(output.change_summary)
      } Applied MLB temporary fencing hire card from SecureWorks wiki: retrieval 2 hours x $90, panel hire $5/panel/week x 12 weeks${
        panels ? ` (${formatQty(panels)} panels)` : ""
      }${
        pickets ? `, star pickets ${formatQty(pickets)} x $13.50` : ""
      }, cable ties/small consumables $25.`,
    ),
  };
}

function sanitizeAndValidateDraftPackOutput(
  output: DraftPackOutput,
): DraftPackOutput {
  const next: DraftPackOutput = {
    ...output,
    report: {
      ...output.report,
      ref: cleanDraftText(output.report.ref),
      address: cleanDraftText(output.report.address),
      contact: cleanDraftText(output.report.contact),
      date: cleanDraftText(output.report.date),
      arrival: cleanDraftText(output.report.arrival),
      crew: cleanDraftText(output.report.crew),
      billing_note: cleanDraftText(output.report.billing_note),
      scope: cleanDraftText(output.report.scope),
      findings: cleanDraftText(output.report.findings),
      works: cleanDraftText(output.report.works),
      materials: cleanDraftText(output.report.materials),
    },
    invoice: {
      ...output.invoice,
      reference: cleanDraftText(output.invoice.reference),
      contact_name: cleanDraftText(output.invoice.contact_name),
      due_date: cleanDraftText(output.invoice.due_date),
      line_items: (output.invoice.line_items || []).map((line) => ({
        ...line,
        description: cleanDraftText(line.description),
      })),
    },
    change_summary: cleanDraftReviewSummary(output.change_summary),
  };
  if (!next.invoice.line_items.length) {
    throw new Error(
      "Draft pack must include at least one invoice line item after feedback overrides",
    );
  }
  const badPricing = next.invoice.line_items
    .map((li, index) => {
      if (!Number.isFinite(li.quantity) || li.quantity <= 0) {
        return `invoice line ${index + 1} has invalid quantity`;
      }
      if (!Number.isFinite(li.unit_price) || li.unit_price <= 0) {
        return `invoice line ${index + 1} has $0/invalid unit_price`;
      }
      return "";
    })
    .filter(Boolean);
  if (badPricing.length) {
    throw new Error(
      `Draft pack has invalid invoice pricing after feedback overrides: ${
        badPricing.join("; ")
      }`,
    );
  }
  assertDraftOnlyText(JSON.stringify(next));
  return next;
}

export function applyDraftPackFeedbackOverrides(
  output: DraftPackOutput,
  ctx: DraftPackContext,
): DraftPackOutput {
  const bodies = humanFeedbackBodies(ctx);
  const feedbackText = bodies.join("\n");
  let next = output;

  const exact = parseExactLabourOnlyFeedback(bodies);
  if (exact) {
    next = applyLabourInstruction(
      next,
      ctx,
      exact,
      true,
      "Exact Ops invoice instruction applied: labour only",
    );
  } else {
    const labour = parseGeneralLabourFeedback(bodies, next, ctx);
    if (labour) {
      next = applyLabourInstruction(
        next,
        ctx,
        labour,
        false,
        "Ops labour instruction applied",
      );
    }
  }

  next = applyMlbTempFenceHireFeedback(next, ctx, feedbackText);
  next = applyPlaceholderRemoval(next, feedbackText);
  next = applyReportTermRemovals(next, feedbackText);
  return sanitizeAndValidateDraftPackOutput(next);
}

export function assertDraftOnlyText(text: string): void {
  const lower = String(text ?? "").toLowerCase();
  for (const word of FORBIDDEN_IRREVERSIBLE_WORDS) {
    const needle = word.toLowerCase();
    if (lower.includes(needle)) {
      throw new Error(
        `draft response contains forbidden irreversible wording: ${word}`,
      );
    }
  }
}

// Select the jobs the cron/batch runner may safely hand to Draft Pack.
//
// Intentionally narrow:
//   - only the trade-report-in board state (`admin_to_send_report`);
//   - never an already-sent job;
//   - skip report-type jobs for this generic pack path (roof/assessment/report
//     family cards get their own mission/UI);
//   - skip failed/in-flight/resume/sent pack rows so cron cannot retry-storm a
//     money/comms edge case. A missing row, or a still-drafted incomplete row, is
//     safe to refresh into a human-review draft.
export function selectDraftPackDueJobIds(
  details: DraftPackDueDetail[],
  packs: DraftPackDuePack[],
  limit = 5,
  packKind = "main",
): string[] {
  const cap = Math.max(1, Math.min(50, Math.floor(Number(limit) || 5)));
  const packsByJob = new Map<string, DraftPackDuePack>();
  for (const pack of packs || []) {
    const jobId = String(pack?.job_id || "").trim();
    if (!jobId) continue;
    if (String(pack?.pack_kind || "main") !== packKind) continue;
    packsByJob.set(jobId, pack);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const detail of details || []) {
    const jobId = String(detail?.job_id || "").trim();
    if (!jobId || seen.has(jobId)) continue;
    if (String(detail?.substatus || "") !== "admin_to_send_report") continue;
    if (detail?.report_sent_at) continue;
    if (detail?.report_type) continue;

    const pack = packsByJob.get(jobId) || null;
    const status = String(pack?.status || "").toLowerCase();
    const due = !pack ||
      (status === "drafted" && (!pack.report_doc_id || !pack.xero_invoice_id));
    if (!due) continue;

    seen.add(jobId);
    out.push(jobId);
    if (out.length >= cap) break;
  }
  return out;
}

function clean(v: unknown): string {
  return String(v ?? "")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Test aliases.
export const _buildDraftPackSystemPrompt = buildDraftPackSystemPrompt;
export const _buildDraftPackUserPrompt = buildDraftPackUserPrompt;
export const _parseDraftPackResponse = parseDraftPackResponse;
export const _normaliseDraftPackOutput = normaliseDraftPackOutput;
export const _assertDraftOnlyText = assertDraftOnlyText;
export const _applyDraftPackFeedbackOverrides = applyDraftPackFeedbackOverrides;
export const _selectDraftPackDueJobIds = selectDraftPackDueJobIds;

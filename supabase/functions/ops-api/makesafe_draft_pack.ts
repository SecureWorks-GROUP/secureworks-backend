import {
  AJS_EXISTING_FENCE_STAR_PICKET_RATE_EX_GST,
  deriveExistingFencePicketDecision,
  type ExistingFencePicketDecision,
} from "./makesafe_existing_fence_pickets.ts";

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
  revision_assertions?: string[];
  applied_rule_ids?: string[];
}

export interface DraftPackContext {
  job?: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
  service_report?: Record<string, unknown> | null;
  feedback_notes?: Array<Record<string, unknown>>;
  selected_photo_urls?: string[];
  source_docs?: Array<Record<string, unknown>>;
}

export interface DraftPackVerificationResult {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  applied_rule_ids: string[];
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
      revision_assertions: [
        "specific human feedback/rules satisfied by this draft, e.g. 'removed temp fencing wording from report'",
      ],
      applied_rule_ids: [
        "pricing/reporting rule identifiers applied, e.g. MLB_ROUTINE_MIN_3H_85 or AJS_LABOUR_80",
      ],
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
      "If Ops feedback says there should be no mention of a topic, no report field may contain that topic after revision. If you cannot satisfy a feedback instruction, say so in change_summary and do not pretend it was done.",
      "For MLB / Major Loss Builders temporary-fence hire, use the SecureWorks hire card when the evidence gives quantities: labour $85 ex/hr weekday with 3-hour minimum (4 hours for solo temp-fence), retrieval allowance 2 hours x $90, panel hire $5 per panel per week for 12 weeks minimum, star pickets $13.50 each, cable ties/small consumables $25 flat. Do not price MLB panels as a sale.",
      "For AJS / AJ Building & Restoration / AJBR, normal labour is $80 ex/hr per trade unless the source evidence explicitly says public-holiday/after-hours/special rate. Do not use the generic $85 builder rate for AJBR/AJS.",
      "For AJS/AJBR temporary fencing, default to labour/travel only because AJS normally supplies/uses its own panels/blocks. Sell panels to AJS at $59 ex GST each and cement bases/blocks at $28 ex GST each only when source evidence explicitly says SecureWorks supplied/sold those materials to AJS. Counts alone are not sale evidence. Never charge AJS cable ties/clips/fixings/small consumables. The only picket carve-out is star pickets at $13.50 ex each when the trade materials_used gives one positive quantity and the scope/works narrative says they prop/support/brace/stabilise/secure an existing fence; any panel, block/base, tie/clip, fixing/consumable, hire, retrieval-material or temporary-fence signal keeps the refusal.",
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
    revision_assertions: cleanStringArray(
      root.revision_assertions ?? root.revisionAssertions,
    ),
    applied_rule_ids: cleanStringArray(
      root.applied_rule_ids ?? root.appliedRuleIds,
    ),
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
    !/materials?|consumables?|panel|base|feet|fixings?|tarp|retrieval|hire/
      .test(
        desc,
      ) &&
    !isPicketLine(line);
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
    /placeholder|tbc|to\s+confirm|materials?|consumables?|sundries|misc|panel|temporary\s+fenc|bases?|blocks?|feet|fixings?|pickets?/
      .test(
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
  const patterns = [
    /remove(?:\s+all)?\s+(?:mentions?|references?)\s+(?:of|to)\s+([^.;\n]+?)(?:\s+from\s+(?:the\s+)?report|\s+from\s+report|[.;\n]|$)/gi,
    /(?:there\s+should\s+be\s+)?no\s+(?:mention|mentions|reference|references)\s+(?:of|to)\s+([^.;\n]+?)(?:\s+(?:in|on)\s+(?:the\s+)?report|[.;\n]|$)/gi,
    /(?:the\s+)?report\s+should\s+(?:have\s+)?no\s+(?:mention|mentions|reference|references)\s+(?:of|to)\s+([^.;\n]+?)(?:[.;\n]|$)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      addRemovalTerms(out, m[1] || "");
    }
  }
  return Array.from(new Set(out));
}

function addRemovalTerms(out: string[], chunk: string): void {
  const trimmed = String(chunk || "")
    .replace(/\banything\s+outside\s+of[\s\S]*$/i, "")
    .replace(/\bbecause[\s\S]*$/i, "")
    .trim();
  const parts = trimmed.split(/\s*(?:,|\/|&|\band\b|\bor\b)\s*/i);
  for (const rawPart of parts) {
    const term = rawPart
      .replace(
        /\b(all|the|any|mentions?|references?|reference|from|report|there|should|be|no|mention|of|to)\b/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
    if (!term) continue;
    if (/temp(?:orary)?\s+fenc/.test(term)) {
      out.push(
        "temporary fencing",
        "temp fencing",
        "temporary fence",
        "temp fence",
      );
      continue;
    }
    if (term.length >= 3 && term.length <= 80) out.push(term);
  }
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

function invoiceLabourLines(output: DraftPackOutput): DraftPackLineItem[] {
  return (output.invoice.line_items || []).filter((line) => isLabourLine(line));
}

function totalLabourHours(output: DraftPackOutput): number {
  return invoiceLabourLines(output).reduce((sum, line) => {
    const qty = Number(line.quantity);
    return sum + (Number.isFinite(qty) ? qty : 0);
  }, 0);
}

function sourceAndFeedbackText(
  ctx: DraftPackContext,
  feedbackText = "",
): string {
  return [
    feedbackText,
    JSON.stringify(ctx.service_report || {}),
    JSON.stringify(ctx.detail || {}),
    JSON.stringify(ctx.job || {}),
    JSON.stringify(ctx.source_docs || []),
  ].join("\n").toLowerCase();
}

function hasSpecialRateEvidence(text: string): boolean {
  return /\b(?:after[-\s]?hours?|public\s+holiday|saturday|weekend|special\s+rate|emergency\s+rate|night\s+rate)\b/
    .test(String(text || "").toLowerCase());
}

function hasTempFenceContext(text: string): boolean {
  return /\b(?:temp(?:orary)?\s+fenc(?:e|ing)|hardifence|fence\s+panels?|fencing\s+panels?)\b/
    .test(String(text || "").toLowerCase());
}

function hasHumanSpecificLabourInstruction(
  bodies: string[],
  output: DraftPackOutput,
  ctx: DraftPackContext,
): boolean {
  return !!parseExactLabourOnlyFeedback(bodies) ||
    !!parseGeneralLabourFeedback(bodies, output, ctx);
}

function humanExplicitlyOverridesStandardPricing(text: string): boolean {
  const lower = String(text || "").toLowerCase();
  return /\b(?:discount|reduce|reduced|only\s+charge|just\s+charge|can't\s+charge|cant\s+charge|cannot\s+charge|not\s+fully\s+charge|charge\s+around|bill\s+\d|make\s+it\s+\d|fixed\s+price|lump\s+sum)\b/
    .test(lower);
}

function reportText(output: DraftPackOutput): string {
  return [
    output.report.scope,
    output.report.findings,
    output.report.works,
    output.report.materials,
  ].join("\n").toLowerCase();
}

function billingNoteMatchesHours(note: string, expectedHours: number): boolean {
  const lower = String(note || "").toLowerCase();
  if (!lower.trim() || !Number.isFinite(expectedHours) || expectedHours <= 0) {
    return true;
  }
  const tradeHours = parseTradeHourInstruction(lower);
  if (
    tradeHours &&
    Math.abs(tradeHours.trades * tradeHours.hoursEach - expectedHours) <= 0.01
  ) return true;
  const hourMatches = Array.from(
    lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:labou?r\s*)?(?:hours?|hrs?)\b/g),
  )
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  if (!hourMatches.length) return false;
  return hourMatches.some((n) => Math.abs(n - expectedHours) <= 0.01);
}

export function verifyDraftPackOutput(
  output: DraftPackOutput,
  ctx: DraftPackContext,
): DraftPackVerificationResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const applied = new Set<string>();
  const bodies = humanFeedbackBodies(ctx);
  const feedbackText = bodies.join("\n");
  const sourceText = sourceAndFeedbackText(ctx, feedbackText);
  const searchText = contextSearchText(output, ctx, feedbackText);
  const nonFeedbackSearchText = contextSearchText(output, ctx, "");
  const labourLines = invoiceLabourLines(output);
  const labourHours = totalLabourHours(output);
  const humanSpecificLabour = hasHumanSpecificLabourInstruction(
    bodies,
    output,
    ctx,
  );
  const humanOverride = humanSpecificLabour ||
    humanExplicitlyOverridesStandardPricing(feedbackText);

  const removalTerms = extractReportRemovalTerms(feedbackText);
  if (removalTerms.length > 0) {
    applied.add("REPORT_FEEDBACK_TERM_REMOVAL");
    const stillPresent = removalTerms.filter((term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(reportText(output));
    });
    if (stillPresent.length) {
      blockers.push(
        `report still mentions feedback-banned term(s): ${
          stillPresent.join(", ")
        }`,
      );
    }
  }

  if (isAjsDraft(ctx, output)) {
    applied.add("AJS_LABOUR_80");
    const specialRate = hasSpecialRateEvidence(sourceText);
    if (labourLines.length === 0) {
      blockers.push("AJS/AJBR make-safe drafts must include a labour line");
    }
    const wrongAjsRates = labourLines.filter((line) => {
      const unit = Number(line.unit_price);
      if (!Number.isFinite(unit)) return true;
      if (Math.abs(unit - 80) <= 0.005) return false;
      if (specialRate && unit > 80) return false;
      return !humanOverride;
    });
    if (wrongAjsRates.length) {
      blockers.push(
        "AJS/AJBR labour must use $80 ex/hr unless source evidence or human feedback explicitly sets a special rate",
      );
    }
    verifyAjsTempFenceInvoiceLines(
      output,
      ctx,
      feedbackText,
      blockers,
      applied,
    );
  }

  if (isMlbDraft(ctx, output)) {
    applied.add("MLB_ROUTINE_MIN_3H_85");
    const removedTempFence = removalTerms.some((term) =>
      /temp(?:orary)?\s+fenc/.test(term)
    );
    const tempFence = !removedTempFence &&
      hasTempFenceContext(nonFeedbackSearchText);
    const specialRate = hasSpecialRateEvidence(sourceText);
    if (labourLines.length === 0) {
      blockers.push(
        "MLB/Major Loss make-safe drafts must include a labour line",
      );
    }
    if (!humanOverride && labourHours > 0 && labourHours < 3) {
      blockers.push(
        "MLB/Major Loss routine make-safe labour must not be below 3 hours unless Ops explicitly discounts it",
      );
    }
    const wrongMlbRates = labourLines.filter((line) => {
      const unit = Number(line.unit_price);
      if (!Number.isFinite(unit)) return true;
      if (Math.abs(unit - 85) <= 0.005) return false;
      if (specialRate && unit >= 100) return false;
      return !humanOverride;
    });
    if (wrongMlbRates.length) {
      blockers.push(
        "MLB/Major Loss labour must use $85 ex/hr unless source evidence or human feedback explicitly sets a different rate",
      );
    }
    if (tempFence) {
      applied.add("MLB_TEMP_FENCE_CARD");
      const soloTempFence = /\b(?:solo|1\s+trade|one\s+trade)\b/.test(
        searchText,
      ) || labourLines.length === 1;
      if (
        !humanOverride && soloTempFence && labourHours > 0 && labourHours < 4
      ) {
        blockers.push(
          "MLB solo temporary-fence make-safe labour must be at least 4 hours unless Ops explicitly discounts it",
        );
      }
      verifyMlbTempFenceInvoiceLines(
        output,
        nonFeedbackSearchText,
        humanOverride,
        blockers,
        applied,
      );
    }
  }

  const billingNote = String(output.report.billing_note || "");
  if (
    /\b(?:pricing|cost(?:ing)?|rate|unit\s*price|invoice)\s+(?:to\s+be\s+)?(?:confirm|confirmed|reviewed|tbc)\b/i
      .test(billingNote)
  ) {
    blockers.push(
      "report.billing_note still contains pricing-to-confirm wording instead of a concrete labour basis",
    );
  }
  if (!billingNoteMatchesHours(billingNote, labourHours)) {
    warnings.push(
      `report.billing_note does not clearly match invoice labour hours (${
        formatQty(labourHours)
      } hours)`,
    );
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    applied_rule_ids: Array.from(applied),
  };
}

export function enforceDraftPackReportFeedbackTerms(
  output: DraftPackOutput,
  ctx: DraftPackContext,
): DraftPackOutput {
  return applyReportTermRemovals(output, humanFeedbackBodies(ctx).join("\n"));
}

function lineDescription(line: DraftPackLineItem): string {
  return String(line?.description || "").toLowerCase();
}

function isPanelLine(line: DraftPackLineItem): boolean {
  return /panel/.test(lineDescription(line)) &&
    /(?:temp(?:orary)?\s+)?fenc(?:e|ing)|make[- ]safe/.test(
      lineDescription(line),
    );
}

function isBaseLine(line: DraftPackLineItem): boolean {
  const desc = lineDescription(line);
  return /(?:cement\s+)?(?:bases?|blocks?|base\/foot|bases?\/feet|feet)/
    .test(desc) &&
    /(?:temp(?:orary)?\s+)?fenc(?:e|ing)|panel|make[- ]safe|cement/.test(desc);
}

function isPicketMaterialLine(
  line: DraftPackLineItem,
  picketPattern: RegExp,
): boolean {
  const desc = lineDescription(line);
  if (!picketPattern.test(desc)) return false;
  const attendanceWorded =
    /labou?r|attendance|trades?\s*(?:x|×)?\s*\d|trade[- ]hour|travel/.test(
      desc,
    );
  const materialChargeWorded =
    /\bhire\b|\bsuppl(?:y|ied|ies)\b|\bsale\b|\bsold\b|\bper\s*(?:panel|picket|unit|week|day)\b|\beach\b|\bmaterials?\s*(?:charge|cost|supplied)\b/
      .test(desc);
  return !attendanceWorded || materialChargeWorded;
}

function isPicketLine(line: DraftPackLineItem): boolean {
  return isPicketMaterialLine(line, /\bpickets?\b/);
}

function isStarPicketLine(line: DraftPackLineItem): boolean {
  return isPicketMaterialLine(line, /\bstar(?:[\W_]+)?pickets?\b/);
}

function isConsumableLine(line: DraftPackLineItem): boolean {
  return /cable\s*ties?|clips?|small\s+consumables|consumables?|fixings?/.test(
    lineDescription(line),
  );
}

function ajsExistingFencePicketDecision(
  output: DraftPackOutput,
  ctx: DraftPackContext,
): ExistingFencePicketDecision {
  const report = asRecord(ctx.service_report);
  const checklist = asRecord(report.checklist_json);
  const detail = asRecord(ctx.detail);
  const job = asRecord(ctx.job);
  const metadata = asRecord(job.metadata);
  const canonicalFamily = String(
    metadata.makesafe_job_family || detail.makesafe_job_family || "",
  );
  return deriveExistingFencePicketDecision({
    support_narratives: [
      output.report.scope,
      output.report.findings,
      output.report.works,
      output.report.materials,
      checklist.work_done,
      checklist.works_completed,
      checklist.scope,
      checklist.scope_notes,
      report.notes,
    ],
    materials_used: Array.isArray(checklist.materials_used)
      ? checklist.materials_used
      : report.materials_used,
    charged_line_descriptions: output.invoice.line_items.map((line) =>
      line.description
    ),
    declared_temporary_fence: /temp(?:orary)?[\s_-]*fenc/i.test(
      canonicalFamily,
    ),
  });
}

function near(value: number, expected: number, tolerance = 0.005): boolean {
  return Number.isFinite(value) && Math.abs(value - expected) <= tolerance;
}

function verifyAjsTempFenceInvoiceLines(
  output: DraftPackOutput,
  ctx: DraftPackContext,
  feedbackText: string,
  blockers: string[],
  applied: Set<string>,
): void {
  const lines = output.invoice.line_items || [];
  const materialLines = lines.filter((line) =>
    isPanelLine(line) || isBaseLine(line) || isPicketLine(line) ||
    isConsumableLine(line)
  );
  const existingFencePickets = ajsExistingFencePicketDecision(output, ctx);
  const picketLines = materialLines.filter(isStarPicketLine);
  if (
    existingFencePickets.state === "billable" && picketLines.length > 1
  ) {
    applied.add("AJS_EXISTING_FENCE_PICKETS_13_50");
    blockers.push(
      "AJS/AJBR existing-fence evidence permits exactly one canonical star-picket sale line",
    );
  }
  if (!materialLines.length) {
    if (existingFencePickets.state === "billable") {
      applied.add("AJS_EXISTING_FENCE_PICKETS_13_50");
      blockers.push(
        `AJS/AJBR existing-fence evidence requires ${
          formatQty(existingFencePickets.quantity)
        } star pickets at $13.50 ex each`,
      );
    }
    return;
  }
  applied.add("AJS_TEMP_FENCE_MATERIAL_GUARD");
  const hasSaleEvidence = hasExplicitAjsTempFenceSaleEvidence(
    ajsSaleEvidenceText(ctx, feedbackText),
  );
  for (const line of materialLines) {
    if (isPicketLine(line)) {
      if (
        isStarPicketLine(line) && existingFencePickets.state === "billable"
      ) {
        applied.add("AJS_EXISTING_FENCE_PICKETS_13_50");
        if (
          Number(line.quantity) !== existingFencePickets.quantity ||
          !near(
            Number(line.unit_price),
            AJS_EXISTING_FENCE_STAR_PICKET_RATE_EX_GST,
          )
        ) {
          blockers.push(
            `AJS/AJBR existing-fence star pickets must use the trade-evidenced quantity ${
              formatQty(existingFencePickets.quantity)
            } at $13.50 ex each`,
          );
        }
        continue;
      }
      blockers.push(
        "AJS/AJBR temp-fence drafts must not charge pickets unless the trade evidence proves the existing-fence carve-out",
      );
      continue;
    }
    if (isConsumableLine(line)) {
      blockers.push(
        "AJS/AJBR temp-fence drafts must not charge cable ties, clips, fixings, or small consumables",
      );
      continue;
    }
    if ((isPanelLine(line) || isBaseLine(line)) && !hasSaleEvidence) {
      blockers.push(
        "AJS/AJBR temp-fence panel/base charges require explicit SecureWorks sale/supply evidence",
      );
      continue;
    }
    if (isPanelLine(line) && !near(Number(line.unit_price), 59)) {
      blockers.push(
        "AJS/AJBR sold temp-fence panels must be priced at $59 ex GST each",
      );
    }
    if (isBaseLine(line) && !near(Number(line.unit_price), 28)) {
      blockers.push(
        "AJS/AJBR sold cement bases/blocks must be priced at $28 ex GST each",
      );
    }
  }
}

function hasLine(
  lines: DraftPackLineItem[],
  predicate: (line: DraftPackLineItem) => boolean,
): boolean {
  return lines.some(predicate);
}

function verifyMlbTempFenceInvoiceLines(
  output: DraftPackOutput,
  evidenceText: string,
  humanOverride: boolean,
  blockers: string[],
  applied: Set<string>,
): void {
  if (humanOverride) return;
  const lines = output.invoice.line_items || [];
  const panels = extractPanelCount(evidenceText);
  const pickets = extractCountNear(evidenceText, [
    /star\s*pickets?\s*(?:x|×|:|-)?\s*(\d+(?:\.\d+)?)/gi,
    /(\d+(?:\.\d+)?)\s*star\s*pickets?/gi,
  ]);
  const mentionsRetrieval =
    /\b(?:retrieval|retrieve|collection|collect|pickup|pick\s*up|remove|dismantle|loading|hire|rental)\b/
      .test(evidenceText);
  const requiresRetrieval = mentionsRetrieval ||
    hasTempFenceContext(evidenceText);

  if (requiresRetrieval) {
    applied.add("MLB_TEMP_FENCE_RETRIEVAL_2H_90");
    const ok = hasLine(lines, (line) => {
      const desc = lineDescription(line);
      return /retrieval|collection|loading|pick\s*up|pickup/.test(desc) &&
        Number(line.quantity) >= 2 && near(Number(line.unit_price), 90);
    });
    if (!ok) {
      blockers.push(
        "MLB temporary-fence hire/retrieval evidence requires retrieval allowance 2 hours x $90",
      );
    }
  }

  if (panels) {
    applied.add("MLB_TEMP_FENCE_PANEL_HIRE_12W");
    const saleStyle = hasLine(lines, (line) =>
      isPanelLine(line) &&
      (!/hire|rental|week/.test(lineDescription(line)) ||
        near(Number(line.unit_price), 59)));
    if (saleStyle) {
      blockers.push(
        "MLB temporary-fence panels must be hire lines, not sale-priced panel lines",
      );
    }
    const ok = hasLine(lines, (line) =>
      isPanelLine(line) &&
      /hire|rental|week/.test(lineDescription(line)) &&
      Number(line.quantity) >= 12 &&
      near(Number(line.unit_price), panels * 5));
    if (!ok) {
      blockers.push(
        `MLB temporary-fence hire requires ${
          formatQty(panels)
        } panels x $5/panel/week x 12 weeks minimum`,
      );
    }
  }

  if (pickets) {
    applied.add("MLB_TEMP_FENCE_PICKETS_13_50");
    const ok = hasLine(lines, (line) =>
      isPicketLine(line) &&
      Number(line.quantity) >= pickets &&
      near(Number(line.unit_price), 13.5));
    if (!ok) {
      blockers.push(
        "MLB temporary-fence star pickets must be priced at $13.50 each",
      );
    }
  }

  const consumablesNeeded = panels || pickets || mentionsRetrieval;
  if (consumablesNeeded) {
    applied.add("MLB_TEMP_FENCE_CONSUMABLES_25");
    const ok = hasLine(
      lines,
      (line) =>
        isConsumableLine(line) && Number(line.quantity) >= 1 &&
        near(Number(line.unit_price), 25),
    );
    if (!ok) {
      blockers.push(
        "MLB temporary-fence hire requires $25 cable ties/small consumables line",
      );
    }
  }
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

function isAjsDraft(ctx: DraftPackContext, output: DraftPackOutput): boolean {
  const detail = asRecord(ctx.detail);
  const makesafeCompany = asRecord(detail.makesafe_companies);
  const ref = String(
    output.invoice.reference || output.report.ref || detail.external_ref || "",
  ).toUpperCase();
  const company = String(
    output.invoice.contact_name || detail.requesting_company_name ||
      makesafeCompany.name || "",
  ).toLowerCase();
  return ref.startsWith("AJBR") || company.includes("aj building") ||
    company.includes("ajbr") || company.includes("ajs");
}

function contextSearchText(
  output: DraftPackOutput,
  ctx: DraftPackContext,
  feedbackText = "",
): string {
  return [
    feedbackText,
    output.report.scope,
    output.report.findings,
    output.report.works,
    output.report.materials,
    JSON.stringify(output.invoice.line_items || []),
    JSON.stringify(ctx.service_report || {}),
    JSON.stringify(ctx.detail || {}),
    JSON.stringify(ctx.job || {}),
    JSON.stringify(ctx.source_docs || []),
  ].join("\n").toLowerCase();
}

function ajsSaleEvidenceText(
  ctx: DraftPackContext,
  feedbackText = "",
): string {
  // Deliberately exclude model-generated invoice/report text here. AJS sale
  // pricing is allowed only from source evidence or human Ops feedback, not
  // from a prior draft line that may have invented "supplied" wording.
  return [
    feedbackText,
    JSON.stringify(ctx.service_report || {}),
    JSON.stringify(ctx.detail || {}),
    JSON.stringify(ctx.job || {}),
  ].join("\n").toLowerCase();
}

function hasExplicitAjsTempFenceSaleEvidence(text: string): boolean {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  const negatedSale =
    /\b(?:never|not|no|don't|do\s+not|didn'?t|wasn'?t|isn'?t|without)\b[\s\S]{0,45}\b(?:sell|sold|sale|selling|suppl(?:y|ied)|provided?|charge|bill|invoice)\b/;
  if (negatedSale.test(lower)) return false;
  return [
    /\b(?:sell|sold|sale|selling)\b[\s\S]{0,120}\b(?:ajs|ajbr|them|panels?|bases?|blocks?)\b/,
    /\b(?:charge|bill|invoice)\s+(?:ajs|ajbr|them)\s+for[\s\S]{0,80}\b(?:panels?|bases?|blocks?|temp(?:orary)?\s+fenc(?:e|ing))\b/,
    /\b(?:secureworks|we|our)\s+(?:supplied|provided|supply|provide|sold|sell)[\s\S]{0,80}\b(?:panels?|bases?|blocks?|temp(?:orary)?\s+fenc(?:e|ing))\b/,
    /\b(?:panels?|bases?|blocks?|temp(?:orary)?\s+fenc(?:e|ing))\b[\s\S]{0,80}\b(?:supplied|provided|sold)\s+by\s+(?:secureworks|us|our)\b/,
  ].some((pattern) => pattern.test(lower));
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

function extractPanelCount(text: string): number | null {
  return extractCountNear(text, [
    /(?:temp(?:orary)?\s+)?(?:fenc(?:e|ing)\s+)?panels?\s*(?:x|×|:|-)?\s*(\d+(?:\.\d+)?)/gi,
    /(\d+(?:\.\d+)?)\s*(?:x|×)?\s*(?:temp(?:orary)?\s+)?(?:fenc(?:e|ing)\s+)?panels?/gi,
  ]);
}

function extractBaseCount(text: string): number | null {
  return extractCountNear(text, [
    /(?:cement\s+)?(?:bases?|blocks?|base\/foot|bases?\/feet|feet)\s*(?:x|×|:|-)?\s*(\d+(?:\.\d+)?)/gi,
    /(\d+(?:\.\d+)?)\s*(?:x|×)?\s*(?:cement\s+)?(?:bases?|blocks?|base\/foot|bases?\/feet|feet)/gi,
  ]);
}

function buildInvoicePrefix(
  output: DraftPackOutput,
  ctx: DraftPackContext,
): string {
  const detail = asRecord(ctx.detail);
  const job = asRecord(ctx.job);
  const ref = String(
    output.invoice.reference || output.report.ref || detail.external_ref || "",
  ).trim();
  const suburb = String(job.site_suburb || detail.site_suburb || "").trim();
  return [ref, suburb].filter(Boolean).join(" - ");
}

function shouldUseAjsDefaultLabourRate(
  line: DraftPackLineItem,
  feedbackText: string,
): boolean {
  if (!isLabourLine(line)) return false;
  const unit = Number(line.unit_price);
  if (Math.abs(unit - 85) > 0.005) return false;
  const lower = String(feedbackText || "").toLowerCase();
  return !/\b(?:after[-\s]?hours?|public\s+holiday|saturday|weekend|special\s+rate)\b/
    .test(lower);
}

function applyAjsPricingFeedbackOverrides(
  output: DraftPackOutput,
  ctx: DraftPackContext,
  feedbackText: string,
): DraftPackOutput {
  if (!isAjsDraft(ctx, output)) return output;

  const searchable = contextSearchText(output, ctx, feedbackText);
  const hasSaleEvidence = hasExplicitAjsTempFenceSaleEvidence(
    ajsSaleEvidenceText(ctx, feedbackText),
  );
  const contextPanels = extractPanelCount(searchable);
  const contextBases = extractBaseCount(searchable);
  const exactLabourOnly = !!parseExactLabourOnlyFeedback(
    humanFeedbackBodies(ctx),
  );
  const existingFencePickets = ajsExistingFencePicketDecision(output, ctx);
  const existingFencePicketQty = !exactLabourOnly &&
      existingFencePickets.state === "billable"
    ? existingFencePickets.quantity
    : null;
  const accountCode =
    output.invoice.line_items.find((line) => line.account_code)?.account_code ||
    "210";
  const prefix = buildInvoicePrefix(output, ctx);
  let changed = false;
  let pendingPanelQty: number | null = null;
  let pendingBaseQty: number | null = null;
  let hasPanelLine = false;
  let hasBaseLine = false;
  let labourRateChanged = false;
  let removedPlaceholderLine = false;
  let removedAjsTempFenceMaterials = false;
  let removedAjsConsumables = false;
  let appliedExistingFencePickets = false;

  const retained: DraftPackLineItem[] = [];
  for (const line of output.invoice.line_items) {
    const desc = String(line.description || "").toLowerCase();
    const lineText = desc + "\n" + searchable;
    const isPanelLine = /panel/.test(desc) &&
      /(?:temp(?:orary)?\s+)?fenc(?:e|ing)|make[- ]safe/.test(desc);
    const isBaseLine =
      /(?:cement\s+)?(?:bases?|blocks?|base\/foot|bases?\/feet|feet)/.test(
        desc,
      ) &&
      /(?:temp(?:orary)?\s+)?fenc(?:e|ing)|panel|make[- ]safe|cement/.test(
        desc,
      );
    const isGenericTempFencePlaceholder = isPlaceholderInvoiceLine(line) &&
      /(?:temp(?:orary)?\s+)?fenc(?:e|ing)|panels?|bases?|blocks?|feet|fixings?|consumables?|materials?/
        .test(desc);
    const isAjsConsumableLine =
      /cable\s*ties?|clips?|fixings?|small\s+consumables|consumables?/.test(
        desc,
      );
    const isAjsPicketLine = isPicketLine(line);
    const isAjsStarPicketLine = isStarPicketLine(line);
    const isAjsTempFenceMaterialLine = isPanelLine || isBaseLine ||
      isGenericTempFencePlaceholder || isAjsPicketLine;

    if (shouldUseAjsDefaultLabourRate(line, feedbackText)) {
      retained.push({ ...line, unit_price: 80 });
      changed = true;
      labourRateChanged = true;
      continue;
    }

    if (isAjsStarPicketLine && existingFencePicketQty) {
      appliedExistingFencePickets = true;
      changed = true;
      continue;
    }

    if (isAjsConsumableLine || isAjsPicketLine) {
      removedAjsConsumables = true;
      changed = true;
      continue;
    }

    if (!hasSaleEvidence && isAjsTempFenceMaterialLine) {
      removedAjsTempFenceMaterials = true;
      removedPlaceholderLine ||= isPlaceholderInvoiceLine(line);
      changed = true;
      continue;
    }

    if (isPanelLine && Math.abs(Number(line.unit_price) - 59) <= 0.005) {
      hasPanelLine = true;
      retained.push(line);
      continue;
    }
    if (isBaseLine && Math.abs(Number(line.unit_price) - 28) <= 0.005) {
      hasBaseLine = true;
      retained.push(line);
      continue;
    }

    if (isPanelLine) {
      const qty = extractPanelCount(lineText) ||
        (Number(line.quantity) > 1 ? Number(line.quantity) : contextPanels);
      if (qty) {
        pendingPanelQty = qty;
        changed = true;
        continue;
      }
    }

    if (isBaseLine) {
      const qty = extractBaseCount(lineText) ||
        (Number(line.quantity) > 1 ? Number(line.quantity) : contextBases);
      if (qty) {
        pendingBaseQty = qty;
        changed = true;
        continue;
      }
    }

    if (isGenericTempFencePlaceholder) {
      if ((/panel/.test(desc) || contextPanels) && contextPanels) {
        pendingPanelQty = contextPanels;
      }
      if ((/(?:base|block|feet)/.test(desc) || contextBases) && contextBases) {
        pendingBaseQty = contextBases;
      }
      if (
        contextPanels || contextBases ||
        feedbackRequestsPlaceholderRemoval(feedbackText)
      ) {
        changed = true;
        removedPlaceholderLine = true;
        continue;
      }
    }

    retained.push(line);
  }

  const additions: DraftPackLineItem[] = [];
  if (existingFencePicketQty) {
    additions.push({
      description: `${
        prefix ? prefix + " - " : ""
      }Star pickets supplied to prop and secure existing fence`,
      quantity: existingFencePicketQty,
      unit_price: AJS_EXISTING_FENCE_STAR_PICKET_RATE_EX_GST,
      account_code: accountCode,
    });
    appliedExistingFencePickets = true;
  }
  if (pendingPanelQty && !hasPanelLine) {
    additions.push({
      description: `${
        prefix ? prefix + " - " : ""
      }Temporary fence panels supplied for make-safe - ${
        formatQty(pendingPanelQty)
      } panels`,
      quantity: pendingPanelQty,
      unit_price: 59,
      account_code: accountCode,
    });
  }
  if (pendingBaseQty && !hasBaseLine) {
    additions.push({
      description: `${
        prefix ? prefix + " - " : ""
      }Cement bases supplied for temporary fencing make-safe - ${
        formatQty(pendingBaseQty)
      } bases`,
      quantity: pendingBaseQty,
      unit_price: 28,
      account_code: accountCode,
    });
  }

  if (additions.length === 0 && !changed) return output;

  const summaryParts = [];
  if (labourRateChanged) {
    summaryParts.push(
      "applied AJS/AJBR normal labour at $80 ex/hr where the draft had the generic $85 rate",
    );
  }
  if (removedAjsTempFenceMaterials) {
    summaryParts.push(
      "removed AJS/AJBR temp-fence material charges because no explicit SecureWorks sale/supply evidence was present",
    );
  }
  if (pendingPanelQty) {
    summaryParts.push(
      `explicit AJS/AJBR sale evidence: temporary fence panels ${
        formatQty(pendingPanelQty)
      } x $59`,
    );
  }
  if (pendingBaseQty) {
    summaryParts.push(
      `explicit AJS/AJBR sale evidence: cement bases ${
        formatQty(pendingBaseQty)
      } x $28`,
    );
  }
  if (removedAjsConsumables) {
    summaryParts.push("removed AJS pickets/cable ties/consumables charge");
  }
  if (appliedExistingFencePickets && existingFencePicketQty) {
    summaryParts.push(
      `trade-evidenced existing-fence star pickets ${
        formatQty(existingFencePicketQty)
      } x $13.50`,
    );
  }
  if (removedPlaceholderLine && additions.length === 0) {
    summaryParts.push("removed unresolved AJS/AJBR material line");
  }
  if (summaryParts.length === 0) {
    summaryParts.push("applied AJS/AJBR wiki pricing guard");
  }

  return {
    ...output,
    invoice: {
      ...output.invoice,
      line_items: [...retained, ...additions],
    },
    change_summary: cleanDraftReviewSummary(
      `${scrubStalePricingReviewSummary(output.change_summary)} ${
        summaryParts.join("; ")
      }.`,
    ),
  };
}

function applyMlbTempFenceHireFeedback(
  output: DraftPackOutput,
  ctx: DraftPackContext,
  feedbackText: string,
): DraftPackOutput {
  const lowerFeedback = String(feedbackText || "").toLowerCase();
  if (!isMlbDraft(ctx, output)) return output;
  const feedbackRequestsHire =
    !/\b(?:hire|rental|retrieval|star\s*pickets?|temp(?:orary)?\s+fenc(?:e|ing)|panels?)\b/
        .test(lowerFeedback)
      ? false
      : /\b(?:charge|add|include|hire|we\s+hire|fee)\b/.test(lowerFeedback);

  const searchable = [
    contextSearchText(output, ctx, feedbackText),
  ].join("\n").toLowerCase();

  const panels = extractPanelCount(searchable);
  const pickets = extractCountNear(searchable, [
    /star\s*pickets?\s*(?:x|×|:|-)?\s*(\d+(?:\.\d+)?)/gi,
    /(\d+(?:\.\d+)?)\s*star\s*pickets?/gi,
  ]);
  const evidenceTriggersHire = hasTempFenceContext(searchable) &&
    (Boolean(panels) || Boolean(pickets));
  const exactLabourOnly = !!parseExactLabourOnlyFeedback(
    humanFeedbackBodies(ctx),
  );
  if (
    !feedbackRequestsHire &&
    (!evidenceTriggersHire || exactLabourOnly ||
      humanExplicitlyOverridesStandardPricing(feedbackText))
  ) {
    return output;
  }

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
    return !/temporary[\s\S]{0,80}fenc(?:e|ing)[\s\S]{0,80}hire|star\s*pickets?|retrieval|collection|loading|cable\s+ties|small\s+consumables|fixings?|consumables?|base\/foot|bases?\/feet|fence\s+bases|feet/
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
  const placeholderLines = next.invoice.line_items
    .map((li, index) => isPlaceholderInvoiceLine(li) ? index + 1 : 0)
    .filter(Boolean);
  if (placeholderLines.length) {
    throw new Error(
      `Draft pack still contains $1 placeholder invoice line(s): ${
        placeholderLines.join(", ")
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
  next = applyAjsPricingFeedbackOverrides(next, ctx, feedbackText);
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

function cleanStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => cleanDraftText(item)).filter(Boolean);
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
export const _verifyDraftPackOutput = verifyDraftPackOutput;
export const _selectDraftPackDueJobIds = selectDraftPackDueJobIds;

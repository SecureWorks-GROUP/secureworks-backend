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
        billing_note: "billing time/costing note",
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
            unit_price: 0,
            account_code: "210",
          },
        ],
      },
      change_summary:
        "short note explaining what changed and what still needs human review",
    },
    rules: [
      "Invoice lines must be DRAFT-only and exclude GST in unit_price.",
      "Use account_code 210 unless the context clearly specifies another make-safe account.",
      "If costing is uncertain, include the best draft line and say it needs pricing review in change_summary.",
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

export function normaliseDraftPackOutput(raw: any): DraftPackOutput {
  const report = raw?.report && typeof raw.report === "object"
    ? raw.report
    : {};
  const invoice = raw?.invoice && typeof raw.invoice === "object"
    ? raw.invoice
    : {};
  const lineItems = Array.isArray(invoice.line_items)
    ? invoice.line_items
    : (Array.isArray(invoice.lines) ? invoice.lines : []);
  const lines = lineItems.map((li: any) => ({
    description: String(li?.description ?? li?.Description ?? "").trim(),
    quantity: num(li?.quantity ?? li?.Quantity ?? 1, 1),
    unit_price: num(li?.unit_price ?? li?.unitPrice ?? li?.UnitAmount ?? 0, 0),
    account_code: String(li?.account_code ?? li?.accountCode ?? "210").trim() ||
      "210",
  })).filter((li: DraftPackLineItem) => li.description);

  if (lines.length === 0) {
    throw new Error(
      "Claude draft response must include at least one invoice line item",
    );
  }

  const out: DraftPackOutput = {
    report: {
      ref: clean(report.ref),
      address: clean(report.address),
      contact: clean(report.contact),
      date: clean(report.date),
      arrival: clean(report.arrival),
      crew: clean(report.crew),
      billing_note: clean(report.billing_note),
      scope: clean(report.scope),
      findings: clean(report.findings),
      works: clean(report.works),
      materials: clean(report.materials),
      photo_limit: Math.max(
        1,
        Math.min(12, Math.round(num(report.photo_limit, 8))),
      ),
    },
    invoice: {
      reference: clean(invoice.reference),
      contact_name: clean(invoice.contact_name ?? invoice.contactName),
      due_date: clean(invoice.due_date ?? invoice.dueDate),
      line_items: lines,
    },
    change_summary: clean(raw?.change_summary ?? raw?.summary) ||
      "Draft pack refreshed for human review.",
  };
  assertDraftOnlyText(JSON.stringify(out));
  return out;
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
export const _selectDraftPackDueJobIds = selectDraftPackDueJobIds;

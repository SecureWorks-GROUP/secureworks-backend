import {
  deriveMakesafeReportArrival,
  deriveMakesafeReportCrewLabel,
} from "./makesafe_report_kv_facts.ts";
import { resolveMakesafeReportProseSections } from "./makesafe_report_prose.ts";
import type {
  DraftPackContext,
  DraftPackOutput,
} from "./makesafe_draft_pack.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function formatCompactHours(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Math.round(value * 10) / 10);
}

export function compactDraftPackBillingNote(
  parsed: DraftPackOutput,
  ctx: DraftPackContext,
): string {
  const lines = Array.isArray(parsed?.invoice?.line_items)
    ? parsed.invoice.line_items
    : [];
  const detail = ctx.detail || {};
  const companyDetail = asRecord(detail.makesafe_companies);
  const ref = String(
    parsed.invoice?.reference || parsed.report?.ref ||
      detail.external_ref || "",
  ).toUpperCase();
  const company = String(
    parsed.invoice?.contact_name ||
      detail.requesting_company_name ||
      companyDetail.name ||
      "",
  ).toLowerCase();
  const isMlb = ref.includes("MLB") || company.includes("major loss") ||
    company.includes("ml builders");
  const labourLines = lines.filter((line) => {
    const description = String(line?.description || "").toLowerCase();
    if (!description) return false;
    if (
      /material|mould killer|tarp|panel|base|feet|fixing|consumable|photo|swms/
        .test(description)
    ) return false;
    return /labou?r|attendance|make[- ]safe|make safe|crew|trade/.test(
      description,
    );
  });
  const labourHours = labourLines.reduce((sum, line) => {
    const quantity = Number(line?.quantity ?? 0);
    return sum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 0);
  }, 0);
  if (labourHours <= 0) return "";

  const description = labourLines.map((line) => String(line?.description || ""))
    .join(" ");
  const tradeHourMatch = description.match(
    /(\d+(?:\.\d+)?)\s*(?:x\s*)?(?:trades?|crew|attendees?)\b[\s\S]{0,90}?(\d+(?:\.\d+)?)\s*(?:x\s*)?hours?/i,
  );
  if (tradeHourMatch) {
    const trades = Number(tradeHourMatch[1]);
    const hours = Number(tradeHourMatch[2]);
    if (
      Number.isFinite(trades) && trades > 0 && Number.isFinite(hours) &&
      hours > 0
    ) {
      const total = trades * hours;
      const tradeLabel = trades === 1 ? "trade" : "trades";
      const totalSuffix = Math.abs(total - labourHours) < 0.2 || trades === 1
        ? ""
        : ` (${formatCompactHours(labourHours)} labour hours total)`;
      return `${formatCompactHours(trades)} ${tradeLabel} x ${
        formatCompactHours(hours)
      } hours${totalSuffix}.`;
    }
  }
  if (isMlb && Math.abs(labourHours - 3) < 0.2) return "1 trade x 3 hours.";
  return `${formatCompactHours(labourHours)} labour hours total.`;
}

/**
 * The canonical DraftPackOutput/report projection used by the served report
 * renderer. SES review materials call this rather than assembling a second
 * report shape from raw checklist fields.
 */
export function projectDraftPackReport(
  parsed: DraftPackOutput,
  ctx: DraftPackContext,
  selectedPhotoUrls: string[] = [],
): Record<string, unknown> {
  const job = ctx.job || {};
  const detail = ctx.detail || {};
  const serviceReport = ctx.service_report || {};
  const checklist = asRecord(serviceReport.checklist_json);
  const ref = parsed.report.ref || parsed.invoice.reference ||
    detail.external_ref ||
    job.job_number || job.id;
  const address = parsed.report.address || job.site_address ||
    job.site_suburb ||
    "Address TBC";
  const compactBillingNote = compactDraftPackBillingNote(parsed, ctx);
  const crew = deriveMakesafeReportCrewLabel({
    supplied: parsed.report.crew,
    tradeCount: checklist.trade_count,
    assignments: ctx.assignments || [],
  });
  const arrival = deriveMakesafeReportArrival({
    supplied: parsed.report.arrival,
    checklistArrival: checklist.arrival_time,
  });
  const prose = resolveMakesafeReportProseSections(
    {
      scope: parsed.report.scope,
      findings: parsed.report.findings,
      works: parsed.report.works ||
        (checklist.work_done as string | undefined) ||
        (serviceReport.notes as string | undefined),
      materials: parsed.report.materials,
    },
    checklist,
  );
  return {
    ref,
    address,
    contact: parsed.report.contact || job.client_name || "",
    date: parsed.report.date || serviceReport.submitted_at ||
      job.updated_at || "",
    arrival,
    crew,
    billing_note: compactBillingNote || parsed.report.billing_note ||
      detail.invoice_notes || "",
    scope: prose.scope,
    findings: prose.findings,
    works: prose.works,
    materials: prose.materials,
    photos: selectedPhotoUrls.map((url) => ({ url })),
    photo_limit: parsed.report.photo_limit || 8,
  };
}

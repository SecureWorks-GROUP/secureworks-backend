// Deterministic, label-anchored work-order PDF gap filling.
// Email/template values are supplied as `current` and always win. This module
// never calls a model and never overwrites a populated field.

import { extractClientFieldsFromPdfText } from "./makesafe_pdf_client_fields.ts";

export type PdfGapFillField =
  | "client_name"
  | "client_phone"
  | "site_address"
  | "site_suburb"
  | "external_ref"
  | "description";

export type PdfGapFillValues = Partial<Record<PdfGapFillField, string>>;

export interface PdfFieldProvenance {
  method: "deterministic";
  source: "work_order_pdf_text";
  rule: "work_order_pdf_gap_fill@v1";
  extractor: string;
  sourcePostId: string;
  attachmentId: string;
  attachmentName: string | null;
}

export interface PdfGapFillResult {
  fields: PdfGapFillValues;
  filledFields: PdfGapFillField[];
  provenance: Partial<Record<PdfGapFillField, PdfFieldProvenance>>;
  warnings: string[];
}

export interface PdfGapFillInput {
  current: PdfGapFillValues;
  pdfText: string | null | undefined;
  extractor: string;
  sourcePostId: string;
  attachmentId: string;
  attachmentName: string | null;
}

const REF_PATTERNS = [
  /\b(?:work|works)\s*order\s*(?:number|no\.?|#)?\s*[:#-]?\s*((?=[A-Z0-9._/-]*\d)[A-Z0-9][A-Z0-9._/-]{2,})\b/i,
  /\b(?:external|claim)\s*(?:reference|ref|number|no\.?|#)\s*[:#-]?\s*((?=[A-Z0-9._/-]*\d)[A-Z0-9][A-Z0-9._/-]{2,})\b/i,
  /\bjob\s*(?:number|no\.?|#)\s*[:#-]?\s*((?=[A-Z0-9._/-]*\d)[A-Z0-9][A-Z0-9._/-]{2,})\b/i,
];

const DESCRIPTION_LABEL =
  /^(?:scope(?:\s+of\s+works?)?|work\s+description|job\s+description|works?\s+required|instructions?|make\s+safe\s+works?)\s*:?\s*(.*)$/i;
const SECTION_LABEL =
  /^(?:work\s+order|works\s+order|supervisor|policy\s*holders?|policyholder|insured|home\s*owner|homeowner|client|customer|contact|mobile|home|email|insurer|site\s+address|property\s+address|risk\s+address|job\s+address|other\s+contact|purchase\s+order|po\s*(?:number|no\.?|#)|external\s+ref|claim\s+ref|job\s*(?:number|no\.?|#)|notes?|attachments?)\b/i;

function clean(value: unknown): string | null {
  const result = String(value ?? "").replace(/\u00a0/g, " ")
    .replace(/[ \t]{2,}/g, " ").trim();
  return result || null;
}

function nonEmpty(value: unknown): boolean {
  return clean(value) !== null;
}

function extractExternalRef(text: string): string | null {
  for (const pattern of REF_PATTERNS) {
    const value = clean(text.match(pattern)?.[1]);
    if (value) return value.replace(/[.,;:]+$/, "");
  }
  return null;
}

function extractDescription(text: string): {
  value: string | null;
  warning?: string;
} {
  const lines = text.split(/\r?\n/).map(clean).filter((
    value,
  ): value is string => !!value);
  const candidates = new Map<string, string>();
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(DESCRIPTION_LABEL);
    if (!match) continue;
    const parts: string[] = [];
    const inline = clean(match[1]);
    if (inline) parts.push(inline);
    for (
      let cursor = index + 1;
      cursor < lines.length && cursor <= index + 12;
      cursor++
    ) {
      if (
        DESCRIPTION_LABEL.test(lines[cursor]) ||
        SECTION_LABEL.test(lines[cursor])
      ) break;
      parts.push(lines[cursor]);
    }
    const value = clean(parts.join(" "));
    if (!value || value.length < 8) continue;
    const bounded = value.slice(0, 2_000);
    candidates.set(
      bounded.toLowerCase().replace(/[^a-z0-9]/g, ""),
      bounded,
    );
  }
  if (candidates.size === 1) return { value: [...candidates.values()][0] };
  if (candidates.size > 1) {
    return { value: null, warning: "ambiguous_pdf_description" };
  }
  return { value: null };
}

function suburbFromAddress(address: string | null): string | null {
  if (!address) return null;
  const match = address.match(
    /,\s*([A-Za-z][A-Za-z .'-]{1,60}?)(?:,\s*|\s+)(?:WA|Western Australia)\s+\d{4}\b/i,
  );
  return clean(match?.[1]);
}

export function gapFillFromWorkOrderPdf(
  input: PdfGapFillInput,
): PdfGapFillResult {
  const result: PdfGapFillResult = {
    fields: { ...input.current },
    filledFields: [],
    provenance: {},
    warnings: [],
  };
  try {
    const text = String(input.pdfText || "").trim();
    if (!text) return { ...result, warnings: ["empty_pdf_text"] };

    const client = extractClientFieldsFromPdfText(text);
    if (!client.unambiguous && client.note) {
      result.warnings.push(`pdf_client_fields:${client.note}`);
    }
    const description = extractDescription(text);
    if (description.warning) result.warnings.push(description.warning);
    const extracted: PdfGapFillValues = {
      ...(client.unambiguous
        ? {
          client_name: client.fields.client_name || undefined,
          client_phone: client.fields.client_phone || undefined,
          site_address: client.fields.site_address || undefined,
        }
        : {}),
      external_ref: extractExternalRef(text) || undefined,
      description: description.value || undefined,
    };
    extracted.site_suburb = !nonEmpty(input.current.site_address)
      ? suburbFromAddress(clean(extracted.site_address)) || undefined
      : undefined;

    for (
      const field of Object.keys(extracted) as PdfGapFillField[]
    ) {
      const value = clean(extracted[field]);
      if (!value || nonEmpty(input.current[field])) continue;
      result.fields[field] = value;
      result.filledFields.push(field);
      result.provenance[field] = {
        method: "deterministic",
        source: "work_order_pdf_text",
        rule: "work_order_pdf_gap_fill@v1",
        extractor: input.extractor,
        sourcePostId: input.sourcePostId,
        attachmentId: input.attachmentId,
        attachmentName: input.attachmentName,
      };
    }
    return result;
  } catch {
    return { ...result, warnings: ["pdf_gap_fill_failed"] };
  }
}

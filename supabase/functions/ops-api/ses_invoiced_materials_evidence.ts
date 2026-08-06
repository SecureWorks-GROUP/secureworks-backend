/**
 * Money already billed — and a pack already shipped — are answers to the
 * materials question.
 *
 * `ses_materials_charge_guard.ts` refuses a silent labour-only proposal when
 * the trade recorded materials used, because this system has no authoritative
 * unit-price list for general make-safe consumables and must never invent one.
 * That guard reads exactly one surface: the `materials_charge` marker a docket
 * revision carries. It is blind to the card's own ISSUED Xero invoice — so a
 * card whose materials a human already priced, authorised and (often) got paid
 * for still asks the operator to price them from scratch.
 *
 * An explicit priced materials line on an issued invoice is STRONGER evidence
 * than a bare figure typed onto a docket: a human read the report, chose the
 * charge, and committed it to the builder. Recognising it does not weaken the
 * gate. Recognising ANY invoice would, so this module never does: a labour-only
 * invoice yields no evidence and the question stands.
 *
 * The reading is deliberately FAIL-CLOSED at every step. Ambiguity (two issued
 * invoices, a line this module cannot account for, an unreadable amount) is
 * never resolved in favour of unblocking a card — it returns the same "no
 * evidence" answer as a labour-only invoice, and the operator prices it.
 *
 * What this module does NOT do: it never adds money to a proposal. The card's
 * materials are already on the issued invoice, so the correct entry on the
 * local proposal is a recorded decision naming that invoice, not a second
 * charge line that a later mint could double-bill. See
 * `decideStandardLabourMaterialsCharge`'s `already_invoiced` action.
 *
 * `readSesReleasedCycleEvidence` is the STRONGER rule beside it (Captain
 * 2026-08-06, Woodvale SWMS-261128 and Ballajura SWMS-26902). A card whose
 * CURRENT attendance cycle has already shipped to the builder and been billed
 * must not be asked to price anything at all — the answer, wherever it was
 * recorded, is settled, and anyone who supplied a figure would double-bill.
 * It holds where the invoice reading cannot: all eight already-sent cards
 * measured on 2026-08-06 mirror ZERO invoice line items, so their money is
 * unreadable line by line and only the send proof settles them.
 *
 * Two boundaries on that rule are load-bearing:
 *
 *  - Terminal is PROVEN, never inferred. The proof is a `ses_release_route_proofs`
 *    row, which carries `job_id`. Do not reach for `ses_external_effects`: its
 *    `job_id` is NULL on every one of the 41 `route_send` rows (measured
 *    2026-08-06), so a job join there reads as "nothing was ever sent".
 *  - Terminal is CYCLE-SCOPED. A re-attendance legitimately reopens a card that
 *    already shipped, and the new cycle's materials are a genuine new question.
 *    Only a proof naming the card's CURRENT cycle settles it.
 */

/** Xero statuses that mean the money is committed, not still editable. */
const ISSUED_INVOICE_STATUSES = new Set(["AUTHORISED", "PAID"]);

/**
 * Labour vocabulary, checked FIRST. A labour line describing the works can
 * mention what was installed, so a materials word inside an hours line must
 * never make it materials evidence.
 */
const LABOUR_LINE_RE =
  /\b(?:labour|labor|attendance|reattendance|re-attendance|hours?|hrs)\b|\d+(?:\.\d+)?\s*(?:x\s*)?h(?:ou)?rs?\b|\btrades?\s*x\b|\bcall[\s-]?out\b|\btravel\b/i;

/**
 * Charged services that are neither labour nor a material. They are recognised
 * ONLY so they cannot be silently counted into a materials figure; they are
 * excluded from the sum and never establish evidence on their own.
 */
const EXCLUDED_SERVICE_LINE_RE =
  /\b(?:disposal|disposed|tip(?:ping)?\s+fees?|waste\s+removal|skip\s+bin)\b/i;

/**
 * Materials vocabulary. Deliberately generic rather than a goods catalogue: a
 * list of products (silicone, plyboard, star pickets, …) is always incomplete,
 * and an incomplete list fails OPEN by leaving real materials unrecognised. A
 * line this module cannot place in one of the three buckets refuses the whole
 * reading instead.
 */
const MATERIALS_LINE_RE =
  /\b(?:materials?|consumables?|fixings?|supplied|supply|hire|sundries)\b/i;

export type SesInvoiceLineKind =
  | "labour"
  | "materials"
  | "excluded_service"
  | "unrecognised";

/**
 * Which bucket one invoice line falls in. Precedence is labour, then excluded
 * service, then materials — an hours line wins over every other word in it.
 */
export function classifySesInvoiceLineDescription(
  description: unknown,
): SesInvoiceLineKind {
  const text = typeof description === "string" ? description.trim() : "";
  if (!text) return "unrecognised";
  if (LABOUR_LINE_RE.test(text)) return "labour";
  if (EXCLUDED_SERVICE_LINE_RE.test(text)) return "excluded_service";
  if (MATERIALS_LINE_RE.test(text)) return "materials";
  return "unrecognised";
}

/** One row of the local `xero_invoices` mirror, as the adapter reads it. */
export interface SesIssuedInvoiceCandidate {
  invoice_id: string | null;
  invoice_number: string | null;
  status: string | null;
  invoice_type: string | null;
  line_items: unknown;
}

export interface SesInvoicedMaterialsLine {
  description: string;
  amount_ex_gst: number;
}

export interface SesInvoicedMaterialsEvidence {
  invoice_id: string;
  invoice_number: string;
  status: string;
  /** Sum of the materials-classified lines, ex GST. Always > 0. */
  materials_ex_gst: number;
  materials_lines: SesInvoicedMaterialsLine[];
  labour_line_count: number;
  excluded_service_line_count: number;
}

export type SesInvoicedMaterialsRefusalCode =
  | "no_issued_invoice"
  | "multiple_issued_invoices"
  | "invoice_line_items_absent"
  | "invoice_line_unreadable"
  | "invoice_line_unrecognised"
  | "invoice_prices_no_materials";

export type SesInvoicedMaterialsReading =
  | { kind: "evidence"; evidence: SesInvoicedMaterialsEvidence }
  | {
    kind: "none";
    reason_code: SesInvoicedMaterialsRefusalCode;
    detail: string;
  };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One `ses_release_route_proofs` row, which is the only proof a pack shipped. */
export interface SesReleaseRouteProofRow {
  route_kind: string | null;
  proven_at: string | null;
  attendance_cycle_ids: unknown;
}

export interface SesReleasedCycleEvidence {
  /** Route kinds proven for THIS cycle, e.g. report / photo / invoice. */
  route_kinds: string[];
  /** Newest proof timestamp among them. */
  last_proven_at: string | null;
  invoice_number: string;
  invoice_status: string;
}

export type SesReleasedCycleRefusalCode =
  | "no_current_attendance_cycle"
  | "current_cycle_not_shipped"
  | "not_billed";

export type SesReleasedCycleReading =
  | { kind: "released"; evidence: SesReleasedCycleEvidence }
  | {
    kind: "none";
    reason_code: SesReleasedCycleRefusalCode;
    detail: string;
  };

/**
 * Has this card's CURRENT attendance cycle already shipped to the builder and
 * been billed?
 *
 * Both halves are required and both are read from evidence: a route proof that
 * names this cycle, and an issued ACCREC invoice on the card. A prior cycle's
 * proof proves nothing about this one — that is what keeps a re-attendance a
 * real question — and a missing cycle id refuses rather than matching anything.
 */
export function readSesReleasedCycleEvidence(input: {
  attendance_cycle_id: string | null;
  route_proofs: readonly SesReleaseRouteProofRow[];
  invoices: readonly SesIssuedInvoiceCandidate[];
}): SesReleasedCycleReading {
  const cycle = text(input.attendance_cycle_id);
  if (!cycle) {
    return {
      kind: "none",
      reason_code: "no_current_attendance_cycle",
      detail:
        "This card has no current attendance cycle, so no send proof can be attributed to one.",
    };
  }
  const forCycle = input.route_proofs.filter((proof) =>
    Array.isArray(proof.attendance_cycle_ids) &&
    proof.attendance_cycle_ids.some((id) => text(id) === cycle)
  );
  if (!forCycle.length) {
    return {
      kind: "none",
      reason_code: "current_cycle_not_shipped",
      detail: input.route_proofs.length
        ? "This card has shipped, but no route proof names its current attendance cycle, so the current cycle is still open work."
        : "This card has no release route proof, so nothing has shipped to the builder.",
    };
  }
  const issued = input.invoices.filter((candidate) =>
    text(candidate.invoice_type).toUpperCase() === "ACCREC" &&
    ISSUED_INVOICE_STATUSES.has(text(candidate.status).toUpperCase())
  );
  if (!issued.length) {
    return {
      kind: "none",
      reason_code: "not_billed",
      detail:
        "This card's current cycle has shipped but carries no AUTHORISED or PAID ACCREC invoice, so it is not billed.",
    };
  }
  const routeKinds = [
    ...new Set(forCycle.map((proof) => text(proof.route_kind)).filter(Boolean)),
  ].sort();
  const provenAt = forCycle
    .map((proof) => text(proof.proven_at))
    .filter(Boolean)
    .sort();
  return {
    kind: "released",
    evidence: {
      route_kinds: routeKinds,
      last_proven_at: provenAt.length ? provenAt[provenAt.length - 1] : null,
      invoice_number: text(issued[0].invoice_number),
      invoice_status: text(issued[0].status).toUpperCase(),
    },
  };
}

/**
 * Xero's own PascalCase is what the mirror stores, but a few historical rows
 * and every test fixture are easier to read in snake_case, so both are
 * accepted. An amount that is present in neither form is unreadable, not zero.
 */
function lineAmountExGst(line: Record<string, unknown>): number | null {
  for (const key of ["LineAmount", "line_amount", "lineAmount"] as const) {
    if (!Object.hasOwn(line, key)) continue;
    const amount = Number(line[key]);
    if (Number.isFinite(amount)) return Math.round(amount * 100) / 100;
    return null;
  }
  const quantity = Number(
    line.Quantity ?? line.quantity ?? (line as { qty?: unknown }).qty,
  );
  const unit = Number(line.UnitAmount ?? line.unit_amount ?? line.unitAmount);
  if (!Number.isFinite(quantity) || !Number.isFinite(unit)) return null;
  return Math.round(quantity * unit * 100) / 100;
}

function lineDescription(line: Record<string, unknown>): string {
  return text(line.Description) || text(line.description);
}

/**
 * Read the card's issued-invoice materials evidence.
 *
 * `candidates` is every ACCREC row the local mirror holds for this ONE job.
 * The reading refuses unless a single issued invoice accounts for every one of
 * its own lines and at least one of them prices materials.
 */
export function readSesInvoicedMaterialsEvidence(
  candidates: readonly SesIssuedInvoiceCandidate[],
): SesInvoicedMaterialsReading {
  const issued = candidates.filter((candidate) =>
    text(candidate.invoice_type).toUpperCase() === "ACCREC" &&
    ISSUED_INVOICE_STATUSES.has(text(candidate.status).toUpperCase())
  );
  if (!issued.length) {
    return {
      kind: "none",
      reason_code: "no_issued_invoice",
      detail:
        "This card has no AUTHORISED or PAID ACCREC invoice, so no committed money describes its materials.",
    };
  }
  if (issued.length > 1) {
    // Two issued invoices on one card is exactly the shape a double-bill takes.
    // Picking one would be a guess about which money the materials belong to.
    return {
      kind: "none",
      reason_code: "multiple_issued_invoices",
      detail: `This card carries ${issued.length} issued ACCREC invoices (${
        issued.map((row) => text(row.invoice_number) || "unnumbered").join(", ")
      }), so which one prices its materials is ambiguous.`,
    };
  }
  const invoice = issued[0];
  const number = text(invoice.invoice_number);
  const lines = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  if (!lines.length) {
    return {
      kind: "none",
      reason_code: "invoice_line_items_absent",
      detail:
        `Issued invoice ${number} has no mirrored line items, so what it priced cannot be read.`,
    };
  }

  const materialsLines: SesInvoicedMaterialsLine[] = [];
  let labourLineCount = 0;
  let excludedServiceLineCount = 0;
  for (const raw of lines) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        kind: "none",
        reason_code: "invoice_line_unreadable",
        detail:
          `Issued invoice ${number} carries a line that is not a readable object.`,
      };
    }
    const line = raw as Record<string, unknown>;
    const description = lineDescription(line);
    const amount = lineAmountExGst(line);
    if (!description || amount === null) {
      return {
        kind: "none",
        reason_code: "invoice_line_unreadable",
        detail:
          `Issued invoice ${number} carries a line with no readable description or ex-GST amount.`,
      };
    }
    const kind = classifySesInvoiceLineDescription(description);
    if (kind === "unrecognised") {
      // Fail closed. An unaccounted line means any materials figure derived
      // from this invoice would be a partial reading presented as a whole one.
      return {
        kind: "none",
        reason_code: "invoice_line_unrecognised",
        detail:
          `Issued invoice ${number} carries a line this reading cannot account for as labour, materials or a charged service: "${description}".`,
      };
    }
    if (kind === "labour") {
      labourLineCount += 1;
      continue;
    }
    if (kind === "excluded_service") {
      excludedServiceLineCount += 1;
      continue;
    }
    if (amount > 0) materialsLines.push({ description, amount_ex_gst: amount });
  }

  const total = Math.round(
    materialsLines.reduce((sum, line) => sum + line.amount_ex_gst, 0) * 100,
  ) / 100;
  if (!materialsLines.length || total <= 0) {
    // The load-bearing refusal: a labour-only invoice must never silence the
    // materials question.
    return {
      kind: "none",
      reason_code: "invoice_prices_no_materials",
      detail:
        `Issued invoice ${number} prices no materials (${labourLineCount} labour line(s), ${excludedServiceLineCount} other charged service line(s)), so it does not answer what the materials cost.`,
    };
  }
  return {
    kind: "evidence",
    evidence: {
      invoice_id: text(invoice.invoice_id),
      invoice_number: number,
      status: text(invoice.status).toUpperCase(),
      materials_ex_gst: total,
      materials_lines: materialsLines,
      labour_line_count: labourLineCount,
      excluded_service_line_count: excludedServiceLineCount,
    },
  };
}

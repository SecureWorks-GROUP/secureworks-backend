// Dispatch scope material lines, stage 2. Pure rules.
// Contract: docs/dispatch-scope-material-lines-v1.md.
//
// Maps a stated supplier name onto an existing supplier record, and decides
// which scope-order lines may be copied onto the job. Nothing here creates a
// supplier, picks a close name, prices a line from the order, or sends.

export function normaliseSupplierName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export type SupplierCandidate = {
  id: string;
  name: string;
  aliases?: readonly string[] | null;
  is_active?: boolean | null;
};

export type SupplierMatch =
  | { status: "matched"; supplier_id: string; supplier_name: string }
  | {
    status: "unmatched";
    reason: "supplier_unmatched" | "supplier_inactive" | "supplier_not_stated";
  }
  | { status: "ambiguous"; reason: "supplier_ambiguous" };

function aliasList(value: readonly string[] | null | undefined): string[] {
  if (!value) return [];
  return value.filter((item) => typeof item === "string" && item.trim().length > 0);
}

function candidateNames(supplier: SupplierCandidate): string[] {
  return [supplier.name, ...aliasList(supplier.aliases)]
    .map((name) => normaliseSupplierName(name))
    .filter((name) => name.length > 0);
}

// Exact normalised name or a known alias. Punctuation, "Pty Ltd" and a
// trailing place name are not stripped, so Metroll does not match Metroll Perth.
export function matchSupplier(
  stated: string | null,
  suppliers: readonly SupplierCandidate[],
): SupplierMatch {
  if (stated === null) return { status: "unmatched", reason: "supplier_not_stated" };
  const key = normaliseSupplierName(stated);
  if (!key) return { status: "unmatched", reason: "supplier_not_stated" };
  const hits = suppliers.filter((supplier) => candidateNames(supplier).includes(key));
  const active = hits.filter((supplier) => supplier.is_active !== false);
  if (active.length === 1) {
    return {
      status: "matched",
      supplier_id: active[0].id,
      supplier_name: active[0].name,
    };
  }
  if (active.length > 1) return { status: "ambiguous", reason: "supplier_ambiguous" };
  if (hits.length > 0) return { status: "unmatched", reason: "supplier_inactive" };
  return { status: "unmatched", reason: "supplier_unmatched" };
}

export function storedSupplierMatch(
  match: SupplierMatch,
): "matched" | "unmatched" | "ambiguous" {
  return match.status;
}

export type ConfirmedPriceRow = {
  id: string;
  material_code: string | null;
  supplier_name: string;
  unit_price: number;
  status: string;
  confirmed_at: string | null;
};

// A timestamp, not the text of one. PostgreSQL to_json writes +00:00, and a
// caller may send Z or a fractional second. Those are one clock. An unreadable
// value sorts as older than any real instant. A tie keeps the smaller id.
function confirmedAtMillis(value: string | null): number | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

// Newest confirmed_at, then the smaller id. Pending and dismissed never count.
// The supplier name must be the matched record's name or one of its aliases.
export function confirmedUnitPrice(
  product: string,
  supplierNames: readonly string[],
  rows: readonly ConfirmedPriceRow[],
): number | null {
  const names = new Set(
    supplierNames.map((name) => normaliseSupplierName(name)).filter((name) => name.length > 0),
  );
  const hits = rows.filter((row) =>
    row.status === "confirmed" &&
    row.material_code === product &&
    names.has(normaliseSupplierName(row.supplier_name)) &&
    Number.isFinite(row.unit_price) &&
    row.unit_price >= 0
  );
  hits.sort((a, b) => {
    const am = confirmedAtMillis(a.confirmed_at);
    const bm = confirmedAtMillis(b.confirmed_at);
    if (am !== bm) {
      if (am === null) return 1;
      if (bm === null) return -1;
      return bm - am;
    }
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
  return hits.length === 0 ? null : hits[0].unit_price;
}

// A fence post stands in 600 mm of ground. The cut is the sheet, the plinth
// rail, and that bury. 1800 + 150 + 600 is a 2550 cut, bought as a 2700 bar.
// This step does not choose the bar. It only refuses a stated bar that cannot
// hold one of its cuts.
export const FENCE_POST_IN_GROUND_MM = 600;

export function fencePostCutMm(sheetHeightMm: number, plinthRailMm: number): number {
  return sheetHeightMm + plinthRailMm + FENCE_POST_IN_GROUND_MM;
}

export function stockShorterThanCut(
  stockLengthMm: number | null,
  cuts: readonly { length_mm: number }[],
): boolean {
  if (stockLengthMm === null || !Number.isFinite(stockLengthMm)) return false;
  return cuts.some((cut) => Number.isFinite(cut.length_mm) && cut.length_mm > stockLengthMm);
}

export function scopeLineCopyReasons(
  productUnknown: boolean,
  match: SupplierMatch,
  lengths: { stock_length_mm: number | null; cuts: readonly { length_mm: number }[] },
): string[] {
  const reasons: string[] = [];
  if (productUnknown) reasons.push("unknown_product");
  if (match.status !== "matched") reasons.push(match.reason);
  if (stockShorterThanCut(lengths.stock_length_mm, lengths.cuts)) {
    reasons.push("stock_shorter_than_cut");
  }
  return reasons;
}

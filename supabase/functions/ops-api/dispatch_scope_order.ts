// Dispatch scope order lines, stage 1.
// Contract: docs/dispatch-scope-order-lines-v1.md.
//
// Turns a Scope Engine supplier order into lines attached to one scope on a
// job. The accepted documents are scope-engine-order/v1, supplier-order/v1
// (what createOrder writes) and a Demand list. A scope-engine-v2 job is not
// an order: its members are not quantities or cut lengths. Nothing here
// nests stock, picks a catalogue row, matches a supplier contact, prices a
// line, or sends.

export const SCOPE_ORDER_LINE_MAX = 500;
export const SCOPE_ORDER_DESCRIPTION_MAX = 300;
export const SCOPE_ORDER_UNIT_MAX = 30;
export const SCOPE_ORDER_QUANTITY_MAX = 999_999_999.999;
export const SCOPE_ORDER_TEXT_MAX = 200;
export const SCOPE_ORDER_LENGTH_MM_MAX = 100_000;
export const SCOPE_ORDER_CUT_MAX = 40;
export const SCOPE_ORDER_CUT_RAW_MAX = 400;
export const SCOPE_ORDER_REF_MAX = 80;
export const SCOPE_ORDER_BYTES_MAX = 2_000_000;
export const SCOPE_ORDER_VERSION_MAX = 200;

const DEMAND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:|/+-]{0,199}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:|/+-]{0,79}$/;
const POSITIONAL_DEMAND_RE = /^material-\d+$/;

export class DispatchScopeOrderError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.body = { error: message, code, ...extra };
  }
}

export type ScopeOrderCut = { length_mm: number; qty: number };

// The only note that is a price reminder. Any other note still means the
// product itself is not settled.
export const SCOPE_ORDER_PRICE_NOTE = "to confirm";

export type ScopeOrderLine = {
  demand_id: string;
  product: string | null;
  product_unknown: boolean;
  // True only when every toConfirm note is the generic price reminder.
  // A named product with only that note is known: product_unknown stays false.
  price_to_confirm: boolean;
  description: string;
  quantity: number | null;
  unit: string | null;
  // Uniform piece length. Null when the pieces on the line are not one length.
  length_mm: number | null;
  // Bar to buy. Null when the document does not state a buy length.
  stock_length_mm: number | null;
  stock_qty: number | null;
  cut_size: string | null;
  cuts: ScopeOrderCut[];
  element_refs: string[];
  supplier_name: string | null;
};

export type ParsedScopeOrder = {
  lines: ScopeOrderLine[];
  withheld_demand_ids: string[];
};

type CutListEntry = { cuts: ScopeOrderCut[]; references: string[] };

export function scopeOrderUtf8Bytes(order: unknown): number {
  return new TextEncoder().encode(JSON.stringify(order)).length;
}

export function parseScopeOrder(input: unknown): ParsedScopeOrder {
  if (Array.isArray(input)) return finish(parseDemands(input), []);
  if (!input || typeof input !== "object") {
    invalid("order must be an object or a list of demands");
  }
  const record = input as Record<string, unknown>;
  if (record.schema === "scope-engine-order/v1") {
    return finish(parseStrictLines(record), []);
  }
  if (record.schemaVersion === "supplier-order/v1") return parseSupplierOrder(record);
  if (record.schema === "scope-engine-v2/job@1") {
    invalid(
      "a scope-engine-v2 job is not an order. Import the supplier-order/v1 that createOrder writes",
    );
  }
  invalid(
    "order schema was not recognised. Send scope-engine-order/v1, supplier-order/v1, or a demand list",
  );
}

export function requireScopeId(value: unknown): string {
  if (typeof value !== "string") {
    throw new DispatchScopeOrderError(400, "invalid_request", "scope_id required");
  }
  const trimmed = value.trim();
  if (!DEMAND_ID_RE.test(trimmed)) {
    throw new DispatchScopeOrderError(400, "invalid_request", "scope_id required");
  }
  return trimmed;
}

export function requireOrderVersion(value: unknown): string {
  if (typeof value !== "string") {
    throw new DispatchScopeOrderError(400, "invalid_request", "order_version required");
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > SCOPE_ORDER_VERSION_MAX) {
    throw new DispatchScopeOrderError(400, "invalid_request", "order_version required");
  }
  return trimmed;
}

export function scopeOrderConfirmFlags(
  product: string | null,
  notes: readonly string[],
  extraUnknown: boolean,
): { product_unknown: boolean; price_to_confirm: boolean } {
  const priceOnly = notes.length > 0 && notes.every((note) =>
    note.trim().toLowerCase() === SCOPE_ORDER_PRICE_NOTE
  );
  const otherNote = notes.some((note) => note.trim().toLowerCase() !== SCOPE_ORDER_PRICE_NOTE);
  return {
    product_unknown: product === null || extraUnknown || otherNote,
    price_to_confirm: priceOnly,
  };
}

export function formatScopeOrderLine(line: ScopeOrderLine): string {
  const product = line.product_unknown
    ? (line.product ? `to confirm (${line.product})` : "to confirm")
    : (line.product ?? "to confirm");
  const qty = line.quantity === null
    ? "qty not stated"
    : `qty ${line.quantity}${line.unit ? " " + line.unit : ""}`;
  const stock = line.stock_length_mm === null
    ? "stock not stated"
    : `stock ${line.stock_qty ?? "?"} x ${line.stock_length_mm} mm`;
  const cut = line.cut_size ?? "cut not stated";
  const refs = line.element_refs.length === 0 ? "no element" : line.element_refs.join(" ");
  const supplier = line.supplier_name ?? "supplier not stated";
  return `${line.demand_id} | ${product} | ${line.description} | ${qty} | ${stock} | ${cut} | ${refs} | ${supplier}`;
}

function finish(
  lines: ScopeOrderLine[],
  withheld: string[],
): ParsedScopeOrder {
  assignStableDemandIds(lines);
  if (lines.length > SCOPE_ORDER_LINE_MAX) {
    invalid(`an order can carry at most ${SCOPE_ORDER_LINE_MAX} lines`);
  }
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.demand_id)) {
      invalid(`demand ${line.demand_id} is repeated`);
    }
    seen.add(line.demand_id);
  }
  return { lines, withheld_demand_ids: [...new Set(withheld)].sort() };
}

function invalid(message: string): never {
  throw new DispatchScopeOrderError(400, "invalid_order", message);
}

function demandId(value: unknown, label: string): string {
  if (typeof value !== "string" || !DEMAND_ID_RE.test(value)) {
    invalid(`${label} must be a short id`);
  }
  return value;
}

function descriptionOf(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > SCOPE_ORDER_DESCRIPTION_MAX) {
    invalid(
      `${label} must be 1 to ${SCOPE_ORDER_DESCRIPTION_MAX} characters`,
    );
  }
  return trimmed;
}

function quantityOf(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(`${label} must be a number 0 or more, or null`);
  }
  if (value > SCOPE_ORDER_QUANTITY_MAX) invalid(`${label} is too large`);
  // JSON numbers round-trip through their shortest text. More than three
  // digits after the point does not fit numeric(12,3), so it is refused
  // rather than rounded into a different quantity.
  const text = String(value);
  const fraction = text.includes("e") || text.includes("E") ? "e" : (text.split(".")[1] ?? "");
  if (fraction.length > 3) invalid(`${label} has more than 3 decimal places`);
  return Math.round(value * 1000) / 1000;
}

function unitOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") invalid("unit must be text or null");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > SCOPE_ORDER_UNIT_MAX) {
    invalid(`unit must be at most ${SCOPE_ORDER_UNIT_MAX} characters`);
  }
  return trimmed;
}

function textOrNull(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") invalid(`${label} must be text or null`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > SCOPE_ORDER_TEXT_MAX) {
    invalid(`${label} must be at most ${SCOPE_ORDER_TEXT_MAX} characters`);
  }
  return trimmed;
}

function wholeMm(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(`${label} must be a whole number of millimetres`);
  }
  if (value > SCOPE_ORDER_LENGTH_MM_MAX) invalid(`${label} is longer than 100 m`);
  return value;
}

function cutsOf(value: unknown, lengthKey: "length_mm" | "lengthMm"): ScopeOrderCut[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid("cuts must be a list");
  if (value.length > SCOPE_ORDER_CUT_RAW_MAX) {
    invalid(`a line can carry at most ${SCOPE_ORDER_CUT_RAW_MAX} cuts`);
  }
  return value.map((cut, index) => {
    if (!cut || typeof cut !== "object" || Array.isArray(cut)) {
      invalid(`cut ${index + 1} must be an object`);
    }
    const record = cut as Record<string, unknown>;
    const qty = record.qty;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) {
      invalid(`cut ${index + 1} qty must be a whole number of 1 or more`);
    }
    return { length_mm: wholeMm(record[lengthKey], `cut ${index + 1} length`), qty };
  });
}

function coalesceCuts(cuts: ScopeOrderCut[]): ScopeOrderCut[] {
  const totals = new Map<number, number>();
  for (const cut of cuts) totals.set(cut.length_mm, (totals.get(cut.length_mm) ?? 0) + cut.qty);
  return [...totals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([length_mm, qty]) => ({ length_mm, qty }));
}

function pieceLength(cuts: ScopeOrderCut[]): number | null {
  if (cuts.length === 0) return null;
  const first = cuts[0].length_mm;
  return cuts.every((cut) => cut.length_mm === first) ? first : null;
}

// A supplier line's lengthMm is the bar to buy. A demand's length is the
// piece. When a stated piece length disagrees with the cuts, keep both: the
// stated length is the bar and the cuts are the pieces.
function applyLengths(
  rawCuts: ScopeOrderCut[],
  stated: number | null,
  statedIsStock: boolean,
): { length_mm: number | null; stock_length_mm: number | null; cuts: ScopeOrderCut[] } {
  const cuts = coalesceCuts(rawCuts);
  if (cuts.length > SCOPE_ORDER_CUT_MAX) {
    invalid(`a line can carry at most ${SCOPE_ORDER_CUT_MAX} cuts`);
  }
  const piece = pieceLength(cuts);
  if (statedIsStock) {
    return { length_mm: piece, stock_length_mm: stated, cuts };
  }
  if (cuts.length === 0) return { length_mm: stated, stock_length_mm: null, cuts };
  if (stated === null || stated === piece) return { length_mm: piece, stock_length_mm: null, cuts };
  return { length_mm: piece, stock_length_mm: stated, cuts };
}

function cutSize(cuts: ScopeOrderCut[]): string | null {
  if (cuts.length === 0) return null;
  const text = cuts.map((cut) => `${cut.qty} x ${cut.length_mm} mm`).join(", ");
  if (text.length > SCOPE_ORDER_DESCRIPTION_MAX) invalid("cut size is too long");
  return text;
}

function line(parts: {
  demand_id: string;
  product: string | null;
  product_unknown: boolean;
  price_to_confirm: boolean;
  description: string;
  quantity: number | null;
  unit: string | null;
  length_mm: number | null;
  stock_length_mm: number | null;
  stock_qty: number | null;
  cuts: ScopeOrderCut[];
  element_refs: string[];
  supplier_name: string | null;
}): ScopeOrderLine {
  if (parts.element_refs.length > SCOPE_ORDER_REF_MAX) {
    invalid(`a line can name at most ${SCOPE_ORDER_REF_MAX} elements`);
  }
  const unknown = parts.product === null ? true : parts.product_unknown;
  return {
    demand_id: parts.demand_id,
    product: parts.product,
    product_unknown: unknown,
    price_to_confirm: parts.price_to_confirm,
    description: parts.description,
    quantity: parts.quantity,
    unit: parts.unit,
    length_mm: parts.length_mm,
    stock_length_mm: parts.stock_length_mm,
    stock_qty: parts.stock_qty,
    cut_size: cutSize(parts.cuts),
    cuts: parts.cuts,
    element_refs: parts.element_refs,
    supplier_name: parts.supplier_name,
  };
}

function confirmList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalid("toConfirm must be a list of text");
  }
  return value;
}

function referenceList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(`${label} references must be a list`);
  const refs: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !REF_RE.test(item)) {
      invalid(`${label} reference must be a short id`);
    }
    refs.push(item);
  }
  return [...new Set(refs)].sort();
}

function requirementRefs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid("requirements must be a list");
  const refs: string[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid(`requirement ${index + 1} must be an object`);
    }
    refs.push(...referenceList((raw as Record<string, unknown>).references, `requirement ${index + 1}`));
  }
  return [...new Set(refs)].sort();
}

function parseStrictLines(record: Record<string, unknown>): ScopeOrderLine[] {
  if (!Array.isArray(record.lines)) invalid("lines must be a list");
  return record.lines.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid(`line ${index + 1} must be an object`);
    }
    const row = raw as Record<string, unknown>;
    const product = textOrNull(row.product, "product");
    const toConfirm = confirmList(row.to_confirm ?? row.toConfirm);
    const unresolved = row.unresolved === true;
    if (row.product_unknown !== undefined && typeof row.product_unknown !== "boolean") {
      invalid("product_unknown must be true or false");
    }
    const flags = scopeOrderConfirmFlags(
      product,
      toConfirm,
      row.product_unknown === true || unresolved,
    );
    const statedLength = row.length_mm === undefined || row.length_mm === null
      ? null
      : wholeMm(row.length_mm, "length_mm");
    const lengths = applyLengths(cutsOf(row.cuts, "length_mm"), statedLength, false);
    const quantity = quantityOf(row.quantity, `line ${index + 1} quantity`);
    return line({
      demand_id: demandId(row.demand_id, `line ${index + 1} demand_id`),
      product,
      product_unknown: flags.product_unknown,
      price_to_confirm: flags.price_to_confirm,
      description: descriptionOf(row.description, `line ${index + 1} description`),
      quantity,
      unit: unitOf(row.unit),
      length_mm: lengths.length_mm,
      stock_length_mm: lengths.stock_length_mm,
      stock_qty: lengths.stock_length_mm === null ? null : quantity,
      cuts: lengths.cuts,
      element_refs: referenceList(row.element_refs ?? row.references, `line ${index + 1}`),
      supplier_name: textOrNull(row.supplier ?? row.supplier_name, "supplier"),
    });
  });
}

function parseDemands(rows: unknown[]): ScopeOrderLine[] {
  return rows.map((raw, index) => demandLine(raw, `demand ${index + 1}`));
}

function demandLine(raw: unknown, label: string, forceUnknown = false): ScopeOrderLine {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalid(`${label} must be an object`);
  }
  const row = raw as Record<string, unknown>;
  const product = textOrNull(row.engineKey ?? row.product, "product");
  const toConfirm = confirmList(row.toConfirm ?? row.to_confirm);
  if (row.cuts !== undefined && row.cuts !== null) {
    if (!Array.isArray(row.cuts)) invalid("cuts must be a list");
    for (const cut of row.cuts) {
      if (cut && typeof cut === "object" && "length_mm" in (cut as object)) {
        invalid("a demand cut uses lengthMm");
      }
    }
  }
  const lengths = applyLengths(cutsOf(row.cuts, "lengthMm"), null, false);
  const flags = scopeOrderConfirmFlags(product, toConfirm, forceUnknown);
  return line({
    demand_id: demandId(row.id ?? row.demand_id, `${label} id`),
    product,
    product_unknown: flags.product_unknown,
    price_to_confirm: flags.price_to_confirm,
    description: descriptionOf(row.description, `${label} description`),
    quantity: quantityOf(row.quantity, `${label} quantity`),
    unit: unitOf(row.unit),
    length_mm: lengths.length_mm,
    stock_length_mm: lengths.stock_length_mm,
    stock_qty: null,
    cuts: lengths.cuts,
    element_refs: referenceList(row.references, label),
    supplier_name: null,
  });
}

function cutListIndex(value: unknown): Map<string, CutListEntry> {
  if (value === undefined || value === null) return new Map();
  if (!Array.isArray(value)) invalid("cutList must be a list");
  const index = new Map<string, CutListEntry>();
  for (const [entryIndex, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid(`cutList ${entryIndex + 1} must be an object`);
    }
    const row = raw as Record<string, unknown>;
    if (row.id === undefined && row.demand_id === undefined) {
      invalid(`cutList ${entryIndex + 1} must name a demand id`);
    }
    const id = demandId(row.id ?? row.demand_id, `cutList ${entryIndex + 1} id`);
    if (index.has(id)) invalid(`cutList demand ${id} is repeated`);
    if (row.cuts !== undefined && row.cuts !== null) {
      if (!Array.isArray(row.cuts)) invalid("cuts must be a list");
      for (const cut of row.cuts) {
        if (cut && typeof cut === "object" && "length_mm" in (cut as object)) {
          invalid("a demand cut uses lengthMm");
        }
      }
    }
    index.set(id, {
      cuts: coalesceCuts(cutsOf(row.cuts, "lengthMm")),
      references: referenceList(row.references, `cutList ${entryIndex + 1}`),
    });
  }
  return index;
}

function parseSupplierOrder(record: Record<string, unknown>): ParsedScopeOrder {
  if (!Array.isArray(record.suppliers)) invalid("suppliers must be a list");
  const cutList = cutListIndex(record.cutList);
  const unresolvedRaw = record.unresolved === undefined ? [] : record.unresolved;
  if (!Array.isArray(unresolvedRaw)) invalid("unresolved must be a list");
  const unresolvedLines: ScopeOrderLine[] = [];
  const unresolvedIds = new Set<string>();
  for (const [index, raw] of unresolvedRaw.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid(`unresolved ${index + 1} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    const built = demandLine(item.demand, `unresolved ${index + 1}`, true);
    if (unresolvedIds.has(built.demand_id)) {
      invalid(`demand ${built.demand_id} is repeated`);
    }
    unresolvedIds.add(built.demand_id);
    unresolvedLines.push(built);
  }
  const purchase: ScopeOrderLine[] = [];
  const withheld: string[] = [];
  for (const [groupIndex, groupRaw] of record.suppliers.entries()) {
    if (!groupRaw || typeof groupRaw !== "object" || Array.isArray(groupRaw)) {
      invalid(`supplier ${groupIndex + 1} must be an object`);
    }
    const group = groupRaw as Record<string, unknown>;
    const groupName = textOrNull(group.supplier ?? group.name, "supplier");
    if (!Array.isArray(group.lines)) invalid(`supplier ${groupIndex + 1} lines must be a list`);
    for (const [lineIndex, raw] of group.lines.entries()) {
      const built = supplierLine(
        raw,
        groupName,
        `supplier ${groupIndex + 1} line ${lineIndex + 1}`,
        cutList,
      );
      const blocked = built.demandIds.filter((id) => unresolvedIds.has(id));
      if (blocked.length === 0) purchase.push(built.line);
      else if (blocked.length < built.demandIds.length) {
        withheld.push(...built.demandIds.filter((id) => !unresolvedIds.has(id)));
      }
    }
  }
  return finish([...purchase, ...unresolvedLines], withheld);
}

function supplierLine(
  raw: unknown,
  groupName: string | null,
  label: string,
  cutList: Map<string, CutListEntry>,
): { line: ScopeOrderLine; demandIds: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalid(`${label} must be an object`);
  }
  const row = raw as Record<string, unknown>;
  if (!Array.isArray(row.demandIds) || row.demandIds.length === 0) {
    invalid(`${label} must name the demands it covers`);
  }
  const demandIds = row.demandIds.map((id, index) =>
    demandId(id, `${label} demand ${index + 1}`)
  );
  const unique = [...new Set(demandIds)].sort();
  const product = textOrNull(row.productId ?? row.product, "product");
  const toConfirm = confirmList(row.toConfirm ?? row.to_confirm);
  let cuts = cutsOf(row.cuts, "lengthMm");
  // Cuts on the purchase line are the pieces on that bar. cutList is the
  // whole demand, so it fills a line only when the line itself has none.
  if (cuts.length === 0) {
    cuts = unique.flatMap((id) => cutList.get(id)?.cuts ?? []);
  }
  let elementRefs = requirementRefs(row.requirements);
  if (elementRefs.length === 0) {
    elementRefs = [...new Set(unique.flatMap((id) => cutList.get(id)?.references ?? []))].sort();
  }
  const statedLength = row.lengthMm === undefined || row.lengthMm === null
    ? null
    : wholeMm(row.lengthMm, "lengthMm");
  const lengths = applyLengths(cuts, statedLength, true);
  const quantity = quantityOf(row.quantity, `${label} quantity`);
  const flags = scopeOrderConfirmFlags(product, toConfirm, false);
  return {
    demandIds: unique,
    line: line({
      demand_id: unique.length === 1 ? unique[0] : unique.join("|"),
      product,
      product_unknown: flags.product_unknown,
      price_to_confirm: flags.price_to_confirm,
      description: descriptionOf(row.description, `${label} description`),
      quantity,
      unit: unitOf(row.unit),
      length_mm: lengths.length_mm,
      stock_length_mm: lengths.stock_length_mm,
      stock_qty: lengths.stock_length_mm === null ? null : quantity,
      cuts: lengths.cuts,
      element_refs: elementRefs,
      supplier_name: textOrNull(row.supplier, "supplier") ?? groupName,
    }),
  };
}

function positionalDemand(id: string): boolean {
  return id.split("|").every((part) => POSITIONAL_DEMAND_RE.test(part));
}

function stableHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a ^= code;
    a = Math.imul(a, 0x01000193);
    b ^= code;
    b = Math.imul(b, 0x01000193);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

function fitDemandId(body: string): string {
  const cleaned = body.replace(/[^A-Za-z0-9_.:|/+-]/g, "-");
  const id = /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `d${cleaned}`;
  if (DEMAND_ID_RE.test(id)) return id;
  return `h${stableHash(body)}`;
}

function materialDemandId(row: ScopeOrderLine): string {
  const refs = [...row.element_refs].sort().join(".");
  const product = (row.product ?? "noproduct").replace(/[^A-Za-z0-9_.:|/+-]/g, "-");
  const stock = row.stock_length_mm === null ? "nostock" : String(row.stock_length_mm);
  return fitDemandId(`${refs || "noref"}|${product}|${stock}`);
}

// createOrder numbers demands material-1, material-2, ... in document order.
// Those numbers move when the engine adds a line, so they are not the row
// key. The stable id is the elements, the product and the buy length.
function assignStableDemandIds(lines: ScopeOrderLine[]): void {
  const next = lines.map((row) => ({
    raw: row.demand_id,
    positional: positionalDemand(row.demand_id),
    id: positionalDemand(row.demand_id) ? materialDemandId(row) : row.demand_id,
  }));
  // A caller-supplied id is the row key. Naming it twice is one demand
  // written twice, so the parse throws and nothing is stored. The engine's
  // material-N numbers are not keys: one demand bought as two stock lengths
  // repeats material-N, and those rows separate by product and buy length.
  const callerCounts = new Map<string, number>();
  for (const item of next) {
    if (!item.positional) callerCounts.set(item.raw, (callerCounts.get(item.raw) ?? 0) + 1);
  }
  for (const [raw, count] of callerCounts) {
    if (count > 1) invalid(`demand ${raw} is repeated`);
  }
  const counts = new Map<string, number>();
  for (const item of next) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  const used = new Set<string>();
  for (const [index, row] of lines.entries()) {
    let id = next[index].id;
    if ((counts.get(id) ?? 0) > 1) {
      const cutKey = row.cuts.map((cut) => `${cut.length_mm}x${cut.qty}`).join(".");
      id = fitDemandId(`${id}|${cutKey || "nocut"}`);
    }
    if (used.has(id)) {
      const sameSource = next.slice(0, index).some((item) =>
        item.raw === next[index].raw && item.id === next[index].id
      );
      if (sameSource) invalid(`demand ${next[index].raw} is repeated`);
      const hashed = fitDemandId(`${id}|${stableHash(next[index].raw)}`);
      if (hashed === id || used.has(hashed)) invalid(`demand ${next[index].raw} is repeated`);
      id = hashed;
    }
    used.add(id);
    row.demand_id = id;
  }
}

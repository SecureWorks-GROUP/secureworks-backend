// Dispatch scope order lines, stage 1.
// Contract: docs/dispatch-scope-order-lines-v1.md.
//
// Turns a Scope Engine material order into lines attached to one job. The
// four accepted documents are the engine's own shapes: a strict
// scope-engine-order/v1 list, a supplier-order/v1 order, a Demand list, and
// a scope-engine-v2 job read as the members it states. Nothing here nests
// stock, picks a catalogue row, matches a supplier contact, prices a line,
// or sends.

export const SCOPE_ORDER_LINE_MAX = 500;
export const SCOPE_ORDER_DESCRIPTION_MAX = 300;
export const SCOPE_ORDER_UNIT_MAX = 30;
export const SCOPE_ORDER_QUANTITY_MAX = 999_999_999.999;
export const SCOPE_ORDER_TEXT_MAX = 200;
export const SCOPE_ORDER_LENGTH_MM_MAX = 100_000;
export const SCOPE_ORDER_CUT_MAX = 40;

const DEMAND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:|/+-]{0,199}$/;

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

export type ScopeOrderLine = {
  demand_id: string;
  product: string | null;
  product_unknown: boolean;
  description: string;
  quantity: number | null;
  unit: string | null;
  length_mm: number | null;
  cut_size: string | null;
  cuts: ScopeOrderCut[];
  supplier_name: string | null;
};

export type ParsedScopeOrder = {
  lines: ScopeOrderLine[];
  withheld_demand_ids: string[];
};

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
  if (record.schema === "scope-engine-v2/job@1") return finish(parseJob(record), []);
  invalid(
    "order schema was not recognised. Send scope-engine-order/v1, supplier-order/v1, a demand list, or a scope-engine-v2 job",
  );
}

export function formatScopeOrderLine(line: ScopeOrderLine): string {
  const product = line.product_unknown
    ? (line.product ? `to confirm (${line.product})` : "to confirm")
    : (line.product ?? "to confirm");
  const qty = line.quantity === null
    ? "qty not stated"
    : `qty ${line.quantity}${line.unit ? " " + line.unit : ""}`;
  const length = line.length_mm === null
    ? "length not stated"
    : `length ${line.length_mm} mm`;
  const cut = line.cut_size ?? "cut not stated";
  const supplier = line.supplier_name ?? "supplier not stated";
  return `${line.demand_id} | ${product} | ${line.description} | ${qty} | ${length} | ${cut} | ${supplier}`;
}

function finish(
  lines: ScopeOrderLine[],
  withheld: string[],
): ParsedScopeOrder {
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
  if (value === null) return null;
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
  if (value.length > SCOPE_ORDER_CUT_MAX) {
    invalid(`a line can carry at most ${SCOPE_ORDER_CUT_MAX} cuts`);
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

function lengthFromCuts(cuts: ScopeOrderCut[], stated: number | null): number | null {
  if (cuts.length === 0) return stated;
  const distinct = new Set(cuts.map((cut) => cut.length_mm));
  if (distinct.size === 1) {
    const only = cuts[0].length_mm;
    if (stated !== null && stated !== only) {
      invalid("length_mm does not match the cut length");
    }
    return only;
  }
  if (stated !== null) invalid("length_mm must be null when the cuts differ");
  return null;
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
  description: string;
  quantity: number | null;
  unit: string | null;
  length_mm: number | null;
  cuts: ScopeOrderCut[];
  supplier_name: string | null;
}): ScopeOrderLine {
  const unknown = parts.product === null ? true : parts.product_unknown;
  return {
    demand_id: parts.demand_id,
    product: parts.product,
    product_unknown: unknown,
    description: parts.description,
    quantity: parts.quantity,
    unit: parts.unit,
    length_mm: parts.length_mm,
    cut_size: cutSize(parts.cuts),
    cuts: parts.cuts,
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
    const flagged = row.product_unknown === true || unresolved || toConfirm.length > 0;
    const statedLength = row.length_mm === undefined || row.length_mm === null
      ? null
      : wholeMm(row.length_mm, "length_mm");
    const cuts = cutsOf(row.cuts, "length_mm");
    return line({
      demand_id: demandId(row.demand_id, `line ${index + 1} demand_id`),
      product,
      product_unknown: flagged,
      description: descriptionOf(row.description, `line ${index + 1} description`),
      quantity: quantityOf(row.quantity, `line ${index + 1} quantity`),
      unit: unitOf(row.unit),
      length_mm: lengthFromCuts(cuts, statedLength),
      cuts,
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
  const cuts = cutsOf(row.cuts, "lengthMm");
  if (row.cuts !== undefined) {
    // A demand cut is lengthMm. Reject a strict length_mm key so the two
    // shapes cannot be mixed into a guessed length.
    for (const cut of row.cuts as unknown[]) {
      if (cut && typeof cut === "object" && "length_mm" in (cut as object)) {
        invalid("a demand cut uses lengthMm");
      }
    }
  }
  return line({
    demand_id: demandId(row.id ?? row.demand_id, `${label} id`),
    product,
    product_unknown: forceUnknown || toConfirm.length > 0,
    description: descriptionOf(row.description, `${label} description`),
    quantity: quantityOf(
      row.quantity === undefined ? null : row.quantity,
      `${label} quantity`,
    ),
    unit: unitOf(row.unit),
    length_mm: lengthFromCuts(cuts, null),
    cuts,
    supplier_name: null,
  });
}

function parseSupplierOrder(record: Record<string, unknown>): ParsedScopeOrder {
  if (!Array.isArray(record.suppliers)) invalid("suppliers must be a list");
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
      const built = supplierLine(raw, groupName, `supplier ${groupIndex + 1} line ${lineIndex + 1}`);
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
  const cuts = cutsOf(row.cuts, "lengthMm");
  const statedLength = row.lengthMm === undefined || row.lengthMm === null
    ? null
    : wholeMm(row.lengthMm, "lengthMm");
  return {
    demandIds: unique,
    line: line({
      demand_id: unique.length === 1 ? unique[0] : unique.join("|"),
      product,
      product_unknown: toConfirm.length > 0,
      description: descriptionOf(row.description, `${label} description`),
      quantity: quantityOf(
        row.quantity === undefined ? null : row.quantity,
        `${label} quantity`,
      ),
      unit: unitOf(row.unit),
      length_mm: lengthFromCuts(cuts, statedLength),
      cuts,
      supplier_name: textOrNull(row.supplier, "supplier") ?? groupName,
    }),
  };
}

const SKIPPED_JOB_KINDS = new Set(["roof-area"]);

function parseJob(record: Record<string, unknown>): ScopeOrderLine[] {
  if (!Array.isArray(record.elements)) invalid("elements must be a list");
  const lines: ScopeOrderLine[] = [];
  for (const [index, raw] of record.elements.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid(`element ${index + 1} must be an object`);
    }
    const element = raw as Record<string, unknown>;
    const kind = typeof element.kind === "string" ? element.kind : "";
    if (!kind) invalid(`element ${index + 1} must name its kind`);
    if (SKIPPED_JOB_KINDS.has(kind)) continue;
    const id = demandId(element.id, `element ${index + 1} id`);
    if (kind === "member") lines.push(memberLine(element, id));
    else if (kind === "member-set" || kind === "truss-set") {
      lines.push(setLine(element, id, kind));
    } else if (kind === "covering" || kind === "infill") {
      lines.push(productElementLine(element, id, kind, null));
    } else if (kind === "gutter") {
      lines.push(productElementLine(element, id, kind, null));
      lines.push(...downpipeLines(element, id));
    } else if (kind === "flashing") lines.push(flashingLine(element, id));
    else lines.push(unrecognisedKindLine(element, id, kind));
  }
  return lines;
}

function statedProduct(value: unknown): string | null {
  return textOrNull(value, "productKey");
}

function elementDescription(element: Record<string, unknown>, id: string, kind: string): string {
  const role = typeof element.role === "string" ? element.role.trim() : "";
  return descriptionOf(`${role || kind} ${id}`, "description");
}

function memberLine(element: Record<string, unknown>, id: string): ScopeOrderLine {
  const product = statedProduct(element.productKey);
  const length = planLengthMm(element, id);
  const cuts = length === null ? [] : [{ length_mm: length, qty: 1 }];
  return line({
    demand_id: id,
    product,
    product_unknown: false,
    description: elementDescription(element, id, "member"),
    quantity: 1,
    unit: "each",
    length_mm: length,
    cuts,
    supplier_name: null,
  });
}

function setLine(
  element: Record<string, unknown>,
  id: string,
  kind: string,
): ScopeOrderLine {
  return line({
    demand_id: id,
    product: statedProduct(element.productKey),
    product_unknown: false,
    description: elementDescription(element, id, kind),
    quantity: statedCount(element.layout, id),
    unit: "each",
    length_mm: null,
    cuts: [],
    supplier_name: null,
  });
}

function productElementLine(
  element: Record<string, unknown>,
  id: string,
  kind: string,
  quantity: number | null,
): ScopeOrderLine {
  return line({
    demand_id: id,
    product: statedProduct(element.productKey),
    product_unknown: false,
    description: elementDescription(element, id, kind),
    quantity,
    unit: null,
    length_mm: null,
    cuts: [],
    supplier_name: null,
  });
}

function flashingLine(element: Record<string, unknown>, id: string): ScopeOrderLine {
  const profile = typeof element.profile === "string" ? element.profile.trim() : "";
  const description = profile
    ? descriptionOf(`flashing ${id} (${profile})`, "description")
    : descriptionOf(`flashing ${id}`, "description");
  return line({
    demand_id: id,
    product: null,
    product_unknown: true,
    description,
    quantity: null,
    unit: null,
    length_mm: null,
    cuts: [],
    supplier_name: null,
  });
}

function unrecognisedKindLine(
  element: Record<string, unknown>,
  id: string,
  kind: string,
): ScopeOrderLine {
  return line({
    demand_id: id,
    product: statedProduct(element.productKey),
    product_unknown: true,
    description: elementDescription(element, id, kind),
    quantity: null,
    unit: null,
    length_mm: null,
    cuts: [],
    supplier_name: null,
  });
}

function downpipeLines(element: Record<string, unknown>, gutterId: string): ScopeOrderLine[] {
  if (element.downpipes === undefined) return [];
  if (!Array.isArray(element.downpipes)) invalid(`${gutterId} downpipes must be a list`);
  return element.downpipes.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid(`${gutterId} downpipe ${index + 1} must be an object`);
    }
    const pipe = raw as Record<string, unknown>;
    return line({
      demand_id: demandId(`${gutterId}:downpipe:${index}`, "downpipe id"),
      product: statedProduct(pipe.productKey),
      product_unknown: false,
      description: descriptionOf(`downpipe ${gutterId} ${index + 1}`, "description"),
      quantity: 1,
      unit: "each",
      length_mm: null,
      cuts: [],
      supplier_name: null,
    });
  });
}

function statedCount(layout: unknown, id: string): number | null {
  if (layout === undefined || layout === null) return null;
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
    invalid(`${id} layout must be an object`);
  }
  const record = layout as Record<string, unknown>;
  if ("count" in record) {
    const count = record.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      invalid(`${id} layout count must be a whole number`);
    }
    return count;
  }
  if ("offsetsMm" in record) {
    if (!Array.isArray(record.offsetsMm)) invalid(`${id} offsets must be a list`);
    for (const offset of record.offsetsMm) {
      if (typeof offset !== "number" || !Number.isFinite(offset)) {
        invalid(`${id} offsets must be numbers`);
      }
    }
    return record.offsetsMm.length;
  }
  return null;
}

function planLengthMm(element: Record<string, unknown>, id: string): number | null {
  if (element.from === undefined && element.to === undefined) return null;
  const from = element.from;
  const to = element.to;
  if (
    !Array.isArray(from) || !Array.isArray(to) || from.length < 2 || to.length < 2 ||
    [from[0], from[1], to[0], to[1]].some((value) =>
      typeof value !== "number" || !Number.isFinite(value)
    )
  ) {
    invalid(`${id} from and to must be coordinate pairs`);
  }
  return wholeMm(
    Math.round(Math.hypot(Number(to[0]) - Number(from[0]), Number(to[1]) - Number(from[1]))),
    `${id} length`,
  );
}

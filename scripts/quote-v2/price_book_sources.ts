// Quote v2, stage 1: extractors for the ten price stores listed in the quote
// design report (section 4). Pure functions over file TEXT: the CLI
// (price_book_import.ts) reads the files, these parse them. Nothing here
// touches a database or the network.
//
// Every observation says which store it came from and whether it is a COST
// (loaded into the price book), a LEGACY SELL rate (reported only: the owner
// ruled that cost is the primary value and a sell rate is never back-computed
// into a cost), a markup, a stock length list, or not a price at all.

export type Family = "fencing" | "patio" | "stratco" | "misc";

export type EvidenceKind =
  | "invoice"
  | "purchase_order"
  | "supplier_quote"
  | "supplier_estimate"
  | "price_list"
  | "owner_stated"
  | "tool_constant";

export type ObservationKind =
  | "cost"
  | "legacy_sell"
  | "markup"
  | "stock_lengths"
  | "not_a_price";

export type StoreId =
  | "s01_fence_cost_prices"
  | "s02_fence_sell_defaults"
  | "s03_fence_business_rules_dead"
  | "s04_fence_parity_seed_sql"
  | "s05_patio_hardcoded"
  | "s06_patio_device_cache"
  | "s07_patio_engine_snapshot"
  | "s08_scope_tool_defaults"
  | "s09_material_price_ledger"
  | "s10_wiki_supplier_csv";

export interface Observation {
  store: StoreId;
  kind: ObservationKind;
  /** The key as the source spells it. */
  source_key: string;
  description: string;
  family: Family;
  /** Unit of `value` as the source states it. */
  source_unit: string;
  /** Cost (or sell, for legacy_sell) in source_unit, ex GST. */
  value: number | null;
  supplier: string;
  supplier_code?: string;
  as_at: string | null;
  evidence_kind: EvidenceKind;
  evidence_ref: string;
  note?: string;
  stock_lengths_mm?: number[];
  /** Length in mm when the source prices one stock length ("each 6.5 m"). */
  per_length_mm?: number;
  /** Set when the observation must not be loaded, with the reason. */
  excluded_reason?: string;
  /** The source marks this row as awaiting blessing. */
  staged_for_blessing?: boolean;
  /** The source claims this value was blessed on a date (never trusted as a blessing). */
  claimed_blessed?: string;
}

export interface SourceRefs {
  fenceCommit: string;
  patioCommit: string;
  wikiCommit: string;
  backendCommit: string;
}

// ── small parsing helpers ───────────────────────────────────────────────

/** The text of a `const NAME = { ... };` object literal, braces balanced. */
export function objectLiteral(text: string, name: string): string | null {
  const start = text.search(new RegExp(`(?:const|var|let)\\s+${name}\\s*=\\s*\\{`));
  if (start < 0) return null;
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

interface Entry {
  key: string;
  value: number;
  comment: string;
}

/** `key: 12.5, // comment` and `'key': 12.5,` entries of a flat object literal. */
export function numericEntries(body: string): Entry[] {
  const out: Entry[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(
      /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*(-?\d+(?:\.\d+)?)\s*,?\s*(?:\/\/\s*(.*))?$/,
    );
    if (!m) continue;
    out.push({
      key: m[1] ?? m[2] ?? m[3],
      value: Number(m[4]),
      comment: (m[5] ?? "").trim(),
    });
  }
  return out;
}

/** `'key': [1, 2, 3],` entries. */
export function arrayEntries(body: string): { key: string; values: number[] }[] {
  const out: { key: string; values: number[] }[] = [];
  const re = /(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*\[([\d,\s]+)\]/g;
  for (const m of body.matchAll(re)) {
    out.push({
      key: m[1] ?? m[2] ?? m[3],
      values: m[4].split(",").map((v) => Number(v.trim())).filter((v) => v > 0),
    });
  }
  return out;
}

/** Minimal CSV (RFC 4180 quotes) to objects keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/** SQL VALUES tuples `('a','b',1.00,NULL,...)` into string-or-null cells. */
export function sqlTuples(text: string): (string | null)[][] {
  const out: (string | null)[][] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("(")) continue;
    const cells: (string | null)[] = [];
    let i = 1;
    while (i < t.length) {
      while (t[i] === " ") i++;
      if (t[i] === "'") {
        let s = "";
        i++;
        while (i < t.length) {
          if (t[i] === "'" && t[i + 1] === "'") {
            s += "'";
            i += 2;
          } else if (t[i] === "'") {
            i++;
            break;
          } else s += t[i++];
        }
        cells.push(s);
      } else {
        let j = i;
        while (j < t.length && t[j] !== "," && t[j] !== ")") j++;
        const raw = t.slice(i, j).trim();
        cells.push(raw.toUpperCase() === "NULL" ? null : raw);
        i = j;
      }
      while (t[i] === " ") i++;
      if (t[i] === ",") i++;
      else break;
    }
    if (cells.length >= 5) out.push(cells);
  }
  return out;
}

const DATE_RE = /(20\d\d-\d\d-\d\d)/;

// ── s01 fence COST_PRICES ───────────────────────────────────────────────

export const FENCE_COST_UNITS: Record<string, string> = {
  concrete: "bag",
  tekScrewBox: "box",
  removeHardie: "lm",
  removeTimberLap: "lm",
  removeColorbond: "lm",
  removeAsbestos: "lm",
  vegClear: "job",
  groundMulch: "lm",
  groundStones: "lm",
  groundTurf: "lm",
  labourPerMetre: "lm",
  delivery: "delivery",
};

export function fenceCostPrices(indexHtml: string, refs: SourceRefs): Observation[] {
  const body = objectLiteral(indexHtml, "COST_PRICES");
  if (!body) throw new Error("fence COST_PRICES not found");
  const header = indexHtml.slice(0, indexHtml.indexOf("const COST_PRICES"));
  const updated = header.slice(-400).match(/Updated (20\d\d-\d\d-\d\d)/)?.[1] ?? null;
  return numericEntries(body).map((e) => {
    const dated = e.comment.match(DATE_RE)?.[1];
    const blessed = e.comment.match(/blessed (20\d\d-\d\d-\d\d)/)?.[1];
    const estimated = /estimated/i.test(e.comment);
    return {
      store: "s01_fence_cost_prices",
      kind: "cost",
      source_key: e.key,
      description: e.comment || e.key,
      family: "fencing",
      source_unit: FENCE_COST_UNITS[e.key] ?? "each",
      value: e.value,
      supplier: /R&R/.test(e.comment) ? "R&R Fencing" : "unspecified",
      as_at: dated ?? updated,
      evidence_kind: "tool_constant",
      evidence_ref: `fence-designer index.html COST_PRICES.${e.key} @${refs.fenceCommit}`,
      note: estimated ? "the tool marks this estimated" : undefined,
      claimed_blessed: blessed,
    } satisfies Observation;
  });
}

// ── s02 fence sell defaults (legacy sell, reported only) ────────────────

const FENCE_SELL_UNITS: Record<string, string> = {
  pricePerMetre: "lm",
  hardiePrice: "lm",
  timberPrice: "lm",
  colorbondRemovalPrice: "lm",
  asbestosPrice: "lm",
  asbestosCertFee: "job",
  vegClearPrice: "job",
};

export function fenceSellDefaults(indexHtml: string, refs: SourceRefs): Observation[] {
  const seen = new Map<string, number>();
  const per = indexHtml.match(/job\.pricePerMetre\s*\|\|\s*(\d+(?:\.\d+)?)/);
  if (per) seen.set("pricePerMetre", Number(per[1]));
  for (const m of indexHtml.matchAll(/\bq\.(\w+)\s*\|\|\s*(\d+(?:\.\d+)?)/g)) {
    if (!seen.has(m[1])) seen.set(m[1], Number(m[2]));
  }
  return [...seen.entries()].map(([key, value]) => ({
    store: "s02_fence_sell_defaults",
    kind: "legacy_sell",
    source_key: key,
    description: key,
    family: "fencing",
    source_unit: FENCE_SELL_UNITS[key] ?? "each",
    value,
    supplier: "n/a",
    as_at: null,
    evidence_kind: "tool_constant",
    evidence_ref: `fence-designer index.html sell default ${key} @${refs.fenceCommit}`,
    note: "sell price the customer sees; never back-computed into a cost",
  }));
}

// ── s03 fence business_rules.js (dead, reported only) ───────────────────

export function fenceBusinessRules(js: string, refs: SourceRefs): Observation[] {
  const out: Observation[] = [];
  for (const [name, kind] of [["DEFAULT_RATES", "legacy_sell"], ["COST_PRICES", "cost"]] as const) {
    const body = objectLiteral(js, name);
    if (!body) continue;
    for (const e of numericEntries(body)) {
      out.push({
        store: "s03_fence_business_rules_dead",
        kind,
        source_key: `${name}.${e.key}`,
        description: e.comment || e.key,
        family: "fencing",
        source_unit: /_per_m2$/.test(e.key) ? "m2" : /_per_m$/.test(e.key) ? "lm" : "each",
        value: e.value,
        supplier: "unspecified",
        as_at: null,
        evidence_kind: "tool_constant",
        evidence_ref: `fence-designer business_rules.js ${name}.${e.key} @${refs.fenceCommit}`,
        excluded_reason: "dead store: business_rules.js is not loaded by the fence tool",
      });
    }
  }
  return out;
}

// ── s04 fence parity seed SQL (scope_tool_defaults seed, 2026-06-11) ────

const SEED_NOT_A_PRICE = new Set([
  "kwikset-std",
  "kwikset-deep",
]);

export function parseSeedRows(
  sql: string,
  store: StoreId,
  evidenceRef: (tool: string, key: string) => string,
  asAt: string,
): Observation[] {
  const out: Observation[] = [];
  for (const cells of sqlTuples(sql)) {
    // (scope_tool, category, item_key, description, unit, cost, sqm, price, code, source, notes)
    const [tool, category, key, description, unit, cost, , price, code, , notes] = cells;
    if (!tool || !key || !description || !unit) continue;
    const family: Family = tool === "fence-designer" ? "fencing" : "patio";
    const costN = cost == null ? null : Number(cost);
    const priceN = price == null ? null : Number(price);
    const base = {
      store,
      source_key: `${tool}:${category}:${key}`,
      description,
      family,
      source_unit: unit,
      supplier: /R&R/.test(notes ?? "") ? "R&R Fencing" : "unspecified",
      supplier_code: code ?? undefined,
      as_at: asAt,
      evidence_kind: "tool_constant" as const,
      evidence_ref: evidenceRef(tool, key),
      note: notes ?? undefined,
    };
    if (unit === "pct" || unit === "mm" || unit === "factor" || SEED_NOT_A_PRICE.has(key)) {
      out.push({
        ...base,
        kind: key === "default-sell-markup" ? "markup" : "not_a_price",
        value: costN,
        excluded_reason: key === "default-sell-markup"
          ? undefined
          : "not a price (a count, percentage or dimension)",
      });
      continue;
    }
    if (/-sell$/.test(key) || key === "price-per-metre-default" || (costN == null && priceN != null)) {
      out.push({ ...base, kind: "legacy_sell", value: priceN ?? costN });
      continue;
    }
    out.push({ ...base, kind: "cost", value: costN });
  }
  return out;
}

export function fenceParitySeed(sql: string, refs: SourceRefs): Observation[] {
  const tag = sql.match(/seed-from-tool-hardcoded (20\d\d-\d\d-\d\d)/)?.[1] ?? "2026-06-11";
  return parseSeedRows(
    sql,
    "s04_fence_parity_seed_sql",
    (tool, key) => `fence-designer parity/seed_scope_tool_defaults.sql ${tool}/${key} @${refs.fenceCommit}`,
    tag,
  );
}

// ── s05 patio hardcoded tables ──────────────────────────────────────────

export function patioHardcoded(indexHtml: string, refs: SourceRefs): Observation[] {
  const version = indexHtml.match(/RATES_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const asAt = version?.match(DATE_RE)?.[1] ?? "2026-06-13";
  const ref = (table: string, key: string) =>
    `patio-tool index.html ${table}['${key}'] @${refs.patioCommit}`;
  const out: Observation[] = [];

  const rates = objectLiteral(indexHtml, "DEFAULT_RATES");
  if (!rates) throw new Error("patio DEFAULT_RATES not found");
  for (const e of numericEntries(rates)) {
    const unit = /\(sqm\)|\(\$\/sqm\)/.test(e.key)
      ? "m2"
      : /\(ea\)/.test(e.key)
      ? "each"
      : /\(bag\)/.test(e.key)
      ? "bag"
      : /\(LM\)/.test(e.key)
      ? "lm"
      : /^(Skilled Trade|Labourer|Electrician)$/.test(e.key)
      ? "day"
      : "lm";
    out.push({
      store: "s05_patio_hardcoded",
      kind: "cost",
      source_key: `DEFAULT_RATES.${e.key}`,
      description: e.key,
      family: "patio",
      source_unit: unit,
      value: e.value,
      supplier: "unspecified",
      as_at: e.comment.match(DATE_RE)?.[1] ?? asAt,
      evidence_kind: "tool_constant",
      evidence_ref: ref("DEFAULT_RATES", e.key),
      note: e.comment || undefined,
      claimed_blessed: e.comment.match(/blessed (20\d\d-\d\d-\d\d)/)?.[1],
    });
  }

  const steel = objectLiteral(indexHtml, "STEEL_RATES");
  for (const e of numericEntries(steel ?? "")) {
    out.push({
      store: "s05_patio_hardcoded",
      kind: "cost",
      source_key: `STEEL_RATES.${e.key}`,
      description: `${e.key} steel`,
      family: "patio",
      source_unit: "lm",
      value: e.value,
      supplier: "unspecified",
      as_at: e.comment.match(DATE_RE)?.[1] ?? asAt,
      evidence_kind: "tool_constant",
      evidence_ref: ref("STEEL_RATES", e.key),
      note: e.comment || undefined,
    });
  }

  const riser = objectLiteral(indexHtml, "RISER_PRICES");
  for (const e of numericEntries(riser ?? "")) {
    out.push({
      store: "s05_patio_hardcoded",
      kind: "cost",
      source_key: `RISER_PRICES.${e.key}`,
      description: `Riser ${e.key}`,
      family: "patio",
      source_unit: "each",
      value: e.value,
      supplier: "unspecified",
      as_at: asAt,
      evidence_kind: "tool_constant",
      evidence_ref: ref("RISER_PRICES", e.key),
    });
  }

  const stock = objectLiteral(indexHtml, "STEEL_STOCK_LENGTHS_BY_SIZE");
  for (const e of arrayEntries(stock ?? "")) {
    out.push({
      store: "s05_patio_hardcoded",
      kind: "stock_lengths",
      source_key: `STEEL_STOCK_LENGTHS_BY_SIZE.${e.key}`,
      description: `${e.key} stock lengths`,
      family: "patio",
      source_unit: "mm",
      value: null,
      supplier: "unspecified",
      as_at: asAt,
      evidence_kind: "tool_constant",
      evidence_ref: ref("STEEL_STOCK_LENGTHS_BY_SIZE", e.key),
      note: "the tool notes these as invoice-verified",
      stock_lengths_mm: [...new Set(e.values)].sort((a, b) => a - b),
    });
  }

  const waste = objectLiteral(indexHtml, "STOCK_LENGTH_WASTE_CONFIG") ?? "";
  for (const m of waste.matchAll(/'([\w-]+)':\s*\{\s*stock_lengths_mm:\s*(null|\[[\d,\s]+\])/g)) {
    const lengths = m[2] === "null"
      ? null
      : m[2].slice(1, -1).split(",").map((v) => Number(v.trim())).filter((v) => v > 0);
    out.push({
      store: "s05_patio_hardcoded",
      kind: "stock_lengths",
      source_key: `STOCK_LENGTH_WASTE_CONFIG.${m[1]}`,
      description: `${m[1]} ${lengths ? "stock lengths" : "cut to length by the supplier"}`,
      family: "patio",
      source_unit: "mm",
      value: null,
      supplier: "unspecified",
      as_at: asAt,
      evidence_kind: "tool_constant",
      evidence_ref: ref("STOCK_LENGTH_WASTE_CONFIG", m[1]),
      stock_lengths_mm: lengths ?? undefined,
      note: lengths ? undefined : "cut_to_size",
    });
  }

  const markup = indexHtml.match(/DEFAULT_SELL_MARKUP\s*=\s*(\d+(?:\.\d+)?)/);
  if (markup) {
    out.push({
      store: "s05_patio_hardcoded",
      kind: "markup",
      source_key: "DEFAULT_SELL_MARKUP",
      description: "Patio default sell markup",
      family: "patio",
      source_unit: "factor",
      value: Number(markup[1]),
      supplier: "n/a",
      as_at: asAt,
      evidence_kind: "tool_constant",
      evidence_ref: `patio-tool index.html DEFAULT_SELL_MARKUP @${refs.patioCommit}`,
    });
  }
  return out;
}

// ── s06 patio per-device browser cache ──────────────────────────────────

export function patioDeviceCache(): Observation[] {
  // Stored in each iPad's browser (localStorage `patioRates`). No server copy
  // exists, so nothing can be read or loaded. Reported as not observed.
  return [];
}

// ── s07 patio engine/v1 rate snapshot (unused by the live tool) ─────────

export function patioEngineSnapshot(ts: string, refs: SourceRefs): Observation[] {
  const effective = ts.match(/CONFIRMED_EFFECTIVE\s*=\s*"(20\d\d-\d\d-\d\d)"/)?.[1] ?? "2026-08-10";
  const out: Observation[] = [];
  for (const m of ts.matchAll(/\["([^"]+)",\s*(\d+),\s*"([a-z]+)"\]/g)) {
    const [, key, cents, unit] = m;
    const sell = /-sell$/.test(key);
    out.push({
      store: "s07_patio_engine_snapshot",
      kind: sell ? "legacy_sell" : "cost",
      source_key: key,
      description: key,
      family: "patio",
      source_unit: unit === "sqm" ? "m2" : unit,
      value: Number(cents) / 100,
      supplier: "unspecified",
      as_at: effective,
      evidence_kind: "owner_stated",
      evidence_ref: `patio-tool engine/v1/rate-snapshot.ts ${key} @${refs.patioCommit}`,
      note: "owner-confirmed 2026-08-10; the live patio tool does not read this engine",
    });
  }
  return out;
}

/** Policy scalars in engine/v1/pricing-model.ts: the confirmed 1.5 markup. */
export function patioEnginePolicy(pricingModelTs: string, refs: SourceRefs): Observation[] {
  const m = pricingModelTs.match(/materialMarkup:\s*(\d+(?:\.\d+)?)\s*,/);
  if (!m) return [];
  return [{
    store: "s07_patio_engine_snapshot",
    kind: "markup",
    source_key: "materialMarkup",
    description: "Patio engine per-line material markup",
    family: "patio",
    source_unit: "factor",
    value: Number(m[1]),
    supplier: "n/a",
    as_at: "2026-08-10",
    evidence_kind: "owner_stated",
    evidence_ref: `patio-tool engine/v1/pricing-model.ts materialMarkup @${refs.patioCommit}`,
    note: "confirmed 2026-08-10 in the engine; the live patio tool does not use the engine",
  }];
}

// ── s08 scope_tool_defaults (live table; repo seed only) ────────────────

export function scopeToolDefaultsRepoSeed(migrationSql: string, refs: SourceRefs): Observation[] {
  const out: Observation[] = [];
  for (const cells of sqlTuples(migrationSql)) {
    // (category, item_key, description, unit, cost, sqm, source)
    const [category, key, description, unit, cost] = cells;
    if (category !== "roofing" || !key || !description || !unit) continue;
    out.push({
      store: "s08_scope_tool_defaults",
      kind: "cost",
      source_key: `roofing:${key}`,
      description,
      family: "patio",
      source_unit: unit,
      value: cost == null ? null : Number(cost),
      supplier: "unspecified",
      as_at: "2026-03-20",
      evidence_kind: "tool_constant",
      evidence_ref: `secureworks-backend supabase/migrations/20260320000006_scope_tool_defaults.sql ${key} @${refs.backendCommit}`,
      note: "repo seed only; the live table's current rows were not read",
    });
  }
  return out;
}

// ── s09 material_price_ledger (live; optional operator export) ──────────

export function materialPriceLedger(
  rows: Record<string, unknown>[] | null,
): Observation[] {
  if (!rows) return [];
  return rows
    .filter((r) => r.status === "confirmed")
    .map((r) => ({
      store: "s09_material_price_ledger" as const,
      kind: "cost" as const,
      source_key: String(r.material_code ?? r.item_description ?? ""),
      description: String(r.item_description ?? ""),
      family: String(r.material_category ?? "").includes("fenc") ? "fencing" : "patio",
      source_unit: String(r.unit ?? "each"),
      value: r.unit_price == null ? null : Number(r.unit_price),
      supplier: String(r.supplier_name ?? "unspecified"),
      supplier_code: r.material_code ? String(r.material_code) : undefined,
      as_at: String(r.confirmed_at ?? r.captured_at ?? "").slice(0, 10) || null,
      evidence_kind: "purchase_order" as const,
      evidence_ref: `material_price_ledger ${String(r.id ?? "")}`,
    }));
}

// ── s10 wiki supplier CSVs ──────────────────────────────────────────────

const DELIVERY_RE = /^DELIVERY|FREIGHT/i;

export function wikiSupplierCsv(
  fileName: string,
  text: string,
  refs: SourceRefs,
): Observation[] {
  const rows = parseCsv(text);
  const stratcoFamily = fileName.startsWith("stratco");
  return rows.map((r) => {
    const rawDesc = r.item_description ?? "";
    const unitRaw = (r.unit ?? "").trim();
    const value = Number(r.unit_cost_ex_gst);
    const lengthM = unitRaw.match(/\((\d+(?:\.\d+)?)m (?:length|sheet)\)/i)?.[1];
    const isDelivery = DELIVERY_RE.test(rawDesc);
    // Delivery lines on supplier invoices carry client street addresses: the
    // description is replaced, never copied.
    const description = isDelivery
      ? `${r.supplier} delivery (address withheld)`
      : rawDesc.replace(/\s+/g, " ").trim();
    let excluded: string | undefined;
    if (unitRaw === "line") excluded = "compound invoice line (several items in one amount)";
    else if (/CUSTOM MADE|LABOUR AND MATERIAL|SWAP upcharge|refer to invoice/i.test(rawDesc)) {
      excluded = "one-off job line, not a catalogue item";
    } else if (/never price/i.test(r.notes ?? "") && /group S|form-S/i.test(`${rawDesc} ${r.invoice_ref}`)) {
      excluded = "the source says never price from this form rate";
    }
    const stock = Number(r.stock_length_mm);
    return {
      store: "s10_wiki_supplier_csv",
      kind: "cost",
      source_key: r.item_key || `${fileName}:${rawDesc.slice(0, 60)}`,
      description,
      family: stratcoFamily ? "stratco" : /r?nr-fencing/.test(fileName) ? "fencing" : "patio",
      source_unit: lengthM ? "length" : unitRaw.toLowerCase(),
      value: Number.isFinite(value) ? value : null,
      supplier: r.supplier,
      supplier_code: r.supplier_sku || undefined,
      as_at: r.as_at || r.invoice_date || null,
      evidence_kind: /estimate|TB-WA-/i.test(`${r.basis} ${r.invoice_ref}`)
        ? "supplier_estimate"
        : /quot/i.test(r.invoice_ref ?? "")
        ? "supplier_quote"
        : /sales order/i.test(r.invoice_ref ?? "")
        ? "purchase_order"
        : "invoice",
      evidence_ref: `wiki research/supplier-pricing/${fileName} ${r.invoice_ref} @${refs.wikiCommit}`,
      note: r.confidence ? `confidence ${r.confidence}` : undefined,
      per_length_mm: lengthM ? Math.round(Number(lengthM) * 1000) : undefined,
      stock_lengths_mm: Number.isFinite(stock) && stock > 0 ? [stock] : undefined,
      staged_for_blessing: /STAGED FOR MARNIN BLESSING|unblessed/i.test(r.notes ?? "") ||
        (stratcoFamily && !r.blessed),
      excluded_reason: excluded,
    } satisfies Observation;
  });
}

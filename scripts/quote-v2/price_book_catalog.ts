// Quote v2, stage 1: which price book item an observation from one of the ten
// stores is about. The rules are explicit on purpose: an observation joins a
// canonical item only when its source names the same thing in the same unit
// (or a unit that converts exactly, such as one 6.5 m length to $/LM).
// Anything the rules cannot place gets its own item key under the
// `unreconciled` category, so it is still loaded and still shows in the diff
// report, but it is never merged into another item by a guess.

import type { Family, Observation } from "./price_book_sources.ts";

export type ItemUnit =
  | "lm"
  | "m2"
  | "each"
  | "bag"
  | "box"
  | "pack"
  | "kit"
  | "sheet"
  | "length"
  | "delivery"
  | "job"
  | "hour"
  | "day";

export interface CanonicalItem {
  item_key: string;
  family: Family;
  category: string;
  description: string;
  unit: ItemUnit;
  reconciled: boolean;
}

export type CutRule = "one_per_stick" | "nest" | "cut_to_size";

export interface Resolution {
  item: CanonicalItem;
  /** Value in the item's unit, or null for a $0 sentinel / missing value. */
  value: number | null;
  conversion?: string;
  /** The stock length this price was for, when the source priced one. */
  per_length_mm?: number;
}

// ── units ───────────────────────────────────────────────────────────────

export function normaliseUnit(raw: string): ItemUnit | null {
  const u = raw.trim().toLowerCase();
  if (["lm", "m", "mtr", "metre", "per lm"].includes(u)) return "lm";
  if (["m2", "sqm", "m²"].includes(u)) return "m2";
  if (["each", "ea", "hole"].includes(u) || u.startsWith("ea ") && !u.includes("bag")) return "each";
  if (u === "bag" || u === "ea (bag)") return "bag";
  if (u === "box") return "box";
  if (u === "pack") return "pack";
  if (u === "kit") return "kit";
  if (u === "sheet") return "sheet";
  if (u === "length") return "length";
  if (u === "delivery" || u === "per delivery") return "delivery";
  if (u === "job" || u === "lot") return "job";
  if (u === "hour" || u === "hr") return "hour";
  if (u === "day") return "day";
  return null;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[×]/g, "x")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/\.(?![0-9])|(?<![0-9])\./g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .replace(/[-.]+$/, "");
}

// ── canonical items with more than one source ───────────────────────────

const ITEMS: Record<string, Omit<CanonicalItem, "item_key" | "reconciled">> = {};
function def(key: string, family: Family, category: string, unit: ItemUnit, description: string) {
  ITEMS[key] = { family, category, unit, description };
}

// Patio flashings, gutters and drainage.
def("flashing-ridge-cap", "patio", "flashing", "lm", "Ridge cap flashing (family rate)");
def("flashing-barge", "patio", "flashing", "lm", "Barge flashing (family rate)");
def("flashing-back", "patio", "flashing", "lm", "Back flashing (family rate)");
def("flashing-gutter", "patio", "flashing", "lm", "Gutter flashing (family rate)");
def("flashing-hip", "patio", "flashing", "lm", "Hip flashing (family rate)");
def("gutter-patio", "patio", "gutter", "lm", "Patio gutter");
def("gutter-box", "patio", "gutter", "lm", "Box gutter");
def("downpipe-95x45", "patio", "gutter", "lm", "Downpipe 95x45");
def("downpipe-clip-95x45", "patio", "gutter", "each", "Downpipe clip 95x45");
def("downpipe-outlet-95x45", "patio", "gutter", "each", "Downpipe outlet (pop) 95x45");
def("gutter-stop-end-patio", "patio", "gutter", "each", "Patio gutter stop end");
def("gutter-clip-universal", "patio", "gutter", "each", "Gutter clip (universal)");
def("infill-twinwall-10mm-700", "patio", "infill", "lm", "Twinwall polycarbonate infill 10 mm x 700");
def("infill-twinwall-10mm-1050", "patio", "infill", "lm", "Twinwall polycarbonate infill 10 mm x 1050");
def("roof-ampelite-solasafe-5rib", "patio", "roofing", "lm", "Ampelite Solasafe 5-rib polycarbonate");
def("riser-100x50", "patio", "riser", "each", "Riser 100x50");
def("riser-76x38", "patio", "riser", "each", "Riser 76x38");
def("riser-75x50", "patio", "riser", "each", "Riser 75x50");
def("bracket-riser", "patio", "bracket", "each", "Riser bracket");
def("bracket-rafter", "patio", "bracket", "each", "Rafter bracket");
def("bracket-tubing", "patio", "bracket", "each", "Tubing bracket");
def("truss-fabrication", "patio", "truss", "lm", "Gable truss fabrication per metre of truss width");
def("truss-steel-76x38", "patio", "truss", "lm", "Gable truss steel 76x38 per metre");
def("gable-truss-average", "patio", "truss", "each", "Gable truss, average standard truss");
def("labour-trade", "patio", "labour", "hour", "Trade labour (cost to us)");
def("labour-labourer", "patio", "labour", "hour", "Labourer (cost to us)");
def("labour-roof-plumber", "patio", "labour", "day", "Roof plumber day (cost to us)");
def("labour-trade-day", "patio", "labour", "day", "Skilled trade day (cost to us)");
def("labour-labourer-day", "patio", "labour", "day", "Labourer day (cost to us)");
def("labour-electrician-day", "patio", "labour", "day", "Electrician day (cost to us)");
def("patio-delivery", "patio", "services", "job", "Patio delivery");
def("purlin-c150", "patio", "steel", "lm", "C150 purlin");
def("purlin-c200", "patio", "steel", "lm", "C200 purlin");
// Shared consumable.
def("concrete-kwikset-20kg", "misc", "concrete", "bag", "Kwikset rapid set concrete 20 kg bag");
// Fencing.
def("fence-panel-kit-h1800-w2380-post2400", "fencing", "panel", "each", "Colorbond panel H1800 x W2380 with 2400 posts");
def("fence-panel-kit-h1800-w3150-post3000", "fencing", "panel", "each", "Colorbond panel H1800 x W3150 with 3000 posts");
def("fence-post-shs-50x50x1.6-l2400", "fencing", "post", "each", "SHS post 50x50x1.6 L2400");
def("fence-post-shs-50x50x1.6-l2700", "fencing", "post", "each", "SHS post 50x50x1.6 L2700");
def("fence-post-shs-90x90x3.0-l1800", "fencing", "post", "each", "SHS post 90x90x3.0 L1800 (gate/corner)");
def("fence-plinth-std-w2380", "fencing", "plinth", "each", "Retaining plinth standard W2380");
def("fence-plinth-long-w3150", "fencing", "plinth", "each", "Retaining plinth long W3150");
def("fence-plinth-install", "fencing", "labour", "each", "Plinth install labour");
def("fence-labour-per-metre", "fencing", "labour", "lm", "Fence install labour per metre");
def("fence-gate-kit-pedestrian", "fencing", "gate", "each", "Pedestrian gate kit");
def("fence-gate-kit-double", "fencing", "gate", "each", "Double swing gate kit");
def("fence-gate-post-90x90", "fencing", "gate", "each", "Gate post 90x90");
def("fence-gate-labour-pedestrian", "fencing", "labour", "each", "Pedestrian gate install labour");
def("fence-gate-labour-double", "fencing", "labour", "each", "Double gate install labour");
def("fence-patio-tube-76x38-l3000", "fencing", "extension", "each", "Patio tube 76x38 RHS L3000");
def("fence-tek-screws-box", "fencing", "consumable", "box", "Tek screws, box");
def("fence-remove-hardie", "fencing", "removal", "lm", "Remove Hardie fence per metre (cost)");
def("fence-remove-timber-lap", "fencing", "removal", "lm", "Remove timber lap fence per metre (cost)");
def("fence-remove-colorbond", "fencing", "removal", "lm", "Remove Colorbond fence per metre (cost)");
def("fence-remove-asbestos", "fencing", "removal", "lm", "Remove asbestos fence per metre (cost)");
def("fence-veg-clear", "fencing", "site", "job", "Vegetation / site clear (cost)");
def("fence-delivery-rr", "fencing", "delivery", "delivery", "R&R Fencing delivery");

// Tool key -> canonical, from the fence tool's own FENCE_COST_MAP (tool
// COST_PRICES key -> seed item key). Panel kits are mapped only where a
// source states the panel width; the rest stay unreconciled.
const FENCE_TOOL_KEYS: Record<string, string> = {
  panelKit1800_2400: "fence-panel-kit-h1800-w2380-post2400",
  panelKit1800_3000: "fence-panel-kit-h1800-w3150-post3000",
  shsPost50_2400: "fence-post-shs-50x50x1.6-l2400",
  shsPost50_2700: "fence-post-shs-50x50x1.6-l2700",
  shsPost90_1800: "fence-post-shs-90x90x3.0-l1800",
  plinth: "fence-plinth-std-w2380",
  plinthLong: "fence-plinth-long-w3150",
  plinthInstall: "fence-plinth-install",
  labourPerMetre: "fence-labour-per-metre",
  gateKitPedestrian: "fence-gate-kit-pedestrian",
  gateKitDouble: "fence-gate-kit-double",
  gatePost90x90: "fence-gate-post-90x90",
  gateLabourPedestrian: "fence-gate-labour-pedestrian",
  gateLabourDouble: "fence-gate-labour-double",
  patioTube: "fence-patio-tube-76x38-l3000",
  concrete: "concrete-kwikset-20kg",
  tekScrewBox: "fence-tek-screws-box",
  removeHardie: "fence-remove-hardie",
  removeTimberLap: "fence-remove-timber-lap",
  removeColorbond: "fence-remove-colorbond",
  removeAsbestos: "fence-remove-asbestos",
  vegClear: "fence-veg-clear",
  delivery: "fence-delivery-rr",
};

const FENCE_SEED_KEYS: Record<string, string> = {
  "panel-kit-1800-2400": "fence-panel-kit-h1800-w2380-post2400",
  "panel-kit-1800-3000": "fence-panel-kit-h1800-w3150-post3000",
  "shs-post-50x50x1.6-l2400": "fence-post-shs-50x50x1.6-l2400",
  "shs-post-50x50x1.6-l2700": "fence-post-shs-50x50x1.6-l2700",
  "shs-post-90x90x3.0-l1800": "fence-post-shs-90x90x3.0-l1800",
  "plinth-cost": "fence-plinth-std-w2380",
  "plinth-cost-long": "fence-plinth-long-w3150",
  "plinth-install": "fence-plinth-install",
  "base-labour": "fence-labour-per-metre",
  "gate-kit-pedestrian": "fence-gate-kit-pedestrian",
  "gate-kit-double": "fence-gate-kit-double",
  "gate-post-90x90": "fence-gate-post-90x90",
  "gate-labour-pedestrian": "fence-gate-labour-pedestrian",
  "gate-labour-double": "fence-gate-labour-double",
  "patio-tube-76x38": "fence-patio-tube-76x38-l3000",
  "concrete-bag": "concrete-kwikset-20kg",
  "tek-screw-box": "fence-tek-screws-box",
  "remove-hardie-cost": "fence-remove-hardie",
  "remove-timber-cost": "fence-remove-timber-lap",
  "remove-colorbond-cost": "fence-remove-colorbond",
  "remove-asbestos-cost": "fence-remove-asbestos",
  "veg-clear-cost": "fence-veg-clear",
  "delivery-cost": "fence-delivery-rr",
};

const PATIO_NAMED: Record<string, string> = {
  "ridge cap": "flashing-ridge-cap",
  "ridge-cap": "flashing-ridge-cap",
  "barge flashing": "flashing-barge",
  "barge-flashing": "flashing-barge",
  "back flashing": "flashing-back",
  "back-flashing": "flashing-back",
  "gutter flashing": "flashing-gutter",
  "gutter-flashing": "flashing-gutter",
  "hip flashing": "flashing-hip",
  "patio gutter": "gutter-patio",
  "patio-gutter": "gutter-patio",
  "box gutter": "gutter-box",
  "box-gutter": "gutter-box",
  "downpipe 95x45": "downpipe-95x45",
  "downpipe-95x45": "downpipe-95x45",
  "downpipe clip (ea)": "downpipe-clip-95x45",
  "downpipe outlet (ea)": "downpipe-outlet-95x45",
  "gutter downpipe pop (ea)": "downpipe-outlet-95x45",
  "gutter stop end (ea)": "gutter-stop-end-patio",
  "gutter clip (ea)": "gutter-clip-universal",
  "infil panel twinwall 700mm": "infill-twinwall-10mm-700",
  "infill-twinwall-700": "infill-twinwall-10mm-700",
  "infil panel twinwall 1050mm": "infill-twinwall-10mm-1050",
  "infill-twinwall-1050": "infill-twinwall-10mm-1050",
  "ampelite solasafe 5-rib": "roof-ampelite-solasafe-5rib",
  "default-ampelite-solasafe-5rib": "roof-ampelite-solasafe-5rib",
  "riser 100x50 (ea)": "riser-100x50",
  "riser-100x50": "riser-100x50",
  "riser:100x50": "riser-100x50",
  "100x50x2": "riser-100x50",
  "riser 76x38 (ea)": "riser-76x38",
  "riser-76x38": "riser-76x38",
  "riser:76x38": "riser-76x38",
  "76x38x1.6": "riser-76x38",
  "riser 75x50 (ea)": "riser-75x50",
  "riser-75x50": "riser-75x50",
  "riser:75x50": "riser-75x50",
  "75x50x2": "riser-75x50",
  "riser bracket (ea)": "bracket-riser",
  "riser-bracket": "bracket-riser",
  "rafter bracket (ea)": "bracket-rafter",
  "rafter-bracket": "bracket-rafter",
  "tubing bracket (ea)": "bracket-tubing",
  "tubing-bracket": "bracket-tubing",
  "truss-fabrication": "truss-fabrication",
  "gable-truss-fab": "truss-fabrication",
  "truss-steel-lm": "truss-steel-76x38",
  "gable-truss-steel": "truss-steel-76x38",
  "gable truss average (ea)": "gable-truss-average",
  "gable-truss-average": "gable-truss-average",
  "labour-trade-cost": "labour-trade",
  "labour-labourer-cost": "labour-labourer",
  "roof-plumber-day": "labour-roof-plumber",
  "skilled trade": "labour-trade-day",
  "skilled-trade": "labour-trade-day",
  "labourer": "labour-labourer-day",
  "electrician": "labour-electrician-day",
  "concrete kwikset (bag)": "concrete-kwikset-20kg",
  "concrete-kwikset": "concrete-kwikset-20kg",
  "kwikset-bag": "concrete-kwikset-20kg",
  "delivery": "patio-delivery",
  "c150 purlin": "purlin-c150",
  "purlin-c150": "purlin-c150",
  "c200 purlin": "purlin-c200",
  "purlin-c200": "purlin-c200",
};

const ROOF_ALIASES: Record<string, string> = {
  trimdekcolorbond: "trimdek",
  corrugatedcolorbond: "corrugated",
  spandekcolorbond: "spandek",
};

// ── steel ───────────────────────────────────────────────────────────────

export function steelKey(text: string): string | null {
  const m = text.replace(/×/g, "x").match(/(\d+)\s*x\s*(\d+)\s*x\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const [, a, b, t] = m;
  const type = a === b ? "shs" : "rhs";
  return `steel-${type}-${a}x${b}x${t}`;
}

/** Posts and beams are cut one per stick; the rest nest (patio nestCuts use). */
export function steelCutRule(key: string): CutRule {
  return /^steel-(shs-90x90|rhs-100x50|rhs-150x50)/.test(key) ? "one_per_stick" : "nest";
}

function steelItem(key: string): CanonicalItem {
  const [, type, size] = key.match(/^steel-(shs|rhs)-(.+)$/)!;
  return {
    item_key: key,
    family: "patio",
    category: "steel",
    description: `${size} ${type.toUpperCase()} steel`,
    unit: "lm",
    reconciled: true,
  };
}

function canonical(key: string): CanonicalItem {
  const d = ITEMS[key];
  if (!d) throw new Error(`catalog: no canonical item ${key}`);
  return { item_key: key, ...d, reconciled: true };
}

function unreconciled(o: Observation, unit: ItemUnit): CanonicalItem {
  // Tool keys name the thing; supplier lines are named by their description.
  const name = o.store === "s10_wiki_supplier_csv" || o.store === "s09_material_price_ledger"
    ? o.description
    : o.source_key.split(/[:.]/).pop()!.replace(/([a-z])([A-Z0-9])/g, "$1-$2");
  return {
    item_key: `${o.family}-${slug(name || o.description)}`.slice(0, 110),
    family: o.family,
    category: "unreconciled",
    description: o.description.slice(0, 200),
    unit,
    reconciled: false,
  };
}

// ── conversions ─────────────────────────────────────────────────────────

/** Lengths in a description: "- 1800mm", "1.8m length". */
function lengthFromDescription(text: string): number | null {
  const mm = text.match(/(?:^|[^x\d])(\d{4})\s*mm\b/i);
  if (mm) return Number(mm[1]);
  const m = text.match(/(\d+(?:\.\d+)?)\s*m (?:length|sheet)/i);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

function convert(
  o: Observation,
  item: CanonicalItem,
): { value: number | null; conversion?: string; per_length_mm?: number } | null {
  if (o.value == null || o.value === 0) return { value: null };
  const from = normaliseUnit(o.source_unit);
  if (from === item.unit) return { value: o.value };
  if (item.unit === "delivery" && (from === "job" || from === "each")) return { value: o.value };
  if (item.unit === "bag" && from === "each" && /\bBAG\b/i.test(o.description)) return { value: o.value };
  if (item.unit === "lm" && (from === "length" || from === "each" || from === "sheet")) {
    const mm = o.per_length_mm ?? lengthFromDescription(o.description);
    if (!mm) return null;
    const perLm = Math.round((o.value / (mm / 1000)) * 10000) / 10000;
    return {
      value: perLm,
      per_length_mm: mm,
      conversion: `$${o.value.toFixed(2)} per ${(mm / 1000).toFixed(mm % 100 ? 2 : 1)} m length = $${perLm.toFixed(2)}/LM`,
    };
  }
  return null;
}

// ── resolve one observation ─────────────────────────────────────────────

function resolveKey(o: Observation): CanonicalItem | null {
  const sk = o.source_key;
  switch (o.store) {
    case "s01_fence_cost_prices":
      return FENCE_TOOL_KEYS[sk] ? canonical(FENCE_TOOL_KEYS[sk]) : null;
    case "s08_scope_tool_defaults":
      return roofItem(sk.split(":")[1]);
    case "s04_fence_parity_seed_sql": {
      const [tool, category, key] = sk.split(":");
      if (tool === "fence-designer") {
        return FENCE_SEED_KEYS[key] ? canonical(FENCE_SEED_KEYS[key]) : null;
      }
      if (category === "steel" || /^(shs|rhs)-/.test(key)) {
        const s = steelKey(key);
        if (s) return steelItem(s);
      }
      const named = PATIO_NAMED[key];
      if (named) return canonical(named);
      if (category === "roofing" && !/^(infill|gable)-/.test(key)) return roofItem(key);
      return null;
    }
    case "s05_patio_hardcoded": {
      const [table, ...rest] = sk.split(".");
      const key = rest.join(".").replace(/×/g, "x");
      if (table === "STEEL_RATES" || table === "STEEL_STOCK_LENGTHS_BY_SIZE") {
        const s = steelKey(key);
        return s ? steelItem(s) : null;
      }
      if (table === "RISER_PRICES") return PATIO_NAMED[key] ? canonical(PATIO_NAMED[key]) : null;
      if (table === "STOCK_LENGTH_WASTE_CONFIG") {
        const map: Record<string, string> = {
          "downpipe-95x45": "downpipe-95x45",
          "patio-gutter": "gutter-patio",
          "box-gutter": "gutter-box",
        };
        return map[key] ? canonical(map[key]) : null;
      }
      if (table === "DEFAULT_RATES") {
        if (/ (SHS|RHS)$/.test(rest.join("."))) {
          const s = steelKey(key);
          return s ? steelItem(s) : null;
        }
        if (/^(solarspan|stratco cgi|spanplus|trimdek|corrugated|spandek|laserlite|ampelite)/i.test(key)) {
          return roofItem(key);
        }
        const named = PATIO_NAMED[key.toLowerCase()];
        return named ? canonical(named) : null;
      }
      return null;
    }
    case "s07_patio_engine_snapshot": {
      if (sk.startsWith("steel:")) {
        const s = steelKey(sk);
        return s ? steelItem(s) : null;
      }
      if (sk.startsWith("roofing:")) return roofItem(sk.split(":")[1]);
      const named = PATIO_NAMED[sk];
      return named ? canonical(named) : null;
    }
    case "s10_wiki_supplier_csv": {
      if (o.family === "stratco") {
        return {
          item_key: `stratco-${slug(sk)}`,
          family: "stratco",
          category: /gate/.test(sk) ? "gate" : /slat/.test(sk) ? "slat" : "frame",
          description: o.description,
          unit: normaliseUnit(o.source_unit) ?? "each",
          reconciled: true,
        };
      }
      if (o.supplier === "BD Metals" && /\b(RHS|SHS)\b/.test(o.description)) {
        const s = steelKey(o.description);
        return s ? steelItem(s) : null;
      }
      if (/DELIVERY|delivery \(address withheld\)/i.test(o.description) && /R&R/.test(o.supplier)) {
        return canonical("fence-delivery-rr");
      }
      if (/COLORBOND PANEL H(\d+)mm X W(\d+)mm (?:INC|WITH) (\d+)mm POSTS/i.test(o.description)) {
        const [, h, w, p] = o.description.match(/H(\d+)mm X W(\d+)mm (?:INC|WITH) (\d+)mm/i)!;
        const key = `fence-panel-kit-h${h}-w${w}-post${p}`;
        return ITEMS[key] ? canonical(key) : {
          item_key: key,
          family: "fencing",
          category: "panel",
          description: `Colorbond panel H${h} x W${w} with ${p} posts`,
          unit: "each",
          reconciled: true,
        };
      }
      if (/PLINTH/i.test(o.description) && /W2380/i.test(o.description)) return canonical("fence-plinth-std-w2380");
      if (/PLINTH/i.test(o.description) && /W3150/i.test(o.description)) return canonical("fence-plinth-long-w3150");
      if (/SHS POST 50 X 50.*L2400/i.test(o.description)) return canonical("fence-post-shs-50x50x1.6-l2400");
      if (/SHS POST 50 X 50.*L2700/i.test(o.description)) return canonical("fence-post-shs-50x50x1.6-l2700");
      if (/SHS POST 90 X 90.*L1800/i.test(o.description)) return canonical("fence-post-shs-90x90x3.0-l1800");
      if (/^CEMENT 20KG BAG ONLY- Rainproof Kwikset/i.test(o.description)) return canonical("concrete-kwikset-20kg");
      if (/PATIO GUTTER Surfmist|GU10/i.test(`${o.description}`) && !/STOP END/i.test(o.description)) {
        return canonical("gutter-patio");
      }
      if (/DOWNPIPE - 1800mm|DOWNPIPE 95x45 1\.8m/i.test(o.description)) return canonical("downpipe-95x45");
      if (/DOWNPIPE CLIP/i.test(o.description)) return canonical("downpipe-clip-95x45");
      if (/DOWNPIPE POP|DOWNPIPE OUTLET/i.test(o.description)) return canonical("downpipe-outlet-95x45");
      if (/PATIO GUTTER STOP END/i.test(o.description)) return canonical("gutter-stop-end-patio");
      if (/UNIVERSAL GUTTER CLIP/i.test(o.description)) return canonical("gutter-clip-universal");
      if (/TW-10-0700/i.test(o.description)) return canonical("infill-twinwall-10mm-700");
      if (/Solasafe .*5Rib/i.test(o.description)) return canonical("roof-ampelite-solasafe-5rib");
      const girth = flashingGirth(o);
      if (girth) {
        return {
          item_key: `flashing-girth-${girth.girth}-${girth.bends}-bend`,
          family: "patio",
          category: "flashing",
          description: `Flashing 0.55, ${girth.girth} mm girth, ${girth.bends} bend${girth.bends > 1 ? "s" : ""}`,
          unit: "lm",
          reconciled: true,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function roofItem(key: string): CanonicalItem {
  let s = key.toLowerCase().replace(/^default-/, "").replace(/mm$/, "").replace(/[^a-z0-9]/g, "");
  s = ROOF_ALIASES[s] ?? s;
  if (s === "ampelitesolasafe5rib") return canonical("roof-ampelite-solasafe-5rib");
  return {
    item_key: `roof-${s}`,
    family: "patio",
    category: "roofing",
    description: `Roof sheet ${s}`,
    unit: "lm",
    reconciled: true,
  };
}

/** Girth (mm) and bends from a flashing line, e.g. "FLASH 150 C WITH 2 B". */
export function flashingGirth(o: Observation): { girth: number; bends: number } | null {
  const cmi = o.description.match(/FLASH (\d+) C WITH (\d+) B/i);
  if (cmi) return { girth: Number(cmi[1]), bends: Number(cmi[2]) };
  const met = o.description.match(/(\d+)mm girth (\d+)-BEND FLASHING/i);
  if (met) return { girth: Number(met[1]), bends: Number(met[2]) };
  return null;
}

export function resolveObservation(o: Observation): Resolution | { unresolved: string } {
  const itemUnit = normaliseUnit(o.source_unit);
  const found = resolveKey(o);
  if (found) {
    const c = convert(o, found);
    if (c) return { item: found, ...c };
    // Same name, incompatible unit: keep it apart rather than mix units.
    const unit = itemUnit ?? "each";
    return {
      item: {
        ...found,
        item_key: `${found.item_key}-per-${unit}`,
        description: `${found.description} (per ${unit})`,
        unit,
        reconciled: false,
        category: "unreconciled",
      },
      value: o.value || null,
      conversion: `unit ${o.source_unit} does not convert to ${found.unit}`,
    };
  }
  if (!itemUnit) return { unresolved: `unit ${o.source_unit} is not a price book unit` };
  return { item: unreconciled(o, itemUnit), value: o.value || null };
}

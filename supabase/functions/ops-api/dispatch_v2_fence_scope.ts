// deno-lint-ignore-file no-explicit-any
// Dispatch v2: fill a fencing job's draft list from the fence scoping tool.
//
// The fence tool saves its scope as scope_json.job (runs, panels, gates,
// profile, colour). The older extractor only reads the patio tool's layout, so
// on a fence scope it found nothing. This reads the fence layout with the same
// rules the material ordering skill uses for Shaun's order emails
// (wiki harness/ops/skills/secureworks-material-ordering/references):
//
//   - panels grouped by panel height, post height, profile and colour:
//     "9 x 1800H standard width panels with 2400H posts";
//   - post height from the retaining height (1800H fencing only);
//   - plinths from the retaining height, one per 150mm per panel;
//   - each gate broken into posts, stiles, infill sheets, latch and rails.
//
// Quickset and fixings are not lines here: the order email adds them itself,
// on the main supplier's email only. Where the skill says to flag something
// (a long or short panel, a height outside the table, a gate with no type) it
// becomes a note for Shaun, never a guessed line.

export type DispatchV2FenceLine = {
  description: string;
  quantity: number;
  /** The sealed line's unit (else the one Shaun's table implies); null on a scope with no sealed lines. */
  unit: string | null;
  detail: string | null;
  profile: string | null;
  colour: string | null;
  /**
   * The sealed scope line it came from (scope_json.lines id, finish line B3); a sealed line split into parts names
   * each part "<id>#k/n". Null on a scope with no sealed lines, or when no sealed line matches (a note says so).
   */
  scope_line_id?: string | null;
  /**
   * The supplier the sealed order sends this line to (its sealed line's supplierId and supplierName). Null when the
   * line names no sealed line, or its sealed line names no supplier: the line is held on the draft list.
   */
  supplier_key?: string | null;
  supplier_name?: string | null;
};

export type DispatchV2FenceFill = {
  lines: DispatchV2FenceLine[];
  notes: string[];
  /**
   * True when the sealed order splits the lines by supplier (a sealed line names one). Each line then goes to its
   * own sealed line's supplier, line for line, and never to the scope's one typed supplier.
   */
  sealed_suppliers: boolean;
};

// 1800H fencing: retaining height (mm) to post height (mm).
const POST_HEIGHT_1800: Record<number, number> = {
  0: 2400,
  150: 2700,
  300: 2700,
  450: 3000,
  600: 3000,
};

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/\s+/g, " ").trim();
  return t || null;
}

function num(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// The fence tool's scope, or null when this is not one (a patio scope, an old
// free-text scope, nothing saved).
export function dispatchV2FenceScopeJob(scopeJson: unknown): any | null {
  let scope: any = scopeJson;
  if (typeof scope === "string") {
    try {
      scope = JSON.parse(scope);
    } catch {
      return null;
    }
  }
  const job = scope && typeof scope === "object" ? scope.job : null;
  if (!job || typeof job !== "object" || !Array.isArray(job.runs)) return null;
  return job;
}

export function dispatchV2FenceLinesFromScope(
  scopeJson: unknown,
): DispatchV2FenceFill | null {
  const job = dispatchV2FenceScopeJob(scopeJson);
  if (!job) return null;
  const profile = text(job.profile);
  const colour = text(job.colour);
  const lines: DispatchV2FenceLine[] = [];
  const notes: string[] = [];
  if (!profile) notes.push("The scope has no sheet profile. Add it to the panel line.");
  if (!colour) notes.push("The scope has no colour. Add it to the panel and plinth lines.");

  // Panels, grouped in the order they first appear.
  const groups = new Map<string, { height: number; post: number | null; count: number }>();
  const offTable = new Set<string>();
  const widths = new Map<string, number>();
  let plinths = 0;
  let unknownRetaining = 0;
  for (const run of job.runs) {
    const panels = Array.isArray(run?.panels) ? run.panels : [];
    for (const panel of panels) {
      const height = num(panel?.height) ?? num(run?.sheetHeight);
      if (height === null || height <= 0) {
        notes.push(`A panel in run ${text(run?.name) ?? "?"} has no height, so it is left out.`);
        continue;
      }
      const retaining = num(panel?.retaining) ?? 0;
      const post = height === 1800 && retaining in POST_HEIGHT_1800
        ? POST_HEIGHT_1800[retaining]
        : null;
      if (post === null) offTable.add(`${height}H panel with ${retaining}mm retaining`);
      const key = `${height}|${post}`;
      const group = groups.get(key) ?? { height, post, count: 0 };
      group.count += 1;
      groups.set(key, group);

      if (retaining > 0) {
        if (retaining % 150 === 0) plinths += retaining / 150;
        else unknownRetaining += 1;
      }
      const width = text(panel?.panelWidth) ?? "standard";
      if (width !== "standard") widths.set(width, (widths.get(width) ?? 0) + 1);
    }
  }
  // Where each line came from in Shaun's rules, for naming its sealed line below (never saved).
  const from = new Map<DispatchV2FenceLine, FenceLineFrom>();
  for (const group of groups.values()) {
    from.set(lines[lines.push({
      description: group.post === null
        ? `${group.height}H standard width panels, post height to confirm`
        : `${group.height}H standard width panels with ${group.post}H posts`,
      quantity: group.count,
      unit: null,
      detail: null,
      profile,
      colour,
    }) - 1], { kind: "panels", height: group.height, post: group.post });
  }
  for (const what of offTable) {
    notes.push(`No post height rule for a ${what}. Set the post height on the panel line.`);
  }
  for (const [width, count] of widths) {
    notes.push(
      `${plural(count, "panel is", "panels are")} marked ${width} width in the scope. Check the panel line with the supplier.`,
    );
  }
  if (plinths > 0) {
    from.set(lines[lines.push({
      description: "150mm standard width plinths",
      quantity: plinths,
      unit: null,
      detail: null,
      profile: null,
      colour,
    }) - 1], { kind: "plinths" });
  }
  if (unknownRetaining > 0) {
    notes.push(
      `${plural(unknownRetaining, "panel has", "panels have")} a retaining height that is not a multiple of 150mm, so its plinths are not counted.`,
    );
  }

  // Gates.
  const gates = Array.isArray(job.gates) ? job.gates : [];
  for (const [gateIndex, gate] of gates.entries()) {
    const type = text(gate?.type)?.toLowerCase() ?? null;
    const width = num(gate?.width);
    const height = num(gate?.height);
    if (type !== "pedestrian" && type !== "double") {
      notes.push(`A gate has no pedestrian or double type in the scope, so its parts are left out.`);
      continue;
    }
    if (width === null || height === null) {
      notes.push(`A ${type} gate has no width or height in the scope, so its parts are left out.`);
      continue;
    }
    const label = `Gate: ${type === "double" ? "Double" : "Pedestrian"} gate ${width}mm`;
    const double = type === "double";
    const part = (
      piece: GatePiece,
      description: string,
      quantity: number,
      detail: string | null,
      withProfile: boolean,
      withColour: boolean,
    ) =>
      from.set(lines[lines.push({
        description,
        quantity,
        unit: null,
        detail,
        profile: withProfile ? profile : null,
        colour: withColour ? colour : null,
      }) - 1], { kind: "gate", gate: gateIndex + 1, piece });
    part("posts", "gate posts", double ? 4 : 2, label, false, true);
    part("stiles", double ? "gate stiles pairs" : "gate stiles pair", double ? 2 : 1, label, false, true);
    part("sheets", `${height}mm Colorbond infill sheets`, double ? 4 : 2, null, true, true);
    part("latch", double ? "Lokklatch kit + drop bolt" : "Lokklatch kit", 1, null, false, false);
    const rails = double || width >= 1500 ? 2 : 1;
    part("rails", rails === 1 ? "long rail" : "long rails", rails, null, false, false);
  }

  const sealed = sealedFenceLines(scopeJson);
  nameSealedLines(sealed, lines, from, notes);
  return { lines, notes, sealed_suppliers: sealed.some((l) => l.supplier_key !== null) };
}

// ── B3: the sealed line each fill line came from ────────────────────────────
//
// A fence one-tool revision saves its sealed lines beside its job (scope_json.lines: id, description, quantity,
// unit, category, supplier; scope-engine-v2 shared/identity/fence.ts and #732). Shaun's lines are not those lines: a
// panel group is the panel kit line, the plinths are the plinth line, and a gate is split into posts, stiles,
// infill sheets, latch and rails. Each fill line names the sealed line it came from, by these rules:
//   - a panel group: the "Panel kit <height>H + <post>H post" line;
//   - the plinths: the standard "Retaining plinth 150mm" line;
//   - a gate's posts: that gate's own post line ("... (gate N)"), else its kit line;
//   - a gate sealed in parts (a "Gate N:" stile, latch, rail or infill sheet line, each with its own supplier): each
//     part its own line, and a part the sealed gate has no line for names none (it is held, never sent to a guess);
//   - a gate sealed as one kit line ("Gate N: pedestrian gate parts"): its other parts that kit line.
// A sealed line that more than one fill line comes from is named on each as "<id>#k/n" (the production index
// job_material_lines_source_line_once allows one row per id and revision), so a reader sees it was split into n parts.
// The unit is the sealed line's; a sealed line with none (a revision sealed before #732) takes the unit Shaun's order
// table implies, and the notes say which. A scope with no sealed lines (the older fence tool) is left as it was.

type GatePiece = "posts" | "stiles" | "sheets" | "latch" | "rails";
type FenceLineFrom =
  | { kind: "panels"; height: number; post: number | null }
  | { kind: "plinths" }
  | { kind: "gate"; gate: number; piece: GatePiece };

type SealedFenceLine = {
  id: string;
  description: string;
  unit: string | null;
  category: string;
  supplier_key: string | null;
  supplier_name: string | null;
};

// A gate sealed in parts names each part in its "Gate N:" line (the stile pair, the latch and hinges, the long rail,
// the infill sheets; live revisions, Nov 2026).
const GATE_PART: Record<Exclude<GatePiece, "posts">, RegExp> = {
  stiles: /\bstiles?\b/i,
  latch: /latch/i,
  rails: /\brails?\b/i,
  sheets: /\binfill sheets?\b/i,
};

// The unit Shaun's order table counts each of his lines in.
const SHAUN_UNIT: Record<string, string> = {
  panels: "each",
  plinths: "each",
  posts: "each",
  stiles: "pair",
  sheets: "each",
  latch: "kit",
  rails: "each",
};

function sealedFenceLines(scopeJson: unknown): SealedFenceLine[] {
  let scope: any = scopeJson;
  if (typeof scope === "string") {
    try {
      scope = JSON.parse(scope);
    } catch {
      return [];
    }
  }
  const raw = scope && typeof scope === "object" && Array.isArray(scope.lines) ? scope.lines : [];
  return raw.flatMap((l: any) =>
    l && typeof l.id === "string" && l.id && typeof l.description === "string"
      ? [{
        id: l.id,
        description: l.description,
        unit: text(l.unit),
        category: String(l.category ?? ""),
        supplier_key: text(l.supplierId) ?? text(l.supplierName),
        supplier_name: text(l.supplierName),
      }]
      : []
  );
}

function sealedLineFor(sealed: SealedFenceLine[], f: FenceLineFrom): SealedFenceLine | null {
  if (f.kind === "panels") {
    return sealed.find((l) => {
      const m = /^Panel kit (\d+)H \+ (\d+)H post/.exec(l.description);
      return l.category === "panels" && !!m && Number(m[1]) === f.height && Number(m[2]) === f.post;
    }) ?? null;
  }
  if (f.kind === "plinths") {
    return sealed.find((l) => /^Retaining plinth 150mm/.test(l.description) && !/, long/.test(l.description)) ?? null;
  }
  const own = sealed.filter((l) => l.category === "gates" && l.description.startsWith(`Gate ${f.gate}:`));
  const parts = Object.values(GATE_PART);
  const inParts = own.some((l) => parts.some((re) => re.test(l.description)));
  const kit = inParts ? null : own[0] ?? null;
  if (f.piece !== "posts") {
    if (!inParts) return kit;
    const re = GATE_PART[f.piece];
    return own.find((l) => re.test(l.description)) ?? null;
  }
  return sealed.find((l) =>
    l.category === "gates" && !l.description.startsWith("Gate ") && l.description.includes(`(gate ${f.gate})`)
  ) ?? kit;
}

function nameSealedLines(
  sealed: SealedFenceLine[],
  lines: DispatchV2FenceLine[],
  from: Map<DispatchV2FenceLine, FenceLineFrom>,
  notes: string[],
): void {
  if (!sealed.length) return;
  const source = lines.map((l) => {
    const f = from.get(l);
    return f ? sealedLineFor(sealed, f) : null;
  });
  const parts = new Map<string, number>();
  for (const s of source) if (s) parts.set(s.id, (parts.get(s.id) ?? 0) + 1);
  const seen = new Map<string, number>();
  const implied: string[] = [];
  const none: string[] = [];
  lines.forEach((l, i) => {
    const s = source[i];
    const f = from.get(l);
    const shaun = f ? SHAUN_UNIT[f.kind === "gate" ? f.piece : f.kind] : "each";
    if (!s) {
      l.scope_line_id = null;
      l.unit = shaun;
      l.supplier_key = null;
      l.supplier_name = null;
      none.push(l.description);
      return;
    }
    l.supplier_key = s.supplier_key;
    l.supplier_name = s.supplier_name;
    const n = parts.get(s.id)!;
    const k = (seen.get(s.id) ?? 0) + 1;
    seen.set(s.id, k);
    l.scope_line_id = n > 1 ? `${s.id}#${k}/${n}` : s.id;
    if (s.unit) l.unit = s.unit;
    else {
      l.unit = shaun;
      implied.push(`${l.description} (${shaun})`);
    }
  });
  if (implied.length) {
    notes.push(`The sealed lines carry no unit, so these take the unit Shaun's order table implies: ${implied.join(", ")}.`);
  }
  if (none.length) {
    notes.push(`${plural(none.length, "line names", "lines name")} no sealed line of the scope: ${none.join(", ")}.`);
  }
}

// ── The scope's supplier ────────────────────────────────────────────────────
//
// The fence tool's supplier is typed free text ("RNR", "Fence supply centre",
// "Strato"); a sealed patio line names the Scope Engine catalogue's supplier
// (T20). Either is matched to one of Shaun's approved order emails by name, so
// the filled lines can go straight into that supplier's box. A name that
// matches none is left for a person: the lines stay on the draft list.

// The short forms the scopes carry, to the approved email's name. The Scope
// Engine's catalogue ids (a sealed patio line's supplierId) mostly match a name
// as they are ("stratco", "metroll", "lysaght"); bd-metals and cmi do not.
// Tweak 4 (5 Nov 2026) renamed "B&D Metals Group" to "BD Metals" and "R&R
// Fencing" to "RnR Fencing": each alias names every name the entry has had,
// so a scope still finds its supplier before and after the rename lands.
const SCOPE_SUPPLIER_ALIASES: Record<string, string[]> = {
  bdmetals: ["BD Metals", "B&D Metals Group"],
  cmi: ["CMI (Combined Metal Industries)"],
  rnr: ["RnR Fencing", "R&R Fencing"],
  randr: ["RnR Fencing", "R&R Fencing"],
  strato: ["Stratco WA"],
  fss: ["Fencing Supply Centre"],
  fencesupplycentre: ["Fencing Supply Centre"],
  bnd: ["BD Metals", "B&D Metals Group"],
  bandd: ["BD Metals", "B&D Metals Group"],
  bd: ["BD Metals", "B&D Metals Group"],
  bandmetals: ["BD Metals", "B&D Metals Group"],
  rnrfencing: ["RnR Fencing", "R&R Fencing"],
  randrfencing: ["RnR Fencing", "R&R Fencing"],
  bandmetalsgroup: ["BD Metals", "B&D Metals Group"],
  banddmetalsgroup: ["BD Metals", "B&D Metals Group"],
};

// "R&R Fencing" -> "randrfencing": case, spaces and punctuation never matter.
function supplierKey(name: unknown): string {
  return String(name ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}

// The scope's supplier as typed, or null.
export function dispatchV2ScopeSupplierName(scopeJson: unknown): string | null {
  const job = dispatchV2FenceScopeJob(scopeJson);
  return job ? text(job.supplier) : null;
}

// The approved name a scope's supplier means, or null. An approved name also
// matches without a trailing "WA" or "Perth" ("Metroll" is "Metroll Perth").
export function dispatchV2MatchScopeSupplier(
  scopeName: unknown,
  approvedNames: string[],
): string | null {
  const key = supplierKey(scopeName);
  if (!key) return null;
  const alias = SCOPE_SUPPLIER_ALIASES[key];
  const aliasKeys = alias ? alias.map(supplierKey) : null;
  for (const name of approvedNames) {
    const k = supplierKey(name);
    if (aliasKeys ? aliasKeys.includes(k) : k === key || k.replace(/(wa|perth)$/, "") === key) {
      return name;
    }
  }
  return null;
}

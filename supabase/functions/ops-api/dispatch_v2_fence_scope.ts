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
  unit: null;
  detail: string | null;
  profile: string | null;
  colour: string | null;
};

export type DispatchV2FenceFill = {
  lines: DispatchV2FenceLine[];
  notes: string[];
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
  for (const group of groups.values()) {
    lines.push({
      description: group.post === null
        ? `${group.height}H standard width panels, post height to confirm`
        : `${group.height}H standard width panels with ${group.post}H posts`,
      quantity: group.count,
      unit: null,
      detail: null,
      profile,
      colour,
    });
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
    lines.push({
      description: "150mm standard width plinths",
      quantity: plinths,
      unit: null,
      detail: null,
      profile: null,
      colour,
    });
  }
  if (unknownRetaining > 0) {
    notes.push(
      `${plural(unknownRetaining, "panel has", "panels have")} a retaining height that is not a multiple of 150mm, so its plinths are not counted.`,
    );
  }

  // Gates.
  const gates = Array.isArray(job.gates) ? job.gates : [];
  for (const gate of gates) {
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
      description: string,
      quantity: number,
      detail: string | null,
      withProfile: boolean,
      withColour: boolean,
    ) =>
      lines.push({
        description,
        quantity,
        unit: null,
        detail,
        profile: withProfile ? profile : null,
        colour: withColour ? colour : null,
      });
    part("gate posts", double ? 4 : 2, label, false, true);
    part(double ? "gate stiles pairs" : "gate stiles pair", double ? 2 : 1, label, false, true);
    part(`${height}mm Colorbond infill sheets`, double ? 4 : 2, null, true, true);
    part(double ? "Lokklatch kit + drop bolt" : "Lokklatch kit", 1, null, false, false);
    const rails = double || width >= 1500 ? 2 : 1;
    part(rails === 1 ? "long rail" : "long rails", rails, null, false, false);
  }

  return { lines, notes };
}

// ── The scope's supplier ────────────────────────────────────────────────────
//
// The fence tool's supplier is typed free text ("RNR", "Fence supply centre",
// "Strato"). It is matched to one of Shaun's approved order emails by name, so
// the filled lines can go straight into that supplier's box. A name that
// matches none is left for a person: the lines stay on the draft list.

// The short forms the scopes carry, to the approved email's name.
const SCOPE_SUPPLIER_ALIASES: Record<string, string> = {
  rnr: "R&R Fencing",
  randr: "R&R Fencing",
  strato: "Stratco WA",
  fss: "Fencing Supply Centre",
  fencesupplycentre: "Fencing Supply Centre",
  bnd: "B&D Metals Group",
  bandd: "B&D Metals Group",
  bandmetals: "B&D Metals Group",
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
  for (const name of approvedNames) {
    const k = supplierKey(name);
    if (alias ? k === supplierKey(alias) : k === key || k.replace(/(wa|perth)$/, "") === key) {
      return name;
    }
  }
  return null;
}

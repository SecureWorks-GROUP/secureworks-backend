// Dispatch slice 4, fencing: the lines a frozen fence scope offers onto the
// Materials table (docs/dispatch-fence-scope-lines-v1.md). Pure: no reads, no
// writes. The store reads the job's latest frozen scope revision and inserts
// what this returns as `not_reviewed` lines under the one supplier the person
// chose, with no price, exactly like the patio suggestion.
//
// The rules are the fence designer's own, as `generateWorkOrderDoc` in
// index.ts already applies them: one panel kit per panel, its post height
// from the sheet height plus the panel's plinths, plinths from the panel's
// retaining (150 mm each, slope plinths added, at most four), and patio tubes
// on a run that has a panel carrying three or four plinths. Nothing here is
// read from the customer's quote, and nothing is guessed: what the scope does
// not say is returned in `held` for the person, never written as a line.

import { DISPATCH_MATERIAL_DESCRIPTION_MAX } from "./dispatch_materials.ts";
import type { DispatchSuggestedLine } from "./dispatch_materials.ts";

// Sheet height -> plinth height (mm) -> post length (mm). Same table as the
// fence designer and generateWorkOrderDoc.
export const FENCE_POST_LOOKUP: Record<number, Record<number, number>> = {
  1200: { 0: 2400, 150: 2400, 300: 2400, 450: 2400, 600: 2400 },
  1500: { 0: 2400, 150: 2400, 300: 2400, 450: 2700, 600: 2700 },
  1800: { 0: 2400, 150: 2700, 300: 2700, 450: 3000, 600: 3000 },
  2100: { 0: 2700, 150: 3000, 300: 3000, 450: 3000, 600: 3000 },
};

const PLINTH_MM = 150;
const MAX_PLINTHS = 4;

export type FenceScopeLines =
  | {
    ok: true;
    lines: DispatchSuggestedLine[];
    held: string[];
    scope_supplier: string | null;
  }
  | { ok: false; reason: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function wholeNumber(value: unknown): number | null {
  const n = typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value)
    ? Number(value)
    : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 &&
      Number.isInteger(n)
    ? n
    : null;
}

function describe(parts: string[]): string {
  return parts.filter(Boolean).join(", ").slice(
    0,
    DISPATCH_MATERIAL_DESCRIPTION_MAX,
  ).trim();
}

// `scope` is the parsed scoper document (jobs.scope_json shape). Any panel the
// table cannot read refuses the whole offer, so a part-read scope never puts
// a short order on the job.
export function fenceScopeSuggestedLines(scope: any): FenceScopeLines {
  const job = scope && typeof scope === "object" ? scope.job : null;
  const runs = Array.isArray(job?.runs) ? job.runs : [];
  if (runs.length === 0) return { ok: false, reason: "no_runs" };

  const profile = text(job.profile);
  const colour = text(job.colour);
  const kits = new Map<string, { line: DispatchSuggestedLine }>();
  let plinths = 0;
  let patioTubes = 0;
  let panelCount = 0;

  for (const run of runs) {
    const panels = Array.isArray(run?.panels) ? run.panels : [];
    let panelsWithPatio = 0;
    for (const panel of panels) {
      const height = wholeNumber(panel?.height);
      const retaining = wholeNumber(panel?.retaining ?? 0);
      const slope = wholeNumber(panel?.slopePlinths ?? 0);
      if (height === null || !(height in FENCE_POST_LOOKUP)) {
        return { ok: false, reason: "panel_height_unknown" };
      }
      if (retaining === null || retaining % PLINTH_MM !== 0 || slope === null) {
        return { ok: false, reason: "panel_retaining_unreadable" };
      }
      const panelPlinths = Math.min(MAX_PLINTHS, slope + retaining / PLINTH_MM);
      const post = FENCE_POST_LOOKUP[height][panelPlinths * PLINTH_MM];
      const long = text(panel?.panelWidth) === "long";
      const key = `${height}:${post}:${long}`;
      const existing = kits.get(key);
      if (existing) {
        existing.line.quantity = (existing.line.quantity ?? 0) + 1;
      } else {
        kits.set(key, {
          line: {
            description: describe([
              `${profile ? profile + " " : ""}fence panel kit`,
              colour,
              `${height} mm sheet`,
              `${post} mm post`,
              long ? "long panel" : "",
            ]),
            quantity: 1,
            unit: "panels",
          },
        });
      }
      plinths += panelPlinths;
      panelCount += 1;
      if (panelPlinths >= 3) panelsWithPatio += 1;
    }
    if (panelsWithPatio > 0) patioTubes += panelsWithPatio + 1;
  }
  if (panelCount === 0) return { ok: false, reason: "no_panels" };

  const lines: DispatchSuggestedLine[] = [...kits.values()].map((k) => k.line);
  if (plinths > 0) {
    lines.push({
      description: describe([`Retaining plinth ${PLINTH_MM} mm`, colour]),
      quantity: plinths,
      unit: "each",
    });
  }
  if (patioTubes > 0) {
    lines.push({
      description: "Patio tube 76x38 RHS 3000 mm",
      quantity: patioTubes,
      unit: "each",
    });
  }

  const gates = Array.isArray(job.gates) ? job.gates : [];
  const gateKits = new Map<string, DispatchSuggestedLine>();
  let gatePosts = 0;
  for (const gate of gates) {
    const double = text(gate?.type) === "double";
    const width = wholeNumber(gate?.width);
    const description = double
      ? describe([
        `Double swing gate kit${width ? ` ${width} mm` : ""}`,
        colour,
      ])
      : describe([`Pedestrian gate kit ${width ?? 900} mm`, colour]);
    const existing = gateKits.get(description);
    if (existing) existing.quantity = (existing.quantity ?? 0) + 1;
    else gateKits.set(description, { description, quantity: 1, unit: "each" });
    gatePosts += double ? 4 : 2;
  }
  lines.push(...gateKits.values());
  if (gatePosts > 0) {
    lines.push({ description: "Gate post", quantity: gatePosts, unit: "each" });
  }

  // What the scope implies but does not say: for the person, never a line.
  const allPosts = panelCount + 1 + gatePosts;
  const held = [
    "One end post beyond the panel kits: confirm its length with the supplier.",
    `Concrete is a crew buy: about ${
      Math.ceil(allPosts * 2 * 1.1 / 2) * 2
    } bags by the fence designer's rule.`,
    "Fixings, removal and delivery are not supplier lines here.",
  ];
  return {
    ok: true,
    lines,
    held,
    scope_supplier: text(job.supplier) || null,
  };
}

// The live working copy may be edited after the last freeze without a new
// frozen revision (seen on a real job on 19 Oct 2026, whose order followed the
// edit). The offer still comes from the frozen revision; this line, added to
// `held`, tells the person to check the lines against the latest scope.
export const FENCE_SCOPE_CHANGED_SINCE_FROZEN =
  "The scope was changed after it was frozen: check these lines against the latest scope.";
export const FENCE_SCOPE_CHANGE_UNCHECKED =
  "Could not check whether the scope was changed after it was frozen: check these lines against the latest scope.";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) =>
        `${JSON.stringify(key)}:${
          canonicalJson((value as Record<string, unknown>)[key])
        }`
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// True when the live runs differ from the frozen runs, compared as JSON values
// (key order ignored, as jsonb equality does). No live runs: nothing to compare.
export function fenceRunsChangedSinceFrozen(
  frozenScope: any,
  liveRuns: unknown,
): boolean {
  if (liveRuns === null || liveRuns === undefined) return false;
  return canonicalJson(frozenScope?.job?.runs ?? null) !==
    canonicalJson(liveRuns);
}

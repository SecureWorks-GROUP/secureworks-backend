// deno-lint-ignore-file no-explicit-any
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchV2FenceLinesFromScope,
  dispatchV2FenceScopeJob,
  dispatchV2MatchScopeSupplier,
} from "./dispatch_v2_fence_scope.ts";
import { dispatchV2LineText } from "./dispatch_v2_emails.ts";

function panel(over: Record<string, unknown> = {}) {
  return { height: 1800, retaining: 0, panelWidth: "standard", step: "level", slopePlinths: 0, ...over };
}

function scope(job: Record<string, unknown>) {
  return { tool: "fence", version: 1, job: { profile: "Neetascreen", colour: "Paperbark", gates: [], ...job } };
}

const texts = (fill: any) => fill.lines.map(dispatchV2LineText);

Deno.test("fence fill: Luke Kim's shape, 9 panels in one line with a note for the long one", () => {
  // SWF-261600: one 22m Rear run, 9 x 1800H, no retaining, one panel long.
  const fill = dispatchV2FenceLinesFromScope(scope({
    runs: [{
      name: "Rear",
      sheetHeight: 1800,
      panels: [...Array(8).fill(0).map(() => panel()), panel({ panelWidth: "long" })],
    }],
  }))!;
  assertEquals(texts(fill), [
    "9 x 1800H standard width panels with 2400H posts\nProfile: Neetascreen\nColour: Paperbark",
  ]);
  assertEquals(fill.notes, [
    "1 panel is marked long width in the scope. Check the panel line with the supplier.",
  ]);
});

Deno.test("fence fill: post heights and plinths follow the retaining table", () => {
  const fill = dispatchV2FenceLinesFromScope(scope({
    runs: [
      { name: "Rear", panels: [panel(), panel({ retaining: 150 }), panel({ retaining: 300 })] },
      { name: "LHS", panels: [panel({ retaining: 450 }), panel({ retaining: 600 }), panel({ retaining: 150 })] },
    ],
  }))!;
  assertEquals(texts(fill), [
    "1 x 1800H standard width panels with 2400H posts\nProfile: Neetascreen\nColour: Paperbark",
    "3 x 1800H standard width panels with 2700H posts\nProfile: Neetascreen\nColour: Paperbark",
    "2 x 1800H standard width panels with 3000H posts\nProfile: Neetascreen\nColour: Paperbark",
    // 150:1 + 300:2 + 450:3 + 600:4 + 150:1
    "11 x 150mm standard width plinths\nColour: Paperbark",
  ]);
  assertEquals(fill.notes, []);
});

Deno.test("fence fill: a pedestrian and a double gate, as in the gate breakdown", () => {
  const fill = dispatchV2FenceLinesFromScope(scope({
    profile: "Ridgeside",
    colour: "Dune",
    runs: [{ name: "Front", panels: [panel()] }],
    gates: [
      { type: "pedestrian", width: 1270, height: 1800 },
      { type: "double", width: 3000, height: 1800 },
    ],
  }))!;
  assertEquals(texts(fill), [
    "1 x 1800H standard width panels with 2400H posts\nProfile: Ridgeside\nColour: Dune",
    "2 x gate posts\nGate: Pedestrian gate 1270mm\nColour: Dune",
    "1 x gate stiles pair\nGate: Pedestrian gate 1270mm\nColour: Dune",
    "2 x 1800mm Colorbond infill sheets\nProfile: Ridgeside\nColour: Dune",
    "1 x Lokklatch kit",
    "1 x long rail",
    "4 x gate posts\nGate: Double gate 3000mm\nColour: Dune",
    "2 x gate stiles pairs\nGate: Double gate 3000mm\nColour: Dune",
    "4 x 1800mm Colorbond infill sheets\nProfile: Ridgeside\nColour: Dune",
    "1 x Lokklatch kit + drop bolt",
    "2 x long rails",
  ]);
});

Deno.test("fence fill: a wide pedestrian gate takes two long rails", () => {
  const fill = dispatchV2FenceLinesFromScope(scope({
    runs: [],
    gates: [{ type: "pedestrian", width: 1500, height: 1500 }],
  }))!;
  assertEquals(fill.lines.at(-1)!.description, "long rails");
  assertEquals(fill.lines.at(-1)!.quantity, 2);
  assertEquals(fill.lines[2].description, "1500mm Colorbond infill sheets");
});

Deno.test("fence fill: never guesses, it leaves a note instead", () => {
  const fill = dispatchV2FenceLinesFromScope(scope({
    profile: "",
    runs: [{ name: "Rear", panels: [panel({ height: 2100 }), panel({ retaining: 900 }), panel({ retaining: 200 })] }],
    gates: [{ type: "", width: 900, height: 1800 }, { type: "pedestrian", width: null, height: 1800 }],
  }))!;
  assertEquals(fill.lines.map((l) => [l.quantity, l.description]), [
    [1, "2100H standard width panels, post height to confirm"],
    [2, "1800H standard width panels, post height to confirm"],
    [6, "150mm standard width plinths"],
  ]);
  assertEquals(fill.notes, [
    "The scope has no sheet profile. Add it to the panel line.",
    "No post height rule for a 2100H panel with 0mm retaining. Set the post height on the panel line.",
    "No post height rule for a 1800H panel with 900mm retaining. Set the post height on the panel line.",
    "No post height rule for a 1800H panel with 200mm retaining. Set the post height on the panel line.",
    "1 panel has a retaining height that is not a multiple of 150mm, so its plinths are not counted.",
    "A gate has no pedestrian or double type in the scope, so its parts are left out.",
    "A pedestrian gate has no width or height in the scope, so its parts are left out.",
  ]);
});

Deno.test("fence fill: quickset and fixings are left to the email", () => {
  const fill = dispatchV2FenceLinesFromScope(scope({ runs: [{ panels: [panel()] }] }))!;
  assertEquals(fill.lines.some((l) => /quickset|fixings/i.test(l.description)), false);
});

Deno.test("fence fill: not a fence tool scope gives null", () => {
  assertEquals(dispatchV2FenceLinesFromScope(null), null);
  assertEquals(dispatchV2FenceLinesFromScope({ items: ["Colorbond fence sheets"] }), null);
  assertEquals(dispatchV2FenceLinesFromScope({ config: { roofing: "solarspan75" } }), null);
  assertEquals(dispatchV2FenceLinesFromScope("not json"), null);
  assertEquals(dispatchV2FenceScopeJob(JSON.stringify(scope({ runs: [] })))?.profile, "Neetascreen");
});

Deno.test("scope supplier: the fence tool's typed names find Shaun's approved order emails", () => {
  // The approved list as it stands (26 Oct 2026).
  const approved = [
    "R&R Fencing", "Fencing Warehouse WA", "Lysaght", "Oxworks", "Metric Fencing", "Teamwork Fencing", "Mackson",
    "Fencing Supply Centre", "Twinside Retaining", "Fence Makers", "Stratco WA", "B&D Metals Group", "Metroll Perth",
    "Bunnings", "Bondor",
  ];
  const match = (name: string) => dispatchV2MatchScopeSupplier(name, approved);
  assertEquals(match("RNR"), "R&R Fencing");
  assertEquals(match("R&R"), "R&R Fencing");
  assertEquals(match("Metroll"), "Metroll Perth");
  assertEquals(match("Lysaght"), "Lysaght");
  assertEquals(match("Stratco"), "Stratco WA");
  assertEquals(match("Strato"), "Stratco WA");
  assertEquals(match("Oxworks "), "Oxworks");
  assertEquals(match("FSS"), "Fencing Supply Centre");
  assertEquals(match("Fencing supply centre "), "Fencing Supply Centre");
  assertEquals(match("Fence supply centre"), "Fencing Supply Centre");
  assertEquals(match("Fencing Warehouse"), "Fencing Warehouse WA");
  assertEquals(match("BND"), "B&D Metals Group");
  assertEquals(match("B&D"), "B&D Metals Group");
  assertEquals(match("Paralink"), null);
  assertEquals(match("Metline"), null);
  assertEquals(match(""), null);
  // An alias only counts when its approved email is there.
  assertEquals(dispatchV2MatchScopeSupplier("RNR", ["Lysaght"]), null);
});

Deno.test("scope supplier (Tweak 4): the renamed BD Metals and RnR Fencing are still found by every typed form", () => {
  // Shaun renamed two approved entries on 5 Nov 2026.
  const approved = ["RnR Fencing", "Fencing Warehouse WA", "BD Metals", "Metroll Perth"];
  const match = (name: string) => dispatchV2MatchScopeSupplier(name, approved);
  for (const typed of ["RNR", "R&R", "R and R", "RnR Fencing", "R&R Fencing"]) {
    assertEquals(match(typed), "RnR Fencing", typed);
  }
  for (const typed of ["BND", "B&D", "BD", "B and D", "BD Metals", "B&D Metals Group"]) {
    assertEquals(match(typed), "BD Metals", typed);
  }
});

// ── B3: each fence fill line names the sealed line it came from ─────────────
// A fence one-tool revision saves its sealed lines (scope_json.lines, scope-engine-v2 #732) beside its job. The fill
// keeps Shaun's lines and wording, and writes on each the sealed line's id and unit. A gate split into parts: the
// posts come from the gate's own post line; the other parts from the gate's kit line, each "<id>#k/n" (the index
// job_material_lines_source_line_once allows one row per id and revision).
function sealedFence(lines: Record<string, unknown>[]) {
  return {
    ...scope({
      supplier: "R&R",
      runs: [{ name: "Rear", panels: Array(9).fill(0).map(() => panel()) }],
      gates: [{ type: "pedestrian", width: 900, height: 1800 }],
    }),
    tool: "fencing",
    lines,
  };
}
const SEALED = [
  { id: "SL-kit", description: "Panel kit 1800H + 2400H post (2380mm wide)", quantity: 9, unit: "each", category: "panels", supplierName: "R&R Fencing" },
  { id: "SL-conc", description: "Concrete 20kg bag (Kwikset)", quantity: 25, unit: "each", category: "materials", supplierName: "R&R Fencing" },
  { id: "SL-gate", description: "Gate 1: pedestrian gate parts (900mm)", quantity: 1, unit: "each", category: "gates", supplierName: "R&R Fencing" },
  { id: "SL-gpost", description: "50x50mm SHS gate post, L2400mm ×2 (gate 1)", quantity: 2, unit: "each", category: "gates", supplierName: "R&R Fencing" },
  { id: "SL-rem", description: "Remove asbestos fence (licenced)", quantity: 9, unit: "m", category: "removal", supplier: "office" },
];
// Every line a fill made from sealed lines must name one, with a unit.
const unnamed = (lines: any[]) => lines.filter((l) => !l.scope_line_id || !l.unit);

Deno.test("B3 fence fill: each line names the sealed line it came from, with its unit; Shaun's lines unchanged", () => {
  const fill = dispatchV2FenceLinesFromScope(sealedFence(SEALED))!;
  assertEquals(fill.lines.map((l: any) => [l.quantity, l.description, l.scope_line_id, l.unit]), [
    [9, "1800H standard width panels with 2400H posts", "SL-kit", "each"],
    [2, "gate posts", "SL-gpost", "each"],
    [1, "gate stiles pair", "SL-gate#1/4", "each"],
    [2, "1800mm Colorbond infill sheets", "SL-gate#2/4", "each"],
    [1, "Lokklatch kit", "SL-gate#3/4", "each"],
    [1, "long rail", "SL-gate#4/4", "each"],
  ]);
  assertEquals(unnamed(fill.lines), []);
  assertEquals(fill.notes, []);
  // The planted fault: a part with no sealed line is caught.
  const planted = fill.lines.map((l: any, i: number) => (i === 3 ? { ...l, scope_line_id: null } : l));
  assertEquals(unnamed(planted).map((l: any) => l.description), ["1800mm Colorbond infill sheets"]);
});

Deno.test("B3 fence fill: a gate with no post line of its own splits its kit line into 5 parts", () => {
  const fill = dispatchV2FenceLinesFromScope(sealedFence(SEALED.filter((l) => l.id !== "SL-gpost")))!;
  assertEquals(fill.lines.slice(1).map((l: any) => l.scope_line_id), ["SL-gate#1/5", "SL-gate#2/5", "SL-gate#3/5", "SL-gate#4/5", "SL-gate#5/5"]);
});

Deno.test("B3 fence fill: a sealed line with no unit takes the unit Shaun's table implies, and says which", () => {
  const fill = dispatchV2FenceLinesFromScope(sealedFence(SEALED.map(({ unit: _u, ...l }) => l)))!;
  assertEquals(fill.lines.map((l: any) => l.unit), ["each", "each", "pair", "each", "kit", "each"]);
  assertEquals(fill.notes, [
    "The sealed lines carry no unit, so these take the unit Shaun's order table implies: 1800H standard width panels with 2400H posts (each), gate posts (each), gate stiles pair (pair), 1800mm Colorbond infill sheets (each), Lokklatch kit (kit), long rail (each).",
  ]);
});

Deno.test("B3 fence fill: a fill line with no sealed line to name keeps a null id and says so; a scope with no sealed lines is unchanged", () => {
  const fill = dispatchV2FenceLinesFromScope(sealedFence(SEALED.filter((l) => l.category !== "gates")))!;
  assertEquals(fill.lines.map((l: any) => l.scope_line_id), ["SL-kit", null, null, null, null, null]);
  assertEquals(fill.notes, [
    "5 lines name no sealed line of the scope: gate posts, gate stiles pair, 1800mm Colorbond infill sheets, Lokklatch kit, long rail.",
  ]);
  const old = dispatchV2FenceLinesFromScope(scope({ runs: [{ panels: [panel()] }] }))!;
  assertEquals(old.lines.map((l: any) => [l.scope_line_id ?? null, l.unit]), [[null, null]]);
});

// ── The sealed supplier split: each line follows its own sealed line's supplier ──
// A live fence revision seals its gate in parts, each with its own supplier: the stile pair, the latch and hinges and
// the long rail to one supplier, the infill sheets and the gate posts to another. The fill names each part's own
// sealed line and its supplier, line for line, never the scope's one typed supplier.
const SPLIT = [
  { id: "SL-kit", description: "Panel kit 1800H + 2400H post (2380mm wide)", quantity: 9, unit: "each", category: "panels", supplierId: "r-and-r-fencing", supplierName: "R&R Fencing" },
  { id: "SL-stile", description: "Gate 1: gate stile pair 1760mm, Monument", quantity: 1, unit: "each", category: "gates", supplierId: "fencing-warehouse-wa", supplierName: "Fencing Warehouse WA" },
  { id: "SL-latch", description: "Gate 1: Lokklatch Deluxe latch and Truclose regular hinge pair", quantity: 1, unit: "each", category: "gates", supplierId: "fencing-warehouse-wa", supplierName: "Fencing Warehouse WA" },
  { id: "SL-rail", description: "Gate 1: long rail 3125mm (gate frame)", quantity: 1, unit: "each", category: "gates", supplierId: "fencing-warehouse-wa", supplierName: "Fencing Warehouse WA" },
  { id: "SL-sheet", description: "Gate 1: 1800mm infill sheet, Sameside, Monument ×2", quantity: 2, unit: "each", category: "gates", supplierId: "r-and-r-fencing", supplierName: "R&R Fencing" },
  { id: "SL-gpost", description: "50x50mm SHS gate post, L2400mm ×2 (gate 1)", quantity: 2, unit: "each", category: "gates", supplierId: "r-and-r-fencing", supplierName: "R&R Fencing" },
];

Deno.test("supplier split: a gate sealed in parts names each part's own line and supplier", () => {
  const fill = dispatchV2FenceLinesFromScope(sealedFence(SPLIT))!;
  assertEquals(fill.sealed_suppliers, true);
  assertEquals(fill.lines.map((l: any) => [l.description, l.scope_line_id, l.supplier_key]), [
    ["1800H standard width panels with 2400H posts", "SL-kit", "r-and-r-fencing"],
    ["gate posts", "SL-gpost", "r-and-r-fencing"],
    ["gate stiles pair", "SL-stile", "fencing-warehouse-wa"],
    ["1800mm Colorbond infill sheets", "SL-sheet", "r-and-r-fencing"],
    ["Lokklatch kit", "SL-latch", "fencing-warehouse-wa"],
    ["long rail", "SL-rail", "fencing-warehouse-wa"],
  ]);
  assertEquals(fill.notes, []);
});

Deno.test("supplier split: a part the sealed gate has no line for is held, never given the kit's supplier", () => {
  const fill = dispatchV2FenceLinesFromScope(sealedFence(SPLIT.filter((l) => l.id !== "SL-rail")))!;
  const rail = fill.lines.find((l: any) => l.description === "long rail")!;
  assertEquals([rail.scope_line_id, rail.supplier_key], [null, null]);
  assertEquals(fill.notes, ["1 line names no sealed line of the scope: long rail."]);
});

Deno.test("supplier split: sealed lines with no supplier leave the scope's one supplier in charge", () => {
  const bare = SPLIT.map(({ supplierId: _i, supplierName: _n, ...l }) => l);
  const fill = dispatchV2FenceLinesFromScope(sealedFence(bare))!;
  assertEquals(fill.sealed_suppliers, false);
  assertEquals(fill.lines.every((l: any) => l.supplier_key === null), true);
});

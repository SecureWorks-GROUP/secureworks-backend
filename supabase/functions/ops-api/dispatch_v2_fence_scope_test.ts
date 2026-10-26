import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchV2FenceLinesFromScope,
  dispatchV2FenceScopeJob,
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
